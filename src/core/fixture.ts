/**
 * 固定 fixture：确定性生成一段跨长观测空档的到达时刻。
 *
 * 场景：30 天密集观测（第 0..29 天）→ 200 天空档 → 5 个末端观测
 * （第 230..234 天）。前半段拟合无法区分空档后 ±1 整周两个方案，
 * 只有加入末端观测后才可区分。
 *
 * 时钟事件（生成记录时刻时按同一右连续规则施加）：
 *  E1(seq 1)：恰好落在第 10 个到达时刻的记录时刻上（右连续语义下
 *             对该到达时刻生效且仅生效一次），+500µs。
 *  E2(seq 2)、E3(seq 3)：同一时刻（第 20.0 天整），+100µs / -30µs，
 *             按不可变 seq 合成。
 */
import {
  DAY_US,
  DM_SCALE,
  F_SCALE,
  PHASE_DEN,
  TERM1_COEF,
  cycleOf,
  dmDelayUs,
  phaseNum,
  roundDiv,
} from "./units.js";

export interface FixtureToa {
  seq: number;
  tUs: string;
  bandMHz: number;
  observatory: string;
}

export interface FixtureClockEvent {
  tUs: string;
  offsetUs: string;
  label: string;
}

export interface Fixture {
  meta: {
    name: string;
    t0Mjd: number;
    fHz: string;
    fdotHzPerS: string;
    dmPcCm3: string;
    noiseSigmaUs: number;
    seed: number;
    sessionDays: number;
    tailStartDay: number;
    tailCount: number;
    bandsMHz: number[];
  };
  clockEvents: FixtureClockEvent[];
  toas: FixtureToa[];
}

export const FIXTURE_PARAMS = {
  fNum: 10n * F_SCALE, // 10 Hz
  dNum: -1_000_000_000n, // -1e-15 Hz/s × 1e24
  dmNum: 30n * DM_SCALE, // 30 pc/cm³
};

const SEED = 1169;
const SESSION_DAYS = 30;
const TAIL_START_DAY = 230;
const TAIL_COUNT = 5;
const BANDS = [820, 1400, 2400];

/** 确定性 LCG，产出 [0,1) 均匀序列 */
function makeRng(seed: bigint) {
  let state = seed;
  return () => {
    state =
      (state * 6364136223846793005n + 1442695040888963407n) &
      0xffff_ffff_ffff_ffffn;
    return Number(state >> 11n) / 2 ** 53;
  };
}

/** σ ≈ 2µs 的类高斯噪声（3 个均匀量之和），取整到微秒 */
function noiseUs(rng: () => number): bigint {
  return BigInt(Math.round((rng() + rng() + rng() - 1.5) * 4));
}

/**
 * 相位相干时刻：求 t 使 φ_true(t) = N（精确整数周）。
 * 浮点给初值，再用精确相位分子做整数牛顿修正，收敛到 <1µs。
 */
function coherentTimeUs(nCycles: bigint): bigint {
  const { fNum, dNum } = FIXTURE_PARAMS;
  const n = Number(nCycles);
  const f = 10;
  const fd = -1e-15;
  const tSec = n / f - (0.5 * fd * (n / f) ** 2) / f;
  let t = BigInt(Math.round(tSec * 1e6));
  for (let i = 0; i < 4; i++) {
    const res = phaseNum(fNum, dNum, t) - nCycles * PHASE_DEN;
    if (res === 0n) break;
    t -= roundDiv(res, TERM1_COEF * fNum);
  }
  return t;
}

export function generateFixture(): Fixture {
  const rng = makeRng(BigInt(SEED));
  const days: number[] = [];
  for (let d = 0; d < SESSION_DAYS; d++) days.push(d);
  for (let d = TAIL_START_DAY; d < TAIL_START_DAY + TAIL_COUNT; d++)
    days.push(d);

  // 1) 无钟跳「洁净」时刻 = 相位相干真值 + 噪声 + 色散时延
  const clean = days.map((d, i) => {
    const band = BANDS[i % BANDS.length];
    const fNum = BigInt(band) * 1_000_000n * F_SCALE;
    const sched = BigInt(d) * DAY_US;
    const nCycles = cycleOf(FIXTURE_PARAMS.fNum, FIXTURE_PARAMS.dNum, sched);
    return (
      coherentTimeUs(nCycles) + noiseUs(rng) + dmDelayUs(FIXTURE_PARAMS.dmNum, fNum)
    );
  });

  // 2) 记录时刻：E1(+500µs) 自第 10 个到达时刻（含）起生效；
  //    E2/E3(+100/-30µs) 自第 20.0 天整起生效。
  const e1Offset = 500n;
  const e23TUs = 20n * DAY_US;
  const e2Offset = 100n;
  const e3Offset = -30n;
  const recorded = clean.map((t, i) => {
    let r = t + (i >= 10 ? e1Offset : 0n);
    if (r >= e23TUs) r += e2Offset + e3Offset;
    return r;
  });

  // 3) E1 边界就放在第 10 个到达时刻的记录时刻上（右连续：生效且仅一次）
  const events = [
    { tUs: recorded[10], offsetUs: e1Offset, label: "maser-step@toa10" },
    { tUs: e23TUs, offsetUs: e2Offset, label: "clock-reset-a" },
    { tUs: e23TUs, offsetUs: e3Offset, label: "clock-reset-b" },
  ];

  // 自洽性断言：用右连续规则重放，记录时刻必须复现
  for (const r of recorded) {
    let off = 0n;
    for (const e of events) if (e.tUs <= r) off += e.offsetUs;
    const i = recorded.indexOf(r);
    if (r - off !== clean[i]) {
      throw new Error(`fixture not self-consistent at seq ${i}`);
    }
  }

  return {
    meta: {
      name: "default",
      t0Mjd: 59000,
      fHz: "10",
      fdotHzPerS: "-1e-15",
      dmPcCm3: "30",
      noiseSigmaUs: 2,
      seed: SEED,
      sessionDays: SESSION_DAYS,
      tailStartDay: TAIL_START_DAY,
      tailCount: TAIL_COUNT,
      bandsMHz: BANDS,
    },
    clockEvents: events.map((e) => ({
      tUs: e.tUs.toString(),
      offsetUs: e.offsetUs.toString(),
      label: e.label,
    })),
    toas: recorded.map((t, i) => ({
      seq: i,
      tUs: t.toString(),
      bandMHz: BANDS[i % BANDS.length],
      observatory: "FAST",
    })),
  };
}
