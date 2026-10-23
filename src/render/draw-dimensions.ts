/**
 * 尺寸标注绘制：把 dimensions.dimLayout 产出的屏幕布局原语（界线 / 尺寸线 / 圆弧 / 箭头 / 文字）画到画布上。
 * 正式标注与命令落位预览共用 drawDimLayout，悬停只换颜色；
 * 布局是纯函数，绘制与命中/拖拽因此共用同一份「看到什么就能点/拖什么」。
 */

import { dimLayout } from '../core/dimensions';
import type { CameraView } from '../core/camera';
import type { DimLayout, DimTextLayout } from '../core/dimensions';
import type { Constraint } from '../core/types';
import type { Theme } from './theme';
import { arrowScreen, lineScreen } from './draw-primitives';

/**
 * 尺寸标注：绘制原语全部是屏幕坐标，绘制/命中/拖拽共用 dimensions.dimLayout 这一份布局。
 * 悬停中的尺寸用选中色；正式标注与落位预览共用 drawDimLayout。
 */
export function drawDim(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  c: Constraint,
  view: CameraView,
  hovered: boolean,
): void {
  const layout = dimLayout(c, view);
  if (!layout) return;
  drawDimLayout(ctx, theme, layout, hovered ? theme.selection : theme.dim);
}

/** 用指定颜色画一份尺寸布局；save/restore 保证描边、虚线、字体不会泄漏到后续绘制 */
export function drawDimLayout(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  layout: DimLayout,
  color: string,
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = theme.hairlineWidth;
  ctx.lineCap = 'butt';

  for (const seg of layout.segments) {
    ctx.setLineDash(seg.extension ? theme.dashDim : []);
    lineScreen(ctx, seg.a, seg.b);
  }
  ctx.setLineDash([]);

  for (const arc of layout.arcs) {
    ctx.beginPath();
    // sweep 有符号：<0 时 canvas 从 start 逆着画到 start+sweep（counterclockwise = true）
    ctx.arc(
      arc.center.x,
      arc.center.y,
      arc.radius,
      arc.start,
      arc.start + arc.sweep,
      arc.sweep < 0,
    );
    ctx.stroke();
  }

  for (const arrow of layout.arrows) arrowScreen(ctx, theme, arrow.tip, arrow.dir);

  drawDimText(ctx, theme, layout.text);
  ctx.restore();
}

export function drawDimText(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  text: DimTextLayout,
): void {
  ctx.font = theme.dimFont;
  ctx.textAlign = text.align;
  ctx.textBaseline = text.baseline;
  ctx.fillStyle = ctx.strokeStyle;
  ctx.fillText(text.text, text.pos.x, text.pos.y);
}
