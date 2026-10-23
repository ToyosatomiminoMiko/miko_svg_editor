/**
 * 网格与原点十字：把世界网格线换算到屏幕像素绘制，取整 + pixelAlign 让 1px 线落在像素中心。
 * 只遍历视口覆盖的世界范围，网格间距由 gridSize 保证屏幕间距落在可读区间，缩放时观感稳定。
 */

import { gridSize, s2w, w2s } from '../core/camera';
import type { CameraView } from '../core/camera';
import type { Theme } from './theme';

export function drawGrid(ctx: CanvasRenderingContext2D, theme: Theme, view: CameraView): void {
  const W = view.viewportW;
  const H = view.viewportH;
  const g = gridSize(view.z);
  const a = s2w({ x: 0, y: 0 }, view);
  const b = s2w({ x: W, y: H }, view);

  ctx.strokeStyle = theme.grid;
  ctx.lineWidth = theme.hairlineWidth;
  ctx.beginPath();
  for (let x = Math.floor(a.x / g) * g; x <= b.x; x += g) {
    const sx = Math.round(w2s({ x, y: 0 }, view).x) + theme.pixelAlign;
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, H);
  }
  for (let y = Math.floor(a.y / g) * g; y <= b.y; y += g) {
    const sy = Math.round(w2s({ x: 0, y }, view).y) + theme.pixelAlign;
    ctx.moveTo(0, sy);
    ctx.lineTo(W, sy);
  }
  ctx.stroke();

  // 原点十字
  const o = w2s({ x: 0, y: 0 }, view);
  ctx.strokeStyle = theme.axis;
  ctx.beginPath();
  ctx.moveTo(0, o.y + theme.pixelAlign);
  ctx.lineTo(W, o.y + theme.pixelAlign);
  ctx.moveTo(o.x + theme.pixelAlign, 0);
  ctx.lineTo(o.x + theme.pixelAlign, H);
  ctx.stroke();
}
