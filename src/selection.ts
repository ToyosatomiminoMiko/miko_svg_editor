/**
 * 选择语义：单击/Shift 加选/框选的方向与结果，以及选择集的派生查询。
 * 只写 state.selection（有序 SelectionItem 列表），不碰渲染与手势；
 * 框选方向判定 isCrossing() 是唯一定义，renderer 与 applyMarquee 共用它。
 *
 * 多选整体拖动的手势入口也在这里：单击一个「已在选择集里」的图元或点时，
 * clickSelect 返回的是整个选择集的拖拽点（selectionDragPoints），由 Editor 交给拖拽手势；
 * 单击未选中的对象则仍然只选它自己。这样「按住任一已选图元拖动全部已选」不需要
 * 在 Editor 里再判断一次选择语义。
 */

import { s2w } from './camera';
import { DRAG_THRESHOLD_PX } from './config';
import { assertNever, entityPointIds } from './entities';
import {
  computeSnap,
  entityCrossesRect,
  entityInsideRect,
  pickEntity,
  pickPoint,
  pointInRect,
  rectOf,
} from './geometry';
import { getEntity, getPoint, model, ownedPointIds } from './model';
import {
  addSelection,
  clearSelection,
  hasSelected,
  selectOnly,
  selectionCounts,
  setSelection,
  state,
  toggleSelected,
} from './state';
import type {
  Entity,
  Marquee,
  Point,
  Selection,
  SelectionEntry,
  SelectionItem,
  Vec,
} from './types';

/** 框选方向：由下往上拖（终点更高）= 交叉选择；由上往下 = 窗口选择 */
export const isCrossing = (s0: Vec, currentS: Vec): boolean => currentS.y < s0.y;

export interface ClickResult {
  hit: 'point' | 'entity' | 'empty';
  /** 单击命中后可作为拖拽起点的点：单点时是它自己，多选时是整个选择集的点 */
  dragPoints: Point[];
  /** 命中空白：是否开始框选（Shift 时为累加框选） */
  startMarquee: boolean;
}

/** 图元相关的点（直线两端点 / 圆心）；点被级联删除时过滤掉悬空 id */
const pointsOf = (e: Entity): Point[] =>
  entityPointIds(e)
    .map(getPoint)
    .filter((p): p is Point => p !== undefined);

/** 已选择列表里图元种类的中文名；新增图元种类时 switch 会编译报错 */
const entityLabel = (e: Entity): string => {
  switch (e.type) {
    case 'line':
      return '直线';
    case 'circle':
      return '圆';
    case 'arc':
      return '圆弧';
    case 'point':
      return '点';
    default:
      return assertNever(e);
  }
};

/** 某项是否被显式选中（图元端点属于「隐含选中」，见 isPointSelected） */
export const isEntitySelected = (id: number): boolean => hasSelected('ent', id);

/**
 * 点是否显示为选中态：显式选中的点，或选中图元的端点/圆心。
 * 渲染与单击判定共用这一条，保证「看起来选中」与「能整体拖动」是同一个集合。
 */
export function isPointSelected(p: Point): boolean {
  if (hasSelected('pt', p.id)) return true;
  for (const item of state.selection.items) {
    if (item.kind !== 'ent') continue;
    const e = getEntity(item.id);
    if (e && entityPointIds(e).includes(p.id)) return true;
  }
  return false;
}

/** 选择集里的图元 id（保持选中顺序） */
export const selectedEntityIds = (selection: Selection = state.selection): number[] =>
  selection.items.filter((item) => item.kind === 'ent').map((item) => item.id);

/** 选择集里的图元对象（跳过已删除的悬空 id） */
export const selectedEntities = (selection: Selection = state.selection): Entity[] =>
  selectedEntityIds(selection)
    .map(getEntity)
    .filter((e): e is Entity => e !== undefined);

/**
 * 选择集里显式选中的点（保持选中顺序）。
 * 「重合」约束以点为主，编辑器把它和 selectedEntities 一起交给约束动作；
 * 注意不含选中图元的端点/圆心——那些是隐含选中，只在渲染上高亮。
 */
export const selectedPoints = (selection: Selection = state.selection): Point[] =>
  selection.items
    .filter((item) => item.kind === 'pt')
    .map((item) => getPoint(item.id))
    .filter((p): p is Point => p !== undefined);

/**
 * 一次拖拽要移动的全部点：所有选中图元的端点/圆心 + 显式选中的点，按 id 去重。
 * 共享端点（两条线共用的顶点）只出现一次，避免同一帧被加上两倍位移。
 */
export function selectionDragPoints(): Point[] {
  const ids = new Set<number>();
  for (const item of state.selection.items) {
    if (item.kind === 'pt') {
      ids.add(item.id);
      continue;
    }
    const e = getEntity(item.id);
    if (e) for (const pid of entityPointIds(e)) ids.add(pid);
  }
  return [...ids].map(getPoint).filter((p): p is Point => p !== undefined);
}

/**
 * 指针按下（左键，选择工具）时的选择结果：
 * - 普通点击未选中的对象：只选中它，并给出它自己的拖拽点；
 * - 普通点击已选中的对象：保留整个选择集，给出整个选择集的拖拽点
 *   （这是多选整体拖动的入口；不能塌缩成单项，否则无法拖动全部已选）；
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
    if (isPointSelected(pt)) {
      return { hit: 'point', dragPoints: selectionDragPoints(), startMarquee: false };
    }
    selectOnly([{ kind: 'pt', id: pt.id }]);
    return { hit: 'point', dragPoints: [pt], startMarquee: false };
  }
  if (ent) {
    if (isEntitySelected(ent.id)) {
      return { hit: 'entity', dragPoints: selectionDragPoints(), startMarquee: false };
    }
    selectOnly([{ kind: 'ent', id: ent.id }]);
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
 * 结果按「先图元后点」的固定顺序进列表，保证同一框选每次得到的列表顺序一致。
 */
export function applyMarquee(marquee: Marquee): void {
  const rect = rectOf(s2w(marquee.s0), s2w(marquee.currentS));
  const crossing = isCrossing(marquee.s0, marquee.currentS);

  const items: SelectionItem[] = [];
  for (const e of model.ents.values()) {
    if (crossing ? entityCrossesRect(e, rect) : entityInsideRect(e, rect))
      items.push({ kind: 'ent', id: e.id });
  }
  // 点图元的点已经以 ent 身份入选项，这里跳过，避免同一个点出现两行
  const owned = ownedPointIds();
  for (const p of model.pts.values()) {
    if (owned.has(p.id)) continue;
    if (pointInRect(p, rect)) items.push({ kind: 'pt', id: p.id });
  }

  if (marquee.add) addSelection(items);
  else setSelection(items);
}

/**
 * 删除/清空模型后把已不存在的对象从选择集里摘掉。
 * 由 EditorControls.sync() 在每次重绘前调用：删除工具、清空等路径不经过选择逻辑，
 * 不清理的话已选择列表会残留「幽灵」条目，计数也会偏大。
 */
export function pruneSelection(): void {
  const items = state.selection.items.filter((item) =>
    item.kind === 'ent' ? getEntity(item.id) !== undefined : getPoint(item.id) !== undefined,
  );
  if (items.length !== state.selection.items.length) setSelection(items);
}

/**
 * 已选择列表的展示数据：按选择集顺序生成 label，UI 层不查模型。
 * 记录悬空 id 的项直接跳过（正常流程已被 pruneSelection 清掉，这里只做兜底）。
 */
export function selectionEntries(): SelectionEntry[] {
  const entries: SelectionEntry[] = [];
  for (const item of state.selection.items) {
    if (item.kind === 'ent') {
      const e = getEntity(item.id);
      if (e) entries.push({ kind: 'ent', id: e.id, label: `${entityLabel(e)} #${e.id}` });
    } else {
      const p = getPoint(item.id);
      if (p) entries.push({ kind: 'pt', id: p.id, label: `点 #${p.id}` });
    }
  }
  return entries;
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
