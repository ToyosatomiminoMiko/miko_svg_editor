/**
 * 出版排版编辑器的顶部工具条。
 *
 * 是什么：文件（保存 / 重新合成 / 打开成品）、添加（文字 / 标题 / 图例 / 色标）、
 * 视图（适应页面 / 1:1）三组命令按钮；宿主由 `app/page-main.ts` 建好（`.dock.page-topbar`，
 * 已带 `role="toolbar"`），本文件只往里填分组。
 * 为什么不用草图模式的 `ui/toolbar.ts`：那个工具条绑定约束求解内核（工具/约束/吸附），
 * 与出版排版编辑器无关；这里只保留 miko_ui 的按钮与 `dock` 外观词汇。
 * 元信息：作者 frontend，2026-10-27。
 */

import { create_element, createButton, createControlGroup, type ButtonHandle } from 'miko_ui';

/** 工具条命令的回调集合（全部由 `app/page-editor.ts` 实现） */
export interface PageToolbarHandlers {
  /** 保存 scene 并合成（Ctrl+S） */
  save(): void;
  /** 用当前 scene 重新合成（不保存） */
  compose(): void;
  /** 新标签页打开服务端成品 final.svg */
  openFinal(): void;
  /** 缩放显示整页 */
  fitPage(): void;
  /** 1:1（1pt = 1 CSS px） */
  actualSize(): void;
  /** 添加普通文字（annotation） */
  addText(): void;
  /** 标题模板 */
  addTitle(): void;
  /** 空图例 */
  addLegend(): void;
  /** 空色标 */
  addColorbar(): void;
}

/** 工具条句柄：只暴露需要由编辑器回写的状态 */
export interface PageToolbarHandle {
  /** 保存中：保存按钮禁用，避免 Ctrl+S 连按写出两份 scene */
  setSaving(saving: boolean): void;
}

/** 一个命令按钮：文案、悬停提示、点击动作、可选禁用 */
interface ToolbarAction {
  readonly text: string;
  readonly title: string;
  readonly run: () => void;
}

/**
 * 装配工具条；重复调用会整体替换宿主内容，不会叠出第二份。
 */
export function buildPageToolbar(
  root: HTMLElement,
  handlers: PageToolbarHandlers,
): PageToolbarHandle {
  const fileRow = create_element({ tag: 'div' }, { class: 'page-button-row' });
  const addRow = create_element({ tag: 'div' }, { class: 'page-button-row' });
  const viewRow = create_element({ tag: 'div' }, { class: 'page-button-row' });

  /** 往某一行加按钮并返回句柄（保存按钮需要后续禁用） */
  const add = (row: HTMLElement, action: ToolbarAction): ButtonHandle => {
    const button = createButton({ text: action.text, title: action.title });
    button.onClick(action.run);
    row.append(button.element);
    return button;
  };

  const saveButton = add(fileRow, {
    text: '保存',
    title: '保存 scene.json 并合成成品（Ctrl+S）',
    run: () => handlers.save(),
  });
  add(fileRow, {
    text: '重新合成',
    title: '用当前 scene 重新合成 final.svg（会先保存当前编辑）',
    run: () => handlers.compose(),
  });
  add(fileRow, {
    text: '成品',
    title: '在新标签页打开服务端合成的 final.svg',
    run: () => handlers.openFinal(),
  });

  add(addRow, {
    text: '文字',
    title: '在页面中央添加一条文字（annotation）',
    run: () => handlers.addText(),
  });
  add(addRow, {
    text: '标题',
    title: '添加标题（title）',
    run: () => handlers.addTitle(),
  });
  add(addRow, {
    text: '图例',
    title: '添加图例（默认放在右栏）',
    run: () => handlers.addLegend(),
  });
  add(addRow, {
    text: '色标',
    title: '添加色标（配色与刻度来自 geo.relief）',
    run: () => handlers.addColorbar(),
  });

  add(viewRow, {
    text: '适应页面',
    title: '缩放显示整页',
    run: () => handlers.fitPage(),
  });
  add(viewRow, {
    text: '1:1',
    title: '1pt = 1 屏幕像素',
    run: () => handlers.actualSize(),
  });

  root.replaceChildren(
    createControlGroup('文件', fileRow),
    createControlGroup('添加', addRow),
    createControlGroup('视图', viewRow),
  );

  return {
    setSaving(saving: boolean): void {
      saveButton.setDisabled(saving);
    },
  };
}
