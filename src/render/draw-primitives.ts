/**
 * 画布绘制原语：屏幕坐标的线段描边与实心箭头，以及世界坐标几何基元（线段 / 圆弧）按当前描边样式绘制。
 * 图元绘制与命令预览共用 strokePrimitive，同一份几何只有一种画法；
 * 颜色/线宽/虚线由调用方先设好，这里只负责路径，不读编辑状态。
 */

import { w2s } from '../core/camera';
import type { CameraView } from '../core/camera';
import type { PreviewShape } from '../core/operations';
import type { Vec } from '../core/types';
import type { Theme } from './theme';

/**
 * 用当前描边样式画一个几何基元（线段 / 圆弧）。
 * 图元绘制与命令预览共用这一份画法；点基元有自己的外环/中心样式，由 drawEntity 单独画。
 */
export function strokePrimitive(
  ctx: CanvasRenderingContext2D,
  prim: PreviewShape,
  view: CameraView,
): void {
  switch (prim.kind) {
    case 'segment': {
      const A = w2s(prim.a, view);
      const B = w2s(prim.b, view);
      ctx.beginPath();
      ctx.moveTo(A.x, A.y);
      ctx.lineTo(B.x, B.y);
      ctx.stroke();
      break;
    }
    case 'circular': {
      const C = w2s(prim.center, view);
      // 圆与圆弧共用同一段画法：整圆只是 sweep = TAU 的圆弧
      ctx.beginPath();
      ctx.arc(C.x, C.y, prim.radius * view.z, prim.start, prim.start + prim.sweep);
      ctx.stroke();
      break;
    }
  }
}

/** 屏幕坐标线段（尺寸标注用） */
export function lineScreen(ctx: CanvasRenderingContext2D, from: Vec, to: Vec): void {
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
}

/** 从箭尾指向箭尖画实心三角箭头（屏幕坐标）；dir 是单位向量 */
export function arrowScreen(ctx: CanvasRenderingContext2D, theme: Theme, tip: Vec, dir: Vec): void {
  const size = theme.arrowSize;
  const half = theme.arrowHalfWidth;
  // 底边中点在箭尖后退 size，底边沿 dir 的法向展开 ±half
  const bx = tip.x - dir.x * size;
  const by = tip.y - dir.y * size;
  const nx = -dir.y * half;
  const ny = dir.x * half;
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(bx + nx, by + ny);
  ctx.lineTo(bx - nx, by - ny);
  ctx.closePath();
  ctx.fillStyle = ctx.strokeStyle;
  ctx.fill();
}
