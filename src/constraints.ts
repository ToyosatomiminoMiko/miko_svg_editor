/**
 * 约束校验与残差表。
 * 每个残差函数返回残差数组，全部为 0 即满足约束。
 * 归一化很重要：角度类用点积/叉积除以模长，避免不同量纲在最小二乘里权重失衡；
 * 分母统一用 vec.safeLen（零长度返回 1），不再出现 `|| 1` 与 `+1e-12` 两种写法。
 *
 * 残差函数按「引用已通过 isConstraintRefsValid 校验」的前提编写：
 * 悬空引用会在取字段时抛错，由 solver.evalResiduals 捕获并记入 invalidConstraints，
 * 而不是静默返回空残差（BUG-4 / B4.1）。
 */

import { CONSTRAINT_META, wrapPi } from './config';
import type { CurveEntity } from './entities';
import { curveRadius, ends, getEntity, getPoint } from './model';
import { vec } from './vec';
import type { Constraint, ConstraintKind, LineEntity, Point } from './types';

const finite = (v: number | undefined): boolean => typeof v === 'number' && Number.isFinite(v);

/**
 * 引用有效性校验：元数据声明的每个引用字段都存在、指向的图元/点存在、
 * 图元种类符合 accepts；并有距离/半径/角度值的约束，其数值必须是有限数。
 * 同时供 solver 在求解前过滤，避免悬挂引用被当成「无约束」静默跳过。
 */
export function isConstraintRefsValid(c: Constraint): boolean {
  for (const ref of CONSTRAINT_META[c.type].refs) {
    const value = c[ref.key];
    if (typeof value !== 'number') return false;
    if (ref.kind === 'point') {
      if (!getPoint(value)) return false;
      continue;
    }
    const entity = getEntity(value);
    if (!entity) return false;
    if (ref.accepts && !ref.accepts.includes(entity.type)) return false;
  }
  if (c.type === 'distancePointPoint' || c.type === 'distancePointLine') return finite(c.distance);
  if (c.type === 'radius') return finite(c.radius);
  if (c.type === 'angle') return finite(c.angle);
  return true;
}

const lineOf = (id: number | undefined): LineEntity => getEntity(id) as LineEntity;
const curveOf = (id: number | undefined): CurveEntity => getEntity(id) as CurveEntity;
const pointOf = (id: number | undefined): Point => getPoint(id)!;

export const RESID: Record<ConstraintKind, (c: Constraint) => number[]> = {
  coincident(c) {
    const a = pointOf(c.a);
    const b = pointOf(c.b);
    return [a.x - b.x, a.y - b.y];
  },

  horizontal(c) {
    const [a, b] = ends(lineOf(c.e));
    return [a.y - b.y];
  },

  vertical(c) {
    const [a, b] = ends(lineOf(c.e));
    return [a.x - b.x];
  },

  parallel(c) {
    const [a1, b1] = ends(lineOf(c.e1));
    const [a2, b2] = ends(lineOf(c.e2));
    const d1 = vec.sub(b1, a1);
    const d2 = vec.sub(b2, a2);
    return [vec.crs(d1, d2) / (vec.safeLen(d1) * vec.safeLen(d2))];
  },

  perpendicular(c) {
    const [a1, b1] = ends(lineOf(c.e1));
    const [a2, b2] = ends(lineOf(c.e2));
    const d1 = vec.sub(b1, a1);
    const d2 = vec.sub(b2, a2);
    return [vec.dot(d1, d2) / (vec.safeLen(d1) * vec.safeLen(d2))];
  },

  equalLength(c) {
    const [a1, b1] = ends(lineOf(c.e1));
    const [a2, b2] = ends(lineOf(c.e2));
    return [vec.dist(a1, b1) - vec.dist(a2, b2)];
  },

  /**
   * 两直线共线：方向平行 + 第二条线起点落在第一条线上，两条都归一到 0。
   * 只写方向叉积不够——平行但错开的两条线仍然不共线，必须再加一条「点到直线距离」；
   * 这条距离用第一条线的方向归一化（与 pointOnLine 同口径），角度残差用两个
   * 方向模长之积归一到 sin 值，避免长短线在最小二乘里权重失衡。
   */
  collinear(c) {
    const [a1, b1] = ends(lineOf(c.e1));
    const [a2, b2] = ends(lineOf(c.e2));
    const d1 = vec.sub(b1, a1);
    const d2 = vec.sub(b2, a2);
    return [
      vec.crs(d1, d2) / (vec.safeLen(d1) * vec.safeLen(d2)),
      vec.crs(vec.sub(a2, a1), d1) / vec.safeLen(d1),
    ];
  },

  pointOnLine(c) {
    const [a, b] = ends(lineOf(c.e));
    const p = pointOf(c.p);
    const d = vec.sub(b, a);
    return [vec.crs(vec.sub(p, a), d) / vec.safeLen(d)];
  },

  pointOnCircle(c) {
    const e = curveOf(c.e);
    const p = pointOf(c.p);
    return [vec.dist(p, pointOf(e.c)) - curveRadius(e)];
  },

  /** 线-圆相切：圆心到直线的距离 = 半径 */
  tangentLineCircle(c) {
    const [a, b] = ends(lineOf(c.line));
    const circ = curveOf(c.circ);
    const cc = pointOf(circ.c);
    const d = vec.sub(b, a);
    return [Math.abs(vec.crs(vec.sub(cc, a), d)) / vec.safeLen(d) - curveRadius(circ)];
  },

  /** 圆-圆相切（外切）：圆心距 = 半径和 */
  tangentCircleCircle(c) {
    const e1 = curveOf(c.e1);
    const e2 = curveOf(c.e2);
    return [vec.dist(pointOf(e1.c), pointOf(e2.c)) - (curveRadius(e1) + curveRadius(e2))];
  },

  concentric(c) {
    const a = pointOf(curveOf(c.e1).c);
    const b = pointOf(curveOf(c.e2).c);
    return [a.x - b.x, a.y - b.y];
  },

  equalRadius(c) {
    return [curveRadius(curveOf(c.e1)) - curveRadius(curveOf(c.e2))];
  },

  /* --- 尺寸类（同时是约束） --- */
  distancePointPoint(c) {
    return [vec.dist(pointOf(c.a), pointOf(c.b)) - c.distance!];
  },

  distancePointLine(c) {
    const [a, b] = ends(lineOf(c.e));
    const p = pointOf(c.p);
    const d = vec.sub(b, a);
    return [Math.abs(vec.crs(vec.sub(p, a), d)) / vec.safeLen(d) - c.distance!];
  },

  radius(c) {
    return [curveRadius(curveOf(c.e)) - c.radius!];
  },

  angle(c) {
    const [a1, b1] = ends(lineOf(c.e1));
    const [a2, b2] = ends(lineOf(c.e2));
    const d1 = vec.sub(b1, a1);
    const d2 = vec.sub(b2, a2);
    return [wrapPi(Math.atan2(vec.crs(d1, d2), vec.dot(d1, d2)) - c.angle!)];
  },

  midpoint(c) {
    const [a, b] = ends(lineOf(c.e));
    const p = pointOf(c.p);
    return [p.x - (a.x + b.x) / 2, p.y - (a.y + b.y) / 2];
  },

  symmetric(c) {
    const [a, b] = ends(lineOf(c.e));
    const p1 = pointOf(c.p1);
    const p2 = pointOf(c.p2);
    const d = vec.sub(b, a);
    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    return [
      vec.crs(vec.sub(mid, a), d) / vec.safeLen(d),
      vec.dot(vec.sub(p2, p1), d) / vec.safeLen(d),
    ];
  },
};
