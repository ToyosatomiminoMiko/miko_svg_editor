/**
 * 工具栏 DOM 构建。按钮表来自 tools.ts 的 TOOLS 与 config/constraints-meta 的 CONSTRAINT_ACTIONS，
 * 动作由调用方（Editor）注入。
 *
 * DOM 与交互全部由 miko_ui 的公开原语搭建（面板 / 分段按钮组 / 按钮 / 开关 / 分组行），
 * 本文件只保留应用自己的类名（.app-*）与业务接线；不使用桌面窗口系统，线上 npm 包即可编译。
 */

import {
  create_element,
  createButton,
  createControlGroup,
  createInlineToggle,
  createPanel,
  createSegmented,
  createSwitch,
} from 'miko_ui';
import { CONSTRAINT_ACTIONS } from './config';
import { TOOLS, type ConstraintAction } from './tools';
import type { ToolId } from './types';

export interface ToolbarHandlers {
  setTool(id: ToolId): void;
  applyConstraint(kind: ConstraintAction): void;
  toggleSnap(): void;
  toggleFixed(): void;
  toggleConstruction(): void;
  fitView(): void;
  exportSVG(): void;
  clearAll(): void;
}

export interface ToolbarHandle {
  setActive(id: ToolId): void;
  setSnap(on: boolean): void;
}

/** 「视图与文件」区的一个按钮：文案、悬停提示、点击动作；数组顺序即显示顺序 */
interface ViewFileButton {
  readonly text: string;
  readonly title: string;
  readonly run: () => void;
}

export function buildToolbar(root: HTMLElement, handlers: ToolbarHandlers): ToolbarHandle {
  // 正文容器：三个控制组纵向排列，类名由 app CSS 作用域化（库只给 .ui-panel-body 的内边距）
  const content = create_element({ tag: 'div' }, { class: 'app-toolbar-content' });
  const panel = createPanel({ title: '草图工具', class: 'app-toolbar-panel', body: [content] });
  root.appendChild(panel.element);

  // 工具区：分段按钮组，列数等于工具数（一行排满），初值取默认工具
  const segmented = createSegmented<ToolId>({
    columns: TOOLS.length,
    ariaLabel: '绘图工具',
    value: 'select',
    items: TOOLS.map((t) => ({ value: t.id, label: t.label })),
  });
  // 用户点击命中新工具才回调（组内命中已选项不触发），与 state.tool 的写回由调用方负责
  segmented.onChange((id) => handlers.setTool(id));
  content.appendChild(createControlGroup('工具', segmented.element));

  // 约束区：按钮表单一来源是 CONSTRAINT_ACTIONS，顺序与按钮文案都从它来
  const constraintRow = create_element({ tag: 'div' }, { class: 'app-button-row' });
  for (const c of CONSTRAINT_ACTIONS) {
    const button = createButton({ text: c.label, title: '给选中图形加约束' });
    button.onClick(() => handlers.applyConstraint(c.id));
    constraintRow.appendChild(button.element);
  }
  content.appendChild(createControlGroup('约束', constraintRow));

  // 视图与文件区：吸附开关 + 五个动作按钮；按钮文案与提示沿用原工具栏
  const viewFileRow = create_element({ tag: 'div' }, { class: 'app-button-row' });

  // 开关自带可见标签（createInlineToggle 的 <label for> 已命名控件），故不再传 ariaLabel，
  // 否则读屏会把「吸附」念两遍
  const snapSwitch = createSwitch({ value: true });
  // 悬停提示沿用原吸附按钮的初始文案；开关本体的勾选态已表达开/关，title 不再随状态改写
  snapSwitch.input.title = '开/关吸附（S 键切换）';
  snapSwitch.onChange(() => handlers.toggleSnap());
  viewFileRow.appendChild(createInlineToggle('吸附', snapSwitch));

  const viewFileButtons: readonly ViewFileButton[] = [
    { text: '固定', title: '固定/解锁选中图形的点', run: () => handlers.toggleFixed() },
    {
      text: '构造',
      title: '切换选中图元的构造线虚显/导出虚线',
      run: () => handlers.toggleConstruction(),
    },
    { text: '适应', title: '缩放显示整张草图', run: () => handlers.fitView() },
    { text: '导出SVG', title: '下载当前草图', run: () => handlers.exportSVG() },
    { text: '清空', title: '删除所有图元', run: () => handlers.clearAll() },
  ];
  for (const meta of viewFileButtons) {
    const button = createButton({ text: meta.text, title: meta.title });
    button.onClick(meta.run);
    viewFileRow.appendChild(button.element);
  }
  content.appendChild(createControlGroup('视图与文件', viewFileRow));

  return {
    // 程序化选中：控件 set() 不触发 onChange，避免同步路径反写成「用户切工具」
    setActive(id: ToolId): void {
      segmented.set(id);
    },
    // 同理，勾选态由 state 驱动，set() 只改控件本身
    setSnap(on: boolean): void {
      snapSwitch.set(on);
    },
  };
}
