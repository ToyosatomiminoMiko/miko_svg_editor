/**
 * config/constraints-meta.ts 的约束元数据与 operations.ts 约束操作的对应关系。
 * 三件事必须同时成立，否则「元数据 ↔ 槽位/执行」的单一来源会漏：
 * 1) 19 种 ConstraintKind 都有元数据与引用字段（Record 穷尽在运行时也要有测试兜底）；
 * 2) 引用字段推导与去重键只由元数据决定，反序选择落到同一个键；
 * 3) operations.ts 的 10 个约束操作都能生成元数据表里的合法 kind
 *    （重合/相切是多态操作，一个按钮会落到多个 kind）。
 * 槽位填充/上下文排除/状态栏等行为见 tests/operations.test.ts 与 tests/coincident.test.ts。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  CONSTRAINT_META,
  ENTITY_REF_KEYS,
  POINT_REF_KEYS,
  constraintRefKey,
} from '../src/config/constraints-meta';
import { addCircle, addLine, addPt, clearModel, model } from '../src/model';
import {
  CONSTRAINT_OPERATIONS,
  createSession,
  executeCommand,
  fillFromOperands,
  operandsFromSelection,
} from '../src/operations';
import { resetInteraction } from '../src/state';
import type { ConstraintKind } from '../src/types';

/** 19 种约束种类，显式列出：元数据表增删时测试需要人跟着改，防止悄悄漂移 */
const ALL_KINDS: readonly ConstraintKind[] = [
  'coincident',
  'horizontal',
  'vertical',
  'parallel',
  'perpendicular',
  'equalLength',
  'collinear',
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

beforeEach(() => {
  clearModel();
  resetInteraction();
});

describe('CONSTRAINT_META', () => {
  it('恰好覆盖 19 种 ConstraintKind', () => {
    const kinds = Object.keys(CONSTRAINT_META) as ConstraintKind[];
    expect(kinds).toHaveLength(19);
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

describe('约束操作与元数据一致', () => {
  it('10 个约束操作：id/label 不重复，槽位与 execute 都是函数', () => {
    expect(CONSTRAINT_OPERATIONS).toHaveLength(10);
    const ids = CONSTRAINT_OPERATIONS.map((op) => op.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const op of CONSTRAINT_OPERATIONS) {
      expect(op.label.length).toBeGreaterThan(0);
      expect(typeof op.slots).toBe('function');
      expect(typeof op.execute).toBe('function');
      const slots = op.slots([]);
      expect(slots.length).toBeGreaterThan(0);
      for (const slot of slots) {
        expect(slot.key.length).toBeGreaterThan(0);
        expect(slot.prompt.length).toBeGreaterThan(0);
      }
    }
  });

  it('每个约束操作的执行结果都落到元数据表里的合法 kind', () => {
    const p = addPt(0, 0);
    const q = addPt(100, 0);
    const line = addLine(p, q);
    const line2 = addLine(addPt(0, 10), addPt(100, 10));
    const circle = addCircle(addPt(300, 0), 10);
    const arc = addCircle(addPt(300, 100), 10);

    const cases: Array<
      [Parameters<typeof createSession>[0], Parameters<typeof operandsFromSelection>[0]]
    > = [
      ['horizontal', { items: [{ kind: 'ent', id: line.id }] }],
      ['vertical', { items: [{ kind: 'ent', id: line.id }] }],
      [
        'parallel',
        {
          items: [
            { kind: 'ent', id: line.id },
            { kind: 'ent', id: line2.id },
          ],
        },
      ],
      [
        'perpendicular',
        {
          items: [
            { kind: 'ent', id: line.id },
            { kind: 'ent', id: line2.id },
          ],
        },
      ],
      [
        'equalLength',
        {
          items: [
            { kind: 'ent', id: line.id },
            { kind: 'ent', id: line2.id },
          ],
        },
      ],
      [
        'collinear',
        {
          items: [
            { kind: 'ent', id: line.id },
            { kind: 'ent', id: line2.id },
          ],
        },
      ],
      [
        'tangent',
        {
          items: [
            { kind: 'ent', id: line.id },
            { kind: 'ent', id: circle.id },
          ],
        },
      ],
      [
        'coincident',
        {
          items: [
            { kind: 'pt', id: p.id },
            { kind: 'pt', id: q.id },
          ],
        },
      ],
      [
        'concentric',
        {
          items: [
            { kind: 'ent', id: circle.id },
            { kind: 'ent', id: arc.id },
          ],
        },
      ],
      [
        'equalRadius',
        {
          items: [
            { kind: 'ent', id: circle.id },
            { kind: 'ent', id: arc.id },
          ],
        },
      ],
    ];

    for (const [opId, selection] of cases) {
      const session = createSession(opId);
      fillFromOperands(session, operandsFromSelection(selection));
      const outcome = executeCommand(session, 1);
      expect(outcome.kind, opId).toBe('action');
      if (outcome.kind !== 'action') continue;
      expect(outcome.result.ok, opId).toBe(true);
      const added = [...model.cons.values()];
      expect(added.length, opId).toBeGreaterThan(0);
      for (const con of added) {
        expect(ALL_KINDS, `${opId} → ${con.type}`).toContain(con.type);
        expect(CONSTRAINT_META[con.type].ui, `${con.type} 的 ui 标记`).toBe(true);
      }
    }
  });

  it('无 UI 入口的 4 种约束只在残差层预留（ui = false）', () => {
    const noUi = ALL_KINDS.filter((kind) => !CONSTRAINT_META[kind].ui);
    expect([...noUi].sort()).toEqual(
      ['angle', 'distancePointLine', 'midpoint', 'symmetric'].sort(),
    );
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
    // 共线：两条直线谁作基准都可以，交换引用仍是同一条约束
    expect(constraintRefKey('collinear', { e1: 1, e2: 2 })).toBe(
      constraintRefKey('collinear', { e1: 2, e2: 1 }),
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
