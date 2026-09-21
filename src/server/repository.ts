import type { Database } from 'better-sqlite3';
import { clearAll } from './db.js';
import type { FixtureBundle } from '../core/store.js';
import type {
  BranchRecord,
  ClockEvent,
  DatasetVersionRecord,
  FitParams,
  FitSummary,
  OperationRecord,
  PointResidual,
  ToaView,
} from '../core/types.js';

interface VersionRow {
  id: string;
  ordinal: number;
  label: string;
  note: string;
}
interface ToaRow {
  code: string;
  version_id: string;
  session: ToaView['session'];
  ordinal: number;
  t_ns: string;
  freq_mhz: number;
  n_cycles: string;
  wrapped: number;
  sigma_s: number;
  active: number;
}
interface BranchRow {
  id: string;
  label: string;
  base_version: string;
  parent_id: string | null;
  note: string;
  gap_offsets_json: string;
  excluded_json: string;
  input_hash: string;
  underidentified_json: string;
  created_at: string;
}
interface ClockRow {
  seq: number;
  branch_id: string;
  at_ns: string;
  jump_ns: string;
  label: string;
}
interface FitRow {
  branch_id: string;
  params_json: string;
  rms_s: number;
  chi2: number;
  max_abs_s: number;
  dof: number;
  points_json: string;
  input_hash: string;
  fitted_at: string;
}
interface OperationRow {
  seq: number;
  ts: string;
  kind: string;
  branch_id: string | null;
  dataset_version: string;
  input_hash: string | null;
  payload_json: string;
}

export class Repository {
  constructor(private readonly db: Database) {}

  persistFixture(bundle: FixtureBundle, nowIso: string): void {
    const insertVersion = this.db.prepare(
      `insert or replace into dataset_versions (id, ordinal, label, note, fixture_hash, created_at)
       values (?, ?, ?, ?, '', ?)`,
    );
    const clearToas = this.db.prepare('delete from toas where version_id = ?');
    const insertToa = this.db.prepare(
      `insert into toas
        (code, version_id, session, ordinal, t_ns, freq_mhz, n_cycles, wrapped, sigma_s, active)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    );
    const tx = this.db.transaction(() => {
      bundle.versions.forEach((version, index) => {
        insertVersion.run(version.versionId, index, version.label, '', nowIso);
        clearToas.run(version.versionId);
        for (const toa of version.toas) {
          insertToa.run(
            toa.code,
            version.versionId,
            toa.session,
            toa.ordinal,
            toa.tNs.toString(),
            toa.freqMhz,
            toa.nCycles.toString(),
            toa.wrapped,
            toa.sigmaS,
          );
        }
      });
    });
    tx();
  }

  replaceAllBranches(branches: BranchRecord[]): void {
    const deleteBranches = this.db.prepare('delete from branches');
    const insertBranch = this.db.prepare(
      `insert into branches
        (id, label, base_version, parent_id, note, gap_offsets_json, excluded_json,
         input_hash, underidentified_json, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertClock = this.db.prepare(
      `insert into clock_events (seq, branch_id, at_ns, jump_ns, label)
       values (?, ?, ?, ?, ?)`,
    );
    const insertFit = this.db.prepare(
      `insert into fits
        (branch_id, params_json, rms_s, chi2, max_abs_s, dof, points_json, input_hash, fitted_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction(() => {
      deleteBranches.run();
      for (const branch of branches) {
        insertBranch.run(
          branch.id,
          branch.label,
          branch.baseVersion,
          branch.parentId,
          branch.note,
          JSON.stringify(branch.gapOffsets),
          JSON.stringify(branch.excluded),
          branch.inputHash,
          JSON.stringify(branch.underidentifiedWith),
          branch.createdAt,
        );
        for (const event of branch.clockEvents) {
          insertClock.run(
            event.seq,
            branch.id,
            event.atNs.toString(),
            event.jumpNs.toString(),
            event.label,
          );
        }
        if (branch.fit) {
          insertFit.run(
            branch.id,
            JSON.stringify(branch.fit.params),
            branch.fit.rmsS,
            branch.fit.chi2,
            branch.fit.maxAbsS,
            branch.fit.dof,
            JSON.stringify(branch.fit.points),
            branch.fit.inputHash,
            branch.fit.fittedAt,
          );
        }
      }
    });
    tx();
  }

  replaceAllOperations(operations: OperationRecord[]): void {
    const clear = this.db.prepare('delete from operations');
    const insert = this.db.prepare(
      `insert into operations (seq, ts, kind, branch_id, dataset_version, input_hash, payload_json)
       values (?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction(() => {
      clear.run();
      for (const operation of operations) {
        insert.run(
          operation.seq,
          operation.ts,
          operation.kind,
          operation.branchId,
          operation.datasetVersion,
          operation.inputHash,
          JSON.stringify(operation.payload),
        );
      }
    });
    tx();
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('insert or replace into meta(key, value) values (?, ?)')
      .run(key, value);
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('select value from meta where key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  resetDatabase(): void {
    clearAll(this.db);
  }

  loadPersistedState(bundle: FixtureBundle): {
    activeVersion: string;
    versions: DatasetVersionRecord[];
    branches: BranchRecord[];
    operations: OperationRecord[];
  } {
    const versionRows = this.db
      .prepare('select * from dataset_versions order by ordinal')
      .all() as VersionRow[];
    const toaRows = this.db
      .prepare('select * from toas order by version_id, ordinal')
      .all() as ToaRow[];
    const branchRows = this.db
      .prepare('select * from branches order by created_at, id')
      .all() as BranchRow[];
    const clockRows = this.db
      .prepare('select * from clock_events order by branch_id, seq')
      .all() as ClockRow[];
    const fitRows = this.db.prepare('select * from fits').all() as FitRow[];
    const operationRows = this.db
      .prepare('select * from operations order by seq')
      .all() as OperationRow[];

    const versions: DatasetVersionRecord[] = versionRows.map((row) => ({
      id: row.id,
      label: row.label,
      note: row.note,
      toas: toaRows
        .filter((toa) => toa.version_id === row.id)
        .map((toa) => this.toaFromRow(toa)),
    }));

    const clocksByBranch = new Map<string, ClockEvent[]>();
    for (const row of clockRows) {
      const list = clocksByBranch.get(row.branch_id) ?? [];
      list.push({
        seq: row.seq,
        branchId: row.branch_id,
        atNs: BigInt(row.at_ns),
        jumpNs: BigInt(row.jump_ns),
        label: row.label,
      });
      clocksByBranch.set(row.branch_id, list);
    }
    const fitsByBranch = new Map(fitRows.map((row) => [row.branch_id, row]));

    const branches: BranchRecord[] = branchRows.map((row) => ({
      id: row.id,
      label: row.label,
      baseVersion: row.base_version,
      parentId: row.parent_id,
      note: row.note,
      gapOffsets: JSON.parse(row.gap_offsets_json) as Record<string, number>,
      excluded: JSON.parse(row.excluded_json) as string[],
      clockEvents: clocksByBranch.get(row.id) ?? [],
      createdAt: row.created_at,
      fit: this.fitFromRow(fitsByBranch.get(row.id)),
      underidentifiedWith: JSON.parse(row.underidentified_json) as string[],
      inputHash: row.input_hash,
    }));

    const operations: OperationRecord[] = operationRows.map((row) => ({
      seq: row.seq,
      ts: row.ts,
      kind: row.kind,
      branchId: row.branch_id,
      payload: JSON.parse(row.payload_json),
      datasetVersion: row.dataset_version,
      inputHash: row.input_hash,
    }));

    const activeVersion = this.getMeta('active_version') ?? bundle.versions[0]!.versionId;
    return { activeVersion, versions, branches, operations };
  }

  private toaFromRow(row: ToaRow): ToaView {
    return {
      code: row.code,
      session: row.session,
      ordinal: row.ordinal,
      tNs: BigInt(row.t_ns),
      freqMhz: row.freq_mhz,
      nCycles: BigInt(row.n_cycles),
      wrapped: row.wrapped,
      sigmaS: row.sigma_s,
      versionId: row.version_id,
      active: row.active === 1,
    };
  }

  private fitFromRow(row: FitRow | undefined): FitSummary | null {
    if (!row) return null;
    return {
      params: JSON.parse(row.params_json) as FitParams,
      rmsS: row.rms_s,
      chi2: row.chi2,
      maxAbsS: row.max_abs_s,
      dof: row.dof,
      points: JSON.parse(row.points_json) as PointResidual[],
      inputHash: row.input_hash,
      fittedAt: row.fitted_at,
    };
  }
}
