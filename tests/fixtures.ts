/**
 * 测试夹具。
 * 圆弧在模型里由「圆心 + 起点 + 终点」三个点定义（半径/角度是派生量），
 * 但测试里仍按「圆心 + 半径 + 起终角」描述最直观，这里统一换算成三个点。
 * 生产创建入口是 sketch-actions.createArc（额外处理复用已有点、投影与整圆去重）。
 */

import { isFullSweep, sweepOf } from '../src/config';
import { addArc, addPt } from '../src/model';
import type { ArcEntity, Point } from '../src/types';

/** 按极坐标造圆弧：起点在 a0、终点在 a1；整圆复用起点，不留下两个重合端点（与生产创建一致） */
export function addArcByAngles(center: Point, r: number, a0: number, a1: number): ArcEntity {
  const start = addPt(center.x + r * Math.cos(a0), center.y + r * Math.sin(a0));
  if (isFullSweep(sweepOf(a0, a1))) return addArc(center, start, start);
  const end = addPt(center.x + r * Math.cos(a1), center.y + r * Math.sin(a1));
  return addArc(center, start, end);
}
