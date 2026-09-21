import { createHash } from 'node:crypto';
import { TimingStore, type ExportEnvelope, type FixtureBundle } from '../core/store.js';
import { replayEnvelope, type ReplayResult } from '../core/replay.js';
import { hashToas } from '../core/hash.js';
import type { BranchRecord, ClockEvent } from '../core/types.js';
import { Repository } from './repository.js';

export interface SnapshotView {
  activeVersion: string;
  versions: Array<{
    id: string;
    label: string;
    toaHash: string;
    count: number;
  }>;
  gaps: FixtureBundle['gaps'];
  spec: {
    tRefNs: string;
    f0NominalHz: number;
    f1TrueHzS: number;
    dmTrue: number;
    phase0Cycles: number;
    gapS: number;
    endpointOffsetS: number;
  };
  toas: ReturnType<TimingStore['version']>['toas'];
  branches: BranchRecord[];
  operationsCount: number;
  underidentifiedPairs: Array<[string, string]>;
}

export class TimingService {
  readonly store: TimingStore;

  constructor(
    private readonly bundle: FixtureBundle,
    private readonly repository: Repository,
  ) {
    this.store = new TimingStore(bundle);
  }

  initializeFromPersistence(): { seeded: boolean } {
    const persisted = this.repository.loadPersistedState(this.bundle);
    if (persisted.branches.length === 0 && persisted.operations.length === 0) {
      this.seed();
      return { seeded: true };
    }
    this.store.reset();
    this.store.activeVersion = this.bundle.versions.some(
      (version) => version.versionId === persisted.activeVersion,
    )
      ? persisted.activeVersion
      : this.bundle.versions[0]!.versionId;

    const clockEvents = new Map<string, ClockEvent[]>();
    for (const branch of persisted.branches) {
      const created = this.store.createBranch({
        id: branch.id,
        label: branch.label,
        fromBranchId: null,
        baseVersion: branch.baseVersion,
        note: branch.note,
        nowIso: branch.createdAt,
      });
      created.gapOffsets = { ...branch.gapOffsets };
      created.excluded = [...branch.excluded];
      created.clockEvents = branch.clockEvents.map((event) => ({ ...event }));
      created.parentId = branch.parentId;
      created.underidentifiedWith = [...branch.underidentifiedWith];
      created.fit = branch.fit;
      created.inputHash = branch.inputHash;
      clockEvents.set(branch.id, created.clockEvents);
    }
    for (const operation of persisted.operations) {
      this.store.operations.push(operation);
    }
    return { seeded: false };
  }

  seed(): void {
    const nowIso = new Date().toISOString();
    this.store.reset();
    this.repository.resetDatabase();
    this.repository.persistFixture(this.bundle, nowIso);
    const h0 = this.store.createBranch({
      id: 'H01',
      label: '周偏移 k=0',
      nowIso,
      note: '空档前后整数周连续的参考分支',
    });
    const h1 = this.store.createBranch({
      id: 'H02',
      label: '周偏移 k=+1',
      fromBranchId: 'H01',
      nowIso,
      note: '跨空档多计一周的竞争分支',
    });
    this.store.adjustGapOffset('H02', 0, 1);
    this.store.refitAll(nowIso);
    void h0;
    void h1;
    this.store.logOperation({
      seq: 1,
      ts: nowIso,
      kind: 'seed',
      branchId: null,
      datasetVersion: this.store.activeVersion,
      inputHash: hashToas(this.store.activeToas),
      payload: { versions: this.bundle.versions.map((v) => v.versionId) },
    });
    this.store.logOperation({
      seq: 2,
      ts: nowIso,
      kind: 'create_branch',
      branchId: 'H01',
      datasetVersion: this.store.activeVersion,
      inputHash: h0.inputHash,
      payload: {
        label: h0.label,
        fromBranchId: null,
        baseVersion: h0.baseVersion,
        gapOffsets: h0.gapOffsets,
        note: h0.note,
      },
    });
    this.store.logOperation({
      seq: 3,
      ts: nowIso,
      kind: 'create_branch',
      branchId: 'H02',
      datasetVersion: this.store.activeVersion,
      inputHash: this.store.requireBranch('H02').inputHash,
      payload: {
        label: h1.label,
        fromBranchId: 'H01',
        baseVersion: h1.baseVersion,
        gapOffsets: h1.gapOffsets,
        note: h1.note,
      },
    });
    this.persistAll(nowIso);
  }

  snapshot(): SnapshotView {
    const toas = this.store.activeToas;
    const pairs: Array<[string, string]> = [];
    const list = [...this.store.branches.values()];
    for (let i = 0; i < list.length; i++) {
      for (const id of list[i]!.underidentifiedWith) {
        if (id > list[i]!.id) pairs.push([list[i]!.id, id]);
      }
    }
    return {
      activeVersion: this.store.activeVersion,
      versions: this.bundle.versions.map((version) => ({
        id: version.versionId,
        label: version.label,
        toaHash: hashToas(version.toas.map((t) => ({ ...t, active: true }))),
        count: version.toas.length,
      })),
      gaps: this.bundle.gaps,
      spec: {
        tRefNs: this.bundle.spec.tRefNs.toString(),
        f0NominalHz: this.bundle.spec.f0Nominal,
        f1TrueHzS: this.bundle.spec.f1True,
        dmTrue: this.bundle.spec.dmTrue,
        phase0Cycles: this.bundle.spec.phase0Cycles,
        gapS: this.bundle.spec.gapS,
        endpointOffsetS: this.bundle.spec.endpointOffsetS,
      },
      toas,
      branches: list,
      operationsCount: this.store.operations.length,
      underidentifiedPairs: pairs,
    };
  }

  switchVersion(versionId: string): void {
    this.store.setActiveVersion(versionId);
    this.repository.setMeta('active_version', versionId);
    const nowIso = new Date().toISOString();
    this.store.refitAll(nowIso);
    this.recordOperation({
      kind: 'switch_version',
      branchId: null,
      payload: { versionId },
      inputHash: hashToas(this.store.activeToas),
      ts: nowIso,
    });
    this.persistAll(nowIso);
  }

  createBranch(request: {
    label: string;
    fromBranchId: string | null;
    gapOffsets?: Record<string, number>;
    note?: string;
  }): BranchRecord {
    const nowIso = new Date().toISOString();
    const branch = this.store.createBranch({
      label: request.label,
      fromBranchId: request.fromBranchId,
      gapOffsets: request.gapOffsets,
      note: request.note,
      nowIso,
    });
    this.store.refitAll(nowIso);
    this.recordOperation({
      kind: 'create_branch',
      branchId: branch.id,
      payload: {
        label: branch.label,
        fromBranchId: request.fromBranchId,
        baseVersion: branch.baseVersion,
        gapOffsets: branch.gapOffsets,
        note: branch.note,
      },
      inputHash: branch.inputHash,
      ts: nowIso,
    });
    this.persistAll(nowIso);
    return branch;
  }

  adjustGapOffset(branchId: string, gapIndex: number, delta: number): BranchRecord {
    const nowIso = new Date().toISOString();
    const branch = this.store.adjustGapOffset(branchId, gapIndex, delta);
    this.store.refitAll(nowIso);
    this.recordOperation({
      kind: 'adjust_gap_offset',
      branchId,
      payload: { branchId, gapIndex, delta },
      inputHash: branch.inputHash,
      ts: nowIso,
    });
    this.persistAll(nowIso);
    return branch;
  }

  setExcluded(branchId: string, toaCode: string, excluded: boolean): BranchRecord {
    const nowIso = new Date().toISOString();
    const branch = this.store.setExcluded(branchId, toaCode, excluded);
    this.store.refitAll(nowIso);
    this.recordOperation({
      kind: 'set_excluded',
      branchId,
      payload: { branchId, toaCode, excluded },
      inputHash: branch.inputHash,
      ts: nowIso,
    });
    this.persistAll(nowIso);
    return branch;
  }

  addClockEvent(request: {
    branchId: string;
    atNs: bigint;
    jumpNs: bigint;
    label: string;
  }): ClockEvent {
    const nowIso = new Date().toISOString();
    const event = this.store.addClockEvent(
      request.branchId,
      { atNs: request.atNs, jumpNs: request.jumpNs, label: request.label },
    );
    this.store.refitAll(nowIso);
    this.recordOperation({
      kind: 'add_clock_event',
      branchId: request.branchId,
      payload: {
        branchId: request.branchId,
        seq: event.seq,
        atNs: event.atNs.toString(),
        jumpNs: event.jumpNs.toString(),
        label: event.label,
      },
      inputHash: this.store.requireBranch(request.branchId).inputHash,
      ts: nowIso,
    });
    this.persistAll(nowIso);
    return event;
  }

  removeClockEvent(branchId: string, seq: number): void {
    const nowIso = new Date().toISOString();
    this.store.removeClockEvent(branchId, seq);
    this.store.refitAll(nowIso);
    this.recordOperation({
      kind: 'remove_clock_event',
      branchId,
      payload: { branchId, seq },
      inputHash: this.store.requireBranch(branchId).inputHash,
      ts: nowIso,
    });
    this.persistAll(nowIso);
  }

  refit(): void {
    const nowIso = new Date().toISOString();
    this.store.refitAll(nowIso);
    this.recordOperation({
      kind: 'refit',
      branchId: null,
      payload: { branchIds: [...this.store.branches.keys()] },
      inputHash: null,
      ts: nowIso,
    });
    this.persistAll(nowIso);
  }

  compare(branchIdA: string, branchIdB: string) {
    return this.store.compare(branchIdA, branchIdB);
  }

  exportRun(): ExportEnvelope & {
    fixtureVersions: Array<{
      versionId: string;
      label: string;
      toas: Array<Record<string, unknown>>;
    }>;
    fixtureHash: string;
  } {
    const nowIso = new Date().toISOString();
    const envelope = this.store.exportEnvelope(nowIso) as ExportEnvelope & {
      fixtureVersions: Array<{
        versionId: string;
        label: string;
        toas: Array<Record<string, unknown>>;
      }>;
    };
    envelope.fixtureVersions = this.bundle.versions.map((version) => ({
      versionId: version.versionId,
      label: version.label,
      toas: version.toas.map((toa) => ({
        code: toa.code,
        session: toa.session,
        ordinal: toa.ordinal,
        tNs: toa.tNs.toString(),
        freqMhz: toa.freqMhz,
        nCycles: toa.nCycles.toString(),
        wrapped: toa.wrapped,
        sigmaS: toa.sigmaS,
        versionId: toa.versionId,
      })),
    }));
    const hash = createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
    return Object.assign(envelope, { fixtureHash: hash });
  }

  importRun(payload: unknown): ReplayResult['report'] & { refitAt: string } {
    if (!payload || typeof payload !== 'object') {
      throw new Error('导入内容必须是导出信封 JSON 对象');
    }
    const envelope = payload as ExportEnvelope & {
      fixtureVersions?: ReplayResult['envelope']['fixtureVersions'];
    };
    if (envelope.format !== 'pulse-clock-visa-export') {
      throw new Error('导出信封 format 不匹配');
    }
    const result = replayEnvelope(envelope, this.bundle);
    const nowIso = new Date().toISOString();
    result.store.refitAll(nowIso);
    this.repository.resetDatabase();
    this.repository.persistFixture(
      {
        versions: result.store.versions.size
          ? [...result.store.versions.values()].map((version) => ({
              versionId: version.id,
              label: version.label,
              toas: version.toas,
            }))
          : this.bundle.versions,
        gaps: this.bundle.gaps,
        spec: this.bundle.spec,
      },
      nowIso,
    );
    this.repository.replaceAllBranches([...result.store.branches.values()]);
    this.repository.replaceAllOperations(result.store.operations);
    this.repository.setMeta('active_version', result.store.activeVersion);

    Object.assign(this.store, {
      versions: result.store.versions,
      branches: result.store.branches,
      operations: result.store.operations,
      activeVersion: result.store.activeVersion,
    });

    return { ...result.report, refitAt: nowIso };
  }

  private recordOperation(record: {
    kind: string;
    branchId: string | null;
    payload: unknown;
    inputHash: string | null;
    ts: string;
    seq?: number;
    datasetVersion?: string;
  }): void {
    const operation = this.store.logOperation(record as never);
    if (record.seq !== undefined) {
      operation.seq = record.seq;
      this.store.operations.sort((a, b) => a.seq - b.seq);
    }
  }

  private persistAll(nowIso: string): void {
    void nowIso;
    this.repository.replaceAllBranches([...this.store.branches.values()]);
    this.repository.replaceAllOperations(this.store.operations);
    this.repository.setMeta('active_version', this.store.activeVersion);
  }
}
