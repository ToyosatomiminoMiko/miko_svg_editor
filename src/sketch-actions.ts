/**
 * 草图领域操作：画线/圆/弧/矩形、加约束、删除、固定、构造线、尺寸创建，以及点击状态机。
 * 纯逻辑层：只依赖 model/solver/config/geometry/dimensions/entities，不实际读写全局 state——
 * 点击状态机把「下一个 pending」作为结果返回，由 Editor 写回 state；
 * 所有求解统一走 solve()，它消费 SolveResult 并把用户可感知的失败翻译成提示（BUG-5）。
 */

import type { CameraView } from './camera';
import {
  AUTO_AXIS_RATIO,
  CONSTRAINT_ACTIONS,
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
  type ConstraintAction,
} from './config';
import {
  isDimConstraint,
  findDimForEntity,
  findDistanceDim,
  pickDim,
  setDimValue,
  type DimConstraint,
} from './dimensions';
import { entityDimTarget, entityPointIds } from './entities';
import { pickEntity, pickPoint } from './geometry';
import {
  addArc,
  addCircle,
  addCon,
  addLine,
  addPt,
  findConstraint,
  getEntity,
  getPoint,
  pointAt,
  removeConstraint,
  removeEntity,
  removePoint,
} from './model';
import { solveSketch } from './solver';
import type { Entity, MeasureText, Pending, Point, Selection, Snap, ToolId, Vec } from './types';
import { vec } from './vec';

/* ======================= 结果与提示 ======================= */

/** 面向用户的一条提示；kind 决定 toast 样式 */
export interface Notice {
  kind: 'info' | 'error';
  message: string;
}

/** 领域操作结果：失败带原因（由 Editor 统一 notify），成功可携带求解提示 */
export type ActionResult = { ok: true; notices: Notice[] } | { ok: false; reason: string };

const ok = (notices: Notice[] = []): ActionResult => ({ ok: true, notices });
const fail = (reason: string): ActionResult => ({ ok: false, reason });

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

/* ======================= 点 ======================= */

/** 取点：吸附到已有点时直接复用，否则在吸附位置（无吸附则指针位置）新建 */
export function acquirePoint(w: Vec, snap: Snap | null): Point {
  if (snap?.pt) return snap.pt;
  const p = snap ? snap.pos : w;
  return addPt(p.x, p.y);
}

/** 本次取点是否新建了模型点（吸附到已有点时为 false，取消时不能删它） */
const isFreshPoint = (snap: Snap | null): boolean => !snap?.pt;

/**
 * 取消未完成操作时调用：删掉这次点击新建、但还没并入图元的孤立点。
 * 已并入图元的点由 removePoint 的级联负责，不会出现在 pending.newPt 里。
 */
export function cancelPending(pending: Pending): void {
  if (!('newPt' in pending)) return;
  const id = pending.newPt;
  if (id === undefined) return;
  const p = getPoint(id);
  if (p) removePoint(p);
}

/* ======================= 绘图 ======================= */

/** 画直线；autoConstrain 时近水平/近竖直自动补约束 */
export function createLine(a: Point, b: Point, autoConstrain = true): ActionResult {
  if (vec.dist(a, b) < MIN_DRAW_LENGTH) return fail('两点重合，未创建直线');
  const line = addLine(a, b);
  if (autoConstrain) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (Math.abs(dy) < Math.abs(dx) * AUTO_AXIS_RATIO) addCon('horizontal', { e: line.id });
    else if (Math.abs(dx) < Math.abs(dy) * AUTO_AXIS_RATIO) addCon('vertical', { e: line.id });
  }
  return ok(solve(ITER_INCREMENTAL));
}

export function createCircle(center: Point, r: number): ActionResult {
  if (r < MIN_RADIUS) return fail('半径太小，未创建圆');
  addCircle(center, r);
  return ok(solve(ITER_INCREMENTAL));
}

/** 画圆弧：a0/a1 原样存，整圆语义由 config/angle.sweepOf 统一（第三击同角 = 整圆） */
export function createArc(center: Point, r: number, a0: number, a1: number): ActionResult {
  if (r < MIN_RADIUS) return fail('半径太小，未创建圆弧');
  addArc(center, r, a0, a1);
  return ok(solve(ITER_INCREMENTAL));
}

/**
 * 矩形：四个角优先复用已有几何点（BUG-7，用 model.pointAt），再连四条边并自动补水平/竖直约束。
 * 首角来自第一次点击的吸附位置，末角来自第二次点击，二者在 pointAt 容差内时会复用到同一点。
 */
export function createRect(a: Vec, b: Vec): ActionResult {
  if (Math.abs(b.x - a.x) < MIN_RECT_EDGE || Math.abs(b.y - a.y) < MIN_RECT_EDGE) {
    return fail('矩形太小，未创建');
  }
  const corner = (x: number, y: number): Point => pointAt(x, y) ?? addPt(x, y);
  const q = [corner(a.x, a.y), corner(b.x, a.y), corner(b.x, b.y), corner(a.x, b.y)];
  // q 固定 4 个角点，i 与 (i+1)%4 都在 [0,4) 内；断言只为满足 noUncheckedIndexedAccess
  for (let i = 0; i < 4; i++) {
    const line = addLine(q[i]!, q[(i + 1) % 4]!);
    addCon(i % 2 === 0 ? 'horizontal' : 'vertical', { e: line.id });
  }
  return ok(solve(ITER_INCREMENTAL));
}

/* ======================= 选择集操作 ======================= */

/** 约束按钮：查 CONSTRAINT_ACTIONS 的 resolve 做适用校验，按引用去重后添加（BUG-3） */
export function applyConstraint(
  action: ConstraintAction,
  selected: readonly Entity[],
): ActionResult {
  const meta = CONSTRAINT_ACTIONS.find((m) => m.id === action);
  if (!meta) return fail('未知的约束操作');
  const resolution = meta.resolve(selected);
  if (!resolution.ok) return fail(resolution.reason);

  let added = 0;
  let skipped = 0;
  for (const item of resolution.items) {
    if (findConstraint(item.kind, item.props)) {
      skipped++;
      continue;
    }
    addCon(item.kind, item.props);
    added++;
  }
  if (added === 0) return fail(skipped > 0 ? '相同约束已存在' : '没有可添加的约束');

  const notices = solve(ITER_CONSTRAINT);
  if (skipped > 0) notices.unshift({ kind: 'info', message: `已跳过 ${skipped} 个重复约束` });
  return ok(notices);
}

/** 删除选中对象；删除的级联（引用约束 / 孤立点）由 model 负责（BUG-4） */
export function deleteSelected(selection: Selection): ActionResult {
  let removed = 0;
  for (const id of selection.ents) {
    const e = getEntity(id);
    if (e) {
      removeEntity(e);
      removed++;
    }
  }
  for (const id of selection.pts) {
    const p = getPoint(id);
    if (p) {
      removePoint(p);
      removed++;
    }
  }
  if (removed === 0) return ok();
  return ok(solve(ITER_INCREMENTAL));
}

/** 固定/解锁：部分锁定 → 全锁，全锁 → 全解锁；图元取其全部端点/圆心 */
export function toggleFixed(selection: Selection): ActionResult {
  const ids = new Set<number>();
  for (const id of selection.ents) {
    const e = getEntity(id);
    if (e) for (const pid of entityPointIds(e)) ids.add(pid);
  }
  for (const id of selection.pts) ids.add(id);
  const pts = [...ids].map(getPoint).filter((p): p is Point => p !== undefined);
  if (pts.length === 0) return fail('先选中图形或点');
  const toFix = !pts.every((p) => p.fixed);
  for (const p of pts) p.fixed = toFix;
  return ok(solve(ITER_FULL));
}

/** 构造线切换：选中的图元里只要还有普通图元就全部转为构造线，否则全部转回普通 */
export function toggleConstruction(selection: Selection): ActionResult {
  const ents = selection.ents.map(getEntity).filter((e): e is Entity => e !== undefined);
  if (ents.length === 0) return fail('先选中图元');
  const toConstruction = !ents.every((e) => e.construction);
  for (const e of ents) e.construction = toConstruction;
  return ok();
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
  if (target.kind === 'radius') {
    const ent = getEntity(target.e);
    if (!ent || ent.type === 'line') return { ok: false, reason: '该图元不能标注半径' };
    const con = addCon('radius', { e: ent.id, radius: ent.r });
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
 * bCreated 表示第二点是这次点击新建的：取消编辑时它要跟着尺寸一起删。
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
  return ok(solve(ITER_EDIT));
}

/** 撤销刚创建的尺寸（输入框 Esc）：删约束，并把创建时顺手建的点一起级联删掉 */
export function rollbackDim(con: DimConstraint, pointId?: number): ActionResult {
  removeConstraint(con);
  if (pointId !== undefined) {
    const p = getPoint(pointId);
    if (p) removePoint(p);
  }
  return ok(solve(ITER_INCREMENTAL));
}

/* ======================= 点击状态机 ======================= */

/** 一次点击后的状态转移结果；pending 由 Editor 写回 state，action/dim 由 Editor 消费 */
export interface ClickOutcome {
  pending: Pending | null;
  /** 有模型变更：Editor 统一提示结果并同步画面 */
  action?: ActionResult;
  /** 需要打开尺寸输入框（新建或点中已有尺寸） */
  dim?: DimResult;
}

/** 吸附位置优先于原始指针位置：绘制/尺寸都落在吸附点上 */
const snapPos = (w: Vec, snap: Snap | null): Vec => (snap ? snap.pos : w);

const freshId = (snap: Snap | null, p: Point): number | undefined =>
  isFreshPoint(snap) ? p.id : undefined;

/** 直线：首击落起点，次击落终点并继续以终点为下一段起点（连续绘制） */
function lineStep(pending: Pending | null, w: Vec, snap: Snap | null): ClickOutcome {
  const pos = snapPos(w, snap);
  if (pending?.type === 'line') {
    if (vec.dist(pending.start, pos) < MIN_DRAW_LENGTH) return { pending };
    const b = acquirePoint(w, snap);
    return {
      // b 已并入新线段，不能标成 newPt：否则 Esc 结束连续绘制时会把线段端点当孤立点删掉，
      // 级联删除会连整条线段一起消失（newPt 只用于「还没并入图元」的点）。
      pending: { type: 'line', start: { x: b.x, y: b.y }, startPt: b },
      action: createLine(pending.startPt, b),
    };
  }
  const a = acquirePoint(w, snap);
  return {
    pending: { type: 'line', start: { x: a.x, y: a.y }, startPt: a, newPt: freshId(snap, a) },
  };
}

/** 圆：首击圆心，次击半径；半径退化时撤销这次新建的圆心 */
function circleStep(pending: Pending | null, w: Vec, snap: Snap | null): ClickOutcome {
  if (pending?.type === 'circle') {
    const center = getPoint(pending.center);
    if (!center) {
      cancelPending(pending);
      return { pending: null };
    }
    const r = vec.dist(center, snapPos(w, snap));
    if (r < MIN_RADIUS) {
      cancelPending(pending);
      return { pending: null, action: fail('半径太小，未创建圆') };
    }
    return { pending: null, action: createCircle(center, r) };
  }
  const center = acquirePoint(w, snap);
  return {
    pending: { type: 'circle', center: center.id, newPt: freshId(snap, center) },
  };
}

/** 圆弧：圆心 → 起点（定半径与 a0）→ 终点（a1）；第三击与起点同角即整圆 */
function arcStep(pending: Pending | null, w: Vec, snap: Snap | null): ClickOutcome {
  if (!pending || pending.type !== 'arc') {
    const center = acquirePoint(w, snap);
    return {
      pending: {
        type: 'arc',
        c: center.id,
        stage: 1,
        newPt: freshId(snap, center),
      },
    };
  }
  const center = getPoint(pending.c);
  if (!center) {
    cancelPending(pending);
    return { pending: null };
  }
  const pos = snapPos(w, snap);
  if (pending.stage === 1) {
    return {
      pending: {
        type: 'arc',
        c: pending.c,
        stage: 2,
        r: Math.max(MIN_RADIUS, vec.dist(center, pos)),
        a0: Math.atan2(pos.y - center.y, pos.x - center.x),
        newPt: pending.newPt,
      },
    };
  }
  if (pending.r === undefined || pending.a0 === undefined) return { pending: null };
  const a1 = Math.atan2(pos.y - center.y, pos.x - center.x);
  return { pending: null, action: createArc(center, pending.r, pending.a0, a1) };
}

/** 矩形：两个对角点，不落临时点（四角在创建时统一取/建） */
function rectStep(pending: Pending | null, w: Vec, snap: Snap | null): ClickOutcome {
  const pos = snapPos(w, snap);
  if (pending?.type === 'rect') {
    return { pending: null, action: createRect(pending.p0, pos) };
  }
  return { pending: { type: 'rect', p0: { x: pos.x, y: pos.y } } };
}

/** 两点尺寸第二步：点回起点视为取消；第二点优先复用已有点 */
function finishPointDim(aId: number, w: Vec, snap: Snap | null, view: CameraView): ClickOutcome {
  const a = getPoint(aId);
  if (!a) return { pending: null };
  const picked = pickPoint(w, view.z);
  if (picked && picked.id === a.id) return { pending: null };
  const b = picked ?? acquirePoint(w, snap);
  const created = picked === null && isFreshPoint(snap);
  const result = dimForPoints(a, b, w, created);
  if (!result.ok && created) removePoint(b);
  return { pending: null, dim: result };
}

/** 尺寸工具：已有尺寸优先编辑，其次选点（进入两点流程），最后点图元建尺寸 */
function dimStep(
  pending: Pending | null,
  w: Vec,
  snap: Snap | null,
  view: CameraView,
  measure: MeasureText,
  font: string,
): ClickOutcome {
  if (pending?.type === 'dim') return finishPointDim(pending.a, w, snap, view);
  const dim = pickDim(w, view, measure, font);
  if (dim) return { pending: null, dim: { ok: true, con: dim, created: false, notices: [] } };
  const pt = pickPoint(w, view.z);
  if (pt) return { pending: { type: 'dim', a: pt.id } };
  const ent = pickEntity(w, view.z);
  if (ent) return { pending: null, dim: dimForEntity(ent, view.z) };
  return { pending: null };
}

/** 删除工具：点优先于图元，二者都走级联删除 */
function eraseStep(w: Vec, view: CameraView): ClickOutcome {
  const pt = pickPoint(w, view.z);
  if (pt) return { pending: null, action: deleteSelected({ ents: [], pts: [pt.id] }) };
  const ent = pickEntity(w, view.z);
  if (ent) return { pending: null, action: deleteSelected({ ents: [ent.id], pts: [] }) };
  return { pending: null };
}

/**
 * 工具点击分发：把当前 pending 与这次点击合成为下一状态。
 * 选择工具由 Editor + selection.ts 处理（需要拖拽/框选手势），这里只返回原 pending。
 */
export function toolClick(
  tool: ToolId,
  pending: Pending | null,
  w: Vec,
  snap: Snap | null,
  view: CameraView,
  measure: MeasureText,
  font: string,
): ClickOutcome {
  switch (tool) {
    case 'line':
      return lineStep(pending, w, snap);
    case 'circle':
      return circleStep(pending, w, snap);
    case 'arc':
      return arcStep(pending, w, snap);
    case 'rect':
      return rectStep(pending, w, snap);
    case 'dim':
      return dimStep(pending, w, snap, view, measure, font);
    case 'erase':
      return eraseStep(w, view);
    case 'select':
      return { pending };
  }
}

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
