import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { openDb, type ExportBundle } from "../src/server/db.js";
import { createApp } from "../src/server/api.js";

let server: Server;
let base: string;

beforeAll(async () => {
  const db = openDb(":memory:");
  server = createApp(db, "/nonexistent-public");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const get = (p: string) => fetch(`${base}${p}`).then((r) => r.json());
const post = (p: string, body: unknown = {}) =>
  fetch(`${base}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());

describe("HTTP API 全流程", () => {
  it("导入 → 建分支 → 加 shift → 摘要 → 对比 → 导出 → 清空 → 重放复核", async () => {
    // 导入完整 fixture
    const imp = await post("/api/import-fixture", { variant: "full" });
    expect(imp.inputVersion).toBe(1);

    // 两个假设分支
    const a = (await post("/api/branches", { name: "方案A(0)", inputVersion: 1 })).branchId;
    const b = (await post("/api/branches", { name: "方案B(+1)", inputVersion: 1, copyFrom: a })).branchId;

    // 在空档边界上给 B 加 +1 周
    const detailA = await get(`/api/branches/${a}/detail`);
    expect(detailA.gaps.length).toBe(1);
    await post(`/api/branches/${b}/shifts`, { boundaryTUs: detailA.gaps[0], delta: 1 });

    // 摘要：A 可识别，B 被排除
    const dA = await get(`/api/branches/${a}/detail`);
    const dB = await get(`/api/branches/${b}/detail`);
    expect(dA.summary.identifiable).toBe(true);
    expect(dB.summary.viable).toBe(false);
    expect(dA.residuals.length).toBe(35);
    // 残差表包含到达时刻、频段、包裹相位、整周编号
    const r0 = dA.residuals[0];
    expect(r0).toHaveProperty("tUs");
    expect(r0).toHaveProperty("bandMHz");
    expect(r0).toHaveProperty("wrapped");
    expect(r0).toHaveProperty("cycle");

    // 逐点对比
    const cmp = await get(`/api/compare?a=${a}&b=${b}`);
    expect(cmp.rows.length).toBe(35);
    const tail = cmp.rows[cmp.rows.length - 1];
    expect(Number(tail.b.cycle) - Number(tail.a.cycle)).toBe(1);

    // 排除候选
    await post(`/api/branches/${a}/exclusions`, { toaId: tail.toaId, excluded: true });
    const dA2 = await get(`/api/branches/${a}/detail`);
    expect(dA2.summary.excludedCount).toBe(1);
    await post(`/api/branches/${a}/exclusions`, { toaId: tail.toaId, excluded: false });

    // 共同时钟跳变：seq 不可变递增
    const ev = await post("/api/clock-events", { tUs: "1000", offsetUs: "5", label: "test" });
    expect(ev.seq).toBe(4); // fixture 已有 3 个

    // 导出运行记录
    const exported = (await get("/api/export")) as ExportBundle;
    expect(exported.format).toBe("pulse-clock-visa-export");
    const summariesBefore = (await get("/api/state")).branches.map((b: any) => b.summary);

    // 清空数据库
    await post("/api/reset");
    const empty = await get("/api/state");
    expect(empty.branches.length).toBe(0);
    expect(empty.inputVersions.length).toBe(0);

    // 重放导出包复核：摘要完全一致
    await post("/api/import-run", exported);
    const replayed = await get("/api/state");
    expect(replayed.branches.length).toBe(2);
    const summariesAfter = replayed.branches.map((b: any) => b.summary);
    expect(summariesAfter).toEqual(summariesBefore);
  });

  it("回退末端数据后形成并列分支（验收路径）", async () => {
    await post("/api/reset");
    const imp = await post("/api/import-fixture", { variant: "full" });
    const rev = await post("/api/revert-tail", { fromVersion: imp.inputVersion });
    expect(rev.inputVersion).toBe(2);

    const a = (await post("/api/branches", { name: "A", inputVersion: 2 })).branchId;
    const b = (await post("/api/branches", { name: "B", inputVersion: 2, copyFrom: a })).branchId;
    // 空档边界超出当前数据范围（末端已回退）
    const fullDetail = await get(`/api/branches/${a}/detail`);
    expect(fullDetail.gaps.length).toBe(0); // 回退版本内无空档
    // 用完整版本的边界（从 fixture 直接得知：第 30 个 TOA 时刻）
    const state = await get("/api/state");
    void state;
    // 直接在完整版本上查边界
    const aFull = (await post("/api/branches", { name: "tmp", inputVersion: 1 })).branchId;
    const fullDet = await get(`/api/branches/${aFull}/detail`);
    await post(`/api/branches/${b}/shifts`, { boundaryTUs: fullDet.gaps[0], delta: 1 });

    const dA = await get(`/api/branches/${a}/detail`);
    const dB = await get(`/api/branches/${b}/detail`);
    expect(dA.summary.viable).toBe(true);
    expect(dB.summary.viable).toBe(true);
    expect(dA.summary.identifiable).toBe(false);
    expect(dB.summary.identifiable).toBe(false);
  });

  it("时钟跳变恰落在观测时刻只应用一次（端到端残差验证）", async () => {
    await post("/api/reset");
    await post("/api/import-fixture", { variant: "full" });
    const a = (await post("/api/branches", { name: "A", inputVersion: 1 })).branchId;
    const detail = await get(`/api/branches/${a}/detail`);
    // 第 10 个到达时刻恰有 500µs 跳变；若应用两次或零次，残差将偏离 ±500µs
    const r10 = detail.residuals.find((r: any) => r.seq === 10);
    expect(r10.appliedClockSeqs).toEqual([1]);
    expect(Math.abs(r10.residualUs)).toBeLessThan(25);
    // 第 9 个不受 E1 影响
    const r9 = detail.residuals.find((r: any) => r.seq === 9);
    expect(r9.appliedClockSeqs).toEqual([]);
    expect(Math.abs(r9.residualUs)).toBeLessThan(25);
  });
});
