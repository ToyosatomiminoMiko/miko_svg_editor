/**
 * 约束元数据：种类、引用字段与按钮文案。
 * 单一来源，供三处消费：
 * - `model.ts` 的「哪些字段算图元/点引用」由 `CONSTRAINT_META.refs` 推导；
 * - `operations.ts` 的约束操作（槽位 + 执行函数）引用这里的 label / refs / unorderedRefs，
 *   新的「UI 动作 → 约束种类」映射不再写在这里，避免和执行逻辑分叉；
 * - `constraints.ts` 的残差方程仍在 `RESID`（`Record<ConstraintKind, …>` 保证穷尽）。
 * `ui` 标记「是否存在 UI 入口」（预留扩展点），具体槽位与执行见 operations.ts。
 */

import type { EntityKind } from '../entities';
import type { Constraint, ConstraintKind } from '../types';

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
  collinear: {
    label: '共线',
    ui: true,
    // 两条直线谁作基准都可以，交换引用仍是同一条约束
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

/** 待添加的一条约束：种类 + 引用/数值字段（由操作表的 execute 构造） */
export type ResolvedConstraint = {
  kind: ConstraintKind;
  props: Omit<Constraint, 'id' | 'type'>;
};

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
