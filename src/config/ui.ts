/**
 * 画布上「无法用 CSS 变量表达」的外观/交互几何常量。
 * 能进 src/styles.css :root 的颜色、线宽、虚线、点半径仍归 CSS（theme.ts 读取）；
 * 这里只放需要参与布局数学、或纯 TS 计算的值，避免 theme.ts 里再塞逻辑。
 */

/** 滚轮缩放灵敏度：缩放因子 = exp(-deltaY × 该值) */
export const WHEEL_ZOOM_SENSITIVITY = 0.0015;

/** 画线时自动加水平/竖直约束的角度比例阈值（|dy| < |dx| × 该值 → 水平） */
export const AUTO_AXIS_RATIO = 0.02;

/** 尺寸文字相对尺寸线的屏幕像素上移量 */
export const DIM_TEXT_GAP_PX = 4;

/** 半径标注文字相对圆心的屏幕像素偏移 */
export const RADIUS_LABEL_DX_PX = 8;
export const RADIUS_LABEL_DY_PX = -8;

/** 文本测量不可用时的回退：按字号与每字宽度估算 */
export const TEXT_FALLBACK_FONT_PX = 12;
export const TEXT_FALLBACK_CHAR_WIDTH = 7;

/** 提示（状态栏闪示 / 消息区条目）自动消失时长（毫秒）；只影响 UI 反馈，不参与画布几何 */
export const TOAST_DURATION_MS = 2600;
