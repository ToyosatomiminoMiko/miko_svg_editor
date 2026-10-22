/**
 * 图元类型分派：按图元种类取引用点、取尺寸工具的目标，并提供「几何大类」守卫。
 * 图元是 types.ts 的可辨识联合，这里用 switch 收窄类型；
 * 每个 switch 的 default 都交给 assertNever，新增图元种类而漏写分支时直接编译失败。
 *
 * 跨种类的判断（例如圆/弧共享圆心+半径）不要在调用点手写
 * `type !== 'circle' && type !== 'arc'`：那会把种类集合复制到各处，新增种类时编译器不报错。
 * 统一走 ENTITY_CATEGORY → CurveEntity/isCurveEntity：新增种类时分类表会强制补全，守卫自动覆盖。
 */

import type { Entity, EntityKind } from './types';

/** 穷尽检查：能走到这里说明某个 switch 漏掉了新类型 */
export const assertNever = (x: never): never => {
  throw new Error(`未处理的分支: ${JSON.stringify(x)}`);
};

/** 图元大类：按共享几何字段分组（直线 / 圆-弧曲线 / 点），供跨种类分支使用 */
export type EntityCategory = 'line' | 'curve' | 'point';

/**
 * 种类 → 大类。
 * `satisfies Record<EntityKind, EntityCategory>` 是编译期穷尽检查：新增图元种类时
 * EntityKind 变大，这张表漏归类就编译失败。CurveEntity 与 isCurveEntity 都由它推导，
 * 因此类型集合只有这一份来源，不会出现「union 写了 circle/arc、守卫漏了 ellipse」的分叉。
 */
const ENTITY_CATEGORY = {
  line: 'line',
  circle: 'curve',
  arc: 'curve',
  point: 'point',
} as const satisfies Record<EntityKind, EntityCategory>;

/**
 * 某大类包含的种类字面量：把分类表的值翻回 key 的联合。
 * 例：C='curve' → 'circle' | 'arc'。
 */
type KindOfCategory<C extends EntityCategory> = {
  [K in EntityKind]: (typeof ENTITY_CATEGORY)[K] extends C ? K : never;
}[EntityKind];

/** 圆/弧：共享圆心 c 与半径 r 的曲线图元（由分类表推导，不是手写 union） */
export type CurveEntity = Extract<Entity, { type: KindOfCategory<'curve'> }>;

/**
 * 圆/弧类型守卫，顺带收窄 undefined：
 *   const e = getEntity(id);
 *   if (!isCurveEntity(e)) return null; // e 现在是 CurveEntity，可直接读 c / r
 * 比 `!e || (e.type !== 'circle' && e.type !== 'arc')` 短，且新增曲线种类时无需改调用点。
 */
export const isCurveEntity = (e: Entity | undefined): e is CurveEntity =>
  e !== undefined && ENTITY_CATEGORY[e.type] === 'curve';

/** 图元种类中文名：已选择列表与命令状态栏共用，新增种类时 switch 会编译报错 */
export function entityLabel(e: Entity): string {
  switch (e.type) {
    case 'line':
      return '直线';
    case 'circle':
      return '圆';
    case 'arc':
      return '圆弧';
    case 'point':
      return '点';
    default:
      return assertNever(e);
  }
}

/**
 * 尺寸工具点中图元后要创建的目标尺寸：
 * 直线取两端点距离（线长），圆/弧取半径。
 * 点图元没有独立尺寸目标（它只能作为两点距离的一端，入口在点击状态机里处理），返回 null。
 */
type DimTarget = { kind: 'distance'; a: number; b: number } | { kind: 'radius'; e: number };

/** 图元引用的点 id：直线是两端点，圆是圆心，圆弧是圆心+起点+终点，点图元是它自己那个点 */
export function entityPointIds(e: Entity): number[] {
  switch (e.type) {
    case 'line':
      return [e.a, e.b];
    case 'circle':
      return [e.c];
    case 'arc':
      return [e.c, e.a, e.b];
    case 'point':
      return [e.p];
    default:
      return assertNever(e);
  }
}

/** 尺寸工具点中这个图元时该建什么尺寸；null = 该图元没有可直接创建的尺寸 */
export function entityDimTarget(e: Entity): DimTarget | null {
  switch (e.type) {
    case 'line':
      return { kind: 'distance', a: e.a, b: e.b };
    case 'circle':
    case 'arc':
      return { kind: 'radius', e: e.id };
    case 'point':
      return null;
    default:
      return assertNever(e);
  }
}
