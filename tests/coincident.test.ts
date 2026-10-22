/**
 * 「重合」约束的多态分派与求解收敛（经 operations.ts 的统一命令引擎）。
 * 「重合」不是单一 kind：同一个按钮按「锚点 + 目标对象」分派到三种残差——
 * 2 个点 → coincident、点 + 直线 → pointOnLine、点 + 圆/弧 → pointOnCircle。
 * 本文件从两层钉住它，避免「按钮能点但写错 kind / 残差永远不收敛」：
 * 1) 槽位填充与上下文排除：点图元按点身份参与；点已是目标直线端点/圆心的组合在
 *    填槽位阶段就被挡住（假约束 / 半径被挤成 0），对象数/类型不对时保持收集态且不写模型；
 * 2) 求解：execute 写入后立即求解（ITER_CONSTRAINT），用残差≈0 证明
 *    constraints.ts 的 coincident / pointOnLine / pointOnCircle 方程确实收敛。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { addArc, addCircle, addLine, addPointEntity, addPt, clearModel, model } from '../src/model';
import {
  createSession,
  executeCommand,
  fillFromOperands,
  operandsFromSelection,
} from '../src/operations';
import { resetInteraction } from '../src/state';
import type { Entity, Point, Selection } from '../src/types';
import { vec } from '../src/vec';

const sel = (entities: readonly Entity[] = [], points: readonly Point[] = []): Selection => ({
  items: [
    ...entities.map((e) => ({ kind: 'ent' as const, id: e.id })),
    ...points.map((p) => ({ kind: 'pt' as const, id: p.id })),
  ],
});

/** 选择集预填「重合」槽位 */
const arm = (selection: Selection) => {
  const session = createSession('coincident');
  const fill = fillFromOperands(session, operandsFromSelection(selection));
  return { session, ...fill };
};

/** 选择集预填 → 执行；返回普通动作结果 */
const run = (selection: Selection) => {
  const { session } = arm(selection);
  const outcome = executeCommand(session, 1);
  if (outcome.kind !== 'action') throw new Error('重合应返回普通动作');
  return outcome.result;
};

/** 当前模型里的约束（按插入顺序） */
const cons = () => [...model.cons.values()];

beforeEach(() => {
  clearModel();
  resetInteraction();
});

describe('重合：多态分派', () => {
  it('2 个显式点 → coincident', () => {
    const p1 = addPt(0, 0);
    const p2 = addPt(10, 5);

    const result = run(sel([], [p1, p2]));

    expect(result.ok).toBe(true);
    expect(cons()).toHaveLength(1);
    expect(cons()[0]).toMatchObject({ type: 'coincident' });
    expect(new Set([cons()[0]?.a, cons()[0]?.b])).toEqual(new Set([p1.id, p2.id]));
  });

  it('2 个点图元 → coincident（展开成它们引用的点）', () => {
    const p1 = addPt(0, 0);
    const p2 = addPt(10, 5);
    const e1 = addPointEntity(p1);
    const e2 = addPointEntity(p2);

    const result = run(sel([e1, e2]));

    expect(result.ok).toBe(true);
    expect(cons()[0]).toMatchObject({ type: 'coincident' });
    expect(new Set([cons()[0]?.a, cons()[0]?.b])).toEqual(new Set([p1.id, p2.id]));
  });

  it('点图元 + 显式点 → coincident（两种点的来源都算数）', () => {
    const p1 = addPt(0, 0);
    const e1 = addPointEntity(p1);
    const p2 = addPt(10, 5);

    const result = run(sel([e1], [p2]));

    expect(result.ok).toBe(true);
    const con = cons()[0];
    expect(con?.type).toBe('coincident');
    // coincident 的 a/b 是无序引用，只要求引用集合正确
    expect(new Set([con?.a, con?.b])).toEqual(new Set([p1.id, p2.id]));
  });

  it('点 + 直线 → pointOnLine', () => {
    const line = addLine(addPt(0, 0), addPt(100, 0));
    const p = addPt(50, 20);

    const result = run(sel([line], [p]));

    expect(result.ok).toBe(true);
    expect(cons()[0]).toMatchObject({ type: 'pointOnLine', p: p.id, e: line.id });
  });

  it('点图元 + 直线 → pointOnLine（点图元展开后作为锚点）', () => {
    const line = addLine(addPt(0, 0), addPt(100, 0));
    const p = addPt(50, 20);
    const e = addPointEntity(p);

    const result = run(sel([line, e]));

    expect(result.ok).toBe(true);
    expect(cons()[0]).toMatchObject({ type: 'pointOnLine', p: p.id, e: line.id });
  });

  it('点 + 圆 → pointOnCircle', () => {
    const circle = addCircle(addPt(0, 0, true), 10);
    const p = addPt(20, 0);

    const result = run(sel([circle], [p]));

    expect(result.ok).toBe(true);
    expect(cons()[0]).toMatchObject({ type: 'pointOnCircle', p: p.id, e: circle.id });
  });

  it('点 + 圆弧 → pointOnCircle（圆/弧共用同一目标种类）', () => {
    const arc = addArc(addPt(0, 0, true), 10, 0, Math.PI);
    const p = addPt(20, 0);

    const result = run(sel([arc], [p]));

    expect(result.ok).toBe(true);
    expect(cons()[0]).toMatchObject({ type: 'pointOnCircle', p: p.id, e: arc.id });
  });

  it('点已是该直线端点 → 填槽位阶段拒绝（点-线重合会恒成立）', () => {
    const a = addPt(0, 0);
    const line = addLine(a, addPt(100, 0));
    const e = addPointEntity(a);

    const { session, reasons } = arm(sel([line, e]));
    expect(reasons.some((r) => r.includes('端点'))).toBe(true);
    // 目标槽位被上下文排除、锚点槽位被点填上：会话不完整，不能执行
    expect(session.values.filter((v) => v !== undefined)).toHaveLength(1);
    // 直线先占住目标槽位，已作为端点的点被锚点槽位的上下文排除挡住
    expect(session.values[0]).toBeUndefined();
    expect(session.values[1]).toBeDefined();
    const outcome = executeCommand(session, 1);
    expect(outcome.kind).toBe('action');
    if (outcome.kind === 'action') expect(outcome.result.ok).toBe(false);
    expect(cons()).toHaveLength(0);
  });

  it('点已是圆/弧的圆心 → 填槽位阶段拒绝（否则会把半径挤成 0）', () => {
    const center = addPt(0, 0, true);
    const circle = addCircle(center, 10);
    const arcCenter = addPt(50, 50, true);
    const arc = addArc(arcCenter, 10, 0, Math.PI);

    for (const [entity, point] of [
      [circle, center],
      [arc, arcCenter],
    ] as const) {
      const { reasons } = arm(sel([entity], [point]));
      expect(
        reasons.some((r) => r.includes('圆心')),
        `${entity.type} 的圆心`,
      ).toBe(true);
    }
    expect(cons()).toHaveLength(0);
    // 守卫保证圆不会被求解器压成零半径
    expect(circle.r).toBe(10);
    expect(arc.r).toBe(10);
  });

  it('同一个点不能和自己重合（显式点 + 拥有它的点图元）', () => {
    const p = addPt(0, 0);
    const e = addPointEntity(p);

    const { session, reasons } = arm(sel([e], [p]));
    expect(reasons.some((r) => r.includes('自己'))).toBe(true);
    expect(session.values.filter((v) => v !== undefined)).toHaveLength(1);
    expect(cons()).toHaveLength(0);
  });
});

describe('重合：非法/多余选择不写模型', () => {
  it('空选择 / 2 图元没有点 → 槽位不齐，执行失败且不写模型', () => {
    const line = addLine(addPt(0, 0), addPt(100, 0));
    const circle = addCircle(addPt(200, 0), 10);
    const cases: Array<[Selection, string]> = [
      [sel(), '空选择'],
      [sel([line, circle]), '2 图元没有点'],
    ];

    for (const [selection, label] of cases) {
      const result = run(selection);
      expect(result.ok, label).toBe(false);
      if (result.ok) continue;
      expect(result.reason.length, label).toBeGreaterThan(0);
      expect(model.cons.size, label).toBe(0);
    }
  });

  it('多出来的不适用对象被忽略（选择集比槽位多时不报错）', () => {
    const line = addLine(addPt(0, 0), addPt(100, 0));
    const extra = addLine(addPt(0, 50), addPt(100, 50));
    const p = addPt(50, 20);

    const { session, used } = arm(sel([line, extra], [p]));
    expect(used).toBe(2); // 点 + 一条直线；另一条直线无处可填
    expect(model.cons.size).toBe(0);
    const outcome = executeCommand(session, 1);
    expect(outcome.kind).toBe('action');
    if (outcome.kind === 'action') expect(outcome.result.ok).toBe(true);
    expect(cons().filter((c) => c.type === 'pointOnLine')).toHaveLength(1);
  });
});

describe('重合：去重', () => {
  it('两个点反序选择只保留一条 coincident', () => {
    const p1 = addPt(0, 0);
    const p2 = addPt(10, 5);
    expect(run(sel([], [p1, p2])).ok).toBe(true);

    const again = run(sel([], [p2, p1]));

    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.reason).toContain('已存在');
    expect(cons().filter((c) => c.type === 'coincident')).toHaveLength(1);
  });

  it('两个点图元反序选择只保留一条 coincident', () => {
    const e1 = addPointEntity(addPt(0, 0));
    const e2 = addPointEntity(addPt(10, 5));
    expect(run(sel([e1, e2])).ok).toBe(true);

    const again = run(sel([e2, e1]));

    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.reason).toContain('已存在');
    expect(cons()).toHaveLength(1);
  });

  it('点 + 直线重复添加被跳过', () => {
    const line = addLine(addPt(0, 0), addPt(100, 0));
    const p = addPt(50, 20);
    expect(run(sel([line], [p])).ok).toBe(true);

    const again = run(sel([line], [p]));

    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.reason).toContain('已存在');
    expect(cons().filter((c) => c.type === 'pointOnLine')).toHaveLength(1);
  });
});

describe('重合：求解收敛', () => {
  it('两个自由点重合后坐标一致，且不产生求解告警', () => {
    const p1 = addPt(0, 0);
    const p2 = addPt(10, 5);

    const result = run(sel([], [p1, p2]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notices).toEqual([]);
    expect(vec.dist(p1, p2)).toBeLessThan(1e-6);
  });

  it('两个点图元重合后坐标一致', () => {
    const p1 = addPt(0, 0);
    const p2 = addPt(10, 5);
    const e1 = addPointEntity(p1);
    const e2 = addPointEntity(p2);

    const result = run(sel([e1, e2]));

    expect(result.ok).toBe(true);
    expect(vec.dist(p1, p2)).toBeLessThan(1e-6);
  });

  it('固定直线两端点后，自由点被拉到线上', () => {
    // 直线 y=0 的两个端点固定：点只能自己动，残差 p.y 必须收敛到 0
    const a = addPt(0, 0, true);
    const b = addPt(100, 0, true);
    const line = addLine(a, b);
    const p = addPt(50, 20);

    const result = run(sel([line], [p]));

    expect(result.ok).toBe(true);
    expect(Math.abs(p.y)).toBeLessThan(1e-6);
  });

  it('点 + 圆：dist(center, point) - r 收敛到 0', () => {
    const center = addPt(0, 0, true);
    const circle = addCircle(center, 10);
    const p = addPt(20, 0);

    const result = run(sel([circle], [p]));

    expect(result.ok).toBe(true);
    expect(Math.abs(vec.dist(center, p) - circle.r)).toBeLessThan(1e-6);
  });
});
