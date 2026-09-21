/**
 * 业务服务层：导入、回退、分支操作、残差摘要与对比。
 * 同时被 HTTP API 与自动化测试调用。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import type { Fixture } from "../core/fixture.js";
import {
  baseCycle,
  computeResiduals,
  findGaps,
  fullSummary,
  type BranchInput,
  type ResidualSummary,
  type TimingParams,
  type ToaResidual,
} from "../core/model.js";
import { DM_SCALE, D_SCALE, F_SCALE } from "../core/units.js";
import * as db from "./db.js";

const here = dirname(fileURLToPath(import.meta.url));

export function loadFixtureFile(name = "default"): Fixture {
  const path = join(here, "../../fixtures", `${name}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as Fixture;
}

export function fixtureParams(fx: Fixture): TimingParams {
  return {
    fNum: BigInt(Math.round(Number(fx.meta.fHz) * 1e12)),
    dNum: BigInt(Math.round(Number(fx.meta.fdotHzPerS) * 1e24)),
    dmNum: BigInt(Math.round(Number(fx.meta.dmPcCm3) * 1e6)),
  };
}

function branchInput(d: DatabaseSync, branchId: number): BranchInput {
  const b = db.getBranch(d, branchId);
  if (!b) throw new Error(`分支不存在: ${branchId}`);
  return {
    params: { fNum: b.fNum, dNum: b.dNum, dmNum: b.dmNum },
    shifts: db.listCycleShifts(d, branchId),
    exclusions: db.listExclusions(d, branchId),
  };
}

/** 导入 fixture 为一个新的输入版本；时钟事件重置为 fixture 事件（共同事件） */
export function importFixture(
  d: DatabaseSync,
  variant: "full" | "no-tail",
  fixtureName = "default",
): { inputVersion: number } {
  const fx = loadFixtureFile(fixtureName);
  const params = fixtureParams(fx);
  const toas =
    variant === "full" ? fx.toas : fx.toas.slice(0, fx.toas.length - fx.meta.tailCount);
  const label = variant === "full" ? "fixture:完整" : "fixture:回退末端";
  const versionId = db.createInputVersion(
    d,
    label,
    `fixture=${fx.meta.name} variant=${variant}`,
    variant === "full" ? fx.meta.tailCount : 0,
  );
  db.replaceClockEvents(
    d,
    fx.clockEvents.map((e) => ({
      tUs: BigInt(e.tUs),
      offsetUs: BigInt(e.offsetUs),
      label: e.label,
    })),
  );
  const events = db.listClockEvents(d);
  for (const t of toas) {
    const fNum = BigInt(t.bandMHz) * 1_000_000n * F_SCALE;
    const toa = {
      inputVersion: versionId,
      seq: t.seq,
      tUs: BigInt(t.tUs),
      fNum,
      bandMHz: t.bandMHz,
      observatory: t.observatory,
      cycleBase: 0n,
    };
    const cycle = baseCycle(toa, params, events);
    db.insertToa(d, { ...toa, cycleBase: cycle });
  }
  db.logRun(d, "import-fixture", `version=${versionId} variant=${variant} toas=${toas.length}`);
  return { inputVersion: versionId };
}

/** 回退末端数据：由某个版本派生去掉末端 tailCount 个到达时刻的新版本 */
export function revertTail(
  d: DatabaseSync,
  fromVersion: number,
): { inputVersion: number } {
  const versions = db.listInputVersions(d);
  const src = versions.find((v) => v.id === fromVersion);
  if (!src) throw new Error(`输入版本不存在: ${fromVersion}`);
  const toas = db.listToas(d, fromVersion);
  const tailCount = src.tailCount > 0 ? src.tailCount : 1;
  const kept = toas.slice(0, toas.length - tailCount);
  const versionId = db.createInputVersion(
    d,
    `回退末端←v${fromVersion}`,
    `reverted ${tailCount} tail toas from version ${fromVersion}`,
    0,
  );
  for (const t of kept) db.insertToa(d, { ...t, inputVersion: versionId });
  db.logRun(d, "revert-tail", `version=${versionId} from=${fromVersion} kept=${kept.length}`);
  return { inputVersion: versionId };
}

export function createBranch(
  d: DatabaseSync,
  name: string,
  inputVersion: number,
  params?: Partial<TimingParams>,
  copyFrom?: number,
): { branchId: number } {
  let p: TimingParams;
  if (copyFrom !== undefined) {
    const src = db.getBranch(d, copyFrom);
    if (!src) throw new Error(`源分支不存在: ${copyFrom}`);
    p = { fNum: src.fNum, dNum: src.dNum, dmNum: src.dmNum };
  } else {
    const fx = loadFixtureFile();
    p = fixtureParams(fx);
  }
  p = {
    fNum: params?.fNum ?? p.fNum,
    dNum: params?.dNum ?? p.dNum,
    dmNum: params?.dmNum ?? p.dmNum,
  };
  const branchId = db.createBranch(d, name, inputVersion, p);
  if (copyFrom !== undefined) {
    for (const s of db.listCycleShifts(d, copyFrom)) {
      db.addCycleShift(d, branchId, s.boundaryTUs, s.delta);
    }
    for (const toaId of db.listExclusions(d, copyFrom)) {
      db.setExclusion(d, branchId, toaId, true);
    }
  }
  db.logRun(d, "create-branch", `branch=${branchId} name=${name} version=${inputVersion}`);
  return { branchId };
}

/** 重新计算某输入版本上所有分支的摘要（含跨分支可识别性），并持久化 */
export function recomputeSummaries(
  d: DatabaseSync,
  inputVersion: number,
): ResidualSummary[] {
  const toas = db.listToas(d, inputVersion);
  const events = db.listClockEvents(d);
  const branches = db.listBranches(d).filter((b) => b.inputVersion === inputVersion);
  const residualsByBranch = new Map<number, ToaResidual[]>();
  for (const b of branches) {
    residualsByBranch.set(
      b.id,
      computeResiduals(toas, events, branchInput(d, b.id)),
    );
  }
  const summaries: ResidualSummary[] = [];
  for (const b of branches) {
    const siblings = branches
      .filter((o) => o.id !== b.id)
      .filter((o) => {
        const a = db.listCycleShifts(d, b.id);
        const c = db.listCycleShifts(d, o.id);
        return JSON.stringify(a.map(shiftKey)) !== JSON.stringify(c.map(shiftKey));
      })
      .map((o) => ({ branchId: o.id, residuals: residualsByBranch.get(o.id)! }));
    const summary = fullSummary(
      b.id,
      toas,
      events,
      branchInput(d, b.id),
      siblings,
    );
    db.saveBranchSummary(d, b.id, summary);
    summaries.push(summary);
  }
  return summaries;
}

const shiftKey = (s: { boundaryTUs: bigint; delta: bigint }) =>
  `${s.boundaryTUs.toString()}:${s.delta.toString()}`;

export function getBranchDetail(d: DatabaseSync, branchId: number) {
  const b = db.getBranch(d, branchId);
  if (!b) throw new Error(`分支不存在: ${branchId}`);
  const toas = db.listToas(d, b.inputVersion);
  const events = db.listClockEvents(d);
  const input = branchInput(d, branchId);
  const residuals = computeResiduals(toas, events, input);
  recomputeSummaries(d, b.inputVersion);
  const fresh = db.getBranch(d, branchId)!;
  return {
    branch: serializeBranch(fresh),
    shifts: db.listCycleShifts(d, branchId).map((s) => ({
      id: s.id,
      boundaryTUs: s.boundaryTUs.toString(),
      delta: s.delta.toString(),
    })),
    gaps: findGaps(toas, input.exclusions).map((g) => g.toString()),
    residuals: residuals.map(serializeResidual),
    summary: fresh.summaryJson ? JSON.parse(fresh.summaryJson) : null,
  };
}

export function compareBranches(d: DatabaseSync, aId: number, bId: number) {
  const a = db.getBranch(d, aId);
  const b = db.getBranch(d, bId);
  if (!a || !b) throw new Error("分支不存在");
  if (a.inputVersion !== b.inputVersion) {
    throw new Error("两个分支依赖不同的输入版本，无法逐点对比");
  }
  const toas = db.listToas(d, a.inputVersion);
  const events = db.listClockEvents(d);
  const ra = computeResiduals(toas, events, branchInput(d, aId));
  const rb = computeResiduals(toas, events, branchInput(d, bId));
  const byId = new Map(rb.map((r) => [r.toaId, r]));
  return toas.map((t) => {
    const x = ra.find((r) => r.toaId === t.id)!;
    const y = byId.get(t.id)!;
    return {
      toaId: t.id,
      seq: t.seq,
      tUs: t.tUs.toString(),
      bandMHz: t.bandMHz,
      a: { cycle: x.cycle.toString(), residualUs: x.residualUs, excluded: x.excluded },
      b: { cycle: y.cycle.toString(), residualUs: y.residualUs, excluded: y.excluded },
    };
  });
}

export function serializeBranch(b: db.Branch) {
  return {
    id: b.id,
    name: b.name,
    inputVersion: b.inputVersion,
    fNum: b.fNum.toString(),
    dNum: b.dNum.toString(),
    dmNum: b.dmNum.toString(),
    summary: b.summaryJson ? JSON.parse(b.summaryJson) : null,
    createdAt: b.createdAt,
  };
}

function serializeResidual(r: ToaResidual) {
  return {
    toaId: r.toaId,
    seq: r.seq,
    tUs: r.tUs.toString(),
    bandMHz: r.bandMHz,
    excluded: r.excluded,
    cycle: r.cycle.toString(),
    wrapped: r.wrapped,
    residualUs: r.residualUs,
    appliedClockSeqs: r.appliedClockSeqs,
  };
}

export function stateSnapshot(d: DatabaseSync) {
  const versions = db.listInputVersions(d);
  const branches = db.listBranches(d);
  for (const v of versions) recomputeSummaries(d, v.id);
  return {
    inputVersions: db.listInputVersions(d),
    clockEvents: db.listClockEvents(d).map((e) => ({
      id: e.id,
      seq: e.seq,
      tUs: e.tUs.toString(),
      offsetUs: e.offsetUs.toString(),
      label: e.label,
    })),
    branches: db.listBranches(d).map(serializeBranch),
    runLog: db.listRunLog(d).slice(-50),
  };
}

export { DM_SCALE, D_SCALE, F_SCALE };
