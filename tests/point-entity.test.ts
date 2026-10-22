/**
 * 点图元（PointEntity）的生命周期、几何/拾取、导出、选择与工具行为。
 * 点图元不是新的求解自由度：坐标仍在被引用的 Point 上，点图元只把「这个点是图元」
 * 这件事放进模型，因此本文件重点钉住它进入其它模块后必须保持一致的三条边界：
 * 1) 同一个点只能有一个身份：被点图元拥有时按 ent 选中（pickPoint 跳过、框选不重复、
 *    渲染交给 drawEntity），未被拥有时仍按 pt 选中；
 * 2) 删除级联沿用「共享端点保留」的原则：删线不能删掉被点图元拥有的端点，
 *    删点图元也不能删掉仍被直线使用的点；
 * 3) 导出/包围盒工具（dim）把点图元当零尺寸图元处理，不能因为退化矩形而消失或算出 NaN。
 * 每个用例先 clearModel()/resetInteraction()，避免单例模型与交互状态在测试间污染。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { cam } from '../src/camera';
import type { CameraView } from '../src/camera';
import { BBOX_PAD_MIN, PICK_POINT_PX, SNAP_PRIORITY } from '../src/config';
import { dimValue } from '../src/dimensions';
import { buildSVG } from '../src/export-svg';
import {
  computeSnap,
  entityCrossesRect,
  entityInsideRect,
  pickEntity,
  pickPoint,
  sketchBounds,
} from '../src/geometry';
import {
  addCon,
  addLine,
  addPointEntity,
  addPt,
  clearModel,
  getEntity,
  getPoint,
  model,
  ownedPointIds,
  pointEntityOf,
  pruneOrphanPoints,
  removeEntity,
  removePoint,
} from '../src/model';
import {
  applyMarquee,
  clickSelect,
  isPointSelected,
  selectedEntities,
  selectedPoints,
  selectionDragPoints,
  selectionEntries,
} from '../src/selection';
import { createPoint, dimForEntity, toolClick } from '../src/sketch-actions';
import { resetInteraction, selectOnly, state } from '../src/state';
import type { Marquee, MeasureText, Point, SelectionItem, Snap } from '../src/types';

const view: CameraView = { x: 0, y: 0, z: 1, viewportW: 800, viewportH: 600 };
const measure: MeasureText = (text) => text.length * 10;
const FONT = '12px sans-serif';

const entItem = (id: number): SelectionItem => ({ kind: 'ent', id });
const ptItem = (id: number): SelectionItem => ({ kind: 'pt', id });
const snapAt = (pt: Point): Snap => ({
  pos: { x: pt.x, y: pt.y },
  pt,
  d: 0,
  pri: SNAP_PRIORITY.point,
});
const gridSnap = (x: number, y: number): Snap => ({
  pos: { x, y },
  d: 1,
  pri: SNAP_PRIORITY.grid,
});

const entIds = (): number[] =>
  state.selection.items.filter((item) => item.kind === 'ent').map((item) => item.id);
const ptIds = (): number[] =>
  state.selection.items.filter((item) => item.kind === 'pt').map((item) => item.id);

/** 世界矩形 [-50,50]² 对应的窗口框选（屏幕 800×600、zoom=1、原点居中） */
const windowMarquee: Marquee = {
  s0: { x: 350, y: 250 },
  currentS: { x: 450, y: 350 },
  active: true,
  add: false,
};

beforeEach(() => {
  clearModel();
  resetInteraction();
  cam.x = 0;
  cam.y = 0;
  cam.z = 1;
  cam.viewportW = 800;
  cam.viewportH = 600;
  state.snapEnabled = true;
});

describe('点图元生命周期', () => {
  it('addPointEntity 把已有点包成点图元，pointEntityOf / ownedPointIds 可反查', () => {
    const p = addPt(3, 4);
    const e = addPointEntity(p);

    expect(e.type).toBe('point');
    expect(e.p).toBe(p.id);
    expect(e.construction).toBe(false);
    expect(getEntity(e.id)).toBe(e);
    expect(pointEntityOf(p.id)).toBe(e);
    expect(pointEntityOf(999)).toBeUndefined();
    expect(ownedPointIds()).toEqual(new Set([p.id]));
  });

  it('删点图元：级联删掉它的点与引用该点的约束；只被约束引用的点也被清掉', () => {
    const p = addPt(0, 0);
    const q = addPt(10, 0);
    const e = addPointEntity(p);
    const con = addCon('coincident', { a: p.id, b: q.id });

    removeEntity(e);

    expect(getEntity(e.id)).toBeUndefined();
    expect(model.ents.size).toBe(0);
    expect(getPoint(p.id)).toBeUndefined();
    expect(model.cons.has(con.id)).toBe(false);
    // q 只被这条约束引用，删约束后成为孤立点，由 pruneOrphanPoints 兜底清掉
    expect(getPoint(q.id)).toBeUndefined();
    expect(model.pts.size).toBe(0);
  });

  it('删点图元但点被直线共享：保留点与引用该点的约束，只删图元身份', () => {
    const p = addPt(0, 0);
    const q = addPt(100, 0);
    const line = addLine(p, q);
    const e = addPointEntity(p);
    const con = addCon('coincident', { a: p.id, b: q.id });

    removeEntity(e);

    expect(getEntity(e.id)).toBeUndefined();
    expect(getEntity(line.id)).toBe(line);
    expect(getPoint(p.id)).toBe(p);
    expect(getPoint(q.id)).toBe(q);
    expect(ownedPointIds().has(p.id)).toBe(false);
    expect(model.cons.has(con.id)).toBe(true);
  });

  it('删线：被点图元拥有的端点保留，另一端点随线删除', () => {
    const a = addPt(0, 0);
    const b = addPt(100, 0);
    const line = addLine(a, b);
    const e = addPointEntity(a);
    const horizontal = addCon('horizontal', { e: line.id });

    removeEntity(line);

    expect(getEntity(line.id)).toBeUndefined();
    expect(model.cons.has(horizontal.id)).toBe(false);
    expect(getEntity(e.id)).toBe(e);
    expect(getPoint(a.id)).toBe(a);
    expect(getPoint(b.id)).toBeUndefined();
    expect(pointEntityOf(a.id)).toBe(e);
  });

  it('pruneOrphanPoints 保留被点图元拥有的点，只清真正孤立的点', () => {
    const owned = addPt(0, 0);
    addPointEntity(owned);
    const orphan = addPt(10, 10);

    pruneOrphanPoints();

    expect(getPoint(owned.id)).toBe(owned);
    expect(getPoint(orphan.id)).toBeUndefined();
  });

  it('removePoint：递归删掉拥有它的点图元以及引用它的直线', () => {
    const p = addPt(0, 0);
    const q = addPt(100, 0);
    const e = addPointEntity(p);
    const line = addLine(p, q);

    removePoint(p);

    expect(getEntity(e.id)).toBeUndefined();
    expect(getEntity(line.id)).toBeUndefined();
    expect(model.ents.size).toBe(0);
    expect(model.pts.size).toBe(0);
  });

  it('删除工具点中点图元：按图元身份级联删除点本身', () => {
    const p = addPt(0, 0);
    const e = addPointEntity(p);

    const outcome = toolClick('erase', null, { x: 0, y: 0 }, null, view, measure, FONT);

    expect(outcome.action?.ok).toBe(true);
    expect(getEntity(e.id)).toBeUndefined();
    expect(getPoint(p.id)).toBeUndefined();
  });
});

describe('点图元的几何与拾取', () => {
  it('pickPoint 跳过被点图元拥有的点', () => {
    const owned = addPt(0, 0);
    addPointEntity(owned);

    expect(pickPoint({ x: 0, y: 0 }, 1)).toBeNull();

    // 放一个更远的普通点：拾取应命中它而不是距离 0 的已拥有点
    const plain = addPt(2, 0);
    expect(pickPoint({ x: 0, y: 0 }, 1)).toBe(plain);
  });

  it('pickEntity 命中点图元，容差用点拾取容差', () => {
    const p = addPt(0, 0);
    const e = addPointEntity(p);

    expect(pickEntity({ x: 0, y: 0 }, 1)).toBe(e);
    expect(pickEntity({ x: PICK_POINT_PX - 1, y: 0 }, 1)).toBe(e);
    expect(pickEntity({ x: PICK_POINT_PX + 1, y: 0 }, 1)).toBeNull();
  });

  it('点图元优先于与它重合的直线被拾取', () => {
    const p = addPt(50, 0);
    const e = addPointEntity(p);
    const line = addLine(addPt(0, 0), addPt(100, 0));

    expect(pickEntity({ x: 50, y: 0 }, 1)).toBe(e);
    expect(pickEntity({ x: 50, y: 0 }, 1)).not.toBe(line);
  });

  it('sketchBounds：点图元退化为零尺寸矩形，仍按最小留白给出包围盒', () => {
    addPointEntity(addPt(5, 5));
    const pad = BBOX_PAD_MIN;

    expect(sketchBounds()).toEqual({
      minx: 5 - pad,
      miny: 5 - pad,
      maxx: 5 + pad,
      maxy: 5 + pad,
      bw: 2 * pad,
      bh: 2 * pad,
    });
  });

  it('sketchBounds：远处点图元参与多图元包围盒并集', () => {
    addLine(addPt(0, 0), addPt(10, 0));
    addPointEntity(addPt(200, 200));

    const bb = sketchBounds();
    expect(bb).not.toBeNull();
    expect(bb?.maxx).toBeGreaterThan(200);
    expect(bb?.maxy).toBeGreaterThan(200);
  });

  it('点图元的框选命中：窗口要求点在框内，交叉只要点与框重叠', () => {
    const e = addPointEntity(addPt(0, 0));
    const inside = { minx: -10, miny: -10, maxx: 10, maxy: 10 };
    const outside = { minx: 20, miny: 20, maxx: 30, maxy: 30 };

    expect(entityInsideRect(e, inside)).toBe(true);
    expect(entityCrossesRect(e, inside)).toBe(true);
    expect(entityInsideRect(e, outside)).toBe(false);
    expect(entityCrossesRect(e, outside)).toBe(false);
  });

  it('computeSnap 仍把点图元的点作为高优先级「已有点」候选', () => {
    const p = addPt(0, 0);
    addPointEntity(p);

    const snap = computeSnap({ x: 1, y: 1 }, 1);
    expect(snap?.pri).toBe(SNAP_PRIORITY.point);
    expect(snap?.pt).toBe(p);
    expect(snap?.pos).toEqual({ x: 0, y: 0 });
  });
});

describe('点图元的 SVG 导出', () => {
  it('普通点图元导出为实心小圆；只有点时也能导出', () => {
    addPointEntity(addPt(5, 5));

    const svg = buildSVG();
    expect(svg).not.toBeNull();
    // 单点包围盒 bw=2 → 线宽取最小值 0.2；点半径 = 0.2 × 1.6 = 0.32
    expect(svg).toContain('<circle cx="5" cy="5" r="0.32" fill="#111" stroke="none"/>');
    // 点 (5,5) 的紧包围盒为 0×0，加 BBOX_PAD_MIN=1 留白
    expect(svg).toContain('viewBox="4 4 2 2"');
    expect(svg).toContain('width="2"');
    expect(svg).toContain('height="2"');
  });

  it('构造点导出为空心虚线圆', () => {
    const e = addPointEntity(addPt(0, 0));
    e.construction = true;

    expect(buildSVG()).toContain(
      '<circle cx="0" cy="0" r="0.32" fill="none" stroke-dasharray="5 5"/>',
    );
  });

  it('普通 addPt 没有图元身份，不产生可导出内容', () => {
    addPt(0, 0);
    expect(buildSVG()).toBeNull();
  });
});

describe('点图元的选择语义', () => {
  it('clickSelect 把点图元按 ent 选中，拖拽点是它引用的点', () => {
    const p = addPt(0, 0);
    const e = addPointEntity(p);

    const result = clickSelect({ x: 0, y: 0 }, 1, false);

    expect(result.hit).toBe('entity');
    expect(state.selection.items).toEqual([entItem(e.id)]);
    expect(result.dragPoints).toEqual([p]);
    expect(result.startMarquee).toBe(false);
  });

  it('未被点图元拥有的点仍按 pt 选中', () => {
    const p = addPt(20, 0);

    const result = clickSelect({ x: 20, y: 0 }, 1, false);

    expect(result.hit).toBe('point');
    expect(state.selection.items).toEqual([ptItem(p.id)]);
  });

  it('applyMarquee 不把被拥有的点再以 pt 身份重复选中', () => {
    const a = addPt(-10, 0);
    const b = addPt(10, 0);
    const line = addLine(a, b);
    const e = addPointEntity(b);

    applyMarquee(windowMarquee);

    expect(entIds().sort()).toEqual([line.id, e.id].sort());
    expect(ptIds()).toEqual([a.id]);
    expect(state.selection.items).toHaveLength(3);
    expect(state.selection.items.some((item) => item.kind === 'pt' && item.id === b.id)).toBe(
      false,
    );
  });

  it('applyMarquee 交叉选择命中点图元', () => {
    const e = addPointEntity(addPt(0, 0));
    applyMarquee({
      s0: { x: 350, y: 350 },
      currentS: { x: 450, y: 250 },
      active: true,
      add: false,
    });
    expect(entIds()).toEqual([e.id]);
  });

  it('selectedEntities / selectedPoints 按选择顺序分开给出，拖拽点合并去重', () => {
    const owned = addPt(0, 0);
    const e = addPointEntity(owned);
    const plain = addPt(50, 50);
    selectOnly([entItem(e.id), ptItem(plain.id)]);

    expect(selectedEntities()).toEqual([e]);
    expect(selectedPoints()).toEqual([plain]);
    expect(selectionDragPoints().map((p) => p.id)).toEqual([owned.id, plain.id]);
    expect(selectionEntries()).toEqual([
      { kind: 'ent', id: e.id, label: `点 #${e.id}` },
      { kind: 'pt', id: plain.id, label: `点 #${plain.id}` },
    ]);
  });

  it('选中点图元时，它的点算隐含选中（与渲染高亮共用同一判定）', () => {
    const p = addPt(0, 0);
    const e = addPointEntity(p);
    selectOnly([entItem(e.id)]);

    expect(isPointSelected(p)).toBe(true);
  });
});

describe("点工具 createPoint / toolClick('point')", () => {
  it('无吸附时在指针位置新建点与点图元', () => {
    const result = createPoint({ x: 3, y: 4 }, null);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.notices).toEqual([]);
    expect(model.pts.size).toBe(1);
    expect(model.ents.size).toBe(1);
    const e = [...model.ents.values()][0];
    expect(e?.type).toBe('point');
    if (e?.type === 'point') {
      expect(getPoint(e.p)).toMatchObject({ x: 3, y: 4 });
      expect(e.construction).toBe(false);
    }
  });

  it('吸附到已有点时把该点提升为点图元，不新建点', () => {
    const a = addPt(0, 0);
    addLine(a, addPt(100, 0));

    const result = createPoint({ x: 0, y: 0 }, snapAt(a));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.notices[0]?.kind).toBe('info');
      expect(result.notices[0]?.message).toContain('提升');
    }
    expect(model.pts.size).toBe(2);
    expect(model.ents.size).toBe(2);
    const e = pointEntityOf(a.id);
    expect(e).toBeDefined();
    expect(e?.p).toBe(a.id);
  });

  it('已有点图元再次创建：返回 info 提示且不重复创建', () => {
    const a = addPt(0, 0);
    const original = addPointEntity(a);
    const before = model.ents.size;

    const result = createPoint({ x: 0, y: 0 }, snapAt(a));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.notices[0]?.message).toContain('已经有一个点');
    }
    expect(model.ents.size).toBe(before);
    expect(pointEntityOf(a.id)).toBe(original);
  });

  it('吸附位置（snap.pos）优先于原始指针位置', () => {
    const result = createPoint({ x: 999, y: 999 }, gridSnap(10, 20));

    expect(result.ok).toBe(true);
    const e = [...model.ents.values()][0];
    expect(e?.type).toBe('point');
    if (e?.type === 'point') expect(getPoint(e.p)).toMatchObject({ x: 10, y: 20 });
  });

  it("toolClick('point') 直接返回建点 action 且不进入 pending", () => {
    const outcome = toolClick('point', null, { x: 7, y: 8 }, null, view, measure, FONT);

    expect(outcome.pending).toBeNull();
    expect(outcome.action?.ok).toBe(true);
    expect(model.ents.size).toBe(1);
    const e = [...model.ents.values()][0];
    expect(e?.type).toBe('point');
    if (e?.type === 'point') expect(getPoint(e.p)).toMatchObject({ x: 7, y: 8 });
  });

  it("toolClick('point') 吸附到已有点时提升该点", () => {
    const a = addPt(0, 0);
    addLine(a, addPt(100, 0));

    const outcome = toolClick('point', null, { x: 0, y: 0 }, snapAt(a), view, measure, FONT);

    expect(outcome.action?.ok).toBe(true);
    expect(pointEntityOf(a.id)).toBeDefined();
  });
});

describe('点图元的尺寸行为', () => {
  it('尺寸工具点中两个点图元可建 distancePointPoint，且不新建点', () => {
    const p1 = addPt(0, 0);
    addPointEntity(p1);
    const p2 = addPt(100, 0);
    addPointEntity(p2);

    const first = toolClick('dim', null, { x: 0, y: 0 }, null, view, measure, FONT);
    expect(first.pending).toEqual({ type: 'dim', a: p1.id });

    const second = toolClick('dim', first.pending, { x: 100, y: 0 }, null, view, measure, FONT);
    expect(second.pending).toBeNull();
    expect(second.dim?.ok).toBe(true);
    if (!second.dim?.ok) return;
    expect(second.dim.created).toBe(true);
    expect(second.dim.con.type).toBe('distancePointPoint');
    expect(dimValue(second.dim.con)).toBe(100);
    expect(model.pts.size).toBe(2);
    expect(model.cons.size).toBe(1);
  });

  it('再次标注同一对点图元时返回编辑会话而不是重复添加尺寸', () => {
    const p1 = addPt(0, 0);
    addPointEntity(p1);
    const p2 = addPt(100, 0);
    addPointEntity(p2);

    const first = toolClick('dim', null, { x: 0, y: 0 }, null, view, measure, FONT);
    const created = toolClick('dim', first.pending, { x: 100, y: 0 }, null, view, measure, FONT);
    if (!created.dim?.ok) throw new Error('尺寸创建失败');

    const again = toolClick('dim', null, { x: 0, y: 0 }, null, view, measure, FONT);
    const existing = toolClick('dim', again.pending, { x: 100, y: 0 }, null, view, measure, FONT);
    expect(existing.dim?.ok).toBe(true);
    if (!existing.dim?.ok) return;
    expect(existing.dim.created).toBe(false);
    expect(existing.dim.con.id).toBe(created.dim.con.id);
    expect(model.cons.size).toBe(1);
  });

  it('dimForEntity(点图元) 失败：点图元只能作为两点距离的一端', () => {
    const e = addPointEntity(addPt(0, 0));

    const result = dimForEntity(e, 1);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('标注尺寸');
    expect(model.cons.size).toBe(0);
  });
});
