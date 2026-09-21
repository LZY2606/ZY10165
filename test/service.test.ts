import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { openDatabase } from '../src/server/db.js';
import { Repository } from '../src/server/repository.js';
import { TimingService } from '../src/server/service.js';
import { loadFixtureBundle } from '../src/core/fixtures/load.js';
import { VERSION_BASELINE, VERSION_WITH_ENDPOINT } from '../src/core/fixtures/gen.js';

let tempDir = '';
let dbPath = '';

function freshService() {
  const db = openDatabase(dbPath);
  const repository = new Repository(db);
  const service = new TimingService(loadFixtureBundle(), repository);
  service.initializeFromPersistence();
  return { service, db };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'pcv-'));
  dbPath = join(tempDir, 'test.sqlite');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('服务层与时钟右连续语义', () => {
  it('时钟跳变恰落在观测时刻时只应用一次（t>=at）', () => {
    const { service } = freshService();
    const tB = service.snapshot().toas.find((toa) => toa.session === 'B')!.tNs;
    service.addClockEvent({
      branchId: 'H01',
      atNs: BigInt(tB),
      jumpNs: 1_000n,
      label: 'boundary',
    });
    const branch = service.snapshot().branches.find((b) => b.id === 'H01')!;
    const pointB = branch.fit!.points.find((p) => p.toaCode.startsWith('B'))!;
    const pointA = branch.fit!.points.find((p) => p.toaCode.startsWith('A'))!;
    expect(BigInt(pointB.clockAppliedNs)).toBe(1_000n);
    expect(BigInt(pointA.clockAppliedNs)).toBe(0n);
    const ops = service.snapshot().operationsCount;
    expect(ops).toBeGreaterThan(0);
  });

  it('同时刻两个事件按不可变序号合成，且都在边界应用一次', () => {
    const { service } = freshService();
    const tB = service.snapshot().toas.find((toa) => toa.session === 'B')!.tNs;
    service.addClockEvent({ branchId: 'H01', atNs: BigInt(tB), jumpNs: 300n, label: 'c' });
    service.addClockEvent({ branchId: 'H01', atNs: BigInt(tB), jumpNs: 100n, label: 'a' });
    service.addClockEvent({ branchId: 'H01', atNs: BigInt(tB), jumpNs: 200n, label: 'b' });
    const branch = service.snapshot().branches.find((b) => b.id === 'H01')!;
    const pointB = branch.fit!.points.find((p) => p.toaCode.startsWith('B'))!;
    expect(BigInt(pointB.clockAppliedNs)).toBe(600n);
    expect(branch.clockEvents.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('排除候选会改变拟合集合，恢复后复原', () => {
    const { service } = freshService();
    service.switchVersion(VERSION_WITH_ENDPOINT);
    const before = service.snapshot().branches.find((b) => b.id === 'H02')!.fit!.rmsS;
    service.setExcluded('H02', 'C1-1400', true);
    const tiedAfterExclude = service.snapshot().branches.find((b) => b.id === 'H02')!.fit!.rmsS;
    expect(tiedAfterExclude).toBeLessThan(1e-9);
    expect(tiedAfterExclude).not.toBeCloseTo(before, 20);
    service.setExcluded('H02', 'C1-1400', false);
    const restored = service.snapshot().branches.find((b) => b.id === 'H02')!.fit!.rmsS;
    expect(restored).toBeCloseTo(before, 20);
  });

  it('SQLite 持久化：关闭后重开，分支/事件/拟合/日志完全恢复', () => {
    const { service, db } = freshService();
    const tB = service.snapshot().toas.find((toa) => toa.session === 'B')!.tNs;
    service.addClockEvent({ branchId: 'H02', atNs: BigInt(tB), jumpNs: 42n, label: 'persisted' });
    service.setExcluded('H01', 'A3-400', true);
    const exportedRms = service.snapshot().branches.map((b) => b.fit?.rmsS);
    db.close();

    const second = freshService();
    const snapshot = second.service.snapshot();
    expect(snapshot.branches).toHaveLength(2);
    const h02 = snapshot.branches.find((b) => b.id === 'H02')!;
    expect(h02.clockEvents).toHaveLength(1);
    expect(h02.clockEvents[0]!.jumpNs.toString()).toBe('42');
    const h01 = snapshot.branches.find((b) => b.id === 'H01')!;
    expect(h01.excluded).toContain('A3-400');
    expect(snapshot.branches.map((b) => b.fit?.rmsS)).toEqual(exportedRms);
    expect(snapshot.operationsCount).toBeGreaterThan(1);
    second.db.close();
  });

  it('导出 -> 清空数据库 -> 导入重放后输入哈希一致、状态复原', () => {
    const { service, db } = freshService();
    service.switchVersion(VERSION_WITH_ENDPOINT);
    const tB = service.snapshot().toas.find((toa) => toa.session === 'B')!.tNs;
    service.addClockEvent({ branchId: 'H01', atNs: BigInt(tB), jumpNs: 9n, label: 'exp' });
    const envelope = service.exportRun();
    const beforeBranches = service.snapshot().branches.map((b) => ({
      id: b.id,
      gaps: { ...b.gapOffsets },
      excluded: [...b.excluded],
      rms: b.fit?.rmsS,
      clocks: b.clockEvents.map((e) => e.seq),
    }));
    db.close();

    const reimport = freshService();
    const report = reimport.service.importRun(envelope);
    expect(report.fixtureHashBefore).toBe(report.fixtureHashAfter);
    expect(report.operationsReplayed).toBe(envelope.operations.length);
    const after = reimport.service.snapshot();
    expect(after.activeVersion).toBe(VERSION_WITH_ENDPOINT);
    expect(
      after.branches.map((b) => ({
        id: b.id,
        gaps: { ...b.gapOffsets },
        excluded: [...b.excluded],
        rms: b.fit?.rmsS,
        clocks: b.clockEvents.map((e) => e.seq),
      })),
    ).toEqual(beforeBranches);
    reimport.db.close();
  });

  it('重置可清空数据库并从固定 fixture 复核重建', () => {
    const { service } = freshService();
    service.switchVersion(VERSION_WITH_ENDPOINT);
    service.seed();
    const snapshot = service.snapshot();
    expect(snapshot.activeVersion).toBe(VERSION_BASELINE);
    expect(snapshot.branches).toHaveLength(2);
    expect(snapshot.branches.every((b) => b.fit !== null)).toBe(true);
  });
});
