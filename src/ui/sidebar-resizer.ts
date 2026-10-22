/**
 * 左侧状态栏的宽度调整：拖动侧栏与 dock 之间的分隔条、或用键盘 ← / → 改宽，
 * 结果写进 `#app` 的 `--status-sidebar-width` 并记到 localStorage。
 *
 * 拖动走 miko_ui 的**窗口缩放手势** `bindWindowResize`（与桌面窗口那八根边缘手柄
 * 同一条 DOM 接线），本文件只保留库不认识的应用策略：
 * - 宽度的**呈现值**只有一条变量（默认值与上下限在 src/styles.css 的 :root）；
 * - 起手锚 + **总位移**解释：起手时记下指针 x 与视觉宽度，每帧算
 *   `起手宽度 + (指针 x - 起手 x)` 再夹取。这是 miko 在 `WindowGeometry.resizeGeometry`
 *   头注里写明的缩放口径 —— 移动边要么在指针底下，要么钉在界上等指针回到界内；
 *   不能用逐帧增量：被上下限吃掉的那段位移增量里没有记录，指针刚一回移尺寸就
 *   立刻跟着动，边与指针脱钩（平移才用增量，缩放用总位移，库刻意分了两套模型）；
 * - 拖拽 clamp：CSS 的 clamp 只兜「视口尺寸变化」，拖拽时行内变量必须在这里给上下限；
 *   上限额外按「应用宽度 - 拖拽条 - 画布最小宽度」收一次，保证画布不被挤没；
 * - 落库（localStorage）与读屏数值（`aria-value*`）；
 * - 键盘 ← / → / Home / End（库的缩放手势只管指针）。
 *
 * 画布尺寸不在这里通知：布局变了 Editor 的 ResizeObserver 会收到（见 editor.ts）。
 */

import { bindWindowResize } from 'miko_ui';
import {
  LAYOUT_FALLBACK,
  STATUS_SIDEBAR_KEY_STEP_LARGE_PX,
  STATUS_SIDEBAR_KEY_STEP_PX,
  STATUS_SIDEBAR_WIDTH_STORAGE_KEY,
} from '../config/layout';

/** 当前允许的宽度区间 */
interface WidthRange {
  readonly min: number;
  readonly max: number;
}

/**
 * 一次手势的锚：起手指针横坐标与起手视觉宽度。
 * 与 miko 窗口缩放同一个口径 —— 每帧都由锚 + 总位移重算，不累加增量。
 */
interface ResizeAnchor {
  readonly pointerX: number;
  readonly width: number;
}

/** 从计算样式读一个像素变量；读不到（样式表未生效 / 被整份覆盖成非法值）用兜底值 */
function readPx(app: HTMLElement, name: string, fallback: number): number {
  const value = Number.parseFloat(getComputedStyle(app).getPropertyValue(name).trim());
  return Number.isFinite(value) ? value : fallback;
}

/**
 * 当前允许的宽度区间。
 * 视口变窄时先保画布：上限再按「应用宽度 - 拖拽条 - 画布最小宽度」收一次；
 * 极端窄视口下这个值可能低于下限，此时以 240px 下限为准（画布拿走剩余宽度）。
 */
function resolveRange(app: HTMLElement): WidthRange {
  const min = readPx(app, '--status-sidebar-width-min', LAYOUT_FALLBACK.sidebarMin);
  const max = readPx(app, '--status-sidebar-width-max', LAYOUT_FALLBACK.sidebarMax);
  const resizer = readPx(app, '--status-resizer-width', LAYOUT_FALLBACK.resizerWidth);
  const canvasMin = readPx(app, '--status-canvas-min-width', LAYOUT_FALLBACK.canvasMinWidth);
  const viewportMax = app.clientWidth - resizer - canvasMin;
  return { min, max: Math.max(min, Math.min(max, viewportMax)) };
}

/** 分隔条左缘相对应用左缘的距离 = 侧栏此刻的视觉宽度（不受行内变量与 CSS clamp 分叉影响） */
function readVisualWidth(app: HTMLElement, separator: HTMLElement): number {
  return separator.getBoundingClientRect().left - app.getBoundingClientRect().left;
}

/** 写宽度与读屏可用的区间值；返回实际落地（clamp 后）的整数像素 */
function applyWidth(
  app: HTMLElement,
  separator: HTMLElement,
  width: number,
  range: WidthRange,
): number {
  const value = Math.min(range.max, Math.max(range.min, Math.round(width)));
  app.style.setProperty('--status-sidebar-width', `${value}px`);
  separator.setAttribute('aria-valuemin', String(Math.round(range.min)));
  separator.setAttribute('aria-valuemax', String(Math.round(range.max)));
  separator.setAttribute('aria-valuenow', String(value));
  // 读屏不能只靠一个裸数字：宽度是有单位的长度
  separator.setAttribute('aria-valuetext', `${value} 像素`);
  return value;
}

/** 记住宽度；隐私模式 / 存储被禁用时只影响「刷新后恢复」，不打断拖拽 */
function persistWidth(width: number): void {
  try {
    localStorage.setItem(STATUS_SIDEBAR_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // 存储不可用：本次会话内宽度仍然生效
  }
}

/** 读上次记住的宽度；没记过或存储不可用时返回 null（回落到样式表默认值） */
function readStoredWidth(): number | null {
  try {
    const raw = localStorage.getItem(STATUS_SIDEBAR_WIDTH_STORAGE_KEY);
    if (raw === null) return null;
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * 给分隔条接上拖拽与键盘调整。
 *
 * 分隔条就是侧栏的东缘手柄，所以方向词用 `'e'`（拖动右缘改宽度），
 * 与窗口缩放手柄共用同一个 `bindWindowResize`。
 *
 * @param app 应用根 `#app`：宽度变量写在它身上，clamp 的可用空间也按它算
 * @param separator 分隔条节点（role="separator"，由 app-shell.ts 建）
 */
export function bindSidebarResizer(app: HTMLElement, separator: HTMLElement): void {
  // 上次拖到的宽度优先；没有记忆就用样式表默认值（读不到再兜底）
  let range = resolveRange(app);
  let width = applyWidth(
    app,
    separator,
    readStoredWidth() ?? readPx(app, '--status-sidebar-width', LAYOUT_FALLBACK.sidebarWidth),
    range,
  );
  // 记忆值可能大于当前视口允许的上限：CSS 自己的 clamp 已经把侧栏压小，这里读回
  // 视觉宽度再落一次，保证行内变量、读屏数值与实际宽度三处一致。
  const visualWidth = Math.round(readVisualWidth(app, separator));
  if (visualWidth !== width) width = applyWidth(app, separator, visualWidth, range);

  // 外壳只挂载一次（与 Editor / notify 的监听同一生命周期），所以这里不引入 dispose
  // 语义；signal 只是库的绑定契约，将来需要卸载时在这个 controller 上 abort 即可。
  const controller = new AbortController();
  /** 当前手势的锚；null = 不在拖动中 */
  let anchor: ResizeAnchor | null = null;

  bindWindowResize(separator, controller.signal, 'e', {
    onStart: (event) => {
      // 起手时重算区间与视觉宽度：视口可能在两次拖拽之间变过
      range = resolveRange(app);
      anchor = {
        pointerX: event.clientX,
        width: Math.round(readVisualWidth(app, separator)),
      };
      // 拖动时整页保持列宽光标并禁止选中文本（类由 styles.css 消费）；
      // 光标本体由库在读 handle 的计算样式后写到 body 上，这里补的是「所有子元素」。
      document.body.classList.add('is-resizing-sidebar');
    },
    onResize: (_direction, pointer) => {
      if (anchor === null) return;
      // 总位移（不是增量）：夹住期间这段位移被吃掉，指针回到界内后尺寸能原样回来
      width = applyWidth(app, separator, anchor.width + pointer.x - anchor.pointerX, range);
    },
    onEnd: () => {
      anchor = null;
      document.body.classList.remove('is-resizing-sidebar');
      // 缩放手势的 onEnd 不区分原因；这里落库的是当前显示宽度，取消也不会丢状态
      persistWidth(width);
    },
  });

  separator.addEventListener(
    'keydown',
    (event) => {
      const step = event.shiftKey ? STATUS_SIDEBAR_KEY_STEP_LARGE_PX : STATUS_SIDEBAR_KEY_STEP_PX;
      range = resolveRange(app);
      const from = Math.round(readVisualWidth(app, separator));
      let next: number | null = null;
      if (event.key === 'ArrowLeft') next = from - step;
      else if (event.key === 'ArrowRight') next = from + step;
      else if (event.key === 'Home') next = range.min;
      else if (event.key === 'End') next = range.max;
      if (next === null) return;

      event.preventDefault();
      width = applyWidth(app, separator, next, range);
      persistWidth(width);
    },
    { signal: controller.signal },
  );
}
