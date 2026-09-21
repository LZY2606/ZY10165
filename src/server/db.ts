/**
 * SQLite 持久层（node:sqlite）。大整数一律以 TEXT 存储，读出后转 BigInt。
 */
import { DatabaseSync } from "node:sqlite";
import type {
  ClockEvent,
  CycleShift,
  ResidualSummary,
  TimingParams,
  Toa,
} from "../core/model.js";

export interface InputVersion {
  id: number;
  label: string;
  note: string;
  tailCount: number;
  createdAt: string;
}

export interface Branch {
  id: number;
  name: string;
  inputVersion: number;
  fNum: bigint;
  dNum: bigint;
  dmNum: bigint;
  summaryJson: string | null;
  createdAt: string;
}

export interface RunLog {
  id: number;
  ts: string;
  action: string;
  detail: string;
}

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS input_version (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      tail_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS toa (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      input_version INTEGER NOT NULL REFERENCES input_version(id),
      seq INTEGER NOT NULL,
      t_us TEXT NOT NULL,
      f_num TEXT NOT NULL,
      band_mhz REAL NOT NULL,
      observatory TEXT NOT NULL,
      cycle_base TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS clock_event (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seq INTEGER NOT NULL UNIQUE,
      t_us TEXT NOT NULL,
      offset_us TEXT NOT NULL,
      label TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS branch (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      input_version INTEGER NOT NULL REFERENCES input_version(id),
      f_num TEXT NOT NULL,
      d_num TEXT NOT NULL,
      dm_num TEXT NOT NULL,
      summary_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cycle_shift (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL REFERENCES branch(id),
      boundary_t_us TEXT NOT NULL,
      delta TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS exclusion (
      branch_id INTEGER NOT NULL REFERENCES branch(id),
      toa_id INTEGER NOT NULL REFERENCES toa(id),
      PRIMARY KEY (branch_id, toa_id)
    );
    CREATE TABLE IF NOT EXISTS run_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT ''
    );
  `);
  return db;
}

const now = () => new Date().toISOString();

export function logRun(db: DatabaseSync, action: string, detail = ""): void {
  db.prepare("INSERT INTO run_log (ts, action, detail) VALUES (?,?,?)").run(
    now(),
    action,
    detail,
  );
}

export function createInputVersion(
  db: DatabaseSync,
  label: string,
  note: string,
  tailCount: number,
): number {
  const r = db
    .prepare(
      "INSERT INTO input_version (label, note, tail_count, created_at) VALUES (?,?,?,?)",
    )
    .run(label, note, tailCount, now());
  return Number(r.lastInsertRowid);
}

export function listInputVersions(db: DatabaseSync): InputVersion[] {
  const rows = db
    .prepare(
      "SELECT id, label, note, tail_count, created_at FROM input_version ORDER BY id",
    )
    .all() as unknown as {
    id: number;
    label: string;
    note: string;
    tail_count: number;
    created_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    note: r.note,
    tailCount: r.tail_count,
    createdAt: r.created_at,
  }));
}

export function insertToa(db: DatabaseSync, toa: Omit<Toa, "id">): number {
  const r = db
    .prepare(
      `INSERT INTO toa (input_version, seq, t_us, f_num, band_mhz, observatory, cycle_base)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(
      toa.inputVersion,
      toa.seq,
      toa.tUs.toString(),
      toa.fNum.toString(),
      toa.bandMHz,
      toa.observatory,
      toa.cycleBase.toString(),
    );
  return Number(r.lastInsertRowid);
}

export function listToas(db: DatabaseSync, inputVersion: number): Toa[] {
  const rows = db
    .prepare(
      `SELECT id, input_version, seq, t_us, f_num, band_mhz, observatory, cycle_base
       FROM toa WHERE input_version = ? ORDER BY seq`,
    )
    .all(inputVersion) as unknown as {
    id: number;
    input_version: number;
    seq: number;
    t_us: string;
    f_num: string;
    band_mhz: number;
    observatory: string;
    cycle_base: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    inputVersion: r.input_version,
    seq: r.seq,
    tUs: BigInt(r.t_us),
    fNum: BigInt(r.f_num),
    bandMHz: r.band_mhz,
    observatory: r.observatory,
    cycleBase: BigInt(r.cycle_base),
  }));
}

export function nextClockSeq(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM clock_event")
    .get() as unknown as { m: number };
  return row.m + 1;
}

export function insertClockEvent(
  db: DatabaseSync,
  ev: Omit<ClockEvent, "id">,
): number {
  const r = db
    .prepare(
      "INSERT INTO clock_event (seq, t_us, offset_us, label) VALUES (?,?,?,?)",
    )
    .run(ev.seq, ev.tUs.toString(), ev.offsetUs.toString(), ev.label);
  return Number(r.lastInsertRowid);
}

export function replaceClockEvents(
  db: DatabaseSync,
  events: Omit<ClockEvent, "id" | "seq">[],
): void {
  db.exec("DELETE FROM clock_event");
  events.forEach((e, i) => {
    insertClockEvent(db, { ...e, seq: i + 1 });
  });
}

export function listClockEvents(db: DatabaseSync): ClockEvent[] {
  const rows = db
    .prepare("SELECT id, seq, t_us, offset_us, label FROM clock_event ORDER BY seq")
    .all() as unknown as {
    id: number;
    seq: number;
    t_us: string;
    offset_us: string;
    label: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    seq: r.seq,
    tUs: BigInt(r.t_us),
    offsetUs: BigInt(r.offset_us),
    label: r.label,
  }));
}

export function createBranch(
  db: DatabaseSync,
  name: string,
  inputVersion: number,
  params: TimingParams,
): number {
  const r = db
    .prepare(
      `INSERT INTO branch (name, input_version, f_num, d_num, dm_num, created_at)
       VALUES (?,?,?,?,?,?)`,
    )
    .run(
      name,
      inputVersion,
      params.fNum.toString(),
      params.dNum.toString(),
      params.dmNum.toString(),
      now(),
    );
  return Number(r.lastInsertRowid);
}

export function getBranch(db: DatabaseSync, id: number): Branch | null {
  const r = db
    .prepare(
      "SELECT id, name, input_version, f_num, d_num, dm_num, summary_json, created_at FROM branch WHERE id = ?",
    )
    .get(id) as unknown as {
    id: number;
    name: string;
    input_version: number;
    f_num: string;
    d_num: string;
    dm_num: string;
    summary_json: string | null;
    created_at: string;
  } | undefined;
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    inputVersion: r.input_version,
    fNum: BigInt(r.f_num),
    dNum: BigInt(r.d_num),
    dmNum: BigInt(r.dm_num),
    summaryJson: r.summary_json,
    createdAt: r.created_at,
  };
}

export function listBranches(db: DatabaseSync): Branch[] {
  const rows = db
    .prepare(
      "SELECT id, name, input_version, f_num, d_num, dm_num, summary_json, created_at FROM branch ORDER BY id",
    )
    .all() as unknown as {
    id: number;
    name: string;
    input_version: number;
    f_num: string;
    d_num: string;
    dm_num: string;
    summary_json: string | null;
    created_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    inputVersion: r.input_version,
    fNum: BigInt(r.f_num),
    dNum: BigInt(r.d_num),
    dmNum: BigInt(r.dm_num),
    summaryJson: r.summary_json,
    createdAt: r.created_at,
  }));
}

export function saveBranchSummary(
  db: DatabaseSync,
  branchId: number,
  summary: ResidualSummary,
): void {
  db.prepare("UPDATE branch SET summary_json = ? WHERE id = ?").run(
    JSON.stringify(summary),
    branchId,
  );
}

export function addCycleShift(
  db: DatabaseSync,
  branchId: number,
  boundaryTUs: bigint,
  delta: bigint,
): number {
  const r = db
    .prepare(
      "INSERT INTO cycle_shift (branch_id, boundary_t_us, delta) VALUES (?,?,?)",
    )
    .run(branchId, boundaryTUs.toString(), delta.toString());
  return Number(r.lastInsertRowid);
}

export function deleteCycleShift(db: DatabaseSync, shiftId: number): void {
  db.prepare("DELETE FROM cycle_shift WHERE id = ?").run(shiftId);
}

export function listCycleShifts(db: DatabaseSync, branchId: number): CycleShift[] {
  const rows = db
    .prepare(
      "SELECT id, branch_id, boundary_t_us, delta FROM cycle_shift WHERE branch_id = ? ORDER BY id",
    )
    .all(branchId) as unknown as {
    id: number;
    branch_id: number;
    boundary_t_us: string;
    delta: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    branchId: r.branch_id,
    boundaryTUs: BigInt(r.boundary_t_us),
    delta: BigInt(r.delta),
  }));
}

export function setExclusion(
  db: DatabaseSync,
  branchId: number,
  toaId: number,
  excluded: boolean,
): void {
  if (excluded) {
    db.prepare(
      "INSERT OR IGNORE INTO exclusion (branch_id, toa_id) VALUES (?,?)",
    ).run(branchId, toaId);
  } else {
    db.prepare("DELETE FROM exclusion WHERE branch_id = ? AND toa_id = ?").run(
      branchId,
      toaId,
    );
  }
}

export function listExclusions(db: DatabaseSync, branchId: number): Set<number> {
  const rows = db
    .prepare("SELECT toa_id FROM exclusion WHERE branch_id = ?")
    .all(branchId) as unknown as { toa_id: number }[];
  return new Set(rows.map((r) => r.toa_id));
}

export function listRunLog(db: DatabaseSync): RunLog[] {
  return db
    .prepare("SELECT id, ts, action, detail FROM run_log ORDER BY id")
    .all() as unknown as RunLog[];
}

const TABLES = [
  "input_version",
  "toa",
  "clock_event",
  "branch",
  "cycle_shift",
  "exclusion",
  "run_log",
];

export function resetDb(db: DatabaseSync): void {
  // 先子表后父表，满足外键约束
  const order = [
    "exclusion",
    "cycle_shift",
    "branch",
    "toa",
    "clock_event",
    "input_version",
    "run_log",
  ];
  for (const t of order) db.exec(`DELETE FROM ${t}`);
  db.exec(
    `DELETE FROM sqlite_sequence WHERE name IN (${TABLES.map((t) => `'${t}'`).join(",")})`,
  );
}

export interface ExportBundle {
  format: "pulse-clock-visa-export";
  version: 1;
  exportedAt: string;
  tables: Record<string, Record<string, unknown>[]>;
}

export function exportAll(db: DatabaseSync): ExportBundle {
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const t of TABLES) {
    if (t === "exclusion") continue; // 无 id 列，单独处理
    tables[t] = db.prepare(`SELECT * FROM ${t} ORDER BY id`).all() as Record<
      string,
      unknown
    >[];
  }
  tables["exclusion"] = db
    .prepare("SELECT branch_id, toa_id FROM exclusion ORDER BY branch_id, toa_id")
    .all() as Record<string, unknown>[];
  return {
    format: "pulse-clock-visa-export",
    version: 1,
    exportedAt: now(),
    tables,
  };
}

export function importAll(db: DatabaseSync, bundle: ExportBundle): void {
  if (bundle.format !== "pulse-clock-visa-export") {
    throw new Error("无法识别的导出格式");
  }
  resetDb(db);
  const order = [
    "input_version",
    "toa",
    "clock_event",
    "branch",
    "cycle_shift",
    "exclusion",
    "run_log",
  ];
  for (const t of order) {
    const rows = bundle.tables[t] ?? [];
    for (const row of rows) {
      const cols = Object.keys(row);
      const sql = `INSERT INTO ${t} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`;
      db.prepare(sql).run(
        ...cols.map((c) => row[c] as string | number | null),
      );
    }
    const hasId = t !== "exclusion";
    if (hasId && rows.length > 0) {
      const maxId = Math.max(...rows.map((r) => Number(r.id)));
      db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = ?").run(
        maxId,
        t,
      );
    }
  }
}
