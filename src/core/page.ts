/**
 * `scene.json` / `geo.json` 的类型、校验、规范化、序列化与摘要（纯逻辑，不碰 DOM）。
 *
 * 是什么：`docs/PAGE-EDITOR.md` §3/§4 的数据契约在 TS 侧的唯一实现——`Scene` 联合类型、
 * `validateScene`（与 `tools/mapdoc/page.py` 同一套约束）、`normalizeScene`（3 位小数）、
 * `serializeScene`（键排序、无空白，供签名/摘要）、`sceneDigest`（SHA-256）。
 * 为什么放在 core 且不碰 DOM：浏览器预览与 Python 合成必须对同一份 scene 得出同一份语义；
 * 浏览器只提交语义值，规范化与校验在两侧各有一份实现，所以必须能在 node 里单测。
 * 注意：`sceneDigest` 用纯 TS SHA-256 实现（不依赖 Web Crypto / node:crypto），
 * 服务器最终写进 marker 的 digest 仍以 Python 侧为准；前端只用它做本地签名比较。
 * 元信息：作者 frontend，2026-10-27，随 `docs/PAGE-EDITOR.md` 新契约落地。
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
  PAGE_SCENE_FORMAT,
  PAGE_SCENE_VERSION,
} from '../config/page';
import type { PaperOrientation, PaperPresetId } from '../config/page';

/* =========================== 基础类型 =========================== */

/** 元素所在坐标空间：page = 纸张坐标（pt）；map = 底图坐标（viewBox 坐标） */
export type ItemSpace = 'page' | 'map';

/** 文字锚点 */
export type TextAnchor = 'start' | 'middle' | 'end';

/** 文字语义角色（只影响默认样式/UI，不参与布局公式） */
export type TextRole = 'title' | 'subtitle' | 'label' | 'annotation' | 'note' | 'source';

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
  /** null = 用 scene.style.font_family */
  font_family: string | null;
  color: string;
  anchor: TextAnchor;
  rotation_deg: number;
  line_height: number;
  italic: boolean;
  bold: boolean;
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

/** 图例元素：高度由 §5.4 公式派生，不落 scene */
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

/** 色标元素：配色/刻度来自 geo.relief，scene 只存摆放与文字 */
export interface ColorbarItem extends ItemBase {
  kind: 'colorbar';
  /** 同 LegendItem.space：Python 合成侧支持 map 空间缩放 */
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

/** scene 里声明的底图身份（服务器用真实底图复核） */
export interface SceneBase {
  sha256: string;
  width_pt: number;
  height_pt: number;
}

/** scene.json 顶层（契约 §4） */
export interface Scene {
  format: typeof PAGE_SCENE_FORMAT;
  version: number;
  /** final 的图路径（figure key 由 URL 查询参数决定，这里是展示/回传用途） */
  figure: string;
  base: SceneBase;
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

/** 地物/地名标注候选（只读；文字由前端渲染） */
export interface GeoLabel {
  id: string;
  kind: string;
  text: string;
  lines: string[];
  x: number;
  y: number;
  rotation_deg: number;
  anchor: TextAnchor;
  font_size_pt: number;
  color: string;
  italic: boolean;
  halo: Halo | null;
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

/** geo.json（§3，只读） */
export interface Geo {
  format: typeof PAGE_GEO_FORMAT;
  version: number;
  base: GeoBase;
  graticule: GeoGraticule;
  labels: GeoLabel[];
  relief: GeoRelief;
  legend: GeoLegend;
  suggestions: GeoSuggestions;
}

/* =========================== 数值与序列化 =========================== */

/** 非有限值（NaN/Infinity）不进 SVG：统一落到 0，避免 NaN 污染字符串 */
const finiteOrZero = (value: number): number => (Number.isFinite(value) ? value : 0);

/**
 * 四舍五入到 `PAGE_DECIMALS` 位小数并归一负零。
 *
 * 为什么是 `Math.round(v*1000)/1000`：Python 合成侧（`tools/mapdoc/render.py`）用
 * `floor(v*1000 + 0.5)/1000` 复刻 JS 语义，避免两侧在 `.xxx5` 边界（如 0.3125）上
 * 得到不同的 3 位小数；这也是「预览与成品同一字节」的硬要求。
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

/** 规范化 scene（3 位小数、新对象）；保存前与摘要前都走它 */
export function normalizeScene(scene: Scene): Scene {
  return roundNumbersDeep(scene);
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
 * 规范化 scene → 键排序、无空白的 JSON 串。
 * 服务器用同一份语义做 sha256；前端用它做「打开后是否改过」的签名比较，
 * 因此必须确定性（键序、数字精度都固定）。
 */
export function serializeScene(scene: Scene): string {
  return JSON.stringify(canonicalValue(normalizeScene(scene)));
}

/** scene 签名：摘要用 3 位小数规范化后的 canonical JSON */
export function sceneDigest(scene: Scene): string {
  return sha256Hex(serializeScene(scene));
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
 * UTF-8 文本的 SHA-256（十六进制小写）。
 * 为什么自己写：core 不能依赖 DOM（Web Crypto 是异步且部分环境不可用），
 * 也不能依赖 node:crypto（浏览器包里不存在）；这个实现只服务本地签名比较。
 */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
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

/* =========================== 校验 =========================== */

/** 校验结果：ok 分支的 scene 已通过结构检查（未规范化） */
export type SceneValidation =
  | { readonly ok: true; readonly scene: Scene; readonly warnings: readonly string[] }
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

const isTextRole = (value: unknown): value is TextRole =>
  value === 'title' ||
  value === 'subtitle' ||
  value === 'label' ||
  value === 'annotation' ||
  value === 'note' ||
  value === 'source';

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

/** 校验 scene.items 里的一个元素；返回 false 表示该元素（或它的 id）已不可用 */
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
  if (!isBoolean(item.bold)) errors.push(`${path}.bold: 必须是布尔值`);
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
 * 校验 scene（结构与取值范围，按契约 §4）。
 *
 * @param value 来自服务器/本地构造的未知 JSON
 * @param geo 可选：提供时补一条「地图是否完整落在纸张内」的告警（越界只告警不报错）
 */
export function validateScene(value: unknown, geo?: Geo | null): SceneValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isObject(value)) {
    return { ok: false, errors: ['scene: 顶层必须是 JSON 对象'], warnings };
  }

  if (value.format !== PAGE_SCENE_FORMAT) errors.push(`format: 必须是 "${PAGE_SCENE_FORMAT}"`);
  if (value.version !== PAGE_SCENE_VERSION) errors.push(`version: 必须是 ${PAGE_SCENE_VERSION}`);
  if (typeof value.figure !== 'string') errors.push('figure: 必须是字符串');

  const base = value.base;
  if (!isObject(base)) {
    errors.push('base: 必须是对象');
  } else {
    if (typeof base.sha256 !== 'string' || base.sha256.length === 0) {
      errors.push('base.sha256: 必须是非空字符串');
    }
    if (!isFiniteNumber(base.width_pt) || base.width_pt <= 0) {
      errors.push('base.width_pt: 必须是正数');
    }
    if (!isFiniteNumber(base.height_pt) || base.height_pt <= 0) {
      errors.push('base.height_pt: 必须是正数');
    }
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
    const ratio = baseRatio(geo, base);
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
  return { ok: true, scene: value as unknown as Scene, warnings };
}

/**
 * 底图纵横比（height/width）：优先用 geo.base，其次用 scene.base。
 * 返回 null 表示参数不足以派生高度。
 */
function baseRatio(geo: Geo | null | undefined, base: unknown): number | null {
  if (geo && geo.base.width_pt > 0) return geo.base.height_pt / geo.base.width_pt;
  if (isObject(base)) {
    const width = base.width_pt;
    const height = base.height_pt;
    if (isFiniteNumber(width) && isFiniteNumber(height) && width > 0) return height / width;
  }
  return null;
}

/** 轻量校验 geo：只查前端渲染默认排版必需的字段，返回错误清单（空 = 可用） */
export function validateGeo(value: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(value)) return ['geo: 顶层必须是 JSON 对象'];
  if (value.format !== PAGE_GEO_FORMAT) errors.push(`geo.format: 必须是 "${PAGE_GEO_FORMAT}"`);
  if (value.version !== PAGE_GEO_VERSION) errors.push(`geo.version: 必须是 ${PAGE_GEO_VERSION}`);
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
  }
  if (!Array.isArray(value.labels)) errors.push('geo.labels: 必须是数组');
  if (!isObject(value.relief)) errors.push('geo.relief: 必须是对象');
  if (!isObject(value.legend)) errors.push('geo.legend: 必须是对象');
  if (!isObject(value.suggestions)) errors.push('geo.suggestions: 必须是对象');
  return errors;
}

/* =========================== 查询/编辑辅助 =========================== */

/** 按 id 找元素 */
export function itemById(scene: Scene, id: number): PageItem | null {
  return scene.items.find((item) => item.id === id) ?? null;
}

/** 删除元素（按 id），返回是否删到；不处理选中态 */
export function removeItem(scene: Scene, id: number): boolean {
  const index = scene.items.findIndex((item) => item.id === id);
  if (index < 0) return false;
  scene.items.splice(index, 1);
  return true;
}

/** 分配一个新的元素 id 并推进 seq（调用方负责把元素插进 items） */
export function allocateItemId(scene: Scene): number {
  const id = scene.seq;
  scene.seq += 1;
  return id;
}

/** 走查元素数量（状态栏/标题用） */
export function countItems(scene: Scene): number {
  return scene.items.length;
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
