/**
 * 拾取与吸附（容差按屏幕像素声明、按 zoom 换算成世界单位），
 * 以及包围盒/框选所需的图元折线近似。
 * 吸附优先级：已有点 > 中点 > 曲线上的点 > 直线上任意点 > 网格（见 config/tolerances 的 SNAP_PRIORITY）。
 * 本文件不读全局相机：所有视图相关量由调用方传入 zoom。
 */

import {
  BBOX_PAD_MIN,
  BBOX_PAD_RATIO,
  PICK_ENTITY_PX,
  PICK_POINT_PX,
  SNAP_GRID_FACTOR,
  SNAP_ON_LINE_T_MAX,
  SNAP_ON_LINE_T_MIN,
  SNAP_PRIORITY,
  SNAP_PX,
  TAU,
  arcSegments,
  isFullSweep,
  normalizeAngle,
  sweepOf,
  worldTol,
} from './config';
import { gridSize } from './camera';
import { assertNever } from './entities';
import { ends, getPoint, model, ownedPointIds } from './model';
import { vec } from './vec';
import type { Entity, Point, PointEntity, Rect, Snap, Vec } from './types';

/** 所有图元的世界坐标包围盒（含留白）；没有图元时返回 null */
interface Bounds {
  minx: number;
  miny: number;
  maxx: number;
  maxy: number;
  bw: number;
  bh: number;
}

/* ---------------- 拾取 ---------------- */

export function distToSeg(p: Vec, a: Vec, b: Vec): number {
  const ab = vec.sub(b, a);
  const den = vec.dot(ab, ab);
  const t = den === 0 ? 0 : Math.max(0, Math.min(1, vec.dot(vec.sub(p, a), ab) / den));
  return vec.dist(p, { x: a.x + ab.x * t, y: a.y + ab.y * t });
}

/**
 * 角度是否落在圆弧范围内（支持跨 0）。
 * 扫角语义统一走 config/angle.sweepOf：起终点同角按整圆处理，整圆任意角度都命中。
 */
function angInArc(ang: number, a0: number, a1: number): boolean {
  const sweep = sweepOf(a0, a1);
  if (isFullSweep(sweep)) return true;
  return normalizeAngle(ang - a0) <= sweep;
}

export function pickPoint(w: Vec, zoom: number): Point | null {
  const tol = worldTol(PICK_POINT_PX, zoom);
  // 点图元的点按图元拾取（pickEntity），否则同一个点会有 pt / ent 两种选择身份
  const owned = ownedPointIds();
  let best: Point | null = null;
  let bestD = tol;
  for (const p of model.pts.values()) {
    if (owned.has(p.id)) continue;
    const d = vec.dist(p, w);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/**
 * 点图元拾取：与 pickPoint 使用同一容差，并在选择时优先于线/圆/弧。
 * 点图元可能与它所在的线/端点重合，若按距离一起比较，Map 顺序会决定谁被选中；
 * 这里先单独取最近的点图元，保证「点优先于图元」对点图元也成立。
 */
export function pickPointEntity(w: Vec, zoom: number): PointEntity | null {
  const tol = worldTol(PICK_POINT_PX, zoom);
  let best: PointEntity | null = null;
  let bestD = tol;
  for (const e of model.ents.values()) {
    if (e.type !== 'point') continue;
    const p = getPoint(e.p);
    if (!p) continue;
    const d = vec.dist(w, p);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

export function pickEntity(w: Vec, zoom: number): Entity | null {
  // 点优先：与选择语义一致（pickPoint 的容差也更大），避免点图元被它所在的线/圆抢走
  const pointEntity = pickPointEntity(w, zoom);
  if (pointEntity) return pointEntity;

  const tol = worldTol(PICK_ENTITY_PX, zoom);
  let best: Entity | null = null;
  let bestD = tol;
  for (const e of model.ents.values()) {
    let d = Infinity;
    switch (e.type) {
      case 'point':
        // 已在上方 pickPointEntity 处理
        break;
      case 'line': {
        const [a, b] = ends(e);
        d = distToSeg(w, a, b);
        break;
      }
      case 'circle':
      case 'arc': {
        const c = getPoint(e.c);
        if (!c) break;
        const ang = Math.atan2(w.y - c.y, w.x - c.x);
        if (e.type === 'arc' && !angInArc(ang, e.a0, e.a1)) break;
        d = Math.abs(vec.dist(w, c) - e.r);
        break;
      }
      default:
        assertNever(e);
    }
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

/* ---------------- 吸附 ---------------- */

export function computeSnap(w: Vec, zoom: number): Snap | null {
  const tol = worldTol(SNAP_PX, zoom);
  const cands: Snap[] = [];

  // 已有点
  for (const p of model.pts.values()) {
    const d = vec.dist(p, w);
    if (d < tol) {
      cands.push({ pos: { x: p.x, y: p.y }, pt: p, d, pri: SNAP_PRIORITY.point });
    }
  }

  // 中点 / 圆上点 / 线上点
  for (const e of model.ents.values()) {
    switch (e.type) {
      case 'point':
        // 点图元的点已经作为「已有点」进入上面的候选（优先级最高），这里无需重复
        break;
      case 'line': {
        const [a, b] = ends(e);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const dm = vec.dist(mid, w);
        if (dm < tol) cands.push({ pos: mid, d: dm, pri: SNAP_PRIORITY.mid });

        const ab = vec.sub(b, a);
        const den = vec.dot(ab, ab);
        const t = den === 0 ? 0 : vec.dot(vec.sub(w, a), ab) / den;
        if (t > SNAP_ON_LINE_T_MIN && t < SNAP_ON_LINE_T_MAX) {
          const on = { x: a.x + ab.x * t, y: a.y + ab.y * t };
          const d = vec.dist(on, w);
          if (d < tol) cands.push({ pos: on, d, pri: SNAP_PRIORITY.on });
        }
        break;
      }
      case 'circle':
      case 'arc': {
        const c = getPoint(e.c);
        if (!c) break;
        const ang = Math.atan2(w.y - c.y, w.x - c.x);
        if (e.type === 'arc' && !angInArc(ang, e.a0, e.a1)) break;
        const on = { x: c.x + e.r * Math.cos(ang), y: c.y + e.r * Math.sin(ang) };
        const d = vec.dist(on, w);
        if (d < tol) cands.push({ pos: on, d, pri: SNAP_PRIORITY.curve });
        break;
      }
      default:
        assertNever(e);
    }
  }

  // 网格
  const g = gridSize(zoom);
  const gp = { x: Math.round(w.x / g) * g, y: Math.round(w.y / g) * g };
  const dg = vec.dist(gp, w);
  if (dg < tol * SNAP_GRID_FACTOR) cands.push({ pos: gp, d: dg, pri: SNAP_PRIORITY.grid });

  if (!cands.length) return null;
  cands.sort((a, b) => a.pri - b.pri || a.d - b.d);
  // 上面已排除空数组；?? null 只是满足 noUncheckedIndexedAccess 的类型收窄
  return cands[0] ?? null;
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
  // p / q 是固定长度 4 的参数表，i 在 [0,4) 内；断言只为满足 noUncheckedIndexedAccess
  for (let i = 0; i < 4; i++) {
    const pi = p[i]!;
    const qi = q[i]!;
    if (pi === 0) {
      if (qi < 0) return false;
    } else {
      const t = qi / pi;
      if (pi < 0) {
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

/** 圆/弧的折线近似；sweep = TAU 时即整圆 */
function circleSamples(c: Point, r: number, a0: number, sweep: number): Vec[] {
  const n = arcSegments(sweep);
  const pts: Vec[] = [];
  for (let i = 0; i <= n; i++) {
    const ang = a0 + (sweep * i) / n;
    pts.push({ x: c.x + r * Math.cos(ang), y: c.y + r * Math.sin(ang) });
  }
  return pts;
}

/** 用折线近似图元，供框选使用 */
function entitySamples(e: Entity): Vec[] {
  switch (e.type) {
    case 'line':
      return ends(e);
    case 'circle': {
      const c = getPoint(e.c);
      return c ? circleSamples(c, e.r, 0, TAU) : [];
    }
    case 'arc': {
      const c = getPoint(e.c);
      return c ? circleSamples(c, e.r, e.a0, sweepOf(e.a0, e.a1)) : [];
    }
    case 'point': {
      const p = getPoint(e.p);
      return p ? [p] : [];
    }
    default:
      return assertNever(e);
  }
}

/** 图元的紧包围盒：圆弧只算弧段范围，整圆才按圆包围盒；点图元退化为零尺寸矩形 */
function entityBounds(e: Entity): Rect | null {
  switch (e.type) {
    case 'line': {
      const a = getPoint(e.a);
      const b = getPoint(e.b);
      return a && b ? rectOf(a, b) : null;
    }
    case 'circle': {
      const c = getPoint(e.c);
      return c ? { minx: c.x - e.r, miny: c.y - e.r, maxx: c.x + e.r, maxy: c.y + e.r } : null;
    }
    case 'arc': {
      const c = getPoint(e.c);
      if (!c) return null;
      const sweep = sweepOf(e.a0, e.a1);
      if (isFullSweep(sweep)) {
        return { minx: c.x - e.r, miny: c.y - e.r, maxx: c.x + e.r, maxy: c.y + e.r };
      }
      let minx = Infinity;
      let miny = Infinity;
      let maxx = -Infinity;
      let maxy = -Infinity;
      const grow = (p: Vec): void => {
        if (p.x < minx) minx = p.x;
        if (p.y < miny) miny = p.y;
        if (p.x > maxx) maxx = p.x;
        if (p.y > maxy) maxy = p.y;
      };
      grow({ x: c.x + e.r * Math.cos(e.a0), y: c.y + e.r * Math.sin(e.a0) });
      grow({
        x: c.x + e.r * Math.cos(e.a0 + sweep),
        y: c.y + e.r * Math.sin(e.a0 + sweep),
      });
      for (let k = 0; k < 4; k++) {
        const ang = (Math.PI / 2) * k;
        if (angInArc(ang, e.a0, e.a1)) {
          grow({ x: c.x + e.r * Math.cos(ang), y: c.y + e.r * Math.sin(ang) });
        }
      }
      return { minx, miny, maxx, maxy };
    }
    case 'point': {
      const p = getPoint(e.p);
      return p ? rectOf(p, p) : null;
    }
    default:
      return assertNever(e);
  }
}

/**
 * 所有图元的世界坐标包围盒（含留白）；没有图元时返回 null。
 * 每个图元先用 entityBounds 取紧包围盒（圆弧按弧段而不是整圆），
 * 再加 pad = 最长边 × padRatio + BBOX_PAD_MIN，避免退化图形留白为 0。
 */
export function sketchBounds(padRatio = BBOX_PAD_RATIO): Bounds | null {
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (const e of model.ents.values()) {
    const b = entityBounds(e);
    if (!b) continue;
    if (b.minx < minx) minx = b.minx;
    if (b.miny < miny) miny = b.miny;
    if (b.maxx > maxx) maxx = b.maxx;
    if (b.maxy > maxy) maxy = b.maxy;
  }
  if (!Number.isFinite(minx)) return null;

  const pad = Math.max(maxx - minx, maxy - miny) * padRatio + BBOX_PAD_MIN;
  return {
    minx: minx - pad,
    miny: miny - pad,
    maxx: maxx + pad,
    maxy: maxy + pad,
    bw: maxx - minx + 2 * pad,
    bh: maxy - miny + 2 * pad,
  };
}

/** 交叉框选：矩形与图元有任何重叠即命中 */
export function entityCrossesRect(e: Entity, r: Rect): boolean {
  const pts = entitySamples(e);
  for (const p of pts) if (pointInRect(p, r)) return true;
  // i 从 1 开始且小于 pts.length，i-1 与 i 都落在数组内；断言只为满足 noUncheckedIndexedAccess
  for (let i = 1; i < pts.length; i++) {
    if (segRectIntersect(pts[i - 1]!, pts[i]!, r)) return true;
  }
  return false;
}

/** 窗口框选：图元必须完全落在矩形内 */
export function entityInsideRect(e: Entity, r: Rect): boolean {
  const b = entityBounds(e);
  if (!b) return false;
  return b.minx >= r.minx && b.maxx <= r.maxx && b.miny >= r.miny && b.maxy <= r.maxy;
}
