/**
 * 草图数据模型：点、图元、约束的增删查与级联清理。
 * 数据只有一份单例 `model`：容器的增删只经本文件导出的函数；
 * 点的坐标/fixed 与图元的 construction 由 solver / 草图操作原地修改（见各模块）。
 * 包围盒在 geometry.sketchBounds；约束残差在 constraints.ts；求解在 solver.ts。
 */

import {
  ENTITY_REF_KEYS,
  INITIAL_SEQ,
  MIN_DRAW_LENGTH,
  POINT_REF_KEYS,
  constraintRefKey,
} from './config';
import { entityPointIds } from './entities';
import { vec } from './vec';
import type {
  ArcEntity,
  CircleEntity,
  Constraint,
  ConstraintKind,
  Entity,
  LineEntity,
  Point,
} from './types';

/** 模型里点/图元/约束的容器；`seq` 是三者共用的全局自增 id 序列 */
interface SketchModel {
  pts: Map<number, Point>;
  ents: Map<number, Entity>;
  cons: Map<number, Constraint>;
  seq: number;
}

export const model: SketchModel = {
  pts: new Map(),
  ents: new Map(),
  cons: new Map(),
  seq: INITIAL_SEQ,
};

const newId = (): number => model.seq++;

export const getPoint = (id: number | undefined): Point | undefined =>
  id === undefined ? undefined : model.pts.get(id);

export const getEntity = (id: number | undefined): Entity | undefined =>
  id === undefined ? undefined : model.ents.get(id);

/** 直线两端点；引用完整性由 model 的级联删除保证 */
export const ends = (e: LineEntity): [Point, Point] => [getPoint(e.a)!, getPoint(e.b)!];

/**
 * 按坐标找已有点（容差 MIN_DRAW_LENGTH）。
 * 矩形工具用它复用吸附到的角点，避免在已有点旁边再建一个重合点。
 */
export function pointAt(x: number, y: number): Point | undefined {
  for (const p of model.pts.values()) {
    if (vec.dist(p, { x, y }) <= MIN_DRAW_LENGTH) return p;
  }
  return undefined;
}

export function addPt(x: number, y: number, fixed = false): Point {
  const p: Point = { id: newId(), x, y, fixed };
  model.pts.set(p.id, p);
  return p;
}

export function addLine(a: Point, b: Point): LineEntity {
  const e: LineEntity = { id: newId(), type: 'line', a: a.id, b: b.id, construction: false };
  model.ents.set(e.id, e);
  return e;
}

/** 圆半径钳制到 >= 0：其余模块（渲染/导出/拾取）因此不再需要 Math.abs(r) */
export function addCircle(c: Point, r: number): CircleEntity {
  const e: CircleEntity = {
    id: newId(),
    type: 'circle',
    c: c.id,
    r: Math.max(0, r),
    construction: false,
  };
  model.ents.set(e.id, e);
  return e;
}

/** 圆弧半径钳制到 >= 0；扫角语义见 config/angle.sweepOf() */
export function addArc(c: Point, r: number, a0: number, a1: number): ArcEntity {
  const e: ArcEntity = {
    id: newId(),
    type: 'arc',
    c: c.id,
    r: Math.max(0, r),
    a0,
    a1,
    construction: false,
  };
  model.ents.set(e.id, e);
  return e;
}

export function addCon(type: ConstraintKind, props: Omit<Constraint, 'id' | 'type'>): Constraint {
  const c: Constraint = { id: newId(), type, ...props };
  model.cons.set(c.id, c);
  return c;
}

/** 约束去重：同 kind 且元数据声明的引用字段全部相同即视为同一条 */
export function findConstraint(
  kind: ConstraintKind,
  props: Omit<Constraint, 'id' | 'type'>,
): Constraint | undefined {
  const key = constraintRefKey(kind, props);
  for (const c of model.cons.values()) {
    if (c.type === kind && constraintRefKey(c.type, c) === key) return c;
  }
  return undefined;
}

const refsAny = (c: Constraint, keys: readonly (keyof Constraint)[], id: number): boolean =>
  keys.some((k) => c[k] === id);

/**
 * 删除图元并级联清理。
 * 删除策略：删图元时，仅被它使用的端点/圆心及其尺寸一并删除；共享端点保留。
 * 具体步骤：先记下该图元的端点；删图元与引用它的约束；对每个端点，若剩余图元都不再引用它，
 * 则删掉引用该点的约束（含以端点定义的 distancePointPoint 尺寸）和该点；
 * 最后 pruneOrphanPoints 兜底清掉因删约束而失去引用的点。
 * 没有这一步，会出现 audit 说的「删完图元仍有点/尺寸残留」。
 */
export function removeEntity(e: Entity): void {
  const candidates = entityPointIds(e);
  model.ents.delete(e.id);
  for (const c of [...model.cons.values()]) {
    if (refsAny(c, ENTITY_REF_KEYS, e.id)) model.cons.delete(c.id);
  }

  const stillUsed = new Set<number>();
  for (const other of model.ents.values()) {
    for (const id of entityPointIds(other)) stillUsed.add(id);
  }
  for (const id of candidates) {
    if (stillUsed.has(id)) continue;
    for (const c of [...model.cons.values()]) {
      if (refsAny(c, POINT_REF_KEYS, id)) model.cons.delete(c.id);
    }
    model.pts.delete(id);
  }
  pruneOrphanPoints();
}

/** 删除一条约束（新建尺寸后 Esc 撤销用）；引用完整性由调用方保证 */
export function removeConstraint(c: Constraint): void {
  model.cons.delete(c.id);
}

/** 删除点并递归级联：引用它的图元（及其约束）与直接引用它的约束一起删掉 */
export function removePoint(p: Point): void {
  for (const e of [...model.ents.values()]) {
    if (entityPointIds(e).includes(p.id)) removeEntity(e);
  }
  for (const c of [...model.cons.values()]) {
    if (refsAny(c, POINT_REF_KEYS, p.id)) model.cons.delete(c.id);
  }
  model.pts.delete(p.id);
  pruneOrphanPoints();
}

/**
 * 清理孤立点：没有任何剩余图元引用（作为端点/圆心）、也没有任何约束点引用字段指向的点。
 * 删除图元/约束后调用，保证模型里不残留不可见也不可操作的几何。
 */
export function pruneOrphanPoints(): void {
  const referenced = new Set<number>();
  for (const e of model.ents.values()) {
    for (const id of entityPointIds(e)) referenced.add(id);
  }
  for (const c of model.cons.values()) {
    for (const k of POINT_REF_KEYS) {
      const v = c[k];
      if (typeof v === 'number') referenced.add(v);
    }
  }
  for (const p of [...model.pts.values()]) {
    if (!referenced.has(p.id)) model.pts.delete(p.id);
  }
}

/** 三个容器都空才算空草图；导出/清空共用这一判定，避免两套「空」定义 */
export const isEmpty = (): boolean =>
  model.pts.size === 0 && model.ents.size === 0 && model.cons.size === 0;

export function clearModel(): void {
  model.pts.clear();
  model.ents.clear();
  model.cons.clear();
  model.seq = INITIAL_SEQ;
}
