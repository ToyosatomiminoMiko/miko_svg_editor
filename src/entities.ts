/**
 * 图元类型分派：全项目「按图元种类做不同事」的统一入口。
 * 图元是 types.ts 的可辨识联合；这里用 switch 收窄类型，
 * default 交给 assertNever 兜底，新增图元类型而漏写分支时直接编译失败。
 */

import type { Entity } from './types';

/** 穷尽检查：能走到这里说明某个 switch 漏掉了新的图元类型 */
export const assertNever = (x: never): never => {
  throw new Error(`未处理的图元类型: ${JSON.stringify(x)}`);
};

/**
 * 尺寸工具点中图元后要创建的目标尺寸：
 * 直线取两端点距离（线长），圆/弧取半径。
 */
export type DimTarget =
  | { kind: 'distance'; a: number; b: number }
  | { kind: 'radius'; e: number };

/** 图元引用的点 id：直线是两端点，圆/弧是圆心 */
export function entityPointIds(e: Entity): number[] {
  switch (e.type) {
    case 'line':
      return [e.a, e.b];
    case 'circle':
    case 'arc':
      return [e.c];
    default:
      return assertNever(e);
  }
}

/** 尺寸工具点中这个图元时该建什么尺寸 */
export function entityDimTarget(e: Entity): DimTarget {
  switch (e.type) {
    case 'line':
      return { kind: 'distance', a: e.a, b: e.b };
    case 'circle':
    case 'arc':
      return { kind: 'radius', e: e.id };
    default:
      return assertNever(e);
  }
}
