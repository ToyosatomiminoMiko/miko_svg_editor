/**
 * 左侧「草图状态」栏外壳：一块通高面板，上半是「已选择」列表、下半是「状态 / 尺寸输入」。
 *
 * 为什么合并成一栏：选择集与当前命令状态都是「此刻在编辑什么」的上下文，原先分处屏幕
 * 两端，视线要来回跳；合并后上半是已选择对象（含逐项移除），下半是命令参数进度、
 * 工具说明、info 闪示与尺寸输入框，宽度一致、阅读顺序从上到下。
 *
 * 为什么是通高侧栏而不是浮在左下角的面板：它现在是布局里的一列（见 ui/app-shell.ts 与
 * styles.css 的网格），不再遮住画布，也就不会和左上角的 dock 抢地方；列表在栏内
 * 滚动，宽度由分隔条拖拽（见 ui/sidebar-resizer.ts）。
 *
 * 只负责面板框体与两个插槽：列表内容见 selection-list.ts，状态文案与尺寸输入见
 * hint-editor.ts。外观只靠 .app-status-* 类名交给应用样式表，本文件不写内联样式、
 * 不 import CSS。
 */

import { create_element, createPanel } from 'miko_ui';

export class StatusPanel {
  /** 上半：「已选择」列表插槽（selection-list.ts 填充） */
  readonly selectionSlot: HTMLElement;
  /** 下半：状态文案与尺寸输入插槽（hint-editor.ts 填充） */
  readonly statusSlot: HTMLElement;

  /**
   * @param root 左侧状态栏宿主（`.app-status` 空 div）；面板由本类自己建并 append 进去
   */
  constructor(root: HTMLElement) {
    const panel = createPanel({ title: '草图状态', class: 'app-status-panel' });
    root.append(panel.element);

    this.selectionSlot = create_element({ tag: 'div' }, { class: 'app-status-selection' });
    this.statusSlot = create_element({ tag: 'div' }, { class: 'app-status-body' });
    panel.body.append(this.selectionSlot, this.statusSlot);
  }
}
