/**
 * 出版排版编辑器的右侧属性面板。
 *
 * 是什么：页面（纸张/方向/宽高/页边距/重新排默认版式）、地图（摆放/图框/刻度）、
 * 元素列表、选中项属性（text / legend / colorbar 分支）、图例条目编辑。
 * 为什么这样组织：所有控件都只是「读当前 layout → 写回 mutator」的薄封装，真正的状态
 * 在 `app/page-editor.ts`；面板在每次 sync 时只刷新「未聚焦」的控件，所以拖动/输入时
 * 不会打断用户正在编辑的输入框。元素列表与属性面板按选中 id 重建，避免控件状态漂移。
 * 已知限制：契约 §4.1 的图例条目没有 visible 字段，因此「隐藏条目」= 从 layout 中移除，
 * 仅在本会话的侧栏里记住，重新显示时按原位置插回（不会写进 layout）。
 * 元信息：作者 frontend，2026-10-27。
 */

import {
  createButton,
  createControlGroup,
  create_element,
  createFieldLabel,
  createNumberField,
  createNumberRow,
  createPanel,
  createRow,
  createSegmented,
  createSwitch,
  createSwitchRow,
  nextWidgetId,
  type NumberFieldHandle,
  type SwitchHandle,
} from 'miko_ui';
import {
  PAGE_COLORBAR_HEIGHT_PT,
  PAGE_COLORBAR_WIDTH_PT,
  PAGE_DEFAULT_MARGIN_PT,
  PAGE_LEGEND_DEFAULTS,
  PAGE_NEW_LEGEND_WIDTH_PT,
  PAGE_PAPER_PRESETS,
  findPaperPreset,
  presetSize,
  type PaperOrientation,
  type PaperPresetId,
} from '../config/page';
import { PAGE_TEXT_STYLES, TEXT_HALO } from '../config/text-style';
import {
  itemById,
  itemKindLabel,
  itemSummary,
  type ColorbarItem,
  type Geo,
  type ItemSpace,
  type LegendEntry,
  type LegendItem,
  type PageItem,
  type PageLayout,
  type TextAnchor,
  type TextItem,
  type TextRole,
} from '../core/page';

/** 侧栏回调：编辑器负责把 mutator 应用到自己的 layout 并重绘/记脏 */
export interface PageSidebarHandlers {
  getLayout(): PageLayout;
  getGeo(): Geo;
  /** 应用一次修改：mutator 直接改入参 layout（编辑器随后重绘并同步侧栏） */
  onChange(mutate: (layout: PageLayout, geo: Geo) => void): void;
  onSelect(id: number | null): void;
  onDelete(id: number): void;
  /** 用给定页边距重新生成默认版式（由编辑器确认后替换 layout） */
  onRelayout(marginPt: number): void;
  /** 轻提示（状态行）：纸张改变时提醒「重新排默认版式」 */
  notify(message: string): void;
}

/** 数字输入登记项：sync 时把最新值写回未聚焦的输入框 */
interface NumberEntry {
  readonly field: NumberFieldHandle;
  readonly read: () => number;
}

/** 颜色输入登记项（原生 `<input type="color">`） */
interface ColorEntry {
  readonly input: HTMLInputElement;
  readonly read: () => string;
}

/** 文本输入/文本域登记项 */
interface TextEntry {
  readonly input: HTMLInputElement | HTMLTextAreaElement;
  readonly read: () => string;
}

/** 开关登记项 */
interface SwitchEntry {
  readonly handle: SwitchHandle;
  readonly read: () => boolean;
}

/** 分段控件登记项（用闭包隐藏泛型，sync 只关心「读值 → set」） */
interface SegmentedEntry {
  readonly read: () => string;
  readonly sync: (value: string) => void;
}

/** 新建图例条目的默认形状 */
function defaultLegendEntry(): LegendEntry {
  return {
    label: '新条目',
    shape: 'line',
    stroke: '#4a4a4a',
    width_pt: 1,
    dash: null,
    fill: null,
    opacity: 1,
    marker: null,
  };
}

/** 图例条目的中文形状名（UI 只用） */
const SHAPE_LABELS: Readonly<Record<LegendEntry['shape'], string>> = {
  line: '线',
  rect: '块',
  point: '点',
};

const ROLE_LABELS: Readonly<Record<TextRole, string>> = {
  title: '标题',
  subtitle: '副标题',
  label: '地名',
  annotation: '标注',
  note: '注记',
  source: '来源',
};

const ANCHOR_LABELS: Readonly<Record<TextAnchor, string>> = {
  start: '左',
  middle: '中',
  end: '右',
};

/**
 * 字重分段选项（四档，4 列）。
 * 为什么存字符串：`createSegmented` 的值域只接受 `string`，写回 `font_weight` 时再转数字；
 * 只暴露规格给出的四档，导入的 page 里其它合法字重（100..900）仍原样保留、不在此被改写。
 */
const FONT_WEIGHT_OPTIONS = [
  { value: '400', label: '常规' },
  { value: '500', label: '中等' },
  { value: '600', label: '半粗' },
  { value: '700', label: '粗' },
] as const;

/** 颜色值兜底：`<input type=color>` 只接受 #rrggbb */
const safeColor = (value: string): string => (/^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000');

/** 侧栏面板 */
export class PageSidebar {
  private readonly hosts: PageSidebarHandlers;
  private readonly pageBody: HTMLElement;
  private readonly mapBody: HTMLElement;
  private readonly elementBody: HTMLElement;
  private readonly elementList: HTMLElement;
  private readonly propertyBody: HTMLElement;

  /** sync 时的最新 layout/geo；登记项的 read 闭包都从这里取最新值 */
  private layout: PageLayout;
  private geo: Geo;
  private selectedId: number | null = null;

  /** 当前已构建的属性面板签名（元素 id）；变化时重建 */
  private propertyKey = '';
  /** 结构性变化（图例条目增删/显隐）后强制重建属性面板 */
  private forcePropertyRebuild = false;

  /** 控件登记表：key 前缀区分页面/地图/属性，属性面板重建时按前缀清理 */
  private readonly numbers = new Map<string, NumberEntry>();
  private readonly colors = new Map<string, ColorEntry>();
  private readonly texts = new Map<string, TextEntry>();
  private readonly switches = new Map<string, SwitchEntry>();
  private readonly segmenteds = new Map<string, SegmentedEntry>();

  /** 当前选中文字 item 的编辑框（双击画布后聚焦它） */
  private textEditor: HTMLTextAreaElement | null = null;
  /** 地图派生高度读数 */
  private mapHeightEl: HTMLElement | null = null;
  /** 元素计数读数 */
  private elementCountEl: HTMLElement | null = null;
  /** 上次「重新排默认版式」用的页边距（面板本地状态，不落 layout） */
  private marginPt = PAGE_DEFAULT_MARGIN_PT;
  /** 会话内隐藏的图例条目：legend id → 被移除的条目与原位置 */
  private readonly hiddenLegendEntries = new Map<number, { entry: LegendEntry; index: number }[]>();

  constructor(host: HTMLElement, handlers: PageSidebarHandlers) {
    this.hosts = handlers;
    this.layout = handlers.getLayout();
    this.geo = handlers.getGeo();

    const pagePanel = createPanel({ title: '页面', class: 'page-sidebar-panel' });
    this.pageBody = pagePanel.body;
    const mapPanel = createPanel({ title: '地图', class: 'page-sidebar-panel' });
    this.mapBody = mapPanel.body;
    const elementPanel = createPanel({ title: '元素', class: 'page-sidebar-panel' });
    this.elementBody = elementPanel.body;
    this.elementList = create_element({ tag: 'div' }, { class: 'page-element-list' });
    this.elementBody.append(this.elementList);
    const propertyPanel = createPanel({ title: '属性', class: 'page-sidebar-panel' });
    this.propertyBody = propertyPanel.body;

    host.append(pagePanel.element, mapPanel.element, elementPanel.element, propertyPanel.element);

    this.buildPagePanel();
    this.buildMapPanel();
    this.sync(this.layout, this.geo, this.selectedId);
  }

  /* =========================== 外部同步 =========================== */

  /** 刷新整个侧栏：页面/地图控件值、元素列表、属性面板（按需重建） */
  sync(layout: PageLayout, geo: Geo, selectedId: number | null): void {
    this.layout = layout;
    this.geo = geo;
    this.selectedId = selectedId;
    this.refreshControls();
    this.rebuildElementList();
    const key = selectedId === null ? '' : String(selectedId);
    if (key !== this.propertyKey || this.forcePropertyRebuild) {
      this.propertyKey = key;
      this.forcePropertyRebuild = false;
      this.rebuildPropertyPanel();
    }
    this.refreshControls();
  }

  /** 聚焦当前选中文字的编辑框（画布双击文字调用） */
  focusTextEditor(): void {
    const editor = this.textEditor;
    if (!editor) return;
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
    editor.scrollIntoView({ block: 'nearest' });
  }

  /* =========================== 页面面板 =========================== */

  private buildPagePanel(): void {
    const presetRow = create_element({ tag: 'div' }, { class: 'page-segmented-row' });
    const presetSegmented = createSegmented<PaperPresetId>({
      columns: 5,
      ariaLabel: '纸张预设',
      value: this.layout.paper.preset,
      items: [
        ...PAGE_PAPER_PRESETS.map((preset) => ({ value: preset.id, label: preset.label })),
        { value: 'Custom', label: '自定义' },
      ],
    });
    presetSegmented.onChange((id) => this.applyPaperPreset(id));
    this.registerSegmented(
      'page.preset',
      () => this.layout.paper.preset,
      (value) => presetSegmented.set(value as PaperPresetId),
    );
    presetRow.append(presetSegmented.element);
    this.pageBody.append(presetRow);

    const orientationSegmented = createSegmented<PaperOrientation>({
      columns: 2,
      ariaLabel: '纸张方向',
      value: this.layout.paper.orientation,
      items: [
        { value: 'portrait', label: '纵向' },
        { value: 'landscape', label: '横向' },
      ],
    });
    orientationSegmented.onChange((orientation) => this.applyOrientation(orientation));
    this.registerSegmented(
      'page.orientation',
      () => this.layout.paper.orientation,
      (value) => orientationSegmented.set(value as PaperOrientation),
    );
    this.pageBody.append(createControlGroup('方向', orientationSegmented.element));

    const sizeRow = create_element({ tag: 'div' }, { class: 'page-field-grid' });
    this.addNumberRow(
      sizeRow,
      'page.width',
      '宽（pt）',
      () => this.layout.paper.width_pt,
      (value) => this.setPaperSize('width_pt', value),
      { min: 50, max: 5000, step: 0.5, onCommit: () => this.notifyPaperChanged() },
    );
    this.addNumberRow(
      sizeRow,
      'page.height',
      '高（pt）',
      () => this.layout.paper.height_pt,
      (value) => this.setPaperSize('height_pt', value),
      { min: 50, max: 5000, step: 0.5, onCommit: () => this.notifyPaperChanged() },
    );
    this.pageBody.append(sizeRow);

    const marginRow = create_element({ tag: 'div' }, { class: 'page-field-grid' });
    this.addNumberRow(
      marginRow,
      'page.margin',
      '页边距（pt）',
      () => this.marginPt,
      (value) => {
        this.marginPt = Math.max(0, value);
      },
      { min: 0, max: 400, step: 1 },
    );
    this.pageBody.append(marginRow);

    const relayout = createButton({
      text: '重新排默认版式',
      title: '用当前页边距重新生成初始排版（会覆盖当前排版）',
      class: 'page-wide-button',
    });
    relayout.onClick(() => this.hosts.onRelayout(this.marginPt));
    this.pageBody.append(relayout.element);
    this.pageBody.append(
      create_element(
        { tag: 'p' },
        { class: 'page-hint' },
        '纸张尺寸与元素位置都以 pt 落盘；预览与导出的 final.svg 共用同一套排版公式。',
      ),
    );
  }

  private applyPaperPreset(id: PaperPresetId): void {
    this.hosts.onChange((layout) => {
      layout.paper.preset = id;
      if (id === 'Custom') return;
      const preset = findPaperPreset(id);
      if (!preset) return;
      const size = presetSize(preset, layout.paper.orientation);
      layout.paper.width_pt = size.width_pt;
      layout.paper.height_pt = size.height_pt;
    });
    this.notifyPaperChanged();
  }

  /** 纸张尺寸/方向改变后的统一提示：默认排版不会自动重排 */
  private notifyPaperChanged(): void {
    this.hosts.notify('纸张已改变：请点「重新排默认版式」或手动调整元素位置');
  }

  private applyOrientation(orientation: PaperOrientation): void {
    this.hosts.onChange((layout) => {
      const before = layout.paper.orientation;
      layout.paper.orientation = orientation;
      const preset = findPaperPreset(layout.paper.preset);
      if (preset) {
        const size = presetSize(preset, orientation);
        layout.paper.width_pt = size.width_pt;
        layout.paper.height_pt = size.height_pt;
      } else if (before !== orientation) {
        // 自定义尺寸没有「纵向原值」可查：按当前宽高交换，直观且可逆
        const width = layout.paper.width_pt;
        layout.paper.width_pt = layout.paper.height_pt;
        layout.paper.height_pt = width;
      }
    });
    this.notifyPaperChanged();
  }

  private setPaperSize(key: 'width_pt' | 'height_pt', value: number): void {
    this.hosts.onChange((layout) => {
      layout.paper[key] = value;
      // 手改尺寸后预设不再成立，统一记成 Custom（避免预设标签与数字不一致）
      layout.paper.preset = 'Custom';
    });
  }

  /* =========================== 地图面板 =========================== */

  private buildMapPanel(): void {
    const positionRow = create_element({ tag: 'div' }, { class: 'page-field-grid' });
    this.addNumberRow(
      positionRow,
      'map.x',
      'x（pt）',
      () => this.layout.map.x,
      (value) => this.hosts.onChange((layout) => (layout.map.x = value)),
      { step: 1 },
    );
    this.addNumberRow(
      positionRow,
      'map.y',
      'y（pt）',
      () => this.layout.map.y,
      (value) => this.hosts.onChange((layout) => (layout.map.y = value)),
      { step: 1 },
    );
    this.addNumberRow(
      positionRow,
      'map.width',
      '宽（pt）',
      () => this.layout.map.width_pt,
      (value) => this.hosts.onChange((layout) => (layout.map.width_pt = value)),
      { min: 2, step: 1 },
    );
    this.mapBody.append(positionRow);
    this.mapHeightEl = create_element({ tag: 'p' }, { class: 'page-hint' });
    this.mapBody.append(this.mapHeightEl);

    const frameRow = create_element({ tag: 'div' }, { class: 'page-field-grid' });
    this.addSwitchRow(
      frameRow,
      'map.frameShow',
      '显示图框',
      () => this.layout.frame.show,
      (value) => this.hosts.onChange((layout) => (layout.frame.show = value)),
    );
    this.addSwitchRow(
      frameRow,
      'map.frameTicks',
      '显示刻度',
      () => this.layout.frame.ticks,
      (value) => this.hosts.onChange((layout) => (layout.frame.ticks = value)),
    );
    this.mapBody.append(createControlGroup('图框', frameRow));

    const frameStyleRow = create_element({ tag: 'div' }, { class: 'page-field-grid' });
    this.addColorRow(
      frameStyleRow,
      'map.stroke',
      '图框颜色',
      () => this.layout.frame.stroke,
      (value) => this.hosts.onChange((layout) => (layout.frame.stroke = value)),
    );
    this.addNumberRow(
      frameStyleRow,
      'map.strokeWidth',
      '图框线宽',
      () => this.layout.frame.width_pt,
      (value) => this.hosts.onChange((layout) => (layout.frame.width_pt = value)),
      { min: 0, step: 0.1 },
    );
    this.addNumberRow(
      frameStyleRow,
      'map.tickLength',
      '刻度长',
      () => this.layout.frame.tick_length_pt,
      (value) => this.hosts.onChange((layout) => (layout.frame.tick_length_pt = value)),
      { min: 0, step: 0.5 },
    );
    this.addNumberRow(
      frameStyleRow,
      'map.tickFont',
      '刻度字号',
      () => this.layout.frame.tick_font_size_pt,
      (value) => this.hosts.onChange((layout) => (layout.frame.tick_font_size_pt = value)),
      { min: 1, step: 0.5 },
    );
    this.addNumberRow(
      frameStyleRow,
      'map.tickGap',
      '刻度间距',
      () => this.layout.frame.tick_gap_pt,
      (value) => this.hosts.onChange((layout) => (layout.frame.tick_gap_pt = value)),
      { min: 0, step: 0.5 },
    );
    this.addColorRow(
      frameStyleRow,
      'map.tickColor',
      '刻度颜色',
      () => this.layout.frame.tick_color,
      (value) => this.hosts.onChange((layout) => (layout.frame.tick_color = value)),
    );
    this.mapBody.append(createControlGroup('样式', frameStyleRow));
  }

  /* =========================== 元素列表 =========================== */

  private rebuildElementList(): void {
    const rows: HTMLElement[] = [];
    for (const item of this.layout.items) {
      const row = create_element(
        { tag: 'div' },
        {
          class: 'page-element-row',
          role: 'button',
          tabindex: '0',
          'aria-pressed': item.id === this.selectedId ? 'true' : 'false',
        },
      );
      if (item.id === this.selectedId) row.classList.add('is-active');
      row.append(
        create_element({ tag: 'span' }, { class: 'page-element-kind' }, itemKindLabel(item)),
        create_element({ tag: 'span' }, { class: 'page-element-summary' }, itemSummary(item)),
      );
      const remove = createButton({
        text: '×',
        title: `删除 #${item.id}`,
        class: 'page-icon-button',
      });
      remove.onClick(() => this.hosts.onDelete(item.id));
      row.append(remove.element);

      row.addEventListener('click', (event) => {
        // 行内的删除按钮自己处理，不再触发选中
        if (event.target instanceof Element && event.target.closest('button') !== null) return;
        this.hosts.onSelect(item.id);
      });
      row.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        this.hosts.onSelect(item.id);
      });
      rows.push(row);
    }
    if (rows.length === 0) {
      rows.push(
        create_element({ tag: 'p' }, { class: 'page-hint' }, '还没有元素：用顶部「添加」新增。'),
      );
    }
    this.elementCountEl?.remove();
    this.elementCountEl = create_element(
      { tag: 'p' },
      { class: 'page-hint' },
      `共 ${this.layout.items.length} 个元素`,
    );
    this.elementList.replaceChildren(...rows, this.elementCountEl);
  }

  /* =========================== 属性面板 =========================== */

  private rebuildPropertyPanel(): void {
    this.clearRegistry('prop.');
    this.textEditor = null;
    const body = this.propertyBody;
    const item = this.selectedId === null ? null : itemById(this.layout, this.selectedId);
    if (!item) {
      body.replaceChildren(
        create_element({ tag: 'p' }, { class: 'page-hint' }, '在画布或上方列表里选中一个元素。'),
      );
      return;
    }
    const fragments: HTMLElement[] = [];
    fragments.push(this.buildCommonItemFields(item));
    switch (item.kind) {
      case 'text':
        fragments.push(...this.buildTextFields(item));
        break;
      case 'legend':
        fragments.push(...this.buildLegendFields(item));
        break;
      case 'colorbar':
        fragments.push(...this.buildColorbarFields(item));
        break;
    }
    body.replaceChildren(...fragments);
  }

  /** 所有元素共有的「坐标空间 + x/y」字段（map 空间写回底图坐标） */
  private buildCommonItemFields(item: PageItem): HTMLElement {
    const container = create_element({ tag: 'div' }, { class: 'page-field-grid' });
    const spaceSegmented = createSegmented<ItemSpace>({
      columns: 2,
      ariaLabel: '坐标空间',
      value: item.space,
      items: [
        { value: 'page', label: '纸张坐标' },
        { value: 'map', label: '底图坐标' },
      ],
    });
    spaceSegmented.onChange((space) =>
      this.hosts.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target) target.space = space;
      }),
    );
    this.registerSegmented(
      'prop.space',
      () => itemById(this.layout, item.id)?.space ?? 'page',
      (value) => spaceSegmented.set(value as ItemSpace),
    );
    container.append(createControlGroup('坐标空间', spaceSegmented.element));

    const positionRow = create_element({ tag: 'div' }, { class: 'page-field-grid' });
    this.addNumberRow(
      positionRow,
      'prop.x',
      item.space === 'map' ? 'x（底图）' : 'x（pt）',
      () => itemById(this.layout, item.id)?.x ?? 0,
      (value) =>
        this.hosts.onChange((layout) => {
          const target = itemById(layout, item.id);
          if (target) target.x = value;
        }),
      { step: 1 },
    );
    this.addNumberRow(
      positionRow,
      'prop.y',
      item.space === 'map' ? 'y（底图）' : 'y（pt）',
      () => itemById(this.layout, item.id)?.y ?? 0,
      (value) =>
        this.hosts.onChange((layout) => {
          const target = itemById(layout, item.id);
          if (target) target.y = value;
        }),
      { step: 1 },
    );
    container.append(positionRow);
    return container;
  }

  private buildTextFields(item: TextItem): HTMLElement[] {
    const fragments: HTMLElement[] = [];

    const textArea = create_element({ tag: 'textarea' }, { class: 'page-textarea' });
    textArea.value = item.lines.join('\n');
    textArea.rows = 4;
    textArea.id = nextWidgetId('page-text');
    textArea.addEventListener('input', () => {
      const lines = textArea.value.split('\n');
      this.hosts.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target?.kind !== 'text') return;
        target.lines = lines;
      });
    });
    this.textEditor = textArea;
    this.registerText('prop.lines', textArea, () => {
      const target = itemById(this.layout, item.id);
      return target?.kind === 'text' ? target.lines.join('\n') : '';
    });
    const textRow = createRow(createFieldLabel('内容', textArea.id), textArea);
    textRow.classList.add('page-text-row');
    fragments.push(textRow);

    const roleSegmented = createSegmented<TextRole>({
      columns: 3,
      ariaLabel: '文字角色',
      value: item.role,
      items: (Object.keys(ROLE_LABELS) as TextRole[]).map((role) => ({
        value: role,
        label: ROLE_LABELS[role],
      })),
    });
    roleSegmented.onChange((role) =>
      this.hosts.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target?.kind === 'text') target.role = role;
      }),
    );
    this.registerSegmented(
      'prop.role',
      () => {
        const target = itemById(this.layout, item.id);
        return target?.kind === 'text' ? target.role : 'annotation';
      },
      (value) => roleSegmented.set(value as TextRole),
    );
    fragments.push(createControlGroup('角色', roleSegmented.element));

    const styleRow = create_element({ tag: 'div' }, { class: 'page-field-grid' });
    this.addNumberRow(
      styleRow,
      'prop.fontSize',
      '字号（pt）',
      () => {
        const target = itemById(this.layout, item.id);
        return target?.kind === 'text' ? target.font_size_pt : 12;
      },
      (value) =>
        this.hosts.onChange((layout) => {
          const target = itemById(layout, item.id);
          if (target?.kind === 'text') target.font_size_pt = value;
        }),
      { min: 0.5, step: 0.5 },
    );
    this.addNumberRow(
      styleRow,
      'prop.lineHeight',
      '行高（倍数）',
      () => {
        const target = itemById(this.layout, item.id);
        return target?.kind === 'text'
          ? target.line_height
          : PAGE_TEXT_STYLES.annotation.line_height;
      },
      (value) =>
        this.hosts.onChange((layout) => {
          const target = itemById(layout, item.id);
          if (target?.kind === 'text') target.line_height = value;
        }),
      { min: 0.5, step: 0.05 },
    );
    this.addNumberRow(
      styleRow,
      'prop.letterSpacing',
      '字距（em）',
      () => {
        const target = itemById(this.layout, item.id);
        return target?.kind === 'text'
          ? target.letter_spacing_em
          : PAGE_TEXT_STYLES.annotation.letter_spacing_em;
      },
      (value) =>
        this.hosts.onChange((layout) => {
          const target = itemById(layout, item.id);
          if (target?.kind === 'text') target.letter_spacing_em = value;
        }),
      { min: -0.5, step: 0.01 },
    );
    this.addNumberRow(
      styleRow,
      'prop.rotation',
      '旋转（°）',
      () => {
        const target = itemById(this.layout, item.id);
        return target?.kind === 'text' ? target.rotation_deg : 0;
      },
      (value) =>
        this.hosts.onChange((layout) => {
          const target = itemById(layout, item.id);
          if (target?.kind === 'text') target.rotation_deg = value;
        }),
      { step: 1 },
    );
    this.addColorRow(
      styleRow,
      'prop.textColor',
      '文字颜色',
      () => {
        const target = itemById(this.layout, item.id);
        return target?.kind === 'text' ? target.color : PAGE_TEXT_STYLES.annotation.color;
      },
      (value) =>
        this.hosts.onChange((layout) => {
          const target = itemById(layout, item.id);
          if (target?.kind === 'text') target.color = value;
        }),
    );
    fragments.push(createControlGroup('文字', styleRow));

    const anchorSegmented = createSegmented<TextAnchor>({
      columns: 3,
      ariaLabel: '对齐',
      value: item.anchor,
      items: (Object.keys(ANCHOR_LABELS) as TextAnchor[]).map((anchor) => ({
        value: anchor,
        label: ANCHOR_LABELS[anchor],
      })),
    });
    anchorSegmented.onChange((anchor) =>
      this.hosts.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target?.kind === 'text') target.anchor = anchor;
      }),
    );
    this.registerSegmented(
      'prop.anchor',
      () => {
        const target = itemById(this.layout, item.id);
        return target?.kind === 'text' ? target.anchor : 'middle';
      },
      (value) => anchorSegmented.set(value as TextAnchor),
    );
    fragments.push(createControlGroup('对齐', anchorSegmented.element));

    const styleSwitches = create_element({ tag: 'div' }, { class: 'page-field-grid' });
    this.addSwitchRow(
      styleSwitches,
      'prop.italic',
      '斜体',
      () => {
        const target = itemById(this.layout, item.id);
        return target?.kind === 'text' ? target.italic : false;
      },
      (value) =>
        this.hosts.onChange((layout) => {
          const target = itemById(layout, item.id);
          if (target?.kind === 'text') target.italic = value;
        }),
    );
    this.addSwitchRow(
      styleSwitches,
      'prop.halo',
      '文字光晕',
      () => {
        const target = itemById(this.layout, item.id);
        return target?.kind === 'text' && target.halo !== null;
      },
      (value) =>
        this.hosts.onChange((layout) => {
          const target = itemById(layout, item.id);
          if (target?.kind !== 'text') return;
          target.halo = value ? { ...TEXT_HALO } : null;
        }),
    );
    this.addColorRow(
      styleSwitches,
      'prop.haloColor',
      '光晕颜色',
      () => {
        const target = itemById(this.layout, item.id);
        return target?.kind === 'text' && target.halo ? target.halo.color : TEXT_HALO.color;
      },
      (value) =>
        this.hosts.onChange((layout) => {
          const target = itemById(layout, item.id);
          if (target?.kind !== 'text') return;
          target.halo = { color: value, width_pt: target.halo?.width_pt ?? TEXT_HALO.width_pt };
        }),
    );
    this.addNumberRow(
      styleSwitches,
      'prop.haloWidth',
      '光晕宽度',
      () => {
        const target = itemById(this.layout, item.id);
        return target?.kind === 'text' && target.halo ? target.halo.width_pt : TEXT_HALO.width_pt;
      },
      (value) =>
        this.hosts.onChange((layout) => {
          const target = itemById(layout, item.id);
          if (target?.kind !== 'text') return;
          target.halo = { color: target.halo?.color ?? TEXT_HALO.color, width_pt: value };
        }),
      { min: 0, step: 0.5 },
    );
    const weightSegmented = createSegmented<string>({
      columns: 4,
      ariaLabel: '字重',
      value: String(item.font_weight),
      items: FONT_WEIGHT_OPTIONS,
    });
    weightSegmented.onChange((value) =>
      this.hosts.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target?.kind === 'text') target.font_weight = Number(value);
      }),
    );
    this.registerSegmented(
      'prop.fontWeight',
      () => {
        const target = itemById(this.layout, item.id);
        return target?.kind === 'text'
          ? String(target.font_weight)
          : String(PAGE_TEXT_STYLES.annotation.font_weight);
      },
      (value) => weightSegmented.set(value),
    );
    fragments.push(createControlGroup('字重', weightSegmented.element));
    fragments.push(createControlGroup('样式', styleSwitches));
    return fragments;
  }

  private buildLegendFields(item: LegendItem): HTMLElement[] {
    const fragments: HTMLElement[] = [];

    const basics = create_element({ tag: 'div' }, { class: 'page-field-grid' });
    this.addTextRow(
      basics,
      'prop.legendTitle',
      '标题',
      () => {
        const target = itemById(this.layout, item.id);
        return target?.kind === 'legend' ? target.title : '';
      },
      (value) =>
        this.hosts.onChange((layout) => {
          const target = itemById(layout, item.id);
          if (target?.kind === 'legend') target.title = value;
        }),
    );
    this.addNumberRow(
      basics,
      'prop.legendWidth',
      '宽度（pt）',
      () => {
        const target = itemById(this.layout, item.id);
        return target?.kind === 'legend' ? target.width_pt : PAGE_NEW_LEGEND_WIDTH_PT;
      },
      (value) =>
        this.hosts.onChange((layout) => {
          const target = itemById(layout, item.id);
          if (target?.kind === 'legend') target.width_pt = value;
        }),
      { min: 1, step: 1 },
    );
    this.addNumberRow(
      basics,
      'prop.legendFont',
      '字号（pt）',
      () => {
        const target = itemById(this.layout, item.id);
        return target?.kind === 'legend' ? target.font_size_pt : PAGE_LEGEND_DEFAULTS.font_size_pt;
      },
      (value) =>
        this.hosts.onChange((layout) => {
          const target = itemById(layout, item.id);
          if (target?.kind === 'legend') target.font_size_pt = value;
        }),
      { min: 0.5, step: 0.5 },
    );
    this.addNumberRow(
      basics,
      'prop.legendTitleSize',
      '标题字号',
      () => {
        const target = itemById(this.layout, item.id);
        return target?.kind === 'legend'
          ? target.title_size_pt
          : PAGE_LEGEND_DEFAULTS.title_size_pt;
      },
      (value) =>
        this.hosts.onChange((layout) => {
          const target = itemById(layout, item.id);
          if (target?.kind === 'legend') target.title_size_pt = value;
        }),
      { min: 0.5, step: 0.5 },
    );
    this.addNumberRow(
      basics,
      'prop.legendRowHeight',
      '行高（pt）',
      () => {
        const target = itemById(this.layout, item.id);
        return target?.kind === 'legend'
          ? target.row_height_pt
          : PAGE_LEGEND_DEFAULTS.row_height_pt;
      },
      (value) =>
        this.hosts.onChange((layout) => {
          const target = itemById(layout, item.id);
          if (target?.kind === 'legend') target.row_height_pt = value;
        }),
      { min: 1, step: 1 },
    );
    this.addNumberRow(
      basics,
      'prop.legendPadding',
      '内边距',
      () => {
        const target = itemById(this.layout, item.id);
        return target?.kind === 'legend' ? target.padding_pt : PAGE_LEGEND_DEFAULTS.padding_pt;
      },
      (value) =>
        this.hosts.onChange((layout) => {
          const target = itemById(layout, item.id);
          if (target?.kind === 'legend') target.padding_pt = value;
        }),
      { min: 0, step: 0.5 },
    );
    this.addNumberRow(
      basics,
      'prop.legendSwatch',
      '色块宽',
      () => {
        const target = itemById(this.layout, item.id);
        return target?.kind === 'legend'
          ? target.swatch_width_pt
          : PAGE_LEGEND_DEFAULTS.swatch_width_pt;
      },
      (value) =>
        this.hosts.onChange((layout) => {
          const target = itemById(layout, item.id);
          if (target?.kind === 'legend') target.swatch_width_pt = value;
        }),
      { min: 1, step: 1 },
    );
    this.addNumberRow(
      basics,
      'prop.legendGap',
      '色块间距',
      () => {
        const target = itemById(this.layout, item.id);
        return target?.kind === 'legend'
          ? target.swatch_gap_pt
          : PAGE_LEGEND_DEFAULTS.swatch_gap_pt;
      },
      (value) =>
        this.hosts.onChange((layout) => {
          const target = itemById(layout, item.id);
          if (target?.kind === 'legend') target.swatch_gap_pt = value;
        }),
      { min: 0, step: 1 },
    );
    fragments.push(createControlGroup('图例', basics));

    const frameRow = create_element({ tag: 'div' }, { class: 'page-field-grid' });
    this.addSwitchRow(
      frameRow,
      'prop.legendFrameShow',
      '显示外框',
      () => {
        const target = itemById(this.layout, item.id);
        return target?.kind === 'legend' ? target.frame.show : true;
      },
      (value) =>
        this.hosts.onChange((layout) => {
          const target = itemById(layout, item.id);
          if (target?.kind === 'legend') target.frame.show = value;
        }),
    );
    this.addColorRow(
      frameRow,
      'prop.legendFrameStroke',
      '外框颜色',
      () => {
        const target = itemById(this.layout, item.id);
        return target?.kind === 'legend' ? target.frame.stroke : '#bbbbbb';
      },
      (value) =>
        this.hosts.onChange((layout) => {
          const target = itemById(layout, item.id);
          if (target?.kind === 'legend') target.frame.stroke = value;
        }),
    );
    this.addColorRow(
      frameRow,
      'prop.legendFrameFill',
      '底色',
      () => {
        const target = itemById(this.layout, item.id);
        return target?.kind === 'legend' ? target.frame.fill : '#ffffff';
      },
      (value) =>
        this.hosts.onChange((layout) => {
          const target = itemById(layout, item.id);
          if (target?.kind === 'legend') target.frame.fill = value;
        }),
    );
    this.addNumberRow(
      frameRow,
      'prop.legendFrameWidth',
      '框线宽',
      () => {
        const target = itemById(this.layout, item.id);
        return target?.kind === 'legend' ? target.frame.width_pt : 0.8;
      },
      (value) =>
        this.hosts.onChange((layout) => {
          const target = itemById(layout, item.id);
          if (target?.kind === 'legend') target.frame.width_pt = value;
        }),
      { min: 0, step: 0.1 },
    );
    this.addNumberRow(
      frameRow,
      'prop.legendFrameOpacity',
      '底色透明度',
      () => {
        const target = itemById(this.layout, item.id);
        return target?.kind === 'legend' ? target.frame.opacity : 0.94;
      },
      (value) =>
        this.hosts.onChange((layout) => {
          const target = itemById(layout, item.id);
          if (target?.kind === 'legend') target.frame.opacity = value;
        }),
      { min: 0, max: 1, step: 0.01 },
    );
    fragments.push(createControlGroup('外框', frameRow));

    fragments.push(this.buildLegendEntries(item));
    return fragments;
  }

  /** 图例条目编辑：label / 显隐 / 删除 / 新增（隐藏 = 从 layout 移除，会话内记住） */
  private buildLegendEntries(item: LegendItem): HTMLElement {
    const container = create_element({ tag: 'div' }, { class: 'page-legend-entries' });
    const list = create_element({ tag: 'div' }, { class: 'page-legend-list' });
    const hidden = this.hiddenLegendEntries.get(item.id) ?? [];

    item.entries.forEach((entry, index) => {
      const row = create_element({ tag: 'div' }, { class: 'page-legend-row' });
      const input = create_element(
        { tag: 'input' },
        { class: 'page-legend-label', type: 'text', value: entry.label },
      );
      input.id = nextWidgetId('page-legend');
      input.addEventListener('input', () => {
        this.hosts.onChange((layout) => {
          const target = itemById(layout, item.id);
          if (target?.kind !== 'legend') return;
          const current = target.entries[index];
          if (current) current.label = input.value;
        });
      });
      this.registerText(`prop.entryLabel.${index}`, input, () => {
        const target = itemById(this.layout, item.id);
        return target?.kind === 'legend' ? (target.entries[index]?.label ?? '') : '';
      });
      row.append(
        create_element({ tag: 'span' }, { class: 'page-legend-shape' }, SHAPE_LABELS[entry.shape]),
        input,
      );

      const visible = createSwitch({ value: true });
      visible.input.title = '隐藏该条目（从 layout 移除，可再次显示）';
      visible.onChange(() => this.hideLegendEntry(item.id, index));
      row.append(visible.element);

      const remove = createButton({ text: '×', title: '删除条目', class: 'page-icon-button' });
      remove.onClick(() => this.deleteLegendEntry(item.id, index));
      row.append(remove.element);
      list.append(row);
    });

    hidden.forEach((stored, hiddenIndex) => {
      const row = create_element({ tag: 'div' }, { class: 'page-legend-row is-hidden' });
      row.append(
        create_element(
          { tag: 'span' },
          { class: 'page-legend-shape' },
          SHAPE_LABELS[stored.entry.shape],
        ),
        create_element({ tag: 'span' }, { class: 'page-legend-label' }, stored.entry.label),
      );
      const visible = createSwitch({ value: false });
      visible.input.title = '重新显示该条目';
      visible.onChange(() => this.showLegendEntry(item.id, hiddenIndex));
      row.append(visible.element);

      const remove = createButton({ text: '×', title: '删除隐藏条目', class: 'page-icon-button' });
      remove.onClick(() => {
        const entries = this.hiddenLegendEntries.get(item.id);
        if (!entries) return;
        entries.splice(hiddenIndex, 1);
        this.forcePropertyRebuild = true;
        this.sync(this.layout, this.geo, this.selectedId);
      });
      row.append(remove.element);
      list.append(row);
    });

    container.append(
      create_element(
        { tag: 'p' },
        { class: 'page-hint' },
        `条目按数组顺序绘制；契约没有 visible 字段，隐藏条目不会写进 layout。`,
      ),
      list,
    );

    const addButton = createButton({ text: '添加条目', title: '在末尾追加一个线型图例条目' });
    addButton.onClick(() => {
      this.forcePropertyRebuild = true;
      this.hosts.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target?.kind === 'legend') target.entries.push(defaultLegendEntry());
      });
    });
    container.append(addButton.element);
    return createControlGroup('条目', container);
  }

  private hideLegendEntry(legendId: number, index: number): void {
    this.forcePropertyRebuild = true;
    this.hosts.onChange((layout) => {
      const target = itemById(layout, legendId);
      if (target?.kind !== 'legend') return;
      const removed = target.entries.splice(index, 1)[0];
      if (!removed) return;
      const list = this.hiddenLegendEntries.get(legendId) ?? [];
      list.push({ entry: removed, index });
      list.sort((a, b) => a.index - b.index);
      this.hiddenLegendEntries.set(legendId, list);
    });
  }

  private showLegendEntry(legendId: number, hiddenIndex: number): void {
    this.forcePropertyRebuild = true;
    this.hosts.onChange((layout) => {
      const target = itemById(layout, legendId);
      if (target?.kind !== 'legend') return;
      const list = this.hiddenLegendEntries.get(legendId);
      const stored = list?.[hiddenIndex];
      if (!list || !stored) return;
      list.splice(hiddenIndex, 1);
      const insertAt = Math.min(stored.index, target.entries.length);
      target.entries.splice(insertAt, 0, stored.entry);
      if (list.length === 0) this.hiddenLegendEntries.delete(legendId);
    });
  }

  private deleteLegendEntry(legendId: number, index: number): void {
    this.forcePropertyRebuild = true;
    this.hosts.onChange((layout) => {
      const target = itemById(layout, legendId);
      if (target?.kind === 'legend') target.entries.splice(index, 1);
    });
  }

  private buildColorbarFields(item: ColorbarItem): HTMLElement[] {
    const fragments: HTMLElement[] = [];
    const basics = create_element({ tag: 'div' }, { class: 'page-field-grid' });
    this.addTextRow(
      basics,
      'prop.cbarTitle',
      '标题',
      () => {
        const target = itemById(this.layout, item.id);
        return target?.kind === 'colorbar' ? target.title : '';
      },
      (value) =>
        this.hosts.onChange((layout) => {
          const target = itemById(layout, item.id);
          if (target?.kind === 'colorbar') target.title = value;
        }),
    );
    this.addTextRow(
      basics,
      'prop.cbarUnit',
      '单位',
      () => {
        const target = itemById(this.layout, item.id);
        return target?.kind === 'colorbar' ? target.unit : '';
      },
      (value) =>
        this.hosts.onChange((layout) => {
          const target = itemById(layout, item.id);
          if (target?.kind === 'colorbar') target.unit = value;
        }),
    );
    this.addNumberRow(
      basics,
      'prop.cbarWidth',
      '宽（pt）',
      () => {
        const target = itemById(this.layout, item.id);
        return target?.kind === 'colorbar' ? target.width_pt : PAGE_COLORBAR_WIDTH_PT;
      },
      (value) =>
        this.hosts.onChange((layout) => {
          const target = itemById(layout, item.id);
          if (target?.kind === 'colorbar') target.width_pt = value;
        }),
      { min: 1, step: 1 },
    );
    this.addNumberRow(
      basics,
      'prop.cbarHeight',
      '高（pt）',
      () => {
        const target = itemById(this.layout, item.id);
        return target?.kind === 'colorbar' ? target.height_pt : PAGE_COLORBAR_HEIGHT_PT;
      },
      (value) =>
        this.hosts.onChange((layout) => {
          const target = itemById(layout, item.id);
          if (target?.kind === 'colorbar') target.height_pt = value;
        }),
      { min: 1, step: 1 },
    );
    this.addNumberRow(
      basics,
      'prop.cbarTitleSize',
      '标题字号',
      () => {
        const target = itemById(this.layout, item.id);
        return target?.kind === 'colorbar' ? target.title_size_pt : 8;
      },
      (value) =>
        this.hosts.onChange((layout) => {
          const target = itemById(layout, item.id);
          if (target?.kind === 'colorbar') target.title_size_pt = value;
        }),
      { min: 0.5, step: 0.5 },
    );
    this.addNumberRow(
      basics,
      'prop.cbarLabelSize',
      '刻度字号',
      () => {
        const target = itemById(this.layout, item.id);
        return target?.kind === 'colorbar' ? target.label_size_pt : 7;
      },
      (value) =>
        this.hosts.onChange((layout) => {
          const target = itemById(layout, item.id);
          if (target?.kind === 'colorbar') target.label_size_pt = value;
        }),
      { min: 0.5, step: 0.5 },
    );
    fragments.push(createControlGroup('色标', basics));

    const switches = create_element({ tag: 'div' }, { class: 'page-field-grid' });
    this.addSwitchRow(
      switches,
      'prop.cbarShowTitle',
      '显示标题',
      () => {
        const target = itemById(this.layout, item.id);
        return target?.kind === 'colorbar' ? target.show_title : true;
      },
      (value) =>
        this.hosts.onChange((layout) => {
          const target = itemById(layout, item.id);
          if (target?.kind === 'colorbar') target.show_title = value;
        }),
    );
    this.addSwitchRow(
      switches,
      'prop.cbarShowTicks',
      '显示刻度',
      () => {
        const target = itemById(this.layout, item.id);
        return target?.kind === 'colorbar' ? target.show_ticks : true;
      },
      (value) =>
        this.hosts.onChange((layout) => {
          const target = itemById(layout, item.id);
          if (target?.kind === 'colorbar') target.show_ticks = value;
        }),
    );
    fragments.push(createControlGroup('显示', switches));
    fragments.push(
      create_element(
        { tag: 'p' },
        { class: 'page-hint' },
        '配色与刻度来自 geo.relief，不落 layout。',
      ),
    );
    return fragments;
  }

  /* =========================== 控件工厂 =========================== */

  /** 数字行：输入即时写回；失焦时若文本为空则恢复当前值 */
  private addNumberRow(
    parent: HTMLElement,
    key: string,
    label: string,
    read: () => number,
    write: (value: number) => void,
    options: { min?: number; max?: number; step?: number; onCommit?: () => void } = {},
  ): void {
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
      else write(value);
      options.onCommit?.();
    });
    const { row } = createNumberRow(label, field);
    parent.append(row);
    this.numbers.set(key, { field, read });
  }

  /** 颜色行：原生 `<input type=color>`，输入即时写回 */
  private addColorRow(
    parent: HTMLElement,
    key: string,
    label: string,
    read: () => string,
    write: (value: string) => void,
  ): void {
    const input = create_element(
      { tag: 'input' },
      { class: 'page-color-input', type: 'color', value: safeColor(read()) },
    );
    input.id = nextWidgetId('page-color');
    input.addEventListener('input', () => write(safeColor(input.value)));
    parent.append(createRow(createFieldLabel(label, input.id), input));
    this.colors.set(key, { input, read });
  }

  /** 单行文本行 */
  private addTextRow(
    parent: HTMLElement,
    key: string,
    label: string,
    read: () => string,
    write: (value: string) => void,
  ): void {
    const input = create_element({ tag: 'input' }, { class: 'page-text-input', type: 'text' });
    input.id = nextWidgetId('page-text');
    input.value = read();
    input.addEventListener('input', () => write(input.value));
    parent.append(createRow(createFieldLabel(label, input.id), input));
    this.texts.set(key, { input, read });
  }

  /** 开关行 */
  private addSwitchRow(
    parent: HTMLElement,
    key: string,
    label: string,
    read: () => boolean,
    write: (value: boolean) => void,
  ): void {
    const handle = createSwitch({ value: read() });
    handle.onChange((value) => write(value));
    parent.append(createSwitchRow(label, handle));
    this.switches.set(key, { handle, read });
  }

  /** 分段控件登记（sync 时按 read 值 set） */
  private registerSegmented(key: string, read: () => string, sync: (value: string) => void): void {
    this.segmenteds.set(key, { read, sync });
  }

  /** 文本输入登记 */
  private registerText(
    key: string,
    input: HTMLInputElement | HTMLTextAreaElement,
    read: () => string,
  ): void {
    this.texts.set(key, { input, read });
  }

  /* =========================== 刷新 =========================== */

  /** 把最新值写回未聚焦的控件（聚焦中的控件保留用户正在输入的文本） */
  private refreshControls(): void {
    if (this.mapHeightEl) {
      const height = (this.layout.map.width_pt * this.geo.base.height_pt) / this.geo.base.width_pt;
      this.mapHeightEl.textContent = `地图高度（派生）：${height.toFixed(1)}pt`;
    }
    const active = document.activeElement;
    for (const entry of this.numbers.values()) {
      if (active === entry.field.input) continue;
      const value = entry.read();
      if (Number.isFinite(value)) entry.field.write(value);
    }
    for (const entry of this.colors.values()) {
      if (active === entry.input) continue;
      entry.input.value = safeColor(entry.read());
    }
    for (const entry of this.texts.values()) {
      if (active === entry.input) continue;
      const value = entry.read();
      if (entry.input.value !== value) entry.input.value = value;
    }
    for (const entry of this.switches.values()) {
      if (active === entry.handle.input) continue;
      const value = entry.read();
      if (entry.handle.get() !== value) entry.handle.set(value);
    }
    for (const entry of this.segmenteds.values()) {
      entry.sync(entry.read());
    }
  }

  /** 清掉某前缀的控件登记（属性面板重建前调用） */
  private clearRegistry(prefix: string): void {
    for (const key of [...this.numbers.keys()])
      if (key.startsWith(prefix)) this.numbers.delete(key);
    for (const key of [...this.colors.keys()]) if (key.startsWith(prefix)) this.colors.delete(key);
    for (const key of [...this.texts.keys()]) if (key.startsWith(prefix)) this.texts.delete(key);
    for (const key of [...this.switches.keys()])
      if (key.startsWith(prefix)) this.switches.delete(key);
    for (const key of [...this.segmenteds.keys()])
      if (key.startsWith(prefix)) this.segmenteds.delete(key);
  }
}

/** 供编辑器判断侧栏是否正在输入（Delete 键不应删元素） */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}
