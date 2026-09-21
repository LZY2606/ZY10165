import { TimingStore, type ExportEnvelope, type FixtureBundle } from './store.js';
import { hashToas } from './hash.js';
import type { ToaInput } from './types.js';

export interface ReplayOperation {
  seq: number;
  ts: string;
  kind: string;
  branchId: string | null;
  datasetVersion: string;
  inputHash: string | null;
  payload: Record<string, unknown>;
}

export interface ReplayResult {
  envelope: ExportEnvelope & {
    fixtureVersions?: Array<{
      versionId: string;
      label: string;
      toas: Array<Omit<ToaInput, 'tNs' | 'nCycles'> & { tNs: string; nCycles: string }>;
    }>;
  };
  store: TimingStore;
  report: {
    operationsReplayed: number;
    branches: string[];
    inputHashMatches: boolean;
    fixtureHashBefore: string;
    fixtureHashAfter: string;
  };
}

export function bundleFromEnvelope(envelope: ExportEnvelope & {
  fixtureVersions?: ReplayResult['envelope']['fixtureVersions'];
}, fallback: FixtureBundle): FixtureBundle {
  if (!envelope.fixtureVersions || envelope.fixtureVersions.length === 0) {
    return fallback;
  }
  return {
    versions: envelope.fixtureVersions.map((version) => ({
      versionId: version.versionId,
      label: version.label,
      toas: version.toas.map((toa) => ({
        code: toa.code,
        session: toa.session,
        ordinal: toa.ordinal,
        tNs: BigInt(toa.tNs),
        freqMhz: toa.freqMhz,
        nCycles: BigInt(toa.nCycles),
        wrapped: toa.wrapped,
        sigmaS: toa.sigmaS,
        versionId: toa.versionId,
      })),
    })),
    gaps: fallback.gaps,
    spec: fallback.spec,
  };
}

export function replayEnvelope(
  envelope: ExportEnvelope & { fixtureVersions?: ReplayResult['envelope']['fixtureVersions'] },
  fallback: FixtureBundle,
): ReplayResult {
  const fixture = bundleFromEnvelope(envelope, fallback);
  const store = new TimingStore(fixture);
  store.reset();

  const beforeHash = hashToas(
    fixture.versions.find((version) => version.versionId === envelope.activeVersion)?.toas.map((t) => ({ ...t, active: true })) ?? [],
  );

  const ops = [...envelope.operations].sort((a, b) => a.seq - b.seq);
  for (const op of ops as ReplayOperation[]) {
    replayOperation(store, op);
    const stored = store.operations[store.operations.length - 1];
    if (!stored || stored.seq !== op.seq || stored.kind !== op.kind) {
      throw new Error(`重放第 ${op.seq} 条操作后状态不一致`);
    }
  }

  if (envelope.activeVersion) store.setActiveVersion(envelope.activeVersion);

  store.refitAll(new Date(0).toISOString());

  const afterHash = hashToas(store.activeToas);
  const expectedIds = envelope.branches.map((branch) => branch.id);
  const actualIds = [...store.branches.keys()];

  for (const branch of envelope.branches) {
    const rebuilt = store.branches.get(branch.id);
    if (!rebuilt) throw new Error(`重放后缺少分支 ${branch.id}`);
    if (JSON.stringify(rebuilt.gapOffsets) !== JSON.stringify(branch.gapOffsets)) {
      throw new Error(`分支 ${branch.id} 周数偏移重放不一致`);
    }
    if (JSON.stringify([...rebuilt.excluded].sort()) !== JSON.stringify([...branch.excluded].sort())) {
      throw new Error(`分支 ${branch.id} 排除集合重放不一致`);
    }
    const clockA = rebuilt.clockEvents.map((event) => [event.seq, event.atNs.toString(), event.jumpNs.toString()]);
    const clockB = branch.clockEvents.map((event) => [event.seq, event.atNs, event.jumpNs]);
    if (JSON.stringify(clockA) !== JSON.stringify(clockB)) {
      throw new Error(`分支 ${branch.id} 时钟事件重放不一致`);
    }
  }

  return {
    envelope,
    store,
    report: {
      operationsReplayed: ops.length,
      branches: actualIds,
      inputHashMatches: JSON.stringify(actualIds) === JSON.stringify(expectedIds),
      fixtureHashBefore: beforeHash,
      fixtureHashAfter: afterHash,
    },
  };
}

function replayOperation(store: TimingStore, op: ReplayOperation): void {
  if (op.datasetVersion) {
    if (store.versions.has(op.datasetVersion)) store.setActiveVersion(op.datasetVersion);
  }
  const p = op.payload;
  switch (op.kind) {
    case 'reset':
    case 'seed':
      break;
    case 'switch_version':
      store.setActiveVersion(String(p.versionId));
      break;
    case 'create_branch': {
      if (!op.branchId) throw new Error('create_branch 操作必须携带 branchId');
      store.createBranch({
        id: op.branchId,
        label: typeof p.label === 'string' ? p.label : undefined,
        fromBranchId: typeof p.fromBranchId === 'string' ? p.fromBranchId : null,
        baseVersion: typeof p.baseVersion === 'string' ? p.baseVersion : undefined,
        gapOffsets: isGapOffsets(p.gapOffsets) ? p.gapOffsets : undefined,
        note: typeof p.note === 'string' ? p.note : undefined,
        nowIso: op.ts,
      });
      break;
    }
    case 'adjust_gap_offset': {
      const branch = op.branchId ?? String(p.branchId);
      store.adjustGapOffset(branch, Number(p.gapIndex), Number(p.delta));
      break;
    }
    case 'set_excluded': {
      const branch = op.branchId ?? String(p.branchId);
      store.setExcluded(branch, String(p.toaCode), Boolean(p.excluded));
      break;
    }
    case 'add_clock_event': {
      const branch = op.branchId ?? String(p.branchId);
      store.addClockEvent(
        branch,
        {
          atNs: BigInt(String(p.atNs)),
          jumpNs: BigInt(String(p.jumpNs)),
          label: String(p.label ?? '时钟跳变'),
        },
        typeof p.seq === 'number' ? p.seq : undefined,
      );
      break;
    }
    case 'remove_clock_event': {
      const branch = op.branchId ?? String(p.branchId);
      store.removeClockEvent(branch, Number(p.seq));
      break;
    }
    case 'refit':
      store.refitAll(op.ts);
      break;
    default:
      throw new Error(`未知操作类型，无法重放: ${op.kind}`);
  }
  store.operations.pop();
  store.operations.push({
    seq: op.seq,
    ts: op.ts,
    kind: op.kind,
    branchId: op.branchId,
    datasetVersion: op.datasetVersion ?? store.activeVersion,
    inputHash: op.inputHash,
    payload: op.payload,
  });
}

function isGapOffsets(value: unknown): value is Record<string, number> {
  if (!value || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).every((entry) => typeof entry === 'number');
}
