/**
 * 单文件地图文档（`<stem>.geo.json`）的类型、校验、规范化、序列化与摘要（纯逻辑，不碰 DOM）。
 *
 * 是什么：`docs/PAGE-EDITOR.md` §3/§4 的数据契约在 TS 侧的唯一实现——地理块 `Geo`、
 * 排版块 `PageLayout`（纸张/地图摆放/图框/样式/items）、`validateGeo` + `validatePage`（契约约束）、
 * `normalizeGeo` / `normalizePage`（可选块补默认、page 数字 3 位小数）、
 * `serializeMapDocFile`（导出文件文本）、`pageDigest` / `geoDigest`（SHA-256）。
 * 为什么放在 core 且不碰 DOM：预览与成品合成必须对同一份 layout 得出同一份语义；
 * 校验/规范化/摘要都要能在 node 里单测，且浏览器与导出共用同一实现。
 * 为什么 geo 与 page 合成一个文件：用户只需要保存/再次打开一份 geo.json（见 §1 数据流）；
 * 文件身份与底图身份各只有一份（顶层 format/version、geo.base），不再有重复声明。
 * 注意：摘要用纯 TS SHA-256 实现（不依赖 Web Crypto / node:crypto），只用于本地签名与
 * 成品 marker（`render/compose-svg.ts` 的 `makeMarker`）。
 * 元信息：作者 frontend，2026-10-27，随 `docs/PAGE-EDITOR.md` 新契约落地；
 *         2026-10-28 合并 scene.json 为 geo.json 的 page 块（去掉独立 scene 格式与重复 base）；
 *         2026-10-29 geo 升 v2：GeoLabel 只含 role/text/位置/锚点/字号（样式归 config/text-style.ts），
 *         TextItem 用 font_weight/letter_spacing_em 取代 bold，labels 逐条校验。
 */

import {
  PAGE_DECIMALS,
  PAGE_GEO_FORMAT,
  PAGE_GEO_VERSION,
  PAGE_MAX_ITEMS,
  PAGE_MAX_TEXT_LINE_CHARS,
  PAGE_MAX_TEXT_LINES,
  PAGE_MIN_MAP_WIDTH_PT,
  PAGE_PAPER_MAX_PT,
  PAGE_PAPER_MIN_PT,
} from '../config/page';
import type { PaperOrientation, PaperPresetId } from '../config/page';
import { MAP_LABEL_ROLES, PAGE_TEXT_STYLES } from '../config/text-style';
import type { MapLabelRole, PageTextRole } from '../config/text-style';

/* =========================== 基础类型 =========================== */

/** 元素所在坐标空间：page = 纸张坐标（pt）；map = 底图坐标（viewBox 坐标） */
export type ItemSpace = 'page' | 'map';

/** 文字锚点 */
export type TextAnchor = 'start' | 'middle' | 'end';

/** 文字语义角色（与 config/text-style.ts 的页面文字角色同源，只影响默认样式/UI，不参与布局公式） */
export type TextRole = PageTextRole;

/** 图例条目形状 */
export type LegendShape = 'line' | 'rect' | 'point';

/** 图例点标记 */
export type LegendMarker = 'star' | 'square' | 'circle';

/** 文字光晕（先描边后填充） */
export interface Halo {
  color: string;
  width_pt: number;
}

/** 所有元素的公共字段：id 唯一、kind 判别、space 坐标空间 */
interface ItemBase {
  id: number;
  kind: string;
  space: ItemSpace;
}

/** 文字元素（契约 §4.1 text） */
export interface TextItem extends ItemBase {
  kind: 'text';
  role: TextRole;
  x: number;
  y: number;
  lines: string[];
  font_size_pt: number;
  /** null = 用 layout.style.font_family */
  font_family: string | null;
  color: string;
  anchor: TextAnchor;
  rotation_deg: number;
  line_height: number;
  italic: boolean;
  /** 数字字重，100..900 的整数（默认 400；渲染时非 400 才写 font-weight） */
  font_weight: number;
  /** 字距（em，相对字号；默认 0，渲染时非 0 才写 letter-spacing） */
  letter_spacing_em: number;
  halo: Halo | null;
}

/** 图例条目（契约 §3 legend.entries / §4.1 legend.entries） */
export interface LegendEntry {
  label: string;
  shape: LegendShape;
  /** null = 不描边（point 标记可能只填充） */
  stroke: string | null;
  width_pt: number;
  dash: number[] | null;
  fill: string | null;
  opacity: number;
  marker: LegendMarker | null;
}

/** 图例框外观（契约 §4.1 legend.frame） */
export interface LegendFrame {
  show: boolean;
  stroke: string;
  width_pt: number;
  fill: string;
  opacity: number;
}

/** 图例元素：高度由 §5.4 公式派生，不落 layout */
export interface LegendItem extends ItemBase {
  kind: 'legend';
  /** 契约把 space 定义为公共字段；page/map 都允许（map 空间由渲染侧缩放尺寸） */
  space: ItemSpace;
  x: number;
  y: number;
  width_pt: number;
  title: string;
  entries: LegendEntry[];
  font_size_pt: number;
  title_size_pt: number;
  row_height_pt: number;
  padding_pt: number;
  swatch_width_pt: number;
  swatch_gap_pt: number;
  frame: LegendFrame;
}

/** 色标元素：配色/刻度来自 geo.relief，layout 只存摆放与文字 */
export interface ColorbarItem extends ItemBase {
  kind: 'colorbar';
  /** 同 LegendItem.space：map 空间时成品合成按地图缩放比缩放宽高 */
  space: ItemSpace;
  x: number;
  y: number;
  width_pt: number;
  height_pt: number;
  title: string;
  unit: string;
  show_title: boolean;
  show_ticks: boolean;
  title_size_pt: number;
  label_size_pt: number;
}

export type PageItem = TextItem | LegendItem | ColorbarItem;

/** 纸张（preset/orientation 只用于 UI 记忆） */
export interface PagePaper {
  preset: PaperPresetId;
  orientation: PaperOrientation;
  width_pt: number;
  height_pt: number;
}

/** 地图摆放：高度由宽度 × 底图纵横比派生（§5.1） */
export interface MapPlacement {
  x: number;
  y: number;
  width_pt: number;
}

/** 图框与刻度（§5.2） */
export interface PageFrame {
  show: boolean;
  stroke: string;
  width_pt: number;
  ticks: boolean;
  tick_length_pt: number;
  tick_font_size_pt: number;
  tick_color: string;
  tick_gap_pt: number;
}

/** 页面级样式 */
export interface PageStyle {
  paper_color: string;
  font_family: string;
  color: string;
}

/**
 * `geo.json` 的排版块（契约 §4）：纸张、地图摆放、图框/样式、items 与 id 序列。
 * 为什么没有 format/version/figure/base：文件身份与底图身份只在顶层（format/version、geo.base），
 * 同一份底图的排版不会出现第二套声明，也就没有「两份 base 不一致」的分支。
 */
export interface PageLayout {
  paper: PagePaper;
  map: MapPlacement;
  frame: PageFrame;
  style: PageStyle;
  /** 数组序 = 绘制序（z 序） */
  items: PageItem[];
  /** 必须为正整数且大于所有 item id */
  seq: number;
}

/* =========================== geo.json 类型（只读） =========================== */

export type GraticuleSide = 'bottom' | 'top' | 'left' | 'right';

export interface GeoTick {
  value: number;
  label: string;
  /** 底图坐标（viewBox 坐标） */
  x: number;
  y: number;
  side: GraticuleSide;
}

export interface GraticuleStyle {
  stroke: string;
  width_pt: number;
  dash: number[];
  opacity: number;
}

export interface GeoGraticule {
  lon: GeoTick[];
  lat: GeoTick[];
  style: GraticuleStyle;
}

/**
 * 地物/地名标注候选（geo v2，只读；样式由 config/text-style.ts 的 role 表决定）。
 * `x` 是文字块的水平锚点（由 `anchor` 决定是左端/中心/右端）；`y` 是文字块**垂直中心**，
 * 前端用 `MAP_LABEL_STYLE.baseline_ratio` 换算回第一行基线（见 core/page-layout.ts）。
 */
export interface GeoLabel {
  id: string;
  role: MapLabelRole;
  /** 原始文字；换行用 "\n"，前端自己 split */
  text: string;
  x: number;
  y: number;
  anchor: TextAnchor;
  font_size_pt: number;
  /** 绘制顺序，整数，原图顺序 */
  order: number;
}

export interface GeoReliefStop {
  offset: number;
  color: string;
}

export interface GeoRelief {
  title: string;
  unit: string;
  vmin: number;
  vmax: number;
  stops: GeoReliefStop[];
  ticks: number[];
}

export interface GeoLegendEntry {
  label: string;
  shape: LegendShape;
  stroke: string | null;
  width_pt: number;
  dash: number[] | null;
  fill: string | null;
  opacity: number;
  marker: LegendMarker | null;
}

export interface GeoLegend {
  title: string;
  entries: GeoLegendEntry[];
}

export interface GeoSuggestions {
  title: string;
  subtitle: string;
  notes: string[];
  source: string;
  area_annotation: string[];
  legend_title: string;
  colorbar_title: string;
}

export interface GeoBase {
  sha256: string;
  /** [x, y, w, h] */
  view_box: [number, number, number, number];
  width_pt: number;
  height_pt: number;
}

/** geo.json（§3，只读地理块；Cartopy 直出） */
export interface Geo {
  format: typeof PAGE_GEO_FORMAT;
  version: number;
  base: GeoBase;
  graticule: GeoGraticule;
  labels: GeoLabel[];
  /**
   * 高程/水深色标数据；Cartopy 不画色标时整个键缺省，`normalizeGeo` 补成 null。
   * 为什么允许 null：默认排版与 compose 的 colorbar 都依赖它，缺省时必须能降级
   * （不生成色标）而不是崩。
   */
  relief: GeoRelief | null;
  legend: GeoLegend;
  suggestions: GeoSuggestions;
}

/** 磁盘上排版块的键名（geo.json 顶层；Cartopy 产物没有这个键） */
export const MAP_DOC_PAGE_KEY = 'page';

/** 磁盘上的单文件地图文档形状：geo 块 + 可选的排版块（编辑器导出时一定写 page） */
export interface MapDoc extends Geo {
  page?: PageLayout;
}

/* =========================== 数值与序列化 =========================== */

/** 非有限值（NaN/Infinity）不进 SVG：统一落到 0，避免 NaN 污染字符串 */
const finiteOrZero = (value: number): number => (Number.isFinite(value) ? value : 0);

/**
 * 四舍五入到 `PAGE_DECIMALS` 位小数并归一负零。
 *
 * 为什么是 `Math.round(v*1000)/1000`：预览、page 摘要与导出的 final.svg 必须共用同一套
 * 舍入（否则同一 layout 会得到不同字节）；`.xxx5` 边界按 JS `Math.round` 语义处理。
 */
export function roundToPageDecimals(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** PAGE_DECIMALS;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** 递归把对象里的数字规范到 3 位小数；返回新对象，不修改入参 */
function roundNumbersDeep<T>(value: T): T {
  if (typeof value === 'number') return roundToPageDecimals(value) as T;
  if (Array.isArray(value)) {
    const items = value as unknown[];
    return items.map((entry) => roundNumbersDeep(entry)) as T;
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = roundNumbersDeep(entry);
    }
    return out as T;
  }
  return value;
}

/** 规范化 layout（3 位小数、新对象）；保存前与摘要前都走它 */
export function normalizePage(layout: PageLayout): PageLayout {
  return roundNumbersDeep(layout);
}

/** 把值变成键排序、无空白、数字 3 位小数的 JSON 结构（递归） */
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry));
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) out[key] = canonicalValue(record[key]);
    return out;
  }
  if (typeof value === 'number') return roundToPageDecimals(finiteOrZero(value));
  return value;
}

/**
 * 任意值 → 键排序、无空白、数字 3 位小数的 canonical JSON 串（geo digest / marker 用）。
 * 复用 layout 的 `canonicalValue`，保证 layout 与 geo 两种文档只有一套规范化口径。
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value)) ?? 'null';
}

/**
 * 规范化 layout → 键排序、无空白的 JSON 串。
 * 签名/摘要用它做「打开后是否改过」的比较，因此必须确定性（键序、数字精度都固定）。
 */
export function serializePage(layout: PageLayout): string {
  return JSON.stringify(canonicalValue(normalizePage(layout)));
}

/**
 * 任意值 → 键排序、无空白、**保留数字精度**的 JSON 结构（只把非有限值落 0）。
 * 为什么单独一份：导出文件的 geo 块必须保持 Cartopy 原精度（`base.view_box` 可能有 6 位小数），
 * 否则导出后再被 Cartopy 侧的一致性校验判成「与底图根标签不一致」；page 块已先 normalizePage
 * 统一到 3 位小数，所以复用同一套键排序即可。
 */
function canonicalValueExact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalValueExact(entry));
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) out[key] = canonicalValueExact(record[key]);
    return out;
  }
  if (typeof value === 'number') return finiteOrZero(value);
  return value;
}

/**
 * 导出单文件地图文档（`<stem>.geo.json`）的文本：geo 全字段 + `page` 排版块。
 *
 * 文件即「可再次编辑的地图」：重新打开时 `page` 块恢复排版，geo 块仍作为只读地理输入。
 * 键排序 + 2 空格缩进 + 末尾一个换行（可 diff、可版本化）；同一输入字节稳定，
 * 且「导出 → 重新打开 → 再导出」必须字节一致（幂等，geo 精度与 page 舍入都不漂移）。
 */
export function serializeMapDocFile(geo: Geo, layout: PageLayout): string {
  const doc: MapDoc = { ...geo, [MAP_DOC_PAGE_KEY]: normalizePage(layout) };
  return `${JSON.stringify(canonicalValueExact(doc), null, 2)}\n`;
}

/** layout 签名：摘要用 3 位小数规范化后的 canonical JSON */
export function pageDigest(layout: PageLayout): string {
  return sha256Hex(serializePage(layout));
}

/** geo 签名（写进 final marker 的 "geo" 字段）：规范化 geo 的 canonical JSON 的 sha256 */
export function geoDigest(geo: Geo): string {
  return sha256Hex(canonicalJson(geo));
}

/* =========================== SHA-256（纯 TS） =========================== */

/** SHA-256 轮常量（FIPS 180-4） */
const SHA256_K: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** SHA-256 初始哈希值 */
const SHA256_H: readonly number[] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

/** 32 位右旋 */
const rotr = (value: number, bits: number): number =>
  ((value >>> bits) | (value << (32 - bits))) >>> 0;

/** 无符号 32 位加法（JS 数字是 double，位运算自动回绕） */
const add32 = (...values: readonly number[]): number => {
  let sum = 0;
  for (const value of values) sum = (sum + (value >>> 0)) | 0;
  return sum >>> 0;
};

/** 取定长数组的一项，越界回退 0（满足 noUncheckedIndexedAccess） */
const at = (values: readonly number[], index: number): number => values[index] ?? 0;

/**
 * bytes 的 SHA-256（十六进制小写）。
 * 为什么自己写：core 不能依赖 DOM（Web Crypto 是异步且部分环境不可用），
 * 也不能依赖 node:crypto（浏览器包里不存在）；这个实现只服务本地签名比较。
 */
export function sha256OfBytes(bytes: Uint8Array): string {
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const data = new Uint8Array(paddedLength);
  data.set(bytes);
  data[bytes.length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const hash = [...SHA256_H];
  const schedule = new Array<number>(64).fill(0);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) schedule[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const w15 = at(schedule, i - 15);
      const w2 = at(schedule, i - 2);
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      schedule[i] = add32(at(schedule, i - 16), s0, at(schedule, i - 7), s1);
    }

    let a = at(hash, 0);
    let b = at(hash, 1);
    let c = at(hash, 2);
    let d = at(hash, 3);
    let e = at(hash, 4);
    let f = at(hash, 5);
    let g = at(hash, 6);
    let h = at(hash, 7);

    for (let i = 0; i < 64; i += 1) {
      const bigS1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = add32(h, bigS1, choose, at(SHA256_K, i), at(schedule, i));
      const bigS0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = add32(bigS0, majority);
      h = g;
      g = f;
      f = e;
      e = add32(d, temp1);
      d = c;
      c = b;
      b = a;
      a = add32(temp1, temp2);
    }

    hash[0] = add32(at(hash, 0), a);
    hash[1] = add32(at(hash, 1), b);
    hash[2] = add32(at(hash, 2), c);
    hash[3] = add32(at(hash, 3), d);
    hash[4] = add32(at(hash, 4), e);
    hash[5] = add32(at(hash, 5), f);
    hash[6] = add32(at(hash, 6), g);
    hash[7] = add32(at(hash, 7), h);
  }

  return hash.map((word) => (word >>> 0).toString(16).padStart(8, '0')).join('');
}

/** UTF-8 文本的 SHA-256（十六进制小写）；对底图原文/规范化 JSON 求摘要都走这里 */
export function sha256Hex(text: string): string {
  return sha256OfBytes(new TextEncoder().encode(text));
}

/* =========================== 校验 =========================== */

/** 校验结果：ok 分支的 layout 已通过结构检查（未规范化） */
export type PageValidation =
  | { readonly ok: true; readonly layout: PageLayout; readonly warnings: readonly string[] }
  | {
      readonly ok: false;
      readonly errors: readonly string[];
      readonly warnings: readonly string[];
    };

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

const isColor = (value: unknown): value is string =>
  typeof value === 'string' && COLOR_RE.test(value);

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';

const isTextAnchor = (value: unknown): value is TextAnchor =>
  value === 'start' || value === 'middle' || value === 'end';

const isItemSpace = (value: unknown): value is ItemSpace => value === 'page' || value === 'map';

/** 页面文字角色：键集来自 config/text-style.ts 的 PAGE_TEXT_STYLES（单一真源） */
const isTextRole = (value: unknown): value is TextRole =>
  typeof value === 'string' && Object.hasOwn(PAGE_TEXT_STYLES, value);

const isMapLabelRole = (value: unknown): value is MapLabelRole =>
  typeof value === 'string' && (MAP_LABEL_ROLES as readonly string[]).includes(value);

const isLegendShape = (value: unknown): value is LegendShape =>
  value === 'line' || value === 'rect' || value === 'point';

const isLegendMarker = (value: unknown): value is LegendMarker =>
  value === 'star' || value === 'square' || value === 'circle';

const GRATICULE_SIDES: readonly GraticuleSide[] = ['bottom', 'top', 'left', 'right'];

const isGraticuleSide = (value: unknown): value is GraticuleSide =>
  typeof value === 'string' && GRATICULE_SIDES.includes(value as GraticuleSide);

/** 可选颜色：null 或 #rrggbb */
const nullableColor = (value: unknown): boolean => value === null || isColor(value);

/** 可选虚线：null 或 2 个正数 */
const nullableDash = (value: unknown): boolean =>
  value === null ||
  (Array.isArray(value) &&
    value.length === 2 &&
    value.every((entry) => isFiniteNumber(entry) && entry > 0));

/** 可选光晕：null 或 {color,width_pt} */
function checkHalo(value: unknown, path: string, errors: string[]): void {
  if (value === null) return;
  if (!isObject(value)) {
    errors.push(`${path}: 必须是对象或 null`);
    return;
  }
  if (!isColor(value.color)) errors.push(`${path}.color: 必须是 #rrggbb`);
  if (!isFiniteNumber(value.width_pt) || value.width_pt <= 0) {
    errors.push(`${path}.width_pt: 必须是正数`);
  }
}

/** 校验 layout.items 里的一个元素；返回 false 表示该元素（或它的 id）已不可用 */
function validateItem(value: unknown, index: number, errors: string[]): void {
  const path = `items[${index}]`;
  if (!isObject(value)) {
    errors.push(`${path}: 必须是对象`);
    return;
  }
  if (!isPositiveInteger(value.id)) errors.push(`${path}.id: 必须是正整数`);
  if (!isItemSpace(value.space)) errors.push(`${path}.space: 必须是 "page" 或 "map"`);

  if (value.kind === 'text') validateTextItem(value, path, errors);
  else if (value.kind === 'legend') validateLegendItem(value, path, errors);
  else if (value.kind === 'colorbar') validateColorbarItem(value, path, errors);
  else errors.push(`${path}.kind: 必须是 "text" / "legend" / "colorbar"`);
}

function validateTextItem(item: Record<string, unknown>, path: string, errors: string[]): void {
  if (!isTextRole(item.role)) errors.push(`${path}.role: 必须是合法文字角色`);
  if (!isFiniteNumber(item.x)) errors.push(`${path}.x: 必须是有限数字`);
  if (!isFiniteNumber(item.y)) errors.push(`${path}.y: 必须是有限数字`);
  if (!Array.isArray(item.lines)) {
    errors.push(`${path}.lines: 必须是字符串数组`);
  } else {
    if (item.lines.length < 1 || item.lines.length > PAGE_MAX_TEXT_LINES) {
      errors.push(`${path}.lines: 需要 1..${PAGE_MAX_TEXT_LINES} 行`);
    }
    item.lines.forEach((line, index) => {
      if (typeof line !== 'string') errors.push(`${path}.lines[${index}]: 必须是字符串`);
      else if (line.length > PAGE_MAX_TEXT_LINE_CHARS) {
        errors.push(`${path}.lines[${index}]: 超过 ${PAGE_MAX_TEXT_LINE_CHARS} 字符`);
      }
    });
  }
  if (!isFiniteNumber(item.font_size_pt) || item.font_size_pt <= 0) {
    errors.push(`${path}.font_size_pt: 必须是正数`);
  }
  if (item.font_family !== null && typeof item.font_family !== 'string') {
    errors.push(`${path}.font_family: 必须是字体串或 null`);
  }
  if (!isColor(item.color)) errors.push(`${path}.color: 必须是 #rrggbb`);
  if (!isTextAnchor(item.anchor)) errors.push(`${path}.anchor: 必须是 start/middle/end`);
  if (!isFiniteNumber(item.rotation_deg)) errors.push(`${path}.rotation_deg: 必须是有限数字`);
  if (!isFiniteNumber(item.line_height) || item.line_height <= 0) {
    errors.push(`${path}.line_height: 必须是正数`);
  }
  if (!isBoolean(item.italic)) errors.push(`${path}.italic: 必须是布尔值`);
  if (
    !isFiniteNumber(item.font_weight) ||
    !Number.isInteger(item.font_weight) ||
    item.font_weight < 100 ||
    item.font_weight > 900
  ) {
    errors.push(`${path}.font_weight: 必须是 100..900 的整数`);
  }
  if (
    !isFiniteNumber(item.letter_spacing_em) ||
    item.letter_spacing_em < -1 ||
    item.letter_spacing_em > 2
  ) {
    errors.push(`${path}.letter_spacing_em: 必须是 -1..2 的有限数字`);
  }
  checkHalo(item.halo, `${path}.halo`, errors);
}

function validateLegendItem(item: Record<string, unknown>, path: string, errors: string[]): void {
  for (const key of [
    'x',
    'y',
    'width_pt',
    'font_size_pt',
    'title_size_pt',
    'row_height_pt',
    'padding_pt',
    'swatch_width_pt',
    'swatch_gap_pt',
  ] as const) {
    if (!isFiniteNumber(item[key])) errors.push(`${path}.${key}: 必须是有限数字`);
  }
  if (isFiniteNumber(item.width_pt) && item.width_pt <= 0)
    errors.push(`${path}.width_pt: 必须大于 0`);
  for (const key of ['font_size_pt', 'title_size_pt', 'row_height_pt', 'padding_pt'] as const) {
    const value = item[key];
    if (isFiniteNumber(value) && value < 0) errors.push(`${path}.${key}: 不能为负`);
  }
  if (typeof item.title !== 'string') errors.push(`${path}.title: 必须是字符串`);

  if (!Array.isArray(item.entries)) {
    errors.push(`${path}.entries: 必须是数组`);
  } else {
    item.entries.forEach((entry, index) =>
      validateLegendEntry(entry, `${path}.entries[${index}]`, errors),
    );
  }

  const frame = item.frame;
  if (!isObject(frame)) {
    errors.push(`${path}.frame: 必须是对象`);
  } else {
    if (!isBoolean(frame.show)) errors.push(`${path}.frame.show: 必须是布尔值`);
    if (!isColor(frame.stroke)) errors.push(`${path}.frame.stroke: 必须是 #rrggbb`);
    if (!isFiniteNumber(frame.width_pt) || frame.width_pt <= 0) {
      errors.push(`${path}.frame.width_pt: 必须是正数`);
    }
    if (!isColor(frame.fill)) errors.push(`${path}.frame.fill: 必须是 #rrggbb`);
    if (!isFiniteNumber(frame.opacity) || frame.opacity < 0 || frame.opacity > 1) {
      errors.push(`${path}.frame.opacity: 必须在 0..1`);
    }
  }
}

function validateLegendEntry(entry: unknown, path: string, errors: string[]): void {
  if (!isObject(entry)) {
    errors.push(`${path}: 必须是对象`);
    return;
  }
  if (typeof entry.label !== 'string') errors.push(`${path}.label: 必须是字符串`);
  if (!isLegendShape(entry.shape)) errors.push(`${path}.shape: 必须是 line/rect/point`);
  if (!nullableColor(entry.stroke)) errors.push(`${path}.stroke: 必须是 #rrggbb 或 null`);
  if (!isFiniteNumber(entry.width_pt) || entry.width_pt <= 0) {
    errors.push(`${path}.width_pt: 必须是正数`);
  }
  if (!nullableDash(entry.dash)) errors.push(`${path}.dash: 必须是 null 或 2 个正数`);
  if (!nullableColor(entry.fill)) errors.push(`${path}.fill: 必须是 #rrggbb 或 null`);
  if (!isFiniteNumber(entry.opacity) || entry.opacity < 0 || entry.opacity > 1) {
    errors.push(`${path}.opacity: 必须在 0..1`);
  }
  if (entry.marker !== null && !isLegendMarker(entry.marker)) {
    errors.push(`${path}.marker: 必须是 star/square/circle 或 null`);
  }
}

function validateColorbarItem(item: Record<string, unknown>, path: string, errors: string[]): void {
  for (const key of [
    'x',
    'y',
    'width_pt',
    'height_pt',
    'title_size_pt',
    'label_size_pt',
  ] as const) {
    if (!isFiniteNumber(item[key])) errors.push(`${path}.${key}: 必须是有限数字`);
  }
  for (const key of ['width_pt', 'height_pt', 'title_size_pt', 'label_size_pt'] as const) {
    const value = item[key];
    if (isFiniteNumber(value) && value <= 0) errors.push(`${path}.${key}: 必须大于 0`);
  }
  if (typeof item.title !== 'string') errors.push(`${path}.title: 必须是字符串`);
  if (typeof item.unit !== 'string') errors.push(`${path}.unit: 必须是字符串`);
  if (!isBoolean(item.show_title)) errors.push(`${path}.show_title: 必须是布尔值`);
  if (!isBoolean(item.show_ticks)) errors.push(`${path}.show_ticks: 必须是布尔值`);
}

/**
 * 校验 `page` 块（结构与取值范围，按契约 §4）。
 *
 * @param value 来自上传文件里的 `page` 键（未知 JSON）
 * @param geo 可选：提供时补一条「地图是否完整落在纸张内」的告警（越界只告警不报错）
 */
export function validatePage(value: unknown, geo?: Geo | null): PageValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isObject(value)) {
    return { ok: false, errors: ['page: 必须是 JSON 对象'], warnings };
  }

  const paper = value.paper;

  if (!isObject(paper)) {
    errors.push('paper: 必须是对象');
  } else {
    const presets: readonly string[] = ['A5', 'A4', 'A3', 'Letter', 'Custom'];
    if (typeof paper.preset !== 'string' || !presets.includes(paper.preset)) {
      errors.push('paper.preset: 必须是 A5/A4/A3/Letter/Custom');
    }
    if (paper.orientation !== 'portrait' && paper.orientation !== 'landscape') {
      errors.push('paper.orientation: 必须是 portrait/landscape');
    }
    for (const key of ['width_pt', 'height_pt'] as const) {
      const size = paper[key];
      if (!isFiniteNumber(size)) errors.push(`paper.${key}: 必须是有限数字`);
      else if (size < PAGE_PAPER_MIN_PT || size > PAGE_PAPER_MAX_PT) {
        errors.push(`paper.${key}: 必须在 ${PAGE_PAPER_MIN_PT}..${PAGE_PAPER_MAX_PT}pt`);
      }
    }
  }

  const map = value.map;
  if (!isObject(map)) {
    errors.push('map: 必须是对象');
  } else {
    if (!isFiniteNumber(map.x)) errors.push('map.x: 必须是有限数字');
    if (!isFiniteNumber(map.y)) errors.push('map.y: 必须是有限数字');
    if (!isFiniteNumber(map.width_pt)) errors.push('map.width_pt: 必须是有限数字');
    else if (map.width_pt <= PAGE_MIN_MAP_WIDTH_PT) {
      errors.push(`map.width_pt: 必须大于 ${PAGE_MIN_MAP_WIDTH_PT}`);
    }
  }

  const frame = value.frame;
  if (!isObject(frame)) {
    errors.push('frame: 必须是对象');
  } else {
    if (!isBoolean(frame.show)) errors.push('frame.show: 必须是布尔值');
    if (!isBoolean(frame.ticks)) errors.push('frame.ticks: 必须是布尔值');
    if (!isColor(frame.stroke)) errors.push('frame.stroke: 必须是 #rrggbb');
    if (!isColor(frame.tick_color)) errors.push('frame.tick_color: 必须是 #rrggbb');
    for (const key of ['width_pt', 'tick_length_pt', 'tick_font_size_pt', 'tick_gap_pt'] as const) {
      const entry = frame[key];
      if (!isFiniteNumber(entry) || entry < 0) errors.push(`frame.${key}: 必须是非负数`);
    }
  }

  const style = value.style;
  if (!isObject(style)) {
    errors.push('style: 必须是对象');
  } else {
    if (!isColor(style.paper_color)) errors.push('style.paper_color: 必须是 #rrggbb');
    if (!isColor(style.color)) errors.push('style.color: 必须是 #rrggbb');
    if (typeof style.font_family !== 'string' || style.font_family.trim().length === 0) {
      errors.push('style.font_family: 必须是非空字符串');
    }
  }

  const items = value.items;
  if (!Array.isArray(items)) {
    errors.push('items: 必须是数组');
  } else {
    if (items.length > PAGE_MAX_ITEMS) {
      errors.push(`items: 最多 ${PAGE_MAX_ITEMS} 个（当前 ${items.length}）`);
    }
    const seen = new Set<number>();
    let maxId = 0;
    items.forEach((item, index) => {
      validateItem(item, index, errors);
      if (isObject(item) && isPositiveInteger(item.id)) {
        if (seen.has(item.id)) errors.push(`items[${index}].id: id ${item.id} 重复`);
        seen.add(item.id);
        maxId = Math.max(maxId, item.id);
      }
    });
    if (!isPositiveInteger(value.seq)) {
      errors.push('seq: 必须是正整数');
    } else if (value.seq <= maxId) {
      errors.push(`seq: 必须大于所有 item id（当前 ${value.seq}，最大 id ${maxId}）`);
    }
  }

  // 越界只告警：契约 §4「map.x/y 有限即可（越界只告警）」
  if (
    isObject(paper) &&
    isFiniteNumber(paper.width_pt) &&
    isFiniteNumber(paper.height_pt) &&
    isObject(map) &&
    isFiniteNumber(map.x) &&
    isFiniteNumber(map.y) &&
    isFiniteNumber(map.width_pt)
  ) {
    const ratio =
      geo !== null && geo !== undefined && geo.base.width_pt > 0
        ? geo.base.height_pt / geo.base.width_pt
        : null;
    const mapHeight = ratio === null ? 0 : map.width_pt * ratio;
    if (
      map.x < 0 ||
      map.y < 0 ||
      map.x + map.width_pt > paper.width_pt ||
      map.y + mapHeight > paper.height_pt
    ) {
      warnings.push('地图超出纸张范围（预览会显示在纸外，成品会被裁掉）');
    }
  }

  if (errors.length > 0) return { ok: false, errors, warnings };
  return { ok: true, layout: value as unknown as PageLayout, warnings };
}

/**
 * 校验 geo v2 的一条地名标注（结构 + 取值范围，按契约 §1）。
 * 不校验样式字段：v2 的样式完全由 `config/text-style.ts` 的 role 表决定，产物里不应出现。
 */
function validateGeoLabel(value: unknown, path: string, seen: Set<string>, errors: string[]): void {
  if (!isObject(value)) {
    errors.push(`${path}: 必须是对象`);
    return;
  }
  if (typeof value.id !== 'string' || value.id.length === 0) {
    errors.push(`${path}.id: 必须是非空字符串`);
  } else {
    if (seen.has(value.id)) errors.push(`${path}.id: id "${value.id}" 重复`);
    seen.add(value.id);
  }
  if (!isMapLabelRole(value.role)) {
    errors.push(`${path}.role: 必须是 config/text-style.ts 里的合法地名角色`);
  }
  if (typeof value.text !== 'string') errors.push(`${path}.text: 必须是字符串`);
  if (!isFiniteNumber(value.x)) errors.push(`${path}.x: 必须是有限数字`);
  if (!isFiniteNumber(value.y)) errors.push(`${path}.y: 必须是有限数字`);
  if (!isTextAnchor(value.anchor)) errors.push(`${path}.anchor: 必须是 start/middle/end`);
  if (!isFiniteNumber(value.font_size_pt) || value.font_size_pt <= 0) {
    errors.push(`${path}.font_size_pt: 必须是正数`);
  }
  if (!isFiniteNumber(value.order) || !Number.isInteger(value.order)) {
    errors.push(`${path}.order: 必须是整数`);
  }
}

/**
 * 轻量校验 geo：只查前端渲染默认排版必需的字段，返回错误清单（空 = 可用）。
 * relief/legend/suggestions 是可选块（Cartopy 不画就没有对应的键）：缺省合法，
 * 存在时只做基础结构检查；归一化默认值由 `normalizeGeo` 负责。
 * 注意：这里也负责文件身份（format/version）；`page` 块不在这里校验（见 `validatePage`）。
 */
export function validateGeo(value: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(value)) return ['geo: 顶层必须是 JSON 对象'];
  if (value.format !== PAGE_GEO_FORMAT) errors.push(`geo.format: 必须是 "${PAGE_GEO_FORMAT}"`);
  if (value.version !== PAGE_GEO_VERSION) {
    if (value.version === 1) {
      errors.push('geo.version: 旧 v1 契约，请用更新后的 Cartopy 重新生成');
    } else {
      errors.push(`geo.version: 必须是 ${PAGE_GEO_VERSION}`);
    }
  }
  const base = value.base;
  if (!isObject(base)) {
    errors.push('geo.base: 必须是对象');
  } else {
    const box = base.view_box;
    if (!Array.isArray(box) || box.length !== 4 || !box.every(isFiniteNumber)) {
      errors.push('geo.base.view_box: 必须是 4 个数字');
    }
    if (!isFiniteNumber(base.width_pt) || base.width_pt <= 0) {
      errors.push('geo.base.width_pt: 必须是正数');
    }
    if (!isFiniteNumber(base.height_pt) || base.height_pt <= 0) {
      errors.push('geo.base.height_pt: 必须是正数');
    }
  }
  const graticule = value.graticule;
  if (!isObject(graticule)) {
    errors.push('geo.graticule: 必须是对象');
  } else {
    for (const key of ['lon', 'lat'] as const) {
      const ticks = graticule[key];
      if (!Array.isArray(ticks)) {
        errors.push(`geo.graticule.${key}: 必须是数组`);
        continue;
      }
      ticks.forEach((tick, index) => {
        if (!isObject(tick)) {
          errors.push(`geo.graticule.${key}[${index}]: 必须是对象`);
          return;
        }
        if (!isFiniteNumber(tick.x) || !isFiniteNumber(tick.y)) {
          errors.push(`geo.graticule.${key}[${index}]: x/y 必须是有限数字`);
        }
        if (typeof tick.label !== 'string') {
          errors.push(`geo.graticule.${key}[${index}].label: 必须是字符串`);
        }
        if (!isGraticuleSide(tick.side)) {
          errors.push(`geo.graticule.${key}[${index}].side: 必须是 bottom/top/left/right`);
        }
      });
    }
    // graticule.style 允许缺省（Cartopy 未来可能不写）；存在但类型不对才算错误。
    if (graticule.style !== undefined && graticule.style !== null && !isObject(graticule.style)) {
      errors.push('geo.graticule.style: 必须是对象或 null');
    }
  }
  if (!Array.isArray(value.labels)) {
    errors.push('geo.labels: 必须是数组');
  } else {
    const seen = new Set<string>();
    value.labels.forEach((label, index) =>
      validateGeoLabel(label, `geo.labels[${index}]`, seen, errors),
    );
  }

  // relief / legend / suggestions 是 Cartopy 的可选块：整块缺省合法；块内字段也可能缺省
  // （Cartopy 的 set_suggestions 只写调用方给出的字段，notes/area_annotation 等可能根本没有键），
  // 所以这里只校验「存在但类型不对」的字段，缺省交给 normalizeGeo 补默认值。
  const relief = value.relief;
  if (relief !== undefined && relief !== null) {
    if (!isObject(relief)) {
      errors.push('geo.relief: 必须是对象或 null');
    } else {
      if (relief.stops !== undefined && !Array.isArray(relief.stops)) {
        errors.push('geo.relief.stops: 必须是数组');
      }
      if (relief.vmin !== undefined || relief.vmax !== undefined) {
        if (
          !isFiniteNumber(relief.vmin) ||
          !isFiniteNumber(relief.vmax) ||
          !(relief.vmax > relief.vmin)
        ) {
          errors.push('geo.relief: vmin/vmax 必须是有限数字且 vmax > vmin');
        }
      }
      if (relief.ticks !== undefined && !Array.isArray(relief.ticks)) {
        errors.push('geo.relief.ticks: 必须是数组');
      }
    }
  }
  const legend = value.legend;
  if (legend !== undefined && legend !== null) {
    if (!isObject(legend)) {
      errors.push('geo.legend: 必须是对象或 null');
    } else {
      if (legend.entries !== undefined && !Array.isArray(legend.entries)) {
        errors.push('geo.legend.entries: 必须是数组');
      }
      if (legend.title !== undefined && typeof legend.title !== 'string') {
        errors.push('geo.legend.title: 必须是字符串');
      }
    }
  }
  const suggestions = value.suggestions;
  if (suggestions !== undefined && suggestions !== null) {
    if (!isObject(suggestions)) {
      errors.push('geo.suggestions: 必须是对象或 null');
    } else {
      for (const key of ['notes', 'area_annotation'] as const) {
        if (suggestions[key] !== undefined && !Array.isArray(suggestions[key])) {
          errors.push(`geo.suggestions.${key}: 必须是数组`);
        }
      }
      for (const key of [
        'title',
        'subtitle',
        'source',
        'legend_title',
        'colorbar_title',
      ] as const) {
        if (suggestions[key] !== undefined && typeof suggestions[key] !== 'string') {
          errors.push(`geo.suggestions.${key}: 必须是字符串`);
        }
      }
    }
  }
  return errors;
}

/* =========================== geo 归一化（可选块补默认） =========================== */

/** 空 suggestions：Cartopy 没有默认文案时的全空块（defaultPageLayout 据此不生成标题/注记/来源） */
function emptySuggestions(): GeoSuggestions {
  return {
    title: '',
    subtitle: '',
    notes: [],
    source: '',
    area_annotation: [],
    legend_title: '',
    colorbar_title: '',
  };
}

/** 字符串字段兜底：类型不对就当空串（normalizeGeo 只补齐，不修改合法值） */
function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** 字符串数组兜底：非数组当空数组；元素不是字符串时转成字符串（避免下游 .split 崩） */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => (typeof entry === 'string' ? entry : String(entry)));
}

/**
 * graticule 线型的中性默认值。
 * 为什么需要：`geo.graticule.style` 是 Cartopy 可能不写的可选字段（validateGeo 允许缺省）；
 * 当前渲染并不读取它，但 `Geo` 类型要求字段完整，缺省时补中性值避免下游拿到 undefined。
 */
function neutralGraticuleStyle(): GraticuleStyle {
  return { stroke: '#808080', width_pt: 0.5, dash: [0.5, 0.825], opacity: 1 };
}

/** 归一化 graticule：刻度数组原样保留，只补可能缺省的 style（lon/lat 由 validateGeo 保证） */
function normalizeGraticule(raw: GeoGraticule): GeoGraticule {
  const source: Record<string, unknown> = isObject(raw) ? raw : {};
  const style = isObject(source['style'])
    ? (source['style'] as unknown as GraticuleStyle)
    : neutralGraticuleStyle();
  return {
    lon: (source['lon'] as GeoTick[] | undefined) ?? [],
    lat: (source['lat'] as GeoTick[] | undefined) ?? [],
    style,
  };
}

/**
 * 归一化 relief：结构不完整一律 null。
 * 为什么坏结构不保留：色标依赖 vmax>vmin、stops 至少一条、数值有限；缺任何一项都无法
 * 画出有意义的色标，不如让默认排版不生成色标、让 layout 里的 colorbar 给出明确错误。
 */
function normalizeRelief(raw: unknown): GeoRelief | null {
  if (!isObject(raw)) return null;
  const title = raw.title;
  const unit = raw.unit;
  const vmin = raw.vmin;
  const vmax = raw.vmax;
  const stops = raw.stops;
  if (typeof title !== 'string' || typeof unit !== 'string') return null;
  if (!isFiniteNumber(vmin) || !isFiniteNumber(vmax) || !(vmax > vmin)) return null;
  if (!Array.isArray(stops) || stops.length === 0) return null;
  const normalizedStops: GeoReliefStop[] = [];
  for (const stop of stops) {
    if (!isObject(stop)) return null;
    const offset = stop.offset;
    const color = stop.color;
    if (!isFiniteNumber(offset) || typeof color !== 'string') return null;
    normalizedStops.push({ offset, color });
  }
  const ticks = Array.isArray(raw.ticks) ? raw.ticks.filter(isFiniteNumber) : [];
  return { title, unit, vmin, vmax, stops: normalizedStops, ticks };
}

/** 归一化 legend：缺省/结构坏 → 空图例（标题固定「图例」，defaultPageLayout 不会生图例框） */
function normalizeLegend(raw: unknown): GeoLegend {
  if (!isObject(raw) || !Array.isArray(raw.entries)) return { title: '图例', entries: [] };
  if (!raw.entries.every(isObject)) return { title: '图例', entries: [] };
  return {
    title: stringOr(raw.title, '图例'),
    entries: raw.entries as unknown as GeoLegendEntry[],
  };
}

/** 归一化 suggestions：逐字段兜底（部分字段坏只影响那一项，不整块丢弃） */
function normalizeSuggestions(raw: unknown): GeoSuggestions {
  if (!isObject(raw)) return emptySuggestions();
  return {
    title: stringOr(raw.title, ''),
    subtitle: stringOr(raw.subtitle, ''),
    notes: stringList(raw.notes),
    source: stringOr(raw.source, ''),
    area_annotation: stringList(raw.area_annotation),
    legend_title: stringOr(raw.legend_title, ''),
    colorbar_title: stringOr(raw.colorbar_title, ''),
  };
}

/**
 * 把上传的 geo 收敛成前端可安全消费的形状：可选块补默认值，返回新对象。
 *
 * - legend 缺省/结构坏 → `{title:'图例', entries: []}`（defaultPageLayout 因此不生成空图例框）；
 * - suggestions 缺省/结构坏 → 全空（defaultPageLayout 因此不生成标题/注记/来源）；
 * - relief 缺省/结构坏 → null（defaultPageLayout 因此不生成色标）；
 * - graticule 的 lon/lat 原样保留，style 缺省时补中性值；
 * - base/labels 不补：validateGeo 已要求，缺了属于调用方漏校验。
 * 为什么返回新对象：`PageDocument.geo` 是打开后共享的只读真值，不能与用户上传的原始
 * JSON 共享可变引用。
 */
export function normalizeGeo(raw: Geo): Geo {
  const source: Partial<Geo> = isObject(raw) ? raw : {};
  return {
    format: source.format ?? PAGE_GEO_FORMAT,
    version: source.version ?? PAGE_GEO_VERSION,
    base: source.base as GeoBase,
    graticule: normalizeGraticule(source.graticule as GeoGraticule),
    labels: source.labels ?? [],
    relief: normalizeRelief(source.relief),
    legend: normalizeLegend(source.legend),
    suggestions: normalizeSuggestions(source.suggestions),
  };
}

/* =========================== 查询/编辑辅助 =========================== */

/** 按 id 找元素 */
export function itemById(layout: PageLayout, id: number): PageItem | null {
  return layout.items.find((item) => item.id === id) ?? null;
}

/** 删除元素（按 id），返回是否删到；不处理选中态 */
export function removeItem(layout: PageLayout, id: number): boolean {
  const index = layout.items.findIndex((item) => item.id === id);
  if (index < 0) return false;
  layout.items.splice(index, 1);
  return true;
}

/** 分配一个新的元素 id 并推进 seq（调用方负责把元素插进 items） */
export function allocateItemId(layout: PageLayout): number {
  const id = layout.seq;
  layout.seq += 1;
  return id;
}

/** 走查元素数量（状态栏/标题用） */
export function countItems(layout: PageLayout): number {
  return layout.items.length;
}

/** 元素类型的中文名（UI 列表与状态提示共用） */
export function itemKindLabel(item: PageItem): string {
  switch (item.kind) {
    case 'text':
      return '文字';
    case 'legend':
      return '图例';
    case 'colorbar':
      return '色标';
  }
}

/**
 * 元素的一行摘要（元素列表用）。
 * 为什么放宽到 18 字：侧栏宽度有限，长文本只显示开头，完整内容在属性面板里。
 */
export function itemSummary(item: PageItem): string {
  switch (item.kind) {
    case 'text': {
      const text = item.lines.join(' ').replace(/\s+/g, ' ').trim();
      return text.length > 18 ? `${text.slice(0, 18)}…` : text || '（空文字）';
    }
    case 'legend':
      return `${item.title || '图例'} · ${item.entries.length} 条`;
    case 'colorbar':
      return item.title || '色标';
  }
}
