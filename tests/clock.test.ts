import { describe, expect, it } from "vitest";
import { generateFixture } from "../src/core/fixture.js";
import { clockOffsetAt, type ClockEvent } from "../src/core/model.js";

function fixtureEvents(): ClockEvent[] {
  return generateFixture().clockEvents.map((e, i) => ({
    id: i + 1,
    seq: i + 1,
    tUs: BigInt(e.tUs),
    offsetUs: BigInt(e.offsetUs),
    label: e.label,
  }));
}

describe("时钟跳变语义", () => {
  const events = fixtureEvents();
  const e1 = events[0];

  it("右连续：跳变恰落在观测时刻时生效", () => {
    const at = clockOffsetAt(events, e1.tUs);
    expect(at.offsetUs).toBe(500n);
    expect(at.appliedSeqs).toEqual([1]);
  });

  it("边界前 1µs 不生效", () => {
    const before = clockOffsetAt(events, e1.tUs - 1n);
    expect(before.offsetUs).toBe(0n);
    expect(before.appliedSeqs).toEqual([]);
  });

  it("恰落在观测时刻的跳变只应用一次（不重复、不遗漏）", () => {
    const fx = generateFixture();
    const toa10 = BigInt(fx.toas[10].tUs);
    expect(toa10).toBe(e1.tUs); // fixture 保证事件恰在第 10 个到达时刻
    const at = clockOffsetAt(events, toa10);
    expect(at.offsetUs).toBe(500n); // 恰好一次：不是 0，也不是 1000
  });

  it("同时事件按不可变 seq 合成", () => {
    const t = events[1].tUs; // E2/E3 同时刻
    const at = clockOffsetAt(events, t);
    expect(at.appliedSeqs).toEqual([1, 2, 3]); // 按 seq 升序
    expect(at.offsetUs).toBe(500n + 100n - 30n);
  });

  it("合成顺序与事件插入顺序无关，只认 seq", () => {
    const shuffled = [events[2], events[0], events[1]];
    const at = clockOffsetAt(shuffled, events[1].tUs);
    expect(at.appliedSeqs).toEqual([1, 2, 3]);
    expect(at.offsetUs).toBe(570n);
  });
});
