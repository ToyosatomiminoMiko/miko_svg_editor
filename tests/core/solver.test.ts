/**
 * solver.ts 的 LM 求解行为（node 环境直接跑，无 DOM）。
 * 覆盖：收敛、冲突约束不可满足、无效约束不崩且上报、圆弧端点自由度与共圆结构残差、
 * exclude 集合的点不被移动、圆半径 setter 钳制到 >= 0。
 * 每个用例 clearModel() 后重新搭 fixture，注意 solveSketch 会原地修改模型。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ITER_FULL } from '../../src/config';
import {
  addCircle,
  addCon,
  addLine,
  addPt,
  arcGeometry,
  clearModel,
  model,
} from '../../src/core/model';
import { solveSketch } from '../../src/core/solver';
import { vec } from '../../src/core/vec';
import { addArcByAngles } from './fixtures';

beforeEach(() => {
  clearModel();
});

describe('基本收敛', () => {
  it('无约束：residual=0、converged、无无效约束', () => {
    addLine(addPt(0, 0), addPt(10, 5));
    const result = solveSketch();
    expect(result.residual).toBe(0);
    expect(result.converged).toBe(true);
    expect(result.invalidConstraints).toEqual([]);
  });

  it('水平约束：求解后两端 y 相等，residual ≈ 0', () => {
    const a = addPt(0, 0);
    const b = addPt(10, 5);
    const line = addLine(a, b);
    addCon('horizontal', { e: line.id });

    const result = solveSketch();

    expect(result.residual).toBeLessThan(1e-9);
    expect(result.converged).toBe(true);
    expect(Math.abs(a.y - b.y)).toBeLessThan(1e-6);
    expect(result.invalidConstraints).toEqual([]);
  });

  it('固定点不参与求解：约束残差由自由点承担', () => {
    const a = addPt(0, 0, true);
    const b = addPt(10, 5);
    const line = addLine(a, b);
    addCon('horizontal', { e: line.id });

    const result = solveSketch();

    expect(a.x).toBe(0);
    expect(a.y).toBe(0);
    expect(b.y).toBeCloseTo(0, 6);
    expect(result.converged).toBe(true);
  });
});

describe('冲突约束', () => {
  it('固定端点上的水平+竖直约束无解：residual > 0 且 converged=false', () => {
    const a = addPt(0, 0, true);
    const b = addPt(10, 5, true);
    const line = addLine(a, b);
    addCon('horizontal', { e: line.id });
    addCon('vertical', { e: line.id });

    const result = solveSketch();

    // 水平残差 5、竖直残差 10 → 平方和 125；点都固定，没有任何可调参数
    expect(result.residual).toBeCloseTo(5 * 5 + 10 * 10, 9);
    expect(result.converged).toBe(false);
    expect(result.invalidConstraints).toEqual([]);
  });

  it('长度 + 水平 + 竖直三条约束互相矛盾：residual > 0 且 converged=false', () => {
    const a = addPt(0, 0);
    const b = addPt(10, 0);
    const line = addLine(a, b);
    addCon('distancePointPoint', { a: a.id, b: b.id, distance: 10 });
    addCon('horizontal', { e: line.id });
    addCon('vertical', { e: line.id });

    const result = solveSketch();

    expect(result.residual).toBeGreaterThan(1e-3);
    expect(result.converged).toBe(false);
  });
});

describe('无效约束（引用悬空 / 种类不符 / 数值缺失）', () => {
  it('无效约束记入 invalidConstraints，跳过其残差且不抛错', () => {
    const center = addPt(0, 0);
    const circle = addCircle(center, 10);
    const a = addPt(0, 0);
    const b = addPt(10, 0);
    addLine(a, b);

    const wrongKind = addCon('horizontal', { e: circle.id });
    const dangling = addCon('coincident', { a: 999, b: 998 });
    const nonFinite = addCon('distancePointPoint', {
      a: a.id,
      b: b.id,
      distance: Number.NaN,
    });

    const result = solveSketch();

    expect(result.invalidConstraints.sort()).toEqual(
      [wrongKind.id, dangling.id, nonFinite.id].sort(),
    );
    // 全部被跳过 → 没有可求的残差，视为满足
    expect(result.residual).toBe(0);
    expect(result.converged).toBe(true);
  });

  it('部分有效部分无效：有效约束仍照常求解', () => {
    const a = addPt(0, 0);
    const b = addPt(10, 5);
    const line = addLine(a, b);
    const valid = addCon('horizontal', { e: line.id });
    const invalid = addCon('coincident', { a: 999, b: 998 });

    const result = solveSketch();

    expect(result.invalidConstraints).toEqual([invalid.id]);
    expect(result.converged).toBe(true);
    expect(Math.abs(a.y - b.y)).toBeLessThan(1e-6);
    expect(model.cons.has(valid.id)).toBe(true);
  });
});

describe('圆弧：端点自由度 + 共圆结构残差', () => {
  it('radius 求解移动端点；求解后终点仍与起点共圆', () => {
    const center = addPt(0, 0, true);
    const arc = addArcByAngles(center, 10, 0.3, 2.1);
    addCon('radius', { e: arc.id, radius: 5 });

    const result = solveSketch();

    const g = arcGeometry(arc);
    if (!g) throw new Error('圆弧引用缺失');
    expect(result.converged).toBe(true);
    expect(g.r).toBeCloseTo(5, 6);
    expect(vec.dist(g.end, g.center)).toBeCloseTo(g.r, 6);
    // 圆心固定、只改半径：两个端点沿径向移动，极角基本不变（角度不是独立参数，只是派生量）
    expect(g.a0).toBeCloseTo(0.3, 4);
    expect(g.a1).toBeCloseTo(2.1, 4);
  });

  it('整圆弧（起终点是同一点）在求解后仍保持整圆语义', () => {
    const center = addPt(0, 0, true);
    const arc = addArcByAngles(center, 10, 0, 0);
    addCon('radius', { e: arc.id, radius: 4 });
    solveSketch();
    const g = arcGeometry(arc);
    if (!g) throw new Error('圆弧引用缺失');
    expect(g.start).toBe(g.end);
    expect(g.r).toBeCloseTo(4, 6);
    expect(g.a0).toBeCloseTo(g.a1, 12);
  });

  it('手动把终点拖离圆后求解：共圆残差把它拉回同一个圆', () => {
    const center = addPt(0, 0, true);
    const arc = addArcByAngles(center, 10, 0, Math.PI / 2);
    const before = arcGeometry(arc);
    if (!before) throw new Error('圆弧引用缺失');
    before.end.x = 20;
    before.end.y = 0;

    const result = solveSketch();

    const g = arcGeometry(arc);
    if (!g) throw new Error('圆弧引用缺失');
    expect(result.converged).toBe(true);
    expect(vec.dist(g.end, g.center)).toBeCloseTo(g.r, 6);
  });
});

describe('exclude 集合', () => {
  it('被排除的点坐标完全不变，其余点承担残差', () => {
    const a = addPt(0, 0);
    const b = addPt(10, 5);
    const line = addLine(a, b);
    addCon('horizontal', { e: line.id });

    const result = solveSketch(ITER_FULL, new Set([a.id]));

    expect(a.x).toBe(0);
    expect(a.y).toBe(0);
    expect(b.y).toBeCloseTo(a.y, 6);
    expect(result.converged).toBe(true);
  });
});

describe('角度约束', () => {
  /** 固定一条水平线 + 一条可转动的线；angle 为度，sector 决定射线符号位 */
  function angleFixture(
    angle: number,
    sector = 0,
  ): {
    line1: ReturnType<typeof addLine>;
    line2: ReturnType<typeof addLine>;
  } {
    const line1 = addLine(addPt(0, 0, true), addPt(100, 0, true));
    const line2 = addLine(addPt(0, 0, true), addPt(100, 100));
    addCon('angleLineLine', { e1: line1.id, e2: line2.id, angle, angleSector: sector });
    return { line1, line2 };
  }

  it('目标角 = 当前夹角时残差为 0（创建尺寸不扰动几何）', () => {
    angleFixture(45);
    const result = solveSketch();
    expect(result.converged).toBe(true);
    expect(result.residual).toBeLessThan(1e-9);
    expect(result.invalidConstraints).toEqual([]);
  });

  it('把角度改成 60° 后，两条线方向夹角收敛到 60°', () => {
    const { line1, line2 } = angleFixture(60);
    const result = solveSketch();
    expect(result.converged).toBe(true);
    expect(result.residual).toBeLessThan(1e-9);

    const [a1, b1] = endsOf(line1);
    const [a2, b2] = endsOf(line2);
    const d1 = vec.sub(b1, a1);
    const d2 = vec.sub(b2, a2);
    const cos = vec.dot(d1, d2) / (Math.hypot(d1.x, d1.y) * Math.hypot(d2.x, d2.y));
    expect((Math.acos(cos) * 180) / Math.PI).toBeCloseTo(60, 3);
  });

  it('象限位翻转一条射线时目标角取补角，几何仍然收敛', () => {
    // 同一对几何直线：sector 0 目标 45°，sector 1 目标 135° 是等价约束
    const { line2 } = angleFixture(135, 1);
    const result = solveSketch();
    expect(result.converged).toBe(true);
    const [a2, b2] = endsOf(line2);
    const d2 = vec.sub(b2, a2);
    const deg = (Math.atan2(d2.y, d2.x) * 180) / Math.PI;
    expect(Math.abs(deg)).toBeCloseTo(45, 3);
  });
});

/** 只给测试用的端点读取（solver 用例不关心 model 的级联语义） */
function endsOf(
  line: ReturnType<typeof addLine>,
): [{ x: number; y: number }, { x: number; y: number }] {
  const a = model.pts.get(line.a);
  const b = model.pts.get(line.b);
  if (!a || !b) throw new Error('直线端点缺失');
  return [a, b];
}

describe('半径钳制', () => {
  it('半径约束目标为负时 r 仍 >= 0（setter 钳制），残差无法归零', () => {
    const center = addPt(0, 0);
    const circle = addCircle(center, 10);
    addCon('radius', { e: circle.id, radius: -5 });

    const result = solveSketch();

    expect(circle.r).toBeGreaterThanOrEqual(0);
    expect(circle.r).toBe(0);
    expect(result.residual).toBeGreaterThan(0);
    expect(result.converged).toBe(false);
  });
});

describe('返回结构', () => {
  it('residual / converged / invalidConstraints 字段始终存在且为有限数', () => {
    addLine(addPt(0, 0), addPt(1, 1));
    const result = solveSketch();
    expect(Number.isFinite(result.residual)).toBe(true);
    expect(typeof result.converged).toBe('boolean');
    expect(Array.isArray(result.invalidConstraints)).toBe(true);
  });

  it('maxIter=0 时只评估一次残差，不迭代', () => {
    const a = addPt(0, 0);
    const b = addPt(10, 5);
    const line = addLine(a, b);
    addCon('horizontal', { e: line.id });
    const before = { ax: a.x, ay: a.y, bx: b.x, by: b.y };
    const result = solveSketch(0);
    expect(result.residual).toBe(25);
    expect({ ax: a.x, ay: a.y, bx: b.x, by: b.y }).toEqual(before);
  });
});
