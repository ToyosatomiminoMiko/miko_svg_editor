/**
 * 约束残差表。
 * 每个函数返回残差数组，全部为 0 即满足约束。
 * 归一化很重要：角度类用点积/叉积除以模长，避免不同量纲在最小二乘里权重失衡。
 */

import { E, P, ends } from './model';
import type { ArcEntity, CircleEntity, Constraint, ConstraintKind, LineEntity } from './types';
import { vec } from './vec';

type CircleLike = CircleEntity | ArcEntity;

const lineOf = (id: number | undefined): LineEntity | undefined => {
  const e = E(id);
  return e?.type === 'line' ? e : undefined;
};

const circleOf = (id: number | undefined): CircleLike | undefined => {
  const e = E(id);
  return e && e.type !== 'line' ? e : undefined;
};

export const RESID: Record<ConstraintKind, (c: Constraint) => number[]> = {
  coincident(c) {
    const a = P(c.a);
    const b = P(c.b);
    return a && b ? [a.x - b.x, a.y - b.y] : [];
  },

  horizontal(c) {
    const e = lineOf(c.e);
    if (!e) return [];
    const [a, b] = ends(e);
    return [a.y - b.y];
  },

  vertical(c) {
    const e = lineOf(c.e);
    if (!e) return [];
    const [a, b] = ends(e);
    return [a.x - b.x];
  },

  parallel(c) {
    const e1 = lineOf(c.e1);
    const e2 = lineOf(c.e2);
    if (!e1 || !e2) return [];
    const [a1, b1] = ends(e1);
    const [a2, b2] = ends(e2);
    const d1 = vec.sub(b1, a1);
    const d2 = vec.sub(b2, a2);
    return [vec.crs(d1, d2) / (vec.len(d1) * vec.len(d2) + 1e-12)];
  },

  perpendicular(c) {
    const e1 = lineOf(c.e1);
    const e2 = lineOf(c.e2);
    if (!e1 || !e2) return [];
    const [a1, b1] = ends(e1);
    const [a2, b2] = ends(e2);
    const d1 = vec.sub(b1, a1);
    const d2 = vec.sub(b2, a2);
    return [vec.dot(d1, d2) / (vec.len(d1) * vec.len(d2) + 1e-12)];
  },

  equalLength(c) {
    const e1 = lineOf(c.e1);
    const e2 = lineOf(c.e2);
    if (!e1 || !e2) return [];
    const [a1, b1] = ends(e1);
    const [a2, b2] = ends(e2);
    return [vec.dist(a1, b1) - vec.dist(a2, b2)];
  },

  pointOnLine(c) {
    const e = lineOf(c.e);
    const p = P(c.p);
    if (!e || !p) return [];
    const [a, b] = ends(e);
    const d = vec.sub(b, a);
    const n = vec.len(d) || 1;
    return [vec.crs(vec.sub(p, a), d) / n];
  },

  pointOnCircle(c) {
    const e = circleOf(c.e);
    const p = P(c.p);
    if (!e || !p) return [];
    const cc = P(e.c);
    return cc ? [vec.dist(p, cc) - e.r] : [];
  },

  /** 线-圆相切：圆心到直线的距离 = 半径 */
  tangentLC(c) {
    const line = lineOf(c.line);
    const circ = circleOf(c.circ);
    if (!line || !circ) return [];
    const [a, b] = ends(line);
    const cc = P(circ.c);
    if (!cc) return [];
    const d = vec.sub(b, a);
    const n = vec.len(d) || 1;
    return [Math.abs(vec.crs(vec.sub(cc, a), d)) / n - circ.r];
  },

  tangentCC(c) {
    const e1 = circleOf(c.e1);
    const e2 = circleOf(c.e2);
    if (!e1 || !e2) return [];
    const p1 = P(e1.c);
    const p2 = P(e2.c);
    return p1 && p2 ? [vec.dist(p1, p2) - (e1.r + e2.r)] : [];
  },

  concentric(c) {
    const e1 = circleOf(c.e1);
    const e2 = circleOf(c.e2);
    if (!e1 || !e2) return [];
    const a = P(e1.c);
    const b = P(e2.c);
    return a && b ? [a.x - b.x, a.y - b.y] : [];
  },

  equalRadius(c) {
    const e1 = circleOf(c.e1);
    const e2 = circleOf(c.e2);
    return e1 && e2 ? [e1.r - e2.r] : [];
  },

  /* --- 尺寸类（同时是约束） --- */
  distancePP(c) {
    const a = P(c.a);
    const b = P(c.b);
    return a && b ? [vec.dist(a, b) - (c.d ?? 0)] : [];
  },

  distancePL(c) {
    const e = lineOf(c.e);
    const p = P(c.p);
    if (!e || !p) return [];
    const [a, b] = ends(e);
    const d = vec.sub(b, a);
    const n = vec.len(d) || 1;
    return [Math.abs(vec.crs(vec.sub(p, a), d)) / n - (c.d ?? 0)];
  },

  radius(c) {
    const e = circleOf(c.e);
    return e ? [e.r - (c.r ?? 0)] : [];
  },

  angle(c) {
    const e1 = lineOf(c.e1);
    const e2 = lineOf(c.e2);
    if (!e1 || !e2) return [];
    const [a1, b1] = ends(e1);
    const [a2, b2] = ends(e2);
    const d1 = vec.sub(b1, a1);
    const d2 = vec.sub(b2, a2);
    let diff = Math.atan2(vec.crs(d1, d2), vec.dot(d1, d2)) - (c.a ?? 0);
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    return [diff];
  },

  midpoint(c) {
    const e = lineOf(c.e);
    const p = P(c.p);
    if (!e || !p) return [];
    const [a, b] = ends(e);
    return [p.x - (a.x + b.x) / 2, p.y - (a.y + b.y) / 2];
  },

  symmetric(c) {
    const e = lineOf(c.e);
    const p1 = P(c.p1);
    const p2 = P(c.p2);
    if (!e || !p1 || !p2) return [];
    const [a, b] = ends(e);
    const d = vec.sub(b, a);
    const n = vec.len(d) || 1;
    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    return [vec.crs(vec.sub(mid, a), d) / n, vec.dot(vec.sub(p2, p1), d) / n];
  },
};
