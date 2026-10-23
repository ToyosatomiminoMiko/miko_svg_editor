/**
 * geometry.ts 的拾取、吸附、包围盒与框选判定。
 * 全部在 node 环境跑：几何函数不读全局相机，容差由 zoom 参数换算成世界单位，
 * 因此「同一屏幕像素容差在不同缩放下命中不同世界范围」可以直接断言。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { PICK_ENTITY_PX, PICK_POINT_PX, SNAP_PRIORITY, SNAP_PX, TAU } from '../../src/config';
import {
  computeSnap,
  distToSeg,
  entityCrossesRect,
  entityInsideRect,
  pickEntity,
  pickPoint,
  pointInRect,
  rectOf,
  sketchBounds,
} from '../../src/core/geometry';
import { addCircle, addLine, addPt, arcGeometry, clearModel } from '../../src/core/model';
import { state } from '../../src/core/state';
import { addArcByAngles } from './fixtures';

beforeEach(() => {
  clearModel();
  state.snapEnabled = true;
});

describe('pickPoint 容差随 zoom 换算', () => {
  it('zoom=1：PICK_POINT_PX 像素内命中，超出不命中', () => {
    const p = addPt(0, 0);
    const tol = PICK_POINT_PX;
    expect(pickPoint({ x: tol - 1, y: 0 }, 1)).toBe(p);
    expect(pickPoint({ x: tol + 1, y: 0 }, 1)).toBeNull();
  });

  it('zoom=2：同样的世界距离在放大后不再命中（世界容差减半）', () => {
    const p = addPt(0, 0);
    expect(pickPoint({ x: PICK_POINT_PX / 2 - 0.5, y: 0 }, 2)).toBe(p);
    expect(pickPoint({ x: PICK_POINT_PX / 2 + 0.5, y: 0 }, 2)).toBeNull();
  });

  it('多点命中时取最近的点', () => {
    const near = addPt(2, 0);
    addPt(6, 0);
    expect(pickPoint({ x: 1, y: 0 }, 1)).toBe(near);
  });
});

describe('pickEntity', () => {
  it('直线按世界距离命中，容差随 zoom', () => {
    const line = addLine(addPt(0, 0), addPt(100, 0));
    expect(pickEntity({ x: 50, y: PICK_ENTITY_PX - 1 }, 1)).toBe(line);
    expect(pickEntity({ x: 50, y: PICK_ENTITY_PX + 1 }, 1)).toBeNull();
    // zoom=2 时世界容差 = 4
    expect(pickEntity({ x: 50, y: PICK_ENTITY_PX / 2 + 1 }, 2)).toBeNull();
  });

  it('圆按到圆周的距离命中', () => {
    const center = addPt(0, 0);
    const circle = addCircle(center, 10);
    expect(pickEntity({ x: 10, y: 0 }, 1)).toBe(circle);
    expect(pickEntity({ x: 10 + PICK_ENTITY_PX + 1, y: 0 }, 1)).toBeNull();
    // 圆心不是圆周：圆心附近近距离不命中
    expect(pickEntity({ x: 0, y: 0 }, 1)).toBeNull();
  });

  it('部分圆弧只命中弧段角度内；整圆弧任意角度都命中', () => {
    const center = addPt(0, 0);
    const quarter = addArcByAngles(center, 10, 0, Math.PI / 2);
    const onArc = { x: 10 * Math.cos(Math.PI / 4), y: 10 * Math.sin(Math.PI / 4) };
    const offArc = { x: -onArc.x, y: -onArc.y };
    expect(pickEntity(onArc, 1)).toBe(quarter);
    expect(pickEntity(offArc, 1)).toBeNull();

    clearModel();
    const c2 = addPt(0, 0);
    const full = addArcByAngles(c2, 10, 0, 0); // a0 === a1 → 整圆
    for (let k = 0; k < 8; k++) {
      const ang = (TAU * k) / 8;
      expect(pickEntity({ x: 10 * Math.cos(ang), y: 10 * Math.sin(ang) }, 1)).toBe(full);
    }
  });
});

describe('圆弧端点就是普通点', () => {
  it('pickPoint 命中圆心与起点/终点；pickEntity 仍按弧段命中', () => {
    const center = addPt(0, 0);
    const arc = addArcByAngles(center, 10, 0, Math.PI / 2);
    const g = arcGeometry(arc);
    if (!g) throw new Error('圆弧引用缺失');
    expect(pickPoint(g.start, 1)).toBe(g.start);
    expect(pickPoint(g.end, 1)).toBe(g.end);
    expect(pickPoint(center, 1)).toBe(center);
    // 端点上既有点又有弧：拾取层先返回点（选择语义再由 selection.clickSelect 决定）
    expect(pickPoint({ x: 10, y: 0 }, 1)).toBe(g.start);
    expect(pickEntity({ x: 10, y: 0 }, 1)).toBe(arc);
  });

  it('computeSnap 在圆弧端点仍按最高优先级的「已有点」返回', () => {
    const center = addPt(0, 0);
    const arc = addArcByAngles(center, 10, 0, Math.PI / 2);
    const g = arcGeometry(arc);
    if (!g) throw new Error('圆弧引用缺失');
    const snap = computeSnap({ x: g.end.x + 1, y: g.end.y + 1 }, 1);
    expect(snap?.pt).toBe(g.end);
    expect(snap?.pri).toBe(SNAP_PRIORITY.point);
  });
});

describe('computeSnap 优先级', () => {
  it('已有点优先于网格', () => {
    const p = addPt(0, 0);
    const snap = computeSnap({ x: 1, y: 1 }, 1);
    expect(snap?.pri).toBe(SNAP_PRIORITY.point);
    expect(snap?.pt).toBe(p);
  });

  it('中点优先于线上点', () => {
    addLine(addPt(0, 0), addPt(100, 0));
    const snap = computeSnap({ x: 50, y: 1 }, 1);
    expect(snap?.pri).toBe(SNAP_PRIORITY.mid);
    expect(snap?.pos.x).toBeCloseTo(50, 12);
    expect(snap?.pos.y).toBeCloseTo(0, 12);
  });

  it('曲线上点优先于网格', () => {
    addCircle(addPt(50, 50), 30);
    const snap = computeSnap({ x: 50, y: 80 }, 1);
    expect(snap?.pri).toBe(SNAP_PRIORITY.curve);
    expect(snap?.pos.x).toBeCloseTo(50, 12);
    expect(snap?.pos.y).toBeCloseTo(80, 12);
  });

  it('线上任意点优先于网格（端点/中点都被排除后）', () => {
    addLine(addPt(0, 0), addPt(100, 0));
    const snap = computeSnap({ x: 20, y: 0 }, 1);
    expect(snap?.pri).toBe(SNAP_PRIORITY.on);
    expect(snap?.pos).toEqual({ x: 20, y: 0 });
  });

  it('无几何可吸附时回退到网格，且网格容差打了折扣', () => {
    const snap = computeSnap({ x: 23, y: 17 }, 1);
    expect(snap?.pri).toBe(SNAP_PRIORITY.grid);
    expect(snap?.pos).toEqual({ x: 20, y: 20 });
    // 折扣后的网格容差 = SNAP_PX * SNAP_GRID_FACTOR，更远就不吸附
    expect(computeSnap({ x: 23, y: 20 + SNAP_PX }, 1)).toBeNull();
  });

  it('吸附总开关由调用方（selection.updateHover）决定，computeSnap 本身不读 state', () => {
    addPt(0, 0);
    state.snapEnabled = false;
    expect(computeSnap({ x: 0, y: 0 }, 1)?.pri).toBe(SNAP_PRIORITY.point);
  });
});

describe('sketchBounds', () => {
  it('空模型返回 null', () => {
    expect(sketchBounds()).toBeNull();
  });

  it('直线包围盒 = 端点范围 + 留白（最长边 × padRatio + BBOX_PAD_MIN）', () => {
    addLine(addPt(0, 0), addPt(10, 0));
    expect(sketchBounds()).toEqual({
      minx: -1.5,
      miny: -1.5,
      maxx: 11.5,
      maxy: 1.5,
      bw: 13,
      bh: 3,
    });
  });

  it('圆弧按弧段紧包围盒，整圆弧按整圆', () => {
    const center = addPt(0, 0);
    addArcByAngles(center, 10, 0, Math.PI / 2);
    // 弧段边界含 0 / π/2 两个方向的三角值，用 closeTo 避免浮点末位差异
    const bb = sketchBounds();
    expect(bb?.minx).toBeCloseTo(-1.5, 12);
    expect(bb?.miny).toBeCloseTo(-1.5, 12);
    expect(bb?.maxx).toBeCloseTo(11.5, 12);
    expect(bb?.maxy).toBeCloseTo(11.5, 12);
    expect(bb?.bw).toBeCloseTo(13, 12);
    expect(bb?.bh).toBeCloseTo(13, 12);

    clearModel();
    const c2 = addPt(0, 0);
    addArcByAngles(c2, 10, 0, 0); // 整圆
    expect(sketchBounds()).toEqual({
      minx: -12,
      miny: -12,
      maxx: 12,
      maxy: 12,
      bw: 24,
      bh: 24,
    });
  });

  it('圆按整圆包围盒', () => {
    addCircle(addPt(5, 5), 10);
    const bb = sketchBounds();
    expect(bb).not.toBeNull();
    expect(bb?.bw).toBeCloseTo(24, 12);
    expect(bb?.minx).toBeCloseTo(-7, 12);
  });

  it('多图元取并集', () => {
    addCircle(addPt(0, 0), 10);
    addLine(addPt(20, 0), addPt(40, 0));
    const bb = sketchBounds();
    expect(bb?.minx).toBeLessThan(-10);
    expect(bb?.maxx).toBeGreaterThan(40);
  });
});

describe('矩形与线段判定', () => {
  it('rectOf 规范化两个对角点', () => {
    expect(rectOf({ x: 10, y: 20 }, { x: -5, y: 0 })).toEqual({
      minx: -5,
      miny: 0,
      maxx: 10,
      maxy: 20,
    });
  });

  it('pointInRect 含边界', () => {
    const r = { minx: 0, miny: 0, maxx: 10, maxy: 10 };
    expect(pointInRect({ x: 0, y: 0 }, r)).toBe(true);
    expect(pointInRect({ x: 10, y: 10 }, r)).toBe(true);
    expect(pointInRect({ x: -0.1, y: 5 }, r)).toBe(false);
    expect(pointInRect({ x: 5, y: 10.1 }, r)).toBe(false);
  });

  it('distToSeg 处理垂足在段内/外与退化线段', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 0 };
    expect(distToSeg({ x: 5, y: 3 }, a, b)).toBe(3);
    expect(distToSeg({ x: 15, y: 0 }, a, b)).toBe(5);
    expect(distToSeg({ x: 4, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 })).toBe(3);
  });

  it('entityCrossesRect 与 entityInsideRect', () => {
    const r = { minx: -50, miny: -50, maxx: 50, maxy: 50 };
    const lineCrossing = addLine(addPt(-100, 0), addPt(0, 0));
    const lineInside = addLine(addPt(-10, 0), addPt(10, 0));
    expect(entityCrossesRect(lineCrossing, r)).toBe(true);
    expect(entityInsideRect(lineCrossing, r)).toBe(false);
    expect(entityCrossesRect(lineInside, r)).toBe(true);
    expect(entityInsideRect(lineInside, r)).toBe(true);

    const circleFar = addCircle(addPt(0, 0), 60);
    const small = { minx: -10, miny: -10, maxx: 10, maxy: 10 };
    expect(entityCrossesRect(circleFar, small)).toBe(false);
    expect(entityInsideRect(circleFar, small)).toBe(false);

    clearModel();
    const circleInside = addCircle(addPt(0, 0), 10);
    expect(entityInsideRect(circleInside, small)).toBe(true);
    expect(entityInsideRect(circleInside, r)).toBe(true);
  });
});

describe('引用悬空时的容错', () => {
  it('图元引用不存在的点时被跳过而不是抛错', () => {
    // 绕过 model 的级联保证，把已有图元改成悬空引用，模拟异常数据（这里只测几何容错）
    const line = addLine(addPt(0, 0), addPt(1, 1));
    line.a = 999;
    line.b = 998;
    expect(sketchBounds()).toBeNull();
    expect(entityInsideRect(line, { minx: 0, miny: 0, maxx: 1, maxy: 1 })).toBe(false);
  });
});
