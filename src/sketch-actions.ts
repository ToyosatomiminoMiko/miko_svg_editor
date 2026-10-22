/**
 * 草图领域操作：画点/线/圆/弧/矩形、加约束、删除、固定、构造、尺寸创建，以及拖拽求解。
 * 纯逻辑层：只依赖 model/solver/config/geometry/dimensions/entities，不读写交互状态——
 * 「点击如何填参数槽位」由 operations.ts 的统一命令会话负责，这里只提供可被操作表调用的原子动作。
 * 所有求解统一走 solve()，它消费 SolveResult 并把用户可感知的失败翻译成提示（BUG-5）。
 */

import {
  ARC_ENDPOINT_RADII_REL_TOL,
  AUTO_AXIS_RATIO,
  DIM_DEFAULT_OFFSET_PX,
  ITER_CONSTRAINT,
  ITER_DRAG,
  ITER_EDIT,
  ITER_FULL,
  ITER_INCREMENTAL,
  MIN_DIM_DISTANCE,
  MIN_DRAW_LENGTH,
  MIN_RADIUS,
  MIN_RECT_EDGE,
  SOLVE_WARN_EPS,
  type ResolvedConstraint,
} from './config';
import {
  isDimConstraint,
  findDimForEntity,
  findDistanceDim,
  setDimValue,
  type DimConstraint,
} from './dimensions';
import { entityDimTarget, entityPointIds, isCurveEntity } from './entities';
import {
  addArc,
  addCircle,
  addCon,
  addLine,
  addPointEntity,
  addPt,
  curveRadius,
  discardPoint,
  findConstraint,
  getEntity,
  getPoint,
  pointAt,
  pointEntityOf,
  removeConstraint,
  removeEntity,
  removePoint,
} from './model';
import { solveSketch } from './solver';
import type { Entity, Point, Selection, Vec } from './types';
import { vec } from './vec';

/* ======================= 结果与提示 ======================= */

/** 面向用户的一条提示；kind 决定去处（error 进消息区 / info 状态栏闪示） */
export interface Notice {
  kind: 'info' | 'error';
  message: string;
}

/** 领域操作结果：失败带原因（由 Editor 统一 notify），成功可携带求解提示 */
export type ActionResult = { ok: true; notices: Notice[] } | { ok: false; reason: string };

export const actionOk = (notices: Notice[] = []): ActionResult => ({ ok: true, notices });
export const actionFail = (reason: string): ActionResult => ({ ok: false, reason });

/**
 * 统一求解入口：消费 SolveResult。
 * - invalidConstraints 非空 = 有约束引用了已删除/无效对象，求解器跳过了它们；
 * - residual > SOLVE_WARN_EPS = 约束没被完全满足（冲突或欠约束导致的数值失败）；
 * - 拖拽时传 silent：每帧求解，失败提示会刷屏。
 */
export function solve(
  maxIter: number,
  options: { exclude?: ReadonlySet<number>; silent?: boolean } = {},
): Notice[] {
  const result = solveSketch(maxIter, options.exclude);
  if (options.silent) return [];
  const notices: Notice[] = [];
  if (result.invalidConstraints.length > 0) {
    notices.push({
      kind: 'error',
      message: `有 ${result.invalidConstraints.length} 条约束引用了不存在的对象，已跳过`,
    });
  }
  if (result.residual > SOLVE_WARN_EPS) {
    notices.push({ kind: 'error', message: '约束未完全满足' });
  }
  return notices;
}

/* ======================= 点图元 ======================= */

/**
 * 在已有点上放点图元（点工具的原子动作）：一个点最多一个点图元。
 * created 表示这个点是本次命令会话顺手新建的：新建时无需提示，
 * 复用已有点（线段端点/圆心/普通点）时提示它被「提升」为独立点。
 */
export function placePointEntity(p: Point, created: boolean): ActionResult {
  if (pointEntityOf(p.id)) {
    return actionOk([{ kind: 'info', message: '这里已经有一个点' }]);
  }
  addPointEntity(p);
  return actionOk(created ? [] : [{ kind: 'info', message: '已把现有点提升为独立点' }]);
}

/* ======================= 绘图 ======================= */

/** 画直线；autoConstrain 时近水平/近竖直自动补约束 */
export function createLine(a: Point, b: Point, autoConstrain = true): ActionResult {
  if (vec.dist(a, b) < MIN_DRAW_LENGTH) return actionFail('两点重合，未创建直线');
  const line = addLine(a, b);
  if (autoConstrain) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (Math.abs(dy) < Math.abs(dx) * AUTO_AXIS_RATIO) addCon('horizontal', { e: line.id });
    else if (Math.abs(dx) < Math.abs(dy) * AUTO_AXIS_RATIO) addCon('vertical', { e: line.id });
  }
  return actionOk(solve(ITER_INCREMENTAL));
}

export function createCircle(center: Point, r: number): ActionResult {
  if (r < MIN_RADIUS) return actionFail('半径太小，未创建圆');
  addCircle(center, r);
  return actionOk(solve(ITER_INCREMENTAL));
}

/** 把点沿「圆心 → 点」的方向放到指定半径上（只改半径、不改角度）；与圆心重合时按 0 角放置 */
function placeOnCircle(p: Point, center: Point, r: number): void {
  const d = vec.dist(center, p);
  const ang = d < MIN_DRAW_LENGTH ? 0 : Math.atan2(p.y - center.y, p.x - center.x);
  p.x = center.x + r * Math.cos(ang);
  p.y = center.y + r * Math.sin(ang);
}

/**
 * 画圆弧：圆心 + 起点 + 终点，半径 = |起点 - 圆心|。
 * 三个点都是模型里的真实点：起点/终点可以是本次点击新建的，也可以复用吸附到的已有点
 * （复用即共享同一个 Point，圆弧直接接上既有几何，无需再加重合约束）。
 *
 * 端点共圆是圆弧的结构不变量，创建时就把几何落成合法状态，避免求解器去「猜」改哪个点：
 * - 起点新建、终点是已有点：以终点定半径，把起点挪到圆上（接上既有终点）；
 * - 终点新建：把终点按起点半径投到圆上（终点只决定终止角，与旧语义一致）；
 * - 两端都是已有点：半径必须一致，否则说明两点本来不共圆，报错而不是静默改既有几何。
 * 起终点重合按整圆处理（sweepOf 语义），并复用起点，避免留一个重合的临时点。
 */
export function createArc(
  center: Point,
  start: Point,
  end: Point,
  created: ReadonlySet<number>,
): ActionResult {
  const rStart = vec.dist(center, start);
  const rEnd = vec.dist(center, end);
  const startIsNew = created.has(start.id);
  const endIsNew = created.has(end.id);

  if (!endIsNew && startIsNew) {
    if (rEnd < MIN_RADIUS) return actionFail('终点离圆心太近，未创建圆弧');
    placeOnCircle(start, center, rEnd);
  } else if (endIsNew) {
    if (rStart < MIN_RADIUS) return actionFail('半径太小，未创建圆弧');
    placeOnCircle(end, center, rStart);
  } else {
    const tol = Math.max(MIN_DRAW_LENGTH, Math.max(rStart, rEnd) * ARC_ENDPOINT_RADII_REL_TOL);
    if (Math.abs(rStart - rEnd) > tol) {
      return actionFail('终点不在圆上：起点与终点到圆心的距离不同，未创建圆弧');
    }
  }

  if (vec.dist(center, start) < MIN_RADIUS) return actionFail('半径太小，未创建圆弧');
  if (vec.dist(start, end) < MIN_DRAW_LENGTH && endIsNew && end.id !== start.id) {
    // 整圆：终点是本次新建的另一个点且与起点重合 → 丢掉它，两端复用起点
    discardPoint(end);
    addArc(center, start, start);
  } else {
    // 也包括 end 就是 start（终点槽位直接复用起点）：a0 === a1 → 整圆
    addArc(center, start, end);
  }
  return actionOk(solve(ITER_INCREMENTAL));
}

/**
 * 矩形：四个角优先复用已有几何点（BUG-7，用 model.pointAt），再连四条边并自动补水平/竖直约束。
 * 首角来自第一次点击的吸附位置，末角来自第二次点击，二者在 pointAt 容差内时会复用到同一点。
 */
export function createRect(a: Vec, b: Vec): ActionResult {
  if (Math.abs(b.x - a.x) < MIN_RECT_EDGE || Math.abs(b.y - a.y) < MIN_RECT_EDGE) {
    return actionFail('矩形太小，未创建');
  }
  const corner = (x: number, y: number): Point => pointAt(x, y) ?? addPt(x, y);
  const q = [corner(a.x, a.y), corner(b.x, a.y), corner(b.x, b.y), corner(a.x, b.y)];
  // q 固定 4 个角点，i 与 (i+1)%4 都在 [0,4) 内；断言只为满足 noUncheckedIndexedAccess
  for (let i = 0; i < 4; i++) {
    const line = addLine(q[i]!, q[(i + 1) % 4]!);
    addCon(i % 2 === 0 ? 'horizontal' : 'vertical', { e: line.id });
  }
  return actionOk(solve(ITER_INCREMENTAL));
}

/* ======================= 选择集操作 ======================= */

/**
 * 批量添加约束（操作表的统一出口）：
 * 按「种类 + 引用字段」去重（BUG-3），重复的跳过并在状态栏提示，全部重复则失败。
 */
export function addConstraints(items: readonly ResolvedConstraint[]): ActionResult {
  let added = 0;
  let skipped = 0;
  for (const item of items) {
    if (findConstraint(item.kind, item.props)) {
      skipped++;
      continue;
    }
    addCon(item.kind, item.props);
    added++;
  }
  if (added === 0) {
    return actionFail(skipped > 0 ? '相同约束已存在' : '没有可添加的约束');
  }

  const notices = solve(ITER_CONSTRAINT);
  if (skipped > 0) notices.unshift({ kind: 'info', message: `已跳过 ${skipped} 个重复约束` });
  return actionOk(notices);
}

/** 删除选中对象；删除的级联（引用约束 / 孤立点）由 model 负责（BUG-4） */
export function deleteSelected(selection: Selection): ActionResult {
  let removed = 0;
  for (const item of selection.items) {
    if (item.kind === 'ent') {
      const e = getEntity(item.id);
      if (e) {
        removeEntity(e);
        removed++;
      }
    } else {
      const p = getPoint(item.id);
      if (p) {
        removePoint(p);
        removed++;
      }
    }
  }
  if (removed === 0) return actionOk();
  return actionOk(solve(ITER_INCREMENTAL));
}

/** 固定/解锁：部分锁定 → 全锁，全锁 → 全解锁；图元取其全部端点/圆心 */
export function toggleFixed(selection: Selection): ActionResult {
  const ids = new Set<number>();
  for (const item of selection.items) {
    if (item.kind === 'pt') {
      ids.add(item.id);
      continue;
    }
    const e = getEntity(item.id);
    if (e) for (const pid of entityPointIds(e)) ids.add(pid);
  }
  const pts = [...ids].map(getPoint).filter((p): p is Point => p !== undefined);
  if (pts.length === 0) return actionFail('先选中图形或点');
  const toFix = !pts.every((p) => p.fixed);
  for (const p of pts) p.fixed = toFix;
  return actionOk(solve(ITER_FULL));
}

/** 构造线切换：选中的图元里只要还有普通图元就全部转为构造线，否则全部转回普通 */
export function toggleConstruction(selection: Selection): ActionResult {
  const ents = selection.items
    .filter((item) => item.kind === 'ent')
    .map((item) => getEntity(item.id))
    .filter((e): e is Entity => e !== undefined);
  if (ents.length === 0) return actionFail('先选中图元');
  const toConstruction = !ents.every((e) => e.construction);
  for (const e of ents) e.construction = toConstruction;
  return actionOk();
}

/* ======================= 尺寸 ======================= */

/** 尺寸创建/编辑会话结果：con 已写入模型 */
export type DimResult =
  | { ok: true; con: DimConstraint; created: boolean; pointId?: number; notices: Notice[] }
  | { ok: false; reason: string };

/** 尺寸工具点中图元：已有尺寸则返回编辑会话，否则按图元种类建半径或长度尺寸 */
export function dimForEntity(e: Entity, zoom: number): DimResult {
  const existing = findDimForEntity(e);
  if (existing) return { ok: true, con: existing, created: false, notices: [] };

  const target = entityDimTarget(e);
  // 点图元没有独立尺寸：它只作为两点距离的一端（入口在 operations.ts 的 dim 操作）
  if (!target) return { ok: false, reason: '该图元不能标注尺寸' };
  if (target.kind === 'radius') {
    const ent = getEntity(target.e);
    if (!isCurveEntity(ent)) return { ok: false, reason: '该图元不能标注半径' };
    const con = addCon('radius', { e: ent.id, radius: curveRadius(ent) });
    if (!isDimConstraint(con)) return { ok: false, reason: '尺寸创建失败' };
    return { ok: true, con, created: true, notices: solve(ITER_CONSTRAINT) };
  }

  const a = getPoint(target.a);
  const b = getPoint(target.b);
  if (!a || !b) return { ok: false, reason: '直线端点缺失' };
  const d = vec.dist(a, b);
  if (d < MIN_DIM_DISTANCE) return { ok: false, reason: '长度太小，无法标注' };
  // offset 是世界偏移：创建时把屏幕像素参考值按当前缩放换算一次，之后缩放不再改（BUG-8）
  const con = addCon('distancePointPoint', {
    a: target.a,
    b: target.b,
    distance: d,
    offset: DIM_DEFAULT_OFFSET_PX / zoom,
  });
  if (!isDimConstraint(con)) return { ok: false, reason: '尺寸创建失败' };
  return { ok: true, con, created: true, notices: solve(ITER_CONSTRAINT) };
}

/**
 * 两点尺寸：已有则返回编辑会话；offset 取点击位置相对连线法线的投影（世界单位）。
 * bCreated 表示第二点是这次操作新建的：取消编辑时它要跟着尺寸一起删。
 */
export function dimForPoints(a: Point, b: Point, w: Vec, bCreated: boolean): DimResult {
  const existing = findDistanceDim(a.id, b.id);
  if (existing) return { ok: true, con: existing, created: false, notices: [] };
  const d = vec.dist(a, b);
  if (d < MIN_DIM_DISTANCE) return { ok: false, reason: '两点距离太小，无法标注' };
  const offset = vec.dot(vec.sub(w, a), vec.unitPerp(vec.sub(b, a)));
  const con = addCon('distancePointPoint', { a: a.id, b: b.id, distance: d, offset });
  if (!isDimConstraint(con)) return { ok: false, reason: '尺寸创建失败' };
  return {
    ok: true,
    con,
    created: true,
    pointId: bCreated ? b.id : undefined,
    notices: solve(ITER_CONSTRAINT),
  };
}

/** 提交尺寸编辑：只改目标值再求解（编辑场景用 ITER_EDIT） */
export function commitDim(con: DimConstraint, value: number): ActionResult {
  setDimValue(con, value);
  return actionOk(solve(ITER_EDIT));
}

/** 撤销刚创建的尺寸（输入框 Esc）：删约束，并把创建时顺手建的点一起级联删掉 */
export function rollbackDim(con: DimConstraint, pointId?: number): ActionResult {
  removeConstraint(con);
  if (pointId !== undefined) {
    const p = getPoint(pointId);
    if (p) removePoint(p);
  }
  return actionOk(solve(ITER_INCREMENTAL));
}

/* ======================= 拖拽 ======================= */

/** 拖拽手势：被拖点、按下时的坐标快照、本次求解要排除的点（不写进模型） */
export interface DragGesture {
  startW: Vec;
  items: { p: Point; ox: number; oy: number }[];
  exclude: Set<number>;
}

/** 拖拽每帧：按光标位移平移被拖点并静默求解（ITER_DRAG，失败不刷屏） */
export function moveDrag(gesture: DragGesture, cursor: Vec): void {
  const dx = cursor.x - gesture.startW.x;
  const dy = cursor.y - gesture.startW.y;
  for (const item of gesture.items) {
    item.p.x = item.ox + dx;
    item.p.y = item.oy + dy;
  }
  solve(ITER_DRAG, { exclude: gesture.exclude, silent: true });
}
