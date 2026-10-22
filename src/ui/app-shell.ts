/**
 * 应用外壳：把 `#app` 排成「左侧状态栏（通高）| 拖拽条 | 顶部 dock + 画布」的网格，
 * 并把四块宿主与画布一次性建好。
 *
 * 为什么用 CSS 网格而不是绝对定位叠层：三块 UI 不再互相遮盖，画布只占真正属于它的
 * 那一格。侧栏宽度是一条自定义属性（`--status-sidebar-width`），dock 换行变高时行高
 * 跟着内容走，画布自动让位 —— 没有任何一处需要 JS 重新计算布局，画布尺寸由
 * Editor 里的 ResizeObserver 跟上（见 editor.ts）。
 *
 * dock 宿主故意同时挂库的 `.dock` 与应用的 `.app-dock`：底色、下沿分隔线、横向排布
 * 仍然来自 `miko_ui/styles.css`；应用样式只覆盖它的定位与高度，让它落进网格
 * 而不是贴住视口上沿（见 styles.css 的 `.app-dock.dock`）。
 *
 * 本文件只建静态宿主与分隔条接线，面板/工具栏/画布内容由各自模块填。
 */

import { create_element } from 'miko_ui';
import { bindSidebarResizer } from './sidebar-resizer';

/** 外壳交给上层（main.ts）的四个节点；顺序即 DOM 顺序（视觉顺序由网格决定）。 */
export interface AppShellHandle {
  /** 左侧状态栏宿主（`.app-status`）：ui/status-panel.ts 往里建面板 */
  readonly sidebarRoot: HTMLElement;
  /** 顶部 dock 宿主（`.dock.app-dock`）：toolbar.ts 往里建工具按钮 */
  readonly dockRoot: HTMLElement;
  /** 画布节点（`.app-canvas`）：Editor 的事件与渲染目标 */
  readonly canvas: HTMLCanvasElement;
  /** 通知区宿主（`.app-notices`）：ui/notify.ts 往里建消息区 */
  readonly noticesRoot: HTMLElement;
}

/**
 * 在 `#app` 里立起外壳。
 *
 * 分隔条是**可聚焦的 `separator`**：鼠标拖动之外，键盘用户能用 ← / → 调宽
 * （见 sidebar-resizer.ts）；它的宽度不参与 CSS 变量，固定在样式表里。
 */
export function mountAppShell(app: HTMLElement): AppShellHandle {
  const sidebarRoot = create_element({ tag: 'div', into: app }, { class: 'app-status' });

  const separator = create_element(
    { tag: 'div', into: app },
    {
      class: 'app-sidebar-resizer',
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-label': '调整草图状态栏宽度',
      tabindex: '0',
    },
  );

  // role/aria-label 与 mountDesktop 给 dock 的口径一致：它就是「草图工具」的工具条
  const dockRoot = create_element(
    { tag: 'div', into: app },
    { class: 'dock app-dock', role: 'toolbar', 'aria-label': '草图工具' },
  );

  const canvas = create_element(
    { tag: 'canvas', into: app },
    { id: 'canvas', class: 'app-canvas', 'aria-label': 'SVG 草图编辑画布' },
  );

  const noticesRoot = create_element({ tag: 'div', into: app }, { class: 'app-notices' });

  bindSidebarResizer(app, separator);

  return { sidebarRoot, dockRoot, canvas, noticesRoot };
}
