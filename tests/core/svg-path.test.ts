/**
 * svg-path 的 transform 与 path 解析单测.
 *
 * 全部在 node 环境执行:这一层只做纯数学,不读 DOM/model,所以可以直接断言
 * 矩阵分量,圆心/半径与离散折线的首末点.浮点结果统一用 toBeCloseTo,
 * 只有构造上必然精确的端点坐标用严格相等.
 */

import { describe, expect, it } from 'vitest';
import {
  IDENTITY_MATRIX,
  applyMatrix,
  isConformal,
  matrixDeterminant,
  matrixScale,
  multiplyMatrix,
  parsePathData,
  parseTransform,
} from '../../src/core/svg-path';
import type { PathParse, PathParseOptions, PathSegment } from '../../src/core/svg-path';
import type { Vec } from '../../src/core/types';

/** 固定离散密度:读数与断言都用同一份,避免测试里散落魔数 */
const OPTIONS: PathParseOptions = { curveSegments: 8, ellipseSegments: 8 };

function parsePath(d: string, override: Partial<PathParseOptions> = {}): PathParse {
  return parsePathData(d, { ...OPTIONS, ...override });
}

function segmentAt(result: PathParse, index: number): PathSegment {
  const segment = result.segments[index];
  if (segment === undefined) throw new Error(`没有第 ${index} 段`);
  return segment;
}

function asLineSegment(result: PathParse, index: number): Extract<PathSegment, { kind: 'line' }> {
  const segment = segmentAt(result, index);
  if (segment.kind !== 'line') throw new Error(`第 ${index} 段不是 line`);
  return segment;
}

function asArcSegment(result: PathParse, index: number): Extract<PathSegment, { kind: 'arc' }> {
  const segment = segmentAt(result, index);
  if (segment.kind !== 'arc') throw new Error(`第 ${index} 段不是 arc`);
  return segment;
}

function asCurveSegment(result: PathParse, index: number): Extract<PathSegment, { kind: 'curve' }> {
  const segment = segmentAt(result, index);
  if (segment.kind !== 'curve') throw new Error(`第 ${index} 段不是 curve`);
  return segment;
}

function expectFinitePoint(point: Vec): void {
  expect(Number.isFinite(point.x)).toBe(true);
  expect(Number.isFinite(point.y)).toBe(true);
}

describe('parseTransform', () => {
  it('空字符串,纯空白与 undefined 返回单位矩阵且 valid', () => {
    for (const text of ['', '  \t\n', undefined]) {
      const parsed = parseTransform(text);
      expect(parsed.valid).toBe(true);
      expect(parsed.matrix).toBe(IDENTITY_MATRIX);
    }
  });

  it('translate 与 scale:缺省参数按 SVG 规则补齐', () => {
    expect(applyMatrix(parseTransform('translate(10 20)').matrix, { x: 1, y: 1 })).toEqual({
      x: 11,
      y: 21,
    });
    // translate 只有一个参数时 ty 缺省为 0
    expect(applyMatrix(parseTransform('translate(10)').matrix, { x: 0, y: 5 })).toEqual({
      x: 10,
      y: 5,
    });
    // scale 只有一个参数时 sx,sy 相同
    expect(applyMatrix(parseTransform('scale(2)').matrix, { x: 1, y: 1 })).toEqual({ x: 2, y: 2 });
    expect(parseTransform('scale(2 3)').matrix).toEqual({ a: 2, b: 0, c: 0, d: 3, e: 0, f: 0 });
  });

  it('matrix 六个分量按 a b c d e f 顺序透传', () => {
    expect(parseTransform('matrix(1 2 3 4 5 6)').matrix).toEqual({
      a: 1,
      b: 2,
      c: 3,
      d: 4,
      e: 5,
      f: 6,
    });
  });

  it('rotate(角度) 与 rotate(角度 cx cy) 绕指定点旋转', () => {
    const quarterTurn = parseTransform('rotate(90)').matrix;
    const direction = applyMatrix(quarterTurn, { x: 1, y: 0 });
    expect(direction.x).toBeCloseTo(0, 12);
    expect(direction.y).toBeCloseTo(1, 12);

    const aboutCenter = parseTransform('rotate(90 5 5)').matrix;
    expect(applyMatrix(aboutCenter, { x: 5, y: 5 }).x).toBeCloseTo(5, 12);
    expect(applyMatrix(aboutCenter, { x: 5, y: 5 }).y).toBeCloseTo(5, 12);
    // 绕 (5,5) 转 90 度:相对向量 (1,0) 变成 (0,1)
    expect(applyMatrix(aboutCenter, { x: 6, y: 5 }).x).toBeCloseTo(5, 12);
    expect(applyMatrix(aboutCenter, { x: 6, y: 5 }).y).toBeCloseTo(6, 12);
  });

  it('skewX / skewY 用 tan(角度) 错切', () => {
    expect(applyMatrix(parseTransform('skewX(45)').matrix, { x: 0, y: 1 }).x).toBeCloseTo(1, 12);
    expect(applyMatrix(parseTransform('skewY(45)').matrix, { x: 1, y: 0 }).y).toBeCloseTo(1, 12);
  });

  it('列表按从右往左作用到点上', () => {
    // translate(10 20) scale(2):先缩放再平移
    const combined = parseTransform('translate(10 20) scale(2)').matrix;
    expect(applyMatrix(combined, { x: 1, y: 1 })).toEqual({ x: 12, y: 22 });
    expect(applyMatrix(combined, { x: 0, y: 0 })).toEqual({ x: 10, y: 20 });
    // 反过来写:先平移再缩放,同一个点得到不同结果
    const reversed = parseTransform('scale(2) translate(10 20)').matrix;
    expect(applyMatrix(reversed, { x: 1, y: 1 })).toEqual({ x: 22, y: 42 });
  });

  it('接受逗号与空白两种分隔,以及函数之间的逗号', () => {
    expect(parseTransform('translate(10,20)').matrix).toEqual(
      parseTransform('translate(10 20)').matrix,
    );
    expect(parseTransform('translate(10,20),scale(2)').valid).toBe(true);
  });

  it('非法函数名,参数个数或数字返回 identity + valid=false', () => {
    const invalidTexts = [
      'translate(10',
      'translate',
      'foo(1)',
      'scale(1 2 3)',
      'matrix(1 0 0 1 0)',
      'rotate()',
      'translate(1e999)',
      'translate(10 20) bogus(1)',
    ];
    for (const text of invalidTexts) {
      const parsed = parseTransform(text);
      expect(parsed.valid, text).toBe(false);
      // 不返回半截变换:失败时矩阵必须回到单位矩阵
      expect(parsed.matrix, text).toBe(IDENTITY_MATRIX);
    }
  });
});

describe('矩阵运算', () => {
  it('multiplyMatrix 返回 left * right,即先应用 right', () => {
    const translate = parseTransform('translate(10 20)').matrix;
    const scale = parseTransform('scale(2)').matrix;
    expect(applyMatrix(multiplyMatrix(translate, scale), { x: 1, y: 1 })).toEqual({ x: 12, y: 22 });
    expect(multiplyMatrix(IDENTITY_MATRIX, scale)).toEqual(scale);
    expect(multiplyMatrix(scale, IDENTITY_MATRIX)).toEqual(scale);
  });

  it('applyMatrix 与 matrixDeterminant', () => {
    expect(applyMatrix(IDENTITY_MATRIX, { x: 3, y: -4 })).toEqual({ x: 3, y: -4 });
    expect(matrixDeterminant(IDENTITY_MATRIX)).toBe(1);
    expect(matrixDeterminant(parseTransform('scale(2 3)').matrix)).toBe(6);
    expect(matrixDeterminant(parseTransform('rotate(30)').matrix)).toBeCloseTo(1, 12);
    // 翻转矩阵行列式为负
    expect(matrixDeterminant(parseTransform('matrix(-1 0 0 1 0 0)').matrix)).toBe(-1);
  });

  it('matrixScale 是 sqrt(|det|):均匀缩放还原倍数,非等比缩放给面积等效值', () => {
    expect(matrixScale(parseTransform('scale(2)').matrix)).toBeCloseTo(2, 12);
    expect(matrixScale(parseTransform('scale(2 8)').matrix)).toBeCloseTo(4, 12);
    expect(matrixScale(parseTransform('rotate(45)').matrix)).toBeCloseTo(1, 12);
    expect(matrixScale(parseTransform('scale(-3 3)').matrix)).toBeCloseTo(3, 12);
  });

  it('isConformal:旋转/等比缩放/翻转/平移为 true,错切与非等比缩放为 false', () => {
    expect(isConformal(parseTransform('rotate(30)').matrix)).toBe(true);
    expect(isConformal(parseTransform('scale(2)').matrix)).toBe(true);
    expect(isConformal(parseTransform('translate(5 7)').matrix)).toBe(true);
    expect(isConformal(parseTransform('matrix(-1 0 0 1 0 0)').matrix)).toBe(true);
    expect(isConformal(parseTransform('scale(2 3)').matrix)).toBe(false);
    expect(isConformal(parseTransform('skewX(30)').matrix)).toBe(false);
    // 退化矩阵:列长为 0,不能当作相似变换
    expect(isConformal(parseTransform('matrix(0 0 0 0 0 0)').matrix)).toBe(false);
  });
});

describe('parsePathData:命令语法', () => {
  it('空 d,纯空白 d 返回空结果且无警告', () => {
    for (const d of [undefined, '', '   ']) {
      const result = parsePathData(d, OPTIONS);
      expect(result.segments).toEqual([]);
      expect(result.flattened).toBe(0);
      expect(result.warnings).toEqual([]);
    }
  });

  it('绝对与相对的折线命令 M/L/H/V 结果一致', () => {
    const absolute = parsePath('M 10 10 L 20 10 H 25 V 15');
    expect(absolute.segments).toHaveLength(3);
    expect(asLineSegment(absolute, 0)).toEqual({
      kind: 'line',
      from: { x: 10, y: 10 },
      to: { x: 20, y: 10 },
    });
    expect(asLineSegment(absolute, 1)).toEqual({
      kind: 'line',
      from: { x: 20, y: 10 },
      to: { x: 25, y: 10 },
    });
    expect(asLineSegment(absolute, 2)).toEqual({
      kind: 'line',
      from: { x: 25, y: 10 },
      to: { x: 25, y: 15 },
    });
    expect(absolute.warnings).toEqual([]);

    const relative = parsePath('m 10 10 l 10 0 h 5 v 5');
    expect(relative.segments).toEqual(absolute.segments);
  });

  it('隐式重复:M 后多对坐标按 lineto,L 后可继续跟多对参数', () => {
    const implicitMove = parsePath('M 0 0 10 0 10 10');
    const explicitMove = parsePath('M 0 0 L 10 0 L 10 10');
    expect(implicitMove.segments).toEqual(explicitMove.segments);
    expect(implicitMove.segments).toHaveLength(2);

    const repeatedLine = parsePath('M 0 0 L 10 0 20 0 30 0');
    expect(repeatedLine.segments).toHaveLength(3);
    expect(asLineSegment(repeatedLine, 2).to).toEqual({ x: 30, y: 0 });

    // 相对 moveto 的隐式重复按相对 lineto(l)处理
    const implicitRelative = parsePath('m 0 0 10 0 0 10');
    expect(implicitRelative.segments).toEqual(parsePath('M 0 0 L 10 0 L 10 10').segments);
  });

  it('Z 追加闭合线段并允许零长度闭合', () => {
    const closed = parsePath('M 0 0 L 10 0 L 10 10 Z');
    expect(closed.segments).toHaveLength(3);
    expect(asLineSegment(closed, 2)).toEqual({
      kind: 'line',
      from: { x: 10, y: 10 },
      to: { x: 0, y: 0 },
    });

    const zeroLength = parsePath('M 5 5 Z');
    expect(zeroLength.segments).toHaveLength(1);
    expect(asLineSegment(zeroLength, 0)).toEqual({
      kind: 'line',
      from: { x: 5, y: 5 },
      to: { x: 5, y: 5 },
    });
  });

  it('Z 之后当前点回到子路径起点,继续命令从起点出发', () => {
    const result = parsePath('M 10 10 L 20 10 Z l 5 0');
    expect(result.segments).toHaveLength(3);
    expect(asLineSegment(result, 2)).toEqual({
      kind: 'line',
      from: { x: 10, y: 10 },
      to: { x: 15, y: 10 },
    });
  });

  it('多个子路径之间不会自动连线', () => {
    const result = parsePath('M 0 0 L 10 0 M 20 20 L 30 20');
    expect(result.segments).toHaveLength(2);
    expect(asLineSegment(result, 1)).toEqual({
      kind: 'line',
      from: { x: 20, y: 20 },
      to: { x: 30, y: 20 },
    });
  });
});

describe('parsePathData:贝塞尔曲线', () => {
  it('三次贝塞尔离散成 curve,首末点精确等于 from/to', () => {
    const result = parsePath('M 0 0 C 0 10 10 10 10 0');
    const curve = asCurveSegment(result, 0);
    expect(result.flattened).toBe(1);
    expect(curve.from).toEqual({ x: 0, y: 0 });
    expect(curve.to).toEqual({ x: 10, y: 0 });
    expect(curve.points).toHaveLength(OPTIONS.curveSegments + 1);
    expect(curve.points[0]).toEqual({ x: 0, y: 0 });
    expect(curve.points.at(-1)).toEqual({ x: 10, y: 0 });
  });

  it('curveSegments 控制折线密度,小于 1 时夹到 1', () => {
    const single = parsePath('M 0 0 C 0 10 10 10 10 0', { curveSegments: 1 });
    expect(asCurveSegment(single, 0).points).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
    const clamped = parsePath('M 0 0 C 0 10 10 10 10 0', { curveSegments: 0 });
    expect(asCurveSegment(clamped, 0).points).toHaveLength(2);
  });

  it('S 的反射控制点与等价三次贝塞尔一致', () => {
    const reflected = parsePath('M 0 0 C 0 10 10 10 10 0 S 20 -10 20 0');
    const explicit = parsePath('M 0 0 C 0 10 10 10 10 0 C 10 -10 20 -10 20 0');
    expect(reflected.segments).toEqual(explicit.segments);
    expect(reflected.flattened).toBe(2);
  });

  it('上一条不是同类曲线时 S/T 的反射控制点取当前点', () => {
    expect(parsePath('M 0 0 S 10 10 20 0').segments).toEqual(
      parsePath('M 0 0 C 0 0 10 10 20 0').segments,
    );
    expect(parsePath('M 0 0 T 20 0').segments).toEqual(parsePath('M 0 0 Q 0 0 20 0').segments);
  });

  it('T 的反射控制点与等价二次贝塞尔一致', () => {
    const reflected = parsePath('M 0 0 Q 5 10 10 0 T 20 0');
    const explicit = parsePath('M 0 0 Q 5 10 10 0 Q 15 -10 20 0');
    expect(reflected.segments).toEqual(explicit.segments);
    expect(reflected.flattened).toBe(2);
  });

  it('相对三次/二次贝塞尔坐标以当前点为基准', () => {
    expect(parsePath('M 10 10 c 0 10 10 10 10 0').segments).toEqual(
      parsePath('M 10 10 C 10 20 20 20 20 10').segments,
    );
    expect(parsePath('M 10 10 q 5 10 10 0').segments).toEqual(
      parsePath('M 10 10 Q 15 20 20 10').segments,
    );
  });
});

describe('parsePathData:圆弧', () => {
  it('圆圆弧输出圆心/半径,sweep-flag=1 时 sweepPositive=true', () => {
    const result = parsePath('M 10 0 A 10 10 0 0 1 0 10');
    const arc = asArcSegment(result, 0);
    expect(result.flattened).toBe(0);
    expect(arc.center.x).toBeCloseTo(0, 12);
    expect(arc.center.y).toBeCloseTo(0, 12);
    expect(arc.radius).toBeCloseTo(10, 12);
    expect(arc.start).toEqual({ x: 10, y: 0 });
    expect(arc.end).toEqual({ x: 0, y: 10 });
    expect(arc.sweepPositive).toBe(true);
    // 圆心到起终点的距离都必须等于半径
    expect(Math.hypot(arc.center.x - arc.start.x, arc.center.y - arc.start.y)).toBeCloseTo(
      arc.radius,
      12,
    );
    expect(Math.hypot(arc.center.x - arc.end.x, arc.center.y - arc.end.y)).toBeCloseTo(
      arc.radius,
      12,
    );
  });

  it('large-arc-flag=1 选中另一侧圆心', () => {
    const result = parsePath('M 10 0 A 10 10 0 1 1 0 10');
    const arc = asArcSegment(result, 0);
    expect(arc.center.x).toBeCloseTo(10, 12);
    expect(arc.center.y).toBeCloseTo(10, 12);
    expect(arc.radius).toBeCloseTo(10, 12);
  });

  it('sweep-flag=0 时 sweepPositive=false', () => {
    const result = parsePath('M 10 0 A 10 10 0 1 0 0 10');
    const arc = asArcSegment(result, 0);
    expect(arc.sweepPositive).toBe(false);
    // large-arc=1 + sweep=0 的圆心在 (0,0)
    expect(arc.center.x).toBeCloseTo(0, 12);
    expect(arc.center.y).toBeCloseTo(0, 12);
  });

  it('rx 或 ry 为 0 时退化成直线,不计入 flattened', () => {
    const result = parsePath('M 0 0 A 0 10 0 0 1 10 10');
    expect(result.segments).toHaveLength(1);
    expect(asLineSegment(result, 0)).toEqual({
      kind: 'line',
      from: { x: 0, y: 0 },
      to: { x: 10, y: 10 },
    });
    expect(result.flattened).toBe(0);
  });

  it('负半径按绝对值处理(仍输出同一条圆圆弧)', () => {
    const negative = parsePath('M 10 0 A -10 -10 0 0 1 0 10');
    const positive = parsePath('M 10 0 A 10 10 0 0 1 0 10');
    expect(negative.segments).toEqual(positive.segments);
  });

  it('起终点重合的圆弧不产生任何段', () => {
    const result = parsePath('M 10 0 A 10 10 0 0 1 10 0');
    expect(result.segments).toHaveLength(0);
    expect(result.warnings).toEqual([]);
  });

  it('端距超过直径时按规范把半径放大到端距的一半', () => {
    const result = parsePath('M 0 0 A 10 10 0 0 1 30 0');
    const arc = asArcSegment(result, 0);
    expect(arc.radius).toBeCloseTo(15, 12);
    expect(arc.center.x).toBeCloseTo(15, 12);
    expect(arc.center.y).toBeCloseTo(0, 12);
  });

  it('rx != ry 的椭圆弧离散成 curve 折线并计入 flattened', () => {
    const result = parsePath('M 0 0 A 30 10 0 0 1 60 0');
    expect(result.flattened).toBe(1);
    expect(result.warnings).toEqual([]);
    const curve = asCurveSegment(result, 0);
    expect(curve.points).toHaveLength(OPTIONS.ellipseSegments + 1);
    expect(curve.points[0]).toEqual({ x: 0, y: 0 });
    expect(curve.points.at(-1)).toEqual({ x: 60, y: 0 });

    const coarse = parsePath('M 0 0 A 30 10 0 0 1 60 0', { ellipseSegments: 3 });
    expect(asCurveSegment(coarse, 0).points).toHaveLength(4);
  });

  it('椭圆弧的 x-axis-rotation 参与采样', () => {
    const rotated = parsePath('M 0 0 A 30 10 60 0 1 60 0', { ellipseSegments: 2 });
    const plain = parsePath('M 0 0 A 30 10 0 0 1 60 0', { ellipseSegments: 2 });
    const rotatedCurve = asCurveSegment(rotated, 0);
    expect(rotatedCurve.points[0]).toEqual({ x: 0, y: 0 });
    expect(rotatedCurve.points.at(-1)).toEqual({ x: 60, y: 0 });
    expect(rotatedCurve.points).not.toEqual(asCurveSegment(plain, 0).points);
  });

  it('相对圆弧与等价绝对圆弧结果一致', () => {
    expect(parsePath('M 0 0 a 10 10 0 0 1 10 10').segments).toEqual(
      parsePath('M 0 0 A 10 10 0 0 1 10 10').segments,
    );
  });
});

describe('parsePathData:错误处理', () => {
  it('参数不足时警告并停止,已解析的段仍返回', () => {
    const result = parsePath('M 0 0 L 10 0 L 5');
    expect(result.segments).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('L');
  });

  it('无法识别的字符警告并停止', () => {
    const result = parsePath('M 0 0 X 1 1');
    expect(result.segments).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('无法识别');
  });

  it('非有限数字按非法 token 警告并停止', () => {
    const result = parsePath('M 0 0 L 1e999 0');
    expect(result.segments).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('A 的 large-arc-flag / sweep-flag 非 0/1 时警告并停止', () => {
    const badLargeArc = parsePath('M 0 0 A 10 10 0 2 0 10 10');
    expect(badLargeArc.segments).toHaveLength(0);
    expect(badLargeArc.warnings).toHaveLength(1);
    expect(badLargeArc.warnings[0]).toContain('large-arc-flag');

    const badSweep = parsePath('M 0 0 A 10 10 0 0 2 10 10');
    expect(badSweep.segments).toHaveLength(0);
    expect(badSweep.warnings).toHaveLength(1);
    expect(badSweep.warnings[0]).toContain('sweep-flag');
  });

  it('数字前没有命令字母时警告并停止', () => {
    const result = parsePath('0 0 L 10 10');
    expect(result.segments).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
  });

  it('解析错误不会抛异常', () => {
    expect(() => parsePath('M 0 0 A')).not.toThrow();
    expect(() => parsePath('ZZZ')).not.toThrow();
    expect(() => parsePath('M - -')).not.toThrow();
  });
});

describe('parsePathData:输出数值约束', () => {
  it('所有输出坐标都是有限数', () => {
    const result = parsePath(
      'M 10 0 A 10 10 0 0 1 0 10 M 0 0 C 0 10 10 10 10 0 Q 5 5 10 0 A 30 10 30 0 1 60 0',
    );
    expect(result.warnings).toEqual([]);
    for (const segment of result.segments) {
      if (segment.kind === 'line') {
        expectFinitePoint(segment.from);
        expectFinitePoint(segment.to);
      } else if (segment.kind === 'arc') {
        expectFinitePoint(segment.center);
        expectFinitePoint(segment.start);
        expectFinitePoint(segment.end);
        expect(Number.isFinite(segment.radius)).toBe(true);
      } else {
        expectFinitePoint(segment.from);
        expectFinitePoint(segment.to);
        for (const point of segment.points) expectFinitePoint(point);
      }
    }
  });

  it('每段 curve 的折线首末点精确等于 from/to', () => {
    const result = parsePath('M 0 0 C 0 10 10 10 10 0 Q 15 20 20 0 A 30 10 0 0 1 50 0');
    expect(result.flattened).toBe(3);
    for (const segment of result.segments) {
      if (segment.kind !== 'curve') continue;
      expect(segment.points.length).toBeGreaterThanOrEqual(2);
      expect(segment.points[0]).toEqual(segment.from);
      expect(segment.points.at(-1)).toEqual(segment.to);
    }
  });
});
