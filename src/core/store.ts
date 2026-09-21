import { hashClockEvents } from './hash.js';
import { branchInputSignature, hashToas } from './hash.js';
import { fitBranch, isStatisticallyTied } from './fit.js';
import { GAPS } from './fixtures/gen.js';
import { FIXTURE_SPEC } from './fixtures/gen.js';
import type {
  BranchRecord,
  ClockEvent,
  DatasetVersionRecord,
  FitSummary,
  OperationRecord,
  ToaInput,
  ToaView,
} from './types.js';

export interface FixtureBundle {
  versions: {
    versionId: string;
    label: string;
    toas: ToaInput[];
  }[];
  gaps: typeof GAPS;
  spec: typeof FIXTURE_SPEC;
}

export interface ExportEnvelope {
  format: string;
  exportedAt: string;
  activeVersion: string;
  fixture: {
    versionId: string;
    fixtureHash: string;
  };
  branches: Array<{
    id: string;
    label: string;
    baseVersion: string;
    parentId: string | null;
    note: string;
    gapOffsets: Record<string, number>;
    excluded: string[];
    clockEvents: Array<{
      seq: number;
      atNs: string;
      jumpNs: string;
      label: string;
    }>;
    createdAt: string;
  }>;
  operations: Array<{
    seq: number;
    ts: string;
    kind: string;
    branchId: string | null;
    datasetVersion: string;
    inputHash: string | null;
    payload: unknown;
  }>;
}

export interface BranchComparison {
  a: { branchId: string; label: string; fit: FitSummary };
  b: { branchId: string; label: string; fit: FitSummary };
  tied: boolean;
  points: Array<{
    toaCode: string;
    session: string;
    freqMhz: number;
    nCyclesA: string;
    nCyclesB: string;
    residualA: number;
    residualB: number;
    deltaResidualS: number;
  }>;
}

export interface RefitResult {
  branches: BranchRecord[];
  underidentifiedPairs: Array<[string, string]>;
}

export class TimingStore {
  readonly versions = new Map<string, DatasetVersionRecord>();
  readonly branches = new Map<string, BranchRecord>();
  readonly operations: OperationRecord[] = [];
  activeVersion = '';
  private branchSeq = 0;
  private readonly gaps = GAPS;

  private fixture: FixtureBundle;

  constructor(fixture: FixtureBundle) {
    this.fixture = fixture;
  }

  reset(fixture: FixtureBundle | null = null): void {
    const bundle = fixture ?? this.fixture;
    this.fixture = bundle;
    this.versions.clear();
    this.branches.clear();
    this.operations.length = 0;
    this.branchSeq = 0;
    for (const version of bundle.versions) {
      this.versions.set(version.versionId, {
        id: version.versionId,
        label: version.label,
        note: '',
        toas: version.toas.map((toa) => ({ ...toa, active: true })),
      });
    }
    this.activeVersion = bundle.versions[0]?.versionId ?? '';
  }

  get activeToas(): ToaView[] {
    return this.version(this.activeVersion).toas;
  }

  version(id: string): DatasetVersionRecord {
    const version = this.versions.get(id);
    if (!version) throw new Error(`未知数据版本: ${id}`);
    return version;
  }

  setActiveVersion(id: string): void {
    this.version(id);
    if (this.activeVersion === id) return;
    this.activeVersion = id;
    for (const branch of this.branches.values()) {
      branch.baseVersion = id;
      branch.inputHash = this.computeInputHash(branch);
      branch.fit = null;
    }
  }

  createBranch(opts: {
    label?: string;
    fromBranchId?: string | null;
    baseVersion?: string;
    gapOffsets?: Record<string, number>;
    note?: string;
    nowIso: string;
    id?: string;
  }): BranchRecord {
    let id: string;
    if (opts.id) {
      if (this.branches.has(opts.id)) throw new Error(`分支 ID 已存在: ${opts.id}`);
      id = opts.id;
      const numericId = Number(id.replace(/^H/, ''));
      if (Number.isFinite(numericId)) this.branchSeq = Math.max(this.branchSeq, numericId);
    } else {
      id = `H${String(++this.branchSeq).padStart(2, '0')}`;
    }
    const parent = opts.fromBranchId
      ? this.requireBranch(opts.fromBranchId)
      : null;
    const defaultOffsets: Record<string, number> = {};
    for (const gap of this.gaps) defaultOffsets[String(gap.index)] = 0;
    const branch: BranchRecord = {
      id,
      label: opts.label ?? `分支 ${id}`,
      baseVersion: opts.baseVersion ?? parent?.baseVersion ?? this.activeVersion,
      parentId: parent?.id ?? null,
      gapOffsets: {
        ...defaultOffsets,
        ...(parent ? parent.gapOffsets : {}),
        ...(opts.gapOffsets ?? {}),
      },
      excluded: parent ? [...parent.excluded] : [],
      clockEvents: parent
        ? parent.clockEvents.map((event) => ({ ...event }))
        : [],
      note: opts.note ?? '',
      createdAt: opts.nowIso,
      fit: null,
      underidentifiedWith: [],
      inputHash: '',
    };
    branch.inputHash = this.computeInputHash(branch);
    this.branches.set(id, branch);
    return branch;
  }

  requireBranch(id: string): BranchRecord {
    const branch = this.branches.get(id);
    if (!branch) throw new Error(`未知假设分支: ${id}`);
    return branch;
  }

  adjustGapOffset(branchId: string, gapIndex: number, delta: number): BranchRecord {
    if (!Number.isInteger(delta)) throw new Error('周数偏移必须是整数');
    const branch = this.requireBranch(branchId);
    const key = String(gapIndex);
    branch.gapOffsets[key] = (branch.gapOffsets[key] ?? 0) + delta;
    branch.inputHash = this.computeInputHash(branch);
    branch.fit = null;
    return branch;
  }

  setExcluded(branchId: string, toaCode: string, excluded: boolean): BranchRecord {
    const branch = this.requireBranch(branchId);
    const toas = this.version(branch.baseVersion).toas;
    if (!toas.some((toa) => toa.code === toaCode)) {
      throw new Error(`分支版本 ${branch.baseVersion} 中不存在观测 ${toaCode}`);
    }
    const has = branch.excluded.includes(toaCode);
    if (excluded && !has) branch.excluded.push(toaCode);
    if (!excluded && has) {
      branch.excluded = branch.excluded.filter((code) => code !== toaCode);
    }
    branch.inputHash = this.computeInputHash(branch);
    branch.fit = null;
    return branch;
  }

  addClockEvent(
    branchId: string,
    event: { atNs: bigint; jumpNs: bigint; label: string },
    seq?: number,
  ): ClockEvent {
    const branch = this.requireBranch(branchId);
    const maxSeq = branch.clockEvents.reduce((m, event0) => Math.max(m, event0.seq), 0);
    const clockEvent: ClockEvent = {
      seq: seq ?? maxSeq + 1,
      branchId,
      atNs: event.atNs,
      jumpNs: event.jumpNs,
      label: event.label,
    };
    if (branch.clockEvents.some((existing) => existing.seq === clockEvent.seq)) {
      throw new Error(`事件序号 ${clockEvent.seq} 已存在；事件序号不可变且唯一`);
    }
    branch.clockEvents.push(clockEvent);
    branch.inputHash = this.computeInputHash(branch);
    branch.fit = null;
    return clockEvent;
  }

  removeClockEvent(branchId: string, seq: number): void {
    const branch = this.requireBranch(branchId);
    const before = branch.clockEvents.length;
    branch.clockEvents = branch.clockEvents.filter((event) => event.seq !== seq);
    if (branch.clockEvents.length === before) {
      throw new Error(`分支 ${branchId} 不存在序号 ${seq} 的时钟事件`);
    }
    branch.inputHash = this.computeInputHash(branch);
    branch.fit = null;
  }

  refitAll(nowIso: string): RefitResult {
    const pairs: Array<[string, string]> = [];
    for (const branch of this.branches.values()) {
      const toas = this.version(branch.baseVersion).toas;
      branch.inputHash = this.computeInputHash(branch);
      branch.fit = fitBranch(
        {
          gapOffsets: branch.gapOffsets,
          excluded: new Set(branch.excluded),
          clockEvents: branch.clockEvents,
        },
        toas,
        this.gaps,
        BigInt(this.fixture.spec.tRefNs),
        this.fixture.spec.f0Nominal,
        this.fixture.spec.phase0Cycles,
        { inputHash: branch.inputHash, nowIso },
      );
      branch.underidentifiedWith = [];
    }
    const list = [...this.branches.values()].filter((branch) => branch.fit);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const branchI = list[i]!;
        const branchJ = list[j]!;
        if (branchI.baseVersion !== branchJ.baseVersion) continue;
        if (isStatisticallyTied(branchI.fit!, branchJ.fit!)) {
          pairs.push([branchI.id, branchJ.id]);
          branchI.underidentifiedWith.push(branchJ.id);
          branchJ.underidentifiedWith.push(branchI.id);
        }
      }
    }
    return { branches: list, underidentifiedPairs: pairs };
  }

  compare(branchIdA: string, branchIdB: string): BranchComparison {
    const a = this.requireBranch(branchIdA);
    const b = this.requireBranch(branchIdB);
    if (!a.fit || !b.fit) throw new Error('两个分支都必须先完成拟合才能比较');
    const pointA = new Map(a.fit.points.map((point) => [point.toaCode, point]));
    const pointB = new Map(b.fit.points.map((point) => [point.toaCode, point]));
    const codes = new Set<string>([...pointA.keys(), ...pointB.keys()]);
    const points = [...codes].sort().map((code) => {
      const pa = pointA.get(code)!;
      const pb = pointB.get(code)!;
      return {
        toaCode: code,
        session: pa.session,
        freqMhz: pa.freqMhz,
        nCyclesA: pa.nCyclesEffective,
        nCyclesB: pb.nCyclesEffective,
        residualA: pa.residualS,
        residualB: pb.residualS,
        deltaResidualS: pa.residualS - pb.residualS,
      };
    });
    return {
      a: { branchId: a.id, label: a.label, fit: a.fit },
      b: { branchId: b.id, label: b.label, fit: b.fit },
      tied: isStatisticallyTied(a.fit, b.fit),
      points,
    };
  }

  logOperation(opts: {
    kind: string;
    branchId: string | null;
    payload: unknown;
    inputHash: string | null;
    ts: string;
    seq?: number;
    datasetVersion?: string;
  }): OperationRecord {
    const seq = opts.seq ?? this.operations.length + 1;
    const existing = this.operations.find((operation) => operation.seq === seq);
    const record: OperationRecord = existing ?? {
      seq,
      ts: opts.ts,
      kind: opts.kind,
      branchId: opts.branchId,
      payload: opts.payload,
      datasetVersion: opts.datasetVersion ?? this.activeVersion,
      inputHash: opts.inputHash,
    };
    if (!existing) this.operations.push(record);
    this.operations.sort((a, b) => a.seq - b.seq);
    return record;
  }

  computeInputHash(branch: BranchRecord): string {
    const toas = this.version(branch.baseVersion).toas;
    return branchInputSignature({
      baseVersion: branch.baseVersion,
      gapOffsets: branch.gapOffsets,
      excluded: [...branch.excluded].sort(),
      clockHash: hashClockEvents(branch.clockEvents),
      toaHash: hashToas(toas),
    });
  }

  exportEnvelope(nowIso: string): ExportEnvelope {
    return {
      format: 'pulse-clock-visa-export',
      exportedAt: nowIso,
      activeVersion: this.activeVersion,
      fixture: {
        versionId: 'fixed-fixture-v1',
        fixtureHash: hashToas(this.activeToas),
      },
      branches: [...this.branches.values()].map((branch) => ({
        id: branch.id,
        label: branch.label,
        baseVersion: branch.baseVersion,
        parentId: branch.parentId,
        note: branch.note,
        gapOffsets: branch.gapOffsets,
        excluded: branch.excluded,
        clockEvents: branch.clockEvents
          .slice()
          .sort((x, y) => x.seq - y.seq)
          .map((event) => ({
            seq: event.seq,
            atNs: event.atNs.toString(),
            jumpNs: event.jumpNs.toString(),
            label: event.label,
          })),
        createdAt: branch.createdAt,
      })),
      operations: this.operations.map((operation) => ({
        seq: operation.seq,
        ts: operation.ts,
        kind: operation.kind,
        branchId: operation.branchId,
        datasetVersion: operation.datasetVersion,
        inputHash: operation.inputHash,
        payload: operation.payload,
      })),
    };
  }
}
