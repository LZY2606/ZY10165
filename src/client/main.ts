import { scatter, type PlotPoint } from "./plot.js";

const T0_MJD = 59000;
const DAY_US = 86_400_000_000;

interface InputVersion { id: number; label: string; note: string; tailCount: number; createdAt: string; }
interface ClockEvent { id: number; seq: number; tUs: string; offsetUs: string; label: string; }
interface Summary {
  inputVersion: number; count: number; excludedCount: number;
  rmsUs: number; meanUs: number; maxAbsUs: number;
  viable: boolean;
  identifiable: boolean;
  competitors: { kind: string; boundaryTUs?: string; delta?: string; otherBranchId?: number; rmsUs: number }[];
}
interface Branch {
  id: number; name: string; inputVersion: number;
  fNum: string; dNum: string; dmNum: string;
  summary: Summary | null; createdAt: string;
}
interface State {
  inputVersions: InputVersion[];
  clockEvents: ClockEvent[];
  branches: Branch[];
  runLog: { id: number; ts: string; action: string; detail: string }[];
}
interface Residual {
  toaId: number; seq: number; tUs: string; bandMHz: number;
  excluded: boolean; cycle: string; wrapped: number;
  residualUs: number; appliedClockSeqs: number[];
}
interface BranchDetail {
  branch: Branch;
  shifts: { id: number; boundaryTUs: string; delta: string }[];
  gaps: string[];
  residuals: Residual[];
  summary: Summary | null;
}

let state: State | null = null;
let selectedBranchId: number | null = null;
let detail: BranchDetail | null = null;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const mjd = (tUs: string) => T0_MJD + Number(tUs) / DAY_US;
const fmtMjd = (tUs: string) => mjd(tUs).toFixed(6);

async function api(path: string, body?: unknown): Promise<any> {
  const res = await fetch(path, body !== undefined
    ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
    : undefined);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

function toast(msg: string) {
  $("#toast").textContent = msg;
  setTimeout(() => { $("#toast").textContent = ""; }, 4000);
}

async function refresh() {
  const st: State = await api("/api/state");
  state = st;
  renderState();
  if (selectedBranchId !== null && st.branches.some((b) => b.id === selectedBranchId)) {
    await loadDetail(selectedBranchId);
  } else if (st.branches.length > 0) {
    await loadDetail(st.branches[st.branches.length - 1].id);
  } else {
    detail = null;
    renderDetail();
  }
}

async function loadDetail(branchId: number) {
  selectedBranchId = branchId;
  detail = await api(`/api/branches/${branchId}/detail`);
  renderState();
  renderDetail();
}

function badge(s: Summary | null): string {
  if (!s) return "";
  if (!s.viable) return '<span class="badge warn">方案被数据排除</span>';
  return s.identifiable
    ? '<span class="badge ok">可识别</span>'
    : '<span class="badge warn">可识别性不足</span>';
}

function renderState() {
  const st = state;
  if (!st) return;
  $("#versions").innerHTML = st.inputVersions.map((v) =>
    `<li>v${v.id} · ${v.label} <span class="mono">${v.note}</span></li>`).join("");
  $("#clock-events").innerHTML = st.clockEvents.map((e) =>
    `<li>seq${e.seq} · t=${fmtMjd(e.tUs)} · ${Number(e.offsetUs)}µs · ${e.label}</li>`).join("");
  $("#branches").innerHTML = st.branches.map((b) => {
    const s = b.summary;
    const rms = s ? s.rmsUs.toFixed(2) : "—";
    return `<li class="clickable ${b.id === selectedBranchId ? "active" : ""}" data-branch="${b.id}">
      #${b.id} ${b.name} · v${b.inputVersion} · RMS ${rms}µs ${badge(s)}
    </li>`;
  }).join("");
  document.querySelectorAll("[data-branch]").forEach((el) =>
    el.addEventListener("click", () => loadDetail(Number((el as HTMLElement).dataset.branch))));

  const verOpts = st.inputVersions.map((v) => `<option value="${v.id}">v${v.id} ${v.label}</option>`).join("");
  (document.querySelector('#form-branch select[name="inputVersion"]') as HTMLSelectElement).innerHTML = verOpts;
  const branchOpts = st.branches.map((b) => `<option value="${b.id}">复制 #${b.id} ${b.name}</option>`).join("");
  (document.querySelector('#form-branch select[name="copyFrom"]') as HTMLSelectElement).innerHTML =
    '<option value="">空白参数（fixture 默认）</option>' + branchOpts;
  const cmpOpts = st.branches.map((b) => `<option value="${b.id}">#${b.id} ${b.name}</option>`).join("");
  $("#compare-a").innerHTML = cmpOpts;
  $("#compare-b").innerHTML = cmpOpts;
  $("#run-log").innerHTML = st.runLog.map((l) =>
    `<li>${l.ts} · ${l.action} · ${l.detail}</li>`).join("");
}

function renderDetail() {
  const nameEl = $("#detail-name");
  const sumEl = $("#detail-summary");
  const tbody = document.querySelector("#toa-table tbody") as HTMLElement;
  if (!detail) {
    nameEl.textContent = "（无分支）";
    sumEl.innerHTML = "";
    tbody.innerHTML = "";
    return;
  }
  nameEl.textContent = `#${detail.branch.id} ${detail.branch.name}`;
  const s = detail.summary;
  sumEl.innerHTML = s ? [
    `<span class="item">RMS <b>${s.rmsUs.toFixed(3)} µs</b></span>`,
    `<span class="item">max|res| ${s.maxAbsUs.toFixed(3)} µs</span>`,
    `<span class="item">计入 ${s.count} · 排除 ${s.excludedCount}</span>`,
    `<span class="item">输入版本 v${s.inputVersion}</span>`,
    `<span class="item">${badge(s)}</span>`,
    ...s.competitors.map((c) => c.kind === "branch"
      ? `<span class="item">与分支 #${c.otherBranchId} 不可区分 (Δ≤${c.rmsUs.toFixed(2)}µs)</span>`
      : `<span class="item">空档 ${fmtMjd(c.boundaryTUs!)} 后 ${c.delta} 周等价 (RMS ${c.rmsUs.toFixed(2)}µs)</span>`),
  ].join("") : "";

  const gapSel = $("#gap-select") as HTMLSelectElement;
  gapSel.innerHTML = detail.gaps.length
    ? detail.gaps.map((g) => `<option value="${g}">空档边界 ${fmtMjd(g)}</option>`).join("")
    : '<option value="">（无空档）</option>';
  $("#shifts").innerHTML = detail.shifts.map((sh) =>
    `<li>@${fmtMjd(sh.boundaryTUs)} ${Number(sh.delta) > 0 ? "+" : ""}${sh.delta} 周
      <button data-del-shift="${sh.id}">删</button></li>`).join("");
  document.querySelectorAll("[data-del-shift]").forEach((el) =>
    el.addEventListener("click", async () => {
      await fetch(`/api/branches/${selectedBranchId}/shifts/${(el as HTMLElement).dataset.delShift}`, { method: "DELETE" });
      await refresh();
    }));

  const events = state?.clockEvents ?? [];
  const pts: PlotPoint[] = detail.residuals.map((r) => ({
    x: mjd(r.tUs), y: r.residualUs, excluded: r.excluded,
  }));
  scatter($("#canvas-resid") as HTMLCanvasElement, pts, {
    yLabel: "残差 µs",
    zeroLine: true,
    gaps: detail.gaps.map(mjd),
    eventLines: events.map((e) => mjd(e.tUs)),
  });
  scatter($("#canvas-phase") as HTMLCanvasElement,
    detail.residuals.map((r) => ({ x: mjd(r.tUs), y: r.wrapped, excluded: r.excluded })),
    { yLabel: "包裹相位", gaps: detail.gaps.map(mjd) });

  const gapSet = new Set(detail.gaps);
  tbody.innerHTML = detail.residuals.map((r) => `
    <tr class="${gapSet.has(r.tUs) ? "gap-after" : ""}">
      <td class="${r.excluded ? "excluded" : ""}">${r.seq}</td>
      <td class="${r.excluded ? "excluded" : ""}">${fmtMjd(r.tUs)}</td>
      <td class="${r.excluded ? "excluded" : ""}">${r.bandMHz}</td>
      <td class="${r.excluded ? "excluded" : ""}">${r.residualUs.toFixed(3)}</td>
      <td class="${r.excluded ? "excluded" : ""}">${r.wrapped.toFixed(6)}</td>
      <td class="${r.excluded ? "excluded" : ""}">${r.cycle}</td>
      <td class="${r.excluded ? "excluded" : ""}">${r.appliedClockSeqs.join(",") || "—"}</td>
      <td><input type="checkbox" data-excl="${r.toaId}" ${r.excluded ? "checked" : ""} /></td>
    </tr>`).join("");
  document.querySelectorAll("[data-excl]").forEach((el) =>
    el.addEventListener("change", async () => {
      const cb = el as HTMLInputElement;
      await api(`/api/branches/${selectedBranchId}/exclusions`, {
        toaId: Number(cb.dataset.excl), excluded: cb.checked,
      });
      await refresh();
    }));
}

async function runCompare() {
  const a = ( $("#compare-a") as HTMLSelectElement).value;
  const b = ( $("#compare-b") as HTMLSelectElement).value;
  if (!a || !b) return;
  const data = await api(`/api/compare?a=${a}&b=${b}`);
  const tbody = document.querySelector("#compare-table tbody") as HTMLElement;
  tbody.innerHTML = data.rows.map((r: any) => `
    <tr>
      <td>${r.seq}</td><td>${fmtMjd(r.tUs)}</td><td>${r.bandMHz}</td>
      <td>${r.a.cycle}</td><td>${r.a.residualUs.toFixed(3)}</td>
      <td>${r.b.cycle}</td><td>${r.b.residualUs.toFixed(3)}</td>
      <td>${(r.a.residualUs - r.b.residualUs).toFixed(3)}</td>
    </tr>`).join("");
  scatter($("#canvas-compare") as HTMLCanvasElement,
    data.rows.map((r: any) => ({ x: mjd(r.tUs), y: r.a.residualUs })),
    {
      yLabel: "残差 µs (A 蓝 / B 橙)", zeroLine: true,
      seriesB: data.rows.map((r: any) => ({ x: mjd(r.tUs), y: r.b.residualUs })),
    });
}

function bind() {
  $("#btn-import-full").addEventListener("click", async () => {
    await api("/api/import-fixture", { variant: "full" });
    toast("已导入完整 fixture"); await refresh();
  });
  $("#btn-revert-tail").addEventListener("click", async () => {
    const v = state?.inputVersions[state.inputVersions.length - 1];
    if (!v) { toast("请先导入 fixture"); return; }
    await api("/api/revert-tail", { fromVersion: v.id });
    toast("已回退末端数据，形成新输入版本"); await refresh();
  });
  $("#btn-export").addEventListener("click", async () => {
    const data = await api("/api/export");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `pulse-clock-visa-export-${Date.now()}.json`;
    a.click();
    toast("运行记录已导出");
  });
  $("#file-replay").addEventListener("change", async (ev) => {
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const text = await file.text();
    await api("/api/import-run", JSON.parse(text));
    toast("导出包已重放"); await refresh();
  });
  $("#btn-reset").addEventListener("click", async () => {
    if (!confirm("确认清空数据库？")) return;
    await api("/api/reset", {});
    selectedBranchId = null; toast("数据库已清空"); await refresh();
  });
  $("#form-clock").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target as HTMLFormElement);
    await api("/api/clock-events", {
      tUs: fd.get("tUs"), offsetUs: fd.get("offsetUs"), label: fd.get("label"),
    });
    (ev.target as HTMLFormElement).reset();
    toast("时钟跳变已添加（共同事件）"); await refresh();
  });
  $("#form-branch").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target as HTMLFormElement);
    const copyFrom = fd.get("copyFrom");
    await api("/api/branches", {
      name: fd.get("name"),
      inputVersion: Number(fd.get("inputVersion")),
      copyFrom: copyFrom ? Number(copyFrom) : undefined,
    });
    (ev.target as HTMLFormElement).reset();
    toast("分支已创建"); await refresh();
  });
  $("#btn-shift-p1").addEventListener("click", () => addShift(1));
  $("#btn-shift-m1").addEventListener("click", () => addShift(-1));
  $("#btn-compare").addEventListener("click", runCompare);
}

async function addShift(delta: number) {
  const boundary = ($("#gap-select") as HTMLSelectElement).value;
  if (!boundary || selectedBranchId === null) { toast("无可用空档边界"); return; }
  await api(`/api/branches/${selectedBranchId}/shifts`, { boundaryTUs: boundary, delta });
  toast(`已在空档后施加 ${delta > 0 ? "+" : ""}${delta} 周`); await refresh();
}

bind();
refresh().catch((e) => toast(String(e)));
