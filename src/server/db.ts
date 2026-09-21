import BetterSqlite3 from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let dbInstance: Database | null = null;

export function openDatabase(path: string): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new BetterSqlite3(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  dbInstance = db;
  return db;
}

export function getDatabase(): Database {
  if (!dbInstance) throw new Error('数据库尚未初始化');
  return dbInstance;
}

export function migrate(db: Database): void {
  db.exec(`
    create table if not exists meta (
      key text primary key,
      value text not null
    );

    create table if not exists dataset_versions (
      id text primary key,
      ordinal integer not null,
      label text not null,
      note text not null default '',
      fixture_hash text not null,
      created_at text not null
    );

    create table if not exists toas (
      code text not null,
      version_id text not null,
      session text not null,
      ordinal integer not null,
      t_ns text not null,
      freq_mhz real not null,
      n_cycles text not null,
      wrapped real not null,
      sigma_s real not null,
      active integer not null check (active in (0,1)),
      primary key (version_id, code)
    );

    create table if not exists branches (
      id text primary key,
      label text not null,
      base_version text not null,
      parent_id text,
      note text not null default '',
      gap_offsets_json text not null,
      excluded_json text not null,
      input_hash text not null,
      underidentified_json text not null default '[]',
      created_at text not null
    );

    create table if not exists clock_events (
      seq integer primary key autoincrement,
      branch_id text not null references branches(id) on delete cascade,
      at_ns text not null,
      jump_ns text not null,
      label text not null
    );

    create table if not exists fits (
      branch_id text primary key references branches(id) on delete cascade,
      params_json text not null,
      rms_s real not null,
      chi2 real not null,
      max_abs_s real not null,
      dof integer not null,
      points_json text not null,
      input_hash text not null,
      fitted_at text not null
    );

    create table if not exists operations (
      seq integer primary key autoincrement,
      ts text not null,
      kind text not null,
      branch_id text,
      dataset_version text not null,
      input_hash text,
      payload_json text not null
    );

    create index if not exists idx_toas_version on toas(version_id);
    create index if not exists idx_clock_branch on clock_events(branch_id);
    create index if not exists idx_ops_seq on operations(seq);
  `);
}

export function clearAll(db: Database): void {
  db.exec(`
    delete from fits;
    delete from clock_events;
    delete from branches;
    delete from toas;
    delete from dataset_versions;
    delete from operations;
    delete from meta;
  `);
}
