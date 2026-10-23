/**
 * 角度与圆弧的数值约定。
 * 圆弧统一用「起点角 a0 + 正向扫角」描述，扫角范围 (0, TAU]：
 * 起终点同角（差值为 0）按整圆处理，这样预览、渲染、拾取、导出对边界情况只有一种解释。
 */

/** 一整圈弧度 */
export const TAU = Math.PI * 2;

/** 扫角小于该值视为起点终点重合 → 整圆；用于抹平浮点误差 */
export const SWEEP_EPS = 1e-9;

/** 整圆折线近似段数 */
export const ARC_SEGMENTS_PER_TURN = 64;

/** 圆弧折线近似的最小段数 */
export const ARC_MIN_SEGMENTS = 8;

/** 把角度归一化到 [0, TAU) */
export function normalizeAngle(angle: number): number {
  return ((angle % TAU) + TAU) % TAU;
}

/**
 * 圆弧的正向扫角，范围 (0, TAU]。
 * 起终点同角（含浮点误差）返回 TAU（整圆），而不是 0：
 * 否则「整圆弧」会在 canvas（画整圆）、SVG（起终点重合不渲染）、
 * 拾取（区间塌缩）三处得到三种结果。
 */
export function sweepOf(a0: number, a1: number): number {
  const d = normalizeAngle(a1 - a0);
  // 两个方向都要抹平浮点误差：a1-a0 = -ε 归一化后是 TAU-ε，同样代表「同角」
  if (d < SWEEP_EPS || d > TAU - SWEEP_EPS) return TAU;
  return d;
}

/** 扫角是否代表整圆 */
export function isFullSweep(sweep: number): boolean {
  return sweep >= TAU - SWEEP_EPS;
}

/** 按扫角决定折线近似段数 */
export function arcSegments(sweep: number): number {
  return Math.max(ARC_MIN_SEGMENTS, Math.ceil((sweep / TAU) * ARC_SEGMENTS_PER_TURN));
}
