/**
 * model.ts 的增删查与级联清理。
 * 重点钉住三条容易回归的规则：
 * 1) 删图元只删「仅被它使用」的点及其尺寸，共享端点与其尺寸保留；
 * 2) 删点会递归删掉引用它的图元/约束；
 * 3) isEmpty / clearModel / pruneOrphanPoints 保证不残留不可见几何。
 * 每个用例先 clearModel()，避免单例模型在测试间互相污染。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { INITIAL_SEQ, MIN_DRAW_LENGTH } from '../src/config';
import {
  addArc,
  addCircle,
  addCon,
  addLine,
  addPt,
  arcGeometry,
  clearModel,
  curveRadius,
  ends,
  findConstraint,
  getEntity,
  getPoint,
  isEmpty,
  model,
  pointAt,
  pruneOrphanPoints,
  removeConstraint,
  removeEntity,
  removePoint,
} from '../src/model';

beforeEach(() => {
  clearModel();
});

describe('新增对象', () => {
  it('点/线/圆/弧 id 共用同一条自增序列', () => {
    const a = addPt(0, 0);
    const b = addPt(10, 0);
    const line = addLine(a, b);
    const center = addPt(50, 50);
    const circle = addCircle(center, 10);
    expect([a.id, b.id, line.id, center.id, circle.id]).toEqual([1, 2, 3, 4, 5]);
    expect(model.seq).toBe(6);
  });

  it('圆半径钳制到 >= 0', () => {
    const c = addPt(0, 0);
    expect(addCircle(c, -5).r).toBe(0);
    expect(addCircle(c, 5).r).toBe(5);
  });

  it('圆弧半径由起点到圆心的距离决定，没有独立参数', () => {
    const c = addPt(0, 0);
    const start = addPt(3, 4); // |start - c| = 5
    const end = addPt(-3, 4);
    const arc = addArc(c, start, end);
    expect(curveRadius(arc)).toBe(5);
    const g = arcGeometry(arc);
    expect(g?.a0).toBeCloseTo(Math.atan2(4, 3), 12);
    expect(g?.a1).toBeCloseTo(Math.atan2(4, -3), 12);
  });

  it('圆弧引用圆心与两个端点（三个点都可被共享/级联删除）', () => {
    const c = addPt(0, 0);
    const start = addPt(10, 0);
    const end = addPt(0, 10);
    const arc = addArc(c, start, end);
    expect(arc.pointIds).toEqual([c.id, start.id, end.id]);
  });

  it('ends 按图元端点取点对象', () => {
    const a = addPt(1, 2);
    const b = addPt(3, 4);
    const line = addLine(a, b);
    expect(ends(line)).toEqual([a, b]);
  });

  it('getPoint / getEntity 对 undefined 与不存在的 id 都返回 undefined', () => {
    expect(getPoint(undefined)).toBeUndefined();
    expect(getEntity(undefined)).toBeUndefined();
    expect(getPoint(999)).toBeUndefined();
    expect(getEntity(999)).toBeUndefined();
  });
});

describe('pointAt 复用', () => {
  it('容差内复用同一点，容差外返回 undefined', () => {
    const p = addPt(10, 10);
    expect(pointAt(10, 10)).toBe(p);
    expect(pointAt(10 + MIN_DRAW_LENGTH / 2, 10)).toBe(p);
    expect(pointAt(10 + MIN_DRAW_LENGTH * 10, 10)).toBeUndefined();
    expect(pointAt(10 + MIN_DRAW_LENGTH * 10, 10 + MIN_DRAW_LENGTH * 10)).toBeUndefined();
  });
});

describe('removeEntity 级联', () => {
  it('删线：端点与以端点为定义的距离尺寸一起删除', () => {
    const a = addPt(0, 0);
    const b = addPt(100, 0);
    const line = addLine(a, b);
    const dim = addCon('distancePointPoint', { a: a.id, b: b.id, distance: 100 });
    const horizontal = addCon('horizontal', { e: line.id });

    removeEntity(line);

    expect(model.ents.size).toBe(0);
    expect(model.pts.size).toBe(0);
    expect(model.cons.size).toBe(0);
    expect(model.cons.has(dim.id)).toBe(false);
    expect(model.cons.has(horizontal.id)).toBe(false);
    expect(isEmpty()).toBe(true);
  });

  it('共享端点保留，引用共享端点的尺寸也保留', () => {
    const a = addPt(0, 0);
    const b = addPt(100, 0);
    const c = addPt(100, 100);
    const line1 = addLine(a, b);
    const line2 = addLine(b, c);
    const sharedDim = addCon('distancePointPoint', { a: b.id, b: c.id, distance: 100 });

    removeEntity(line1);

    // A 只属于 line1 → 删除；B 仍被 line2 使用 → 保留；C 保留
    expect(model.pts.size).toBe(2);
    expect(getPoint(a.id)).toBeUndefined();
    expect(getPoint(b.id)).toBeDefined();
    expect(getPoint(c.id)).toBeDefined();
    expect(model.ents.size).toBe(1);
    expect(model.ents.get(line2.id)).toBeDefined();
    // 尺寸引用 B/C，两者都在 → 不删
    expect(model.cons.has(sharedDim.id)).toBe(true);
  });

  it('删圆：圆心随之删除', () => {
    const center = addPt(5, 5);
    const circle = addCircle(center, 10);
    removeEntity(circle);
    expect(model.ents.size).toBe(0);
    expect(model.pts.size).toBe(0);
  });

  it('删图元时删除引用该图元的约束，但不误删其它图元的约束', () => {
    const a = addPt(0, 0);
    const b = addPt(10, 0);
    const c = addPt(20, 0);
    const line1 = addLine(a, b);
    const line2 = addLine(b, c);
    const h1 = addCon('horizontal', { e: line1.id });
    const h2 = addCon('horizontal', { e: line2.id });

    removeEntity(line1);

    expect(model.cons.has(h1.id)).toBe(false);
    expect(model.cons.has(h2.id)).toBe(true);
  });
});

describe('removePoint 递归', () => {
  it('删点会删掉引用它的图元，并级联到该图元的其它端点', () => {
    const a = addPt(0, 0);
    const b = addPt(10, 0);
    addLine(a, b);
    removePoint(a);
    expect(model.ents.size).toBe(0);
    expect(model.pts.size).toBe(0);
    expect(isEmpty()).toBe(true);
  });

  it('删点时删除直接引用它的约束', () => {
    const a = addPt(0, 0);
    const b = addPt(10, 0);
    const con = addCon('coincident', { a: a.id, b: b.id });
    removePoint(a);
    expect(model.cons.has(con.id)).toBe(false);
  });
});

describe('removeConstraint', () => {
  it('只删约束本身，不动点/图元', () => {
    const a = addPt(0, 0);
    const b = addPt(10, 0);
    addLine(a, b);
    const con = addCon('horizontal', { e: 1 });
    removeConstraint(con);
    expect(model.cons.size).toBe(0);
    expect(model.pts.size).toBe(2);
    expect(model.ents.size).toBe(1);
  });
});

describe('pruneOrphanPoints', () => {
  it('删除没有任何引用的孤立点', () => {
    addPt(1, 1);
    expect(model.pts.size).toBe(1);
    pruneOrphanPoints();
    expect(model.pts.size).toBe(0);
  });

  it('保留被图元端点或约束点引用字段引用的点', () => {
    const a = addPt(0, 0);
    const b = addPt(10, 0);
    addLine(a, b);
    const p = addPt(50, 50);
    const q = addPt(60, 60);
    addCon('coincident', { a: p.id, b: q.id });
    pruneOrphanPoints();
    expect(model.pts.size).toBe(4);
  });
});

describe('findConstraint 去重', () => {
  it('同 kind 同引用字段视为同一条约束', () => {
    const a = addPt(0, 0);
    const b = addPt(10, 0);
    const line = addLine(a, b);
    const con = addCon('horizontal', { e: line.id });

    expect(findConstraint('horizontal', { e: line.id })).toBe(con);
    expect(findConstraint('horizontal', { e: 999 })).toBeUndefined();
  });

  it('非引用数值字段（radius/distance）不参与去重', () => {
    const c = addPt(0, 0);
    const circle = addCircle(c, 10);
    const con = addCon('radius', { e: circle.id, radius: 10 });
    expect(findConstraint('radius', { e: circle.id, radius: 99 })).toBe(con);
  });

  it('不同 kind 不会互相命中', () => {
    const a = addPt(0, 0);
    const b = addPt(10, 0);
    const line = addLine(a, b);
    addCon('horizontal', { e: line.id });
    expect(findConstraint('vertical', { e: line.id })).toBeUndefined();
  });
});

describe('isEmpty / clearModel', () => {
  it('三容器都空才算空草图', () => {
    expect(isEmpty()).toBe(true);
    addPt(0, 0);
    expect(isEmpty()).toBe(false);
  });

  it('clearModel 清空数据并把 id 序列重置到 INITIAL_SEQ', () => {
    addPt(0, 0);
    addPt(1, 1);
    clearModel();
    expect(isEmpty()).toBe(true);
    expect(addPt(0, 0).id).toBe(INITIAL_SEQ);
  });
});
