import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDb, listToas, getBranch, addCycleShift, setExclusion } from "../src/server/db.js";
import {
  createBranch,
  importFixture,
  recomputeSummaries,
  revertTail,
} from "../src/server/service.js";

let db: DatabaseSync;
beforeEach(() => {
  db = openDb(":memory:");
});

function summaryOf(branchId: number) {
  const b = getBranch(db, branchId)!;
  return JSON.parse(b.summaryJson!);
}

describe("整周模糊与可识别性", () => {
  it("完整数据：shift 0 可识别，shift +1 被数据排除", () => {
    const { inputVersion } = importFixture(db, "full");
    const a = createBranch(db, "方案A(0)", inputVersion).branchId;
    const b = createBranch(db, "方案B(+1)", inputVersion, undefined, a).branchId;
    const toas = listToas(db, inputVersion);
    const gapBoundary = toas[toas.length - 5].tUs; // 空档后第一个末端观测
    addCycleShift(db, b, gapBoundary, 1n);
    recomputeSummaries(db, inputVersion);

    const sa = summaryOf(a);
    const sb = summaryOf(b);
    expect(sa.viable).toBe(true);
    expect(sa.identifiable).toBe(true);
    expect(sa.rmsUs).toBeLessThan(25);
    expect(sb.viable).toBe(false); // RMS ~ 38ms，被数据排除
    expect(sb.rmsUs).toBeGreaterThan(10_000);
  });

  it("回退末端数据：两个周数方案并列保留，均标记可识别性不足", () => {
    const full = importFixture(db, "full");
    const reverted = revertTail(db, full.inputVersion);
    const v = reverted.inputVersion;
    expect(listToas(db, v).length).toBe(30);

    const a = createBranch(db, "方案A(0)", v).branchId;
    const b = createBranch(db, "方案B(+1)", v, undefined, a).branchId;
    // 空档边界取完整 fixture 中末端首点的时刻（超出当前数据范围，shift 暂不作用于任何点）
    const fullToas = listToas(db, full.inputVersion);
    const gapBoundary = fullToas[fullToas.length - 5].tUs;
    addCycleShift(db, b, gapBoundary, 1n);
    recomputeSummaries(db, v);

    const sa = summaryOf(a);
    const sb = summaryOf(b);
    // 两个方案都保留（均未被排除），且都标记可识别性不足
    expect(sa.viable).toBe(true);
    expect(sb.viable).toBe(true);
    expect(sa.identifiable).toBe(false);
    expect(sb.identifiable).toBe(false);
    // 残差完全一致（shift 尚无作用对象）
    expect(sa.rmsUs).toBeCloseTo(sb.rmsUs, 9);
    // 互相指认为不可区分的竞争方案
    expect(sa.competitors.some((c: any) => c.kind === "branch" && c.otherBranchId === b)).toBe(true);
    expect(sb.competitors.some((c: any) => c.kind === "branch" && c.otherBranchId === a)).toBe(true);
  });

  it("加入末端观测后两个方案重新可区分", () => {
    const full = importFixture(db, "full");
    const reverted = revertTail(db, full.inputVersion);
    // 先在回退版本上建立并列分支
    const a0 = createBranch(db, "A", reverted.inputVersion).branchId;
    const b0 = createBranch(db, "B", reverted.inputVersion, undefined, a0).branchId;
    const fullToas = listToas(db, full.inputVersion);
    const gapBoundary = fullToas[fullToas.length - 5].tUs;
    addCycleShift(db, b0, gapBoundary, 1n);
    recomputeSummaries(db, reverted.inputVersion);
    expect(summaryOf(a0).identifiable).toBe(false);
    // 再把同样的两个方案建到完整版本上
    const a1 = createBranch(db, "A", full.inputVersion).branchId;
    const b1 = createBranch(db, "B", full.inputVersion, undefined, a1).branchId;
    addCycleShift(db, b1, gapBoundary, 1n);
    recomputeSummaries(db, full.inputVersion);
    expect(summaryOf(a1).identifiable).toBe(true);
    expect(summaryOf(b1).viable).toBe(false);
  });

  it("排除候选：排除离群点后 RMS 下降且计数正确", () => {
    const { inputVersion } = importFixture(db, "full");
    const a = createBranch(db, "A", inputVersion).branchId;
    const b = createBranch(db, "B", inputVersion, undefined, a).branchId;
    const toas = listToas(db, inputVersion);
    addCycleShift(db, b, toas[toas.length - 5].tUs, 1n);
    recomputeSummaries(db, inputVersion);
    const rmsBefore = summaryOf(b).rmsUs;
    // 把 5 个末端观测全部列为排除候选
    for (const t of toas.slice(-5)) setExclusion(db, b, t.id, true);
    recomputeSummaries(db, inputVersion);
    const sb = summaryOf(b);
    expect(sb.count).toBe(30);
    expect(sb.excludedCount).toBe(5);
    expect(sb.rmsUs).toBeLessThan(rmsBefore);
  });
});
