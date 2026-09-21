import { describe, expect, it } from 'vitest';
import { applyGapOffsets, canonicalWrappedPhase, clockCorrectionNs, expandedPhaseCycles } from '../src/core/phase.js';
import { GAPS } from '../src/core/fixtures/gen.js';
import type { ClockEvent } from '../src/core/types.js';

describe('确切整数周展开', () => {
  it('整周计数始终使用 bigint 且跨空档仅做整数加法', () => {
    const toa = { session: 'C' as const, nCycles: 259300000n };
    expect(applyGapOffsets(toa, GAPS, { '0': 1, '1': -2 })).toBe(259299999n);
    expect(applyGapOffsets(toa, GAPS, { '0': -5, '1': 0 })).toBe(259299995n);
  });

  it('巨大整数周不经过浮点取模，无精度丢失', () => {
    const huge = { session: 'C' as const, nCycles: 9_007_199_254_740_993n };
    const shifted = applyGapOffsets(huge, GAPS, { '0': 1, '1': 1 });
    expect(shifted).toBe(9_007_199_254_740_995n);
    const expanded = expandedPhaseCycles(
      { ...huge, wrapped: 0.25 },
      GAPS,
      { '0': 0, '1': 0 },
    );
    expect(expanded.whole).toBe(9_007_199_254_740_993n);
    expect(BigInt(Math.trunc(expanded.total))).not.toBe(expanded.whole);
    expect(Number.isSafeInteger(expanded.whole)).toBe(false);
    expect(typeof expanded.whole === 'bigint').toBe(true);
  });

  it('包裹相位归一化到 [0,1)，且不用于反推整周', () => {
    expect(canonicalWrappedPhase(-0.2)).toBeCloseTo(0.8, 12);
    expect(canonicalWrappedPhase(1.3)).toBeCloseTo(0.3, 12);
  });

  it('右连续：事件恰落在观测时刻时只应用一次', () => {
    const t = 1_000_000_000_000_000_000n;
    const events: ClockEvent[] = [
      { seq: 2, branchId: 'H01', atNs: t, jumpNs: 100n, label: 'later' },
      { seq: 1, branchId: 'H01', atNs: t, jumpNs: 5n, label: 'first' },
      { seq: 3, branchId: 'H01', atNs: t + 1n, jumpNs: 7n, label: 'after' },
    ];
    const exact = clockCorrectionNs(t, events);
    expect(exact.correctionNs).toBe(105n);
    expect(exact.applied.map((event) => event.seq)).toEqual([1, 2]);
    const before = clockCorrectionNs(t - 1n, events);
    expect(before.correctionNs).toBe(0n);
    const after = clockCorrectionNs(t + 1n, events);
    expect(after.correctionNs).toBe(112n);
  });

  it('同一时刻多事件按不可变 seq 合成，与输入顺序无关', () => {
    const t = 50n;
    const events: ClockEvent[] = [
      { seq: 3, branchId: 'h', atNs: t, jumpNs: 30n, label: 'c' },
      { seq: 1, branchId: 'h', atNs: t, jumpNs: 10n, label: 'a' },
      { seq: 2, branchId: 'h', atNs: t, jumpNs: 20n, label: 'b' },
    ];
    expect(clockCorrectionNs(t, events).correctionNs).toBe(60n);
    expect(clockCorrectionNs(t, [...events].reverse()).correctionNs).toBe(60n);
  });
});
