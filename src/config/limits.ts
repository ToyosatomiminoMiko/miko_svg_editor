/**
 * 视图 / 模型 / 绘图的数值上下限与退化阈值。
 * 阈值统一按「世界单位」声明（文件名带 _WORLD 的除外），
 * 屏幕像素容差见 tolerances.ts。
 */

/* ---------------- 视图缩放 ---------------- */

/** 缩放下限（1 世界单位 = 0.02 屏幕像素） */
export const ZOOM_MIN = 0.02;

/** 缩放上限 */
export const ZOOM_MAX = 80;

/** 初始 / 重置缩放 */
export const DEFAULT_ZOOM = 1;

/** modelBounds 的留白比例（相对最长边） */
export const BBOX_PAD_RATIO = 0.05;

/** 包围盒留白的最小绝对量，避免退化图形留白为 0 */
export const BBOX_PAD_MIN = 1;

/** 「适应视图」时图形占视口的比例 */
export const FIT_VIEW_FILL = 0.9;

/* ---------------- 网格 ---------------- */

/** 网格间距的基准值，按 2 的幂缩放使屏幕间距落在 [GRID_MIN_PX, GRID_MAX_PX] */
export const GRID_BASE = 10;

/** 网格间距的缩放步进因子 */
export const GRID_STEP_FACTOR = 2;
export const GRID_MIN_PX = 20;
export const GRID_MAX_PX = 60;

/* ---------------- 退化阈值 ---------------- */

/** 两点距离小于该值视为同一点（画线 / 删除孤立点判定） */
export const MIN_DRAW_LENGTH = 1e-6;

/** 两点距离小于该值不创建距离尺寸 */
export const MIN_DIM_DISTANCE = 1e-6;

/** 圆 / 圆弧的最小半径；半径小于该值不创建图元 */
export const MIN_RADIUS = 1e-4;

/** 矩形的最小边长；任一边更短则不创建矩形 */
export const MIN_RECT_EDGE = 1e-4;

/* ---------------- 模型 ---------------- */

/** 全局 id 序列初值（点/图元/约束共用） */
export const INITIAL_SEQ = 1;

/* ---------------- 尺寸标注 ---------------- */

/** 从图元创建尺寸标注时，尺寸线相对图元的世界偏移的屏幕像素参考值（创建时按当前缩放换算一次） */
export const DIM_DEFAULT_OFFSET_PX = 14;
