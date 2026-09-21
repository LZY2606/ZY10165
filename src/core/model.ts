/**
 * 计时模型：时钟事件合成、到达时刻改正、残差与整周模糊判定。
 */
import {
  DAY_US,
  PHASE_DEN,
  cycleOf,
  dmDelayUs,
  floorDiv,
  phaseNum,
  roundDiv,
  wrappedPhase,
} from "./units.js";

export interface TimingParams {
  fNum: bigint; // 频率 × 1e12
  dNum: bigint; // 频率导数 × 1e24
  dmNum: bigint; // 色散量 × 1e6
}

export interface Toa {
  id: number;
  inputVersion: number;
  seq: number; // 输入内序号（不可变）
  tUs: bigint; // 记录的到达时刻（含时钟偏差与色散）
  fNum: bigint; // 观测频率 × 1e12
  bandMHz: number;
  observatory: string;
  cycleBase: bigint; // 导入时按参考参数取整得到的基准整周
}

export interface ClockEvent {
  id: number;
  seq: number; // 不可变事件序号，合成顺序的唯一依据
  tUs: bigint; // 生效边界（右连续）
  offsetUs: bigint; // 仪器时钟跳变量（记录时刻 - 真实时刻）
  label: string;
}

export interface CycleShift {
  id: number;
  branchId: number;
  boundaryTUs: bigint; // 空档边界：对 t >= boundary 的到达时刻生效
  delta: bigint; // 整周偏移（可正可负）
}

export interface BranchInput {
  params: TimingParams;
  shifts: CycleShift[];
  exclusions: Set<number>; // 排除候选 toa.id
}

/**
 * 时钟跳变合成：右连续 —— 事件边界恰好等于观测时刻时该事件生效；
 * 同一时刻的多个事件按不可变 seq 升序合成（折叠求和）。
 * 每个事件至多应用一次。
 */
export function clockOffsetAt(
  events: ClockEvent[],
  tUs: bigint,
): { offsetUs: bigint; appliedSeqs: number[] } {
  const applicable = events
    .filter((e) => e.tUs <= tUs)
    .sort((a, b) => a.seq - b.seq);
  let offset = 0n;
  const appliedSeqs: number[] = [];
  for (const e of applicable) {
    offset += e.offsetUs;
    appliedSeqs.push(e.seq);
  }
  return { offsetUs: offset, appliedSeqs };
}

/** 周数偏移合成：边界右连续，按边界时刻再按 id 升序合成 */
export function cycleShiftAt(shifts: CycleShift[], tUs: bigint): bigint {
  const applicable = shifts
    .filter((s) => s.boundaryTUs <= tUs)
    .sort((a, b) =>
      a.boundaryTUs < b.boundaryTUs
        ? -1
        : a.boundaryTUs > b.boundaryTUs
          ? 1
          : a.id - b.id,
    );
  let delta = 0n;
  for (const s of applicable) delta += s.delta;
  return delta;
}

/** 改正到太阳系无穷频率等效到达时刻：t_corr = t_obs - 时钟偏差 - 色散时延 */
export function correctedTUs(
  toa: Pick<Toa, "tUs" | "fNum">,
  params: TimingParams,
  events: ClockEvent[],
): bigint {
  const { offsetUs } = clockOffsetAt(events, toa.tUs);
  return toa.tUs - offsetUs - dmDelayUs(params.dmNum, toa.fNum);
}

/** 导入时计算基准整周：对改正后相位四舍五入到最近整数周 */
export function baseCycle(
  toa: Pick<Toa, "tUs" | "fNum">,
  refParams: TimingParams,
  events: ClockEvent[],
): bigint {
  const tCorr = correctedTUs(toa, refParams, events);
  return roundDiv(phaseNum(refParams.fNum, refParams.dNum, tCorr), PHASE_DEN);
}

export interface ToaResidual {
  toaId: number;
  seq: number;
  tUs: bigint;
  bandMHz: number;
  excluded: boolean;
  cycle: bigint; // 最终整周编号 = cycleBase + Σshift
  wrapped: number; // 包裹相位（展示用）
  residualUs: number; // 残差（微秒，统计/展示用浮点）
  appliedClockSeqs: number[];
}

export function computeResiduals(
  toas: Toa[],
  events: ClockEvent[],
  branch: BranchInput,
): ToaResidual[] {
  const { fNum, dNum } = branch.params;
  return toas.map((toa) => {
    const tCorr = correctedTUs(toa, branch.params, events);
    const cycle = toa.cycleBase + cycleShiftAt(branch.shifts, toa.tUs);
    const resNum = phaseNum(fNum, dNum, tCorr) - cycle * PHASE_DEN;
    // 残差(µs) = resNum/PHASE_DEN 周 ÷ f(Hz) × 1e6
    const residualUs =
      (Number(resNum) / Number(PHASE_DEN)) * (1e18 / Number(fNum));
    return {
      toaId: toa.id,
      seq: toa.seq,
      tUs: toa.tUs,
      bandMHz: toa.bandMHz,
      excluded: branch.exclusions.has(toa.id),
      cycle,
      wrapped: wrappedPhase(fNum, dNum, tCorr),
      residualUs,
      appliedClockSeqs: clockOffsetAt(events, toa.tUs).appliedSeqs,
    };
  });
}

export interface ResidualSummary {
  branchId?: number;
  inputVersion: number;
  count: number;
  excludedCount: number;
  rmsUs: number;
  meanUs: number;
  maxAbsUs: number;
  /** 拟合是否被数据支持（RMS 低于噪声地板） */
  viable: boolean;
  /** 可识别：拟合可用且不存在不可区分的替代周数方案 */
  identifiable: boolean;
  competitors: Competitor[];
}

export interface Competitor {
  kind: "gap-shift" | "branch";
  boundaryTUs?: string;
  delta?: string;
  otherBranchId?: number;
  rmsUs: number;
}

export function summarize(
  residuals: ToaResidual[],
  inputVersion: number,
): Omit<ResidualSummary, "identifiable" | "competitors" | "viable"> {
  const used = residuals.filter((r) => !r.excluded);
  const n = used.length;
  if (n === 0) {
    return {
      inputVersion,
      count: 0,
      excludedCount: residuals.length,
      rmsUs: 0,
      meanUs: 0,
      maxAbsUs: 0,
    };
  }
  const mean = used.reduce((s, r) => s + r.residualUs, 0) / n;
  const rms = Math.sqrt(used.reduce((s, r) => s + r.residualUs ** 2, 0) / n);
  const maxAbs = Math.max(...used.map((r) => Math.abs(r.residualUs)));
  return {
    inputVersion,
    count: n,
    excludedCount: residuals.length - n,
    rmsUs: rms,
    meanUs: mean,
    maxAbsUs: maxAbs,
  };
}

/** 空档：相邻未排除到达时刻间距 >= minGapUs，边界取空档后第一个到达时刻 */
export function findGaps(
  toas: Toa[],
  exclusions: Set<number>,
  minGapUs: bigint = 10n * DAY_US,
): bigint[] {
  const used = toas
    .filter((t) => !exclusions.has(t.id))
    .sort((a, b) => (a.tUs < b.tUs ? -1 : 1));
  const boundaries: bigint[] = [];
  for (let i = 1; i < used.length; i++) {
    if (used[i].tUs - used[i - 1].tUs >= minGapUs) {
      boundaries.push(used[i].tUs);
    }
  }
  return boundaries;
}

/**
 * 对 (f, fdot) 做未加权最小二乘拟合（浮点仅用于参数估计，
 * 整周编号始终保持精确整数输入）。
 */
export function fitParams(
  samples: { dtUs: bigint; cycle: bigint }[],
): { fHz: number; fdot: number; rmsUs: number } {
  let a = 0,
    b = 0,
    c = 0,
    u = 0,
    v = 0;
  for (const s of samples) {
    const dt = Number(s.dtUs) / 1e6;
    const n = Number(s.cycle);
    a += dt * dt;
    b += 0.5 * dt ** 3;
    c += 0.25 * dt ** 4;
    u += n * dt;
    v += 0.5 * n * dt * dt;
  }
  const det = a * c - b * b;
  if (det === 0 || samples.length < 2) {
    return { fHz: 0, fdot: 0, rmsUs: Number.POSITIVE_INFINITY };
  }
  const f = (u * c - v * b) / det;
  const g = (a * v - b * u) / det;
  let acc = 0;
  for (const s of samples) {
    const dt = Number(s.dtUs) / 1e6;
    const resTurns = f * dt + 0.5 * g * dt * dt - Number(s.cycle);
    acc += ((resTurns / f) * 1e6) ** 2;
  }
  return { fHz: f, fdot: g, rmsUs: Math.sqrt(acc / samples.length) };
}

/** 可识别性不足判定阈值：RMS 低于 max(基准×1.05, 噪声地板) 视为等价方案 */
export const IDENT_RMS_FACTOR = 1.05;
export const IDENT_NOISE_FLOOR_US = 25;

/**
 * 对每个空档尝试 ±1 周替代方案并重拟合 (f, fdot)。
 * 若替代方案 RMS 与基准不可区分，则两个方案都不可识别，需并列保留。
 */
export function checkIdentifiability(
  toas: Toa[],
  events: ClockEvent[],
  branch: BranchInput,
  baseRmsUs: number,
): Competitor[] {
  const gaps = findGaps(toas, branch.exclusions);
  const threshold = Math.max(
    baseRmsUs * IDENT_RMS_FACTOR,
    IDENT_NOISE_FLOOR_US,
  );
  const competitors: Competitor[] = [];
  const used = toas.filter((t) => !branch.exclusions.has(t.id));
  for (const boundary of gaps) {
    for (const delta of [1n, -1n]) {
      const altShifts: CycleShift[] = [
        ...branch.shifts,
        { id: Number.MAX_SAFE_INTEGER, branchId: -1, boundaryTUs: boundary, delta },
      ];
      const samples = used.map((t) => ({
        dtUs: correctedTUs(t, branch.params, events),
        cycle: t.cycleBase + cycleShiftAt(altShifts, t.tUs),
      }));
      const fit = fitParams(samples);
      if (fit.rmsUs <= threshold) {
        competitors.push({
          kind: "gap-shift",
          boundaryTUs: boundary.toString(),
          delta: delta.toString(),
          rmsUs: fit.rmsUs,
        });
      }
    }
  }
  return competitors;
}

/**
 * 跨分支可识别性：若另一分支的周数方案（shift 集合）不同，
 * 但在当前输入版本的全部共同未排除到达时刻上残差差异不超过
 * 噪声地板，则数据不足以区分两个方案 —— 两者并列保留并标记。
 */
export function crossBranchCompetitors(
  residuals: ToaResidual[],
  siblings: { branchId: number; residuals: ToaResidual[] }[],
): Competitor[] {
  const competitors: Competitor[] = [];
  for (const s of siblings) {
    const byId = new Map(s.residuals.map((r) => [r.toaId, r]));
    let maxDiff = 0;
    for (const r of residuals) {
      if (r.excluded) continue;
      const other = byId.get(r.toaId);
      if (!other || other.excluded) continue;
      maxDiff = Math.max(maxDiff, Math.abs(r.residualUs - other.residualUs));
    }
    if (maxDiff <= IDENT_NOISE_FLOOR_US) {
      competitors.push({
        kind: "branch",
        otherBranchId: s.branchId,
        rmsUs: maxDiff,
      });
    }
  }
  return competitors;
}

export function fullSummary(
  branchId: number,
  toas: Toa[],
  events: ClockEvent[],
  branch: BranchInput,
  siblings: { branchId: number; residuals: ToaResidual[] }[] = [],
): ResidualSummary {
  const residuals = computeResiduals(toas, events, branch);
  const inputVersion = toas[0]?.inputVersion ?? 0;
  const base = summarize(residuals, inputVersion);
  const competitors = [
    ...checkIdentifiability(toas, events, branch, base.rmsUs),
    ...crossBranchCompetitors(residuals, siblings),
  ];
  const viable = base.count > 0 && base.rmsUs <= IDENT_NOISE_FLOOR_US;
  return {
    ...base,
    branchId,
    viable,
    identifiable: viable && competitors.length === 0,
    competitors,
  };
}

/** 供测试与导入使用：由真值参数直接求整周（精确） */
export function exactCycleAt(params: TimingParams, tUs: bigint): bigint {
  return cycleOf(params.fNum, params.dNum, tUs);
}
