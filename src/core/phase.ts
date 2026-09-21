import { NS_PER_SEC, DM_K_S, DM_REF_MHZ } from './constants.js';
import type { ToaView, ClockEvent, GapDef, SessionCode } from './types.js';

export function nsToSeconds(tNs: bigint): number {
  return Number(tNs) / Number(NS_PER_SEC);
}

export function secondsToNs(s: number): bigint {
  return BigInt(Math.round(s * Number(NS_PER_SEC)));
}

export function dmDelaySeconds(freqMhz: number, dm: number): number {
  const inv = (f: number) => 1 / (f * f);
  return (DM_K_S / 1e3) * dm * (inv(freqMhz) - inv(DM_REF_MHZ));
}

export function canonicalWrappedPhase(w: number): number {
  const z = ((w % 1) + 1) % 1;
  return Object.is(z, -0) ? 0 : z;
}

export function applyGapOffsets(
  toa: Pick<ToaView, 'session' | 'nCycles'>,
  gaps: GapDef[],
  offsets: Record<string, number>,
): bigint {
  let cycles = toa.nCycles;
  for (const gap of gaps) {
    if (isAtOrAfterGap(toa.session, gap)) {
      const shift = offsets[String(gap.index)];
      cycles += BigInt(shift ?? 0);
    }
  }
  return cycles;
}

function isAtOrAfterGap(session: SessionCode, gap: GapDef): boolean {
  const order: SessionCode[] = ['A', 'B', 'C'];
  return order.indexOf(session) >= order.indexOf(gap.beforeSession);
}

/**
 * 右连续时钟语义：观测台钟读数 tObs 与太阳系参考时 t 的关系为
 *   tObs = t + sum{ jump : event.atNs <= tObs }
 * 即事件恰好在观测时刻时计入一次（[at, +∞)）。
 * 同时刻多事件按不可变 seq 升序合成，结果与排序输入无关。
 */
export function clockCorrectionNs(
  toaNs: bigint,
  events: ClockEvent[],
): { correctionNs: bigint; applied: ClockEvent[] } {
  const applied = events
    .filter((event) => event.atNs <= toaNs)
    .slice()
    .sort((a, b) => a.seq - b.seq);
  let correctionNs = 0n;
  for (const event of applied) correctionNs += event.jumpNs;
  return { correctionNs, applied };
}

export function correctedToaNs(toaNs: bigint, events: ClockEvent[]): bigint {
  const { correctionNs } = clockCorrectionNs(toaNs, events);
  return toaNs - correctionNs;
}

/**
 * 展开的整数相位（周）——直接使用存储的 BigInt 整数周与空档偏移相加，
 * 绝不使用浮点 % 1 / Math.round 从包裹相位反推大计数。
 */
export function expandedPhaseCycles(
  toa: Pick<ToaView, 'session' | 'nCycles' | 'wrapped'>,
  gaps: GapDef[],
  offsets: Record<string, number>,
): { whole: bigint; frac: number; total: number } {
  const whole = applyGapOffsets(toa, gaps, offsets);
  const frac = canonicalWrappedPhase(toa.wrapped);
  return { whole, frac, total: Number(whole) + frac };
}
