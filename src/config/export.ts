/**
 * SVG 导出标定。
 * 导出是独立介质（用户单位、无缩放），不读 canvas 主题：
 * 颜色 / 线宽 / 精度 / 文件名集中在这里，导出函数通过参数接收样式覆盖。
 */

/** 描边颜色：导出统一用深色，便于在白色背景/其它软件里查看 */
export const EXPORT_STROKE = '#111';

/** 最小线宽（用户单位） */
export const EXPORT_STROKE_MIN = 0.2;

/** 线宽参考系数：线宽 = max(min, 包围盒最长边 / 该系数) */
export const EXPORT_STROKE_REF = 500;

/** SVG 数值小数位 */
export const EXPORT_DECIMALS = 4;

/** 下载文件名 */
export const EXPORT_FILENAME = 'sketch.svg';

/** 没有图元可导出时的提示文案 */
export const EXPORT_EMPTY_MESSAGE = '没有可导出的图元';

/** 下载后 revoke objectURL 的延迟（毫秒） */
export const EXPORT_REVOKE_MS = 1000;

/** 构造线虚线的 SVG 用户单位；canvas 侧像素虚线见 styles.css 的 --dash-construction */
export const EXPORT_DASH = '5 5';

/** 线帽：与画布观感一致 */
export const EXPORT_LINE_CAP = 'round';

/** 导出样式（可由调用方覆盖，用于测试或将来做导出主题） */
export interface ExportStyle {
  stroke: string;
  lineCap: string;
  /** 构造线虚线，SVG 用户单位 */
  dash: string;
}

export const DEFAULT_EXPORT_STYLE: ExportStyle = {
  stroke: EXPORT_STROKE,
  lineCap: EXPORT_LINE_CAP,
  dash: EXPORT_DASH,
};
