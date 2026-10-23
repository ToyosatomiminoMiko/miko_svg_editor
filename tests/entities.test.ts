/**
 * 图元多态契约：EntityBase 子类各自实现的「同一组操作」在种类之间口径一致。
 * 这些用例钉住的是调用点依赖的接口，而不是某种图元的内部字段：
 * 引用点、尺寸目标、几何基元、重合/相切约束映射、求解自由度与圆弧结构残差
 * 都通过多态方法给出，新增图元种类时应先让这里覆盖到新子类。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { TAU, sweepOf } from '../src/config';
import { ArcEntity, CircleEntity, LineEntity, PointEntity, isCurveEntity } from '../src/entities';
import {
  addArc,
  addCircle,
  addLine,
  addPointEntity,
  addPt,
  clearModel,
  getPoint,
  primitiveOf,
  model,
} from '../src/model';
import { vec } from '../src/vec';
import { addArcByAngles } from './fixtures';

beforeEach(() => {
  clearModel();
});

describe('引用点、标签与大类', () => {
  it('每种图元按自己的结构给出 pointIds / label / category', () => {
    const a = addPt(0, 0);
    const b = addPt(10, 0);
    const line = addLine(a, b);
    const center = addPt(50, 50);
    const circle = addCircle(center, 10);
    const arc = addArcByAngles(addPt(100, 100), 10, 0, Math.PI / 2);
    const pe = addPointEntity(addPt(200, 200));

    expect([line.label, circle.label, arc.label, pe.label]).toEqual(['直线', '圆', '圆弧', '点']);
    expect([line.category, circle.category, arc.category, pe.category]).toEqual([
      'line',
      'curve',
      'curve',
      'point',
    ]);
    expect(line.pointIds).toEqual([a.id, b.id]);
    expect(circle.pointIds).toEqual([center.id]);
    expect(arc.pointIds).toEqual([arc.c, arc.a, arc.b]);
    expect(pe.pointIds).toEqual([pe.p]);
  });

  it('isCurveEntity 用子类关系判断圆/弧，点图元拥有自己的点', () => {
    const center = addPt(0, 0);
    const circle = addCircle(center, 10);
    const arc = addArcByAngles(addPt(50, 50), 5, 0, 1);
    const pe = addPointEntity(addPt(9, 9));

    expect(isCurveEntity(circle)).toBe(true);
    expect(isCurveEntity(arc)).toBe(true);
    expect(isCurveEntity(pe)).toBe(false);
    expect(pe.ownedPointId).toBe(pe.p);
    expect(circle.ownedPointId).toBeNull();
  });
});

describe('尺寸目标与结构角色', () => {
  it('直线标长度、圆/弧标半径、点图元没有独立尺寸', () => {
    const a = addPt(0, 0);
    const b = addPt(10, 0);
    const line = addLine(a, b);
    const circle = addCircle(addPt(0, 0), 10);
    const arc = addArcByAngles(addPt(50, 50), 10, 0, 1);
    const pe = addPointEntity(addPt(9, 9));

    expect(line.dimTarget()).toEqual({ kind: 'distance', a: a.id, b: b.id });
    expect(circle.dimTarget()).toEqual({ kind: 'radius', e: circle.id });
    expect(arc.dimTarget()).toEqual({ kind: 'radius', e: arc.id });
    expect(pe.dimTarget()).toBeNull();
  });

  it('pointRole 指出点在图元里的结构角色（重合的上下文排除用）', () => {
    const a = addPt(0, 0);
    const b = addPt(10, 0);
    const line = addLine(a, b);
    const center = addPt(50, 50);
    const circle = addCircle(center, 10);
    const arc = addArcByAngles(center, 10, 0, 1);

    expect(line.pointRole(a.id)).toBe('端点');
    expect(line.pointRole(center.id)).toBeNull();
    expect(circle.pointRole(center.id)).toBe('圆心');
    expect(circle.pointRole(a.id)).toBeNull();
    expect(arc.pointRole(center.id)).toBe('圆心');
    expect(arc.pointRole(arc.a)).toBe('端点');
  });
});

describe('几何基元归一', () => {
  it('直线 → segment、圆与整圆弧 → sweep=TAU 的 circular、点图元 → dot', () => {
    const a = addPt(0, 0);
    const b = addPt(10, 0);
    const line = addLine(a, b);
    const circle = addCircle(addPt(0, 0), 10);
    const arc = addArcByAngles(addPt(50, 50), 10, 0, Math.PI / 2);
    const pe = addPointEntity(addPt(7, 8));

    expect(primitiveOf(line)).toEqual({ kind: 'segment', a, b });
    expect(primitiveOf(circle)).toMatchObject({ kind: 'circular', radius: 10, sweep: TAU });
    expect(primitiveOf(arc)).toMatchObject({
      kind: 'circular',
      radius: 10,
      sweep: sweepOf(0, Math.PI / 2),
    });
    expect(primitiveOf(pe)).toEqual({ kind: 'dot', at: getPoint(pe.p) });
  });

  it('引用点缺失时 primitive 返回 null，只读路径据此跳过', () => {
    const line = addLine(addPt(0, 0), addPt(1, 1));
    line.a = 999;
    expect(primitiveOf(line)).toBeNull();
  });
});

describe('约束映射多态', () => {
  it('pointOnConstraint：直线 pointOnLine、圆/弧 pointOnCircle、点图元无', () => {
    const p = addPt(1, 1);
    const line = addLine(addPt(0, 0), addPt(10, 0));
    const circle = addCircle(addPt(0, 0), 10);
    const arc = addArcByAngles(addPt(50, 50), 10, 0, 1);
    const pe = addPointEntity(addPt(9, 9));

    expect(line.pointOnConstraint(p.id)).toEqual({
      kind: 'pointOnLine',
      props: { p: p.id, e: line.id },
    });
    expect(circle.pointOnConstraint(p.id)).toEqual({
      kind: 'pointOnCircle',
      props: { p: p.id, e: circle.id },
    });
    expect(arc.pointOnConstraint(p.id)?.kind).toBe('pointOnCircle');
    expect(pe.pointOnConstraint(p.id)).toBeNull();
  });

  it('tangentWith：线与圆互相分派到 tangentLineCircle，圆与弧落到 tangentCircleCircle', () => {
    const line = addLine(addPt(0, 0), addPt(10, 0));
    const circle = addCircle(addPt(0, 0), 10);
    const arc = addArcByAngles(addPt(50, 50), 10, 0, 1);
    const other = addCircle(addPt(100, 100), 5);

    const forward = line.tangentWith(circle);
    const backward = circle.tangentWith(line);
    expect(forward).toEqual({
      kind: 'tangentLineCircle',
      props: { line: line.id, circ: circle.id },
    });
    expect(backward).toEqual({
      kind: 'tangentLineCircle',
      props: { line: line.id, circ: circle.id },
    });

    expect(circle.tangentWith(arc)).toEqual({
      kind: 'tangentCircleCircle',
      props: { e1: circle.id, e2: arc.id },
    });
    expect(line.tangentWith(line)).toBeNull();
    expect(other.tangentWith(circle)?.kind).toBe('tangentCircleCircle');
  });
});

describe('求解自由度与结构残差', () => {
  it('只有圆贡献标量自由度（半径），且写回时钳制 >= 0', () => {
    const line = addLine(addPt(0, 0), addPt(10, 0));
    const circle = addCircle(addPt(0, 0), 10);
    const pe = addPointEntity(addPt(3, 3));

    expect(line.freeParams()).toHaveLength(0);
    expect(pe.freeParams()).toHaveLength(0);
    expect(circle.freeParams()).toHaveLength(1);
    const [r] = circle.freeParams();
    expect(r?.get()).toBe(10);
    r?.set(-5);
    expect(circle.r).toBe(0);
  });

  it('圆弧的端点共圆残差由自己提供：合法圆弧为 0，端点被挪开后非 0', () => {
    const arc = addArcByAngles(addPt(0, 0), 10, 0, Math.PI / 2);
    const residuals = (e: ArcEntity): number[] => e.structuralResiduals(getPoint);
    expect(residuals(arc)).toHaveLength(1);
    expect(residuals(arc)[0]).toBeCloseTo(0, 12);

    const end = getPoint(arc.b);
    if (!end) throw new Error('圆弧终点缺失');
    end.x = 2;
    end.y = 10;
    expect(Math.abs(residuals(arc)[0] ?? 0)).toBeGreaterThan(0.1);

    // 其它图元没有结构残差
    expect(addLine(addPt(0, 0), addPt(1, 1)).structuralResiduals(getPoint)).toEqual([]);
    expect(addCircle(addPt(0, 0), 1).structuralResiduals(getPoint)).toEqual([]);
  });
});

describe('半径的多态取值', () => {
  it('圆读自身 r，圆弧由圆心到起点的距离推出；直线/点返回 null', () => {
    const center = addPt(0, 0);
    const circle = addCircle(center, 10);
    const start = addPt(3, 4);
    const arc = addArc(center, start, start);
    const line = addLine(addPt(0, 0), addPt(1, 1));

    expect(circle.radius(getPoint)).toBe(10);
    expect(arc.radius(getPoint)).toBe(5);
    expect(line.radius(getPoint)).toBeNull();
    expect(vec.dist(getPoint(arc.a) ?? start, center)).toBe(5);
  });
});

describe('容器类型', () => {
  it('模型里存的是各自子类实例，可安全使用 instanceof 守卫', () => {
    addLine(addPt(0, 0), addPt(1, 0));
    addCircle(addPt(5, 5), 2);
    addPointEntity(addPt(9, 9));
    const values = [...model.ents.values()];
    expect(values.filter((e): e is LineEntity => e instanceof LineEntity)).toHaveLength(1);
    expect(values.filter((e): e is CircleEntity => e instanceof CircleEntity)).toHaveLength(1);
    expect(values.filter((e): e is PointEntity => e instanceof PointEntity)).toHaveLength(1);
  });
});
