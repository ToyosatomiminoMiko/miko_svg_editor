/**
 * 出版排版编辑器的「打开地图」上传面板。
 *
 * 是什么：画布中央的一块面板——说明需要哪几个文件、一个「选择文件…」按钮、一块拖放区
 * 和一行错误文案；只负责把用户选/拖进来的 `File[]` 交给回调，以及展示打开失败的中文原因。
 * 为什么不做文件分类与校验：那是 `app/page-main.ts` + `core/` 的职责（需要读字节、求 sha256、
 * 解析 SVG/JSON）；本文件是 UI 层，只碰 DOM 与 File 列表，方便单独复用与测试。
 * 为什么面板覆盖整个画布：拖放目标越大越不容易拖错；面板隐藏后画布继续给编辑器用。
 * 元信息：作者 app，2026-10-28，无后端数据流（上传 base.svg + geo.json）。
 */

import { create_element, createButton, createPanel } from 'miko_ui';
import { PAGE_UPLOAD_ACCEPT } from '../config/page';

/** 面板向组合根报告用户选择的结果（不做任何过滤） */
export interface PageOpenHandlers {
  onFiles(files: readonly File[]): void;
}

/** 上传面板句柄：显示/隐藏、清错、读写忙碌态 */
export interface PageOpenPanelHandle {
  /** 覆盖画布的面板根节点（已挂进宿主） */
  readonly element: HTMLElement;
  show(): void;
  hide(): void;
  /** 复位：清错误、清文件框的值（允许再次选择同一个文件）、取消忙碌态 */
  reset(): void;
  /** 展示/清除错误文案（null 表示清除） */
  setError(message: string | null): void;
  /** 读取与校验期间锁住输入，避免并发打开两份地图 */
  setBusy(busy: boolean): void;
}

/**
 * 在画布宿主里建上传面板（面板自带遮罩，`position: absolute; inset: 0`）。
 * 宿主需要是定位元素（`.page-canvas-host` 已是 `position: relative`）。
 */
export function createPageOpenPanel(
  host: HTMLElement,
  handlers: PageOpenHandlers,
): PageOpenPanelHandle {
  const overlay = create_element({ tag: 'div' }, { class: 'page-open' });

  const lead = create_element(
    { tag: 'p' },
    { class: 'page-open-lead' },
    '需要同名的底图 base.svg 与 geo.json（可选 scene.json）。',
  );
  const hint = create_element(
    { tag: 'p' },
    { class: 'page-open-hint' },
    '两份文件由 Cartopy_file 一起生成：底图负责几何，geo.json 负责刻度、地名与配色。把文件拖到页面任意位置，或点下面的按钮选择。',
  );

  const dropText = create_element(
    { tag: 'span' },
    { class: 'page-open-drop-text' },
    '把 base.svg 与 geo.json 拖到这里',
  );
  const pickButton = createButton({
    text: '选择文件…',
    title: '同时选择 base.svg、geo.json，必要时加上 scene.json',
  });
  const dropZone = create_element(
    { tag: 'div' },
    { class: 'page-open-drop' },
    dropText,
    pickButton.element,
  );

  const errorText = create_element({ tag: 'p' }, { class: 'page-open-error', role: 'alert' });
  errorText.hidden = true;

  const input = create_element(
    { tag: 'input' },
    {
      type: 'file',
      class: 'page-open-input',
      accept: PAGE_UPLOAD_ACCEPT,
      multiple: '',
      'aria-hidden': 'true',
      tabindex: '-1',
    },
  );

  const panel = createPanel({
    title: '打开地图',
    class: 'page-open-panel',
    body: [lead, hint, dropZone, errorText, input],
  });
  overlay.append(panel.element);
  host.append(overlay);

  let busy = false;

  const setDragging = (dragging: boolean): void => {
    dropZone.classList.toggle('is-dragover', dragging);
  };

  const submitFiles = (files: readonly File[]): void => {
    if (busy) return;
    handlers.onFiles(files);
  };

  const setError = (message: string | null): void => {
    errorText.textContent = message ?? '';
    errorText.hidden = message === null || message.length === 0;
  };

  const setBusy = (next: boolean): void => {
    busy = next;
    overlay.classList.toggle('is-busy', next);
    pickButton.setDisabled(next);
    input.disabled = next;
    if (next) setDragging(false);
  };

  const pick = (): void => {
    if (busy) return;
    input.click();
  };

  pickButton.onClick(pick);
  dropZone.addEventListener('click', (event) => {
    // 点拖放区空白处等同点按钮；点在按钮上时由按钮自己的 click 处理，避免切两次
    if (event.target === pickButton.element) return;
    pick();
  });
  input.addEventListener('change', () => {
    const files = input.files === null ? [] : [...input.files];
    // 清掉 value：否则用户修好文件后重新选同一个文件不会触发 change
    input.value = '';
    if (files.length === 0) return;
    setError(null);
    submitFiles(files);
  });

  overlay.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (busy) return;
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy';
    setDragging(true);
  });
  overlay.addEventListener('dragleave', (event) => {
    const next = event.relatedTarget;
    // 在面板内部从子节点移到另一个子节点也会触发 dragleave：只有离开整个遮罩才算离开
    if (next instanceof Node && overlay.contains(next)) return;
    setDragging(false);
  });
  overlay.addEventListener('drop', (event) => {
    event.preventDefault();
    setDragging(false);
    if (busy) return;
    const files = event.dataTransfer === null ? [] : [...event.dataTransfer.files];
    if (files.length === 0) {
      setError('拖入的内容不是文件：请拖入 .svg 与 .json 文件');
      return;
    }
    setError(null);
    submitFiles(files);
  });

  return {
    element: overlay,
    show(): void {
      overlay.hidden = false;
    },
    hide(): void {
      overlay.hidden = true;
      setDragging(false);
    },
    reset(): void {
      setError(null);
      setBusy(false);
      input.value = '';
    },
    setError,
    setBusy,
  };
}
