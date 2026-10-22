/**
 * selection.ts 的选择语义与 state 交互（node 环境）。
 * 选择集是有序的 SelectionItem 列表：点击已选项保留多选并整体拖动、框选方向、
 * 已选择列表数据与拖拽点去重都在这里验证。
 * 框选方向是唯一定义：由下往上拖（终点 y 更小）= 交叉选择，由上往下 = 窗口选择。
 * 夹具把屏幕坐标固定为 800×600、zoom=1、世界原点在屏幕中心，便于手算世界矩形。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { DRAG_THRESHOLD_PX } from '../src/config';
import { cam } from '../src/camera';
import {
  addCircle,
  addCon,
  addLine,
  addPt,
  arcGeometry,
  clearModel,
  getPoint,
  removeEntity,
} from '../src/model';
import {
  applyMarquee,
  clearHover,
  clickSelect,
  isCrossing,
  isPointSelected,
  pruneSelection,
  selectionDragPoints,
  selectionEntries,
  selectionSummary,
  updateHover,
  updateMarquee,
} from '../src/selection';
import { resetInteraction, selectOnly, state } from '../src/state';
import type { Marquee, SelectionItem } from '../src/types';
import { addArcByAngles } from './fixtures';

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

/** 世界 (100,0)-(200,0) 的直线：屏幕 (500,300)-(600,300) */
function lineFixture(): ReturnType<typeof addLine> {
  return addLine(addPt(100, 0), addPt(200, 0));
}

/** 选择集里的图元 id（保持顺序） */
const entIds = (): number[] =>
  state.selection.items.filter((item) => item.kind === 'ent').map((item) => item.id);

/** 选择集里的点 id（保持顺序） */
const ptIds = (): number[] =>
  state.selection.items.filter((item) => item.kind === 'pt').map((item) => item.id);

const entItem = (id: number): SelectionItem => ({ kind: 'ent', id });
const ptItem = (id: number): SelectionItem => ({ kind: 'pt', id });

/** 屏幕矩形 [-50,50]²（世界单位）对应的框选参数 */
const crossingMarquee: Marquee = {
  s0: { x: 350, y: 350 },
  currentS: { x: 450, y: 250 },
  active: true,
  add: false,
};
const windowMarquee: Marquee = {
  s0: { x: 350, y: 250 },
  currentS: { x: 450, y: 350 },
  active: true,
  add: false,
};

describe('isCrossing', () => {
  it('由下往上拖是交叉选择', () => {
    expect(isCrossing({ x: 0, y: 100 }, { x: 10, y: 50 })).toBe(true);
  });

  it('由上往下拖是窗口选择', () => {
    expect(isCrossing({ x: 0, y: 0 }, { x: 10, y: 50 })).toBe(false);
  });
});

describe('clickSelect 单选', () => {
  it('点优先于图元', () => {
    const p = addPt(150, 0);
    lineFixture();
    const result = clickSelect({ x: 150, y: 0 }, 1, false);
    expect(result.hit).toBe('point');
    expect(state.selection.items).toEqual([ptItem(p.id)]);
    expect(result.dragPoints).toEqual([p]);
    expect(result.startMarquee).toBe(false);
  });

  it('点中图元：选中图元并给出端点作为拖拽点', () => {
    const line = lineFixture();
    const result = clickSelect({ x: 150, y: 0 }, 1, false);
    expect(result.hit).toBe('entity');
    expect(state.selection.items).toEqual([entItem(line.id)]);
    expect(result.dragPoints).toHaveLength(2);
  });

  it('点中空白：清空选择并开始框选', () => {
    const p = addPt(0, 0);
    selectOnly([ptItem(p.id)]);
    const result = clickSelect({ x: 300, y: 300 }, 1, false);
    expect(result.hit).toBe('empty');
    expect(result.startMarquee).toBe(true);
    expect(state.selection.items).toEqual([]);
  });

  it('Shift 点击同一点：从选择里切掉', () => {
    const p = addPt(0, 0);
    selectOnly([ptItem(p.id)]);
    const result = clickSelect({ x: 0, y: 0 }, 1, true);
    expect(result.hit).toBe('point');
    expect(state.selection.items).toEqual([]);
    expect(result.startMarquee).toBe(false);
  });

  it('Shift 点击空白：保留已有选择并开始累加框选', () => {
    const p = addPt(0, 0);
    selectOnly([ptItem(p.id)]);
    const result = clickSelect({ x: 300, y: 300 }, 1, true);
    expect(result.startMarquee).toBe(true);
    expect(state.selection.items).toEqual([ptItem(p.id)]);
  });

  it('Shift 点击未选中的图元：加入选择', () => {
    const line = lineFixture();
    clickSelect({ x: 300, y: 300 }, 1, true); // 空白处按下不清空
    const result = clickSelect({ x: 150, y: 0 }, 1, true);
    expect(result.hit).toBe('entity');
    expect(result.startMarquee).toBe(false);
    expect(state.selection.items).toEqual([entItem(line.id)]);
  });
});

describe('clickSelect 圆弧端点', () => {
  it('点击圆弧端点按普通点选中（与线段端点一致）', () => {
    const center = addPt(0, 0);
    const arc = addArcByAngles(center, 10, 0, Math.PI / 2);
    const g = arcGeometry(arc);
    if (!g) throw new Error('圆弧引用缺失');

    const result = clickSelect(g.start, 1, false);

    expect(result.hit).toBe('point');
    expect(result.dragPoints).toEqual([g.start]);
    expect(state.selection.items).toEqual([{ kind: 'pt', id: g.start.id }]);
  });
});

describe('clickSelect 多选整体拖动', () => {
  /** 两条不相交的直线：A 在 y=0，B 在 y=50；世界 x 都在 100..200 */
  function twoLines(): { a: ReturnType<typeof addLine>; b: ReturnType<typeof addLine> } {
    return {
      a: addLine(addPt(100, 0), addPt(200, 0)),
      b: addLine(addPt(100, 50), addPt(200, 50)),
    };
  }

  it('点中已选中的图元：保留整个选择集，拖拽点是全部选中图元的端点', () => {
    const { a, b } = twoLines();
    selectOnly([entItem(a.id), entItem(b.id)]);

    const result = clickSelect({ x: 150, y: 0 }, 1, false);

    expect(result.hit).toBe('entity');
    // 不能塌缩成单项，否则拖动会只带动一条线
    expect(state.selection.items).toEqual([entItem(a.id), entItem(b.id)]);
    // 共享端点不存在时 4 个端点都参与拖动；顺序按选择集与 entityPointIds 的稳定顺序
    expect(result.dragPoints.map((p) => p.id)).toEqual([a.a, a.b, b.a, b.b]);
  });

  it('点中未选中的图元：选择塌缩成它自己，只拖它自己的端点', () => {
    const { a, b } = twoLines();
    selectOnly([entItem(a.id)]);

    const result = clickSelect({ x: 150, y: 50 }, 1, false);

    expect(result.hit).toBe('entity');
    expect(state.selection.items).toEqual([entItem(b.id)]);
    expect(result.dragPoints.map((p) => p.id)).toEqual([b.a, b.b]);
  });

  it('点中已选图元的端点（隐含选中）：保留多选并整体拖动', () => {
    const line = lineFixture();
    const extra = addPt(0, 0);
    selectOnly([entItem(line.id), ptItem(extra.id)]);

    const result = clickSelect({ x: 100, y: 0 }, 1, false);

    expect(result.hit).toBe('point');
    expect(state.selection.items).toEqual([entItem(line.id), ptItem(extra.id)]);
    expect(result.dragPoints.map((p) => p.id)).toEqual([line.a, line.b, extra.id]);
  });

  it('点中已选中的独立点：拖动全部已选点', () => {
    const p1 = addPt(0, 0);
    const p2 = addPt(50, 0);
    selectOnly([ptItem(p1.id), ptItem(p2.id)]);

    const result = clickSelect({ x: 0, y: 0 }, 1, false);

    expect(result.hit).toBe('point');
    expect(state.selection.items).toEqual([ptItem(p1.id), ptItem(p2.id)]);
    expect(result.dragPoints.map((p) => p.id)).toEqual([p1.id, p2.id]);
  });

  it('Shift 点击已选图元只做反选，不触发拖拽', () => {
    const { a, b } = twoLines();
    selectOnly([entItem(a.id), entItem(b.id)]);

    const result = clickSelect({ x: 150, y: 0 }, 1, true);

    expect(result.dragPoints).toEqual([]);
    expect(state.selection.items).toEqual([entItem(b.id)]);
  });
});

describe('applyMarquee', () => {
  it('交叉选择：与矩形有任何重叠的图元都选中；点按是否在框内', () => {
    const inside = addLine(addPt(-10, 0), addPt(10, 0));
    const crossing = addLine(addPt(-100, 0), addPt(0, 0));
    const far = addLine(addPt(200, 200), addPt(300, 300));

    applyMarquee(crossingMarquee);

    expect(isCrossing(crossingMarquee.s0, crossingMarquee.currentS)).toBe(true);
    expect(entIds().sort()).toEqual([inside.id, crossing.id].sort());
    // 点选择只看是否在框内：inside 两端 + crossing 的 (0,0) 在框内，(-100,0) 不在
    expect(ptIds()).toHaveLength(3);
    expect(entIds()).not.toContain(far.id);
  });

  it('窗口选择：只有完全落在框内的图元被选中', () => {
    const inside = addLine(addPt(-10, 0), addPt(10, 0));
    const partially = addLine(addPt(-100, 0), addPt(0, 0));

    applyMarquee(windowMarquee);

    expect(isCrossing(windowMarquee.s0, windowMarquee.currentS)).toBe(false);
    expect(entIds()).toEqual([inside.id]);
    expect(entIds()).not.toContain(partially.id);
  });

  it('列表顺序稳定：先图元后点，供已选择列表按固定顺序展示', () => {
    addLine(addPt(-10, 0), addPt(10, 0));
    addPt(0, 0);

    applyMarquee(windowMarquee);

    // 被选中的图元排在前，框内的点（含图元端点）按 model 迭代顺序排在后
    expect(state.selection.items[0]?.kind).toBe('ent');
    expect(state.selection.items.slice(1).every((item) => item.kind === 'pt')).toBe(true);
  });

  it('add 为 true 时与已有选择求并集', () => {
    const inside = addLine(addPt(-10, 0), addPt(10, 0));
    const other = addPt(0, 0);
    selectOnly([ptItem(other.id)]);

    applyMarquee({ ...crossingMarquee, add: true });

    expect(entIds()).toEqual([inside.id]);
    expect(ptIds()).toContain(other.id);
  });

  it('add 为 false 时覆盖已有选择', () => {
    addLine(addPt(-10, 0), addPt(10, 0));
    const stale = addPt(500, 500);
    selectOnly([ptItem(stale.id)]);

    applyMarquee(crossingMarquee);

    expect(ptIds()).not.toContain(stale.id);
  });
});

describe('selectionDragPoints / isPointSelected', () => {
  it('选中图元时其端点算隐含选中；拖拽点按 id 去重共享端点', () => {
    const shared = addPt(0, 0);
    const a = addPt(100, 0);
    const b = addPt(0, 100);
    const l1 = addLine(shared, a);
    const l2 = addLine(shared, b);
    selectOnly([entItem(l1.id), entItem(l2.id)]);

    expect(isPointSelected(shared)).toBe(true);
    expect(isPointSelected(a)).toBe(true);
    // 共享端点只出现一次，避免同一帧被重复平移
    expect(selectionDragPoints().map((p) => p.id)).toEqual([shared.id, a.id, b.id]);
  });

  it('显式选中的点与图元端点合并时也去重', () => {
    const line = lineFixture();
    const end = getPoint(line.a)!;
    selectOnly([ptItem(end.id), entItem(line.id)]);

    expect(selectionDragPoints().map((p) => p.id)).toEqual([end.id, line.b]);
  });

  it('选中圆弧时圆心与起点/终点一起成为拖拽点（整弧平移）', () => {
    const center = addPt(0, 0);
    const arc = addArcByAngles(center, 10, 0, Math.PI / 2);
    const g = arcGeometry(arc);
    if (!g) throw new Error('圆弧引用缺失');
    selectOnly([entItem(arc.id)]);

    expect(selectionDragPoints().map((p) => p.id)).toEqual([center.id, g.start.id, g.end.id]);
  });
});

describe('pruneSelection / selectionEntries', () => {
  it('无选择时列表为空', () => {
    expect(selectionEntries()).toEqual([]);
  });

  it('按选择顺序给出种类与文案，点坐标变化不影响文案', () => {
    const line = addLine(addPt(100, 0), addPt(200, 0));
    const p = addPt(0, 0);
    selectOnly([entItem(line.id), ptItem(p.id)]);

    expect(selectionEntries()).toEqual([
      { kind: 'ent', id: line.id, label: `直线 #${line.id}`, constraints: [] },
      { kind: 'pt', id: p.id, label: `点 #${p.id}`, constraints: [] },
    ]);
  });

  it('圆与圆弧的文案不同', () => {
    const c = addCircle(addPt(0, 0), 10);
    selectOnly([entItem(c.id)]);
    expect(selectionEntries()).toEqual([
      { kind: 'ent', id: c.id, label: `圆 #${c.id}`, constraints: [] },
    ]);
  });

  it('模型删除对象后 pruneSelection 摘掉悬空项，计数与列表同步', () => {
    const line = addLine(addPt(100, 0), addPt(200, 0));
    // 另立一条线，它的端点不会随 line 的删除而消失（孤立点会被 pruneOrphanPoints 清掉）
    const other = addLine(addPt(0, 100), addPt(0, 200));
    selectOnly([entItem(line.id), ptItem(other.a)]);

    removeEntity(line);
    pruneSelection();

    expect(state.selection.items).toEqual([ptItem(other.a)]);
    expect(selectionEntries()).toHaveLength(1);
  });
});

describe('selectionEntries 行内约束', () => {
  it('只显示已选对象已有的约束：图元直接引用 + 端点引用，同一条约束只出现一次', () => {
    const line = addLine(addPt(0, 0), addPt(100, 0));
    const horizontal = addCon('horizontal', { e: line.id });
    // 距离尺寸引用两个端点：图元行要能看到它，并带显示值
    const distance = addCon('distancePointPoint', { a: line.a, b: line.b, distance: 100 });
    // 点在图元端点上的 pointOnLine 同时命中图元引用与端点引用，仍只列一次
    const onLine = addCon('pointOnLine', { e: line.id, p: line.a });

    selectOnly([entItem(line.id)]);
    expect(selectionEntries()).toEqual([
      {
        kind: 'ent',
        id: line.id,
        label: `直线 #${line.id}`,
        constraints: [
          { id: horizontal.id, text: '水平' },
          { id: distance.id, text: '距离 100' },
          { id: onLine.id, text: '点在线上' },
        ],
      },
    ]);
  });

  it('选中点时只列引用该点的约束；尺寸按画布同款两位小数显示', () => {
    const a = addPt(0, 0);
    const b = addPt(10, 0);
    const other = addPt(50, 50);
    const dim = addCon('distancePointPoint', { a: a.id, b: b.id, distance: 12.345 });
    addCon('coincident', { a: b.id, b: other.id });

    selectOnly([ptItem(a.id)]);
    expect(selectionEntries()).toEqual([
      {
        kind: 'pt',
        id: a.id,
        label: `点 #${a.id}`,
        constraints: [{ id: dim.id, text: '距离 12.35' }],
      },
    ]);
  });

  it('圆列出半径尺寸的显示值，未选中对象的约束不出现', () => {
    const c1 = addCircle(addPt(0, 0), 5);
    const c2 = addCircle(addPt(100, 0), 10);
    const r1 = addCon('radius', { e: c1.id, radius: 5 });
    addCon('radius', { e: c2.id, radius: 10 });

    selectOnly([entItem(c1.id)]);
    expect(selectionEntries()[0]?.constraints).toEqual([{ id: r1.id, text: '半径 5' }]);

    selectOnly([]);
    expect(selectionEntries()).toEqual([]);
  });

  it('同一条约束引用图元的两个端点时也只出现一次', () => {
    const line = addLine(addPt(0, 0), addPt(10, 10));
    const coincident = addCon('coincident', { a: line.a, b: line.b });

    selectOnly([entItem(line.id)]);
    expect(selectionEntries()[0]?.constraints).toEqual([{ id: coincident.id, text: '重合' }]);
  });

  it('约束条目各带模型 id：同文案的两条约束分属不同对象，不会互相顶替', () => {
    const c1 = addCircle(addPt(0, 0), 5);
    const c2 = addCircle(addPt(100, 0), 10);
    const r1 = addCon('radius', { e: c1.id, radius: 5 });
    const r2 = addCon('radius', { e: c2.id, radius: 10 });

    selectOnly([entItem(c1.id), entItem(c2.id)]);
    expect(selectionEntries().map((entry) => entry.constraints)).toEqual([
      [{ id: r1.id, text: '半径 5' }],
      [{ id: r2.id, text: '半径 10' }],
    ]);
    expect(r1.id).not.toBe(r2.id);
  });
});

describe('updateHover / clearHover', () => {
  it('有吸附时记录 snap 与 hoverPt；图元悬停与点互斥', () => {
    const p = addPt(0, 0);
    addLine(addPt(100, 0), addPt(200, 0));

    updateHover({ x: 0, y: 0 }, 1);
    expect(state.hoverPt).toBe(p);
    expect(state.snap?.pt).toBe(p);
    expect(state.hoverEnt).toBeNull();
  });

  it('关闭吸附后 snap 为 null，但仍保留悬停高亮', () => {
    const p = addPt(0, 0);
    state.snapEnabled = false;
    updateHover({ x: 0, y: 0 }, 1);
    expect(state.snap).toBeNull();
    expect(state.hoverPt).toBe(p);
  });

  it('clearHover 清空全部悬停/吸附标记', () => {
    addPt(0, 0);
    updateHover({ x: 0, y: 0 }, 1);
    clearHover();
    expect(state.snap).toBeNull();
    expect(state.hoverPt).toBeNull();
    expect(state.hoverEnt).toBeNull();
  });
});

describe('updateMarquee', () => {
  it('位移超过 DRAG_THRESHOLD_PX 才 active', () => {
    state.marquee = {
      s0: { x: 400, y: 300 },
      currentS: { x: 400, y: 300 },
      active: false,
      add: false,
    };
    updateMarquee({ x: 401, y: 300 });
    expect(state.marquee.active).toBe(false);
    updateMarquee({ x: 400 + DRAG_THRESHOLD_PX + 1, y: 300 });
    expect(state.marquee.active).toBe(true);
    expect(state.marquee.currentS).toEqual({ x: 400 + DRAG_THRESHOLD_PX + 1, y: 300 });
  });

  it('没有框选状态时安全返回', () => {
    expect(() => updateMarquee({ x: 1, y: 1 })).not.toThrow();
  });
});

describe('selectionSummary', () => {
  it('按选中内容给出文案', () => {
    expect(selectionSummary()).toBe('');
    selectOnly([entItem(1)]);
    expect(selectionSummary()).toBe('已选 1 个图元');
    selectOnly([ptItem(2)]);
    expect(selectionSummary()).toBe('已选 1 个点');
    selectOnly([entItem(1), entItem(2), ptItem(3)]);
    expect(selectionSummary()).toBe('已选 2 图元 + 1 点');
  });
});
