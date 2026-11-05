/**
 * 出版排版编辑器的右侧属性面板(编排层).
 *
 * 是什么:持有面板外壳与侧栏本地状态(隐藏图例条目,文字编辑框,派生高度读数),
 * 在 `sync()` 里驱动四块面板刷新;具体控件构建拆在 `page-panel-*` / `page-fields-*` 模块,
 * 控件登记与刷新在 `page-sidebar-controls.ts`,两者之间的契约是 `SidebarContext`.
 * 为什么这样组织:所有控件都只是「读最新 layout -> 写回 mutator」的薄封装,真正的状态在
 * `app/page-editor.ts`;面板在每次 sync 时只刷新「未聚焦」的控件,所以拖动/输入时不会打断
 * 用户正在编辑的输入框.元素列表与属性面板按选中 id 重建,避免控件状态漂移.
 * 已知限制:契约 §4.1 的图例条目没有 visible 字段,因此「隐藏条目」= 从 layout 中移除,
 * 仅在本会话的侧栏里记住,重新显示时按原位置插回(不会写进 layout).
 * 元信息:作者 ToyosatomiminoMiko,2026-11-05.
 */

import { create_element, createButton, createPanel } from 'miko_ui';
import {
  itemById,
  itemKindLabel,
  itemSummary,
  type Geo,
  type LegendEntry,
  type PageItem,
  type PageLayout,
} from '../core/page';
import { buildColorbarFields } from './page-fields-colorbar';
import { buildCommonItemFields } from './page-fields-common';
import { buildLegendFields } from './page-fields-legend';
import { buildTextFields } from './page-fields-text';
import { buildMapPanel } from './page-panel-map';
import { buildPaperPanel } from './page-panel-paper';
import { SidebarControlRegistry } from './page-sidebar-controls';
import type { PageSidebarHandlers, SidebarContext } from './page-sidebar-context';

/** 侧栏面板 */
export class PageSidebar {
  private readonly hosts: PageSidebarHandlers;
  private readonly pageBody: HTMLElement;
  private readonly mapBody: HTMLElement;
  private readonly elementBody: HTMLElement;
  private readonly elementList: HTMLElement;
  private readonly propertyBody: HTMLElement;

  /** sync 时的最新 layout/geo;登记项的 read 闭包都从这里取最新值 */
  private layout: PageLayout;
  private geo: Geo;
  private selectedId: number | null = null;

  /** 当前已构建的属性面板签名(元素 id);变化时重建 */
  private propertyKey = '';
  /** 结构性变化(图例条目增删/显隐)后强制重建属性面板 */
  private forcePropertyRebuild = false;

  /** 控件登记表:key 前缀区分页面/地图/属性,属性面板重建时按前缀清理 */
  private readonly controls = new SidebarControlRegistry();

  /** 当前选中文字 item 的编辑框(双击画布后聚焦它) */
  private textEditor: HTMLTextAreaElement | null = null;
  /** 地图派生高度读数 */
  private mapHeightEl: HTMLElement | null = null;
  /** 元素计数读数 */
  private elementCountEl: HTMLElement | null = null;
  /** 会话内隐藏的图例条目:legend id -> 被移除的条目与原位置 */
  private readonly hiddenLegendEntries = new Map<number, { entry: LegendEntry; index: number }[]>();

  /** 面板模块与侧栏状态之间的唯一通道 */
  private readonly context: SidebarContext;

  constructor(host: HTMLElement, handlers: PageSidebarHandlers) {
    this.hosts = handlers;
    this.layout = handlers.getLayout();
    this.geo = handlers.getGeo();
    this.context = {
      handlers,
      controls: this.controls,
      getLayout: () => this.layout,
      getGeo: () => this.geo,
      getSelectedId: () => this.selectedId,
      setTextEditor: (input) => {
        this.textEditor = input;
      },
      setMapHeightEl: (el) => {
        this.mapHeightEl = el;
      },
      markPropertyRebuild: () => {
        this.forcePropertyRebuild = true;
      },
      requestPropertyRebuild: () => {
        this.forcePropertyRebuild = true;
        this.sync(this.layout, this.geo, this.selectedId);
      },
      hiddenLegendEntries: this.hiddenLegendEntries,
    };

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

    buildPaperPanel(this.pageBody, this.context);
    buildMapPanel(this.mapBody, this.context);
    this.sync(this.layout, this.geo, this.selectedId);
  }

  /* =========================== 外部同步 =========================== */

  /** 刷新整个侧栏:页面/地图控件值,元素列表,属性面板(按需重建) */
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

  /** 聚焦当前选中文字的编辑框(画布双击文字调用) */
  focusTextEditor(): void {
    const editor = this.textEditor;
    if (!editor) return;
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
    editor.scrollIntoView({ block: 'nearest' });
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
        // 行内的删除按钮自己处理,不再触发选中
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
        create_element({ tag: 'p' }, { class: 'page-hint' }, '还没有元素:用顶部「添加」新增.'),
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
    this.controls.clearRegistry('prop.');
    this.textEditor = null;
    const body = this.propertyBody;
    const item: PageItem | null =
      this.selectedId === null ? null : (itemById(this.layout, this.selectedId) ?? null);
    if (!item) {
      body.replaceChildren(
        create_element({ tag: 'p' }, { class: 'page-hint' }, '在画布或上方列表里选中一个元素.'),
      );
      return;
    }
    const fragments: HTMLElement[] = [];
    fragments.push(buildCommonItemFields(this.context, item));
    switch (item.kind) {
      case 'text':
        fragments.push(...buildTextFields(this.context, item));
        break;
      case 'legend':
        fragments.push(...buildLegendFields(this.context, item));
        break;
      case 'colorbar':
        fragments.push(...buildColorbarFields(this.context, item));
        break;
    }
    body.replaceChildren(...fragments);
  }

  /* =========================== 刷新 =========================== */

  /** 刷新地图派生高度读数与全部控件值(控件内部跳过聚焦中的输入框) */
  private refreshControls(): void {
    if (this.mapHeightEl) {
      const height = (this.layout.map.width_pt * this.geo.base.height_pt) / this.geo.base.width_pt;
      this.mapHeightEl.textContent = `地图高度(派生):${height.toFixed(1)}pt`;
    }
    this.controls.refreshControls();
  }
}

/** 供编辑器判断侧栏是否正在输入(Delete 键不应删元素) */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}
