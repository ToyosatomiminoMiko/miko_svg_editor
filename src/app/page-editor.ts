/**
 * 出版排版编辑器的状态机：选择/拖拽/缩放/平移/脏标记/导出。
 *
 * 是什么：持有当前 `PageLayout`（唯一真值）与打开时的 `PageDocument`（底图字节 + geo），把画布
 * 指针/键盘手势翻译成对 layout 的修改，组织预览重绘与侧栏同步；导出两个文件——
 * `exportGeo()` 把 geo + page 写成 `<stem>.geo.json`（再次打开即可继续编辑），
 * `exportFinal()` 调 `render/compose-svg.ts` 在浏览器内合成 `<stem>.svg` 后下载。
 * 本文件不认识任何 HTTP 接口。
 * 为什么拖拽/缩放只改 layout 而不改底图：地理层只读（契约 §1），map 空间 item 的位置
 * 写回底图坐标；预览与成品共用 `core/page-layout.ts` 的同一套 §5 公式。
 * 缩放/平移通过根 `<svg>` 的 `viewBox` 实现；指针坐标转换统一走 `getScreenCTM().inverse()`，
 * 这样 letterbox（preserveAspectRatio）与设备像素比都不需要自己算。
 * 元信息：作者 frontend，2026-10-27；2026-10-28 改为无后端（上传文档 + 双导出）。
 */

import {
  PAGE_DEFAULT_MARGIN_PT,
  PAGE_FIT_PADDING_RATIO,
  PAGE_KEY_MOVE_LARGE_PT,
  PAGE_KEY_MOVE_PT,
  PAGE_LEGEND_DEFAULTS,
  PAGE_NEW_COLORBAR_HEIGHT_PT,
  PAGE_NEW_COLORBAR_WIDTH_PT,
  PAGE_NEW_LEGEND_WIDTH_PT,
  PAGE_WHEEL_ZOOM_SENSITIVITY,
  PAGE_ZOOM_MAX,
  PAGE_ZOOM_MIN,
} from '../config/page';
import { geoFileNameOf, finalFileNameOf, type PageDocument } from '../core/document';
import {
  allocateItemId,
  countItems,
  itemById,
  normalizePage,
  removeItem,
  roundToPageDecimals,
  serializeMapDocFile,
  type ColorbarItem,
  type Geo,
  type LegendItem,
  type PageLayout,
  type TextItem,
  type TextRole,
} from '../core/page';
import {
  defaultPageLayout,
  mapTransform,
  type DefaultPageLayoutOptions,
} from '../core/page-layout';
import { PAGE_TEXT_STYLES } from '../config/text-style';
import { formatPageNumber } from '../render/page-format';
import { composeFinalSvg, type ComposeReport } from '../render/compose-svg';
import { renderPageSvg } from '../render/page-svg';
import type { TextMeasure } from '../core/types';
import { downloadText } from '../ui/download';
import { isEditableTarget, type PageSidebar } from '../ui/page-sidebar';
import type { PageNotifier } from '../ui/page-notify';

/** JSON 导出的 MIME（浏览器据此识别 `<stem>.geo.json`） */
const GEO_MIME = 'application/json';
/** SVG 导出的 MIME */
const SVG_MIME = 'image/svg+xml';

/** 把异常转成可直接展示的一行中文 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 视图窗口（根 svg 的 viewBox） */
interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 画布手势：平移或拖拽元素 */
type Gesture =
  | {
      readonly kind: 'pan';
      readonly startClientX: number;
      readonly startClientY: number;
      readonly startView: ViewBox;
    }
  | {
      readonly kind: 'drag';
      readonly id: number;
      readonly startPageX: number;
      readonly startPageY: number;
      readonly originX: number;
      readonly originY: number;
      readonly space: 'page' | 'map';
    };

/** 编辑器依赖（全部由 `app/page-main.ts` 注入） */
export interface PageEditorDeps {
  /** 预览根 `<svg>`（viewBox 由编辑器维护） */
  readonly svg: SVGSVGElement;
  readonly sidebar: PageSidebar;
  readonly notifier: PageNotifier;
  /** 文本度量（宽度 + 字体行盒；canvas measureText/fontBoundingBox 适配器） */
  readonly measureText: TextMeasure;
  /** 打开的上传文档（底图字节/契约解析结果/规范化 geo） */
  readonly document: PageDocument;
  /** 底图预览的 objectURL（由组合根创建并在关闭时 revoke） */
  readonly baseUrl: string;
  readonly layout: PageLayout;
  /** 初次打开时 layout 是否来自 defaultPageLayout（尚未导出） */
  readonly dirty?: boolean;
}

/** 选中/拖拽/缩放/导出状态机 */
export class PageEditor {
  private readonly svg: SVGSVGElement;
  private readonly sidebar: PageSidebar;
  private readonly notifier: PageNotifier;
  private readonly measureText: TextMeasure;
  private readonly document: PageDocument;
  private readonly baseUrl: string;
  private readonly geo: Geo;
  private layout: PageLayout;

  private selectedId: number | null = null;
  private view: ViewBox = { x: 0, y: 0, w: 1, h: 1 };
  private dirty: boolean;
  private spaceDown = false;
  private gesture: Gesture | null = null;
  private started = false;

  constructor(deps: PageEditorDeps) {
    this.svg = deps.svg;
    this.sidebar = deps.sidebar;
    this.notifier = deps.notifier;
    this.measureText = deps.measureText;
    this.document = deps.document;
    this.baseUrl = deps.baseUrl;
    this.geo = deps.document.geo;
    this.layout = deps.layout;
    this.dirty = deps.dirty ?? false;

    this.svg.classList.add('page-canvas');
    this.svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    this.svg.setAttribute('role', 'img');
    this.svg.setAttribute('aria-label', '出版排版预览画布');
    // 画布可聚焦：空格平移/方向键微移只在焦点不落在输入控件时生效
    this.svg.setAttribute('tabindex', '0');
  }

  /* =========================== 生命周期 =========================== */

  /** 首次装配：适应页面、绑事件、渲染 */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.fitPage();
    this.renderAll();
    this.svg.addEventListener('pointerdown', this.onPointerDown);
    this.svg.addEventListener('pointermove', this.onPointerMove);
    this.svg.addEventListener('pointerup', this.onPointerUp);
    this.svg.addEventListener('pointercancel', this.onPointerUp);
    this.svg.addEventListener('wheel', this.onWheel, { passive: false });
    this.svg.addEventListener('dblclick', this.onDoubleClick);
    this.svg.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onWindowBlur);
    window.addEventListener('beforeunload', this.onBeforeUnload);
    this.updateChrome();
  }

  /**
   * 关闭当前文档：解绑所有 window/画布监听并清空根节点。
   * 为什么由组合根调用而不是自动：同一份外壳会被下一份上传文档复用，
   * 组合根要在 revoke 预览 objectURL 前先把编辑器停干净。
   */
  destroy(): void {
    if (!this.started) return;
    this.started = false;
    this.svg.removeEventListener('pointerdown', this.onPointerDown);
    this.svg.removeEventListener('pointermove', this.onPointerMove);
    this.svg.removeEventListener('pointerup', this.onPointerUp);
    this.svg.removeEventListener('pointercancel', this.onPointerUp);
    this.svg.removeEventListener('wheel', this.onWheel);
    this.svg.removeEventListener('dblclick', this.onDoubleClick);
    this.svg.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onWindowBlur);
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    this.gesture = null;
    this.spaceDown = false;
    this.svg.classList.remove('is-panning', 'is-dragging', 'is-pan-ready');
    this.svg.replaceChildren();
  }

  /** 当前 layout 的只读引用（page-main 装配侧栏需要） */
  get currentLayout(): PageLayout {
    return this.layout;
  }

  /* =========================== 修改入口 =========================== */

  /** 应用一次 layout 修改：mutator 直接改 layout，然后重绘/同步侧栏/记脏 */
  applyPageChange(mutate: (layout: PageLayout, geo: Geo) => void): void {
    mutate(this.layout, this.geo);
    this.dirty = true;
    this.renderAll();
  }

  /** 选中元素（null = 取消选中） */
  select(id: number | null): void {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.renderAll();
  }

  /** 删除一个元素 */
  deleteItem(id: number): void {
    if (itemById(this.layout, id) === null) return;
    if (this.selectedId === id) this.selectedId = null;
    this.applyPageChange((layout) => {
      removeItem(layout, id);
    });
  }

  /* =========================== 导出 =========================== */

  /**
   * 导出 `<stem>.geo.json`（Ctrl+S 的入口）：geo 全字段 + page 排版块，成功即清脏标记。
   * 为什么先 `normalizePage`：page 的数字口径必须是 3 位小数（与预览/签名一致）；
   * geo 块保持原精度（Cartopy 的 view_box 可能有 6 位小数），由 `serializeMapDocFile` 分别处理。
   */
  exportGeo(): boolean {
    const fileName = geoFileNameOf(this.document);
    try {
      const layout = normalizePage(this.layout);
      downloadText(serializeMapDocFile(this.geo, layout), fileName, GEO_MIME);
      this.dirty = false;
      this.updateChrome();
      this.notifier.info(`已导出 ${fileName}`);
      return true;
    } catch (error) {
      this.notifier.error(`导出 geo.json 失败：${errorMessage(error)}`);
      return false;
    }
  }

  /**
   * 导出 `final.svg`：浏览器内合成后下载，展示合成报告里的告警。
   * 为什么不清脏标记：导出 SVG 不改变排版数据，geo.json 仍可能没导出；
   * 是否「干净」以 geo.json 落盘为准。
   */
  exportFinal(): void {
    const fileName = finalFileNameOf(this.document);
    try {
      const result = composeFinalSvg(this.document, this.layout);
      downloadText(result.svg, fileName, SVG_MIME);
      this.reportWarnings(result.report);
      this.notifier.info(`已导出 ${fileName}（${result.report.counts.total} 个元素）`);
    } catch (error) {
      this.notifier.error(`导出 SVG 失败：${errorMessage(error)}`);
    }
  }

  /* =========================== 视图 =========================== */

  /** 适应页面：纸张四周留 4% 空白 */
  fitPage(): void {
    const pad =
      Math.max(this.layout.paper.width_pt, this.layout.paper.height_pt) * PAGE_FIT_PADDING_RATIO;
    this.view = {
      x: -pad,
      y: -pad,
      w: this.layout.paper.width_pt + pad * 2,
      h: this.layout.paper.height_pt + pad * 2,
    };
    this.applyView();
  }

  /** 1:1：1pt = 1 屏幕像素，以纸张中心为锚点 */
  actualSize(): void {
    const width = this.svg.clientWidth > 0 ? this.svg.clientWidth : this.layout.paper.width_pt;
    const height = this.svg.clientHeight > 0 ? this.svg.clientHeight : this.layout.paper.height_pt;
    this.view = {
      x: this.layout.paper.width_pt / 2 - width / 2,
      y: this.layout.paper.height_pt / 2 - height / 2,
      w: width,
      h: height,
    };
    this.applyView();
  }

  /* =========================== 添加元素 =========================== */

  /** 添加文字元素（role 决定默认位置/字号） */
  addText(role: TextRole): void {
    let newId = 0;
    this.applyPageChange((layout) => {
      newId = allocateItemId(layout);
      layout.items.push(this.newTextItem(layout, newId, role));
    });
    this.select(newId);
  }

  /** 添加标题模板 */
  addTitle(): void {
    this.addText('title');
  }

  /** 添加空图例（默认右栏顶部） */
  addLegend(): void {
    let newId = 0;
    this.applyPageChange((layout) => {
      newId = allocateItemId(layout);
      const paper = layout.paper;
      const margin = layout.map.x;
      const rightX = Math.min(
        Math.max(
          layout.map.x + layout.map.width_pt + 16,
          paper.width_pt - margin - PAGE_NEW_LEGEND_WIDTH_PT,
        ),
        paper.width_pt - margin - 20,
      );
      const width = Math.max(
        40,
        Math.min(PAGE_NEW_LEGEND_WIDTH_PT, paper.width_pt - margin - rightX),
      );
      const legend: LegendItem = {
        id: newId,
        kind: 'legend',
        space: 'page',
        x: rightX,
        y: layout.map.y,
        width_pt: width,
        title: '图例',
        entries: [],
        font_size_pt: PAGE_LEGEND_DEFAULTS.font_size_pt,
        title_size_pt: PAGE_LEGEND_DEFAULTS.title_size_pt,
        row_height_pt: PAGE_LEGEND_DEFAULTS.row_height_pt,
        padding_pt: PAGE_LEGEND_DEFAULTS.padding_pt,
        swatch_width_pt: PAGE_LEGEND_DEFAULTS.swatch_width_pt,
        swatch_gap_pt: PAGE_LEGEND_DEFAULTS.swatch_gap_pt,
        frame: {
          show: true,
          stroke: PAGE_LEGEND_DEFAULTS.frame_stroke,
          width_pt: PAGE_LEGEND_DEFAULTS.frame_width_pt,
          fill: PAGE_LEGEND_DEFAULTS.frame_fill,
          opacity: PAGE_LEGEND_DEFAULTS.frame_opacity,
        },
      };
      layout.items.push(legend);
    });
    this.select(newId);
  }

  /** 添加色标（配色/刻度来自 geo.relief；没有 relief 的 geo 不能加） */
  addColorbar(): void {
    const relief = this.geo.relief;
    if (relief === null) {
      this.notifier.error('该 geo.json 没有 relief 色标数据，无法添加色标');
      return;
    }
    let newId = 0;
    this.applyPageChange((layout) => {
      newId = allocateItemId(layout);
      const paper = layout.paper;
      const x = paper.width_pt - 72;
      const height = Math.min(PAGE_NEW_COLORBAR_HEIGHT_PT, Math.max(60, paper.height_pt - 120));
      const colorbar: ColorbarItem = {
        id: newId,
        kind: 'colorbar',
        space: 'page',
        x,
        y: Math.max(40, paper.height_pt * 0.4),
        width_pt: PAGE_NEW_COLORBAR_WIDTH_PT,
        height_pt: height,
        title: relief.title || '色标',
        unit: relief.unit,
        show_title: true,
        show_ticks: true,
        title_size_pt: 8,
        label_size_pt: 7,
      };
      layout.items.push(colorbar);
    });
    this.select(newId);
  }

  /** 用当前页边距重新生成默认版式（脏时先确认；会替换整份 layout） */
  async relayoutDefault(marginPt = PAGE_DEFAULT_MARGIN_PT): Promise<void> {
    if (this.dirty) {
      const accepted = await this.notifier.ask('重新生成默认版式会覆盖当前排版，继续？');
      if (!accepted) return;
    }
    const options: DefaultPageLayoutOptions = {
      margin_pt: marginPt,
      paper: { ...this.layout.paper },
      measureText: this.measureText.width,
    };
    this.layout = defaultPageLayout(this.geo, options);
    this.selectedId = null;
    this.dirty = true;
    this.fitPage();
    this.renderAll();
    this.notifier.info('已重新生成默认版式');
  }

  /* =========================== 渲染与状态 =========================== */

  /** 重绘预览、同步侧栏、更新标题/状态栏 */
  renderAll(): void {
    renderPageSvg(this.svg, this.layout, this.geo, {
      baseUrl: this.baseUrl,
      selectedId: this.selectedId,
      measureText: this.measureText,
      interactive: true,
    });
    this.sidebar.sync(this.layout, this.geo, this.selectedId);
    this.updateChrome();
  }

  /** 标题与状态栏：文档名用底图文件名；脏标记表示「当前排版还没导出 geo.json」 */
  private updateChrome(): void {
    const count = countItems(this.layout);
    document.title = `${this.document.baseFileName} · ${count} 元素${this.dirty ? ' *' : ''}`;
    const selection = this.selectedId === null ? '' : ` · 选中 #${this.selectedId}`;
    this.notifier.setState(`${count} 个元素${selection} · ${this.dirty ? '未导出' : '已导出'}`);
  }

  /** 把合成报告的告警送到消息区（越界元素单独汇总） */
  private reportWarnings(report: ComposeReport): void {
    for (const warning of report.warnings) this.notifier.error(`警告：${warning}`);
    if (report.out_of_paper.length > 0) {
      this.notifier.error(`有 ${report.out_of_paper.length} 个对象落在纸张之外（成品会被裁掉）`);
    }
  }

  /** 把 viewBox 写回根 svg（缩放/平移的唯一出口） */
  private applyView(): void {
    this.svg.setAttribute(
      'viewBox',
      `${formatPageNumber(this.view.x)} ${formatPageNumber(this.view.y)} ${formatPageNumber(this.view.w)} ${formatPageNumber(this.view.h)}`,
    );
  }

  /* =========================== 坐标换算 =========================== */

  /** 屏幕（client）坐标 → 纸张坐标；依赖 getScreenCTM 处理 viewBox/letterbox/DPR */
  private clientToPage(clientX: number, clientY: number): { x: number; y: number } | null {
    const matrix = this.svg.getScreenCTM();
    if (!matrix) return null;
    const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    return { x: point.x, y: point.y };
  }

  /** 当前屏幕像素与纸张单位的比例（min 处理 letterbox；与 preserveAspectRatio=meet 一致） */
  private screenScale(): number {
    const width = this.svg.clientWidth;
    const height = this.svg.clientHeight;
    if (width <= 0 || height <= 0) return 1;
    return Math.min(width / this.view.w, height / this.view.h);
  }

  /** 命中测试：返回被点到的元素 id */
  private hitTest(target: EventTarget | null): number | null {
    if (!(target instanceof Element)) return null;
    const group = target.closest('[data-page-item]');
    if (!(group instanceof Element)) return null;
    const raw = group.getAttribute('data-page-item');
    if (raw === null) return null;
    const id = Number.parseInt(raw, 10);
    return Number.isInteger(id) ? id : null;
  }

  /* =========================== 指针手势 =========================== */

  private readonly onPointerDown = (event: PointerEvent): void => {
    // 画布获得焦点：否则空格/方向键会被浏览器作用在别的焦点元素上
    this.svg.focus({ preventScroll: true });
    // 中键 / 空格 = 平移；左键 = 选择 + 拖拽
    if (event.button === 1 || (event.button === 0 && this.spaceDown)) {
      event.preventDefault();
      this.gesture = {
        kind: 'pan',
        startClientX: event.clientX,
        startClientY: event.clientY,
        startView: { ...this.view },
      };
      this.svg.setPointerCapture(event.pointerId);
      this.svg.classList.add('is-panning');
      return;
    }
    if (event.button !== 0) return;
    const id = this.hitTest(event.target);
    if (id === null) {
      this.select(null);
      return;
    }
    this.select(id);
    const item = itemById(this.layout, id);
    const page = this.clientToPage(event.clientX, event.clientY);
    if (!item || !page) return;
    this.gesture = {
      kind: 'drag',
      id,
      startPageX: page.x,
      startPageY: page.y,
      originX: item.x,
      originY: item.y,
      space: item.space,
    };
    this.svg.setPointerCapture(event.pointerId);
    this.svg.classList.add('is-dragging');
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const gesture = this.gesture;
    if (!gesture) return;
    if (gesture.kind === 'pan') {
      const scale = this.screenScale();
      if (scale <= 0) return;
      const dx = (event.clientX - gesture.startClientX) / scale;
      const dy = (event.clientY - gesture.startClientY) / scale;
      this.view = {
        x: gesture.startView.x - dx,
        y: gesture.startView.y - dy,
        w: gesture.startView.w,
        h: gesture.startView.h,
      };
      this.applyView();
      return;
    }
    const item = itemById(this.layout, gesture.id);
    const page = this.clientToPage(event.clientX, event.clientY);
    if (!item || !page) return;
    let dx = page.x - gesture.startPageX;
    let dy = page.y - gesture.startPageY;
    if (event.shiftKey) {
      // Shift：锁定到位移更大的轴，便于把文字对齐到水平/竖直位置
      if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    if (gesture.space === 'map') {
      const transform = mapTransform(this.geo, this.layout.map);
      dx /= transform.s;
      dy /= transform.s;
    }
    item.x = roundToPageDecimals(gesture.originX + dx);
    item.y = roundToPageDecimals(gesture.originY + dy);
    this.dirty = true;
    this.renderAll();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!this.gesture) return;
    this.gesture = null;
    this.svg.classList.remove('is-panning', 'is-dragging');
    if (this.svg.hasPointerCapture(event.pointerId)) {
      this.svg.releasePointerCapture(event.pointerId);
    }
    if (this.dirty) this.updateChrome();
  };

  private readonly onContextMenu = (event: MouseEvent): void => {
    // 右键不弹浏览器菜单：画布上右键留给未来的手势（当前只做阻止默认）
    event.preventDefault();
  };

  private readonly onDoubleClick = (event: MouseEvent): void => {
    const id = this.hitTest(event.target);
    if (id === null) return;
    const item = itemById(this.layout, id);
    if (item?.kind !== 'text') return;
    event.preventDefault();
    this.select(id);
    this.sidebar.focusTextEditor();
  };

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const anchor = this.clientToPage(event.clientX, event.clientY);
    if (!anchor) return;
    const factor = Math.exp(-event.deltaY * PAGE_WHEEL_ZOOM_SENSITIVITY);
    this.zoomAt(factor, anchor);
  };

  /** 以纸张坐标 anchor 为中心缩放（缩放范围见 config PAGE_ZOOM_MIN/MAX） */
  private zoomAt(factor: number, anchor: { x: number; y: number }): void {
    const width = this.svg.clientWidth > 0 ? this.svg.clientWidth : this.layout.paper.width_pt;
    const minWidth = width / PAGE_ZOOM_MAX;
    const maxWidth = width / PAGE_ZOOM_MIN;
    const nextWidth = Math.min(maxWidth, Math.max(minWidth, this.view.w / factor));
    if (!Number.isFinite(nextWidth) || nextWidth <= 0) return;
    const ratio = nextWidth / this.view.w;
    this.view = {
      x: anchor.x - (anchor.x - this.view.x) * ratio,
      y: anchor.y - (anchor.y - this.view.y) * ratio,
      w: nextWidth,
      h: this.view.h * ratio,
    };
    this.applyView();
  }

  /* =========================== 键盘 =========================== */

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    // Ctrl+S 优先于「输入框里不响应快捷键」：导出 geo.json 是全局命令
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      this.exportGeo();
      return;
    }
    if (isEditableTarget(event.target)) return;
    // 焦点在按钮/分隔条上时不要抢空格/Delete/方向键（那些是控件自己的键盘语义）
    if (
      event.target instanceof HTMLElement &&
      event.target.closest('button, a, [role="button"], [role="separator"]') !== null
    ) {
      return;
    }

    if (event.key === ' ' || event.code === 'Space') {
      this.spaceDown = true;
      this.svg.classList.add('is-pan-ready');
      event.preventDefault();
      return;
    }
    if (event.key === 'Escape') {
      this.select(null);
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (this.selectedId === null) return;
      event.preventDefault();
      this.deleteItem(this.selectedId);
      return;
    }
    if (event.key.startsWith('Arrow')) {
      if (this.selectedId === null) return;
      const step = event.shiftKey ? PAGE_KEY_MOVE_LARGE_PT : PAGE_KEY_MOVE_PT;
      const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
      const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
      if (dx === 0 && dy === 0) return;
      event.preventDefault();
      this.moveSelectedBy(dx, dy);
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (event.key !== ' ' && event.code !== 'Space') return;
    this.spaceDown = false;
    this.svg.classList.remove('is-pan-ready');
  };

  private readonly onWindowBlur = (): void => {
    this.spaceDown = false;
    this.svg.classList.remove('is-pan-ready');
  };

  private readonly onBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (!this.dirty) return;
    event.preventDefault();
  };

  /** 方向键微移：page 空间按 pt，map 空间换算回底图坐标 */
  private moveSelectedBy(dxPage: number, dyPage: number): void {
    const id = this.selectedId;
    if (id === null) return;
    const item = itemById(this.layout, id);
    if (!item) return;
    const scale = item.space === 'map' ? mapTransform(this.geo, this.layout.map).s : 1;
    if (scale <= 0) return;
    item.x = roundToPageDecimals(item.x + dxPage / scale);
    item.y = roundToPageDecimals(item.y + dyPage / scale);
    this.dirty = true;
    this.renderAll();
  }

  /* =========================== 新建元素 =========================== */

  /** 文字模板：按 role 给默认位置/字号/对齐（用户随后可改） */
  private newTextItem(layout: PageLayout, id: number, role: TextRole): TextItem {
    const paper = layout.paper;
    const centerX = paper.width_pt / 2;
    // 样式默认值只从 config/text-style.ts 的页面文字角色表取，不在这里写死
    const style = PAGE_TEXT_STYLES[role];
    const base = {
      id,
      kind: 'text' as const,
      space: 'page' as const,
      role,
      font_family: null,
      color: style.color,
      rotation_deg: 0,
      line_height: style.line_height,
      italic: style.italic,
      font_weight: style.font_weight,
      letter_spacing_em: style.letter_spacing_em,
      halo: style.halo ? { ...style.halo } : null,
    };
    switch (role) {
      case 'title':
        return {
          ...base,
          x: centerX,
          y: layout.map.y - 26,
          lines: ['新标题'],
          font_size_pt: 18,
          anchor: 'middle',
        };
      case 'subtitle':
        return {
          ...base,
          x: centerX,
          y: layout.map.y - 10,
          lines: ['副标题'],
          font_size_pt: 9,
          anchor: 'middle',
        };
      case 'source':
        return {
          ...base,
          x: centerX,
          y: paper.height_pt - 14,
          lines: ['来源说明'],
          font_size_pt: 7,
          anchor: 'middle',
        };
      case 'note':
        return {
          ...base,
          x: paper.width_pt - 210,
          y: paper.height_pt / 2,
          lines: ['新注记'],
          font_size_pt: 7.5,
          anchor: 'start',
        };
      case 'label':
      case 'annotation':
      default:
        return {
          ...base,
          x: centerX,
          y: paper.height_pt / 2,
          lines: ['新文字'],
          font_size_pt: 10,
          anchor: 'middle',
        };
    }
  }

  /* =========================== 状态查询（测试/调试） =========================== */

  /** 是否未导出（组合根据此决定「打开…」是否先确认） */
  get isDirty(): boolean {
    return this.dirty;
  }

  /** 当前选中 id */
  get selection(): number | null {
    return this.selectedId;
  }
}
