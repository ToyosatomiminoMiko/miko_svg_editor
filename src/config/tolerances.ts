/**
 * 交互手感常量（拾取 / 吸附 / 框选阈值）。
 * 全部以屏幕像素声明；读取方必须用 worldTol(px, zoom) 换算成世界单位，
 * 这样缩放后点击手感不变。
 */

/** 点拾取容差 */
export const PICK_POINT_PX = 9;

/** 图元拾取容差 */
export const PICK_ENTITY_PX = 8;

/** 吸附容差（点 / 中点 / 曲线 / 网格共用的基础值） */
export const SNAP_PX = 11;

/** 网格吸附容差折扣：网格优先级最低，容差也更小，避免抢走几何吸附 */
export const SNAP_GRID_FACTOR = 0.75;

/** 尺寸标注命中容差 */
export const DIM_PICK_PX = 6;

/** 平移 / 框选的拖拽阈值：位移超过它才认为「开始拖」 */
export const DRAG_THRESHOLD_PX = 3;

/** 吸附到「直线上任意点」时参数 t 的可用区间，靠近端点交给端点/中点吸附 */
export const SNAP_ON_LINE_T_MIN = 0.02;
export const SNAP_ON_LINE_T_MAX = 0.98;

/** 吸附候选优先级：值越小越优先，0 已有点 … 5 网格 */
export const SNAP_PRIORITY = {
  point: 0,
  mid: 1,
  curve: 2,
  on: 3,
  grid: 5,
} as const;

/** 屏幕像素容差 → 世界单位 */
export const worldTol = (px: number, zoom: number): number => px / zoom;
