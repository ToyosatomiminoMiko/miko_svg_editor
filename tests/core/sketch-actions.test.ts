/**
 * sketch-actions.ts 的原子领域操作（node 环境，无 DOM）。
 * 这些函数只依赖 model/solver/geometry/dimensions：参数槽位与点击状态机已统一到
 * operations.ts，本文件只测「一次操作真正写模型」的部分：
 * 创建图元的退化阈值、删除级联、固定/构造、尺寸创建与回滚、拖拽求解、求解提示翻译。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { AUTO_AXIS_RATIO } from '../../src/config';
import {
  angleLineGeometry,
  dimText,
  dimValue,
  findAngleDim,
  isDimConstraint,
} from '../../src/core/dimensions';
import {
  addCircle,
  addCon,
  addLine,
  addPointEntity,
  addPt,
  arcGeometry,
  clearModel,
  curveRadius,
  getEntity,
  getPoint,
  model,
} from '../../src/core/model';
import {
  commitDim,
  createArc,
  createCircle,
  createLine,
  createRect,
  deleteConstraint,
  deleteSelected,
  dimForEntity,
  dimForLines,
  dimForPoints,
  moveDrag,
  rollbackDim,
  solve,
  toggleConstruction,
  toggleFixed,
} from '../../src/core/sketch-actions';
import { resetInteraction } from '../../src/core/state';
import { addArcByAngles } from './fixtures';

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
    expect(createCircle(c, 1e-5).ok).toBe(false);

    const tinyStart = addPt(1e-5, 0);
    const tinyEnd = addPt(0, 1e-5);
    expect(createArc(c, tinyStart, tinyEnd, new Set([tinyStart.id, tinyEnd.id])).ok).toBe(false);
    expect(model.ents.size).toBe(0);
  });

  it('合法半径创建图元；圆弧的起点/终点成为模型点', () => {
    const c = addPt(0, 0);
    expect(createCircle(c, 10).ok).toBe(true);
    const start = addPt(10, 0);
    const end = addPt(0, 10);
    expect(createArc(c, start, end, new Set([start.id, end.id])).ok).toBe(true);
    expect(model.ents.size).toBe(2);

    const arc = [...model.ents.values()].find((e) => e.type === 'arc');
    if (!arc || arc.type !== 'arc') throw new Error('圆弧未创建');
    expect(arc.pointIds).toEqual([c.id, start.id, end.id]);
    const g = arcGeometry(arc);
    expect(g?.r).toBeCloseTo(10, 6);
    expect(g?.a0).toBeCloseTo(0, 12);
    expect(g?.a1).toBeCloseTo(Math.PI / 2, 12);
  });

  it('终点是本次新建的点：只决定终止角，按起点半径投到圆上', () => {
    const c = addPt(0, 0);
    const start = addPt(10, 0);
    const end = addPt(0, 5); // 点击半径 5；圆弧半径仍由起点决定
    const created = new Set([start.id, end.id]);
    expect(createArc(c, start, end, created).ok).toBe(true);
    expect(end.x).toBeCloseTo(0, 12);
    expect(end.y).toBeCloseTo(10, 12);
    expect(model.ents.size).toBe(1);
  });

  it('终点是已有点：复用该点并以它定半径，起点被挪到同一个圆上', () => {
    const c = addPt(0, 0);
    const start = addPt(10, 0); // 本次新建
    const end = addPt(0, 20); // 已有点：圆弧要接上它

    expect(createArc(c, start, end, new Set([start.id])).ok).toBe(true);

    // 起点保持极角 0、半径改成 |终点 - 圆心| = 20
    expect(start.x).toBeCloseTo(20, 12);
    expect(start.y).toBeCloseTo(0, 12);
    const arc = [...model.ents.values()][0];
    if (!arc || arc.type !== 'arc') throw new Error('圆弧未创建');
    expect(curveRadius(arc)).toBeCloseTo(20, 12);
  });

  it('两端都是已有点但不共圆：拒绝创建，不改动既有几何', () => {
    const c = addPt(0, 0);
    const start = addPt(10, 0);
    const end = addPt(0, 20);
    const before = [start.x, start.y, end.x, end.y];

    const result = createArc(c, start, end, new Set());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('圆上');
    expect(model.ents.size).toBe(0);
    expect([start.x, start.y, end.x, end.y]).toEqual(before);
  });

  it('起终点重合按整圆处理：复用起点，不留重合的第二端点', () => {
    const c = addPt(0, 0);
    const start = addPt(10, 0);
    const end = addPt(10, 0);
    const created = new Set([start.id, end.id]);

    expect(createArc(c, start, end, created).ok).toBe(true);

    // 圆心 + 起点；临时终点被丢弃，模型里没有两个重合端点
    expect(model.pts.size).toBe(2);
    const arc = [...model.ents.values()][0];
    if (!arc || arc.type !== 'arc') throw new Error('圆弧未创建');
    expect(arc.a).toBe(start.id);
    expect(arc.b).toBe(start.id);
    const g = arcGeometry(arc);
    expect(g?.r).toBeCloseTo(10, 12);
  });
});

describe('createRect', () => {
  it('过小的矩形拒绝创建', () => {
    expect(createRect({ x: 0, y: 0 }, { x: 1e-5, y: 10 }).ok).toBe(false);
    expect(createRect({ x: 0, y: 0 }, { x: 10, y: 1e-5 }).ok).toBe(false);
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

describe('deleteConstraint（已选择行内的约束 ×）', () => {
  it('只删指定约束：其余约束与几何保留，求解不改动已满足的点', () => {
    const { a, b, line } = plainLine();
    const horizontal = addCon('horizontal', { e: line.id });
    const dim = addCon('distancePointPoint', { a: a.id, b: b.id, distance: 100 });

    const result = deleteConstraint(horizontal.id);
    expect(result.ok).toBe(true);
    expect(model.cons.has(horizontal.id)).toBe(false);
    expect(model.cons.has(dim.id)).toBe(true);
    expect([...model.ents.keys()]).toEqual([line.id]);
    expect(a.x).toBeCloseTo(0, 12);
    expect(b.x).toBeCloseTo(100, 12);
  });

  it('删除尺寸约束不级联删除点/图元（约束只是附加关系）', () => {
    const center = addPt(0, 0);
    const circle = addCircle(center, 10);
    const radius = addCon('radius', { e: circle.id, radius: 10 });
    const pointCount = model.pts.size;

    expect(deleteConstraint(radius.id).ok).toBe(true);
    expect(model.cons.size).toBe(0);
    expect(model.pts.size).toBe(pointCount);
    expect(model.pts.has(center.id)).toBe(true);
    expect(getEntity(circle.id)).toBe(circle);
  });

  it('找不到的 id 视为已删：幂等且不报错', () => {
    plainLine();
    expect(deleteConstraint(999).ok).toBe(true);
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
  it('圆/弧创建半径尺寸，放置点决定引线方向；重复点中时返回编辑会话', () => {
    const circle = addCircle(addPt(0, 0), 10);
    const first = dimForEntity(circle, { x: 10, y: 10 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.created).toBe(true);
    expect(first.con.type).toBe('radius');
    expect(dimValue(first.con)).toBe(10);
    expect(first.con.leaderAngle).toBeCloseTo(Math.PI / 4, 12);

    const second = dimForEntity(circle, { x: -10, y: -10 });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.created).toBe(false);
    expect(second.con.id).toBe(first.con.id);
    // 编辑已有尺寸时不覆盖摆放参数
    expect(second.con.leaderAngle).toBeCloseTo(Math.PI / 4, 12);
  });

  it('圆弧半径尺寸取派生半径（圆心到起点的距离）', () => {
    const arc = addArcByAngles(addPt(0, 0, true), 10, 0, Math.PI / 2);
    const result = dimForEntity(arc, { x: 10, y: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.con.type).toBe('radius');
    expect(dimValue(result.con)).toBe(10);
  });

  it('直线创建距离尺寸，放置点决定世界 offset', () => {
    const { line } = plainLine();
    const result = dimForEntity(line, { x: 50, y: 25 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.con.type).toBe('distancePointPoint');
    expect(dimValue(result.con)).toBe(100);
    expect(result.con.offset).toBeCloseTo(25, 12);
  });

  it('没有放置点时不创建长度/半径尺寸（由操作槽位保证正常流程不会发生）', () => {
    const { line } = plainLine();
    const result = dimForEntity(line);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('放置');
    expect(model.cons.size).toBe(0);
  });

  it('commitDim 改目标值并求解', () => {
    const circle = addCircle(addPt(0, 0), 10);
    const result = dimForEntity(circle, { x: 10, y: 0 });
    if (!result.ok) throw new Error('尺寸创建失败');
    const committed = commitDim(result.con, 5);
    expect(committed.ok).toBe(true);
    expect(circle.r).toBeCloseTo(5, 6);
    expect(dimValue(result.con)).toBe(5);
  });

  it('点图元没有独立尺寸目标', () => {
    const e = addPointEntity(addPt(0, 0));
    const result = dimForEntity(e);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('不能标注尺寸');
    expect(model.cons.size).toBe(0);
  });
});

describe('dimForLines（角度尺寸）', () => {
  /** 两条 45° 夹角直线，交点 (0,0) */
  function angleLines(): { line1: ReturnType<typeof addLine>; line2: ReturnType<typeof addLine> } {
    const line1 = addLine(addPt(0, 0), addPt(100, 0));
    const line2 = addLine(addPt(0, 0), addPt(100, 100));
    return { line1, line2 };
  }

  it('创建角度尺寸：目标角取放置扇形的当前夹角，放置点决定象限与弧半径', () => {
    const { line1, line2 } = angleLines();
    const result = dimForLines(line1, line2, { x: 20, y: 5 }, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(result.con.type).toBe('angleLineLine');
    expect(dimValue(result.con)).toBeCloseTo(45, 9);
    expect(result.con.angleSector).toBe(0);
    expect(result.con.offset).toBeCloseTo(Math.hypot(20, 5), 9);
    expect(dimText(result.con)).toBe('45°');

    const again = dimForLines(line1, line2, { x: 10, y: 10 }, 1);
    if (!again.ok) throw new Error('应返回已有角度尺寸');
    expect(again.created).toBe(false);
    expect(again.con.id).toBe(result.con.id);
    expect(findAngleDim(line2.id, line1.id)?.id).toBe(result.con.id);
  });

  it('平行直线拒绝创建并给理由', () => {
    const line1 = addLine(addPt(0, 0), addPt(100, 0));
    const line2 = addLine(addPt(0, 10), addPt(100, 10));
    const result = dimForLines(line1, line2, { x: 50, y: 5 }, 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('平行');
    expect(model.cons.size).toBe(0);
  });

  it('commitDim 驱动求解收敛到新的夹角', () => {
    const { line1, line2 } = angleLines();
    const result = dimForLines(line1, line2, { x: 20, y: 5 }, 1);
    if (!result.ok) throw new Error('尺寸创建失败');
    const committed = commitDim(result.con, 60);
    expect(committed.ok).toBe(true);
    const g = angleLineGeometry(line1, line2);
    if (!g) throw new Error('直线求交失败');
    // 放置象限 0 的夹角（两条线的方向夹角）应为 60°
    const d1 = g.d1;
    const d2 = g.d2;
    const cos = (d1.x * d2.x + d1.y * d2.y) / (Math.hypot(d1.x, d1.y) * Math.hypot(d2.x, d2.y));
    expect((Math.acos(cos) * 180) / Math.PI).toBeCloseTo(60, 3);
  });

  it('角度输入超过 180° 被拒绝，目标值不变', () => {
    const { line1, line2 } = angleLines();
    const result = dimForLines(line1, line2, { x: 20, y: 5 }, 1);
    if (!result.ok) throw new Error('尺寸创建失败');
    const before = dimValue(result.con);
    const committed = commitDim(result.con, 180);
    expect(committed.ok).toBe(false);
    if (!committed.ok) expect(committed.reason).toContain('180');
    expect(dimValue(result.con)).toBe(before);
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
    expect(solve(80, { silent: true })).toEqual([]);
  });

  it('无效约束提示错误，冲突约束提示未满足', () => {
    const circle = addCircle(addPt(0, 0), 10);
    addCon('horizontal', { e: circle.id }); // 种类不符 → invalid
    const notices = solve(80);
    expect(
      notices.some((n) => n.kind === 'error' && n.message.includes('引用了不存在的对象')),
    ).toBe(true);

    clearModel();
    const a = addPt(0, 0, true);
    const b = addPt(10, 5, true);
    const line = addLine(a, b);
    addCon('horizontal', { e: line.id });
    const conflict = solve(80);
    expect(conflict.some((n) => n.message.includes('约束未完全满足'))).toBe(true);
    expect(isDimConstraint(addCon('horizontal', { e: line.id }))).toBe(false);
  });
});
