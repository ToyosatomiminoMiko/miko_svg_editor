/**
 * 图元与点的画布绘制：图元按几何基元描边，点图元画「外环 + 实心中心」，普通点画实心圆与选中环。
 * 选中/悬停/构造的样式优先级集中在这里，并与 selection.ts 的选中判定共用同一份语义：
 * 「看起来选中」与「能整体拖动」必须是同一个集合，所以点图元的选中态要跟随它拥有的点。
 */

import { TAU } from '../config';
import { w2s } from '../core/camera';
import type { CameraView } from '../core/camera';
import { getPoint, primitiveOf } from '../core/model';
import {
  isCommandEntity,
  isCommandPoint,
  isEntitySelected,
  isPointSelected,
} from '../core/selection';
import type { Entity } from '../core/entities';
import type { Point } from '../core/types';
import type { Theme } from './theme';
import { strokePrimitive } from './draw-primitives';

/**
 * 图元是否按选中态画。
 * 点图元额外看它的点是否被隐含选中：选中一条直线时，它的端点在界面上是选中态；
 * 若该端点同时被点图元拥有，点图元的高亮必须与点保持一致。
 */
export function isSelectedForRender(e: Entity): boolean {
  if (isEntitySelected(e.id) || isCommandEntity(e)) return true;
  const owned = e.ownedPointId;
  if (owned === null) return false;
  const p = getPoint(owned);
  return p !== undefined && (isPointSelected(p) || isCommandPoint(p));
}

export function drawEntity(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  e: Entity,
  selected: boolean,
  hovered: boolean,
  view: CameraView,
): void {
  ctx.lineWidth = selected
    ? theme.selectionWidth
    : hovered
      ? theme.strokeWidthHot
      : theme.strokeWidth;
  ctx.strokeStyle = selected
    ? theme.selection
    : hovered
      ? theme.hot
      : e.construction
        ? theme.construction
        : theme.geom;
  ctx.setLineDash(e.construction ? theme.dashConstruction : []);
  // 线帽/线接读主题：草图圆头，地图模式由 map-theme.ts 改成 butt 与底图 A6 一致
  ctx.lineCap = theme.lineCap;
  ctx.lineJoin = theme.lineJoin;

  // 图元已多态归一到基元：线段/圆弧走公共描边，点图元画外环 + 实心中心
  const prim = primitiveOf(e);
  if (prim?.kind === 'dot') {
    const S = w2s(prim.at, view);
    const p = e.ownedPointId === null ? undefined : getPoint(e.ownedPointId);
    // 固定点与其他点一致始终显示为红色（选中/悬停也不改色，靠线宽与选择环区分）
    if (p?.fixed) ctx.strokeStyle = theme.pointFixed;
    ctx.beginPath();
    ctx.arc(S.x, S.y, theme.pointGraphicRingRadius, 0, TAU);
    ctx.stroke();
    // 构造点只留外环（虚线外环），表达「不参与导出实体」的构造语义
    if (!e.construction) {
      ctx.beginPath();
      ctx.arc(S.x, S.y, theme.pointRadius, 0, TAU);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();
    }
  } else if (prim) {
    strokePrimitive(ctx, prim, view);
  }
  ctx.setLineDash([]);
}

export function drawPoint(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  p: Point,
  hovered: boolean,
  selected: boolean,
  view: CameraView,
): void {
  const s = w2s(p, view);
  const r = selected
    ? theme.pointSelectedRadius
    : hovered
      ? theme.pointRadiusHot
      : theme.pointRadius;
  ctx.beginPath();
  ctx.arc(s.x, s.y, r, 0, TAU);
  ctx.fillStyle = p.fixed
    ? theme.pointFixed
    : selected
      ? theme.selection
      : hovered
        ? theme.hot
        : theme.point;
  ctx.fill();
  if (selected) {
    ctx.beginPath();
    ctx.arc(s.x, s.y, r + theme.selectedRingExtra, 0, TAU);
    ctx.lineWidth = theme.hairlineWidth;
    ctx.strokeStyle = theme.selection;
    ctx.stroke();
  }
}
