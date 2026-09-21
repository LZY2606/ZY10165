import { TIE_RMS_TOL_S } from './constants.js';
import {
  applyGapOffsets,
  canonicalWrappedPhase,
  clockCorrectionNs,
  dmDelaySeconds,
  nsToSeconds,
} from './phase.js';
import type {
  ClockEvent,
  FitParams,
  FitSummary,
  GapDef,
  PointResidual,
  ToaView,
} from './types.js';

export interface FitInput {
  toas: ToaView[];
  gaps: GapDef[];
  gapOffsets: Record<string, number>;
  clockEvents: ClockEvent[];
  excluded: Set<string>;
  refNs: bigint;
  f0Nominal: number;
}

interface DesignRow {
  code: string;
  cols: number[];
  y: number;
  sigma: number;
  freqMhz: number;
  uS: number;
}

/**
 * 到达时刻计时模型（以历元 tRef 中心化）：
 *   t_obs(freq) - tRef = u
 *               = (N_eff + w - phase0Nom)/f0Nom
 *                 + a + b*u + c*u^2/2 + q*dDM(freq)
 * 其中 N_eff 为确切 BigInt 整数周展开（不做浮点取模），
 * dDM(freq) = 4.148808e-3 * (freq^-2 - 1400^-2)，单位秒（DM=1）。
 * 拟合参数 [a(秒), b, c(1/s), q=DM]，条件良好后映射回
 *   phi0 = phase0Nom - a*f0Nom；f0 = f0Nom/(1+b)；f1 = -c*f0Nom/(1+b)。
 */
export function buildRows(input: FitInput): DesignRow[] {
  const tRefS = nsToSeconds(input.refNs);
  const rows: DesignRow[] = [];
  for (const toa of input.toas) {
    const { correctionNs } = clockCorrectionNs(toa.tNs, input.clockEvents);
    const tObsS = nsToSeconds(toa.tNs - correctionNs);
    const nEff = applyGapOffsets(toa, input.gaps, input.gapOffsets);
    const w = canonicalWrappedPhase(toa.wrapped);
    const nominalPhaseS = (Number(nEff) + w) / input.f0Nominal;
    const uS = tObsS - tRefS;
    rows.push({
      code: toa.code,
      y: uS - nominalPhaseS,
      cols: [1, uS, uS * uS * 0.5, dmDelaySeconds(toa.freqMhz, 1)],
      sigma: toa.sigmaS,
      freqMhz: toa.freqMhz,
      uS,
    });
  }
  return rows;
}

function solveWeightedLeastSquares(
  rows: DesignRow[],
): { beta: number[]; residual: Map<string, number> } {
  const p = 4;
  const ata = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const aty = new Array<number>(p).fill(0);
  for (const row of rows) {
    const weight = 1 / (row.sigma * row.sigma);
    for (let i = 0; i < p; i++) {
      const xi = row.cols[i]!;
      const ataRow = ata[i]!;
      for (let j = 0; j < p; j++) ataRow[j] = ataRow[j]! + weight * xi * row.cols[j]!;
      aty[i] = aty[i]! + weight * xi * row.y;
    }
  }
  const beta = gaussianSolve(ata, aty);
  const residual = new Map<string, number>();
  for (const row of rows) {
    let predicted = 0;
    for (let i = 0; i < p; i++) predicted += beta[i]! * row.cols[i]!;
    residual.set(row.code, row.y - predicted);
  }
  return { beta, residual };
}

function gaussianSolve(aIn: number[][], bIn: number[]): number[] {
  const n = aIn.length;
  const a: number[][] = aIn.map((row) => row.slice());
  const b: number[] = bIn.slice();
  const at = (i: number, j: number): number => {
    const value = a[i]?.[j];
    if (value === undefined) throw new Error('内部错误：矩阵越界');
    return value;
  };
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(at(r, col)) > Math.abs(at(pivot, col))) pivot = r;
    }
    if (Math.abs(at(pivot, col)) < 1e-30) {
      throw new Error(`拟合矩阵在第 ${col + 1} 列奇异，观测不足以分离参数`);
    }
    const pivotRow = a[col]!;
    a[col] = a[pivot]!;
    a[pivot] = pivotRow;
    const bPivot = b[col]!;
    b[col] = b[pivot]!;
    b[pivot] = bPivot;
    const pivotValue = a[col]![col]!;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = at(r, col) / pivotValue;
      if (factor === 0) continue;
      const rowR = a[r]!;
      const rowCol = a[col]!;
      for (let c = col; c < n; c++) rowR[c] = at(r, c) - factor * rowCol[c]!;
      b[r] = b[r]! - factor * b[col]!;
    }
  }
  return b.map((value, i) => value / a[i]![i]!);
}

export function buildPointResiduals(
  toas: ToaView[],
  gaps: GapDef[],
  gapOffsets: Record<string, number>,
  clockEvents: ClockEvent[],
  excluded: Set<string>,
  residual: Map<string, number>,
): PointResidual[] {
  return toas.map((toa) => {
    const { correctionNs } = clockCorrectionNs(toa.tNs, clockEvents);
    const nEff = applyGapOffsets(toa, gaps, gapOffsets);
    return {
      toaCode: toa.code,
      session: toa.session,
      tNs: toa.tNs.toString(),
      freqMhz: toa.freqMhz,
      nCyclesEffective: nEff.toString(),
      wrapped: canonicalWrappedPhase(toa.wrapped),
      excluded: excluded.has(toa.code),
      residualS: residual.get(toa.code) ?? Number.NaN,
      clockAppliedNs: correctionNs.toString(),
    };
  });
}

export function fitRows(
  rows: DesignRow[],
  f0Nominal: number,
  nominalPhase0Cycles: number,
): { params: FitParams; beta: number[]; residual: Map<string, number> } {
  const { beta, residual } = solveWeightedLeastSquares(rows);
  const onePlusB = 1 + beta[1]!;
  const params: FitParams = {
    phi0S: nominalPhase0Cycles - beta[0]! * f0Nominal,
    f0Hz: f0Nominal / onePlusB,
    f1HzS: (-beta[2]! * f0Nominal) / onePlusB,
    dm: beta[3]!,
  };
  return { params, beta, residual };
}

export function summarize(
  rows: DesignRow[],
  residual: Map<string, number>,
): Pick<FitSummary, 'rmsS' | 'chi2' | 'maxAbsS' | 'dof'> {
  let chi2 = 0;
  let sqSum = 0;
  let maxAbs = 0;
  for (const row of rows) {
    const r = residual.get(row.code) ?? 0;
    chi2 += (r / row.sigma) ** 2;
    sqSum += r * r;
    if (Math.abs(r) > maxAbs) maxAbs = Math.abs(r);
  }
  return {
    rmsS: Math.sqrt(sqSum / rows.length),
    chi2,
    maxAbsS: maxAbs,
    dof: rows.length - 4,
  };
}

export function fitBranch(
  opts: {
    gapOffsets: Record<string, number>;
    excluded: Set<string>;
    clockEvents: ClockEvent[];
  },
  toas: ToaView[],
  gaps: GapDef[],
  refNs: bigint,
  f0Nominal: number,
  nominalPhase0Cycles: number,
  meta: { inputHash: string; nowIso: string },
): FitSummary {
  const allRows = buildRows({
    toas,
    gaps,
    gapOffsets: opts.gapOffsets,
    clockEvents: opts.clockEvents,
    excluded: opts.excluded,
    refNs,
    f0Nominal,
  });
  const activeRows = allRows.filter((row) => !opts.excluded.has(row.code));
  if (activeRows.length < 4) {
    throw new Error(
      `至少需要 4 个未排除观测拟合 4 参数，当前 ${activeRows.length} 个`,
    );
  }
  const { params, residual } = fitRows(
    activeRows,
    f0Nominal,
    nominalPhase0Cycles,
  );
  const stats = summarize(activeRows, residual);
  const points = buildPointResiduals(
    toas,
    gaps,
    opts.gapOffsets,
    opts.clockEvents,
    opts.excluded,
    residual,
  );
  return {
    params,
    ...stats,
    points,
    inputHash: meta.inputHash,
    fittedAt: meta.nowIso,
  };
}

export function isStatisticallyTied(a: FitSummary, b: FitSummary): boolean {
  return (
    Math.abs(a.rmsS - b.rmsS) <= TIE_RMS_TOL_S &&
    Math.abs(a.chi2 - b.chi2) <= TIE_RMS_TOL_S * 1e6
  );
}
