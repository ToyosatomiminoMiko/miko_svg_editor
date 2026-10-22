/**
 * 数字格式化的唯一实现。
 * 显示（尺寸标注）与存储（尺寸输入框回填）必须分开：
 * 回填用全精度 String(value)，只有显示才按小数位截断，否则打开再确认会静默改写数值。
 */

/** 尺寸标注显示的小数位 */
export const DIM_DECIMALS = 2;

/**
 * 按固定小数位格式化，再去掉多余的 0。
 * - `-0` 归一成 `0`（`Number('-0.0000').toString()` 仍是 "0"，这里显式兜底以免依赖实现细节）；
 * - 非有限值返回 `0`，避免把 NaN 写进 SVG。
 */
export function formatNumber(v: number, decimals: number): string {
  if (!Number.isFinite(v)) return '0';
  const rounded = Number(v.toFixed(decimals));
  // `rounded === 0` 对 -0 也成立：这里显式归一负零，避免依赖 Number#toString 的实现细节
  return (rounded === 0 ? 0 : rounded).toString();
}

/** 尺寸标注的显示格式 */
export const formatDimValue = (v: number): string => formatNumber(v, DIM_DECIMALS);
