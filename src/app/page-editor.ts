/**
 * 出版排版编辑器的状态机：选择/拖拽/缩放/平移/脏标记/保存。
 *
 * 是什么：持有当前 `Scene`（唯一真值），把画布指针/键盘手势翻译成对 scene 的修改，
 * 组织预览重绘与侧栏同步；同时是 `/api/doc`、`/api/geo`、`/api/scene`、`/api/compose`
 * 的 HTTP 客户端（本文件里的 fetch 辅助也由 `app/page-main.ts` 复用）。
 * 为什么拖拽/缩放只改 scene 而不改底图：地理层只读（契约 §1），map 空间 item 的位置
 * 写回底图坐标，成品由 Python 合成；预览只是同一套 §5 公式的 DOM 实现。
 * 缩放/平移通过根 `<svg>` 的 `viewBox` 实现；指针坐标转换统一走 `getScreenCTM().inverse()`，
 * 这样 letterbox（preserveAspectRatio）与设备像素比都不需要自己算。
 * 元信息：作者 frontend，2026-10-27。
 */

import {
  PAGE_COMPOSE_URL,
  PAGE_DEFAULT_MARGIN_PT,
  PAGE_DOC_URL,
  PAGE_FIT_PADDING_RATIO,
  PAGE_GEO_URL,
  PAGE_KEY_MOVE_LARGE_PT,
  PAGE_KEY_MOVE_PT,
  PAGE_LEGEND_DEFAULTS,
  PAGE_NEW_COLORBAR_HEIGHT_PT,
  PAGE_NEW_COLORBAR_WIDTH_PT,
  PAGE_NEW_LEGEND_WIDTH_PT,
  PAGE_REQUEST_TIMEOUT_MS,
  PAGE_SCENE_URL,
  PAGE_WHEEL_ZOOM_SENSITIVITY,
  PAGE_ZOOM_MAX,
  PAGE_ZOOM_MIN,
} from '../config/page';
import {
  allocateItemId,
  countItems,
  itemById,
  normalizeScene,
  removeItem,
  serializeScene,
  type ColorbarItem,
  type Geo,
  type LegendItem,
  type Scene,
  type TextItem,
  type TextRole,
} from '../core/page';
import { defaultScene, mapTransform, type DefaultSceneOptions } from '../core/page-layout';
import { roundToPageDecimals } from '../core/page';
import { formatPageNumber } from '../render/page-format';
import { renderPageSvg } from '../render/page-svg';
import type { MeasureText } from '../core/types';
import { isEditableTarget, type PageSidebar } from '../ui/page-sidebar';
import type { PageNotifier } from '../ui/page-notify';
import type { PageToolbarHandle } from '../ui/page-toolbar';

/* =========================== HTTP 类型与客户端 =========================== */

/** `/api/doc` 的底图描述 */
export interface PageDocBase {
  readonly url: string;
  readonly sha256: string;
  readonly width_pt: number;
  readonly height_pt: number;
}

/** `/api/doc` 的图标识 */
export interface PageDocFigure {
  readonly key: string;
  readonly path: string;
}

/** `/api/doc` 的响应（契约 §8） */
export interface PageDoc {
  readonly figure: PageDocFigure;
  readonly base: PageDocBase;
  readonly geo: { readonly url: string };
  readonly scene: { readonly url: string };
  readonly final: { readonly url: string };
  readonly needs: { readonly base: boolean; readonly geo: boolean };
}

/** compose 报告里前端会用到的字段（其余字段原样忽略） */
export interface PageComposeReport {
  readonly warnings?: readonly string[];
  readonly counts?: Readonly<Record<string, number>>;
  readonly out_of_canvas?: readonly number[];
}

/** 保存失败的语义码（契约 §8） */
export type PageSaveErrorCode =
  | 'invalid_scene'
  | 'base_changed'
  | 'base_size_changed'
  | 'base_missing'
  | 'geo_missing'
  | 'network'
  | 'http';

export type PageSaveVerdict =
  | {
      readonly ok: true;
      readonly composed: boolean;
      readonly report: PageComposeReport | null;
      readonly marker: Readonly<Record<string, unknown>> | null;
    }
  | { readonly ok: false; readonly code: PageSaveErrorCode; readonly message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

/** 轻量断言 `/api/doc` 的响应；失败抛出可直接展示的中文错误 */
function assertPageDoc(value: unknown): PageDoc {
  if (!isRecord(value)) throw new Error('/api/doc 响应不是对象');
  const figure = value.figure;
  const base = value.base;
  const geo = value.geo;
  const scene = value.scene;
  const final = value.final;
  const needs = value.needs;
  if (!isRecord(figure) || asString(figure.key) === null) {
    throw new Error('/api/doc 缺少 figure.key');
  }
  if (
    !isRecord(base) ||
    asString(base.url) === null ||
    theStringOrEmpty(base.sha256) === null ||
    asNumber(base.width_pt) === null ||
    asNumber(base.height_pt) === null
  ) {
    throw new Error('/api/doc 缺少 base 描述（url/sha256/width_pt/height_pt）');
  }
  const geoUrl = isRecord(geo) ? (asString(geo.url) ?? PAGE_GEO_URL) : PAGE_GEO_URL;
  const sceneUrl = isRecord(scene) ? (asString(scene.url) ?? PAGE_SCENE_URL) : PAGE_SCENE_URL;
  const finalUrl = isRecord(final) ? (asString(final.url) ?? '/final.svg') : '/final.svg';
  return {
    figure: { key: figure.key as string, path: theStringOrEmpty(figure.path) ?? '' },
    base: {
      url: base.url as string,
      sha256: theStringOrEmpty(base.sha256) ?? '',
      width_pt: base.width_pt as number,
      height_pt: base.height_pt as number,
    },
    geo: { url: geoUrl },
    scene: { url: sceneUrl },
    final: { url: finalUrl },
    needs: {
      base: isRecord(needs) ? needs.base === true : false,
      geo: isRecord(needs) ? needs.geo === true : false,
    },
  };
}

/** 空字符串也算合法字符串（底图缺失时 sha256 为空） */
function theStringOrEmpty(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** 带超时的 fetch；网络错误统一转成中文 Error */
async function request(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), PAGE_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: 'no-store' });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`请求超时（${PAGE_REQUEST_TIMEOUT_MS / 1000}s）：${url}`, { cause: error });
    }
    throw new Error(`网络错误：${url}`, { cause: error });
  } finally {
    window.clearTimeout(timer);
  }
}

/** 读 JSON 响应体；非 JSON 时返回 null（错误路径也要能读到语义体） */
async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

/** 从错误响应里取业务码与 message（新契约用 error，旧实现用 code，两者都兼容） */
function failureOf(response: Response, body: unknown, fallback: string): PageSaveVerdict {
  const record = isRecord(body) ? body : {};
  const rawCode = asString(record.error) ?? asString(record.code) ?? fallback;
  const message = asString(record.message) ?? `HTTP ${response.status}`;
  const code: PageSaveErrorCode =
    rawCode === 'invalid_scene' ||
    rawCode === 'base_changed' ||
    rawCode === 'base_size_changed' ||
    rawCode === 'base_missing' ||
    rawCode === 'geo_missing'
      ? rawCode
      : 'http';
  return { ok: false, code, message };
}

/** 从成功响应里取 report/marker（字段缺失时给 null，不阻止「已保存」提示） */
function successOf(body: unknown): PageSaveVerdict {
  const record = isRecord(body) ? body : {};
  const report = isRecord(record.report) ? (record.report as PageComposeReport) : null;
  const marker = isRecord(record.marker) ? record.marker : null;
  return {
    ok: true,
    composed: record.composed !== false,
    report,
    marker,
  };
}

/** `GET /api/doc` */
export async function fetchPageDoc(): Promise<PageDoc> {
  const response = await request(PAGE_DOC_URL);
  if (!response.ok) {
    const body = await readJson(response);
    const record = isRecord(body) ? body : {};
    throw new Error(asString(record.message) ?? `GET /api/doc 失败（HTTP ${response.status}）`);
  }
  return assertPageDoc(await readJson(response));
}

/** `GET /api/geo`：返回原始 geo 对象（校验由调用方做） */
export async function fetchGeoJson(): Promise<unknown> {
  const response = await request(PAGE_GEO_URL);
  if (!response.ok) {
    const body = await readJson(response);
    const record = isRecord(body) ? body : {};
    throw new Error(
      asString(record.message) ?? `GET /api/geo 失败（HTTP ${response.status}，geo 尚未生成？）`,
    );
  }
  return readJson(response);
}

/** `GET /api/scene`：不存在时服务器返回 `null` */
export async function fetchSceneJson(): Promise<unknown> {
  const response = await request(PAGE_SCENE_URL);
  if (!response.ok) {
    const body = await readJson(response);
    const record = isRecord(body) ? body : {};
    throw new Error(asString(record.message) ?? `GET /api/scene 失败（HTTP ${response.status}）`);
  }
  return readJson(response);
}

/** PUT 请求体：scene 去掉 figure、数字规范化，按需带 `ack_base_change` */
function savePayload(scene: Scene, ackBaseChange: boolean): Record<string, unknown> {
  const normalized = normalizeScene(scene);
  const { figure: _figure, ...rest } = normalized;
  const payload: Record<string, unknown> = { ...rest };
  if (ackBaseChange) payload.ack_base_change = true;
  return payload;
}

/** `PUT /api/scene`：保存并触发合成 */
export async function putScene(scene: Scene, ackBaseChange = false): Promise<PageSaveVerdict> {
  let response: Response;
  try {
    response = await request(PAGE_SCENE_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(savePayload(scene, ackBaseChange)),
    });
  } catch (error) {
    return {
      ok: false,
      code: 'network',
      message: error instanceof Error ? error.message : '网络错误',
    };
  }
  const body = await readJson(response);
  if (!response.ok) return failureOf(response, body, 'http');
  return successOf(body);
}

/** `POST /api/compose`：用服务器当前 scene 重新合成 */
export async function postCompose(): Promise<PageSaveVerdict> {
  let response: Response;
  try {
    response = await request(PAGE_COMPOSE_URL, { method: 'POST' });
  } catch (error) {
    return {
      ok: false,
      code: 'network',
      message: error instanceof Error ? error.message : '网络错误',
    };
  }
  const body = await readJson(response);
  if (!response.ok) return failureOf(response, body, 'http');
  return successOf(body);
}

/* =========================== 编辑器 =========================== */

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
  /** 文本测量器（canvas measureText 适配器） */
  readonly measureText: MeasureText;
  readonly doc: PageDoc;
  readonly geo: Geo;
  readonly scene: Scene;
  /** 初次打开时 scene 是否来自 defaultScene（尚未保存） */
  readonly dirty?: boolean;
}

/** 选中/拖拽/保存状态机 + HTTP 动作 */
export class PageEditor {
  private readonly svg: SVGSVGElement;
  private readonly sidebar: PageSidebar;
  private readonly notifier: PageNotifier;
  private readonly measureText: MeasureText;
  private readonly doc: PageDoc;
  private readonly geo: Geo;
  private scene: Scene;

  private selectedId: number | null = null;
  private view: ViewBox = { x: 0, y: 0, w: 1, h: 1 };
  private dirty: boolean;
  private saving = false;
  private spaceDown = false;
  private gesture: Gesture | null = null;
  private toolbar: PageToolbarHandle | null = null;

  constructor(deps: PageEditorDeps) {
    this.svg = deps.svg;
    this.sidebar = deps.sidebar;
    this.notifier = deps.notifier;
    this.measureText = deps.measureText;
    this.doc = deps.doc;
    this.geo = deps.geo;
    this.scene = deps.scene;
    this.dirty = deps.dirty ?? false;

    this.svg.classList.add('page-canvas');
    this.svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    this.svg.setAttribute('role', 'img');
    this.svg.setAttribute('aria-label', '出版排版预览画布');
    // 画布可聚焦：空格平移/方向键微移只在焦点不落在输入控件时生效
    this.svg.setAttribute('tabindex', '0');
  }

  /* =========================== 生命周期 =========================== */

  /** 挂上工具栏句柄（page-main 先构造编辑器再建工具栏） */
  bindToolbar(handle: PageToolbarHandle): void {
    this.toolbar = handle;
  }

  /** 首次装配：适应页面、绑事件、渲染 */
  start(): void {
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

  /** 当前 scene 的只读引用（page-main 装配侧栏需要） */
  get currentScene(): Scene {
    return this.scene;
  }

  /* =========================== 修改入口 =========================== */

  /** 应用一次 scene 修改：mutator 直接改 scene，然后重绘/同步侧栏/记脏 */
  applySceneChange(mutate: (scene: Scene, geo: Geo) => void): void {
    mutate(this.scene, this.geo);
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
    if (itemById(this.scene, id) === null) return;
    if (this.selectedId === id) this.selectedId = null;
    this.applySceneChange((scene) => {
      removeItem(scene, id);
    });
  }

  /* =========================== 工具栏动作 =========================== */

  /** 保存：PUT scene，处理 400/409/503；成功时清脏标记并展示 warnings */
  async save(): Promise<boolean> {
    if (this.saving) return false;
    this.saving = true;
    this.toolbar?.setSaving(true);
    this.updateChrome();
    try {
      let ack = false;
      for (;;) {
        const verdict = await putScene(this.scene, ack);
        if (verdict.ok) {
          this.dirty = false;
          this.updateChrome();
          this.reportWarnings(verdict.report);
          this.notifier.info(verdict.composed ? '已保存并合成' : 'scene 已保存（合成未完成）');
          if (verdict.marker) {
            const counts = isRecord(verdict.marker.counts) ? verdict.marker.counts : null;
            const total = counts ? counts['total'] : null;
            if (typeof total === 'number') this.notifier.info(`final 已更新：共 ${total} 个元素`);
          }
          return true;
        }
        if (verdict.code === 'base_changed') {
          if (ack) {
            this.notifier.error('底图仍与 scene 声明不一致，保存取消');
            return false;
          }
          const accepted = await this.notifier.ask(
            '底图已更新（内容可能变化），scene 的底图声明将随之更新。仍要保存？',
          );
          if (!accepted) return false;
          ack = true;
          continue;
        }
        if (verdict.code === 'base_size_changed') {
          this.notifier.error('底图尺寸已变（画布尺寸变化），请刷新页面后重新排版再保存');
          return false;
        }
        if (verdict.code === 'invalid_scene') {
          this.notifier.error(`scene 校验失败：${verdict.message}`);
          return false;
        }
        if (verdict.code === 'base_missing' || verdict.code === 'geo_missing') {
          this.notifier.error(
            `服务端缺少 ${verdict.code === 'base_missing' ? '底图' : 'geo'}：${verdict.message}`,
          );
          return false;
        }
        this.notifier.error(`保存失败：${verdict.message}`);
        return false;
      }
    } finally {
      this.saving = false;
      this.toolbar?.setSaving(false);
      this.updateChrome();
    }
  }

  /** 重新合成：先保存（含确认），再 POST /api/compose */
  async composeAgain(): Promise<void> {
    if (!(await this.save())) return;
    const verdict = await postCompose();
    if (verdict.ok) {
      this.reportWarnings(verdict.report);
      this.notifier.info('已重新合成 final.svg');
      return;
    }
    this.notifier.error(`重新合成失败：${verdict.message}`);
  }

  /** 新标签页打开服务端成品 */
  openFinal(): void {
    const url = this.doc.final.url || '/final.svg';
    window.open(url, '_blank', 'noopener');
  }

  /** 适应页面：纸张四周留 4% 空白 */
  fitPage(): void {
    const pad =
      Math.max(this.scene.paper.width_pt, this.scene.paper.height_pt) * PAGE_FIT_PADDING_RATIO;
    this.view = {
      x: -pad,
      y: -pad,
      w: this.scene.paper.width_pt + pad * 2,
      h: this.scene.paper.height_pt + pad * 2,
    };
    this.applyView();
  }

  /** 1:1：1pt = 1 屏幕像素，以纸张中心为锚点 */
  actualSize(): void {
    const width = this.svg.clientWidth > 0 ? this.svg.clientWidth : this.scene.paper.width_pt;
    const height = this.svg.clientHeight > 0 ? this.svg.clientHeight : this.scene.paper.height_pt;
    this.view = {
      x: this.scene.paper.width_pt / 2 - width / 2,
      y: this.scene.paper.height_pt / 2 - height / 2,
      w: width,
      h: height,
    };
    this.applyView();
  }

  /** 添加文字元素（role 决定默认位置/字号） */
  addText(role: TextRole): void {
    let newId = 0;
    this.applySceneChange((scene) => {
      newId = allocateItemId(scene);
      scene.items.push(this.newTextItem(scene, newId, role));
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
    this.applySceneChange((scene) => {
      newId = allocateItemId(scene);
      const paper = scene.paper;
      const margin = scene.map.x;
      const rightX = Math.min(
        Math.max(
          scene.map.x + scene.map.width_pt + 16,
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
        y: scene.map.y,
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
      scene.items.push(legend);
    });
    this.select(newId);
  }

  /** 添加色标（配色/刻度来自 geo.relief） */
  addColorbar(): void {
    let newId = 0;
    this.applySceneChange((scene) => {
      newId = allocateItemId(scene);
      const paper = scene.paper;
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
        title: this.geo.relief.title || '色标',
        unit: this.geo.relief.unit,
        show_title: true,
        show_ticks: true,
        title_size_pt: 8,
        label_size_pt: 7,
      };
      scene.items.push(colorbar);
    });
    this.select(newId);
  }

  /** 用当前页边距重新生成默认版式（脏时先确认；会替换整份 scene） */
  async relayoutDefault(marginPt = PAGE_DEFAULT_MARGIN_PT): Promise<void> {
    if (this.dirty) {
      const accepted = await this.notifier.ask('重新生成默认版式会覆盖当前排版，继续？');
      if (!accepted) return;
    }
    const options: DefaultSceneOptions = {
      figure: this.scene.figure,
      margin_pt: marginPt,
      paper: { ...this.scene.paper },
      measureText: this.measureText,
    };
    this.scene = defaultScene(this.geo, this.doc.base, options);
    this.selectedId = null;
    this.dirty = true;
    this.fitPage();
    this.renderAll();
    this.notifier.info('已重新生成默认版式');
  }

  /* =========================== 渲染与状态 =========================== */

  /** 重绘预览、同步侧栏、更新标题/状态栏 */
  renderAll(): void {
    renderPageSvg(this.svg, this.scene, this.geo, {
      baseUrl: this.doc.base.url || '/base.svg',
      selectedId: this.selectedId,
      measureText: this.measureText,
      interactive: true,
    });
    this.sidebar.sync(this.scene, this.geo, this.selectedId);
    this.updateChrome();
  }

  /** 标题与状态栏（脏标记/保存中/元素数） */
  private updateChrome(): void {
    const count = countItems(this.scene);
    const figureName = this.doc.figure.key || '地图排版';
    document.title = `${figureName} · ${count} 元素${this.dirty ? ' *' : ''}`;
    const selection = this.selectedId === null ? '' : ` · 选中 #${this.selectedId}`;
    this.notifier.setState(
      `${count} 个元素${selection} · ${this.dirty ? '未保存' : '已保存'}${
        this.saving ? ' · 保存中…' : ''
      }`,
    );
  }

  /** 把 compose 报告的告警送到消息区（越界对象单独汇总） */
  private reportWarnings(report: PageComposeReport | null): void {
    if (!report) return;
    for (const warning of report.warnings ?? []) this.notifier.error(`警告：${warning}`);
    const outOfCanvas = report.out_of_canvas ?? [];
    if (outOfCanvas.length > 0) {
      this.notifier.error(`有 ${outOfCanvas.length} 个对象落在纸张之外（成品会被裁掉）`);
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
    const item = itemById(this.scene, id);
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
    const item = itemById(this.scene, gesture.id);
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
      const transform = mapTransform(this.geo, this.scene.map);
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
    const item = itemById(this.scene, id);
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
    const width = this.svg.clientWidth > 0 ? this.svg.clientWidth : this.scene.paper.width_pt;
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
    // Ctrl+S 优先于「输入框里不响应快捷键」：保存是全局命令
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void this.save();
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
    const item = itemById(this.scene, id);
    if (!item) return;
    const scale = item.space === 'map' ? mapTransform(this.geo, this.scene.map).s : 1;
    if (scale <= 0) return;
    item.x = roundToPageDecimals(item.x + dxPage / scale);
    item.y = roundToPageDecimals(item.y + dyPage / scale);
    this.dirty = true;
    this.renderAll();
  }

  /* =========================== 新建元素 =========================== */

  /** 文字模板：按 role 给默认位置/字号/对齐（用户随后可改） */
  private newTextItem(scene: Scene, id: number, role: TextRole): TextItem {
    const paper = scene.paper;
    const centerX = paper.width_pt / 2;
    const base = {
      id,
      kind: 'text' as const,
      space: 'page' as const,
      role,
      font_family: null,
      color: scene.style.color,
      rotation_deg: 0,
      line_height: 1.35,
      italic: false,
      bold: false,
      halo: null,
    };
    switch (role) {
      case 'title':
        return {
          ...base,
          x: centerX,
          y: scene.map.y - 26,
          lines: ['新标题'],
          font_size_pt: 18,
          anchor: 'middle',
        };
      case 'subtitle':
        return {
          ...base,
          x: centerX,
          y: scene.map.y - 10,
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

  /** 是否未保存 */
  get isDirty(): boolean {
    return this.dirty;
  }

  /** 当前选中 id */
  get selection(): number | null {
    return this.selectedId;
  }

  /** 当前 scene 签名（beforeunload 的比对口径与调试用） */
  get signature(): string {
    return serializeScene(this.scene);
  }
}
