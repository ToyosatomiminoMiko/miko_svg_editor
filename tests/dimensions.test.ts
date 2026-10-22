/**
 * dimensions.ts 的尺寸取值/设值/文案/布局/命中。
 * 用假 CameraView + 假 MeasureText 注入，覆盖纯逻辑路径：
 * 布局是屏幕坐标（world → screen 由 w2s 快照换算），renderer 与 pickDim 共用同一份布局。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  DIM_META,
  dimKindOf,
  dimLabel,
  dimLayout,
  dimValue,
  findDimForEntity,
  findDistanceDim,
  isDimConstraint,
  pickDim,
  setDimValue,
} from '../src/dimensions';
import type { DimConstraint } from '../src/dimensions';
import type { CameraView } from '../src/camera';
import { DIM_DEFAULT_OFFSET_PX, DIM_PICK_PX, DIM_TEXT_GAP_PX } from '../src/config';
import { addCircle, addCon, addLine, addPt, clearModel } from '../src/model';
import type { MeasureText } from '../src/types';

/** 假相机：世界原点在屏幕 (400,300)，zoom=1 */
const view: CameraView = { x: 0, y: 0, z: 1, viewportW: 800, viewportH: 600 };

/** 假文本测量：每字符 10px（与字号 12 无关，便于手算命中框） */
const measure: MeasureText = (text) => text.length * 10;

const FONT = '12px sans-serif';

beforeEach(() => {
  clearModel();
});

/** 建一条水平直线（世界坐标 A(0,0) → B(100,0)）并加距离尺寸 */
function distanceFixture(offset = 20): {
  a: ReturnType<typeof addPt>;
  b: ReturnType<typeof addPt>;
  con: DimConstraint;
} {
  const a = addPt(0, 0);
  const b = addPt(100, 0);
  addLine(a, b);
  const con = addCon('distancePointPoint', { a: a.id, b: b.id, distance: 100, offset });
  if (!isDimConstraint(con)) throw new Error('测试 fixture 建尺寸失败');
  return { a, b, con };
}

describe('取值 / 设值 / 文案', () => {
  it('距离尺寸：value/setValue/label', () => {
    const { con } = distanceFixture();
    expect(isDimConstraint(con)).toBe(true);
    expect(dimKindOf(con)).toBe('distancePointPoint');
    expect(dimValue(con)).toBe(100);
    setDimValue(con, 42.5);
    expect(dimValue(con)).toBe(42.5);
    expect(dimLabel(con)).toBe('距离');
    expect(dimLabel('distancePointPoint')).toBe('距离');
  });

  it('半径尺寸：value/setValue/label', () => {
    const center = addPt(0, 0);
    const circle = addCircle(center, 30);
    const con = addCon('radius', { e: circle.id, radius: 30 });
    if (!isDimConstraint(con)) throw new Error('测试 fixture 建尺寸失败');
    expect(dimKindOf(con)).toBe('radius');
    expect(dimValue(con)).toBe(30);
    setDimValue(con, 12.345);
    expect(dimValue(con)).toBe(12.345);
    expect(dimLabel(con)).toBe('半径');
  });

  it('非尺寸约束 dimKindOf 返回 null', () => {
    const a = addPt(0, 0);
    const b = addPt(10, 0);
    const line = addLine(a, b);
    const con = addCon('horizontal', { e: line.id });
    expect(isDimConstraint(con)).toBe(false);
    expect(dimKindOf(con)).toBeNull();
    expect(dimLayout(con, view)).toBeNull();
  });

  it('DIM_META 覆盖两种尺寸，且每条都有完整能力', () => {
    expect(Object.keys(DIM_META).sort()).toEqual(['distancePointPoint', 'radius']);
    for (const meta of Object.values(DIM_META)) {
      expect(meta.label.length).toBeGreaterThan(0);
      expect(typeof meta.value).toBe('function');
      expect(typeof meta.setValue).toBe('function');
      expect(typeof meta.layout).toBe('function');
      expect(typeof meta.matchesEntity).toBe('function');
    }
  });
});

describe('dimLayout 屏幕投影', () => {
  it('距离尺寸：世界 offset 沿法线投影到屏幕', () => {
    const { con } = distanceFixture(20);
    const layout = dimLayout(con, view);
    expect(layout).not.toBeNull();
    if (!layout || layout.kind !== 'distance') throw new Error('布局类型不符');
    // A/B 是屏幕坐标：(0,0) → (400,300)，(100,0) → (500,300)
    expect(layout.A).toEqual({ x: 400, y: 300 });
    expect(layout.B).toEqual({ x: 500, y: 300 });
    // 左法线 (0,1)（世界 y 向下），offset=20 世界单位 → 屏幕 +20
    expect(layout.A2).toEqual({ x: 400, y: 320 });
    expect(layout.B2).toEqual({ x: 500, y: 320 });
    expect(layout.text).toBe('100');
    expect(layout.textPos).toEqual({ x: 450, y: 320 - DIM_TEXT_GAP_PX });
  });

  it('缩放改变 offset 的屏幕长度，但世界 offset 不变', () => {
    const { con } = distanceFixture(20);
    const zoomed: CameraView = { ...view, z: 2 };
    const layout = dimLayout(con, zoomed);
    if (!layout || layout.kind !== 'distance') throw new Error('布局类型不符');
    expect(layout.A2.y - layout.A.y).toBe(40);
    expect(layout.textPos.x).toBe((layout.A2.x + layout.B2.x) / 2);
  });

  it('半径尺寸：文字在圆心屏幕坐标右上方', () => {
    const center = addPt(0, 0);
    const circle = addCircle(center, 30);
    const con = addCon('radius', { e: circle.id, radius: 30 });
    if (!isDimConstraint(con)) throw new Error('测试 fixture 建尺寸失败');
    const layout = dimLayout(con, view);
    if (!layout || layout.kind !== 'radius') throw new Error('布局类型不符');
    expect(layout.text).toBe('R30');
    expect(layout.textPos).toEqual({ x: 400 + 8, y: 300 - 8 });
  });

  it('引用悬空返回 null（不抛错）', () => {
    const con = addCon('distancePointPoint', { a: 999, b: 998, distance: 10, offset: 0 });
    expect(isDimConstraint(con)).toBe(true);
    expect(dimLayout(con, view)).toBeNull();
    const radiusCon = addCon('radius', { e: 997, radius: 1 });
    expect(dimLayout(radiusCon, view)).toBeNull();
  });
});

describe('pickDim 命中', () => {
  it('命中文字框（屏幕容差内）', () => {
    const { con } = distanceFixture();
    // 文字框：x ∈ [435,465], y ∈ [304,316]；屏幕 (450,310) → 世界 (50,10)
    expect(pickDim({ x: 50, y: 10 }, view, measure, FONT)).toBe(con);
  });

  it('命中尺寸线（到线段距离）', () => {
    const { con } = distanceFixture();
    // 尺寸线 A2-B2 在屏幕 y=320；屏幕 (450,320) → 世界 (50,20)
    expect(pickDim({ x: 50, y: 20 }, view, measure, FONT)).toBe(con);
  });

  it('超出 DIM_PICK_PX 不命中', () => {
    distanceFixture();
    const far = { x: 50, y: 100 }; // 屏幕 (450,400)，距文字/尺寸线都 > DIM_PICK_PX
    expect(pickDim(far, view, measure, FONT)).toBeNull();
    expect(DIM_PICK_PX).toBeGreaterThan(0);
  });

  it('半径尺寸命中文字框', () => {
    const center = addPt(0, 0);
    const circle = addCircle(center, 30);
    const con = addCon('radius', { e: circle.id, radius: 30 });
    if (!isDimConstraint(con)) throw new Error('测试 fixture 建尺寸失败');
    // 文字左端 (408,292)，宽 30、高 12 → 屏幕 (410,290) → 世界 (10,-10)
    expect(pickDim({ x: 10, y: -10 }, view, measure, FONT)).toBe(con);
  });

  it('非尺寸约束不参与命中', () => {
    const a = addPt(0, 0);
    const b = addPt(10, 0);
    const line = addLine(a, b);
    addCon('horizontal', { e: line.id });
    expect(pickDim({ x: 5, y: 0 }, view, measure, FONT)).toBeNull();
  });
});

describe('按图元/点查已有尺寸', () => {
  it('findDimForEntity：直线匹配两端点（顺序无关）', () => {
    const a = addPt(0, 0);
    const b = addPt(100, 0);
    const line = addLine(a, b);
    const con = addCon('distancePointPoint', {
      a: b.id,
      b: a.id,
      distance: 100,
      offset: DIM_DEFAULT_OFFSET_PX,
    });
    expect(findDimForEntity(line)).toBe(con);
  });

  it('findDimForEntity：圆匹配半径尺寸', () => {
    const circle = addCircle(addPt(0, 0), 10);
    const con = addCon('radius', { e: circle.id, radius: 10 });
    expect(findDimForEntity(circle)).toBe(con);
  });

  it('findDistanceDim 顺序无关，且忽略类型不符的约束', () => {
    const a = addPt(0, 0);
    const b = addPt(100, 0);
    addLine(a, b);
    const con = addCon('distancePointPoint', { a: a.id, b: b.id, distance: 100, offset: 0 });
    expect(findDistanceDim(a.id, b.id)).toBe(con);
    expect(findDistanceDim(b.id, a.id)).toBe(con);
    expect(findDistanceDim(a.id, 999)).toBeUndefined();
  });
});

describe('全精度与显示精度分离（BUG-2 的数据侧）', () => {
  it('dimValue 保留输入全精度，只有 layout.text 按小数位截断', () => {
    const { con } = distanceFixture();
    setDimValue(con, 12.345);
    expect(dimValue(con)).toBe(12.345);
    const layout = dimLayout(con, view);
    expect(layout?.text).toBe('12.35');
  });
});
