/**
 * 草图数据模型：点、图元、约束的增删查，以及包围盒计算。
 * 求解逻辑在 solver.ts，约束方程在 constraints.ts。
 */

import type {
  ArcEntity,
  CircleEntity,
  Constraint,
  ConstraintKind,
  Entity,
  LineEntity,
  Point,
} from './types';

export interface Bounds {
  minx: number;
  miny: number;
  maxx: number;
  maxy: number;
  bw: number;
  bh: number;
}

export interface SketchModel {
  pts: Map<number, Point>;
  ents: Map<number, Entity>;
  cons: Map<number, Constraint>;
  /** 全局自增 id：点/图元/约束共用，保证 id 唯一 */
  seq: number;
}

export const model: SketchModel = {
  pts: new Map(),
  ents: new Map(),
  cons: new Map(),
  seq: 1,
};

export const newId = (): number => model.seq++;

export const P = (id: number | undefined): Point | undefined =>
  id === undefined ? undefined : model.pts.get(id);

export const E = (id: number | undefined): Entity | undefined =>
  id === undefined ? undefined : model.ents.get(id);

/** 直线两端点；调用方保证引用的点存在 */
export const ends = (e: LineEntity): [Point, Point] => [P(e.a)!, P(e.b)!];

export function addPt(x: number, y: number, fixed = false): Point {
  const p: Point = { id: newId(), x, y, fixed, dragging: false };
  model.pts.set(p.id, p);
  return p;
}

export function addLine(a: Point, b: Point): LineEntity {
  const e: LineEntity = { id: newId(), type: 'line', a: a.id, b: b.id, construction: false };
  model.ents.set(e.id, e);
  return e;
}

export function addCircle(c: Point, r: number): CircleEntity {
  const e: CircleEntity = { id: newId(), type: 'circle', c: c.id, r, construction: false };
  model.ents.set(e.id, e);
  return e;
}

export function addArc(c: Point, r: number, a0: number, a1: number): ArcEntity {
  const e: ArcEntity = { id: newId(), type: 'arc', c: c.id, r, a0, a1, construction: false };
  model.ents.set(e.id, e);
  return e;
}

export function addCon(
  type: ConstraintKind,
  props: Omit<Constraint, 'id' | 'type'>,
): Constraint {
  const c: Constraint = { id: newId(), type, ...props };
  model.cons.set(c.id, c);
  return c;
}

/** 约束里表示图元引用的字段名 */
const ENTITY_REF_KEYS = ['e', 'e1', 'e2', 'line', 'circ'] as const;
/** 约束里表示点引用的字段名 */
const POINT_REF_KEYS = ['a', 'b', 'p', 'p1', 'p2'] as const;

const refsAny = (c: Constraint, keys: readonly (keyof Constraint)[], id: number): boolean =>
  keys.some((k) => c[k] === id);

export function removeEntity(e: Entity): void {
  model.ents.delete(e.id);
  for (const c of [...model.cons.values()]) {
    if (refsAny(c, ENTITY_REF_KEYS, e.id)) model.cons.delete(c.id);
  }
}

export function removePoint(p: Point): void {
  for (const e of [...model.ents.values()]) {
    const hit = e.type === 'line' ? e.a === p.id || e.b === p.id : e.c === p.id;
    if (hit) removeEntity(e);
  }
  for (const c of [...model.cons.values()]) {
    if (refsAny(c, POINT_REF_KEYS, p.id)) model.cons.delete(c.id);
  }
  model.pts.delete(p.id);
}

/** 所有图元的世界坐标包围盒（含留白）；没有图元时返回 null */
export function modelBounds(padRatio = 0.05): Bounds | null {
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  const grow = (x: number, y: number): void => {
    if (x < minx) minx = x;
    if (y < miny) miny = y;
    if (x > maxx) maxx = x;
    if (y > maxy) maxy = y;
  };

  for (const e of model.ents.values()) {
    if (e.type === 'line') {
      const [a, b] = ends(e);
      grow(a.x, a.y);
      grow(b.x, b.y);
    } else {
      const c = P(e.c);
      if (!c) continue;
      grow(c.x - e.r, c.y - e.r);
      grow(c.x + e.r, c.y + e.r);
    }
  }
  if (!Number.isFinite(minx)) return null;

  const pad = Math.max(maxx - minx, maxy - miny) * padRatio + 1;
  return {
    minx: minx - pad,
    miny: miny - pad,
    maxx: maxx + pad,
    maxy: maxy + pad,
    bw: maxx - minx + 2 * pad,
    bh: maxy - miny + 2 * pad,
  };
}

export function clearModel(): void {
  model.pts.clear();
  model.ents.clear();
  model.cons.clear();
  model.seq = 1;
}
