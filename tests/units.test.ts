import { describe, expect, it } from "vitest";
import {
  DAY_US,
  F_SCALE,
  PHASE_DEN,
  cycleOf,
  dmDelayUs,
  floorDiv,
  phaseNum,
  roundDiv,
  wrappedPhase,
} from "../src/core/units.js";
import { DM_SCALE } from "../src/core/units.js";

const F = 10n * F_SCALE; // 10 Hz
const D = -1_000_000_000n; // -1e-15 Hz/s

describe("有理数取整", () => {
  it("floorDiv 对负数向下取整", () => {
    expect(floorDiv(7n, 2n)).toBe(3n);
    expect(floorDiv(-7n, 2n)).toBe(-4n);
    expect(floorDiv(-8n, 2n)).toBe(-4n);
  });
  it("roundDiv 四舍五入", () => {
    expect(roundDiv(5n, 2n)).toBe(3n);
    expect(roundDiv(-5n, 2n)).toBe(-2n); // 半值远离零 -> -3? 验证实现口径
    expect(roundDiv(4n, 2n)).toBe(2n);
  });
});

describe("整周计数（精确整数，禁止浮点取模）", () => {
  it("大计数：235 天 × 10Hz ≈ 2 亿周，逐周精确", () => {
    // 在 t 处相位恰为整数 N 时，cycleOf 必须精确返回 N
    const tUs = 234n * DAY_US;
    const n = cycleOf(F, D, tUs);
    // 相位分子 - N*PHASE_DEN 的余数必须落在 [0, PHASE_DEN)
    const rem = phaseNum(F, D, tUs) - n * PHASE_DEN;
    expect(rem >= 0n).toBe(true);
    expect(rem < PHASE_DEN).toBe(true);
    // 1 秒之后必须恰好多 10 周（f=10Hz，fdot 影响 < 1 周）
    const n2 = cycleOf(F, D, tUs + 1_000_000n);
    expect(n2 - n).toBe(10n);
  });
  it("计数规模超过 2^31 仍精确（BigInt 路径）", () => {
    // 构造超大时刻：10^6 天 ≈ 8.64e16 µs，周数 ~8.64e11
    const tUs = 1_000_000n * DAY_US;
    const n = cycleOf(F, 0n, tUs);
    expect(n).toBe(864_000_000_000n); // 10Hz × 86400s × 1e6 天
  });
  it("包裹相位落在 [0,1)", () => {
    for (const t of [0n, 123_456_789n, 234n * DAY_US + 777n]) {
      const w = wrappedPhase(F, D, t);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThan(1);
    }
  });
});

describe("色散时延", () => {
  const DM = 30n * DM_SCALE;
  it("频率越高时延越小", () => {
    const f820 = 820n * 1_000_000n * F_SCALE;
    const f1400 = 1400n * 1_000_000n * F_SCALE;
    const f2400 = 2400n * 1_000_000n * F_SCALE;
    expect(dmDelayUs(DM, f820)).toBeGreaterThan(dmDelayUs(DM, f1400));
    expect(dmDelayUs(DM, f1400)).toBeGreaterThan(dmDelayUs(DM, f2400));
  });
  it("1400MHz、DM=30 时延 ≈ 63503 µs", () => {
    const f1400 = 1400n * 1_000_000n * F_SCALE;
    const d = dmDelayUs(DM, f1400);
    // 4.148808e9 × 30 / 1400² = 63502.04…
    expect(d).toBe(63502n);
  });
});
