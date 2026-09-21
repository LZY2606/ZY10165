/** Canvas 散点图：残差 / 包裹相位 / 分支对比。 */

export interface PlotPoint {
  x: number; // MJD
  y: number;
  excluded?: boolean;
}

export interface PlotOptions {
  yLabel: string;
  zeroLine?: boolean;
  gaps?: number[]; // 空档边界 MJD，右侧阴影
  eventLines?: number[]; // 时钟事件 MJD 竖线
  seriesB?: PlotPoint[]; // 对比序列
}

export function scatter(canvas: HTMLCanvasElement, points: PlotPoint[], opts: PlotOptions) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#0b101c";
  ctx.fillRect(0, 0, width, height);

  const pad = { l: 56, r: 12, t: 18, b: 26 };
  const all = [...points, ...(opts.seriesB ?? [])];
  if (all.length === 0) {
    ctx.fillStyle = "#8b94ab";
    ctx.fillText("无数据", pad.l, height / 2);
    return;
  }
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  let x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (opts.zeroLine) { y0 = Math.min(y0, 0); y1 = Math.max(y1, 0); }
  if (x1 - x0 < 1e-9) { x0 -= 0.5; x1 += 0.5; }
  const yPad = (y1 - y0 || 1) * 0.12;
  y0 -= yPad; y1 += yPad;

  const X = (x: number) => pad.l + ((x - x0) / (x1 - x0)) * (width - pad.l - pad.r);
  const Y = (y: number) => height - pad.b - ((y - y0) / (y1 - y0)) * (height - pad.t - pad.b);

  // 空档阴影（边界右侧到下一数据点之前的区域用边界竖线表示）
  ctx.strokeStyle = "#7e3333";
  ctx.setLineDash([4, 4]);
  for (const g of opts.gaps ?? []) {
    ctx.beginPath(); ctx.moveTo(X(g), pad.t); ctx.lineTo(X(g), height - pad.b); ctx.stroke();
  }
  ctx.setLineDash([]);
  // 时钟事件竖线
  ctx.strokeStyle = "#5c4a17";
  for (const e of opts.eventLines ?? []) {
    ctx.beginPath(); ctx.moveTo(X(e), pad.t); ctx.lineTo(X(e), height - pad.b); ctx.stroke();
  }

  // 坐标轴与零线
  ctx.strokeStyle = "#2a3550";
  ctx.strokeRect(pad.l, pad.t, width - pad.l - pad.r, height - pad.t - pad.b);
  if (opts.zeroLine && y0 < 0 && y1 > 0) {
    ctx.strokeStyle = "#33507e";
    ctx.beginPath(); ctx.moveTo(pad.l, Y(0)); ctx.lineTo(width - pad.r, Y(0)); ctx.stroke();
  }

  ctx.fillStyle = "#8b94ab";
  ctx.font = "11px ui-monospace, monospace";
  ctx.fillText(opts.yLabel, 6, pad.t + 4);
  ctx.fillText(y1.toPrecision(3), 6, pad.t + 16);
  ctx.fillText(y0.toPrecision(3), 6, height - pad.b);
  ctx.fillText(x0.toFixed(2), pad.l, height - 8);
  ctx.fillText(x1.toFixed(2), width - pad.r - 60, height - 8);

  const draw = (pts: PlotPoint[], color: string, exclColor: string) => {
    for (const p of pts) {
      ctx.fillStyle = p.excluded ? exclColor : color;
      ctx.beginPath();
      ctx.arc(X(p.x), Y(p.y), 3, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  draw(points, "#7fd4ff", "#3a4560");
  if (opts.seriesB) draw(opts.seriesB, "#ffb27f", "#3a4560");
}
