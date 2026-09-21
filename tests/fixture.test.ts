import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateFixture } from "../src/core/fixture.js";

describe("固定 fixture", () => {
  it("生成器确定性：两次生成完全一致", () => {
    expect(generateFixture()).toEqual(generateFixture());
  });

  it("与仓库内提交的 fixtures/default.json 一致", () => {
    const committed = JSON.parse(
      readFileSync(join(__dirname, "../fixtures/default.json"), "utf8"),
    );
    expect(generateFixture()).toEqual(committed);
  });

  it("场景结构：30 个前半段 + 5 个末端，空档 200 天", () => {
    const fx = generateFixture();
    expect(fx.toas.length).toBe(35);
    const t = fx.toas.map((x) => BigInt(x.tUs));
    const gapStart = t[29];
    const gapEnd = t[30];
    const gapDays = Number(gapEnd - gapStart) / 86_400_000_000;
    expect(gapDays).toBeGreaterThan(190);
    expect(gapDays).toBeLessThan(210);
  });

  it("E1 恰落在第 10 个到达时刻；E2/E3 同时刻", () => {
    const fx = generateFixture();
    expect(fx.clockEvents[0].tUs).toBe(fx.toas[10].tUs);
    expect(fx.clockEvents[1].tUs).toBe(fx.clockEvents[2].tUs);
  });
});
