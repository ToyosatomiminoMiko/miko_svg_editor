/**
 * 约束元数据：种类、引用字段、UI 动作与按钮文案。
 * 单一来源，供三处消费：
 * - `tools.ts` 的约束按钮表由 `CONSTRAINT_ACTIONS` 生成；
 * - `model.ts` 的「哪些字段算图元/点引用」由 `CONSTRAINT_META.refs` 推导；
 * - 约束动作的适用校验与参数构造由 `sketch-actions.ts` 查 `resolve` 函数完成，不再写 if/else 链。
 * 残差方程仍在 `constraints.ts` 的 `RESID`（`Record<ConstraintKind, …>` 保证穷尽）。
 */

import { isCurveEntity, type CurveEntity } from '../entities';
import type { Constraint, ConstraintKind, Entity, EntityKind, Point } from '../types';

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
    ui: true, // 由「重合」按钮按选中对象多态地生成（点-点 / 点-线 / 点-圆）
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
    ui: true, // 由「重合」按钮在「1 个点 + 1 条直线」时生成
    refs: [
      { key: 'e', kind: 'entity', accepts: LINE },
      { key: 'p', kind: 'point' },
    ],
  },
  pointOnCircle: {
    label: '点在圆上',
    ui: true, // 由「重合」按钮在「1 个点 + 1 个圆/弧」时生成
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

/**
 * 约束动作的输入：选中的图元 + 显式选中的点。
 * 大多数动作只看图元；「重合」以点为主，必须同时拿到点（独立点、直线端点、圆心），
 * 所以约束动作统一接收这份结构，而不是只传 Entity[]。
 * points 只含显式选中的点：选中图元时其端点/圆心属于「隐含选中」，不参与约束构造。
 */
export interface ConstraintSelection {
  readonly entities: readonly Entity[];
  readonly points: readonly Point[];
}

/** 约束动作（按钮）id；一个按钮可能按选中类型生成不同 kind（相切 / 重合） */
export type ConstraintAction =
  | 'coincident'
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
  /** 从选中对象解析出要添加的约束；不适用时给出面向用户的理由 */
  resolve(selection: ConstraintSelection): ConstraintResolution;
}

const fail = (reason: string): ConstraintResolution => ({ ok: false, reason });

const entitiesOfKind = (selected: readonly Entity[], kind: EntityKind): Entity[] =>
  selected.filter((e) => e.type === kind);

/** 圆/弧：相切、同心、等半径的目标；点图元不在其中（守卫由 ENTITY_CATEGORY 单点维护） */
const curvesOf = (selected: readonly Entity[]): CurveEntity[] => selected.filter(isCurveEntity);

/**
 * 取「长度已由调用方校验」的数组元素。
 * 下面各 resolve 分支先检查了 length === 1 / === 2 才读下标，因此元素必然存在；
 * noUncheckedIndexedAccess 看不出这个不变量，集中在这里断言并注释，避免分支里散落非空断言。
 */
const first = <T>(items: readonly T[]): T => items[0]!;
const second = <T>(items: readonly T[]): T => items[1]!;

/**
 * 重合族的多态表：按「目标对象」的种类分派到具体约束 kind 与引用字段。
 * 与 dimensions.ts 的 DIM_META 同构——新增一种可重合目标（如椭圆）只需加一条记录并补
 * targetOfEntity 的映射，构造逻辑不再写 if/else 链；去重与残差仍复用通用的
 * constraintRefKey / RESID。
 */
type CoincidentTarget = 'point' | 'line' | 'curve';

interface CoincidentTargetMeta {
  kind: ConstraintKind;
  /** 构造约束引用：pointId 是锚点，targetId 是另一个点或目标图元的 id */
  props(pointId: number, targetId: number): Omit<Constraint, 'id' | 'type'>;
}

const COINCIDENT_TARGETS: Record<CoincidentTarget, CoincidentTargetMeta> = {
  point: { kind: 'coincident', props: (a, b) => ({ a, b }) },
  line: { kind: 'pointOnLine', props: (p, e) => ({ p, e }) },
  curve: { kind: 'pointOnCircle', props: (p, e) => ({ p, e }) },
};

/** 目标图元 → 多态表键；点图元在调用前已被展开成点 id，这里返回 null */
const targetOfEntity = (e: Entity): CoincidentTarget | null => {
  switch (e.type) {
    case 'line':
      return 'line';
    case 'circle':
    case 'arc':
      return 'curve';
    case 'point':
      return null;
  }
};

/**
 * 「重合」按钮的多态解析：从选中的点/图元里找出「锚点 + 目标」。
 * 点的两个来源：
 * - 显式选中的点（pt）：独立点的点被图元身份接管后不在这里，但线段端点/圆心可以；
 * - 选中的点图元（ent）：展开成它引用的点 id。
 * 目标可以是另一个点、一条直线、一个圆/弧——具体 kind 查 COINCIDENT_TARGETS。
 */
function resolveCoincident(selection: ConstraintSelection): ConstraintResolution {
  const pointIds = selection.points.map((p) => p.id);
  const entities: Entity[] = [];
  for (const e of selection.entities) {
    if (e.type === 'point') pointIds.push(e.p);
    else entities.push(e);
  }

  if (pointIds.length + entities.length !== 2) {
    return fail('重合一次只能选 2 个对象：2 个点，或 1 个点 + 1 条直线/圆/弧');
  }
  if (pointIds.length === 0) {
    return fail('重合需要至少 1 个点（独立点、线段端点或圆心）');
  }
  if (pointIds.length === 2) {
    if (first(pointIds) === second(pointIds)) return fail('同一个点不能和自己重合');
    const meta = COINCIDENT_TARGETS.point;
    return {
      ok: true,
      items: [{ kind: meta.kind, props: meta.props(first(pointIds), second(pointIds)) }],
    };
  }

  const pointId = first(pointIds);
  const target = first(entities);
  // 点已经是目标图元的固有部分时重合没有意义：
  // - 直线端点恒在线上（假约束）；
  // - 圆心/弧心与自己的圆/弧重合只会把半径挤成 0（退化图元）。
  if (target.type === 'line' && (target.a === pointId || target.b === pointId)) {
    return fail('这个点已经是该直线的端点');
  }
  if (isCurveEntity(target) && target.c === pointId) {
    return fail('这个点已经是该圆/弧的圆心');
  }
  const targetKind = targetOfEntity(target);
  if (!targetKind) return fail('重合的目标只能是点、直线或圆/弧');
  const meta = COINCIDENT_TARGETS[targetKind];
  return { ok: true, items: [{ kind: meta.kind, props: meta.props(pointId, target.id) }] };
}

export const CONSTRAINT_ACTIONS: readonly ConstraintActionMeta[] = [
  {
    id: 'coincident',
    label: '重合',
    resolve(selection) {
      return resolveCoincident(selection);
    },
  },
  {
    id: 'horizontal',
    label: '水平',
    resolve(selection) {
      const selected = selection.entities;
      if (selected.length === 0) return fail('先选中直线');
      const lines = entitiesOfKind(selected, 'line');
      if (lines.length !== selected.length) return fail('水平约束只能用于直线');
      return { ok: true, items: lines.map((e) => ({ kind: 'horizontal', props: { e: e.id } })) };
    },
  },
  {
    id: 'vertical',
    label: '竖直',
    resolve(selection) {
      const selected = selection.entities;
      if (selected.length === 0) return fail('先选中直线');
      const lines = entitiesOfKind(selected, 'line');
      if (lines.length !== selected.length) return fail('竖直约束只能用于直线');
      return { ok: true, items: lines.map((e) => ({ kind: 'vertical', props: { e: e.id } })) };
    },
  },
  {
    id: 'parallel',
    label: '平行',
    resolve(selection) {
      const selected = selection.entities;
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
    resolve(selection) {
      const selected = selection.entities;
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
    resolve(selection) {
      const selected = selection.entities;
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
    resolve(selection) {
      const selected = selection.entities;
      if (selected.length !== 2) return fail('相切约束需要选中 2 个图元');
      const lines = entitiesOfKind(selected, 'line');
      const curves = curvesOf(selected);
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
    resolve(selection) {
      const selected = selection.entities;
      if (selected.length !== 2) return fail('同心约束需要选中 2 个圆/弧');
      const curves = curvesOf(selected);
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
    resolve(selection) {
      const selected = selection.entities;
      if (selected.length !== 2) return fail('等半径约束需要选中 2 个圆/弧');
      const curves = curvesOf(selected);
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
