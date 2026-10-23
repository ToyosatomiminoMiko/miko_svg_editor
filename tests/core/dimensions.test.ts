/**
 * dimensions.ts 的尺寸取值/设值/文案/布局/命中/拖拽。
 * 用假 CameraView + 假 MeasureText 注入，覆盖纯逻辑路径：
 * 布局是屏幕坐标（world → screen 由 w2s 快照换算），renderer / pickDim / applyDimDrag 共用同一份布局。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  DIM_META,
  applyDimDrag,
  dimHitDistance,
  dimKindOf,
  dimLabel,
  dimLayout,
  dimText,
  dimValidationError,
  dimValue,
  findAngleDim,
  findDimForEntity,
  findDistanceDim,
  isDimConstraint,
  pickDim,
  setDimValue,
  angleLineGeometry,
  angleSectorAt,
  angleSectorDegrees,
} from '../../src/core/dimensions';
import type { DimConstraint } from '../../src/core/dimensions';
import type { CameraView } from '../../src/core/camera';
import {
  DIM_LEADER_GAP_PX,
  DIM_PICK_PX,
  DIM_TEXT_GAP_PX,
  TEXT_FALLBACK_FONT_PX,
} from '../../src/config';
import { addCircle, addCon, addLine, addPt, clearModel, getEntity } from '../../src/core/model';
import type { MeasureText } from '../../src/core/types';
import { addArcByAngles } from './fixtures';

/** 假相机：世界原点在屏幕 (400,300)，zoom=1 */
const view: CameraView = { x: 0, y: 0, z: 1, viewportW: 800, viewportH: 600 };

/** 假文本测量：每字符 10px（与字号 12 无关，便于手算命中框） */
const measure: MeasureText = (text) => text.length * 10;

const FONT = '12px sans-serif';

const close = (a: number, b: number, digits = 6): void => expect(a).toBeCloseTo(b, digits);

beforeEach(() => {
  clearModel();
});

/* ---------------- fixture ---------------- */

/** 水平直线 A(0,0) → B(100,0) + 距离尺寸；offset 是世界偏移（默认 20） */
function distanceFixture(offset = 20): {
  a: ReturnType<typeof addPt>;
  b: ReturnType<typeof addPt>;
  con: DimConstraint;
} {
  const a = addPt(0, 0);
  const b = addPt(100, 0);
  addLine(a, b);
  const con = addCon('distancePointPoint', { a: a.id, b: b.id, distance: 100, offset });
  if (!isDimConstraint(con)) throw new Error('测试 fixture 建距离尺寸失败');
  return { a, b, con };
}

/** 圆 (0,0) r=30 + 半径尺寸（不指定引线方向，走缺省 -45°） */
function circleFixture(): DimConstraint {
  const center = addPt(0, 0);
  const circle = addCircle(center, 30);
  const con = addCon('radius', { e: circle.id, radius: 30 });
  if (!isDimConstraint(con)) throw new Error('测试 fixture 建半径尺寸失败');
  return con;
}

/**
 * 两条 45° 夹角的直线：line1 沿 +x，line2 沿 +45°；顶点在 (0,0)。
 * 两条线各自拥有独立的端点（intersection 由布局求交得到，不要求共享点）。
 */
function angleFixture(): {
  line1: ReturnType<typeof addLine>;
  line2: ReturnType<typeof addLine>;
  con: DimConstraint;
} {
  const line1 = addLine(addPt(0, 0), addPt(100, 0));
  const line2 = addLine(addPt(0, 0), addPt(100, 100));
  const con = addCon('angleLineLine', {
    e1: line1.id,
    e2: line2.id,
    angle: 45,
    offset: 20,
    angleSector: 0,
  });
  if (!isDimConstraint(con)) throw new Error('测试 fixture 建角度尺寸失败');
  return { line1, line2, con };
}

/* ======================= 取值 / 设值 / 文案 ======================= */

describe('取值 / 设值 / 文案', () => {
  it('距离尺寸：value/setValue/label/text', () => {
    const { con } = distanceFixture();
    expect(isDimConstraint(con)).toBe(true);
    expect(dimKindOf(con)).toBe('distancePointPoint');
    expect(dimValue(con)).toBe(100);
    setDimValue(con, 42.5);
    expect(dimValue(con)).toBe(42.5);
    expect(dimLabel(con)).toBe('距离');
    expect(dimLabel('distancePointPoint')).toBe('距离');
    expect(dimText(con)).toBe('42.5');
  });

  it('半径尺寸：文案带 R，数值保留全精度', () => {
    const con = circleFixture();
    expect(dimKindOf(con)).toBe('radius');
    expect(dimValue(con)).toBe(30);
    expect(dimText(con)).toBe('R30');
    setDimValue(con, 12.345);
    expect(dimValue(con)).toBe(12.345);
    expect(dimLabel(con)).toBe('半径');
    // 显示两位小数，但存储/回填仍是 12.345
    expect(dimText(con)).toBe('R12.35');
  });

  it('角度尺寸：以度存/显示，文案带 °', () => {
    const { con } = angleFixture();
    expect(dimKindOf(con)).toBe('angleLineLine');
    expect(dimValue(con)).toBe(45);
    expect(dimLabel(con)).toBe('角度');
    expect(dimText(con)).toBe('45°');
    setDimValue(con, 60.5);
    expect(dimValue(con)).toBe(60.5);
    expect(dimText(con)).toBe('60.5°');
  });

  it('角度输入校验：必须小于 180°', () => {
    const { con } = angleFixture();
    expect(dimValidationError(con, 45)).toBeUndefined();
    expect(dimValidationError(con, 179.99)).toBeUndefined();
    expect(dimValidationError(con, 180)).toBe('角度必须小于 180°');
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

  it('DIM_META 覆盖三种尺寸，且每条都有完整能力', () => {
    expect(Object.keys(DIM_META).sort()).toEqual(['angleLineLine', 'distancePointPoint', 'radius']);
    for (const meta of Object.values(DIM_META)) {
      expect(meta.label.length).toBeGreaterThan(0);
      expect(typeof meta.value).toBe('function');
      expect(typeof meta.setValue).toBe('function');
      expect(typeof meta.text).toBe('function');
      expect(typeof meta.layout).toBe('function');
      expect(typeof meta.drag).toBe('function');
      expect(typeof meta.matchesEntity).toBe('function');
    }
  });
});

/* ======================= 距离尺寸布局 ======================= */

describe('距离尺寸布局', () => {
  it('界线 + 尺寸线 + 两端箭头 + 文字，全部是屏幕坐标', () => {
    const { con } = distanceFixture(20);
    const layout = dimLayout(con, view);
    expect(layout).not.toBeNull();
    if (!layout) throw new Error('布局为空');

    expect(layout.kind).toBe('distancePointPoint');
    // 两道界线：A(400,300)→A2(400,320)、B(500,300)→B2(500,320)；尺寸线 A2→B2
    expect(layout.segments).toEqual([
      { a: { x: 400, y: 300 }, b: { x: 400, y: 320 }, extension: true },
      { a: { x: 500, y: 300 }, b: { x: 500, y: 320 }, extension: true },
      { a: { x: 400, y: 320 }, b: { x: 500, y: 320 } },
    ]);
    expect(layout.text.text).toBe('100');
    expect(layout.text.pos).toEqual({ x: 450, y: 320 - DIM_TEXT_GAP_PX });
    expect(layout.text.align).toBe('center');
    expect(layout.text.baseline).toBe('bottom');
    // 箭头在尺寸线两端、指向界线（彼此背离）
    expect(layout.arrows).toHaveLength(2);
    expect(layout.arrows[0]?.tip).toEqual({ x: 400, y: 320 });
    expect(layout.arrows[0]?.dir.x).toBeCloseTo(-1, 12);
    expect(layout.arrows[1]?.tip).toEqual({ x: 500, y: 320 });
    expect(layout.arrows[1]?.dir.x).toBeCloseTo(1, 12);
  });

  it('缩放改变 offset 的屏幕长度，但世界 offset 不变', () => {
    const { con } = distanceFixture(20);
    const zoomed: CameraView = { ...view, z: 2 };
    const layout = dimLayout(con, zoomed);
    if (!layout) throw new Error('布局为空');
    const seg = layout.segments[2];
    expect(seg?.a.y).toBe(340);
    expect(seg?.b.y).toBe(340);
    expect(layout.text.text).toBe('100');
  });

  it('负 offset 落在连线另一侧', () => {
    const { con } = distanceFixture(-10);
    const layout = dimLayout(con, view);
    if (!layout) throw new Error('布局为空');
    expect(layout.segments[2]?.a.y).toBe(290);
  });
});

/* ======================= 半径尺寸布局 ======================= */

describe('半径尺寸布局', () => {
  it('圆心十字 + 圆心到弧的引线 + 弧上的箭头，文字在箭头外侧', () => {
    const con = circleFixture();
    const layout = dimLayout(con, view);
    expect(layout).not.toBeNull();
    if (!layout) throw new Error('布局为空');

    expect(layout.kind).toBe('radius');
    // 缺省引线方向 -45°：从圆心 (400,300) 指向圆周 (400+30/√2, 300-30/√2)
    const tip = layout.arrows[0]?.tip;
    if (!tip) throw new Error('缺少箭头');
    close(tip.x, 400 + 30 * Math.SQRT1_2);
    close(tip.y, 300 - 30 * Math.SQRT1_2);
    // 引线是圆心 → 箭头落点
    expect(layout.segments[0]?.a).toEqual({ x: 400, y: 300 });
    expect(layout.segments[0]?.b).toEqual(tip);
    // 箭头方向朝弧外（圆心 → 弧），与引线同向
    const dir = layout.arrows[0]?.dir;
    if (!dir) throw new Error('缺少箭头方向');
    close(dir.x, Math.SQRT1_2);
    close(dir.y, -Math.SQRT1_2);
    // 文字：箭头外侧一个 gap，水平向右 → 左对齐
    expect(layout.text.text).toBe('R30');
    expect(layout.text.align).toBe('left');
    close(layout.text.pos.x, tip.x + dir.x * DIM_LEADER_GAP_PX);
    close(layout.text.pos.y, tip.y + dir.y * DIM_LEADER_GAP_PX);
    // 圆心十字：横竖各一段
    expect(layout.segments).toHaveLength(3);
  });

  it('圆弧半径：缺省引线指向弧中点', () => {
    const center = addPt(0, 0);
    const arc = addArcByAngles(center, 30, 0, Math.PI / 2);
    const con = addCon('radius', { e: arc.id, radius: 30 });
    if (!isDimConstraint(con)) throw new Error('测试 fixture 建半径尺寸失败');
    const layout = dimLayout(con, view);
    const tip = layout?.arrows[0]?.tip;
    if (!tip) throw new Error('缺少箭头');
    close(tip.x, 400 + 30 * Math.cos(Math.PI / 4));
    close(tip.y, 300 + 30 * Math.sin(Math.PI / 4));
  });

  it('圆弧半径：引线方向被夹到弧段内（最近的端点）', () => {
    const center = addPt(0, 0);
    const arc = addArcByAngles(center, 30, 0, Math.PI / 2);
    const con = addCon('radius', { e: arc.id, radius: 30, leaderAngle: Math.PI });
    if (!isDimConstraint(con)) throw new Error('测试 fixture 建半径尺寸失败');
    const tip = dimLayout(con, view)?.arrows[0]?.tip;
    if (!tip) throw new Error('缺少箭头');
    // 从 π 夹到弧的终点 π/2（比起点 0 更近）
    close(tip.x, 400);
    close(tip.y, 330);
  });

  it('缩放后引线长度按 zoom 换算，文字间距仍是屏幕像素', () => {
    const con = circleFixture();
    const zoomed: CameraView = { ...view, z: 2 };
    const tip = dimLayout(con, zoomed)?.arrows[0]?.tip;
    if (!tip) throw new Error('缺少箭头');
    close(tip.x, 400 + 60 * Math.SQRT1_2);
    close(tip.y, 300 - 60 * Math.SQRT1_2);
    expect(dimLayout(con, zoomed)?.text.pos.x).toBeCloseTo(
      tip.x + Math.SQRT1_2 * DIM_LEADER_GAP_PX,
      9,
    );
  });
});

/* ======================= 角度尺寸布局 ======================= */

describe('角度尺寸布局', () => {
  it('顶点 + 圆弧 + 两道界线 + 切向箭头 + 角平分线外侧文字', () => {
    const { con } = angleFixture();
    const layout = dimLayout(con, view);
    expect(layout).not.toBeNull();
    if (!layout) throw new Error('布局为空');

    expect(layout.kind).toBe('angleLineLine');
    expect(layout.arcs).toHaveLength(1);
    const arc = layout.arcs[0];
    if (!arc) throw new Error('缺少圆弧');
    expect(arc.center).toEqual({ x: 400, y: 300 });
    close(arc.radius, 20);
    close(arc.start, 0);
    close(arc.sweep, Math.PI / 4);

    // 界线：顶点 → 圆弧两端
    expect(layout.segments[0]?.a).toEqual({ x: 400, y: 300 });
    close(layout.segments[0]?.b.x ?? 0, 420);
    close(layout.segments[0]?.b.y ?? 0, 300);
    close(layout.segments[1]?.b.x ?? 0, 400 + 20 * Math.SQRT1_2);
    close(layout.segments[1]?.b.y ?? 0, 300 + 20 * Math.SQRT1_2);

    // 文字在 22.5° 角平分线外侧（R + gap + 半个字高）
    const textR = 20 + DIM_TEXT_GAP_PX + TEXT_FALLBACK_FONT_PX / 2;
    close(layout.text.pos.x, 400 + textR * Math.cos(Math.PI / 8));
    close(layout.text.pos.y, 300 + textR * Math.sin(Math.PI / 8));
    expect(layout.text.text).toBe('45°');
    expect(layout.text.align).toBe('center');

    // 箭头：起点背向弧内（屏幕上），终点沿弧行进方向（屏幕左下）
    const [startArrow, endArrow] = layout.arrows;
    if (!startArrow || !endArrow) throw new Error('缺少箭头');
    close(startArrow.dir.x, 0);
    close(startArrow.dir.y, -1);
    close(endArrow.dir.x, -Math.SQRT1_2);
    close(endArrow.dir.y, Math.SQRT1_2);
  });

  it('象限位决定画哪一对射线', () => {
    const { con } = angleFixture();
    con.angleSector = 2; // 反向直线 1、保留直线 2 → 135° 扇形
    const layout = dimLayout(con, view);
    const arc = layout?.arcs[0];
    if (!arc) throw new Error('缺少圆弧');
    close(Math.abs(arc.sweep), (Math.PI * 3) / 4);
    expect(layout?.text.text).toBe('45°'); // 文案是约束目标，不由象限推导
  });

  it('平行线不画角度尺寸（无稳定顶点）', () => {
    const line1 = addLine(addPt(0, 0), addPt(100, 0));
    const line2 = addLine(addPt(0, 10), addPt(100, 10));
    const con = addCon('angleLineLine', { e1: line1.id, e2: line2.id, angle: 0, offset: 20 });
    if (!isDimConstraint(con)) throw new Error('测试 fixture 建角度尺寸失败');
    expect(dimLayout(con, view)).toBeNull();
  });
});

/* ======================= 命中 ======================= */

describe('pickDim 命中', () => {
  it('距离尺寸：命中文字框、尺寸线；超出容差不命中', () => {
    const { con } = distanceFixture();
    // 文字框中心：屏幕 (450, 316) → 世界 (50,16)
    expect(pickDim({ x: 50, y: 16 }, view, measure, FONT)).toBe(con);
    // 尺寸线 y=320 → 世界 (50,20)
    expect(pickDim({ x: 50, y: 20 }, view, measure, FONT)).toBe(con);
    expect(pickDim({ x: 50, y: 40 }, view, measure, FONT)).toBeNull();
    expect(DIM_PICK_PX).toBeGreaterThan(0);
  });

  it('半径尺寸：命中引线、箭头附近与文字', () => {
    const con = circleFixture();
    // 引线中点：屏幕 (400+15/√2, 300-15/√2) → 世界 (10.6,-10.6)
    const mid = { x: 15 * Math.SQRT1_2, y: -15 * Math.SQRT1_2 };
    expect(pickDim(mid, view, measure, FONT)).toBe(con);
    // 文字在箭头外侧：屏幕约 (426.9,273.1)，宽 30、框高 12 → 世界 (30,-25) 命中
    expect(pickDim({ x: 30, y: -25 }, view, measure, FONT)).toBe(con);
    // 圆心十字也参与命中
    expect(pickDim({ x: 2, y: 0 }, view, measure, FONT)).toBe(con);
  });

  it('角度尺寸：命中圆弧与文字', () => {
    const { con } = angleFixture();
    // 圆弧中点：22.5°、半径 20（世界 = 屏幕 - (400,300)）
    const ang = Math.PI / 8;
    expect(pickDim({ x: 20 * Math.cos(ang), y: 20 * Math.sin(ang) }, view, measure, FONT)).toBe(
      con,
    );
    // 角平分线外侧的文字中心：文字宽 30、框高 12，中心即锚点（baseline middle）
    const textR = 20 + DIM_TEXT_GAP_PX + TEXT_FALLBACK_FONT_PX / 2;
    expect(
      pickDim({ x: textR * Math.cos(ang), y: textR * Math.sin(ang) }, view, measure, FONT),
    ).toBe(con);
  });

  it('非尺寸约束不参与命中', () => {
    const a = addPt(0, 0);
    const b = addPt(10, 0);
    const line = addLine(a, b);
    addCon('horizontal', { e: line.id });
    expect(pickDim({ x: 5, y: 0 }, view, measure, FONT)).toBeNull();
  });

  it('dimHitDistance：命中尺寸线距离为 0', () => {
    const { con } = distanceFixture();
    const layout = dimLayout(con, view);
    if (!layout) throw new Error('布局为空');
    expect(dimHitDistance(layout, measure, FONT, { x: 450, y: 320 })).toBe(0);
  });
});

/* ======================= 拖拽 ======================= */

describe('applyDimDrag 拖拽摆放', () => {
  it('距离：法向投影成为新的世界 offset（可翻到另一侧）', () => {
    const { con } = distanceFixture();
    applyDimDrag(con, { x: 50, y: 35 }, view);
    expect(con.offset).toBe(35);
    applyDimDrag(con, { x: 50, y: -15 }, view);
    expect(con.offset).toBe(-15);
  });

  it('半径：拖动只旋转引线方向，不改半径目标值', () => {
    const con = circleFixture();
    applyDimDrag(con, { x: 0, y: 10 }, view);
    expect(con.radius).toBe(30);
    expect(con.leaderAngle).toBeCloseTo(Math.PI / 2, 12);
    const tip = dimLayout(con, view)?.arrows[0]?.tip;
    if (!tip) throw new Error('缺少箭头');
    close(tip.x, 400);
    close(tip.y, 330);
  });

  it('半径：拖动到圆弧外时引线贴住最近的弧端点', () => {
    const center = addPt(0, 0);
    const arc = addArcByAngles(center, 30, 0, Math.PI / 2);
    const con = addCon('radius', { e: arc.id, radius: 30 });
    if (!isDimConstraint(con)) throw new Error('测试 fixture 建半径尺寸失败');
    applyDimDrag(con, { x: 0, y: 10 }, view); // 弧外（π/2 之后）
    expect(con.leaderAngle).toBeCloseTo(Math.PI / 2, 12);
  });

  it('角度：拖远改弧半径，拖到另一个扇形改象限并把目标角取补角', () => {
    const { con } = angleFixture();
    applyDimDrag(con, { x: 30, y: 10 }, view);
    expect(con.angleSector).toBe(0);
    expect(con.angle).toBe(45);
    close(con.offset ?? 0, Math.hypot(30, 10));

    applyDimDrag(con, { x: -10, y: 10 }, view);
    expect(con.angleSector).toBe(1);
    expect(con.angle).toBe(135);
    close(con.offset ?? 0, Math.hypot(10, 10));
  });

  it('角度：拖到顶点附近不改象限、弧半径有最小屏幕下限', () => {
    const { con } = angleFixture();
    applyDimDrag(con, { x: 1, y: 1 }, view);
    expect(con.angleSector).toBe(0);
    expect(con.angle).toBe(45);
    close(con.offset ?? 0, 12); // DIM_MIN_ARC_PX / zoom
  });
});

/* ======================= 按图元/点/直线对查已有尺寸 ======================= */

describe('按对象查已有尺寸', () => {
  it('findDimForEntity：直线匹配两端点（顺序无关）', () => {
    const a = addPt(0, 0);
    const b = addPt(100, 0);
    const line = addLine(a, b);
    const con = addCon('distancePointPoint', {
      a: b.id,
      b: a.id,
      distance: 100,
      offset: 20,
    });
    expect(findDimForEntity(line)).toBe(con);
  });

  it('findDimForEntity：圆匹配半径尺寸', () => {
    const circle = addCircle(addPt(0, 0), 10);
    const con = addCon('radius', { e: circle.id, radius: 10 });
    expect(findDimForEntity(circle)).toBe(con);
  });

  it('findDimForEntity：角度尺寸不按单条直线命中（同一线可同时有长度与角度）', () => {
    const { line1 } = angleFixture();
    expect(findDimForEntity(line1)).toBeUndefined();
  });

  it('findDistanceDim 顺序无关，忽略类型不符的约束', () => {
    const a = addPt(0, 0);
    const b = addPt(100, 0);
    addLine(a, b);
    const con = addCon('distancePointPoint', { a: a.id, b: b.id, distance: 100, offset: 0 });
    expect(findDistanceDim(a.id, b.id)).toBe(con);
    expect(findDistanceDim(b.id, a.id)).toBe(con);
    expect(findDistanceDim(a.id, 999)).toBeUndefined();
  });

  it('findAngleDim 顺序无关', () => {
    const { line1, line2, con } = angleFixture();
    expect(findAngleDim(line1.id, line2.id)).toBe(con);
    expect(findAngleDim(line2.id, line1.id)).toBe(con);
    expect(findAngleDim(line1.id, 999)).toBeUndefined();
    expect(getEntity(line1.id)).toBeDefined();
  });
});

/* ======================= 角度几何辅助 ======================= */

describe('角度几何辅助', () => {
  it('angleLineGeometry：求交点与方向；平行返回 null', () => {
    const line1 = addLine(addPt(0, 0), addPt(100, 0));
    const line2 = addLine(addPt(100, -50), addPt(100, 50));
    const g = angleLineGeometry(line1, line2);
    if (!g) throw new Error('应能求交');
    close(g.vertex.x, 100);
    close(g.vertex.y, 0);

    const parallel = addLine(addPt(0, 10), addPt(100, 10));
    expect(angleLineGeometry(line1, parallel)).toBeNull();
  });

  it('angleSectorAt / angleSectorDegrees：四个扇形互不重叠且铺满整圈', () => {
    const line1 = addLine(addPt(0, 0), addPt(100, 0));
    const line2 = addLine(addPt(0, 0), addPt(100, 100));
    const g = angleLineGeometry(line1, line2);
    if (!g) throw new Error('应能求交');
    const points = [
      { x: 10, y: 1 },
      { x: -10, y: 1 },
      { x: -10, y: -1 },
      { x: 10, y: -1 },
    ];
    const sectors = points.map((p) => angleSectorAt(g, p));
    expect(new Set(sectors).size).toBe(4);
    expect(angleSectorDegrees(g, 0)).toBeCloseTo(45, 9);
    expect(angleSectorDegrees(g, 1) + angleSectorDegrees(g, 0)).toBeCloseTo(180, 9);
  });
});

/* ======================= 全精度与显示精度分离 ======================= */

describe('全精度与显示精度分离', () => {
  it('dimValue 保留输入全精度，只有 dimText 按小数位截断', () => {
    const { con } = distanceFixture();
    setDimValue(con, 12.345);
    expect(dimValue(con)).toBe(12.345);
    expect(dimText(con)).toBe('12.35');
    expect(dimLayout(con, view)?.text.text).toBe('12.35');
  });
});
