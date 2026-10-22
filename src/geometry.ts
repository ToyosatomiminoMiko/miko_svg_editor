/**
 * 拾取与吸附。
 * 吸附优先级：已有点 > 中点 > 曲线上的点 > 直线上任意点 > 网格。
 */

import { cam, gridSize } from './camera';
import { P, ends, model } from './model';
import type { Entity, Point, Rect, Snap, Vec } from './types';
import { vec } from './vec';

export function distToSeg(p: Vec, a: Vec, b: Vec): number {
  const ab = vec.sub(b, a);
  const den = vec.dot(ab, ab) || 1;
  let t = vec.dot(vec.sub(p, a), ab) / den;
  t = Math.max(0, Math.min(1, t));
  return vec.dist(p, { x: a.x + ab.x * t, y: a.y + ab.y * t });
}

/** 角度是否落在圆弧 [a0, a1] 范围内（支持跨 0 的情况） */
export function angInArc(ang: number, a0: number, a1: number): boolean {
  const TAU = Math.PI * 2;
  const s = ((a0 % TAU) + TAU) % TAU;
  const e = ((a1 % TAU) + TAU) % TAU;
  const x = ((ang % TAU) + TAU) % TAU;
  if (e >= s) return x >= s && x <= e;
  return x >= s || x <= e;
}

export function pickPoint(w: Vec, tolPx = 9): Point | null {
  const t = tolPx / cam.z;
  let best: Point | null = null;
  let bd = t;
  for (const p of model.pts.values()) {
    const d = vec.dist(p, w);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}

export function pickEntity(w: Vec, tolPx = 8): Entity | null {
  const t = tolPx / cam.z;
  let best: Entity | null = null;
  let bd = t;
  for (const e of model.ents.values()) {
    let d = Infinity;
    if (e.type === 'line') {
      const [a, b] = ends(e);
      d = distToSeg(w, a, b);
    } else {
      const c = P(e.c);
      if (!c) continue;
      const ang = Math.atan2(w.y - c.y, w.x - c.x);
      if (e.type === 'arc' && !angInArc(ang, e.a0, e.a1)) continue;
      d = Math.abs(vec.dist(w, c) - e.r);
    }
    if (d < bd) {
      bd = d;
      best = e;
    }
  }
  return best;
}

export function computeSnap(w: Vec): Snap | null {
  const tol = 11 / cam.z;
  const cands: Snap[] = [];

  // 已有点
  for (const p of model.pts.values()) {
    const d = vec.dist(p, w);
    if (d < tol) cands.push({ type: 'point', pos: { x: p.x, y: p.y }, pt: p, d, pri: 0 });
  }

  // 中点 / 圆上点 / 线上点
  for (const e of model.ents.values()) {
    if (e.type === 'line') {
      const [a, b] = ends(e);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const dm = vec.dist(mid, w);
      if (dm < tol) cands.push({ type: 'mid', pos: mid, d: dm, pri: 1 });

      const ab = vec.sub(b, a);
      const t2 = vec.dot(vec.sub(w, a), ab) / (vec.dot(ab, ab) || 1);
      if (t2 > 0.02 && t2 < 0.98) {
        const on = { x: a.x + ab.x * t2, y: a.y + ab.y * t2 };
        const d = vec.dist(on, w);
        if (d < tol) cands.push({ type: 'on', pos: on, d, pri: 3 });
      }
    } else {
      const c = P(e.c);
      if (!c) continue;
      const ang = Math.atan2(w.y - c.y, w.x - c.x);
      if (e.type === 'arc' && !angInArc(ang, e.a0, e.a1)) continue;
      const on = { x: c.x + e.r * Math.cos(ang), y: c.y + e.r * Math.sin(ang) };
      const d = vec.dist(on, w);
      if (d < tol) cands.push({ type: 'quad', pos: on, d, pri: 2 });
    }
  }

  // 网格
  const g = gridSize();
  const gp = { x: Math.round(w.x / g) * g, y: Math.round(w.y / g) * g };
  const dg = vec.dist(gp, w);
  if (dg < tol * 0.75) cands.push({ type: 'grid', pos: gp, d: dg, pri: 5 });

  if (!cands.length) return null;
  cands.sort((a, b) => a.pri - b.pri || a.d - b.d);
  return cands[0];
}

/* ---------------- 框选 ---------------- */

export function rectOf(a: Vec, b: Vec): Rect {
  return {
    minx: Math.min(a.x, b.x),
    miny: Math.min(a.y, b.y),
    maxx: Math.max(a.x, b.x),
    maxy: Math.max(a.y, b.y),
  };
}

/** 点是否落在矩形内（含边界） */
export function pointInRect(p: Vec, r: Rect): boolean {
  return p.x >= r.minx && p.x <= r.maxx && p.y >= r.miny && p.y <= r.maxy;
}

/** 线段与矩形是否相交（Liang–Barsky 裁剪） */
function segRectIntersect(a: Vec, b: Vec, r: Rect): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x - r.minx, r.maxx - a.x, a.y - r.miny, r.maxy - a.y];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
  }
  return true;
}

/** 用折线近似图元，供框选使用 */
export function entitySamples(e: Entity): Vec[] {
  if (e.type === 'line') return ends(e);
  const c = P(e.c);
  if (!c) return [];
  const TAU = Math.PI * 2;

  if (e.type === 'circle') {
    const n = 64;
    const pts: Vec[] = [];
    for (let i = 0; i <= n; i++) {
      const ang = (TAU * i) / n;
      pts.push({ x: c.x + e.r * Math.cos(ang), y: c.y + e.r * Math.sin(ang) });
    }
    return pts;
  }

  let sweep = e.a1 - e.a0;
  while (sweep <= 0) sweep += TAU;
  const n = Math.max(8, Math.ceil((sweep / TAU) * 64));
  const pts: Vec[] = [];
  for (let i = 0; i <= n; i++) {
    const ang = e.a0 + (sweep * i) / n;
    pts.push({ x: c.x + e.r * Math.cos(ang), y: c.y + e.r * Math.sin(ang) });
  }
  return pts;
}

/** 图元的紧包围盒：圆弧只算弧段范围，不按整圆算 */
export function entityBounds(e: Entity): Rect {
  if (e.type === 'line') {
    const [a, b] = ends(e);
    return rectOf(a, b);
  }
  const c = P(e.c);
  if (!c) return { minx: 0, miny: 0, maxx: 0, maxy: 0 };
  if (e.type === 'circle') {
    return { minx: c.x - e.r, miny: c.y - e.r, maxx: c.x + e.r, maxy: c.y + e.r };
  }

  let sweep = e.a1 - e.a0;
  while (sweep <= 0) sweep += Math.PI * 2;
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  const add = (p: Vec): void => {
    minx = Math.min(minx, p.x);
    maxx = Math.max(maxx, p.x);
    miny = Math.min(miny, p.y);
    maxy = Math.max(maxy, p.y);
  };
  add({ x: c.x + e.r * Math.cos(e.a0), y: c.y + e.r * Math.sin(e.a0) });
  add({ x: c.x + e.r * Math.cos(e.a0 + sweep), y: c.y + e.r * Math.sin(e.a0 + sweep) });
  for (let k = 0; k < 4; k++) {
    const ang = (Math.PI / 2) * k;
    if (angInArc(ang, e.a0, e.a0 + sweep)) {
      add({ x: c.x + e.r * Math.cos(ang), y: c.y + e.r * Math.sin(ang) });
    }
  }
  return { minx, miny, maxx, maxy };
}

/** 交叉框选：矩形与图元有任何重叠即命中 */
export function entityCrossesRect(e: Entity, r: Rect): boolean {
  const pts = entitySamples(e);
  for (const p of pts) if (pointInRect(p, r)) return true;
  for (let i = 1; i < pts.length; i++) {
    if (segRectIntersect(pts[i - 1], pts[i], r)) return true;
  }
  return false;
}

/** 窗口框选：图元必须完全落在矩形内 */
export function entityInsideRect(e: Entity, r: Rect): boolean {
  const b = entityBounds(e);
  return b.minx >= r.minx && b.maxx <= r.maxx && b.miny >= r.miny && b.maxy <= r.maxy;
}
