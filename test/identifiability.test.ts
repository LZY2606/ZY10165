import { describe, expect, it } from 'vitest';
import { TimingStore } from '../src/core/store.js';
import { loadFixtureBundle } from '../src/core/fixtures/load.js';
import { isStatisticallyTied } from '../src/core/fit.js';
import { VERSION_BASELINE, VERSION_WITH_ENDPOINT } from '../src/core/fixtures/gen.js';

function newStore(initialVersion = VERSION_BASELINE) {
  const bundle = loadFixtureBundle();
  const store = new TimingStore(bundle);
  store.reset();
  store.setActiveVersion(initialVersion);
  const now = '2026-09-22T00:00:00.000Z';
  const k0 = store.createBranch({ id: 'H01', label: 'k0', nowIso: now });
  const k1 = store.createBranch({ id: 'H02', label: 'k1', fromBranchId: 'H01', nowIso: now });
  store.adjustGapOffset('H02', 0, 1);
  void k0;
  void k1;
  store.refitAll(now);
  return { store, bundle };
}

describe('整数周方案的可识别性', () => {
  it('回退末端望次后两方案统计并列并被标记为可识别性不足', () => {
    const { store } = newStore(VERSION_BASELINE);
    store.refitAll('2026-09-22T01:00:00.000Z');
    const k0 = store.requireBranch('H01');
    const k1 = store.requireBranch('H02');
    expect(k0.fit).not.toBeNull();
    expect(k1.fit).not.toBeNull();
    expect(k0.fit!.rmsS).toBeLessThan(1e-9);
    expect(k1.fit!.rmsS).toBeLessThan(1e-9);
    expect(isStatisticallyTied(k0.fit!, k1.fit!)).toBe(true);
    expect(k0.underidentifiedWith).toContain('H02');
    expect(k1.underidentifiedWith).toContain('H01');
    expect(k0.fit!.params.dm).toBeCloseTo(100, 6);
  });

  it('加入末端观测后两方案可以区分，错周方案残差显著', () => {
    const { store } = newStore(VERSION_BASELINE);
    store.setActiveVersion(VERSION_WITH_ENDPOINT);
    store.refitAll('2026-09-22T02:00:00.000Z');
    const k0 = store.requireBranch('H01');
    const k1 = store.requireBranch('H02');
    expect(k0.fit!.rmsS).toBeLessThan(1e-9);
    expect(k1.fit!.rmsS).toBeGreaterThan(1e-7);
    expect(isStatisticallyTied(k0.fit!, k1.fit!)).toBe(false);
    expect(k0.underidentifiedWith).toEqual([]);
    const comparison = store.compare('H01', 'H02');
    const endpoint = comparison.points.find((point) => point.toaCode.startsWith('C'));
    expect(endpoint).toBeDefined();
    expect(Math.abs(endpoint!.deltaResidualS)).toBeGreaterThan(1e-7);
  });

  it('并列与可区分状态可随输入版本反复切换且两个分支都保留', () => {
    const { store } = newStore(VERSION_BASELINE);
    for (const [version, tied] of [
      [VERSION_BASELINE, true],
      [VERSION_WITH_ENDPOINT, false],
      [VERSION_BASELINE, true],
    ] as const) {
      store.setActiveVersion(version);
      store.refitAll('2026-09-22T03:00:00.000Z');
      const k0 = store.requireBranch('H01');
      const k1 = store.requireBranch('H02');
      expect(isStatisticallyTied(k0.fit!, k1.fit!)).toBe(tied);
      expect(store.branches.size).toBe(2);
    }
  });
});
