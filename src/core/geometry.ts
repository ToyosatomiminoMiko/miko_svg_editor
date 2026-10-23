/**
 * 拾取、吸附、包围盒与框选判定。
 * 图元的几何差异已经在 entities.ts 里多态归一到 EntityPrimitive（线段 / 圆弧 / 点）：
 * 本文件只对基元写一次数学，拾取距离、吸附候选、折线近似与包围盒因此不会出现
 * 「圆和圆弧各写一遍」的重复分支。所有视图相关量由调用方传入 zoom（不读全局相机）。
 * 吸附优先级：已有点 > 中点 > 曲线上的点 > 直线上任意点 > 网格（见 config/tolerances）。
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
  arcSegments,
  isFullSweep,
  normalizeAngle,
  worldTol,
} from '../config';
import { gridSize } from './camera';
import { PointEntity, type Entity, type EntityPrimitive } from './entities';
import { getPoint, model, ownedPointIds, primitiveOf } from './model';
import { vec } from './vec';
import type { Point, Rect, Snap, Vec } from './types';

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
 * 扫角语义统一走 config/angle.sweepOf（圆弧基元在构造时已换算成 sweep），
 * 整圆任意角度都命中。
 */
function angleInSweep(ang: number, start: number, sweep: number): boolean {
  return isFullSweep(sweep) || normalizeAngle(ang - start) <= sweep;
}

/** 世界点到基元的最近距离；圆弧角度范围外视为无穷远（不参与拾取/吸附） */
function primitiveDistance(w: Vec, prim: EntityPrimitive): number {
  switch (prim.kind) {
    case 'segment':
      return distToSeg(w, prim.a, prim.b);
    case 'circular': {
      const ang = Math.atan2(w.y - prim.center.y, w.x - prim.center.x);
      if (!angleInSweep(ang, prim.start, prim.sweep)) return Infinity;
      return Math.abs(vec.dist(w, prim.center) - prim.radius);
    }
    case 'dot':
      return vec.dist(w, prim.at);
  }
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
    if (!(e instanceof PointEntity)) continue;
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
    const prim = primitiveOf(e);
    // 点基元已在上方 pickPointEntity 按点容差处理，这里不再参与线/面拾取
    if (!prim || prim.kind === 'dot') continue;
    const d = primitiveDistance(w, prim);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

/* ---------------- 吸附 ---------------- */

/** 基元能提供的吸附候选（不含已有点与网格：前者由点容器提供，后者由调用方兜底） */
interface PrimitiveSnapCandidate {
  pos: Vec;
  d: number;
  pri: number;
}

function primitiveSnapCandidates(prim: EntityPrimitive, w: Vec): PrimitiveSnapCandidate[] {
  switch (prim.kind) {
    case 'segment': {
      const { a, b } = prim;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const out: PrimitiveSnapCandidate[] = [
        { pos: mid, d: vec.dist(mid, w), pri: SNAP_PRIORITY.mid },
      ];
      const ab = vec.sub(b, a);
      const den = vec.dot(ab, ab);
      const t = den === 0 ? 0 : vec.dot(vec.sub(w, a), ab) / den;
      if (t > SNAP_ON_LINE_T_MIN && t < SNAP_ON_LINE_T_MAX) {
        const on = { x: a.x + ab.x * t, y: a.y + ab.y * t };
        out.push({ pos: on, d: vec.dist(on, w), pri: SNAP_PRIORITY.on });
      }
      return out;
    }
    case 'circular': {
      const ang = Math.atan2(w.y - prim.center.y, w.x - prim.center.x);
      if (!angleInSweep(ang, prim.start, prim.sweep)) return [];
      const on = {
        x: prim.center.x + prim.radius * Math.cos(ang),
        y: prim.center.y + prim.radius * Math.sin(ang),
      };
      return [{ pos: on, d: vec.dist(on, w), pri: SNAP_PRIORITY.curve }];
    }
    case 'dot':
      // 点图元的点已经作为「已有点」进入候选（优先级最高），基元层不重复产出
      return [];
  }
}

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

  // 中点 / 圆上点 / 线上点：由基元多态提供，圆与圆弧共用同一段径向投影数学
  for (const e of model.ents.values()) {
    const prim = primitiveOf(e);
    if (!prim) continue;
    for (const cand of primitiveSnapCandidates(prim, w)) {
      if (cand.d < tol) cands.push({ pos: cand.pos, d: cand.d, pri: cand.pri });
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

/** 圆弧的折线近似；sweep = TAU 时即整圆 */
function circularSamples(center: Vec, radius: number, start: number, sweep: number): Vec[] {
  const n = arcSegments(sweep);
  const pts: Vec[] = [];
  for (let i = 0; i <= n; i++) {
    const ang = start + (sweep * i) / n;
    pts.push({ x: center.x + radius * Math.cos(ang), y: center.y + radius * Math.sin(ang) });
  }
  return pts;
}

/** 用折线近似基元，供框选使用 */
function primitiveSamples(prim: EntityPrimitive): Vec[] {
  switch (prim.kind) {
    case 'segment':
      return [prim.a, prim.b];
    case 'circular':
      return circularSamples(prim.center, prim.radius, prim.start, prim.sweep);
    case 'dot':
      return [prim.at];
  }
}

/** 基元的紧包围盒：圆弧只算弧段范围，整圆才按整圆包围盒；点基元退化为零尺寸矩形 */
function primitiveBounds(prim: EntityPrimitive): Rect {
  switch (prim.kind) {
    case 'segment':
      return rectOf(prim.a, prim.b);
    case 'dot':
      return rectOf(prim.at, prim.at);
    case 'circular': {
      const { center, radius, start, sweep } = prim;
      if (isFullSweep(sweep)) {
        return {
          minx: center.x - radius,
          miny: center.y - radius,
          maxx: center.x + radius,
          maxy: center.y + radius,
        };
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
      const at = (ang: number): Vec => ({
        x: center.x + radius * Math.cos(ang),
        y: center.y + radius * Math.sin(ang),
      });
      // 起终点与象限极值都按「圆心 + 半径 + 角度」计算，和圆弧基元本身保持同一口径
      grow(at(start));
      grow(at(start + sweep));
      for (let k = 0; k < 4; k++) {
        const ang = (Math.PI / 2) * k;
        if (angleInSweep(ang, start, sweep)) grow(at(ang));
      }
      return { minx, miny, maxx, maxy };
    }
  }
}

/**
 * 所有图元的世界坐标包围盒（含留白）；没有图元时返回 null。
 * 每个图元先用基元取紧包围盒（圆弧按弧段而不是整圆），
 * 再加 pad = 最长边 × padRatio + BBOX_PAD_MIN，避免退化图形留白为 0。
 */
export function sketchBounds(padRatio = BBOX_PAD_RATIO): Bounds | null {
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (const e of model.ents.values()) {
    const prim = primitiveOf(e);
    if (!prim) continue;
    const b = primitiveBounds(prim);
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
  const prim = primitiveOf(e);
  if (!prim) return false;
  const pts = primitiveSamples(prim);
  for (const p of pts) if (pointInRect(p, r)) return true;
  // i 从 1 开始且小于 pts.length，i-1 与 i 都落在数组内；断言只为满足 noUncheckedIndexedAccess
  for (let i = 1; i < pts.length; i++) {
    if (segRectIntersect(pts[i - 1]!, pts[i]!, r)) return true;
  }
  return false;
}

/** 窗口框选：图元必须完全落在矩形内 */
export function entityInsideRect(e: Entity, r: Rect): boolean {
  const prim = primitiveOf(e);
  if (!prim) return false;
  const b = primitiveBounds(prim);
  return b.minx >= r.minx && b.maxx <= r.maxx && b.miny >= r.miny && b.maxy <= r.maxy;
}
