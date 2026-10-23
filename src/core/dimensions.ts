/**
 * 尺寸标注：单一元数据表 DIM_META 集中「哪些约束算尺寸 + 取值/设值/文案/布局/命中/拖拽/图元匹配」，
 * 其余函数都查表，新增尺寸种类只需加一条元数据。
 *
 * 布局是纯函数：世界坐标 → 屏幕坐标由调用方传 CameraView 快照，文字宽度由注入的 MeasureText 测量，
 * 因此本文件不依赖全局相机/主题/DOM。renderer 画图、pickDim 命中与尺寸拖拽共用同一份布局，
 * 「看到什么就能点/拖什么」只有一份定义。
 *
 * 布局输出的是绘制原语（屏幕坐标的线段/圆弧/箭头/文字），不是某一类尺寸的私有字段：
 * 距离尺寸的尺寸线与界线、半径尺寸的引线、角度尺寸的圆弧因此能被同一个 renderer 绘制、
 * 被同一个命中函数测试，不需要在绘制/命中/拖拽三处各写一遍「这是什么尺寸」的分支。
 *
 * 用户单位约定：距离/半径以世界单位存，角度以**度**存（理由见 types.ts 的 Constraint.angle）；
 * 输入框回填、画布文案与列表文案都读同一个 dimValue/dimText，不会出现「存储弧度、显示度数」的分叉。
 */

import {
  DIM_CENTER_MARK_PX,
  DIM_DEFAULT_OFFSET_PX,
  DIM_LEADER_GAP_PX,
  DIM_MIN_ARC_PX,
  DIM_PICK_PX,
  DIM_TEXT_GAP_PX,
  MIN_ANGLE_SIN,
  RAD_TO_DEG,
  TEXT_FALLBACK_FONT_PX,
  formatDimValue,
  isFullSweep,
  normalizeAngle,
  sweepOf,
} from '../config';
import { distToSeg } from './geometry';
import { ArcEntity, LineEntity, isCurveEntity, type Entity } from './entities';
import { arcGeometry, ends, getEntity, getPoint, model } from './model';
import { vec } from './vec';
import { w2s } from './camera';
import type { CameraView } from './camera';
import type { Constraint, MeasureText, Vec } from './types';

/** 能画成尺寸标注的约束种类 */
export type DimKind = 'distancePointPoint' | 'radius' | 'angleLineLine';

/**
 * 尺寸类约束：按 kind 收窄，数值字段必填。
 * 创建路径必须在 addCon 时同时写入 distance/radius/angle（见 sketch-actions），
 * 因此取值/布局不需要 `?? 0` 兜底；类型收窄由 expectType 守卫完成。
 */
export type DimConstraint =
  | (Constraint & { type: 'distancePointPoint'; distance: number })
  | (Constraint & { type: 'radius'; radius: number })
  | (Constraint & { type: 'angleLineLine'; angle: number });

/**
 * 按种类收窄：DIM_META 只会在「自己的种类」上调用自己的方法，这里只做类型收窄；
 * 运行时抛错是防御「元数据表与 DimConstraint 联合漂移」，不是正常数据路径。
 */
function expectType<K extends DimKind>(
  c: DimConstraint,
  type: K,
): asserts c is Extract<DimConstraint, { type: K }> {
  if (c.type !== type) throw new Error(`尺寸种类不匹配：${c.type} / ${type}`);
}

/* ======================= 屏幕布局原语 ======================= */

/**
 * 文字锚点。align/baseline 直接对应 canvas 的 textAlign/textBaseline，
 * 命中框按同一份对齐方式算，文字框不会与画面上的字分叉。
 */
export interface DimTextLayout {
  readonly text: string;
  /** 屏幕坐标：对齐锚点 */
  readonly pos: Vec;
  readonly align: 'left' | 'center' | 'right';
  readonly baseline: 'top' | 'middle' | 'bottom';
}

/** 屏幕坐标线段；extension = 尺寸界线（画虚线，与尺寸线区分） */
export interface DimSegmentLayout {
  readonly a: Vec;
  readonly b: Vec;
  readonly extension?: boolean;
}

/**
 * 屏幕坐标圆弧。sweep 是**有符号**扫角：>0 表示角度递增方向（屏幕 y 向下，
 * 视觉上是顺时针），<0 表示递减方向；renderer 用 ctx.arc(start, start + sweep, sweep < 0)，
 * 命中判定用同一个 sweep 判断角度是否落在弧内。
 */
export interface DimArcLayout {
  readonly center: Vec;
  readonly radius: number;
  readonly start: number;
  readonly sweep: number;
}

/** 箭头：tip 是箭尖屏幕坐标，dir 是单位向量「从箭尾指向箭尖」 */
export interface DimArrowLayout {
  readonly tip: Vec;
  readonly dir: Vec;
}

/** 一条尺寸在屏幕上的完整画法：renderer / 命中 / 拖拽共用 */
export interface DimLayout {
  readonly kind: DimKind;
  readonly text: DimTextLayout;
  readonly segments: readonly DimSegmentLayout[];
  readonly arcs: readonly DimArcLayout[];
  readonly arrows: readonly DimArrowLayout[];
}

/* ======================= 元数据表 ======================= */

interface DimMeta {
  readonly label: string;
  /** 取值/设值的用户单位（角度=度） */
  value(c: DimConstraint): number;
  setValue(c: DimConstraint, v: number): void;
  /** 画布标注与「已选择」列表共用的显示文案（带单位，如 R12.3 / 45°） */
  text(c: DimConstraint): string;
  /** 输入框校验；解析层负责「正数」，这里只补种类特有的范围（角度 < 180°） */
  validate?(v: number): string | undefined;
  layout(c: DimConstraint, view: CameraView): DimLayout | null;
  /** 拖拽尺寸（只改摆放参数，不改目标值、不触发求解） */
  drag(c: DimConstraint, w: Vec, view: CameraView): void;
  /** 尺寸工具再点该图元时是否命中这条尺寸（用于「改为编辑」而不是重复添加） */
  matchesEntity(c: DimConstraint, e: Entity): boolean;
  matchesPoints?(c: DimConstraint, a: number, b: number): boolean;
  matchesEntities?(c: DimConstraint, e1: number, e2: number): boolean;
}

const samePair = (c: Constraint, a: number, b: number): boolean =>
  (c.a === a && c.b === b) || (c.a === b && c.b === a);

const sameEntityPair = (c: Constraint, e1: number, e2: number): boolean =>
  (c.e1 === e1 && c.e2 === e2) || (c.e1 === e2 && c.e2 === e1);

/** 单位向量；零向量返回零向量（退化尺寸由创建阈值挡住，这里只防绘制 NaN） */
const unit = (v: Vec): Vec => {
  const l = Math.hypot(v.x, v.y);
  return l === 0 ? { x: 0, y: 0 } : { x: v.x / l, y: v.y / l };
};

const neg = (v: Vec): Vec => ({ x: -v.x, y: -v.y });

/** 从 from 转到 to 的有符号角，范围 (-π, π]；用于判断两射线之间的夹角方向 */
const signedAngle = (from: Vec, to: Vec): number =>
  Math.atan2(vec.crs(from, to), vec.dot(from, to));

/* ---------------- 距离尺寸 ---------------- */

/**
 * 两点距离 / 直线长度。
 * 尺寸线沿两点连线法向偏移 offset（世界单位，带符号）：屏幕上是两道界线 + 一条尺寸线，
 * 两端各一个指向界线方向的实心箭头，文字压在尺寸线上方。拖动尺寸线/文字改的就是 offset。
 */
function distanceLayout(c: DimConstraint, view: CameraView): DimLayout | null {
  expectType(c, 'distancePointPoint');
  const a = getPoint(c.a);
  const b = getPoint(c.b);
  if (!a || !b) return null;
  const nrm = vec.unitPerp(vec.sub(b, a));
  const off = c.offset ?? 0;
  const A = w2s(a, view);
  const B = w2s(b, view);
  const A2 = w2s({ x: a.x + nrm.x * off, y: a.y + nrm.y * off }, view);
  const B2 = w2s({ x: b.x + nrm.x * off, y: b.y + nrm.y * off }, view);
  const mid = { x: (A2.x + B2.x) / 2, y: (A2.y + B2.y) / 2 };
  return {
    kind: 'distancePointPoint',
    segments: [
      { a: A, b: A2, extension: true },
      { a: B, b: B2, extension: true },
      { a: A2, b: B2 },
    ],
    arcs: [],
    arrows: [
      { tip: A2, dir: unit(vec.sub(A2, B2)) },
      { tip: B2, dir: unit(vec.sub(B2, A2)) },
    ],
    text: {
      text: DIM_META.distancePointPoint.text(c),
      pos: { x: mid.x, y: mid.y - DIM_TEXT_GAP_PX },
      align: 'center',
      baseline: 'bottom',
    },
  };
}

/* ---------------- 半径尺寸 ---------------- */

/** 半径引线缺省方向：圆弧取弧中点，整圆/圆取右上（-45°，屏幕 y 向下） */
function defaultRadiusAngle(e: Entity): number {
  if (e instanceof ArcEntity) {
    const g = arcGeometry(e);
    if (g) {
      const sweep = sweepOf(g.a0, g.a1);
      return isFullSweep(sweep) ? -Math.PI / 4 : normalizeAngle(g.a0 + sweep / 2);
    }
  }
  return -Math.PI / 4;
}

/**
 * 把引线方向夹到圆弧的角度范围内：半径尺寸的箭头必须落在弧上，
 * 拖动到弧外时贴住最近的端点，而不是指向一段不存在的几何。
 * 圆（整圆弧）没有范围限制。
 */
export function clampRadiusLeaderAngle(e: Entity, angle: number): number {
  if (!(e instanceof ArcEntity)) return normalizeAngle(angle);
  const g = arcGeometry(e);
  if (!g) return normalizeAngle(angle);
  const sweep = sweepOf(g.a0, g.a1);
  const stored = normalizeAngle(angle);
  if (isFullSweep(sweep)) return stored;
  const delta = normalizeAngle(stored - g.a0);
  if (delta <= sweep) return stored;
  const toEnd = delta - sweep;
  const toStart = Math.PI * 2 - delta;
  return normalizeAngle(toEnd <= toStart ? g.a0 + sweep : g.a0);
}

/**
 * 半径尺寸：圆心到圆弧的引线 + 弧上的箭头 + 圆心的十字标记，文字在箭头外侧。
 * 拖动引线/文字绕圆心旋转（leaderAngle）；圆弧上的引线方向会被夹到弧段内。
 */
function radiusLayout(c: DimConstraint, view: CameraView): DimLayout | null {
  expectType(c, 'radius');
  const e = getEntity(c.e);
  if (!isCurveEntity(e)) return null;
  const center = getPoint(e.c);
  const r = e.radius(getPoint);
  if (!center || r === null) return null;

  const angle = clampRadiusLeaderAngle(e, c.leaderAngle ?? defaultRadiusAngle(e));
  const dir = { x: Math.cos(angle), y: Math.sin(angle) };
  const C = w2s(center, view);
  const P = { x: C.x + dir.x * r * view.z, y: C.y + dir.y * r * view.z };
  // 文字放在箭头外侧；水平方向决定左/右对齐，接近竖直时居中
  const align: DimTextLayout['align'] = dir.x > 0.25 ? 'left' : dir.x < -0.25 ? 'right' : 'center';
  const gap = DIM_LEADER_GAP_PX;
  const m = DIM_CENTER_MARK_PX;
  return {
    kind: 'radius',
    segments: [
      { a: C, b: P },
      // 圆心十字（CAD 的半径/直径标注惯例）；作为界线原语参与命中，拖动它一样改引线方向
      { a: { x: C.x - m, y: C.y }, b: { x: C.x + m, y: C.y }, extension: true },
      { a: { x: C.x, y: C.y - m }, b: { x: C.x, y: C.y + m }, extension: true },
    ],
    arcs: [],
    arrows: [{ tip: P, dir }],
    text: {
      text: DIM_META.radius.text(c),
      pos: { x: P.x + dir.x * gap, y: P.y + dir.y * gap },
      align,
      baseline: 'middle',
    },
  };
}

/* ---------------- 角度尺寸 ---------------- */

/** 两直线求交后的几何：顶点与两条带方向向量（方向即端点 a→b，象限符号位作用在它上面） */
export interface AngleLineGeometry {
  readonly vertex: Vec;
  readonly d1: Vec;
  readonly d2: Vec;
}

/**
 * 两直线夹角几何：顶点（交点）+ 两条方向向量。
 * 平行/夹角过小（|sin| < MIN_ANGLE_SIN）时返回 null：交点跑到无穷远，
 * 没有稳定的顶点与扇形，角度标注无意义（创建入口据此报错，布局据此不画）。
 */
export function angleLineGeometry(
  e1: Entity | undefined,
  e2: Entity | undefined,
): AngleLineGeometry | null {
  if (!(e1 instanceof LineEntity) || !(e2 instanceof LineEntity)) return null;
  const [a1, b1] = ends(e1);
  const [a2, b2] = ends(e2);
  const d1 = vec.sub(b1, a1);
  const d2 = vec.sub(b2, a2);
  const denom = vec.crs(d1, d2);
  const sin = denom / (vec.safeLen(d1) * vec.safeLen(d2));
  if (Math.abs(sin) < MIN_ANGLE_SIN) return null;
  const t = vec.crs(vec.sub(a2, a1), d2) / denom;
  return {
    vertex: { x: a1.x + d1.x * t, y: a1.y + d1.y * t },
    d1,
    d2,
  };
}

/** 某个象限对应的两条射线（反向由符号位决定） */
function sectorRays(g: AngleLineGeometry, sector: number): { r1: Vec; r2: Vec } {
  return {
    r1: (sector & 1) === 0 ? g.d1 : neg(g.d1),
    r2: (sector & 2) === 0 ? g.d2 : neg(g.d2),
  };
}

/**
 * 放置点落在哪个象限（0..3）：四个象限 = 两条直线分出的四个扇形，
 * 每个扇形是「从 r1 沿较短路转到 r2」扫过的方向集合；四个组合恰好铺满整圈且互不重叠。
 */
export function angleSectorAt(g: AngleLineGeometry, p: Vec): number {
  const q = vec.sub(p, g.vertex);
  for (let sector = 0; sector < 4; sector++) {
    const { r1, r2 } = sectorRays(g, sector);
    const sweep = signedAngle(r1, r2);
    const rel = signedAngle(r1, q);
    const inside = sweep >= 0 ? rel >= 0 && rel <= sweep : rel <= 0 && rel >= sweep;
    if (inside) return sector;
  }
  // 四个扇形铺满整圈，只有浮点边界会漏；落到 0 只是兜底
  return 0;
}

/** 某象限的夹角（度）；与残差同口径：cos 由两条带符号方向的内积决定 */
export function angleSectorDegrees(g: AngleLineGeometry, sector: number): number {
  const { r1, r2 } = sectorRays(g, sector);
  return Math.abs(signedAngle(r1, r2)) * RAD_TO_DEG;
}

/**
 * 两直线夹角：顶点 + 两条射线之间的圆弧、两道沿直线的界线、弧两端各一个切向箭头，
 * 文字在角平分线外侧。拖动改弧半径；拖过直线时切换象限（目标角随之取补角，约束等价）。
 */
function angleLayout(c: DimConstraint, view: CameraView): DimLayout | null {
  expectType(c, 'angleLineLine');
  const g = angleLineGeometry(getEntity(c.e1), getEntity(c.e2));
  if (!g) return null;
  const sector = c.angleSector ?? 0;
  const { r1, r2 } = sectorRays(g, sector);
  const V = w2s(g.vertex, view);
  // 弧半径至少 DIM_MIN_ARC_PX，拖动到顶点上也不会让弧塌缩成一个点
  const R = Math.max((c.offset ?? 0) * view.z, DIM_MIN_ARC_PX);
  const a1 = Math.atan2(r1.y, r1.x);
  const a2 = Math.atan2(r2.y, r2.x);
  const sweep = signedAngle(r1, r2);
  const p1 = { x: V.x + R * Math.cos(a1), y: V.y + R * Math.sin(a1) };
  const p2 = { x: V.x + R * Math.cos(a2), y: V.y + R * Math.sin(a2) };
  const midAng = a1 + sweep / 2;
  const textR = R + DIM_TEXT_GAP_PX + TEXT_FALLBACK_FONT_PX / 2;
  // 圆弧行进方向的切向；起点箭头反向（背向弧内），终点箭头顺向，两个箭头都指向弧外
  const sign = sweep >= 0 ? 1 : -1;
  const tangent = (ang: number): Vec => ({ x: -Math.sin(ang) * sign, y: Math.cos(ang) * sign });
  return {
    kind: 'angleLineLine',
    segments: [
      { a: V, b: p1, extension: true },
      { a: V, b: p2, extension: true },
    ],
    arcs: [{ center: V, radius: R, start: a1, sweep }],
    arrows: [
      { tip: p1, dir: neg(tangent(a1)) },
      { tip: p2, dir: tangent(a2) },
    ],
    text: {
      text: DIM_META.angleLineLine.text(c),
      pos: { x: V.x + textR * Math.cos(midAng), y: V.y + textR * Math.sin(midAng) },
      align: 'center',
      baseline: 'middle',
    },
  };
}

/* ---------------- 元数据表 ---------------- */

/**
 * 尺寸元数据表：新增一种尺寸 = 加一条记录，取值/文案/布局/拖拽/匹配不需要再改别处。
 * distance/radius/angle 字段由「addCon 时同时写入数值」的创建路径保证存在，
 * 因此用非空断言而非 `?? 0` 兜底（兜底会把未初始化错误静默变成 0）。
 */
export const DIM_META: Record<DimKind, DimMeta> = {
  distancePointPoint: {
    label: '距离',
    value(c) {
      expectType(c, 'distancePointPoint');
      return c.distance;
    },
    setValue(c, v) {
      expectType(c, 'distancePointPoint');
      c.distance = v;
    },
    text(c) {
      expectType(c, 'distancePointPoint');
      return formatDimValue(c.distance);
    },
    layout: distanceLayout,
    drag(c, w) {
      expectType(c, 'distancePointPoint');
      const a = getPoint(c.a);
      const b = getPoint(c.b);
      if (!a || !b) return;
      // 光标在两点连线法向上的投影 = 新的世界偏移；拖到连线另一侧时符号自动翻转
      const nrm = vec.unitPerp(vec.sub(b, a));
      c.offset = vec.dot(vec.sub(w, a), nrm);
    },
    matchesEntity(c, e) {
      expectType(c, 'distancePointPoint');
      return e instanceof LineEntity && samePair(c, e.a, e.b);
    },
    matchesPoints(c, a, b) {
      expectType(c, 'distancePointPoint');
      return samePair(c, a, b);
    },
  },

  radius: {
    label: '半径',
    value(c) {
      expectType(c, 'radius');
      return c.radius;
    },
    setValue(c, v) {
      expectType(c, 'radius');
      c.radius = v;
    },
    text(c) {
      expectType(c, 'radius');
      return `R${formatDimValue(c.radius)}`;
    },
    layout: radiusLayout,
    drag(c, w) {
      expectType(c, 'radius');
      const e = getEntity(c.e);
      if (!isCurveEntity(e)) return;
      const center = getPoint(e.c);
      if (!center) return;
      // 引线固定在圆心：拖动只旋转方向，不改变半径（半径是约束目标，由输入框改）
      const raw = Math.atan2(w.y - center.y, w.x - center.x);
      c.leaderAngle = clampRadiusLeaderAngle(e, raw);
    },
    matchesEntity(c, e) {
      expectType(c, 'radius');
      return c.e === e.id;
    },
  },

  angleLineLine: {
    label: '角度',
    value(c) {
      expectType(c, 'angleLineLine');
      return c.angle;
    },
    setValue(c, v) {
      expectType(c, 'angleLineLine');
      c.angle = v;
    },
    text(c) {
      expectType(c, 'angleLineLine');
      return `${formatDimValue(c.angle)}°`;
    },
    validate: (v) => (v >= 180 ? '角度必须小于 180°' : undefined),
    layout: angleLayout,
    drag(c, w, view) {
      expectType(c, 'angleLineLine');
      const g = angleLineGeometry(getEntity(c.e1), getEntity(c.e2));
      if (!g) return;
      const dist = vec.dist(w, g.vertex);
      // 弧半径跟随光标，但不小于 DIM_MIN_ARC_PX；离顶点太近时不做象限切换，避免符号抖动
      c.offset = Math.max(dist, DIM_MIN_ARC_PX / view.z);
      if (dist * view.z < DIM_MIN_ARC_PX) return;
      const old = c.angleSector ?? 0;
      const next = angleSectorAt(g, w);
      if (next === old) return;
      c.angleSector = next;
      // 只翻转一条直线的方向位时，目标角取补角；约束方程 cos 值反号、几何意义不变。
      // 翻转两位（0↔3）等于两条都取反，内积符号不变，目标角保持不变。
      const flipped = next ^ old;
      if (flipped === 1 || flipped === 2) c.angle = 180 - c.angle;
    },
    // 角度尺寸没有「单图元」这条尺寸：同一条直线可以同时有长度与角度，不能按单图元命中
    matchesEntity: () => false,
    matchesEntities(c, e1, e2) {
      expectType(c, 'angleLineLine');
      return sameEntityPair(c, e1, e2);
    },
  },
};

/** 尺寸类约束的类型守卫：addCon 返回泛型 Constraint，创建尺寸后据此收窄 */
export const isDimConstraint = (c: Constraint): c is DimConstraint => c.type in DIM_META;

/** 约束是否尺寸标注；不是则返回 null */
export function dimKindOf(c: Constraint): DimKind | null {
  return isDimConstraint(c) ? c.type : null;
}

export const dimValue = (c: DimConstraint): number => DIM_META[c.type].value(c);

export const setDimValue = (c: DimConstraint, v: number): void => DIM_META[c.type].setValue(c, v);

/** 尺寸文案：画布标注与「已选择」列表共用（角度带 °、半径带 R） */
export const dimText = (c: DimConstraint): string => DIM_META[c.type].text(c);

/** 输入框校验：返回错误文案（undefined = 可提交）；长度/半径的正数由解析层负责 */
export const dimValidationError = (c: DimConstraint, v: number): string | undefined =>
  DIM_META[c.type].validate?.(v);

/** 尺寸种类的中文名（输入框标签、列表前缀） */
export const dimLabel = (dim: DimKind | DimConstraint): string =>
  DIM_META[typeof dim === 'string' ? dim : dim.type].label;

/**
 * 计算一条尺寸在屏幕上的画法；非尺寸约束或引用悬空返回 null。
 * 传 view 快照而不是读全局 cam，renderer 与命中判定因此可以共用同一份布局。
 */
export function dimLayout(c: Constraint, view: CameraView): DimLayout | null {
  if (!isDimConstraint(c)) return null;
  return DIM_META[c.type].layout(c, view);
}

/**
 * 拖动尺寸：把光标世界坐标写回摆放参数（距离=法向偏移 / 半径=引线方向 / 角度=弧半径+象限）。
 * 只改展示参数、不改目标值，所以不需要求解；引用悬空时布局函数会自行返回，拖拽函数也会早退。
 */
export function applyDimDrag(c: DimConstraint, w: Vec, view: CameraView): void {
  DIM_META[c.type].drag(c, w, view);
}

/* ======================= 命中 ======================= */

/** 从字体简写里取字号；解析失败时按 config/ui 的回退字号算 */
const fontSizePx = (font: string): number => Number.parseFloat(font) || TEXT_FALLBACK_FONT_PX;

/**
 * 屏幕点到文字框的距离（框内为 0）。
 * 按 align/baseline 把文字锚点换算成矩形：bottom 的文字落在锚点上方，middle 上下各半。
 */
function textHitDistance(text: DimTextLayout, measure: MeasureText, font: string, s: Vec): number {
  const w = measure(text.text, font);
  const h = fontSizePx(font);
  const minx =
    text.align === 'center'
      ? text.pos.x - w / 2
      : text.align === 'right'
        ? text.pos.x - w
        : text.pos.x;
  const maxx = minx + w;
  const miny =
    text.baseline === 'bottom'
      ? text.pos.y - h
      : text.baseline === 'middle'
        ? text.pos.y - h / 2
        : text.pos.y;
  const maxy = miny + h;
  const dx = Math.max(minx - s.x, 0, s.x - maxx);
  const dy = Math.max(miny - s.y, 0, s.y - maxy);
  return Math.hypot(dx, dy);
}

/** 屏幕点到圆弧的距离：角度在弧内取径向距离，否则取到较近端点的直线距离 */
function arcHitDistance(arc: DimArcLayout, s: Vec): number {
  const dx = s.x - arc.center.x;
  const dy = s.y - arc.center.y;
  const ang = Math.atan2(dy, dx);
  const inside =
    arc.sweep >= 0
      ? normalizeAngle(ang - arc.start) <= arc.sweep
      : normalizeAngle(arc.start - ang) <= -arc.sweep;
  if (inside) return Math.abs(Math.hypot(dx, dy) - arc.radius);
  const end = arc.start + arc.sweep;
  const at = (a: number): Vec => ({
    x: arc.center.x + arc.radius * Math.cos(a),
    y: arc.center.y + arc.radius * Math.sin(a),
  });
  return Math.min(vec.dist(s, at(arc.start)), vec.dist(s, at(end)));
}

/** 尺寸标注到屏幕点的命中距离（取文字 / 线段 / 圆弧的最近值） */
export function dimHitDistance(
  layout: DimLayout,
  measure: MeasureText,
  font: string,
  s: Vec,
): number {
  let best = textHitDistance(layout.text, measure, font, s);
  for (const seg of layout.segments) best = Math.min(best, distToSeg(s, seg.a, seg.b));
  for (const arc of layout.arcs) best = Math.min(best, arcHitDistance(arc, s));
  return best;
}

/**
 * 命中已有的尺寸标注（屏幕容差），多条命中时取最近的。
 * font 由调用方从主题传入（editor 传 theme.dimFont），与 renderer 绘制用同一份字体，
 * 这样文字命中框不会和画面上的字宽分叉。
 */
export function pickDim(
  w: Vec,
  view: CameraView,
  measure: MeasureText,
  font: string,
  pickTolPx = DIM_PICK_PX,
): DimConstraint | null {
  const s = w2s(w, view);
  let best: DimConstraint | null = null;
  let bestD = pickTolPx;
  for (const c of model.cons.values()) {
    if (!isDimConstraint(c)) continue;
    const layout = DIM_META[c.type].layout(c, view);
    if (!layout) continue;
    const d = dimHitDistance(layout, measure, font, s);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/* ======================= 按图元/点查已有尺寸 ======================= */

/** 图元已经有的尺寸：尺寸工具再点它时改为编辑，避免重复堆积（角度尺寸不按单图元命中） */
export function findDimForEntity(e: Entity): DimConstraint | undefined {
  for (const c of model.cons.values()) {
    if (isDimConstraint(c) && DIM_META[c.type].matchesEntity(c, e)) return c;
  }
  return undefined;
}

/** 两点之间已有的距离尺寸 */
export function findDistanceDim(a: number, b: number): DimConstraint | undefined {
  for (const c of model.cons.values()) {
    if (!isDimConstraint(c)) continue;
    if (DIM_META[c.type].matchesPoints?.(c, a, b)) return c;
  }
  return undefined;
}

/** 两条直线之间已有的角度尺寸（顺序无关） */
export function findAngleDim(e1: number, e2: number): DimConstraint | undefined {
  for (const c of model.cons.values()) {
    if (!isDimConstraint(c)) continue;
    if (DIM_META[c.type].matchesEntities?.(c, e1, e2)) return c;
  }
  return undefined;
}

/** 放置点决定的缺省角度弧半径（世界单位）：放置点离顶点太近时用屏幕像素兜底 */
export const angleRadiusFromPlacement = (vertex: Vec, placement: Vec, zoom: number): number =>
  Math.max(vec.dist(placement, vertex), DIM_DEFAULT_OFFSET_PX / zoom);
