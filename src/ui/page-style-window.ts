/**
 * 样式设置窗口:按「页面文字 / 地图标注」分类统一编辑文字样式.
 *
 * 是什么:独立模态窗口(遮罩 + 头部说明 + 两列正文).左列按 `config/text-style.ts` 的
 * `TEXT_STYLE_CATEGORY_GROUPS` 列出全部分类(语义小标题 + 名称 + 色块 + 元素数量徽标 +
 * 已改标记;地图分类在底图里没有该 role 时置灰但仍可选中并解释原因);右列顶部是固定的
 * 分类头(名称 / 类型 / 影响数量 / 默认或已改 / 示例 / 恢复默认 / 实时预览),下面是按
 * 四组重建的字段(字号 / 颜色与字形 / 行距与字距 / 描边光晕).
 * 为什么样式只在窗口里按分类改:样式是分类级覆盖(`page.text_style`),改一次由 core
 * 批量写回该分类下所有 item(`.work/STYLE-SETTINGS-SPEC.md` §0/§3).窗口只负责发
 * 「单字段补丁」与「恢复默认」,脏标记/重绘/侧栏同步全部由宿主的 onApply/onReset 完成;
 * 本模块不持有 layout,每次读都走 getLayout/getGeo 取最新值.
 * 字号口径:页面分类跟固定的代码默认字号;地图分类跟 `MAP_LABEL_ROLE_STYLES[role]` 的
 * 纸张 mm 设计常量(不随底图/纸张缩放),且同分类全部地名统一为窗口值.默认值不再用说明段落解释,而是每个数值字段旁的 reset 按钮:
 * 点它删掉该字段覆盖并恢复代码默认值(值已是默认时按钮禁用).
 * 左列数量徽标与右列「影响 N 个元素」都按 `itemsOfTextCategory` 的 item 数量算,
 * 保证窗口说的数字与实际会被改到的元素一致.
 * 刷新口径:选中分类切换 / 打开窗口 / 恢复默认时只重建右侧字段(分类头与预览是固定节点,
 * 避免恢复默认按钮随重建丢焦点);用户输入与外部 layout 变化(sync)只就地刷新值,分类头,
 * 左列徽标与预览,且跳过聚焦中的控件,避免打断正在输入的数字.光晕开关会改变光晕颜色/宽度的
 * 可用性,这类结构变化由 refreshStructure() 单独处理,不重建整块字段(重建会丢焦点).
 * 实时预览用 SVG 重画示例文字(与 `render/page-svg.ts` 同一套属性口径:halo 副本先画,
 * 填充副本后画),背景取纸张色(地图分类用浅色地图底),让字号/颜色/光晕的改动立刻可见.
 * 无障碍:模态 `role="dialog" aria-modal="true" aria-label="样式设置"`,头部总说明用
 * `aria-describedby` 关联;Esc / 点遮罩 / 头部「关闭」都能关闭(窗口不设底部操作条);打开时焦点进窗口,
 * 关闭时归还给打开前的焦点;左列按钮带 `aria-pressed` 与含数量/已改状态的 aria-label.
 * 元信息:作者 ToyosatomiminoMiko,2026-11-05.
 */

import {
  createBadge,
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
  create_svg_element,
  nextWidgetId,
  type ButtonHandle,
  type NumberFieldHandle,
  type SegmentedHandle,
  type SwitchHandle,
} from 'miko_ui';
import {
  MAP_LABEL_STYLE,
  TEXT_HALO,
  TEXT_STYLE_CATEGORY_GROUPS,
  TEXT_STYLE_CATEGORY_META,
  TEXT_STYLE_FONT_SIZE_MAX_MM,
  TEXT_STYLE_FONT_SIZE_STEP_MM,
  TEXT_STYLE_FONT_SIZE_UI_MIN_MM,
  TEXT_STYLE_HALO_WIDTH_MAX_MM,
  type MapLabelRole,
  type TextStyleCategoryId,
  type TextStyleCategoryKind,
  type TextStyleCategoryMeta,
} from '../config/text-style';
import { clampPageNumber } from '../core/page';
import type { Geo, Halo, PageLayout, TextItem } from '../core/page';
import { acquireModalGuard, releaseModalGuard } from './keyboard-guard';
import {
  defaultTextFontSizeMm,
  defaultTextStyleFields,
  itemsOfTextCategory,
  mapCategoryDefaultFontSizeMm,
  readTextCategoryStyle,
  type ResolvedTextStyle,
  type TextStylePatch,
  type TextStyleResetField,
} from '../core/text-style';

/** 窗口需要宿主注入的全部能力(布局/地图的最新值 + 补丁/恢复出口) */
export interface StyleSettingsWindowDeps {
  /** 宿主(挂 overlay;app 传 document.body) */
  readonly host: HTMLElement;
  readonly getLayout: () => PageLayout;
  readonly getGeo: () => Geo;
  /** 应用补丁(编辑器负责脏标记/重绘/侧栏同步) */
  readonly onApply: (category: TextStyleCategoryId, patch: TextStylePatch) => void;
  /** 恢复该分类默认样式 */
  readonly onReset: (category: TextStyleCategoryId) => void;
  /** 只恢复某个字段的默认值(数值字段旁的 reset 按钮) */
  readonly onResetField: (category: TextStyleCategoryId, field: TextStyleResetField) => void;
}

/** 分类列表里的一项:按钮本身 + 刷新时要改的色块/数量徽标/已改标记 */
interface CategoryEntry {
  readonly button: HTMLButtonElement;
  readonly swatch: HTMLElement;
  readonly count: HTMLElement;
  readonly changed: HTMLElement;
}

/** 右列固定分类头里需要随选中分类刷新的节点(重建设字段时不重建这些节点) */
interface CategoryHead {
  readonly element: HTMLElement;
  readonly name: HTMLElement;
  readonly kind: HTMLElement;
  readonly state: HTMLElement;
  readonly description: HTMLElement;
  readonly impact: HTMLElement;
  readonly example: HTMLElement;
  readonly empty: HTMLElement;
  readonly preview: HTMLElement;
  readonly reset: ButtonHandle;
}

/**
 * 字段值绑定:重建字段时登记,sync 时就地刷新用.
 * 为什么用判别联合而不是基类:四类控件的「读值 -> 写显示」只有几行差异,
 * 联合 + switch 在类型上就能保证每个分支都处理到(`switch-exhaustiveness-check`).
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

/** 字重分段选项:与侧栏改造前同一组四档(导入的其它合法字重原样保留,不在此改写) */
const FONT_WEIGHT_OPTIONS = [
  { value: '400', label: '常规' },
  { value: '500', label: '中等' },
  { value: '600', label: '半粗' },
  { value: '700', label: '粗' },
] as const;

/** 预览画布的用户坐标宽度(高度按内容动态撑开,缩放交给 preserveAspectRatio) */
const PREVIEW_WIDTH = 320;
/** 预览条最小高度(px):单行小字号时不至于显得空 */
const PREVIEW_MIN_HEIGHT = 72;

/** 颜色值兜底:`<input type="color">` 只接受 #rrggbb(与 `page-sidebar-controls.ts` 同口径) */
function safeColor(value: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000';
}

/** 预览里的数值属性:最多两位小数,避免 6.699999 这类浮点噪声进 SVG 属性 */
function previewNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/**
 * 数值字段旁的 reset 登记项:按钮,对应数字框,当前值/默认值读取器.
 * 禁用口径由 refreshResets 统一算:值已等于默认值,或该字段结构上不可改(光晕关闭时的宽度).
 */
interface ResetBinding {
  readonly field: TextStyleResetField;
  readonly label: string;
  readonly button: ButtonHandle;
  readonly input: NumberFieldHandle;
  readonly readCurrent: () => number;
  readonly readDefault: () => number;
  readonly isStructurallyDisabled?: () => boolean;
}

export class StyleSettingsWindow {
  private readonly deps: StyleSettingsWindowDeps;
  private readonly overlay: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly fieldsEl: HTMLElement;
  private readonly fieldsBodyEl: HTMLElement;
  private readonly head: CategoryHead;
  private readonly categoryEntries = new Map<TextStyleCategoryId, CategoryEntry>();

  /** 当前选中分类:默认第一个页面文字分类;关闭后保留,下次打开仍在原分类 */
  private selected: TextStyleCategoryId =
    TEXT_STYLE_CATEGORY_GROUPS[0]?.categories[0]?.id ?? 'title';
  private isOpen = false;
  /** 打开前的焦点元素:关闭时归还(元素可能已被移除,归还前判 isConnected) */
  private previousFocus: HTMLElement | null = null;

  /** 静态按钮的清理回调(关闭按钮/恢复默认),destroy 时统一释放 */
  private readonly disposers: (() => void)[] = [];
  /** 本次字段重建产生的控件清理回调(重建前先释放上一批) */
  private fieldDisposers: (() => void)[] = [];
  /** 字段值绑定(与 fieldDisposers 同生命周期) */
  private bindings: FieldBinding[] = [];
  /** 每个数值字段的 reset 登记项(重建字段时换掉,refresh 时更新可用态与提示) */
  private resets: ResetBinding[] = [];
  /** 光晕关闭时需要禁用的两个控件与其行 */
  private haloColorInput: HTMLInputElement | null = null;
  private haloWidthField: NumberFieldHandle | null = null;
  private haloRows: HTMLElement[] = [];

  constructor(deps: StyleSettingsWindowDeps) {
    this.deps = deps;

    // 遮罩 + 窗口骨架:类名是 styles-page.css 的消费契约
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
      title: '关闭样式设置(Esc)',
    });
    headerClose.onClick(() => this.close());
    header.append(title, headerClose.element);

    // 头部总说明:解释两组分类的区别 + 改动生效范围(对话框用 aria-describedby 关联它)
    const introId = nextWidgetId('page-style-intro');
    const intro = create_element({ tag: 'div' }, { class: 'page-style-intro', id: introId });
    intro.append(
      create_element(
        { tag: 'p' },
        { class: 'page-style-intro-lead' },
        '按分类统一设置文字样式;任何改动都会立即作用于该分类下的全部文字.',
      ),
      create_element(
        { tag: 'p' },
        { class: 'page-style-intro-detail' },
        '页面文字不在地图上,按文字角色分类;地图标注来自 Cartopy geo.json,按地名 role 分类.地图分类的字号默认值不是某条地名的字号,而是该 role 的纸张 mm 设计字号(固定值,不随底图或纸张缩放).',
      ),
    );
    this.panel.setAttribute('aria-describedby', introId);

    const body = create_element({ tag: 'div' }, { class: 'page-style-body' });
    this.listEl = create_element({ tag: 'div' }, { class: 'page-style-list' });
    this.fieldsEl = create_element({ tag: 'div' }, { class: 'page-style-fields' });
    this.head = this.buildCategoryHead();
    this.fieldsBodyEl = create_element({ tag: 'div' }, { class: 'page-style-fields-body' });
    this.fieldsEl.append(this.head.element, this.fieldsBodyEl);
    body.append(this.listEl, this.fieldsEl);

    // 关闭入口只保留头部按钮(另有 Esc 与点遮罩),窗口不设底部操作条
    this.panel.append(header, intro, body);
    this.overlay.append(this.panel);
    this.disposers.push(
      () => headerClose.dispose(),
      () => this.head.reset.dispose(),
    );

    this.buildCategoryList();
    // 点遮罩(不是面板内部)关闭:与确认框同一条判定
    this.overlay.addEventListener('click', (event) => {
      if (event.target === this.overlay) this.close();
    });
  }

  /* =========================== 对外生命周期 =========================== */

  /**
   * 打开窗口:可选直接定位到某个分类(侧栏「打开样式设置」带入当前 item 的分类).
   * 打开时总是重建字段,保证字段 kind 与选中分类一致;关闭期间选中项保留.
   */
  open(category?: TextStyleCategoryId): void {
    if (this.isOpen) {
      if (category !== undefined) this.select(category);
      return;
    }
    if (category !== undefined) this.selected = category;
    this.isOpen = true;
    acquireModalGuard();
    const active = this.overlay.ownerDocument.activeElement;
    this.previousFocus = active instanceof HTMLElement ? active : null;
    if (!this.overlay.isConnected) this.deps.host.append(this.overlay);
    this.overlay.hidden = false;
    this.rebuildFields();
    this.refresh();
    window.addEventListener('keydown', this.onKeyDown, true);
    this.panel.focus();
  }

  /** 关闭窗口:摘掉遮罩,解除 Esc,归还焦点;字段控件保留到下次重建/destroy */
  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    releaseModalGuard();
    window.removeEventListener('keydown', this.onKeyDown, true);
    this.overlay.hidden = true;
    this.overlay.remove();
    const previous = this.previousFocus;
    this.previousFocus = null;
    if (previous !== null && previous.isConnected) previous.focus();
  }

  /** 外部 layout 变化后刷新显示(可选调用;关闭状态下不读 layout,避免会话已销毁) */
  sync(): void {
    if (!this.isOpen) return;
    this.refresh();
  }

  /** 卸载:关闭,释放全部控件,移除 DOM(切换文档/页面卸载时调用) */
  destroy(): void {
    this.close();
    this.disposeFields();
    this.overlay.remove();
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
    this.categoryEntries.clear();
  }

  /* =========================== 左列:分类列表 =========================== */

  /** 按 config 的两组分类建左列;组内按 meta.section 切成语义小标题(不改变分类顺序) */
  private buildCategoryList(): void {
    const groups: HTMLElement[] = [];
    for (const group of TEXT_STYLE_CATEGORY_GROUPS) {
      const groupEl = create_element(
        { tag: 'section' },
        { class: 'page-style-group', 'aria-label': group.label },
      );
      groupEl.append(
        create_element({ tag: 'h3' }, { class: 'page-style-group-title' }, group.label),
        create_element({ tag: 'p' }, { class: 'page-style-group-desc' }, group.description),
      );
      let currentSection: string | null = null;
      let sectionEl: HTMLElement | null = null;
      for (const meta of group.categories) {
        if (meta.section !== currentSection) {
          currentSection = meta.section;
          sectionEl = create_element({ tag: 'div' }, { class: 'page-style-section' });
          sectionEl.append(
            create_element({ tag: 'h4' }, { class: 'page-style-section-title' }, meta.section),
          );
          groupEl.append(sectionEl);
        }
        const entry = this.buildCategoryButton(meta);
        sectionEl?.append(entry.button);
        this.categoryEntries.set(meta.id, entry);
      }
      groups.push(groupEl);
    }
    this.listEl.replaceChildren(...groups);
  }

  /** 一个分类按钮:色块 + 名称 + 已改标记 + 数量徽标(色彩与数量在 refreshList 里写) */
  private buildCategoryButton(meta: TextStyleCategoryMeta): CategoryEntry {
    const button = create_element(
      { tag: 'button' },
      {
        type: 'button',
        class: 'page-style-category',
        'aria-pressed': 'false',
        title: `${meta.label}:${meta.description}`,
      },
    );
    const swatch = create_element({ tag: 'span' }, { class: 'page-style-swatch' });
    const name = create_element({ tag: 'span' }, { class: 'page-style-category-name' }, meta.label);
    const changed = createBadge('已改', {
      class: 'page-style-badge page-style-changed',
    });
    changed.hidden = true;
    const count = createBadge('0', { class: 'page-style-badge page-style-count' });
    button.append(swatch, name, changed, count);
    button.addEventListener('click', () => this.select(meta.id));
    return { button, swatch, count, changed };
  }

  /** 切换分类:只重建右侧字段(分类头/预览是固定节点,滚动位置也重置到字段顶部) */
  private select(category: TextStyleCategoryId): void {
    if (category === this.selected) return;
    this.selected = category;
    this.rebuildFields();
    this.refresh();
    this.fieldsBodyEl.scrollTop = 0;
  }

  /**
   * 「恢复默认」:先让宿主删掉该分类覆盖,再按最新 layout 重建字段.
   * 恢复后该分类回到「默认」,分类头里的按钮会被禁用;浏览器在按钮变 disabled 的瞬间会把
   * 焦点丢回 body,所以这里先把焦点接回左列当前分类按钮,键盘用户不会丢失操作位置.
   */
  private resetSelected(): void {
    // 不在这里按「有无覆盖」提前返回:页面分类没有覆盖,但字号与固定默认值不同
    // (旧排版或旧文件)时按钮也是可用的,重置会回到固定默认字号;真正的不可用态由按钮 disabled 表达.
    const hadFocus = this.overlay.ownerDocument.activeElement === this.head.reset.element;
    this.deps.onReset(this.selected);
    this.rebuildFields();
    this.refresh();
    if (hadFocus) this.categoryEntries.get(this.selected)?.button.focus();
  }

  /* =========================== 右列:分类头与预览 =========================== */

  /**
   * 建右列顶部固定的分类头(只建一次).
   * 为什么固定不重建:恢复默认按钮在这里,它点击后要重建下面字段;若按钮本身也被重建,
   * 焦点会落到 body 上,键盘用户会丢失操作位置.
   */
  private buildCategoryHead(): CategoryHead {
    const element = create_element({ tag: 'header' }, { class: 'page-style-cat' });
    const name = create_element({ tag: 'h3' }, { class: 'page-style-cat-name' });
    const kind = createBadge('', { class: 'page-style-badge page-style-kind' });
    const state = createBadge('', { class: 'page-style-badge page-style-state' });
    const reset = createButton({
      text: '恢复默认值',
      class: 'page-style-reset',
      title: '把该分类的样式恢复为代码默认值',
    });
    reset.onClick(() => this.resetSelected());
    const titleRow = create_element({ tag: 'div' }, { class: 'page-style-cat-row' });
    titleRow.append(name, kind, state, reset.element);

    const description = create_element({ tag: 'p' }, { class: 'page-style-cat-desc' });
    const impact = create_element({ tag: 'span' }, { class: 'page-style-impact' });
    const example = create_element({ tag: 'span' }, { class: 'page-style-example' });
    const metaRow = create_element({ tag: 'div' }, { class: 'page-style-cat-meta' });
    metaRow.append(impact, example);
    const empty = create_element({ tag: 'p' }, { class: 'page-style-cat-empty', hidden: '' });

    const preview = create_element({ tag: 'div' }, { class: 'page-style-preview' });
    const previewWrap = create_element({ tag: 'div' }, { class: 'page-style-preview-wrap' });
    previewWrap.append(
      create_element({ tag: 'span' }, { class: 'page-style-preview-caption' }, '实时预览'),
      preview,
    );

    element.append(titleRow, description, metaRow, empty, previewWrap);
    return { element, name, kind, state, description, impact, example, empty, preview, reset };
  }

  /* =========================== 右列:字段 =========================== */

  /** 重建右侧字段:先释放上一批控件,再按分类 kind 声明四组字段 */
  private rebuildFields(): void {
    this.disposeFields();
    this.haloColorInput = null;
    this.haloWidthField = null;
    this.haloRows = [];

    const meta = TEXT_STYLE_CATEGORY_META[this.selected];
    this.fieldsBodyEl.replaceChildren(
      this.buildSizeSection(),
      this.buildTypeSection(),
      this.buildSpacingSection(),
      this.buildHaloSection(meta.kind),
    );
    this.refreshStructure();
  }

  /**
   * 「字号」组:数字行 + reset.
   * 地图分类的默认值是 role 表的纸张 mm 设计字号,不是某条地名的字号;
   * 页面分类的默认值是固定代码常量,不随纸张尺寸缩放.
   */
  private buildSizeSection(): HTMLElement {
    const grid = create_element({ tag: 'div' }, { class: 'page-field-grid' });
    this.addNumberRow(
      grid,
      '字号(mm)',
      () => this.readStyle().font_size_mm,
      (value) => this.apply({ font_size_mm: value }),
      {
        // 与 validateTextStyleOverride 共用同一份契约上限(见 config/text-style.ts):
        // UI 允许写入但校验拒绝的值会让整份 page 块在重开时回退默认版式.
        // 下限不能用契约下限 0.35:浏览器把 min 当步进基准,0.35 与 0.5 不同余会让方向键
        // 落在 0.35/0.85/1.35 上;UI 下限取 step 的整数倍(0.5,仍严于契约).
        min: TEXT_STYLE_FONT_SIZE_UI_MIN_MM,
        max: TEXT_STYLE_FONT_SIZE_MAX_MM,
        step: TEXT_STYLE_FONT_SIZE_STEP_MM,
        reset: { field: 'font_size_mm', readDefault: () => this.defaultFontSizeMm() },
      },
    );
    return createControlGroup('字号', grid);
  }

  /** 「颜色与字形」组:文字颜色 / 字重 / 斜体 */
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
    return createControlGroup('颜色与字形', grid);
  }

  /** 「行距与字距」组:行高倍数 / 字距 em */
  private buildSpacingSection(): HTMLElement {
    const grid = create_element({ tag: 'div' }, { class: 'page-field-grid' });
    this.addNumberRow(
      grid,
      '行高(倍数)',
      () => this.readStyle().line_height,
      (value) => this.apply({ line_height: value }),
      {
        min: 0.5,
        max: 5,
        step: 0.05,
        reset: {
          field: 'line_height',
          readDefault: () => defaultTextStyleFields(this.selected).line_height,
        },
      },
    );
    this.addNumberRow(
      grid,
      '字距(em)',
      () => this.readStyle().letter_spacing_em,
      (value) => this.apply({ letter_spacing_em: value }),
      {
        min: -1,
        max: 2,
        step: 0.01,
        reset: {
          field: 'letter_spacing_em',
          readDefault: () => defaultTextStyleFields(this.selected).letter_spacing_em,
        },
      },
    );
    return createControlGroup('行距与字距', grid);
  }

  /** 「描边(光晕)」组:开关 + 颜色 + 宽度;关闭时颜色/宽度禁用(避免在「无光晕」上写孤立值) */
  private buildHaloSection(kind: TextStyleCategoryKind): HTMLElement {
    const grid = create_element({ tag: 'div' }, { class: 'page-field-grid' });
    const hint =
      kind === 'map'
        ? '地图底图复杂,光晕(白色描边)用于让文字保持可读.'
        : '光晕(描边)用于让文字在复杂的底图或页面上保持可读.';
    grid.append(create_element({ tag: 'p' }, { class: 'page-style-hint' }, hint));
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
        this.apply({ halo: { color: value, width_mm: halo.width_mm } });
      },
    );
    const width = this.addNumberRow(
      grid,
      '光晕宽度(mm)',
      () => this.readStyle().halo?.width_mm ?? this.defaultHalo().width_mm,
      (value) => {
        const halo = this.readStyle().halo;
        if (halo === null) return;
        this.apply({ halo: { color: halo.color, width_mm: value } });
      },
      {
        // 覆盖口径是 0..7mm(config/text-style.ts 与 validateTextStyleHalo 同源);
        // 0 = 有光晕配置但不可见(item halo 允许 0,见 core/page.ts checkHalo).
        min: 0,
        max: TEXT_STYLE_HALO_WIDTH_MAX_MM,
        step: 0.1,
        reset: {
          field: 'halo_width_mm',
          readDefault: () => this.defaultHalo().width_mm,
          isStructurallyDisabled: () => this.readStyle().halo === null,
        },
      },
    );
    this.haloColorInput = color.input;
    this.haloWidthField = width.field;
    this.haloRows.push(color.row, width.row);
    return createControlGroup('描边(光晕)', grid);
  }

  /* =========================== 字段工厂 =========================== */

  /**
   * 数字行:input 阶段即时写补丁;提交时解析失败就把显示回退到 layout 里的最新值.
   * 给了 `reset` 就在数字框右侧挂一个 miko_ui 口径的 reset 按钮(与 Slider 的重置按钮同一件),
   * 点它只恢复该字段的代码默认值;按钮可用态在 refreshResets 里统一刷新.
   */
  private addNumberRow(
    parent: HTMLElement,
    label: string,
    read: () => number,
    write: (value: number) => void,
    options: {
      readonly min?: number;
      readonly max?: number;
      readonly step?: number;
      readonly reset?: {
        readonly field: TextStyleResetField;
        readonly readDefault: () => number;
        readonly isStructurallyDisabled?: () => boolean;
      };
    } = {},
  ): { readonly row: HTMLDivElement; readonly field: NumberFieldHandle } {
    const field = createNumberField({
      value: read(),
      min: options.min,
      max: options.max,
      step: options.step,
    });
    // 写入前夹取:min/max 只是 DOM 属性,浏览器不阻止键入越界值;layout 里出现
    // 校验会拒的值 -> 导出成功后重开整份排版回退默认(见 page-sidebar-controls.ts 注释).
    const clamp = (value: number): number => {
      if (options.min !== undefined && options.max !== undefined) {
        return clampPageNumber(value, options.min, options.max);
      }
      if (options.min !== undefined) return Math.max(options.min, value);
      if (options.max !== undefined) return Math.min(options.max, value);
      return value;
    };
    field.onInput((value) => {
      if (value === null) return;
      write(clamp(value));
    });
    field.onCommit((value) => {
      if (value === null) {
        field.write(read());
      } else {
        const clamped = clamp(value);
        write(clamped);
        // 提交时把显示改成实际生效值,用户能看到夹取结果(而不是留着越界文本).
        if (clamped !== value) field.write(clamped);
      }
    });
    const { row } = createNumberRow(label, field);
    if (options.reset !== undefined) {
      const reset = options.reset;
      const button = createButton({
        text: 'reset',
        class: 'slider-field-reset',
        title: `重置「${label}」为默认值`,
        ariaLabel: `重置「${label}」为默认值`,
      });
      button.onClick(() => this.resetField(button));
      row.append(button.element);
      this.resets.push({
        field: reset.field,
        label,
        button,
        input: field,
        readCurrent: read,
        readDefault: reset.readDefault,
        isStructurallyDisabled: reset.isStructurallyDisabled,
      });
      this.fieldDisposers.push(() => button.dispose());
    }
    parent.append(row);
    this.bindings.push({ kind: 'number', field, read });
    this.fieldDisposers.push(() => field.dispose());
    return { row, field };
  }

  /**
   * 点 reset:让宿主删掉该字段覆盖并重算该分类文字,然后刷新窗口.
   * 刷新后按钮通常变成禁用(值回到默认),浏览器会把焦点丢回 body;这里把焦点接回数字框,
   * 键盘用户不会丢失操作位置.
   */
  private resetField(button: ButtonHandle): void {
    const hadFocus = this.overlay.ownerDocument.activeElement === button.element;
    const binding = this.resets.find((item) => item.button === button);
    if (binding === undefined) return;
    this.deps.onResetField(this.selected, binding.field);
    this.refresh();
    if (hadFocus) binding.input.input.focus();
  }

  /** 颜色行:原生 `<input type="color">`(与侧栏颜色字段同一件),即时写补丁 */
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

  /** 开关行:切换即写补丁(状态在 layout 里,控件本身只是显示) */
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

  /** 一次刷新:左列徽标/选中态,分类头,字段值,字段可用性,reset 可用态,实时预览 */
  private refresh(): void {
    this.refreshList();
    this.refreshHead();
    this.refreshValues();
    this.refreshStructure();
    this.refreshResets();
    this.refreshPreview();
  }

  /**
   * 左列:激活态 / 色块 / 数量徽标 / 已改标记 / 地图分类 0 项置灰.
   * 地图分类在底图里没有该 role 时置灰(但不禁用:仍可选中并在右列看到原因);
   * 页面分类 0 项保持可用(之后还能新增该角色文字).
   */
  private refreshList(): void {
    const layout = this.getLayout();
    const geo = this.getGeo();
    for (const [category, entry] of this.categoryEntries) {
      const meta = TEXT_STYLE_CATEGORY_META[category];
      const active = category === this.selected;
      const style = readTextCategoryStyle(layout, geo, category);
      const itemCount = itemsOfTextCategory(layout, geo, category).length;
      const overridden = layout.text_style[category] !== undefined;
      const empty = meta.kind === 'map' && this.geoLabelCount(category) === 0;

      entry.button.classList.toggle('is-active', active);
      entry.button.classList.toggle('is-empty', empty);
      entry.button.setAttribute('aria-pressed', String(active));
      entry.swatch.style.background = safeColor(style.color);
      entry.count.textContent = String(itemCount);
      entry.changed.hidden = !overridden;
      entry.button.title = empty
        ? `${meta.label}:${meta.description}(该底图没有此分类,修改对当前图无效果)`
        : `${meta.label}:${meta.description}`;
      const spoken = [meta.label, `${itemCount} 个元素`];
      if (overridden) spoken.push('已改');
      if (empty) spoken.push('该底图没有此分类');
      entry.button.setAttribute('aria-label', spoken.join(','));
    }
  }

  /** 右列分类头:类型徽标,影响数量,默认/已改,示例,空分类原因,恢复默认可用性 */
  private refreshHead(): void {
    const meta = TEXT_STYLE_CATEGORY_META[this.selected];
    const layout = this.getLayout();
    const items = itemsOfTextCategory(layout, this.getGeo(), this.selected);
    const overridden = layout.text_style[this.selected] !== undefined;
    const paperSizeDiffers = !overridden && this.pageSizeDiffersFromDefault();

    this.head.name.textContent = meta.label;
    this.head.kind.textContent = meta.kind === 'map' ? '地图标注' : '页面文字';
    // 第三种状态「排版值」:用户没写覆盖,但当前字号与固定默认值不同(旧排版或旧文件).
    // 它不是「已改」,也不同于「默认」,明确标出来才解释得清恢复按钮为什么可用.
    this.head.state.textContent = overridden ? '已改' : paperSizeDiffers ? '排版值' : '默认';
    this.head.state.classList.toggle('is-changed', overridden);
    this.head.description.textContent = meta.description;
    this.head.impact.textContent = `影响 ${items.length} 个元素`;
    this.head.example.textContent = `示例:${this.exampleTextOf(meta, items)}`;

    const emptyReason = this.emptyReasonOf(meta, items.length);
    this.head.empty.hidden = emptyReason === null;
    this.head.empty.textContent = emptyReason ?? '';

    const canReset = overridden || paperSizeDiffers;
    this.head.reset.setDisabled(!canReset);
    this.head.reset.setText(`恢复「${meta.label}」默认值`);
    this.head.reset.element.title = canReset
      ? paperSizeDiffers
        ? `当前字号来自旧排版(与固定默认字号不同);恢复默认会回到代码固定值`
        : `把「${meta.label}」恢复为代码默认样式`
      : `「${meta.label}」当前就是默认样式,无需恢复`;
  }

  /**
   * 页面分类当前字号是否偏离固定默认字号.
   * 只用于恢复默认按钮是否可用:旧排版/旧文件里的 item 字号可能与当前固定默认值不同,
   * 此时没有覆盖,也应该允许用户一键回到默认字号.
   */
  private pageSizeDiffersFromDefault(): boolean {
    const meta = TEXT_STYLE_CATEGORY_META[this.selected];
    if (meta.kind !== 'page') return false;
    return (
      Math.abs(
        this.readStyle().font_size_mm - defaultTextFontSizeMm(this.selected, this.getLayout()),
      ) > 0.0005
    );
  }

  /** 字段值:就地写回未聚焦的控件(聚焦中的输入框保持用户文本,避免打断输入) */
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

  /** 结构可用性:光晕关闭时禁用光晕颜色/宽度 */
  private refreshStructure(): void {
    const haloDisabled = this.readStyle().halo === null;
    for (const row of this.haloRows) row.classList.toggle('is-disabled', haloDisabled);
    if (this.haloColorInput !== null) this.haloColorInput.disabled = haloDisabled;
    if (this.haloWidthField !== null) this.haloWidthField.input.disabled = haloDisabled;
  }

  /**
   * reset 可用态:值回到默认(或结构上不可改,如光晕关闭时的宽度)就禁用;
   * 标题写明会回到多少,点之前就能看到目标值.数值比较用 5e-4 容差:地图字号保留 1 位小数,
   * 行高/字距按 step 输入,浮点噪声不该让按钮在默认值附近乱闪.
   */
  private refreshResets(): void {
    for (const reset of this.resets) {
      const current = reset.readCurrent();
      const target = reset.readDefault();
      const atDefault = Math.abs(current - target) <= 5e-4;
      const disabled = atDefault || (reset.isStructurallyDisabled?.() ?? false);
      const targetText = previewNumber(target);
      reset.button.setDisabled(disabled);
      const text = disabled
        ? `「${reset.label}」已是默认值`
        : `重置「${reset.label}」为默认值 ${targetText}`;
      reset.button.element.title = text;
      reset.button.element.setAttribute('aria-label', text);
    }
  }

  /** 当前分类的默认字号(mm):页面分类固定常量;地图分类 = role 表纸张 mm 设计值 */
  private defaultFontSizeMm(): number {
    const meta = TEXT_STYLE_CATEGORY_META[this.selected];
    const layout = this.getLayout();
    if (meta.kind === 'map') {
      return mapCategoryDefaultFontSizeMm(this.selected as MapLabelRole);
    }
    return defaultTextFontSizeMm(this.selected, layout);
  }

  /** 实时预览:用当前分类样式重画示例文字(halo 副本先画,填充副本后画,与渲染层同口径) */
  private refreshPreview(): void {
    const meta = TEXT_STYLE_CATEGORY_META[this.selected];
    const layout = this.getLayout();
    const style = this.readStyle();
    const items = itemsOfTextCategory(layout, this.getGeo(), this.selected);
    const lines = this.previewLinesOf(meta, items);
    const fontSize = style.font_size_mm;
    const step = fontSize * Math.max(0.5, style.line_height);
    const blockHeight = step * (lines.length - 1) + fontSize;
    const viewHeight = Math.max(PREVIEW_MIN_HEIGHT, Math.ceil(blockHeight + 28));
    const firstBaseline = (viewHeight - blockHeight) / 2 + fontSize * 0.8;
    const halo = style.halo;

    const drawLine = (line: string, index: number, haloPass: boolean): SVGTextElement => {
      const attributes: Record<string, string> = {
        x: previewNumber(PREVIEW_WIDTH / 2),
        y: previewNumber(firstBaseline + index * step),
        'text-anchor': 'middle',
        'font-family': layout.style.font_family,
        'font-size': previewNumber(fontSize),
      };
      if (style.italic) attributes['font-style'] = 'italic';
      if (style.font_weight !== 400) attributes['font-weight'] = String(style.font_weight);
      if (style.letter_spacing_em !== 0) {
        attributes['letter-spacing'] = `${previewNumber(style.letter_spacing_em)}em`;
      }
      if (haloPass && halo !== null) {
        attributes.fill = halo.color;
        attributes.stroke = halo.color;
        attributes['stroke-width'] = previewNumber(halo.width_mm);
        attributes['paint-order'] = 'stroke';
      } else {
        attributes.fill = style.color;
      }
      return create_svg_element({ tag: 'text' }, attributes, line);
    };

    const nodes: SVGTextElement[] = [];
    if (halo !== null) {
      for (const [index, line] of lines.entries()) nodes.push(drawLine(line, index, true));
    }
    for (const [index, line] of lines.entries()) nodes.push(drawLine(line, index, false));

    const svg = create_svg_element(
      { tag: 'svg' },
      {
        class: 'page-style-preview-svg',
        viewBox: `0 0 ${PREVIEW_WIDTH} ${viewHeight}`,
        preserveAspectRatio: 'xMidYMid meet',
        'aria-hidden': 'true',
        focusable: 'false',
      },
    );
    svg.append(...nodes);
    this.head.preview.classList.toggle('is-map', meta.kind === 'map');
    // 页面文字用纸张色作预览底;地图分类的浅色地图底由 CSS 的 .is-map 给(与成品观感一致)
    this.head.preview.style.background = meta.kind === 'map' ? '' : layout.style.paper_color;
    this.head.preview.replaceChildren(svg);
  }

  /* =========================== 补丁出口与小工具 =========================== */

  /** 应用单字段补丁:交宿主落 layout/重绘,然后就地刷新本窗口(含结构变化) */
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

  /** 底图里该地图分类的地名条数(0 = 该底图没有这个分类,左列置灰的原因) */
  private geoLabelCount(category: TextStyleCategoryId): number {
    if (TEXT_STYLE_CATEGORY_META[category].kind !== 'map') return 0;
    return this.getGeo().labels.filter((label) => label.role === category).length;
  }

  /**
   * 右列「示例」文字:页面分类取第一条 item 的整段文字(多行用 / 分隔);地图分类取前 1~2 条
   * 地名的首行(用 · 分隔).没有 item 时退回 config 里的静态示例,避免示例行空着.
   */
  private exampleTextOf(meta: TextStyleCategoryMeta, items: readonly TextItem[]): string {
    if (items.length === 0) return meta.example;
    if (meta.kind === 'map') {
      const parts = items
        .slice(0, 2)
        .map((item) => item.lines[0] ?? '')
        .filter((line) => line.length > 0);
      return parts.length > 0 ? parts.join(' · ') : meta.example;
    }
    const first = items[0];
    if (first === undefined) return meta.example;
    const text = first.lines.join(' / ');
    return text.length > 0 ? text : meta.example;
  }

  /** 预览行:页面分类看第一条 item 的前两行;地图分类取前两条地名首行;都为空时用静态示例 */
  private previewLinesOf(meta: TextStyleCategoryMeta, items: readonly TextItem[]): string[] {
    const lines =
      meta.kind === 'map'
        ? items
            .slice(0, 2)
            .map((item) => item.lines[0] ?? '')
            .filter((line) => line.length > 0)
        : (items[0]?.lines.slice(0, 2) ?? []).filter((line) => line.length > 0);
    return lines.length > 0 ? lines : [meta.example];
  }

  /** 空分类原因(右列分类头里的一行说明);页面分类 0 项只提示,不置灰 */
  private emptyReasonOf(meta: TextStyleCategoryMeta, itemCount: number): string | null {
    if (meta.kind === 'map') {
      const labelCount = this.geoLabelCount(this.selected);
      if (labelCount === 0) {
        return `该底图没有「${meta.label}」地名,修改对当前图没有效果.`;
      }
      if (itemCount === 0) {
        return `当前排版里没有「${meta.label}」文字(可能已被删除),修改不会影响已有元素.`;
      }
      return null;
    }
    if (itemCount === 0) {
      return `当前排版里还没有「${meta.label}」文字,修改会在新增该分类文字时生效.`;
    }
    return null;
  }

  /** 光晕打开时的默认值:地图分类跟该分类的代码默认(角色表可覆盖宽度),页面分类跟 `TEXT_HALO` */
  private defaultHalo(): Halo {
    if (TEXT_STYLE_CATEGORY_META[this.selected].kind === 'map') {
      return (
        defaultTextStyleFields(this.selected).halo ?? {
          color: MAP_LABEL_STYLE.halo_color,
          width_mm: MAP_LABEL_STYLE.halo_width_mm,
        }
      );
    }
    return { color: TEXT_HALO.color, width_mm: TEXT_HALO.width_mm };
  }

  /** 释放上一批字段控件(重建/destroy 前调用):先解绑控件,再清空登记 */
  private disposeFields(): void {
    for (const dispose of this.fieldDisposers) dispose();
    this.fieldDisposers = [];
    this.bindings = [];
    this.resets = [];
  }

  /** Esc 关闭;capture 阶段拦截,避免同一次按键再触发画布快捷键(与确认框同做法) */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    this.close();
  };
}
