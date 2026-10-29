/**
 * 出版排版编辑器的「打开地图」上传面板。
 *
 * 是什么：画布中央的一块面板——一段说明、两个独立的选择栏（底图 SVG / JSON）、一个「打开地图」
 * 按钮和一行错误文案。每栏自带「选择…」按钮、隐藏的 `<input type="file">` 与文件名回显；拖到页面
 * 任意位置的文件会按扩展名自动落进对应一栏。本文件只负责分栏、展示已选文件、把选齐的文件交给
 * 回调，以及显示打开失败的中文原因。
 * 为什么 SVG 与 JSON 分成两栏：打开需要「底图 + geo.json」两份文件，用户经常只想换其中一份
 * （底图没变、只重新生成 geo.json；或排版文件没变、只换了底图）。合成一个 multiple 选择框时，
 * 第二次选择会覆盖第一次的全部选中项，用户只能每次把两份一起重选；拆成两栏后各栏独立替换，
 * 另一栏原样保留。
 * 为什么只按扩展名分栏：UI 层不该读文件内容。分栏只是把文件送进哪个框，真正的分类与校验
 * （JSON 的 `format`、sha256、viewBox 一致性）在 `app/page-main.ts` 与 `core/` 里做，
 * 内容 format 始终是唯一真值——扩展名分错也不会被误判，只是进错一栏后由 app 报错。
 * 为什么 geo 栏只收一个文件：排版（page 块）就在同一份 geo.json 里，两份 JSON 无法判断以谁为准。
 * 为什么面板覆盖整个画布：拖放目标越大越不容易拖错；面板隐藏后画布继续给编辑器用。
 * 元信息：作者 app，2026-10-28，无后端数据流（上传 base.svg + geo.json）；同日拆分为 SVG/JSON 两栏；
 *         2026-10-28 晚起 JSON 栏只收一份 geo.json（排版已并入其中，不再有可选 scene.json）。
 */

import { create_element, createButton, createPanel, type ButtonHandle } from 'miko_ui';
import { PAGE_UPLOAD_JSON_ACCEPT, PAGE_UPLOAD_SVG_ACCEPT } from '../config/page';
import { classifyUploadFile } from '../core/document';

/** 面板向组合根报告用户选择的结果（SVG 在前、JSON 在后；不做内容过滤） */
export interface PageOpenHandlers {
  onFiles(files: readonly File[]): void;
}

/** 上传面板句柄：显示/隐藏、清错、读写忙碌态 */
export interface PageOpenPanelHandle {
  /** 覆盖画布的面板根节点（已挂进宿主） */
  readonly element: HTMLElement;
  show(): void;
  hide(): void;
  /** 复位：清空两栏、清错误、清文件框的值（允许再次选择同一个文件）、取消忙碌态 */
  reset(): void;
  /** 展示/清除错误文案（null 表示清除） */
  setError(message: string | null): void;
  /** 读取与校验期间锁住输入，避免并发打开两份地图 */
  setBusy(busy: boolean): void;
}

/** 一栏的节点与已选文件 */
interface Slot {
  /** 整栏（标签 + 文件名 + 按钮），点空白处等同点「选择…」 */
  readonly root: HTMLElement;
  readonly pick: ButtonHandle;
  readonly input: HTMLInputElement;
  /** 文件名回显节点 */
  readonly name: HTMLElement;
  /** 空栏时的回显文案（JSON 栏要提示 geo.json 必需） */
  readonly emptyText: string;
  files: readonly File[];
}

/** 新建一栏所需的口径 */
interface SlotOptions {
  readonly label: string;
  readonly emptyText: string;
  readonly pickText: string;
  readonly pickTitle: string;
  readonly accept: string;
  /** 是否允许多选：底图与 JSON 都只收一个（排版已并入 geo.json） */
  readonly multiple: boolean;
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
    '分别选择底图 SVG 与 geo.json。',
  );
  const hint = create_element(
    { tag: 'p' },
    { class: 'page-open-hint' },
    '底图由 Cartopy_file 生成（负责几何），geo.json 记录刻度、地名与配色；本编辑器导出的 geo.json 还带排版，重新打开即可继续编辑。也可以把文件拖到页面任意位置，会按扩展名自动放进对应一栏。',
  );

  /** 建一栏：标签 + 文件名回显 + 「选择…」按钮 + 隐藏 input */
  const createSlot = (options: SlotOptions): Slot => {
    const name = create_element(
      { tag: 'span' },
      { class: 'page-open-slot-name' },
      options.emptyText,
    );
    const pick = createButton({
      text: options.pickText,
      class: 'page-open-slot-pick',
      title: options.pickTitle,
    });
    const input = create_element(
      { tag: 'input' },
      {
        type: 'file',
        class: 'page-open-input',
        accept: options.accept,
        multiple: options.multiple ? '' : undefined,
        'aria-hidden': 'true',
        tabindex: '-1',
      },
    );
    const root = create_element(
      { tag: 'div' },
      { class: 'page-open-slot', role: 'group', 'aria-label': options.label },
      create_element({ tag: 'span' }, { class: 'page-open-slot-label' }, options.label),
      name,
      pick.element,
    );
    return { root, pick, input, name, emptyText: options.emptyText, files: [] };
  };

  const svgSlot = createSlot({
    label: '底图 SVG',
    emptyText: '未选择',
    pickText: '选择 SVG…',
    pickTitle: '选择 Cartopy 生成的底图 .svg',
    accept: PAGE_UPLOAD_SVG_ACCEPT,
    multiple: false,
  });
  const jsonSlot = createSlot({
    label: 'geo.json',
    emptyText: '未选择（geo.json 必需）',
    pickText: '选择 geo.json…',
    pickTitle: '选择 geo.json（Cartopy 产出的，或本编辑器导出的带排版文件）',
    accept: PAGE_UPLOAD_JSON_ACCEPT,
    multiple: false,
  });

  const slots = create_element(
    { tag: 'div' },
    { class: 'page-open-slots' },
    svgSlot.root,
    jsonSlot.root,
  );

  const errorText = create_element({ tag: 'p' }, { class: 'page-open-error', role: 'alert' });
  errorText.hidden = true;

  const openButton = createButton({
    text: '打开地图',
    class: 'page-open-submit',
    disabled: true,
  });
  const actions = create_element(
    { tag: 'div' },
    { class: 'page-open-actions' },
    openButton.element,
  );

  const panel = createPanel({
    title: '打开地图',
    class: 'page-open-panel',
    body: [lead, hint, slots, errorText, actions, svgSlot.input, jsonSlot.input],
  });
  overlay.append(panel.element);
  host.append(overlay);

  let busy = false;

  const setDragging = (dragging: boolean): void => {
    slots.classList.toggle('is-dragover', dragging);
  };

  const setError = (message: string | null): void => {
    errorText.textContent = message ?? '';
    errorText.hidden = message === null || message.length === 0;
  };

  /** 把两栏状态同步到 DOM：文件名、已填样式、按钮可用性 */
  const sync = (): void => {
    for (const slot of [svgSlot, jsonSlot]) {
      const filled = slot.files.length > 0;
      slot.name.textContent = filled
        ? slot.files.map((file) => file.name).join('、')
        : slot.emptyText;
      slot.root.classList.toggle('is-filled', filled);
      slot.input.disabled = busy;
      slot.pick.setDisabled(busy);
    }
    const ready = svgSlot.files.length > 0 && jsonSlot.files.length > 0;
    openButton.setDisabled(busy || !ready);
    openButton.element.title = ready ? '' : '先分别选择底图 SVG 与 JSON';
  };

  const setBusy = (next: boolean): void => {
    busy = next;
    overlay.classList.toggle('is-busy', next);
    if (next) setDragging(false);
    sync();
  };

  /**
   * 把一批文件送进对应栏（选择框与拖放共用）：
   * - 底图最多一个，多了直接报错、两栏都不改；
   * - 只拖一种文件时另一栏保持原值（用户可能分两次拖）；
   * - JSON 栏一次只收一个 geo.json（排版与地理数据同在一个文件里，不能合并两份）。
   */
  const applyFiles = (files: readonly File[]): void => {
    if (files.length === 0) {
      setError('拖入的内容不是文件：请拖入 .svg 与 .json');
      return;
    }
    const svgFiles: File[] = [];
    const jsonFiles: File[] = [];
    const unknown: string[] = [];
    for (const file of files) {
      switch (classifyUploadFile(file.name)) {
        case 'base':
          svgFiles.push(file);
          break;
        case 'geo':
        case 'json':
          jsonFiles.push(file);
          break;
        case 'unknown':
          unknown.push(file.name);
          break;
      }
    }
    if (unknown.length > 0) {
      setError(`不识别的文件：${unknown.join('、')}。只接受 .svg 与 .json`);
      return;
    }
    if (svgFiles.length > 1) {
      setError(`只能选择一个底图 .svg（收到了 ${svgFiles.length} 个）`);
      return;
    }
    if (jsonFiles.length > 1) {
      setError(`只能选择一个 geo.json（收到了 ${jsonFiles.length} 个）`);
      return;
    }
    if (svgFiles.length === 1) svgSlot.files = svgFiles;
    if (jsonFiles.length === 1) jsonSlot.files = jsonFiles;
    setError(null);
    sync();
  };

  /** 「打开地图」：两栏都选齐才把文件交给组合根（内容校验仍由 app/core 做） */
  const submit = (): void => {
    if (busy) return;
    if (svgSlot.files.length === 0 || jsonSlot.files.length === 0) return;
    setError(null);
    handlers.onFiles([...svgSlot.files, ...jsonSlot.files]);
  };

  openButton.onClick(submit);

  for (const slot of [svgSlot, jsonSlot]) {
    slot.pick.onClick(() => {
      if (busy) return;
      slot.input.click();
    });
    // 点整栏空白处等同点按钮；点在按钮上时由按钮自己的 click 处理，避免一次点击弹两次文件框
    slot.root.addEventListener('click', (event) => {
      if (event.target === slot.pick.element) return;
      if (busy) return;
      slot.input.click();
    });
    slot.input.addEventListener('change', () => {
      const files = slot.input.files === null ? [] : [...slot.input.files];
      // 清掉 value：否则用户修好文件后重新选同一个文件不会触发 change
      slot.input.value = '';
      if (files.length === 0) return;
      applyFiles(files);
    });
  }

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
    applyFiles(files);
  });

  sync();

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
      svgSlot.files = [];
      jsonSlot.files = [];
      setError(null);
      setBusy(false);
      svgSlot.input.value = '';
      jsonSlot.input.value = '';
    },
    setError,
    setBusy,
  };
}
