interface FitPoint {
  toaCode: string;
  session: 'A' | 'B' | 'C';
  tNs: string;
  freqMhz: number;
  nCyclesEffective: string;
  wrapped: number;
  excluded: boolean;
  residualS: number;
  clockAppliedNs: string;
}
interface FitSummary {
  params: { phi0S: number; f0Hz: number; f1HzS: number; dm: number };
  rmsS: number;
  chi2: number;
  maxAbsS: number;
  dof: number;
  points: FitPoint[];
  inputHash: string;
  fittedAt: string;
}
interface ClockEventJson {
  seq: number;
  branchId: string;
  atNs: string;
  jumpNs: string;
  label: string;
}
interface BranchJson {
  id: string;
  label: string;
  baseVersion: string;
  parentId: string | null;
  note: string;
  gapOffsets: Record<string, number>;
  excluded: string[];
  clockEvents: ClockEventJson[];
  createdAt: string;
  fit: FitSummary | null;
  underidentifiedWith: string[];
  inputHash: string;
}
interface ToaJson {
  code: string;
  session: 'A' | 'B' | 'C';
  ordinal: number;
  tNs: string;
  freqMhz: number;
  nCycles: string;
  wrapped: number;
  sigmaS: number;
  versionId: string;
  active: boolean;
}
interface State {
  activeVersion: string;
  versions: { id: string; label: string; toaHash: string; count: number }[];
  gaps: { index: number; afterSession: string; beforeSession: string }[];
  spec: {
    tRefNs: string;
    f0NominalHz: number;
    gapS: number;
    endpointOffsetS: number;
  };
  toas: ToaJson[];
  branches: BranchJson[];
  operationsCount: number;
  underidentifiedPairs: [string, string][];
}

let state: State | null = null;

const $ = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`缺少元素 ${selector}`);
  return element;
};

async function api(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init,
    body: init.body as BodyInit | null | undefined,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status}: ${text}`);
  }
  return response.json() as Promise<unknown>;
}

async function refresh(): Promise<void> {
  state = (await api('/api/state')) as State;
  render(state);
}

function render(current: State): void {
  renderVersionSelect(current);
  renderToas(current);
  drawPhaseCanvas(current);
  renderBranches(current);
  renderCompareSelectors(current);
  renderIdentBanner(current);
}

function renderVersionSelect(current: State): void {
  const select = $<HTMLSelectElement>('#version-select');
  select.innerHTML = '';
  for (const version of current.versions) {
    const option = document.createElement('option');
    option.value = version.id;
    option.textContent = `${version.label}（${version.count} 点）`;
    option.selected = version.id === current.activeVersion;
    select.append(option);
  }
}

function renderToas(current: State): void {
  const body = $('#toa-table tbody') as HTMLTableSectionElement;
  body.innerHTML = '';
  for (const toa of current.toas) {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${toa.session} 望次</td>
      <td>${toa.code}</td>
      <td>${toa.tNs}</td>
      <td>${toa.freqMhz}</td>
      <td>${toa.nCycles}</td>
      <td>${toa.wrapped.toFixed(9)}</td>`;
    body.append(row);
  }
}

function renderIdentBanner(current: State): void {
  const banner = $('#ident-banner') as HTMLDivElement;
  if (current.underidentifiedPairs.length === 0) {
    banner.classList.add('hidden');
    banner.textContent = '';
    return;
  }
  banner.classList.remove('hidden');
  banner.textContent =
    '可识别性不足：' +
    current.underidentifiedPairs
      .map(([a, b]) => `${a} 与 ${b} 的残差统计并列（rms 差 ≤ 1e-9 s），两个整数周方案同时保留。`)
      .join('；');
}

function drawPhaseCanvas(current: State): void {
  const canvas = $<HTMLCanvasElement>('#phase-canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#0c1220';
  ctx.fillRect(0, 0, width, height);

  const pad = { left: 56, right: 20, top: 24, bottom: 34 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const times = current.toas.map((toa) => BigInt(toa.tNs));
  const tMin = times.reduce((a, b) => (a < b ? a : b));
  const tMax = times.reduce((a, b) => (a > b ? a : b));
  const span = Number(tMax - tMin) || 1;

  ctx.strokeStyle = '#2b3650';
  ctx.fillStyle = '#98a4bb';
  ctx.lineWidth = 1;
  ctx.font = '12px sans-serif';
  for (let k = 0; k <= 4; k++) {
    const y = pad.top + (plotH * k) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
    const value = 1 - k / 4;
    ctx.fillText(value.toFixed(2), 8, y + 4);
  }
  ctx.fillText('包裹相位 w（周）', 6, 14);

  const xOf = (tNs: bigint) => pad.left + (Number(tNs - tMin) / span) * plotW;
  const yOf = (w: number) => pad.top + (1 - w) * plotH;

  const colors: Record<string, string> = { A: '#6bb6ff', B: '#ffcf6b', C: '#7ce0a8' };
  for (const toa of current.toas) {
    const x = xOf(BigInt(toa.tNs));
    const y = yOf(toa.wrapped);
    ctx.fillStyle = colors[toa.session] ?? '#fff';
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#98a4bb';
    ctx.fillText(`${toa.code} ${toa.freqMhz}MHz`, x + 7, y - 6);
  }
  ctx.fillStyle = '#98a4bb';
  ctx.fillText('注意：图中圆点仅显示包裹相位；整数周 N 以 BigInt 明确存储，跨空档不取模推断。', pad.left, height - 10);
}

function renderBranches(current: State): void {
  const container = $('#branches') as HTMLDivElement;
  container.innerHTML = '';
  for (const branch of current.branches) {
    container.append(renderBranchCard(current, branch));
  }
}

function renderBranchCard(current: State, branch: BranchJson): HTMLDivElement {
  const card = document.createElement('div');
  card.className = 'branch';
  const tied = branch.underidentifiedWith.length > 0;
  if (tied) card.classList.add('tied');
  const fit = branch.fit;
  const tagHtml = fit
    ? tied
      ? '<span class="tag warn">可识别性不足 · 并列</span>'
      : '<span class="tag ok">已拟合</span>'
    : '<span class="tag">未拟合</span>';
  card.innerHTML = `
    <h3><span>${branch.id} · ${branch.label}</span>${tagHtml}</h3>
    <div class="small">输入版本 ${branch.baseVersion} · 父分支 ${branch.parentId ?? '—'} · 输入哈希 ${branch.inputHash.slice(0, 12)}…</div>
    <div class="metrics">
      <span>phi0 (周)</span><b>${fit ? fit.params.phi0S.toFixed(9) : '—'}</b>
      <span>f0 (Hz)</span><b>${fit ? fit.params.f0Hz.toFixed(9) : '—'}</b>
      <span>f1 (Hz/s)</span><b>${fit ? fit.params.f1HzS.toExponential(3) : '—'}</b>
      <span>DM (pc cm⁻³)</span><b>${fit ? fit.params.dm.toFixed(6) : '—'}</b>
      <span>rms 残差</span><b>${fit ? `${(fit.rmsS * 1e6).toExponential(3)} µs` : '—'}</b>
      <span>χ² / dof</span><b>${fit ? `${fit.chi2.toExponential(3)} / ${fit.dof}` : '—'}</b>
    </div>
    <div class="clock-list">周偏移：${current.gaps
      .map(
        (gap) =>
          `${gap.afterSession}→${gap.beforeSession} k=${branch.gapOffsets[String(gap.index)] ?? 0}`,
      )
      .join('；')}</div>
    <div class="row-actions" data-branch="${branch.id}">
      <select data-action="gap-index">
        ${current.gaps
          .map(
            (gap) =>
              `<option value="${gap.index}">空档 ${gap.afterSession}→${gap.beforeSession}</option>`,
          )
          .join('')}
      </select>
      <button type="button" data-action="dec">周数 −1</button>
      <button type="button" data-action="inc">周数 +1</button>
    </div>
    <div class="row-actions">
      <select data-action="toa-code">
        ${current.toas.map((toa) => `<option value="${toa.code}">${toa.code}</option>`).join('')}
      </select>
      <button type="button" data-action="exclude">列为排除候选</button>
      <button type="button" data-action="include">恢复观测</button>
    </div>
    <div class="row-actions">
      <input data-action="at-ns" placeholder="事件时刻 t (ns)" size="22" />
      <input data-action="jump-ns" placeholder="跳变量 (ns)" size="14" />
      <input data-action="clock-label" placeholder="事件标签" size="12" />
      <button type="button" data-action="add-clock">添加时钟跳变（右连续）</button>
    </div>
    <div class="clock-list" data-role="clock-events"></div>
    <div class="exclude-list" data-role="excluded"></div>
  `;

  const clockHost = card.querySelector('[data-role="clock-events"]') as HTMLDivElement;
  if (branch.clockEvents.length === 0) {
    clockHost.textContent = '时钟事件：无';
  } else {
    clockHost.append(
      ...branch.clockEvents.map((event) => {
        const line = document.createElement('div');
        line.innerHTML = `#${event.seq} ${event.label}：t≥${event.atNs} 应用 ${event.jumpNs} ns
          <button type="button" data-action="remove-clock" data-seq="${event.seq}">删除</button>`;
        return line;
      }),
    );
  }
  const excludedHost = card.querySelector('[data-role="excluded"]') as HTMLDivElement;
  excludedHost.textContent = branch.excluded.length
    ? '排除候选：'
    : '排除候选：无';
  excludedHost.append(
    ...branch.excluded.map((code) => {
      const span = document.createElement('span');
      span.textContent = code;
      return span;
    }),
  );

  card.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach((button) => {
    button.addEventListener('click', () =>
      handleBranchAction(branch.id, button.dataset.action ?? '', card, button),
    );
  });
  return card;
}

async function handleBranchAction(
  branchId: string,
  action: string,
  card: HTMLDivElement,
  sourceButton?: HTMLButtonElement,
): Promise<void> {
  try {
    if (action === 'inc' || action === 'dec') {
      const gapIndex = Number(
        (card.querySelector('[data-action="gap-index"]') as HTMLSelectElement).value,
      );
      await api('/api/branches/adjust-offset', {
        method: 'POST',
        body: JSON.stringify({ branchId, gapIndex, delta: action === 'inc' ? 1 : -1 }),
      });
    } else if (action === 'exclude' || action === 'include') {
      const toaCode = (card.querySelector('[data-action="toa-code"]') as HTMLSelectElement).value;
      await api('/api/branches/exclude', {
        method: 'POST',
        body: JSON.stringify({ branchId, toaCode, excluded: action === 'exclude' }),
      });
    } else if (action === 'add-clock') {
      const atNs = (card.querySelector('[data-action="at-ns"]') as HTMLInputElement).value.trim();
      const jumpNs = (card.querySelector('[data-action="jump-ns"]') as HTMLInputElement).value.trim();
      const label = (card.querySelector('[data-action="clock-label"]') as HTMLInputElement).value.trim();
      if (!/^-?\d+$/.test(atNs) || !/^-?\d+$/.test(jumpNs)) {
        throw new Error('时钟事件时刻与跳变量必须是整数纳秒');
      }
      await api('/api/branches/clock-event', {
        method: 'POST',
        body: JSON.stringify({ branchId, atNs, jumpNs, label: label || '时钟跳变' }),
      });
    } else if (action === 'remove-clock') {
      const seq = Number(sourceButton?.dataset.seq);
      if (!Number.isInteger(seq)) throw new Error('缺少时钟事件序号');
      await api('/api/branches/remove-clock-event', {
        method: 'POST',
        body: JSON.stringify({ branchId, seq }),
      });
    }
    await refresh();
  } catch (error) {
    alert(error instanceof Error ? error.message : String(error));
  }
}

function renderCompareSelectors(current: State): void {
  for (const id of ['compare-a', 'compare-b'] as const) {
    const select = $<HTMLSelectElement>(`#${id}`);
    const previous = select.value;
    select.innerHTML = current.branches
      .map((branch) => `<option value="${branch.id}">${branch.id} ${branch.label}</option>`)
      .join('');
    select.value = previous || (id === 'compare-a' ? current.branches[0]?.id ?? '' : current.branches[1]?.id ?? current.branches[0]?.id ?? '');
  }
}

interface Comparison {
  a: { branchId: string; label: string; fit: FitSummary };
  b: { branchId: string; label: string; fit: FitSummary };
  tied: boolean;
  points: {
    toaCode: string;
    session: string;
    freqMhz: number;
    nCyclesA: string;
    nCyclesB: string;
    residualA: number;
    residualB: number;
    deltaResidualS: number;
  }[];
}

async function runComparison(): Promise<void> {
  const branchIdA = $<HTMLSelectElement>('#compare-a').value;
  const branchIdB = $<HTMLSelectElement>('#compare-b').value;
  const result = (await api('/api/compare', {
    method: 'POST',
    body: JSON.stringify({ branchIdA, branchIdB }),
  })) as { comparison: Comparison };
  renderComparison(result.comparison);
}

function renderComparison(comparison: Comparison): void {
  const body = $('#compare-table tbody') as HTMLTableSectionElement;
  body.innerHTML = '';
  for (const point of comparison.points) {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${point.toaCode}</td>
      <td>${point.session}</td>
      <td>${point.freqMhz}</td>
      <td>${point.nCyclesA}</td>
      <td>${point.nCyclesB}</td>
      <td>${(point.residualA * 1e6).toFixed(4)}</td>
      <td>${(point.residualB * 1e6).toFixed(4)}</td>
      <td>${(point.deltaResidualS * 1e6).toFixed(4)}</td>`;
    body.append(row);
  }
  drawResidualCanvas(comparison);
}

function drawResidualCanvas(comparison: Comparison): void {
  const canvas = $<HTMLCanvasElement>('#residual-canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#0c1220';
  ctx.fillRect(0, 0, width, height);
  const pad = { left: 64, right: 20, top: 26, bottom: 40 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const values = comparison.points.flatMap((point) => [point.residualA, point.residualB]);
  const maxAbs = Math.max(1e-9, ...values.map((value) => Math.abs(value || 0)));
  const yOf = (value: number) => pad.top + (1 - value / maxAbs) * plotH * 0.5;

  ctx.strokeStyle = '#2b3650';
  ctx.fillStyle = '#98a4bb';
  ctx.font = '12px sans-serif';
  for (let k = -2; k <= 2; k++) {
    const y = yOf((k / 2) * maxAbs);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
    ctx.fillText(`${(((k / 2) * maxAbs) * 1e6).toFixed(2)} µs`, 8, y + 4);
  }
  const bandW = plotW / Math.max(1, comparison.points.length);
  comparison.points.forEach((point, index) => {
    const xA = pad.left + bandW * index + bandW * 0.28;
    const xB = pad.left + bandW * index + bandW * 0.62;
    ctx.fillStyle = '#6bb6ff';
    ctx.fillRect(xA, Math.min(yOf(0), yOf(point.residualA)), 8, Math.abs(yOf(point.residualA) - yOf(0)));
    ctx.fillStyle = '#ffcf6b';
    ctx.fillRect(xB, Math.min(yOf(0), yOf(point.residualB)), 8, Math.abs(yOf(point.residualB) - yOf(0)));
    ctx.fillStyle = '#98a4bb';
    ctx.save();
    ctx.translate(xA, height - 18);
    ctx.rotate(-Math.PI / 7);
    ctx.fillText(point.toaCode, 0, 0);
    ctx.restore();
  });
  ctx.fillStyle = '#6bb6ff';
  ctx.fillText(`■ ${comparison.a.branchId} rms=${(comparison.a.fit.rmsS * 1e6).toExponential(2)} µs`, pad.left, 16);
  ctx.fillStyle = '#ffcf6b';
  ctx.fillText(`■ ${comparison.b.branchId} rms=${(comparison.b.fit.rmsS * 1e6).toExponential(2)} µs${comparison.tied ? '（统计并列）' : ''}`, pad.left + 320, 16);
}

async function exportRun(): Promise<void> {
  const payload = await api('/api/export');
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `pulse-clock-visa-run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function importRun(file: File): Promise<void> {
  const text = await file.text();
  const payload = JSON.parse(text) as unknown;
  const result = (await api('/api/import', {
    method: 'POST',
    body: JSON.stringify(payload),
  })) as { report: { operationsReplayed: number; fixtureHashBefore: string; fixtureHashAfter: string } };
  const match = result.report.fixtureHashBefore === result.report.fixtureHashAfter;
  alert(
    `重放完成：${result.report.operationsReplayed} 条操作；fixture 哈希${match ? '一致' : '不一致'}。`,
  );
  await refresh();
}

function bindToolbar(): void {
  $('#version-select').addEventListener('change', async (event) => {
    const select = event.target as HTMLSelectElement;
    await api('/api/switch-version', {
      method: 'POST',
      body: JSON.stringify({ versionId: select.value }),
    });
    await refresh();
  });
  $('#btn-refit').addEventListener('click', async () => {
    await api('/api/refit', { method: 'POST' });
    await refresh();
  });
  $('#btn-export').addEventListener('click', () => void exportRun());
  $('#btn-import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void importRun(file);
    input.value = '';
  });
  $('#btn-reset').addEventListener('click', async () => {
    if (!confirm('确认清空数据库并重新导入固定 fixture 种子？')) return;
    await api('/api/reset', { method: 'POST' });
    await refresh();
  });
  $('#btn-branch').addEventListener('click', async () => {
    if (!state) return;
    const fromBranchId =
      $<HTMLSelectElement>('#compare-a').value || state.branches[0]?.id || null;
    const label = prompt('新分支名称', `分支 H${String(state.branches.length + 1).padStart(2, '0')}`);
    if (!label) return;
    await api('/api/branches', {
      method: 'POST',
      body: JSON.stringify({ label, fromBranchId }),
    });
    await refresh();
  });
  $('#btn-compare').addEventListener('click', () => void runComparison());
}

bindToolbar();
void refresh().then(() => void runComparison()).catch((error: unknown) => {
  alert(error instanceof Error ? error.message : String(error));
});
