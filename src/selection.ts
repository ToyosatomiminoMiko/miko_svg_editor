/**
 * 选择语义：单击/Shift 加选/框选的方向与结果。
 * 只写 state.selection（图元 id 与点 id 分开存），不碰渲染与手势；
 * 框选方向判定 isCrossing() 是唯一定义，renderer 与 applyMarquee 共用它。
 */

import { s2w } from './camera';
import { DRAG_THRESHOLD_PX } from './config';
import { entityPointIds } from './entities';
import {
  computeSnap,
  entityCrossesRect,
  entityInsideRect,
  pickEntity,
  pickPoint,
  pointInRect,
  rectOf,
} from './geometry';
import { getPoint, model } from './model';
import {
  addSelection,
  clearSelection,
  selectOnly,
  selectionCounts,
  setSelection,
  state,
  toggleSelected,
} from './state';
import type { Entity, Marquee, Point, Selection, Vec } from './types';

/** 框选方向：由下往上拖（终点更高）= 交叉选择；由上往下 = 窗口选择 */
export const isCrossing = (s0: Vec, currentS: Vec): boolean => currentS.y < s0.y;

export interface ClickResult {
  hit: 'point' | 'entity' | 'empty';
  /** 单击命中后可作为拖拽起点的点：点本身，或图元的所有端点 */
  dragPoints: Point[];
  /** 命中空白：是否开始框选（Shift 时为累加框选） */
  startMarquee: boolean;
}

/** 图元相关的点（直线两端点 / 圆心）；点被级联删除时过滤掉悬空 id */
const pointsOf = (e: Entity): Point[] =>
  entityPointIds(e)
    .map(getPoint)
    .filter((p): p is Point => p !== undefined);

/**
 * 指针按下（左键，选择工具）时的选择结果：
 * - 普通点击：只选中命中的对象（点优先于图元），并给出拖拽点；
 * - Shift 点击：在已有选择里切换该对象，不触发拖拽；
 * - 空白：清空选择（Shift 时保留），交给调用方开始框选。
 */
export function clickSelect(w: Vec, zoom: number, shift: boolean): ClickResult {
  const pt = pickPoint(w, zoom);
  const ent = pt ? null : pickEntity(w, zoom);

  if (shift) {
    if (pt) toggleSelected('pt', pt.id);
    else if (ent) toggleSelected('ent', ent.id);
    return {
      hit: pt ? 'point' : ent ? 'entity' : 'empty',
      dragPoints: [],
      startMarquee: !pt && !ent,
    };
  }
  if (pt) {
    selectOnly([], [pt.id]);
    return { hit: 'point', dragPoints: [pt], startMarquee: false };
  }
  if (ent) {
    selectOnly([ent.id], []);
    return { hit: 'entity', dragPoints: pointsOf(ent), startMarquee: false };
  }
  // 空白处按下先清空；松手时没拖动就等价于「点击空白清空选择」
  clearSelection();
  return { hit: 'empty', dragPoints: [], startMarquee: true };
}

/**
 * 框选结算：把一次框选手势（显式参数）换算成世界矩形并写入 state.selection。
 * 职责划分：框选进行中的 live 状态在 state.marquee（由 Editor/updateMarquee 维护），
 * 结算时由调用方把捕获的手势传进来——不要在这里再读 state.marquee，
 * 否则调用方先清空 state 再结算就会静默失效。
 * 交叉选择看「图元与矩形有任何重叠」，窗口选择要求图元完全在框内；点只看是否在框内。
 */
export function applyMarquee(marquee: Marquee): void {
  const rect = rectOf(s2w(marquee.s0), s2w(marquee.currentS));
  const crossing = isCrossing(marquee.s0, marquee.currentS);

  const ents: number[] = [];
  for (const e of model.ents.values()) {
    if (crossing ? entityCrossesRect(e, rect) : entityInsideRect(e, rect)) ents.push(e.id);
  }
  const pts: number[] = [];
  for (const p of model.pts.values()) {
    if (pointInRect(p, rect)) pts.push(p.id);
  }

  const found: Selection = { ents, pts };
  if (marquee.add) addSelection(found);
  else setSelection(found);
}

/** 指针移动时的悬停/吸附刷新；拖拽/平移期间不调用（标记由 clearHover 提前清掉，BUG-11） */
export function updateHover(w: Vec, zoom: number): void {
  state.snap = state.snapEnabled ? computeSnap(w, zoom) : null;
  state.hoverPt = pickPoint(w, zoom);
  state.hoverEnt = state.hoverPt ? null : pickEntity(w, zoom);
}

/** 手势开始时清空悬停/吸附标记，避免旧位置的高亮残留 */
export function clearHover(): void {
  state.snap = null;
  state.hoverPt = null;
  state.hoverEnt = null;
}

/** 框选每帧更新终点与 active 阈值；世界矩形只在 applyMarquee 结算时换算一次 */
export function updateMarquee(sp: Vec): void {
  const marquee = state.marquee;
  if (!marquee) return;
  marquee.currentS = { x: sp.x, y: sp.y };
  const moved = Math.hypot(sp.x - marquee.s0.x, sp.y - marquee.s0.y);
  if (!marquee.active && moved > DRAG_THRESHOLD_PX) marquee.active = true;
}

/** 底部提示里的选中数量文案；没有选择时返回空串 */
export function selectionSummary(): string {
  const { ents, pts } = selectionCounts();
  if (ents > 0 && pts > 0) return `已选 ${ents} 图元 + ${pts} 点`;
  if (ents > 0) return `已选 ${ents} 个图元`;
  if (pts > 0) return `已选 ${pts} 个点`;
  return '';
}
