import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer } from '../src/server/server.js';

let running: RunningServer;
let tempDir: string;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'pcv-http-'));
  running = await startServer({
    host: '127.0.0.1',
    port: 0,
    dbPath: join(tempDir, 'http.sqlite'),
  });
});

afterAll(async () => {
  await running.close();
  rmSync(tempDir, { recursive: true, force: true });
});

async function getJson(path: string): Promise<any> {
  const response = await fetch(`${running.url}${path}`);
  expect(response.ok).toBe(true);
  return response.json();
}

async function postJson(path: string, body: unknown): Promise<any> {
  const response = await fetch(`${running.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
  return response.json();
}

describe('HTTP 本地服务', () => {
  it('首页标题为脉钟签证并加载打包后的 Canvas 客户端', async () => {
    const html = await (await fetch(`${running.url}/`)).text();
    expect(html).toContain('脉钟签证');
    expect(html).toContain('phase-canvas');
    expect(html).toContain('residual-canvas');
    const js = await (await fetch(`${running.url}/app.js`)).text();
    expect(js).toContain('drawPhaseCanvas');
  });

  it('/api/state 返回到达时刻、频段、分支与输入版本', async () => {
    const state = await getJson('/api/state');
    expect(state.toas.length).toBeGreaterThanOrEqual(5);
    expect(state.toas[0]).toHaveProperty('nCycles');
    expect(state.branches.map((b: { id: string }) => b.id)).toEqual(['H01', 'H02']);
  });

  it('末端回退产生并列分支，加入末端后可区分', async () => {
    let state = (await postJson('/api/switch-version', { versionId: 'v1-baseline' })).state;
    expect(state.underidentifiedPairs.length).toBeGreaterThan(0);
    state = (await postJson('/api/switch-version', { versionId: 'v2-with-endpoint' })).state;
    expect(state.underidentifiedPairs).toEqual([]);
    const k0 = state.branches.find((b: { id: string }) => b.id === 'H01');
    const k1 = state.branches.find((b: { id: string }) => b.id === 'H02');
    expect(k1.fit.rmsS).toBeGreaterThan(k0.fit.rmsS * 1000);
  });

  it('在边界时刻添加时钟事件后，比较接口逐点返回且仅作用一次', async () => {
    const state = await getJson('/api/state');
    const tB = state.toas.find((t: { session: string }) => t.session === 'B').tNs;
    const updated = (
      await postJson('/api/branches/clock-event', {
        branchId: 'H01',
        atNs: tB,
        jumpNs: '500',
        label: 'boundary-http',
      })
    ).state;
    const h01 = updated.branches.find((b: { id: string }) => b.id === 'H01');
    const pointB = h01.fit.points.find((p: { toaCode: string }) => p.toaCode.startsWith('B'));
    const pointA = h01.fit.points.find((p: { toaCode: string }) => p.toaCode.startsWith('A1'));
    expect(pointB.clockAppliedNs).toBe('500');
    expect(pointA.clockAppliedNs).toBe('0');
    const comparison = (
      await postJson('/api/compare', { branchIdA: 'H01', branchIdB: 'H02' })
    ).comparison;
    expect(comparison.points.length).toBe(6);
    expect(comparison.points.every((p: { nCyclesA: string }) => typeof p.nCyclesA === 'string')).toBe(true);
  });
});
