/**
 * 样式设置窗口：按「页面文字 / 地图标注」分类统一编辑文字样式。
 *
 * 是什么：独立模态窗口（遮罩 + 两列面板）。左列按 `config/text-style.ts` 的
 * `TEXT_STYLE_CATEGORY_GROUPS` 列出全部分类（当前颜色色块 + 显示名）；右列按分类 `kind`
 * 重建字段（字号/颜色/字重/斜体/行高/字距/光晕）。
 * 为什么样式只在窗口里按分类改：样式是分类级覆盖（`page.text_style`），改一次由 core
 * 批量写回该分类下所有 item（`.work/STYLE-SETTINGS-SPEC.md` §0/§3）。窗口只负责发
 * 「单字段补丁」与「恢复默认」，脏标记/重绘/侧栏同步全部由宿主的 onApply/onReset 完成；
 * 本模块不持有 layout，每次读都走 getLayout/getGeo 取最新值，因此窗口打开期间外部改动
 * 也会在 sync() 里反映出来。
 * 字号口径（2026-11-05 用户反馈后统一）：页面分类与地图分类都只有一个「字号（pt）」数字；
 * 地图分类的字号是必设项、同分类下全部地名永远统一（§12.1/§12.2），窗口不再有
 * 「统一字号」开关或「跟随底图数据」模式，直接显示 `readTextCategoryStyle` 算出的有效字号
 * （用户覆盖 ?? core 的分类默认统一字号）。
 * 刷新口径：选中分类切换 / 打开窗口 / 恢复默认时整体重建右侧字段；用户输入与外部 layout
 * 变化（sync）只就地刷新值，且跳过聚焦中的控件，避免打断正在输入的数字。光晕开关会改变
 * 光晕颜色/宽度的可用性，这类结构变化由 refreshStructure() 单独处理，不重建整块字段
 * （重建会丢焦点）。
 * 无障碍：模态 `role="dialog" aria-modal="true" aria-label="样式设置"`；Esc / 点遮罩 /
 * 头部与底部「关闭」都能关闭；打开时焦点进窗口，关闭时归还给打开前的焦点。
 * 元信息：作者 ui-dev，2026-11-05，新建（`.work/STYLE-SETTINGS-SPEC.md` §7.3）；
 *         作者 ui-dev，2026-11-05，按 §12.2 删除地图分类「统一字号」开关（字号恒统一）。
 */

import {
  createButton,
  createControlGroup,
  create_element,
  createFieldLabel,
  createNumberField,
  createNumberRow,
  createRow,
  createSegmented,
  createSwitch,
  createSwitchRow,
  nextWidgetId,
  type NumberFieldHandle,
  type SegmentedHandle,
  type SwitchHandle,
} from 'miko_ui';
import {
  MAP_LABEL_STYLE,
  TEXT_HALO,
  TEXT_STYLE_CATEGORY_GROUPS,
  TEXT_STYLE_CATEGORY_META,
  type TextStyleCategoryId,
  type TextStyleCategoryKind,
} from '../config/text-style';
import type { Geo, Halo, PageLayout } from '../core/page';
import {
  readTextCategoryStyle,
  type ResolvedTextStyle,
  type TextStylePatch,
} from '../core/text-style';

/** 窗口需要宿主注入的全部能力（布局/地图的最新值 + 补丁出口） */
export interface StyleSettingsWindowDeps {
  /** 宿主（挂 overlay；app 传 document.body） */
  readonly host: HTMLElement;
  readonly getLayout: () => PageLayout;
  readonly getGeo: () => Geo;
  /** 应用补丁（编辑器负责脏标记/重绘/侧栏同步） */
  readonly onApply: (category: TextStyleCategoryId, patch: TextStylePatch) => void;
  /** 恢复该分类默认样式 */
  readonly onReset: (category: TextStyleCategoryId) => void;
}

/** 分类列表里的一项：按钮 + 它的颜色色块（色块底色由 TS 写，见 refreshSelection） */
interface CategoryEntry {
  readonly button: HTMLButtonElement;
  readonly swatch: HTMLElement;
}

/**
 * 字段值绑定：重建字段时登记，sync 时就地刷新用。
 * 为什么用判别联合而不是基类：四类控件的「读值 → 写显示」只有几行差异，
 * 联合 + switch 在类型上就能保证每个分支都处理到（`switch-exhaustiveness-check`）。
 */
type FieldBinding =
  | { readonly kind: 'number'; readonly field: NumberFieldHandle; readonly read: () => number }
  | { readonly kind: 'color'; readonly input: HTMLInputElement; readonly read: () => string }
  | { readonly kind: 'switch'; readonly handle: SwitchHandle; readonly read: () => boolean }
  | {
      readonly kind: 'segmented';
      readonly handle: SegmentedHandle<string>;
      readonly read: () => string;
    };

/** 字重分段选项：与侧栏改造前同一组四档（导入的其它合法字重原样保留，不在此改写） */
const FONT_WEIGHT_OPTIONS = [
  { value: '400', label: '常规' },
  { value: '500', label: '中等' },
  { value: '600', label: '半粗' },
  { value: '700', label: '粗' },
] as const;

/** 颜色值兜底：`<input type="color">` 只接受 #rrggbb（与 `page-sidebar-controls.ts` 同口径） */
function safeColor(value: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000';
}

export class StyleSettingsWindow {
  private readonly deps: StyleSettingsWindowDeps;
  private readonly overlay: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly fieldsEl: HTMLElement;
  private readonly categoryEntries = new Map<TextStyleCategoryId, CategoryEntry>();

  /** 当前选中分类：默认第一个页面文字分类；关闭后保留，下次打开仍在原分类 */
  private selected: TextStyleCategoryId =
    TEXT_STYLE_CATEGORY_GROUPS[0]?.categories[0]?.id ?? 'title';
  private isOpen = false;
  /** 打开前的焦点元素：关闭时归还（元素可能已被移除，归还前判 isConnected） */
  private previousFocus: HTMLElement | null = null;

  /** 静态按钮的清理回调（关闭按钮/恢复默认），destroy 时统一释放 */
  private readonly disposers: (() => void)[] = [];
  /** 本次字段重建产生的控件清理回调（重建前先释放上一批） */
  private fieldDisposers: (() => void)[] = [];
  /** 字段值绑定（与 fieldDisposers 同生命周期） */
  private bindings: FieldBinding[] = [];
  /** 光晕关闭时需要禁用的两个控件与其行 */
  private haloColorInput: HTMLInputElement | null = null;
  private haloWidthField: NumberFieldHandle | null = null;
  private haloRows: HTMLElement[] = [];

  constructor(deps: StyleSettingsWindowDeps) {
    this.deps = deps;

    // 遮罩 + 窗口骨架：类名是 styles-page.css 的消费契约（spec §7.3）
    this.overlay = create_element({ tag: 'div' }, { class: 'page-style-overlay', hidden: '' });
    this.panel = create_element(
      { tag: 'div' },
      {
        class: 'page-style-window',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': '样式设置',
        tabindex: '-1',
      },
    );
    const header = create_element({ tag: 'header' }, { class: 'page-style-header' });
    const title = create_element({ tag: 'h2' }, { class: 'page-style-title' }, '样式设置');
    const headerClose = createButton({
      text: '关闭',
      class: 'page-style-close',
      title: '关闭样式设置（Esc）',
    });
    headerClose.onClick(() => this.close());
    header.append(title, headerClose.element);

    const body = create_element({ tag: 'div' }, { class: 'page-style-body' });
    this.listEl = create_element({ tag: 'div' }, { class: 'page-style-list' });
    this.fieldsEl = create_element({ tag: 'div' }, { class: 'page-style-fields' });
    body.append(this.listEl, this.fieldsEl);

    const footer = create_element({ tag: 'footer' }, { class: 'page-style-footer' });
    const reset = createButton({
      text: '恢复默认',
      class: 'page-style-reset',
      title: '把该分类的样式恢复为默认值',
    });
    reset.onClick(() => this.resetSelected());
    const footerClose = createButton({ text: '关闭', title: '关闭样式设置' });
    footerClose.onClick(() => this.close());
    footer.append(reset.element, footerClose.element);

    this.panel.append(header, body, footer);
    this.overlay.append(this.panel);
    this.disposers.push(
      () => headerClose.dispose(),
      () => reset.dispose(),
      () => footerClose.dispose(),
    );

    this.buildCategoryList();
    // 点遮罩（不是面板内部）关闭：与确认框同一条判定
    this.overlay.addEventListener('click', (event) => {
      if (event.target === this.overlay) this.close();
    });
  }

  /* =========================== 对外生命周期 =========================== */

  /** 打开窗口：重建字段 → 挂载 → 焦点进面板 → 接管 Esc */
  open(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    const active = this.overlay.ownerDocument.activeElement;
    this.previousFocus = active instanceof HTMLElement ? active : null;
    if (!this.overlay.isConnected) this.deps.host.append(this.overlay);
    this.overlay.hidden = false;
    this.rebuildFields();
    this.refresh();
    window.addEventListener('keydown', this.onKeyDown, true);
    this.panel.focus();
  }

  /** 关闭窗口：摘掉遮罩、解除 Esc、归还焦点；字段控件保留到下次重建/destroy */
  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    window.removeEventListener('keydown', this.onKeyDown, true);
    this.overlay.hidden = true;
    this.overlay.remove();
    const previous = this.previousFocus;
    this.previousFocus = null;
    if (previous !== null && previous.isConnected) previous.focus();
  }

  /** 外部 layout 变化后刷新显示（可选调用；关闭状态下不读 layout，避免会话已销毁） */
  sync(): void {
    if (!this.isOpen) return;
    this.refresh();
  }

  /** 卸载：关闭、释放全部控件、移除 DOM（切换文档/页面卸载时调用） */
  destroy(): void {
    this.close();
    this.disposeFields();
    this.overlay.remove();
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
    this.categoryEntries.clear();
  }

  /* =========================== 列表与选中 =========================== */

  /** 按 config 的两组分类建左列（分类 id/显示名只来自 config，UI 不写死文案） */
  private buildCategoryList(): void {
    const groups: HTMLElement[] = [];
    for (const group of TEXT_STYLE_CATEGORY_GROUPS) {
      const groupEl = create_element(
        { tag: 'section' },
        { class: 'page-style-group', 'aria-label': group.label },
      );
      groupEl.append(
        create_element({ tag: 'h3' }, { class: 'page-style-group-title' }, group.label),
      );
      for (const meta of group.categories) {
        const button = create_element(
          { tag: 'button' },
          {
            type: 'button',
            class: 'page-style-category',
            'aria-pressed': 'false',
            title: meta.label,
          },
        );
        const swatch = create_element({ tag: 'span' }, { class: 'page-style-swatch' });
        const name = create_element(
          { tag: 'span' },
          { class: 'page-style-category-name' },
          meta.label,
        );
        button.append(swatch, name);
        button.addEventListener('click', () => this.select(meta.id));
        groupEl.append(button);
        this.categoryEntries.set(meta.id, { button, swatch });
      }
      groups.push(groupEl);
    }
    this.listEl.replaceChildren(...groups);
  }

  /** 切换分类：整体重建右侧字段（kind 可能从 page 变 map） */
  private select(category: TextStyleCategoryId): void {
    if (category === this.selected) return;
    this.selected = category;
    this.rebuildFields();
    this.refresh();
    this.fieldsEl.scrollTop = 0;
  }

  /** 「恢复默认」：先让宿主删掉该分类覆盖，再按最新 layout 重建字段 */
  private resetSelected(): void {
    this.deps.onReset(this.selected);
    this.rebuildFields();
    this.refresh();
  }

  /* =========================== 右侧字段 =========================== */

  /** 重建右侧字段：先释放上一批控件，再按分类 kind 声明字段与分区 */
  private rebuildFields(): void {
    this.disposeFields();
    this.haloColorInput = null;
    this.haloWidthField = null;
    this.haloRows = [];

    const meta = TEXT_STYLE_CATEGORY_META[this.selected];
    const kindLabel = meta.kind === 'map' ? '地图标注' : '页面文字';
    const heading = create_element(
      { tag: 'h3' },
      { class: 'page-style-fields-title' },
      meta.label,
      create_element({ tag: 'span' }, { class: 'page-style-fields-kind' }, kindLabel),
    );

    this.fieldsEl.replaceChildren(
      heading,
      this.buildSizeSection(meta.kind),
      this.buildTypeSection(),
      this.buildHaloSection(),
    );
    this.refreshStructure();
  }

  /**
   * 字号区：页面分类与地图分类都是同一个数字行（min 1 / step 0.5）。
   * 地图分类字号是必设项（§12.1）：同分类下全部地名永远统一使用这个字号，所以不再有
   * 开关，只在数字行下面放一句静态说明（不是控件，也不随状态显隐）。
   */
  private buildSizeSection(kind: TextStyleCategoryKind): HTMLElement {
    const grid = create_element({ tag: 'div' }, { class: 'page-field-grid' });
    this.addNumberRow(
      grid,
      '字号（pt）',
      () => this.readStyle().font_size_pt,
      (value) => this.apply({ font_size_pt: value }),
      { min: 1, max: 500, step: 0.5 },
    );
    if (kind === 'map') {
      grid.append(
        create_element({ tag: 'p' }, { class: 'page-style-hint' }, '该分类全部地名统一使用此字号'),
      );
    }
    return createControlGroup('字号', grid);
  }

  /** 通用文字字段：颜色 / 字重 / 斜体 / 行高 / 字距（页面与地图分类共用） */
  private buildTypeSection(): HTMLElement {
    const grid = create_element({ tag: 'div' }, { class: 'page-field-grid' });
    this.addColorRow(
      grid,
      '文字颜色',
      () => this.readStyle().color,
      (value) => this.apply({ color: value }),
    );

    const weight = createSegmented<string>({
      columns: 4,
      ariaLabel: '字重',
      value: String(this.readStyle().font_weight),
      items: FONT_WEIGHT_OPTIONS,
    });
    weight.onChange((value) => this.apply({ font_weight: Number(value) }));
    const weightRow = createRow(
      create_element({ tag: 'span' }, { class: 'page-style-row-label' }, '字重'),
      weight.element,
    );
    weightRow.classList.add('page-style-weight-row');
    grid.append(weightRow);
    this.bindings.push({
      kind: 'segmented',
      handle: weight,
      read: () => String(this.readStyle().font_weight),
    });
    this.fieldDisposers.push(() => weight.dispose());

    this.addSwitchRow(
      grid,
      '斜体',
      () => this.readStyle().italic,
      (value) => this.apply({ italic: value }),
    );
    this.addNumberRow(
      grid,
      '行高（倍数）',
      () => this.readStyle().line_height,
      (value) => this.apply({ line_height: value }),
      { min: 0.5, max: 5, step: 0.05 },
    );
    this.addNumberRow(
      grid,
      '字距（em）',
      () => this.readStyle().letter_spacing_em,
      (value) => this.apply({ letter_spacing_em: value }),
      { min: -1, max: 2, step: 0.01 },
    );
    return createControlGroup('文字', grid);
  }

  /** 光晕：开关 + 颜色 + 宽度；关闭时颜色/宽度禁用（避免在「无光晕」上写孤立值） */
  private buildHaloSection(): HTMLElement {
    const grid = create_element({ tag: 'div' }, { class: 'page-field-grid' });
    this.addSwitchRow(
      grid,
      '光晕',
      () => this.readStyle().halo !== null,
      (enabled) => this.apply({ halo: enabled ? this.defaultHalo() : null }),
    );
    const color = this.addColorRow(
      grid,
      '光晕颜色',
      () => this.readStyle().halo?.color ?? this.defaultHalo().color,
      (value) => {
        const halo = this.readStyle().halo;
        if (halo === null) return;
        this.apply({ halo: { color: value, width_pt: halo.width_pt } });
      },
    );
    const width = this.addNumberRow(
      grid,
      '光晕宽度（pt）',
      () => this.readStyle().halo?.width_pt ?? this.defaultHalo().width_pt,
      (value) => {
        const halo = this.readStyle().halo;
        if (halo === null) return;
        this.apply({ halo: { color: halo.color, width_pt: value } });
      },
      { min: 0, max: 20, step: 0.5 },
    );
    this.haloColorInput = color.input;
    this.haloWidthField = width.field;
    this.haloRows.push(color.row, width.row);
    return createControlGroup('光晕', grid);
  }

  /* =========================== 字段工厂 =========================== */

  /** 数字行：input 阶段即时写补丁；提交时解析失败就把显示回退到 layout 里的最新值 */
  private addNumberRow(
    parent: HTMLElement,
    label: string,
    read: () => number,
    write: (value: number) => void,
    options: { readonly min?: number; readonly max?: number; readonly step?: number } = {},
  ): { readonly row: HTMLDivElement; readonly field: NumberFieldHandle } {
    const field = createNumberField({
      value: read(),
      min: options.min,
      max: options.max,
      step: options.step,
    });
    field.onInput((value) => {
      if (value === null) return;
      write(value);
    });
    field.onCommit((value) => {
      if (value === null) field.write(read());
    });
    const { row } = createNumberRow(label, field);
    parent.append(row);
    this.bindings.push({ kind: 'number', field, read });
    this.fieldDisposers.push(() => field.dispose());
    return { row, field };
  }

  /** 颜色行：原生 `<input type="color">`（与侧栏颜色字段同一件），即时写补丁 */
  private addColorRow(
    parent: HTMLElement,
    label: string,
    read: () => string,
    write: (value: string) => void,
  ): { readonly row: HTMLDivElement; readonly input: HTMLInputElement } {
    const input = create_element({ tag: 'input' }, { class: 'page-color-input', type: 'color' });
    input.id = nextWidgetId('page-style-color');
    input.value = safeColor(read());
    input.addEventListener('input', () => write(safeColor(input.value)));
    const row = createRow(createFieldLabel(label, input.id), input);
    parent.append(row);
    this.bindings.push({ kind: 'color', input, read });
    return { row, input };
  }

  /** 开关行：切换即写补丁（状态在 layout 里，控件本身只是显示） */
  private addSwitchRow(
    parent: HTMLElement,
    label: string,
    read: () => boolean,
    write: (value: boolean) => void,
  ): SwitchHandle {
    const handle = createSwitch({ value: read() });
    handle.onChange((value) => write(value));
    parent.append(createSwitchRow(label, handle));
    this.bindings.push({ kind: 'switch', handle, read });
    this.fieldDisposers.push(() => handle.dispose());
    return handle;
  }

  /* =========================== 刷新 =========================== */

  /** 一次刷新：左列激活态/色块、字段值、字段可用性 */
  private refresh(): void {
    this.refreshSelection();
    this.refreshValues();
    this.refreshStructure();
  }

  /** 左列：激活项用 accent 底/描边（与侧栏元素列表同一视觉词汇），色块取该分类当前颜色 */
  private refreshSelection(): void {
    for (const [category, entry] of this.categoryEntries) {
      const active = category === this.selected;
      entry.button.classList.toggle('is-active', active);
      entry.button.setAttribute('aria-pressed', String(active));
      entry.swatch.style.background = safeColor(
        readTextCategoryStyle(this.getLayout(), this.getGeo(), category).color,
      );
    }
  }

  /** 字段值：就地写回未聚焦的控件（聚焦中的输入框保持用户文本，避免打断输入） */
  private refreshValues(): void {
    const active = this.overlay.ownerDocument.activeElement;
    for (const binding of this.bindings) {
      switch (binding.kind) {
        case 'number': {
          if (active === binding.field.input) break;
          const value = binding.read();
          if (Number.isFinite(value)) binding.field.write(value);
          break;
        }
        case 'color': {
          if (active === binding.input) break;
          binding.input.value = safeColor(binding.read());
          break;
        }
        case 'switch': {
          if (active === binding.handle.input) break;
          const value = binding.read();
          if (binding.handle.get() !== value) binding.handle.set(value);
          break;
        }
        case 'segmented': {
          const value = binding.read();
          if (binding.handle.get() !== value) binding.handle.set(value);
          break;
        }
      }
    }
  }

  /** 结构可用性：光晕关闭时禁用光晕颜色/宽度（字号行地图/页面同构，无显隐差异） */
  private refreshStructure(): void {
    const haloDisabled = this.readStyle().halo === null;
    for (const row of this.haloRows) row.classList.toggle('is-disabled', haloDisabled);
    if (this.haloColorInput !== null) this.haloColorInput.disabled = haloDisabled;
    if (this.haloWidthField !== null) this.haloWidthField.input.disabled = haloDisabled;
  }

  /* =========================== 补丁出口与小工具 =========================== */

  /** 应用单字段补丁：交宿主落 layout/重绘，然后就地刷新本窗口（含结构变化） */
  private apply(patch: TextStylePatch): void {
    this.deps.onApply(this.selected, patch);
    this.refresh();
  }

  private getLayout(): PageLayout {
    return this.deps.getLayout();
  }

  private getGeo(): Geo {
    return this.deps.getGeo();
  }

  private readStyle(): ResolvedTextStyle {
    return readTextCategoryStyle(this.getLayout(), this.getGeo(), this.selected);
  }

  /** 光晕打开时的默认值：地图分类跟 `MAP_LABEL_STYLE`，页面分类跟 `TEXT_HALO` */
  private defaultHalo(): Halo {
    return TEXT_STYLE_CATEGORY_META[this.selected].kind === 'map'
      ? { color: MAP_LABEL_STYLE.halo_color, width_pt: MAP_LABEL_STYLE.halo_width_pt }
      : { color: TEXT_HALO.color, width_pt: TEXT_HALO.width_pt };
  }

  /** 释放上一批字段控件（重建/destroy 前调用）：先解绑控件，再清空登记 */
  private disposeFields(): void {
    for (const dispose of this.fieldDisposers) dispose();
    this.fieldDisposers = [];
    this.bindings = [];
  }

  /** Esc 关闭；capture 阶段拦截，避免同一次按键再触发画布快捷键（与确认框同做法） */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    this.close();
  };
}
