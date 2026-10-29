/**
 * 出版排版编辑器的顶部工具条。
 *
 * 是什么：文件（打开… / 导出 geo.json / 导出 SVG）、添加（文字 / 标题 / 图例 / 色标）、
 * 视图（适应页面 / 1:1）三组命令按钮；宿主由 `app/page-main.ts` 建好（`.dock.page-topbar`，
 * 已带 `role="toolbar"`），本文件只往里填分组。
 * 为什么没有「保存」按钮：页面是纯静态的，导出 geo.json 就是落盘（`Ctrl+S` 走同一入口），
 * 导出 SVG 是另一份独立产物；两者都在浏览器内直接生成文件，不需要任何远端确认，
 * 也就不需要任何按钮禁用态。
 * 为什么不用草图模式的 `ui/toolbar.ts`：那个工具条绑定约束求解内核（工具/约束/吸附），
 * 与出版排版编辑器无关；这里只保留 miko_ui 的按钮与 `dock` 外观词汇。
 * 元信息：作者 frontend，2026-10-27；2026-10-28 改为无后端双导出。
 */

import { create_element, createButton, createControlGroup } from 'miko_ui';

/** 工具条命令的回调集合（全部由 `app/page-editor.ts` 实现） */
export interface PageToolbarHandlers {
  /** 「打开…」：换一份底图 + geo（脏时由组合根先确认） */
  open(): void;
  /** 导出 `<stem>.geo.json`（Ctrl+S 同此入口） */
  exportGeo(): void;
  /** 导出 final.svg（浏览器内合成） */
  exportSvg(): void;
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

/** 一个命令按钮：文案、悬停提示、点击动作 */
interface ToolbarAction {
  readonly text: string;
  readonly title: string;
  readonly run: () => void;
}

/**
 * 装配工具条；重复调用会整体替换宿主内容，不会叠出第二份。
 * 没有返回值：画面状态全部在编辑器里，工具条不需要被回写（按钮没有禁用态）。
 */
export function buildPageToolbar(root: HTMLElement, handlers: PageToolbarHandlers): void {
  const fileRow = create_element({ tag: 'div' }, { class: 'page-button-row' });
  const addRow = create_element({ tag: 'div' }, { class: 'page-button-row' });
  const viewRow = create_element({ tag: 'div' }, { class: 'page-button-row' });

  const add = (row: HTMLElement, action: ToolbarAction): void => {
    const button = createButton({ text: action.text, title: action.title });
    button.onClick(action.run);
    row.append(button.element);
  };

  add(fileRow, {
    text: '打开…',
    title: '重新选择底图 base.svg 与 geo.json（当前排版有改动时会先确认）',
    run: () => handlers.open(),
  });
  add(fileRow, {
    text: '导出 geo.json',
    title: '下载 geo.json（geo + 排版，可再次打开继续编辑；Ctrl+S）',
    run: () => handlers.exportGeo(),
  });
  add(fileRow, {
    text: '导出 SVG',
    title: '在浏览器内合成并下载 final.svg',
    run: () => handlers.exportSvg(),
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
}
