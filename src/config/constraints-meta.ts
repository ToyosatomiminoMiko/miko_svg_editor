/**
 * 约束元数据：种类、引用字段、UI 动作与按钮文案。
 * 单一来源，供三处消费：
 * - `tools.ts` 的约束按钮表由 `CONSTRAINT_ACTIONS` 生成；
 * - `model.ts` 的「哪些字段算图元/点引用」由 `CONSTRAINT_META.refs` 推导；
 * - 约束动作的适用校验与参数构造由 `sketch-actions.ts` 查 `resolve` 函数完成，不再写 if/else 链。
 * 残差方程仍在 `constraints.ts` 的 `RESID`（`Record<ConstraintKind, …>` 保证穷尽）。
 */

import type { Constraint, ConstraintKind, Entity, EntityKind } from '../types';

/** 一条约束引用：图元或点，以及图元引用可接受的种类 */
export interface ConstraintRefMeta {
  /** 构造 Constraint 时写入的字段名 */
  key: keyof Constraint;
  kind: 'entity' | 'point';
  /** 仅 kind === 'entity' 时有效；缺省表示圆/弧等曲线类（line 之外的图元） */
  accepts?: readonly EntityKind[];
}

export interface ConstraintKindMeta {
  label: string;
  /** 是否有 UI 入口；false 表示类型/残差已就绪但暂未接入按钮（预留扩展点） */
  ui: boolean;
  refs: readonly ConstraintRefMeta[];
  /**
   * refs 是否无序：平行/同心这类约束交换两个引用仍是同一条约束。
   * 去重键会先对引用部分排序，避免「先选 A 再选 B」与「先选 B 再选 A」重复添加。
   */
  unorderedRefs?: boolean;
}

const LINE: readonly EntityKind[] = ['line'];
const CURVE: readonly EntityKind[] = ['circle', 'arc'];

export const CONSTRAINT_META: Record<ConstraintKind, ConstraintKindMeta> = {
  coincident: {
    label: '重合',
    ui: false, // 暂无入口
    unorderedRefs: true,
    refs: [
      { key: 'a', kind: 'point' },
      { key: 'b', kind: 'point' },
    ],
  },
  horizontal: { label: '水平', ui: true, refs: [{ key: 'e', kind: 'entity', accepts: LINE }] },
  vertical: { label: '竖直', ui: true, refs: [{ key: 'e', kind: 'entity', accepts: LINE }] },
  parallel: {
    label: '平行',
    ui: true,
    unorderedRefs: true,
    refs: [
      { key: 'e1', kind: 'entity', accepts: LINE },
      { key: 'e2', kind: 'entity', accepts: LINE },
    ],
  },
  perpendicular: {
    label: '垂直',
    ui: true,
    unorderedRefs: true,
    refs: [
      { key: 'e1', kind: 'entity', accepts: LINE },
      { key: 'e2', kind: 'entity', accepts: LINE },
    ],
  },
  equalLength: {
    label: '等长',
    ui: true,
    unorderedRefs: true,
    refs: [
      { key: 'e1', kind: 'entity', accepts: LINE },
      { key: 'e2', kind: 'entity', accepts: LINE },
    ],
  },
  pointOnLine: {
    label: '点在线上',
    ui: false, // 暂无入口
    refs: [
      { key: 'e', kind: 'entity', accepts: LINE },
      { key: 'p', kind: 'point' },
    ],
  },
  pointOnCircle: {
    label: '点在圆上',
    ui: false, // 暂无入口
    refs: [
      { key: 'e', kind: 'entity', accepts: CURVE },
      { key: 'p', kind: 'point' },
    ],
  },
  tangentLineCircle: {
    label: '相切',
    ui: true, // 由「相切」按钮按选中类型转成该 kind
    refs: [
      { key: 'line', kind: 'entity', accepts: LINE },
      { key: 'circ', kind: 'entity', accepts: CURVE },
    ],
  },
  tangentCircleCircle: {
    label: '相切',
    ui: true, // 由「相切」按钮按选中类型转成该 kind
    unorderedRefs: true,
    refs: [
      { key: 'e1', kind: 'entity', accepts: CURVE },
      { key: 'e2', kind: 'entity', accepts: CURVE },
    ],
  },
  concentric: {
    label: '同心',
    ui: true,
    unorderedRefs: true,
    refs: [
      { key: 'e1', kind: 'entity', accepts: CURVE },
      { key: 'e2', kind: 'entity', accepts: CURVE },
    ],
  },
  equalRadius: {
    label: '等半径',
    ui: true,
    unorderedRefs: true,
    refs: [
      { key: 'e1', kind: 'entity', accepts: CURVE },
      { key: 'e2', kind: 'entity', accepts: CURVE },
    ],
  },
  distancePointPoint: {
    label: '距离',
    ui: true, // 入口在尺寸工具，不在约束按钮区
    unorderedRefs: true,
    refs: [
      { key: 'a', kind: 'point' },
      { key: 'b', kind: 'point' },
    ],
  },
  distancePointLine: {
    label: '点到线距离',
    ui: false, // 暂无入口
    refs: [
      { key: 'e', kind: 'entity', accepts: LINE },
      { key: 'p', kind: 'point' },
    ],
  },
  radius: {
    label: '半径',
    ui: true, // 入口在尺寸工具
    refs: [{ key: 'e', kind: 'entity', accepts: CURVE }],
  },
  angle: {
    label: '角度',
    ui: false, // 暂无入口
    refs: [
      { key: 'e1', kind: 'entity', accepts: LINE },
      { key: 'e2', kind: 'entity', accepts: LINE },
    ],
  },
  midpoint: {
    label: '中点',
    ui: false, // 暂无入口
    refs: [
      { key: 'e', kind: 'entity', accepts: LINE },
      { key: 'p', kind: 'point' },
    ],
  },
  symmetric: {
    label: '对称',
    ui: false, // 暂无入口
    refs: [
      { key: 'e', kind: 'entity', accepts: LINE },
      { key: 'p1', kind: 'point' },
      { key: 'p2', kind: 'point' },
    ],
  },
};

/** 约束动作（按钮）id；一个按钮可能按选中类型生成不同 kind（相切） */
export type ConstraintAction =
  | 'horizontal'
  | 'vertical'
  | 'parallel'
  | 'perpendicular'
  | 'equalLength'
  | 'tangent'
  | 'concentric'
  | 'equalRadius';

/** 解析结果：待添加的约束（可能多条，例如多选直线加水平） */
export type ResolvedConstraint = {
  kind: ConstraintKind;
  props: Omit<Constraint, 'id' | 'type'>;
};

export type ConstraintResolution =
  { ok: true; items: readonly ResolvedConstraint[] } | { ok: false; reason: string };

export interface ConstraintActionMeta {
  id: ConstraintAction;
  label: string;
  /** 从选中图元解析出要添加的约束；不适用时给出面向用户的理由 */
  resolve(selected: readonly Entity[]): ConstraintResolution;
}

const fail = (reason: string): ConstraintResolution => ({ ok: false, reason });

const entitiesOfKind = (selected: readonly Entity[], kind: EntityKind): Entity[] =>
  selected.filter((e) => e.type === kind);

/**
 * 取「长度已由调用方校验」的数组元素。
 * 下面各 resolve 分支先检查了 length === 1 / === 2 才读下标，因此元素必然存在；
 * noUncheckedIndexedAccess 看不出这个不变量，集中在这里断言并注释，避免分支里散落非空断言。
 */
const first = <T>(items: readonly T[]): T => items[0]!;
const second = <T>(items: readonly T[]): T => items[1]!;

export const CONSTRAINT_ACTIONS: readonly ConstraintActionMeta[] = [
  {
    id: 'horizontal',
    label: '水平',
    resolve(selected) {
      if (selected.length === 0) return fail('先选中直线');
      const lines = entitiesOfKind(selected, 'line');
      if (lines.length !== selected.length) return fail('水平约束只能用于直线');
      return { ok: true, items: lines.map((e) => ({ kind: 'horizontal', props: { e: e.id } })) };
    },
  },
  {
    id: 'vertical',
    label: '竖直',
    resolve(selected) {
      if (selected.length === 0) return fail('先选中直线');
      const lines = entitiesOfKind(selected, 'line');
      if (lines.length !== selected.length) return fail('竖直约束只能用于直线');
      return { ok: true, items: lines.map((e) => ({ kind: 'vertical', props: { e: e.id } })) };
    },
  },
  {
    id: 'parallel',
    label: '平行',
    resolve(selected) {
      if (selected.length !== 2) return fail('平行约束需要选中 2 条直线');
      const lines = entitiesOfKind(selected, 'line');
      if (lines.length !== 2) return fail('平行约束只能用于直线');
      return {
        ok: true,
        items: [{ kind: 'parallel', props: { e1: first(lines).id, e2: second(lines).id } }],
      };
    },
  },
  {
    id: 'perpendicular',
    label: '垂直',
    resolve(selected) {
      if (selected.length !== 2) return fail('垂直约束需要选中 2 条直线');
      const lines = entitiesOfKind(selected, 'line');
      if (lines.length !== 2) return fail('垂直约束只能用于直线');
      return {
        ok: true,
        items: [{ kind: 'perpendicular', props: { e1: first(lines).id, e2: second(lines).id } }],
      };
    },
  },
  {
    id: 'equalLength',
    label: '等长',
    resolve(selected) {
      if (selected.length !== 2) return fail('等长约束需要选中 2 条直线');
      const lines = entitiesOfKind(selected, 'line');
      if (lines.length !== 2) return fail('等长约束只能用于直线');
      return {
        ok: true,
        items: [{ kind: 'equalLength', props: { e1: first(lines).id, e2: second(lines).id } }],
      };
    },
  },
  {
    id: 'tangent',
    label: '相切',
    resolve(selected) {
      if (selected.length !== 2) return fail('相切约束需要选中 2 个图元');
      const lines = entitiesOfKind(selected, 'line');
      const curves = selected.filter((e) => e.type !== 'line');
      if (lines.length === 1 && curves.length === 1) {
        return {
          ok: true,
          items: [
            { kind: 'tangentLineCircle', props: { line: first(lines).id, circ: first(curves).id } },
          ],
        };
      }
      if (curves.length === 2) {
        return {
          ok: true,
          items: [
            { kind: 'tangentCircleCircle', props: { e1: first(curves).id, e2: second(curves).id } },
          ],
        };
      }
      return fail('相切需要 1 条直线 + 1 个圆/弧，或 2 个圆/弧');
    },
  },
  {
    id: 'concentric',
    label: '同心',
    resolve(selected) {
      if (selected.length !== 2) return fail('同心约束需要选中 2 个圆/弧');
      const curves = selected.filter((e) => e.type !== 'line');
      if (curves.length !== 2) return fail('同心约束只能用于圆/弧');
      return {
        ok: true,
        items: [{ kind: 'concentric', props: { e1: first(curves).id, e2: second(curves).id } }],
      };
    },
  },
  {
    id: 'equalRadius',
    label: '等半径',
    resolve(selected) {
      if (selected.length !== 2) return fail('等半径约束需要选中 2 个圆/弧');
      const curves = selected.filter((e) => e.type !== 'line');
      if (curves.length !== 2) return fail('等半径约束只能用于圆/弧');
      return {
        ok: true,
        items: [{ kind: 'equalRadius', props: { e1: first(curves).id, e2: second(curves).id } }],
      };
    },
  },
];

/**
 * 约束去重键：类型 + 元数据声明的引用字段（同组引用不重复添加）。
 * unorderedRefs 的种类先对「字段=值」排序，让反序选择落到同一个键上。
 */
export function constraintRefKey(
  kind: ConstraintKind,
  props: Omit<Constraint, 'id' | 'type'>,
): string {
  const meta = CONSTRAINT_META[kind];
  const values = props as Record<string, number | undefined>;
  const refs = meta.refs.map((ref) => values[ref.key]);
  if (meta.unorderedRefs) {
    // 字段名本身不参与（e1/e2 只是槽位），只按引用值排序，反序选择才会落到同一键
    refs.sort((a, b) => (a ?? 0) - (b ?? 0));
    return [kind, ...refs.map((v) => String(v ?? ''))].join('|');
  }
  return [kind, ...meta.refs.map((ref, i) => `${String(ref.key)}=${String(refs[i] ?? '')}`)].join(
    '|',
  );
}

const uniqueKeys = (kind: 'entity' | 'point'): readonly (keyof Constraint)[] => {
  const keys: (keyof Constraint)[] = [];
  for (const meta of Object.values(CONSTRAINT_META)) {
    for (const ref of meta.refs) {
      if (ref.kind === kind && !keys.includes(ref.key)) keys.push(ref.key);
    }
  }
  return keys;
};

/** 约束里表示图元引用的字段名（由元数据表推导，新增约束种类不必再改 model.ts） */
export const ENTITY_REF_KEYS: readonly (keyof Constraint)[] = uniqueKeys('entity');

/** 约束里表示点引用的字段名 */
export const POINT_REF_KEYS: readonly (keyof Constraint)[] = uniqueKeys('point');
