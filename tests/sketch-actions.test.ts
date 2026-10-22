/**
 * sketch-actions.ts 的领域操作与点击状态机（node 环境，无 DOM）。
 * 这些函数只依赖 model/solver/geometry/dimensions：点击状态机把「下一个 pending」作为结果返回，
 * 由 Editor 写回 state；因此这里直接传 pending 与 CameraView 快照即可完整测试。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  AUTO_AXIS_RATIO,
  DIM_DEFAULT_OFFSET_PX,
  ITER_FULL,
  MIN_RADIUS,
  MIN_RECT_EDGE,
} from '../src/config';
import type { CameraView } from '../src/camera';
import { isDimConstraint, dimValue } from '../src/dimensions';
import {
  addCircle,
  addCon,
  addLine,
  addPt,
  clearModel,
  getEntity,
  getPoint,
  model,
} from '../src/model';
import {
  applyConstraint,
  cancelPending,
  commitDim,
  createArc,
  createCircle,
  createLine,
  createRect,
  deleteSelected,
  dimForEntity,
  dimForPoints,
  moveDrag,
  rollbackDim,
  solve,
  toggleConstruction,
  toggleFixed,
  toolClick,
} from '../src/sketch-actions';
import { resetInteraction } from '../src/state';
import type { MeasureText, Pending } from '../src/types';

const view: CameraView = { x: 0, y: 0, z: 1, viewportW: 800, viewportH: 600 };
const measure: MeasureText = (text) => text.length * 10;
const FONT = '12px sans-serif';

beforeEach(() => {
  clearModel();
  resetInteraction();
});

/** 用 model API 建一条水平线（不自动补约束，便于测约束/尺寸操作） */
function plainLine(): {
  a: ReturnType<typeof addPt>;
  b: ReturnType<typeof addPt>;
  line: ReturnType<typeof addLine>;
} {
  const a = addPt(0, 0);
  const b = addPt(100, 0);
  return { a, b, line: addLine(a, b) };
}

describe('createLine', () => {
  it('近水平自动补 horizontal 约束', () => {
    const a = addPt(0, 0);
    const b = addPt(100, 1); // |dy| = 1 < 100 × AUTO_AXIS_RATIO
    const result = createLine(a, b);
    expect(result.ok).toBe(true);
    expect(model.cons.size).toBe(1);
    expect([...model.cons.values()][0]?.type).toBe('horizontal');
    expect(AUTO_AXIS_RATIO).toBeGreaterThan(0);
  });

  it('近竖直自动补 vertical 约束', () => {
    const a = addPt(0, 0);
    const b = addPt(1, 100);
    createLine(a, b);
    expect([...model.cons.values()][0]?.type).toBe('vertical');
  });

  it('斜线不自动补约束；autoConstrain=false 时也不补', () => {
    createLine(addPt(0, 0), addPt(100, 50));
    expect(model.cons.size).toBe(0);
    createLine(addPt(0, 200), addPt(100, 201), false);
    expect(model.cons.size).toBe(0);
  });

  it('两点重合拒绝创建并给理由', () => {
    const a = addPt(0, 0);
    const b = addPt(0, 0);
    const result = createLine(a, b);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
    expect(model.ents.size).toBe(0);
  });
});

describe('createCircle / createArc', () => {
  it('半径太小拒绝创建', () => {
    const c = addPt(0, 0);
    expect(createCircle(c, MIN_RADIUS / 2).ok).toBe(false);
    expect(createArc(c, MIN_RADIUS / 2, 0, 1).ok).toBe(false);
    expect(model.ents.size).toBe(0);
  });

  it('合法半径创建图元', () => {
    const c = addPt(0, 0);
    expect(createCircle(c, 10).ok).toBe(true);
    expect(createArc(c, 10, 0, Math.PI).ok).toBe(true);
    expect(model.ents.size).toBe(2);
  });
});

describe('createRect', () => {
  it('过小的矩形拒绝创建', () => {
    expect(createRect({ x: 0, y: 0 }, { x: MIN_RECT_EDGE / 2, y: 10 }).ok).toBe(false);
    expect(createRect({ x: 0, y: 0 }, { x: 10, y: MIN_RECT_EDGE / 2 }).ok).toBe(false);
    expect(model.ents.size).toBe(0);
  });

  it('四角优先复用已有点，并生成 4 条边 + 2 水平 2 竖直约束', () => {
    const existing = addPt(10, 0); // 复用 (10,0) 这个角
    const result = createRect({ x: 0, y: 0 }, { x: 10, y: 5 });
    expect(result.ok).toBe(true);
    expect(model.pts.size).toBe(4);
    expect(model.ents.size).toBe(4);
    expect(model.pts.get(existing.id)).toBe(existing);
    const types = [...model.cons.values()].map((c) => c.type);
    expect(types.filter((t) => t === 'horizontal')).toHaveLength(2);
    expect(types.filter((t) => t === 'vertical')).toHaveLength(2);
  });
});

describe('applyConstraint', () => {
  it('合法选择添加约束；重复添加被跳过并报错', () => {
    const l1 = plainLine().line;
    const l2 = addLine(addPt(0, 10), addPt(100, 10));

    const first = applyConstraint('horizontal', [l1, l2]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(model.cons.size).toBe(2);

    const again = applyConstraint('horizontal', [l1, l2]);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toContain('已存在');
  });

  it('非法选择返回面向用户的理由，不写模型', () => {
    const circle = addCircle(addPt(0, 0), 10);
    const result = applyConstraint('horizontal', [circle]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
    expect(model.cons.size).toBe(0);

    const unknown = applyConstraint('parallel', []);
    expect(unknown.ok).toBe(false);
  });

  it('相切按选中类型生成对应 kind', () => {
    const l = plainLine().line;
    const circle = addCircle(addPt(50, 50), 10);
    const result = applyConstraint('tangent', [l, circle]);
    expect(result.ok).toBe(true);
    expect([...model.cons.values()][0]?.type).toBe('tangentLineCircle');
  });
});

describe('deleteSelected 级联', () => {
  it('删除图元会级联删除端点与尺寸', () => {
    const { a, b, line } = plainLine();
    const dim = addCon('distancePointPoint', { a: a.id, b: b.id, distance: 100 });
    const result = deleteSelected({ items: [{ kind: 'ent', id: line.id }] });
    expect(result.ok).toBe(true);
    expect(model.ents.size).toBe(0);
    expect(model.pts.size).toBe(0);
    expect(model.cons.has(dim.id)).toBe(false);
    expect(getEntity(line.id)).toBeUndefined();
  });

  it('空选择返回 ok 且不改模型', () => {
    plainLine();
    const before = model.ents.size;
    expect(
      deleteSelected({
        items: [
          { kind: 'ent', id: 999 },
          { kind: 'pt', id: 999 },
        ],
      }).ok,
    ).toBe(true);
    expect(model.ents.size).toBe(before);
  });
});

describe('toggleFixed / toggleConstruction', () => {
  it('固定/解锁在两类状态间切换', () => {
    const { a, b, line } = plainLine();
    expect(toggleFixed({ items: [{ kind: 'ent', id: line.id }] }).ok).toBe(true);
    expect(a.fixed).toBe(true);
    expect(b.fixed).toBe(true);
    toggleFixed({ items: [{ kind: 'ent', id: line.id }] });
    expect(a.fixed).toBe(false);
    expect(toggleFixed({ items: [] }).ok).toBe(false);
  });

  it('构造线切换作用于所有选中图元', () => {
    const { line } = plainLine();
    expect(toggleConstruction({ items: [{ kind: 'ent', id: line.id }] }).ok).toBe(true);
    expect(line.construction).toBe(true);
    toggleConstruction({ items: [{ kind: 'ent', id: line.id }] });
    expect(line.construction).toBe(false);
    expect(toggleConstruction({ items: [] }).ok).toBe(false);
  });
});

describe('dimForEntity', () => {
  it('圆/弧创建半径尺寸，重复点中时返回编辑会话', () => {
    const circle = addCircle(addPt(0, 0), 10);
    const first = dimForEntity(circle, 1);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.created).toBe(true);
    expect(first.con.type).toBe('radius');
    expect(dimValue(first.con)).toBe(10);

    const second = dimForEntity(circle, 1);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.created).toBe(false);
    expect(second.con.id).toBe(first.con.id);
  });

  it('直线创建距离尺寸，offset 按当前缩放换算成世界偏移', () => {
    const { line } = plainLine();
    const result = dimForEntity(line, 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.con.type).toBe('distancePointPoint');
    expect(dimValue(result.con)).toBe(100);
    expect(result.con.offset).toBe(DIM_DEFAULT_OFFSET_PX / 2);
  });

  it('commitDim 改目标值并求解', () => {
    const circle = addCircle(addPt(0, 0), 10);
    const result = dimForEntity(circle, 1);
    if (!result.ok) throw new Error('尺寸创建失败');
    const committed = commitDim(result.con, 5);
    expect(committed.ok).toBe(true);
    expect(circle.r).toBeCloseTo(5, 6);
    expect(dimValue(result.con)).toBe(5);
  });
});

describe('dimForPoints / rollbackDim', () => {
  it('两点尺寸记录偏移与新建点标记，重复使用时复用已有尺寸', () => {
    const a = addPt(0, 0);
    const b = addPt(100, 0);
    const result = dimForPoints(a, b, { x: 50, y: 20 }, true);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(result.con.type).toBe('distancePointPoint');
    expect(result.con.offset).toBeCloseTo(20, 12);
    expect(result.pointId).toBe(b.id);

    const again = dimForPoints(a, b, { x: 50, y: 20 }, false);
    if (!again.ok) throw new Error('应返回已有尺寸');
    expect(again.created).toBe(false);
    expect(again.con.id).toBe(result.con.id);
  });

  it('rollbackDim 删约束；带 pointId 时把顺手建的点一起删', () => {
    const a = addPt(0, 0);
    const b = addPt(100, 0);
    const result = dimForPoints(a, b, { x: 50, y: 20 }, true);
    if (!result.ok) throw new Error('尺寸创建失败');
    const conId = result.con.id;
    rollbackDim(result.con, result.pointId);
    expect(model.cons.has(conId)).toBe(false);
    expect(getPoint(b.id)).toBeUndefined();
  });
});

describe('cancelPending', () => {
  it('删除本次点击新建但还没并入图元的点', () => {
    const p = addPt(0, 0);
    const pending: Pending = { type: 'circle', center: 999, newPt: p.id };
    cancelPending(pending);
    expect(getPoint(p.id)).toBeUndefined();
  });

  it('没有 newPt 时什么都不做', () => {
    const ptsBefore = model.pts.size;
    cancelPending({ type: 'rect', p0: { x: 0, y: 0 } });
    expect(model.pts.size).toBe(ptsBefore);
  });
});

describe('toolClick 状态机', () => {
  it('select 工具原样返回 pending', () => {
    const pending: Pending = { type: 'rect', p0: { x: 0, y: 0 } };
    const outcome = toolClick('select', pending, { x: 0, y: 0 }, null, view, measure, FONT);
    expect(outcome.pending).toBe(pending);
  });

  it('直线：两次点击成线，第二击成为下一段起点', () => {
    const first = toolClick('line', null, { x: 0, y: 0 }, null, view, measure, FONT);
    expect(first.pending?.type).toBe('line');
    expect(first.action).toBeUndefined();
    expect(model.pts.size).toBe(1);

    const second = toolClick('line', first.pending, { x: 100, y: 0 }, null, view, measure, FONT);
    expect(second.pending?.type).toBe('line');
    expect(second.action?.ok).toBe(true);
    expect(model.ents.size).toBe(1);
  });

  it('圆：圆心 + 半径点', () => {
    const center = toolClick('circle', null, { x: 0, y: 0 }, null, view, measure, FONT);
    expect(center.pending?.type).toBe('circle');
    const done = toolClick('circle', center.pending, { x: 10, y: 0 }, null, view, measure, FONT);
    expect(done.pending).toBeNull();
    expect(done.action?.ok).toBe(true);
    expect(model.ents.size).toBe(1);
  });

  it('弧：圆心 → 起点 → 终点', () => {
    const c = toolClick('arc', null, { x: 0, y: 0 }, null, view, measure, FONT);
    const stage2 = toolClick('arc', c.pending, { x: 10, y: 0 }, null, view, measure, FONT);
    const p = stage2.pending;
    expect(p?.type).toBe('arc');
    if (p?.type !== 'arc') throw new Error('应为 arc pending');
    expect(p.stage).toBe(2);
    const done = toolClick('arc', p, { x: 0, y: 10 }, null, view, measure, FONT);
    expect(done.action?.ok).toBe(true);
    const arc = [...model.ents.values()][0];
    expect(arc?.type).toBe('arc');
    if (arc?.type === 'arc') {
      expect(arc.r).toBeCloseTo(10, 6);
      expect(arc.a0).toBeCloseTo(0, 12);
      expect(arc.a1).toBeCloseTo(Math.PI / 2, 12);
    }
  });

  it('矩形：两个对角点创建 4 条边', () => {
    const first = toolClick('rect', null, { x: 0, y: 0 }, null, view, measure, FONT);
    expect(first.pending?.type).toBe('rect');
    const done = toolClick('rect', first.pending, { x: 10, y: 5 }, null, view, measure, FONT);
    expect(done.pending).toBeNull();
    expect(done.action?.ok).toBe(true);
    expect(model.ents.size).toBe(4);
  });

  it('尺寸：点中图元创建距离尺寸', () => {
    plainLine();
    const outcome = toolClick('dim', null, { x: 50, y: 0 }, null, view, measure, FONT);
    expect(outcome.dim?.ok).toBe(true);
    if (outcome.dim?.ok) {
      expect(outcome.dim.created).toBe(true);
      expect(outcome.dim.con.type).toBe('distancePointPoint');
    }
  });

  it('尺寸：点中已有点进入两点尺寸流程', () => {
    const { a } = plainLine();
    const outcome = toolClick('dim', null, { x: a.x, y: a.y }, null, view, measure, FONT);
    expect(outcome.pending).toEqual({ type: 'dim', a: a.id });
  });

  it('删除：点优先，其次图元；都级联删除', () => {
    const p = addPt(0, 0);
    addLine(p, addPt(100, 0));
    const erasePoint = toolClick('erase', null, { x: 0, y: 0 }, null, view, measure, FONT);
    expect(erasePoint.action?.ok).toBe(true);
    expect(model.ents.size).toBe(0);

    clearModel();
    addLine(addPt(0, 0), addPt(100, 0));
    const eraseLine = toolClick('erase', null, { x: 50, y: 0 }, null, view, measure, FONT);
    expect(eraseLine.action?.ok).toBe(true);
    expect(model.ents.size).toBe(0);
  });
});

describe('moveDrag', () => {
  it('按光标位移平移被拖点并静默求解', () => {
    const { a } = plainLine();
    const gesture = {
      startW: { x: 0, y: 0 },
      items: [{ p: a, ox: a.x, oy: a.y }],
      exclude: new Set<number>(),
    };
    moveDrag(gesture, { x: 5, y: 7 });
    expect(a.x).toBe(5);
    expect(a.y).toBe(7);
  });
});

describe('solve 提示翻译', () => {
  it('silent 模式不产生提示', () => {
    plainLine();
    expect(solve(ITER_FULL, { silent: true })).toEqual([]);
  });

  it('无效约束提示错误，冲突约束提示未满足', () => {
    const circle = addCircle(addPt(0, 0), 10);
    addCon('horizontal', { e: circle.id }); // 种类不符 → invalid
    const notices = solve(ITER_FULL);
    expect(
      notices.some((n) => n.kind === 'error' && n.message.includes('引用了不存在的对象')),
    ).toBe(true);

    clearModel();
    const a = addPt(0, 0, true);
    const b = addPt(10, 5, true);
    const line = addLine(a, b);
    addCon('horizontal', { e: line.id });
    const conflict = solve(ITER_FULL);
    expect(conflict.some((n) => n.message.includes('约束未完全满足'))).toBe(true);
    expect(isDimConstraint(addCon('horizontal', { e: line.id }))).toBe(false);
  });
});

describe('applyConstraint 反序选择去重（BUG-3）', () => {
  it('先选 A 再选 B 与先选 B 再选 A 只保留一条平行约束', () => {
    const p1 = addPt(0, 0);
    const p2 = addPt(100, 0);
    const line1 = addLine(p1, p2);
    const p3 = addPt(0, 30);
    const p4 = addPt(100, 30);
    const line2 = addLine(p3, p4);

    const first = applyConstraint('parallel', [line1, line2]);
    expect(first.ok).toBe(true);
    const second = applyConstraint('parallel', [line2, line1]);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toContain('已存在');
    expect([...model.cons.values()].filter((x) => x.type === 'parallel')).toHaveLength(1);
  });
});
