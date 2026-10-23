/**
 * 「共线」约束：两条直线落在同一条无限长直线上（对齐 FreeCAD 的 Collinear 语义）。
 * 残差有 2 个（见 constraints.ts 的 RESID.collinear）：
 * 1) crs(d1, d2) / (|d1| * |d2|)：方向平行。叉积除以模长积 = 夹角正弦，无量纲，
 *    长短线在最小二乘里权重一致；
 * 2) crs(a2 - a1, d1) / |d1|：e2 起点 a2 到 e1 所在无限长直线的有符号距离（世界单位）。
 * 两者同时为 0 才共线：只满足 1) 只是平行（两条平行线可以相距任意远）。
 * 本文件从「残差值 → 求解收敛 → 操作槽位/去重 → 已选列表文案 → 级联删除/悬空引用」
 * 钉住整条链路，避免按钮能点但写错 kind 或残差永远不收敛。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { RESID } from '../../src/core/constraints';
import {
  addCircle,
  addCon,
  addLine,
  addPt,
  clearModel,
  model,
  removeEntity,
} from '../../src/core/model';
import {
  createSession,
  executeCommand,
  fillFromOperands,
  operandsFromSelection,
  operationById,
} from '../../src/core/operations';
import { selectionEntries } from '../../src/core/selection';
import { solveSketch } from '../../src/core/solver';
import { resetInteraction, selectOnly } from '../../src/core/state';
import type { Entity } from '../../src/core/entities';
import type { Selection } from '../../src/core/types';
import { vec } from '../../src/core/vec';

/** 图元选择集：顺序即用户点击顺序（决定哪个进 e1、哪个进 e2 槽位） */
const entSel = (...entities: readonly Entity[]): Selection => ({
  items: entities.map((e) => ({ kind: 'ent', id: e.id })),
});

/** 选择集预填「共线」槽位 */
const arm = (selection: Selection) => {
  const session = createSession('collinear');
  const fill = fillFromOperands(session, operandsFromSelection(selection));
  return { session, ...fill };
};

/** 选择集预填 → 执行；返回普通动作结果 */
const run = (selection: Selection) => {
  const { session } = arm(selection);
  const outcome = executeCommand(session, 1);
  if (outcome.kind !== 'action') throw new Error('共线应返回普通动作');
  return outcome.result;
};

/** 当前模型里的约束（按插入顺序） */
const cons = () => [...model.cons.values()];

beforeEach(() => {
  clearModel();
  resetInteraction();
});

describe('共线：RESID 残差值', () => {
  it('已经共线的两条水平线：两个残差都 ≈ 0', () => {
    const l1 = addLine(addPt(0, 0), addPt(100, 0));
    const l2 = addLine(addPt(200, 0), addPt(300, 0));
    const con = addCon('collinear', { e1: l1.id, e2: l2.id });

    const r = RESID.collinear(con);

    expect(r).toHaveLength(2);
    expect(Math.abs(r[0]!)).toBeLessThan(1e-12);
    expect(Math.abs(r[1]!)).toBeLessThan(1e-12);
  });

  it('平行但错开 y=10：方向残差 ≈ 0，距离残差 ≈ -10（有符号距离）', () => {
    const l1 = addLine(addPt(0, 0), addPt(100, 0));
    const l2 = addLine(addPt(0, 10), addPt(100, 10));
    const con = addCon('collinear', { e1: l1.id, e2: l2.id });

    const r = RESID.collinear(con);

    expect(Math.abs(r[0]!)).toBeLessThan(1e-12);
    // crs((0,10),(100,0)) / |(100,0)| = -1000 / 100 = -10；符号随叉积方向，绝对值即线间距
    expect(r[1]!).toBeCloseTo(-10, 9);
    expect(Math.abs(r[1]!)).toBeCloseTo(10, 9);
  });

  it('相交但不平行：方向残差 ≠ 0（这里互相垂直，sin=1），残差整体非零', () => {
    const l1 = addLine(addPt(0, 0), addPt(100, 0));
    const l2 = addLine(addPt(0, 0), addPt(0, 100));
    const con = addCon('collinear', { e1: l1.id, e2: l2.id });

    const r = RESID.collinear(con);

    expect(r[0]!).toBeCloseTo(1, 9);
    // 两线都过原点，距离残差本来就是 0；但共线要求两个残差同时为 0
    expect(Math.abs(r[1]!)).toBeLessThan(1e-12);
    expect(r.some((v) => Math.abs(v) > 1e-6)).toBe(true);
  });

  it('方向残差是无量纲的 sin 值（与线长无关），距离残差带长度量纲（按比例缩放）', () => {
    // 两组完全相似的几何，第二组整体放大 1000 倍：
    // r0 不变 → 已按 (|d1||d2|) 归一；r1 放大 1000 → 仍是世界长度
    const baseL1 = addLine(addPt(0, 0), addPt(10, 0));
    const baseL2 = addLine(addPt(20, 5), addPt(30, 15));
    const scaledL1 = addLine(addPt(0, 0), addPt(10000, 0));
    const scaledL2 = addLine(addPt(20000, 5000), addPt(30000, 15000));

    const rBase = RESID.collinear(addCon('collinear', { e1: baseL1.id, e2: baseL2.id }));
    const rScaled = RESID.collinear(addCon('collinear', { e1: scaledL1.id, e2: scaledL2.id }));

    expect(rBase[0]!).toBeCloseTo(1 / Math.SQRT2, 9);
    expect(rScaled[0]!).toBeCloseTo(rBase[0]!, 9);
    expect(rBase[1]!).toBeCloseTo(-5, 9);
    expect(rScaled[1]!).toBeCloseTo(rBase[1]! * 1000, 6);
    for (const v of [...rBase, ...rScaled]) expect(Number.isFinite(v)).toBe(true);
  });

  it('零长度直线（两端点重合）不产生 NaN/Infinity：safeLen 兜底为 1', () => {
    const degenerate = addLine(addPt(0, 0), addPt(0, 0));
    const l2 = addLine(addPt(10, 10), addPt(20, 20));
    const con = addCon('collinear', { e1: degenerate.id, e2: l2.id });

    const r = RESID.collinear(con);

    expect(r).toHaveLength(2);
    for (const v of r) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('共线：求解收敛', () => {
  it('两条歪斜直线求解后：方向叉积 ≈ 0，e2 起点到 e1 所在直线的距离 ≈ 0', () => {
    const a1 = addPt(0, 0);
    const b1 = addPt(100, 5);
    const a2 = addPt(0, 20);
    const b2 = addPt(100, 40);
    const l1 = addLine(a1, b1);
    const l2 = addLine(a2, b2);
    addCon('collinear', { e1: l1.id, e2: l2.id });

    const result = solveSketch();

    expect(result.converged).toBe(true);
    expect(result.invalidConstraints).toEqual([]);
    // 用残差的几何定义复算，而不是调 RESID，避免「实现和测试一起错」。
    // 叉积本身带长度量纲（约 100×100），先除以模长积才是无量纲的方向残差。
    const d1 = vec.sub(b1, a1);
    const d2 = vec.sub(b2, a2);
    const sine = vec.crs(d1, d2) / (vec.safeLen(d1) * vec.safeLen(d2));
    expect(Math.abs(sine)).toBeLessThan(1e-6);
    expect(Math.abs(vec.crs(vec.sub(a2, a1), d1)) / vec.safeLen(d1)).toBeLessThan(1e-6);
  });

  it('固定第一组端点：自由直线被拉到同一条无限长直线上', () => {
    const a1 = addPt(0, 0, true);
    const b1 = addPt(100, 0, true);
    const a2 = addPt(0, 20);
    const b2 = addPt(100, 40);
    const l1 = addLine(a1, b1);
    const l2 = addLine(a2, b2);
    addCon('collinear', { e1: l1.id, e2: l2.id });

    const result = solveSketch();

    expect(result.converged).toBe(true);
    // 残差 1 就是 a2 的有符号 y 距离；残差 0 迫使 b2.y - a2.y = 0
    expect(Math.abs(a2.y)).toBeLessThan(1e-6);
    expect(Math.abs(b2.y)).toBeLessThan(1e-6);
    // 固定点完全不动
    expect([a1.x, a1.y, b1.x, b1.y]).toEqual([0, 0, 100, 0]);
  });
});

describe('共线：操作槽位与执行', () => {
  it('操作元数据：一个按钮「共线」、两个直线槽位', () => {
    const op = operationById('collinear');

    expect(op.label).toBe('共线');
    expect(op.group).toBe('constraint');
    expect(op.slots([])).toHaveLength(2);
  });

  it('选择两条直线执行：只新增一条 kind=collinear 的约束，e1/e2 对应选择顺序', () => {
    const l1 = addLine(addPt(0, 0), addPt(100, 0));
    const l2 = addLine(addPt(0, 20), addPt(100, 30));

    const result = run(entSel(l1, l2));

    expect(result.ok).toBe(true);
    const added = cons();
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ type: 'collinear', e1: l1.id, e2: l2.id });
  });

  it('反序选择同一对直线：去重失败提示「相同约束已存在」，模型仍只有 1 条', () => {
    const l1 = addLine(addPt(0, 0), addPt(100, 0));
    const l2 = addLine(addPt(0, 20), addPt(100, 30));
    expect(run(entSel(l1, l2)).ok).toBe(true);

    const again = run(entSel(l2, l1));

    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.reason).toContain('已存在');
    expect(cons()).toHaveLength(1);
  });

  it('同一条直线填两个槽位：第二个槽位被通用重复逻辑挡住', () => {
    const l1 = addLine(addPt(0, 0), addPt(100, 0));

    const { session, used, reasons } = arm(entSel(l1, l1));

    expect(used).toBe(1);
    expect(reasons.some((r) => r.includes('重复'))).toBe(true);
    expect(session.values[1]).toBeUndefined();
    const outcome = executeCommand(session, 1);
    expect(outcome.kind).toBe('action');
    if (outcome.kind === 'action') expect(outcome.result.ok).toBe(false);
    expect(cons()).toHaveLength(0);
  });

  it('只选一条直线 / 选到非直线对象：槽位填不满，执行失败且不写模型', () => {
    const line = addLine(addPt(0, 0), addPt(100, 0));
    const circle = addCircle(addPt(300, 0), 10);

    const cases: Array<[Selection, string]> = [
      [entSel(line), '只选一条直线'],
      [entSel(line, circle), '圆不接受直线槽位'],
    ];
    for (const [selection, label] of cases) {
      const { session, used } = arm(selection);
      expect(used, label).toBe(1);
      expect(session.values[1], label).toBeUndefined();
      const result = run(selection);
      expect(result.ok, label).toBe(false);
      expect(model.cons.size, label).toBe(0);
    }
  });
});

describe('共线：已选列表文案', () => {
  it('两条直线的行内约束都显示「共线」', () => {
    const l1 = addLine(addPt(0, 0), addPt(100, 0));
    const l2 = addLine(addPt(0, 10), addPt(100, 10));
    const con = addCon('collinear', { e1: l1.id, e2: l2.id });

    selectOnly([
      { kind: 'ent', id: l1.id },
      { kind: 'ent', id: l2.id },
    ]);

    // 共线的两个引用都是图元，两条直线各自都该看到这条约束（同一条约束只出现一次/行）
    expect(selectionEntries().map((entry) => entry.constraints)).toEqual([
      [{ id: con.id, text: '共线' }],
      [{ id: con.id, text: '共线' }],
    ]);
  });
});

describe('共线：级联删除与无效引用', () => {
  it('删除其中一条直线：引用它的共线约束被级联删除，另一条直线保留', () => {
    const l1 = addLine(addPt(0, 0), addPt(100, 0));
    const l2 = addLine(addPt(50, 0), addPt(150, 0));
    addCon('collinear', { e1: l1.id, e2: l2.id });
    expect(model.cons.size).toBe(1);

    removeEntity(l1);

    expect(model.cons.size).toBe(0);
    expect(model.ents.has(l2.id)).toBe(true);
  });

  it('悬空引用：e1 指向不存在的 id 时记入 invalidConstraints，不抛错', () => {
    const l2 = addLine(addPt(0, 0), addPt(100, 0));
    const dangling = addCon('collinear', { e1: 999_999, e2: l2.id });

    const result = solveSketch();

    expect(result.invalidConstraints).toContain(dangling.id);
    // 无效约束被跳过，其余部分照常求解
    expect(result.converged).toBe(true);
  });
});
