/**
 * 页面布局常量：左侧状态栏宽度拖拽用到的那几个数。
 *
 * 为什么宽度本身不在这里：侧栏宽度的呈现值只有一份真相 —— `src/styles.css`
 * `:root` 里的 `--status-sidebar-width`（默认值）与 `--status-sidebar-width-min` /
 * `-max`、`--status-resizer-width`、`--status-canvas-min-width`。拖拽时只把
 * `--status-sidebar-width` 写成 `#app` 的行内变量；上下限每次起手从计算样式读，
 * 这样改样式表不需要同步改 TS。本文件的数字只在「计算样式里读不到那个变量」时
 * 兜底（与 theme.ts 读画布 token 的兜底同一条口径），正常路径永远不生效。
 *
 * 记忆键与键盘步长是纯交互口径，CSS 表达不了，放在这里。
 */

/** 侧栏宽度写进 localStorage 的键：刷新后回到上次拖到的宽度 */
export const STATUS_SIDEBAR_WIDTH_STORAGE_KEY = 'miko-svg-editor.status-sidebar-width';

/** 分隔条聚焦后 ← / → 每按一次调整的像素 */
export const STATUS_SIDEBAR_KEY_STEP_PX = 16;

/** Shift + ← / → 的粗调像素 */
export const STATUS_SIDEBAR_KEY_STEP_LARGE_PX = 64;

/**
 * 计算样式读不到布局变量时的兜底值。
 *
 * 唯一真相是 `src/styles.css` 的 `:root`；这里必须与它一致，只有「样式表还没生效」
 * 或「消费者整份覆盖了变量」时才用得上。上下限与兜底画布宽度也都由样式表定义，
 * 所以拖拽的 clamp 结果在 CSS 与 JS 两侧一致。
 */
export const LAYOUT_FALLBACK = {
  sidebarWidth: 340,
  sidebarMin: 240,
  sidebarMax: 560,
  resizerWidth: 6,
  canvasMinWidth: 420,
} as const;
