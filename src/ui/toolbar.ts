/**
 * 顶部 dock 的工具栏装配。宿主 root 由 ui/app-shell.ts 建好，已带
 * `class="dock app-dock"`、`role="toolbar"`、`aria-label="草图工具"`；本文件只往里填
 * 两个直接子节点：
 * - `div.dock-group.app-dock-tools`：左侧「工具」分段 + 「约束」按钮组；
 * - `div.dock-actions.app-dock-actions`：右侧「视图与文件」动作组（`.dock-actions`
 *   自带 `margin-left: auto`，把它推到 dock 右端）。
 *
 * 为什么不再用 createPanel：dock 是 miko 桌面任务栏的形态——通栏、无圆角、无标题栏，
 * 面板的标题栏与内边距会和 dock 自己的外观打架；两分区用 `.dock-group` /
 * `.dock-actions` 这组 dock 词汇，宿主语义（role / aria-label）已由 app-shell 给足。
 * 两个分区一次 `replaceChildren` 写入，重复调用不会叠出第二份。
 *
 * 按钮表来自 operations.ts 的 TOOLS / CONSTRAINT_OPERATIONS / EDIT_OPERATIONS，
 * 动作由调用方（Editor）注入。
 *
 * 两种模式只差「视图与文件」区的即时命令：草图模式导出本地 SVG；地图模式的成品由 Python
 * 合成，所以换成「保存 / 成品」，工具与约束分组两边完全一致（同一编辑内核）。
 *
 * 与命令模型的关系：工具与约束/固定/构造按钮都只是「启动一个操作」——操作把参数槽位
 * 填满后立即执行（见 operations.ts 与 ui/editor-controls.ts）。工具栏不保存任何参数，
 * 只负责把点击转成 armOperation(id)，并同步「当前工具」与「当前操作按钮」的高亮态。
 */

import {
  create_element,
  createButton,
  createControlGroup,
  createInlineToggle,
  createSegmented,
  createSwitch,
  type ButtonHandle,
} from 'miko_ui';
import {
  CONSTRAINT_OPERATIONS,
  EDIT_OPERATIONS,
  TOOLS,
  type OperationId,
} from '../core/operations';
import type { ToolId } from '../core/types';

export interface ToolbarHandlers {
  setTool(id: ToolId): void;
  /** 约束 / 固定 / 构造按钮：启动一个参数槽位化操作 */
  armOperation(id: OperationId): void;
  toggleSnap(): void;
  fitView(): void;
  /** 本地导出当前草图 */
  exportSVG(): void;
  clearAll(): void;
}

export interface ToolbarHandle {
  /** 程序化选中工具分段（不触发 onChange） */
  setActiveTool(id: ToolId): void;
  /** 约束/编辑按钮的高亮态：传入当前操作 id，null 清除 */
  setActiveOperation(id: OperationId | null): void;
  setSnap(on: boolean): void;
}

/** 「视图与文件」区的一个按钮：文案、悬停提示、点击动作、是否禁用；数组顺序即显示顺序 */
interface ViewFileButton {
  readonly text: string;
  readonly title: string;
  readonly run: () => void;
  readonly disabled?: boolean;
}

/**
 * 装配工具栏。
 * @param root dock 宿主（`.dock.app-dock`）
 * @param handlers 工具/约束/视图动作的回调
 */
export function buildToolbar(root: HTMLElement, handlers: ToolbarHandlers): ToolbarHandle {
  // 左分区：工具分段 + 约束/编辑按钮组；行容器留 .app-button-row 负责窄视口换行
  const toolZone = create_element({ tag: 'div' }, { class: 'dock-group app-dock-tools' });

  // 工具区：分段按钮组，列数等于工具数（一行排满），初值取默认工具
  const segmented = createSegmented<ToolId>({
    columns: TOOLS.length,
    ariaLabel: '绘图工具',
    value: 'select',
    items: TOOLS.map((t) => ({ value: t.id, label: t.label })),
  });
  // 用户点击命中新工具才回调（组内命中已选项不触发），与 state.tool 的写回由调用方负责
  segmented.onChange((id) => handlers.setTool(id));
  toolZone.appendChild(createControlGroup('工具', segmented.element));

  // 约束区：按钮表单一来源是 operations 的约束操作，顺序与按钮文案都从它来
  const constraintRow = create_element({ tag: 'div' }, { class: 'app-button-row' });
  const actionButtons = new Map<OperationId, ButtonHandle>();
  /** 往某一行的按钮表里加一枚操作按钮：行容器由调用点给（约束组 / 视图与文件组） */
  const addActionButton = (
    row: HTMLElement,
    id: OperationId,
    text: string,
    title: string,
  ): void => {
    const button = createButton({ text, title });
    button.onClick(() => handlers.armOperation(id));
    actionButtons.set(id, button);
    row.appendChild(button.element);
  };
  for (const op of CONSTRAINT_OPERATIONS)
    addActionButton(constraintRow, op.id, op.label, '参数可在画布上补齐，填满立即执行');
  toolZone.appendChild(createControlGroup('约束', constraintRow));

  // 右分区：视图与文件（吸附开关 + 即时命令，草图 3 个 / 地图 4 个）
  const actionZone = create_element({ tag: 'div' }, { class: 'dock-actions app-dock-actions' });
  const viewFileRow = create_element({ tag: 'div' }, { class: 'app-button-row' });

  // 开关自带可见标签（createInlineToggle 的 <label for> 已命名控件），故不再传 ariaLabel，
  // 否则读屏会把「吸附」念两遍
  const snapSwitch = createSwitch({ value: true });
  // 悬停提示沿用原吸附按钮的初始文案；开关本体的勾选态已表达开/关，title 不再随状态改写
  snapSwitch.input.title = '开/关吸附（S 键切换）';
  snapSwitch.onChange(() => handlers.toggleSnap());
  viewFileRow.appendChild(createInlineToggle('吸附', snapSwitch));

  // 固定/构造也是参数槽位化操作：按钮进同一张高亮表，位置沿用原「视图与文件」小节
  for (const op of EDIT_OPERATIONS)
    addActionButton(viewFileRow, op.id, op.label, '参数可在画布上补齐，填满立即执行');

  // 即时命令表：适应视图 / 导出本地 SVG / 清空
  const viewFileButtons: readonly ViewFileButton[] = [
    { text: '适应', title: '缩放显示整张草图', run: () => handlers.fitView() },
    { text: '导出SVG', title: '下载当前草图', run: () => handlers.exportSVG() },
    { text: '清空', title: '删除所有图元', run: () => handlers.clearAll() },
  ];
  for (const meta of viewFileButtons) {
    const button = createButton({
      text: meta.text,
      title: meta.title,
      disabled: meta.disabled ?? false,
    });
    button.onClick(meta.run);
    viewFileRow.appendChild(button.element);
  }
  actionZone.appendChild(createControlGroup('视图与文件', viewFileRow));

  // 两个分区一次落位：重复调用只会替换旧子树，不会叠出第二份
  root.replaceChildren(toolZone, actionZone);

  return {
    // 程序化选中：控件 set() 不触发 onChange，避免同步路径反写成「用户切工具」
    setActiveTool(id: ToolId): void {
      segmented.set(id);
    },
    setActiveOperation(id: OperationId | null): void {
      for (const [opId, button] of actionButtons) {
        const active = opId === id;
        button.element.classList.toggle('is-active', active);
        if (active) button.element.setAttribute('aria-pressed', 'true');
        else button.element.removeAttribute('aria-pressed');
      }
    },
    // 同理，勾选态由 state 驱动，set() 只改控件本身
    setSnap(on: boolean): void {
      snapSwitch.set(on);
    },
  };
}
