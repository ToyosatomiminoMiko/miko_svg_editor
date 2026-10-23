/**
 * 交互层覆盖物：命令预览、框选矩形、吸附标记。
 * 预览几何用虚线画在实体层，尺寸落位预览用正式标注的画法 + 预览色，跟在指针后面；
 * 这些绘制都在 save/restore 的局部状态里，描边/虚线/透明度不能泄漏给后续绘制。
 */

import { w2s } from '../core/camera';
import type { CameraView } from '../core/camera';
import { commandPreview, dimensionPreview } from '../core/operations';
import type { CommandSession } from '../core/operations';
import { isCrossing } from '../core/selection';
import type { Marquee, Snap, Vec } from '../core/types';
import type { Theme } from './theme';
import { drawDimLayout } from './draw-dimensions';
import { strokePrimitive } from './draw-primitives';

/**
 * 命令预览：几何基元用虚线画在实体层（strokePrimitive），尺寸落位用正式标注的画法 +
 * 预览色，跟在指针后面——目标选好后用户看到的就是「按下会得到的那条尺寸」。
 */
export function drawPreview(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  command: CommandSession | null,
  cur: Vec,
  view: CameraView,
): void {
  if (!command) return;
  const shapes = commandPreview(command, cur);
  const dim = dimensionPreview(command, cur, view, view.z);
  if (shapes.length === 0 && !dim) return;

  if (shapes.length > 0) {
    ctx.save();
    ctx.strokeStyle = theme.preview;
    ctx.lineWidth = theme.strokeWidth;
    ctx.setLineDash(theme.dashPreview);
    for (const shape of shapes) strokePrimitive(ctx, shape, view);
    ctx.setLineDash([]);
    ctx.restore();
  }
  if (dim) drawDimLayout(ctx, theme, dim, theme.preview);
}

/** 框选矩形：方向判定与命中判定共用 selection.isCrossing（下→上交叉 / 上→下窗口） */
export function drawMarquee(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  marquee: Marquee | null,
): void {
  if (!marquee) return;
  const crossing = isCrossing(marquee.s0, marquee.currentS);
  const x = Math.min(marquee.s0.x, marquee.currentS.x);
  const y = Math.min(marquee.s0.y, marquee.currentS.y);
  const w = Math.abs(marquee.currentS.x - marquee.s0.x);
  const h = Math.abs(marquee.currentS.y - marquee.s0.y);

  ctx.save();
  ctx.strokeStyle = crossing ? theme.marqueeCross : theme.marqueeWindow;
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = theme.strokeWidth;
  ctx.setLineDash(theme.dashMarquee);
  ctx.globalAlpha = theme.marqueeFillAlpha;
  ctx.fillRect(x, y, w, h);
  ctx.globalAlpha = 1;
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

export function drawSnapMarker(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  snap: Snap | null,
  view: CameraView,
): void {
  if (!snap) return;
  const s = w2s(snap.pos, view);
  ctx.save();
  ctx.strokeStyle = theme.snap;
  ctx.lineWidth = theme.strokeWidth;
  ctx.beginPath();
  ctx.moveTo(s.x - theme.snapArm, s.y);
  ctx.lineTo(s.x + theme.snapArm, s.y);
  ctx.moveTo(s.x, s.y - theme.snapArm);
  ctx.lineTo(s.x, s.y + theme.snapArm);
  ctx.stroke();
  ctx.restore();
}
