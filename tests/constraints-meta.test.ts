/**
 * config/constraints-meta.ts 的约束元数据与动作解析。
 * 三件事必须同时成立，否则「查表 + 校验 + 构造 + 去重」的单一来源会漏：
 * 1) 18 种 ConstraintKind 都有元数据与引用字段（Record 穷尽在运行时也要有测试兜底）；
 * 2) 每个 UI 动作的 resolve 在合法/非法选择上都给出明确结果（不抛异常、失败带理由）；
 * 3) constraintRefKey 只由 kind + refs 引用字段组成，保证同组约束去重。
 */

import { describe, expect, it } from 'vitest';
import {
  CONSTRAINT_ACTIONS,
  CONSTRAINT_META,
  ENTITY_REF_KEYS,
  POINT_REF_KEYS,
  constraintRefKey,
} from '../src/config/constraints-meta';
import type { ConstraintAction, ConstraintActionMeta } from '../src/config/constraints-meta';
import type { ArcEntity, CircleEntity, ConstraintKind, Entity, LineEntity } from '../src/types';

/** 18 种约束种类，显式列出：元数据表增删时测试需要人跟着改，防止悄悄漂移 */
const ALL_KINDS: readonly ConstraintKind[] = [
  'coincident',
  'horizontal',
  'vertical',
  'parallel',
  'perpendicular',
  'equalLength',
  'pointOnLine',
  'pointOnCircle',
  'tangentLineCircle',
  'tangentCircleCircle',
  'concentric',
  'equalRadius',
  'distancePointPoint',
  'distancePointLine',
  'radius',
  'angle',
  'midpoint',
  'symmetric',
];

const line = (id: number): LineEntity => ({ id, type: 'line', construction: false, a: 1, b: 2 });
const circle = (id: number): CircleEntity => ({
  id,
  type: 'circle',
  construction: false,
  c: 3,
  r: 1,
});
const arc = (id: number): ArcEntity => ({
  id,
  type: 'arc',
  construction: false,
  c: 4,
  r: 1,
  a0: 0,
  a1: Math.PI,
});

const action = (id: ConstraintAction): ConstraintActionMeta => {
  const found = CONSTRAINT_ACTIONS.find((item) => item.id === id);
  if (!found) throw new Error(`缺少约束动作: ${id}`);
  return found;
};

describe('CONSTRAINT_META', () => {
  it('恰好覆盖 18 种 ConstraintKind', () => {
    const kinds = Object.keys(CONSTRAINT_META) as ConstraintKind[];
    expect(kinds).toHaveLength(18);
    expect([...kinds].sort()).toEqual([...ALL_KINDS].sort());
  });

  it('每种约束都有 label、ui 标记和至少一个引用字段', () => {
    for (const kind of ALL_KINDS) {
      const meta = CONSTRAINT_META[kind];
      expect(meta, kind).toBeDefined();
      expect(meta.label.length, kind).toBeGreaterThan(0);
      expect(typeof meta.ui, kind).toBe('boolean');
      expect(meta.refs.length, kind).toBeGreaterThan(0);
    }
  });

  it('引用字段的 key 合法且在同一约束内不重复', () => {
    const validKeys = new Set<string>(['e', 'e1', 'e2', 'line', 'circ', 'a', 'b', 'p', 'p1', 'p2']);
    for (const kind of ALL_KINDS) {
      const keys = CONSTRAINT_META[kind].refs.map((ref) => String(ref.key));
      expect(keys.length, kind).toBe(new Set(keys).size);
      for (const key of keys) {
        expect(validKeys.has(key), `${kind} 的引用字段 ${key}`).toBe(true);
      }
    }
  });

  it('图元引用声明可接受的图元种类，点引用不声明', () => {
    const entityKinds = new Set(['line', 'circle', 'arc']);
    for (const kind of ALL_KINDS) {
      for (const ref of CONSTRAINT_META[kind].refs) {
        expect(['entity', 'point'], kind).toContain(ref.kind);
        if (ref.kind === 'entity') {
          expect(ref.accepts, `${kind}.${String(ref.key)}`).toBeDefined();
          expect(ref.accepts?.length ?? 0).toBeGreaterThan(0);
          for (const accepted of ref.accepts ?? []) {
            expect(entityKinds.has(accepted), `${kind}.${String(ref.key)} 接受 ${accepted}`).toBe(
              true,
            );
          }
        } else {
          expect(ref.accepts, `${kind}.${String(ref.key)} 是点引用`).toBeUndefined();
        }
      }
    }
  });
});

describe('引用字段推导', () => {
  it('ENTITY_REF_KEYS / POINT_REF_KEYS 由元数据表汇总而来', () => {
    expect(ENTITY_REF_KEYS).toEqual(['e', 'e1', 'e2', 'line', 'circ']);
    expect(POINT_REF_KEYS).toEqual(['a', 'b', 'p', 'p1', 'p2']);
  });

  it('每个引用键都真的被某个约束使用', () => {
    const allRefs = ALL_KINDS.flatMap((kind) => CONSTRAINT_META[kind].refs);
    const usedEntityKeys = new Set(allRefs.filter((r) => r.kind === 'entity').map((r) => r.key));
    const usedPointKeys = new Set(allRefs.filter((r) => r.kind === 'point').map((r) => r.key));
    expect(ENTITY_REF_KEYS).toEqual([...usedEntityKeys]);
    expect(POINT_REF_KEYS).toEqual([...usedPointKeys]);
  });
});

describe('CONSTRAINT_ACTIONS', () => {
  it('动作 id 不重复，且都有 label 与 resolve', () => {
    const ids = CONSTRAINT_ACTIONS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(CONSTRAINT_ACTIONS.length).toBeGreaterThan(0);
    for (const item of CONSTRAINT_ACTIONS) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(typeof item.resolve).toBe('function');
    }
  });

  it('horizontal / vertical：任意条直线逐条生成', () => {
    for (const id of ['horizontal', 'vertical'] as const) {
      const result = action(id).resolve([line(11), line(12)]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.items).toHaveLength(2);
      expect(result.items.map((item) => item.kind)).toEqual([id, id]);
      expect(result.items.map((item) => item.props.e)).toEqual([11, 12]);
    }
  });

  it('parallel / perpendicular / equalLength：两条直线生成一条约束', () => {
    for (const id of ['parallel', 'perpendicular', 'equalLength'] as const) {
      const result = action(id).resolve([line(21), line(22)]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.items).toEqual([{ kind: id, props: { e1: 21, e2: 22 } }]);
    }
  });

  it('tangent：直线 + 圆/弧 → tangentLineCircle', () => {
    const result = action('tangent').resolve([line(31), circle(32)]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toEqual([{ kind: 'tangentLineCircle', props: { line: 31, circ: 32 } }]);
  });

  it('tangent：两个曲线 → tangentCircleCircle', () => {
    const result = action('tangent').resolve([circle(41), arc(42)]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toEqual([{ kind: 'tangentCircleCircle', props: { e1: 41, e2: 42 } }]);
  });

  it('concentric / equalRadius：两个圆/弧 → 一条约束', () => {
    for (const id of ['concentric', 'equalRadius'] as const) {
      const result = action(id).resolve([circle(51), arc(52)]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.items).toEqual([{ kind: id, props: { e1: 51, e2: 52 } }]);
    }
  });

  it('解析出的 kind 一定在元数据表里', () => {
    const legalCases: Array<[ConstraintAction, Entity[]]> = [
      ['horizontal', [line(1)]],
      ['vertical', [line(2)]],
      ['parallel', [line(3), line(4)]],
      ['perpendicular', [line(5), line(6)]],
      ['equalLength', [line(7), line(8)]],
      ['tangent', [line(9), circle(10)]],
      ['tangent', [circle(11), arc(12)]],
      ['concentric', [circle(13), circle(14)]],
      ['equalRadius', [arc(15), arc(16)]],
    ];
    for (const [id, selected] of legalCases) {
      const result = action(id).resolve(selected);
      expect(result.ok, `${id}: ${JSON.stringify(selected)}`).toBe(true);
      if (!result.ok) continue;
      for (const item of result.items) {
        expect(Object.keys(CONSTRAINT_META)).toContain(item.kind);
      }
    }
  });

  it('非法选择返回失败并给出面向用户的理由，不抛异常', () => {
    const illegalCases: Array<[ConstraintAction, Entity[], string]> = [
      ['horizontal', [], '空选择'],
      ['horizontal', [circle(1)], '圆不能水平'],
      ['vertical', [arc(2)], '弧不能竖直'],
      ['parallel', [line(3)], '少选一条'],
      ['parallel', [line(4), circle(5)], '类型不对'],
      ['perpendicular', [circle(6), circle(7)], '两个圆不能垂直'],
      ['equalLength', [line(8), circle(9)], '线与圆不能等长'],
      ['tangent', [line(10)], '只选一条'],
      ['tangent', [line(11), line(12)], '两条直线不能相切'],
      ['tangent', [line(13), circle(14), circle(15)], '选太多'],
      ['concentric', [line(16), circle(17)], '线不能同心'],
      ['equalRadius', [line(18), line(19)], '直线没有半径'],
    ];

    for (const [id, selected, label] of illegalCases) {
      const result = action(id).resolve(selected);
      expect(result.ok, `${id} / ${label}`).toBe(false);
      if (result.ok) continue;
      expect(result.reason.length, `${id} / ${label}`).toBeGreaterThan(0);
    }
  });
});

describe('constraintRefKey', () => {
  it('同一 kind 同一组引用得到同一个键（可去重）', () => {
    expect(constraintRefKey('horizontal', { e: 1 })).toBe(constraintRefKey('horizontal', { e: 1 }));
    expect(constraintRefKey('parallel', { e1: 1, e2: 2 })).toBe(
      constraintRefKey('parallel', { e1: 1, e2: 2 }),
    );
    expect(constraintRefKey('coincident', { a: 7, b: 8 })).toBe(
      constraintRefKey('coincident', { a: 7, b: 8 }),
    );
  });

  it('引用不同 → 键不同', () => {
    expect(constraintRefKey('horizontal', { e: 1 })).not.toBe(
      constraintRefKey('horizontal', { e: 2 }),
    );
    expect(constraintRefKey('parallel', { e1: 1, e2: 2 })).not.toBe(
      constraintRefKey('parallel', { e1: 1, e2: 3 }),
    );
    // 无序引用（coincident 的 a/b、parallel 的 e1/e2）交换引用仍是同一约束；
    // 有序引用的种类（如 tangentLineCircle 的 line/circ）顺序仍然参与键。
    expect(constraintRefKey('tangentLineCircle', { line: 1, circ: 2 })).not.toBe(
      constraintRefKey('tangentLineCircle', { line: 2, circ: 1 }),
    );
  });

  it('kind 参与前缀：引用相同但种类不同 → 键不同', () => {
    expect(constraintRefKey('horizontal', { e: 1 })).not.toBe(
      constraintRefKey('vertical', { e: 1 }),
    );
  });

  it('非引用字段（distance / radius / offset）不参与去重键', () => {
    // 去重只针对「哪几个图元/点」，同组引用即使目标值不同也视为同一约束
    expect(constraintRefKey('radius', { e: 1, radius: 5 })).toBe(
      constraintRefKey('radius', { e: 1, radius: 6 }),
    );
    expect(constraintRefKey('distancePointPoint', { a: 1, b: 2, distance: 5 })).toBe(
      constraintRefKey('distancePointPoint', { a: 1, b: 2, distance: 6 }),
    );
    expect(constraintRefKey('distancePointLine', { e: 1, p: 2, offset: 5 })).toBe(
      constraintRefKey('distancePointLine', { e: 1, p: 2, offset: 6 }),
    );
  });

  it('键包含元数据声明的全部引用字段', () => {
    const key = constraintRefKey('tangentLineCircle', { line: 3, circ: 4 });
    expect(key).toContain('tangentLineCircle');
    expect(key).toContain('line=3');
    expect(key).toContain('circ=4');
  });
});

describe('constraintRefKey：无序引用去重（BUG-3 反序选择）', () => {
  it('对称引用种类反序选择得到同一键', () => {
    expect(constraintRefKey('parallel', { e1: 1, e2: 2 })).toBe(
      constraintRefKey('parallel', { e1: 2, e2: 1 }),
    );
    expect(constraintRefKey('perpendicular', { e1: 1, e2: 2 })).toBe(
      constraintRefKey('perpendicular', { e1: 2, e2: 1 }),
    );
    expect(constraintRefKey('equalLength', { e1: 1, e2: 2 })).toBe(
      constraintRefKey('equalLength', { e1: 2, e2: 1 }),
    );
    expect(constraintRefKey('concentric', { e1: 1, e2: 2 })).toBe(
      constraintRefKey('concentric', { e1: 2, e2: 1 }),
    );
    expect(constraintRefKey('equalRadius', { e1: 1, e2: 2 })).toBe(
      constraintRefKey('equalRadius', { e1: 2, e2: 1 }),
    );
    expect(constraintRefKey('tangentCircleCircle', { e1: 1, e2: 2 })).toBe(
      constraintRefKey('tangentCircleCircle', { e1: 2, e2: 1 }),
    );
    expect(constraintRefKey('distancePointPoint', { a: 1, b: 2 })).toBe(
      constraintRefKey('distancePointPoint', { a: 2, b: 1 }),
    );
    expect(constraintRefKey('coincident', { a: 1, b: 2 })).toBe(
      constraintRefKey('coincident', { a: 2, b: 1 }),
    );
  });

  it('有序引用种类反序是不同的键', () => {
    expect(constraintRefKey('tangentLineCircle', { line: 1, circ: 2 })).not.toBe(
      constraintRefKey('tangentLineCircle', { line: 2, circ: 1 }),
    );
    expect(constraintRefKey('distancePointLine', { e: 1, p: 2 })).not.toBe(
      constraintRefKey('distancePointLine', { e: 2, p: 1 }),
    );
  });
});
