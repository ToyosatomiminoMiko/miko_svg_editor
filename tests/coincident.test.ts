/**
 * 「重合」约束的多态分派与求解收敛（经 sketch-actions.applyConstraint 的公开入口）。
 * 「重合」不是单一 kind：同一个按钮按「锚点 + 目标对象」分派到三种残差——
 * 2 个点 → coincident、点 + 直线 → pointOnLine、点 + 圆/弧 → pointOnCircle。
 * 本文件从两层钉住它，避免「按钮能点但写错 kind / 残差永远不收敛」：
 * 1) 分派与拒绝规则：点图元展开成它引用的点；点已是该直线端点时拒绝（否则是恒成立的假约束）；
 *    对象数/类型不对、重复添加都要给出理由且不写模型；反序选择必须落到同一条约束；
 * 2) 求解：applyConstraint 写入后立即求解（ITER_CONSTRAINT），用残差≈0 证明
 *    constraints.ts 的 coincident / pointOnLine / pointOnCircle 方程确实收敛。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { ConstraintSelection } from '../src/config';
import { addArc, addCircle, addLine, addPointEntity, addPt, clearModel, model } from '../src/model';
import { applyConstraint } from '../src/sketch-actions';
import { resetInteraction } from '../src/state';
import type { Entity, Point } from '../src/types';
import { vec } from '../src/vec';

/** 约束动作统一接收 {entities, points}；重合的点既可以是显式点也可以是点图元 */
const sel = (
  entities: readonly Entity[] = [],
  points: readonly Point[] = [],
): ConstraintSelection => ({ entities, points });

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

    const result = applyConstraint('coincident', sel([], [p1, p2]));

    expect(result.ok).toBe(true);
    expect(cons()).toHaveLength(1);
    expect(cons()[0]).toMatchObject({ type: 'coincident', a: p1.id, b: p2.id });
  });

  it('2 个点图元 → coincident（展开成它们引用的点）', () => {
    const p1 = addPt(0, 0);
    const p2 = addPt(10, 5);
    const e1 = addPointEntity(p1);
    const e2 = addPointEntity(p2);

    const result = applyConstraint('coincident', sel([e1, e2]));

    expect(result.ok).toBe(true);
    expect(cons()[0]).toMatchObject({ type: 'coincident', a: p1.id, b: p2.id });
  });

  it('点图元 + 显式点 → coincident（两种点的来源都算数）', () => {
    const p1 = addPt(0, 0);
    const e1 = addPointEntity(p1);
    const p2 = addPt(10, 5);

    const result = applyConstraint('coincident', sel([e1], [p2]));

    expect(result.ok).toBe(true);
    const con = cons()[0];
    expect(con?.type).toBe('coincident');
    // coincident 的 a/b 是无序引用，只要求引用集合正确
    expect(new Set([con?.a, con?.b])).toEqual(new Set([p1.id, p2.id]));
  });

  it('点 + 直线 → pointOnLine', () => {
    const line = addLine(addPt(0, 0), addPt(100, 0));
    const p = addPt(50, 20);

    const result = applyConstraint('coincident', sel([line], [p]));

    expect(result.ok).toBe(true);
    expect(cons()[0]).toMatchObject({ type: 'pointOnLine', p: p.id, e: line.id });
  });

  it('点图元 + 直线 → pointOnLine（点图元展开后作为锚点）', () => {
    const line = addLine(addPt(0, 0), addPt(100, 0));
    const p = addPt(50, 20);
    const e = addPointEntity(p);

    const result = applyConstraint('coincident', sel([line, e]));

    expect(result.ok).toBe(true);
    expect(cons()[0]).toMatchObject({ type: 'pointOnLine', p: p.id, e: line.id });
  });

  it('点 + 圆 → pointOnCircle', () => {
    const circle = addCircle(addPt(0, 0, true), 10);
    const p = addPt(20, 0);

    const result = applyConstraint('coincident', sel([circle], [p]));

    expect(result.ok).toBe(true);
    expect(cons()[0]).toMatchObject({ type: 'pointOnCircle', p: p.id, e: circle.id });
  });

  it('点 + 圆弧 → pointOnCircle（圆/弧共用同一目标种类）', () => {
    const arc = addArc(addPt(0, 0, true), 10, 0, Math.PI);
    const p = addPt(20, 0);

    const result = applyConstraint('coincident', sel([arc], [p]));

    expect(result.ok).toBe(true);
    expect(cons()[0]).toMatchObject({ type: 'pointOnCircle', p: p.id, e: arc.id });
  });

  it('点已是该直线端点 → 拒绝（点-线重合会恒成立）', () => {
    const a = addPt(0, 0);
    const line = addLine(a, addPt(100, 0));
    const e = addPointEntity(a);

    const result = applyConstraint('coincident', sel([line, e]));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('端点');
    expect(cons()).toHaveLength(0);
  });

  it('点已是圆/弧的圆心 → 拒绝（否则会把半径挤成 0）', () => {
    const center = addPt(0, 0, true);
    const circle = addCircle(center, 10);
    const arcCenter = addPt(50, 50, true);
    const arc = addArc(arcCenter, 10, 0, Math.PI);

    for (const [entity, point] of [
      [circle, center],
      [arc, arcCenter],
    ] as const) {
      const result = applyConstraint('coincident', sel([entity], [point]));
      expect(result.ok, `${entity.type} 的圆心`).toBe(false);
      if (!result.ok) expect(result.reason).toContain('圆心');
    }
    expect(cons()).toHaveLength(0);
    // 守卫保证圆不会被求解器压成零半径
    expect(circle.r).toBe(10);
    expect(arc.r).toBe(10);
  });

  it('同一个点不能和自己重合（显式点 + 拥有它的点图元）', () => {
    const p = addPt(0, 0);
    const e = addPointEntity(p);

    const result = applyConstraint('coincident', sel([e], [p]));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('自己');
    expect(cons()).toHaveLength(0);
  });
});

describe('重合：非法选择不写模型', () => {
  it('空选择 / 2 图元没有点 / 3 个对象 / 点 + 2 图元 → 失败且给出理由', () => {
    const line = addLine(addPt(0, 0), addPt(100, 0));
    const circle = addCircle(addPt(200, 0), 10);
    const cases: Array<[ConstraintSelection, string]> = [
      [sel(), '空选择'],
      [sel([line, circle]), '2 图元没有点'],
      [sel([line], [addPt(0, 50), addPt(50, 50)]), '3 个对象'],
      [sel([line, circle], [addPt(0, 50)]), '点 + 2 图元'],
    ];

    for (const [selection, label] of cases) {
      const before = model.cons.size;
      const result = applyConstraint('coincident', selection);
      expect(result.ok, label).toBe(false);
      if (result.ok) continue;
      expect(result.reason.length, label).toBeGreaterThan(0);
      expect(model.cons.size, label).toBe(before);
    }
  });
});

describe('重合：去重', () => {
  it('两个点反序选择只保留一条 coincident', () => {
    const p1 = addPt(0, 0);
    const p2 = addPt(10, 5);
    expect(applyConstraint('coincident', sel([], [p1, p2])).ok).toBe(true);

    const again = applyConstraint('coincident', sel([], [p2, p1]));

    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.reason).toContain('已存在');
    expect(cons().filter((c) => c.type === 'coincident')).toHaveLength(1);
  });

  it('两个点图元反序选择只保留一条 coincident', () => {
    const e1 = addPointEntity(addPt(0, 0));
    const e2 = addPointEntity(addPt(10, 5));
    expect(applyConstraint('coincident', sel([e1, e2])).ok).toBe(true);

    const again = applyConstraint('coincident', sel([e2, e1]));

    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.reason).toContain('已存在');
    expect(cons()).toHaveLength(1);
  });

  it('点 + 直线重复添加被跳过', () => {
    const line = addLine(addPt(0, 0), addPt(100, 0));
    const p = addPt(50, 20);
    expect(applyConstraint('coincident', sel([line], [p])).ok).toBe(true);

    const again = applyConstraint('coincident', sel([line], [p]));

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

    const result = applyConstraint('coincident', sel([], [p1, p2]));

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

    const result = applyConstraint('coincident', sel([e1, e2]));

    expect(result.ok).toBe(true);
    expect(vec.dist(p1, p2)).toBeLessThan(1e-6);
  });

  it('固定直线两端点后，自由点被拉到线上', () => {
    // 直线 y=0 的两个端点固定：点只能自己动，残差 p.y 必须收敛到 0
    const a = addPt(0, 0, true);
    const b = addPt(100, 0, true);
    const line = addLine(a, b);
    const p = addPt(50, 20);

    const result = applyConstraint('coincident', sel([line], [p]));

    expect(result.ok).toBe(true);
    expect(Math.abs(p.y)).toBeLessThan(1e-6);
  });

  it('点 + 圆：dist(center, point) - r 收敛到 0', () => {
    const center = addPt(0, 0, true);
    const circle = addCircle(center, 10);
    const p = addPt(20, 0);

    const result = applyConstraint('coincident', sel([circle], [p]));

    expect(result.ok).toBe(true);
    expect(Math.abs(vec.dist(center, p) - circle.r)).toBeLessThan(1e-6);
  });
});
