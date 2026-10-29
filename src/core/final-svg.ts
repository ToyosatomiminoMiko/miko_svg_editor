/**
 * 成品 SVG（`<stem>.svg`）的再编辑支持：读取内嵌可编辑源、定位内联底图、还原底图原文
 * （纯逻辑，不碰 DOM）。
 *
 * 是什么：`readFinalSvg(text)` 识别本编辑器合成的成品——`<g id="mapdoc-map">` 图层、
 * `<metadata id="mapdoc-source">` 内嵌源与尾部 `<!-- mapdoc-final:… -->` marker，
 * 解出「导出时的 geo.json 原文 + 底图前后缀」、内联底图原文与 marker 摘要；
 * `reconstructFinalBase(final, geo.base)` 把底图字节还原出来（内嵌前缀/后缀齐全时逐字节一致；
 * 旧版成品没有内嵌源时用 geo.base 合成一个外壳，`exact=false`）。
 * 为什么需要它：用户只想再编辑「已经编辑并导出过的成品 SVG」，不想每次都被要求找齐
 * `base.svg + geo.json` 两份源文件。成品里本来就内联了底图内容，导出时再把
 * 整份 geo.json 与底图前后缀写进 `<metadata>`，就能单文件往返、且排版/字节完全一致。
 * 为什么前缀/后缀只存几十字节：底图可能接近 10 MB，整份再存一遍会让成品体积翻倍；
 * 内联的 `inner` 已在 `mapdoc-map` 组里，补上 XML 声明/根起始标签与收尾即可逐字节还原。
 * 为什么还要 marker 校验：内嵌源与渲染内容是同一次合成的两个产物，用 marker 里的
 * geo/page 摘要对照能发现文件被外部工具改过或配错 geo.json。
 * 元信息：作者 lead，2026-10-29，新增「成品 SVG 可直接再编辑」数据流（见 docs/PAGE-EDITOR.md §6.2/§8）。
 */

import {
  PAGE_FINAL_MARKER_VERSION,
  PAGE_FINAL_SOURCE_FORMAT,
  PAGE_FINAL_SOURCE_VERSION,
} from '../config/page';
import { decodeBase64Utf8 } from './base64';
import { findTagEnd } from './base-svg';
import type { GeoBase } from './page';

/** 成品里内嵌源所在的 `<metadata>` id（与 compose 写出的一致） */
export const FINAL_SOURCE_METADATA_ID = 'mapdoc-source';
/** 成品里内联底图的图层 id */
const FINAL_MAP_GROUP_ID = 'mapdoc-map';
/** 排版叠加层痕迹：用于把「成品」与「底图」区分开 */
const FINAL_OVERLAY_MARK = 'mapdoc-overlay';
/** 尾部 marker 痕迹 */
const FINAL_MARKER_MARK = 'mapdoc-final';

/** 尾部 marker 的计数块（与 compose 的 report 同形状；解析失败时为 null） */
export interface FinalMarkerCounts {
  readonly text: number;
  readonly legend: number;
  readonly colorbar: number;
  readonly total: number;
}

/** 尾部 `<!-- mapdoc-final:… -->` 解出的内容（§6.1） */
export interface FinalMarker {
  readonly version: number;
  /** geoDigest(geo) */
  readonly geo: string;
  /** pageDigest(layout) */
  readonly page: string;
  readonly counts: FinalMarkerCounts | null;
}

/** 内嵌的可编辑源（§6.2）：从 `<metadata id="mapdoc-source">` 解出 */
export interface FinalSource {
  /** 导出时 `serializeMapDocFile` 的原文（整份 geo.json：geo 块 + page 块） */
  readonly documentText: string;
  /** 底图原文中 `inner` 之前的字节（XML 声明 + 根起始标签） */
  readonly basePrefix: string;
  /** 底图原文中 `inner` 之后的字节（最后一个 `</svg>` 及其后的收尾） */
  readonly baseSuffix: string;
  /** 导出时 `document.baseSha256`：prefix+inner+suffix 还原出的底图字节摘要 */
  readonly baseSha256: string;
  /**
   * prefix/suffix 是否来自原始底图（true），还是旧版成品迁移时用 `geo.base` 合成（false）。
   * 为什么必须落盘：合成的外壳字节与原 `base.svg` 不同，`geo.base.sha256` 校验会不成立；
   * 重开时只有知道这个标志才能改用「与内嵌 baseSha256 对照」而不是误报不配套。
   */
  readonly exact: boolean;
}

/** 一次成品 SVG 解析的完整结果（errors 只针对内嵌源；marker 问题进 warnings） */
export interface FinalSvgInfo {
  /** 是否识别为本编辑器合成的成品（图层/marker/内嵌源任一命中） */
  readonly is_final: boolean;
  /** 内嵌可编辑源；不是成品、没有该 metadata 或数据损坏时为 null */
  readonly source: FinalSource | null;
  /** 尾部 marker；缺失或无法解析时为 null */
  readonly marker: FinalMarker | null;
  /** `mapdoc-map` 组的原文（= 导出时的底图 `inner`）；定位失败为 null */
  readonly base_inner: string | null;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

/** 把未知值收窄成「非 null 的普通对象」 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 从 `start` 处读取标签名（遇到空白、`/`、`>` 结束）；不合法时返回 '' */
function tagNameAt(text: string, start: number): string {
  let end = start;
  while (end < text.length) {
    const code = text.charCodeAt(end);
    const isNameChar =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 58 ||
      code === 45 ||
      code === 95;
    if (!isNameChar) break;
    end += 1;
  }
  return text.slice(start, end);
}

/** 找到 `</g>` 的结束位置（`>` 下标）；找不到返回 -1 */
function findMapGroupClose(text: string, openTagEnd: number): number {
  let depth = 1;
  let index = openTagEnd + 1;
  while (index < text.length) {
    const start = text.indexOf('<', index);
    if (start < 0) return -1;
    // 注释 / CDATA / 处理指令里的 `<g` 不是元素，整段跳过。
    if (text.startsWith('<!--', start)) {
      const end = text.indexOf('-->', start + 4);
      if (end < 0) return -1;
      index = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', start)) {
      const end = text.indexOf(']]>', start + 9);
      if (end < 0) return -1;
      index = end + 3;
      continue;
    }
    const tagEnd = findTagEnd(text, start);
    if (tagEnd < 0) return -1;
    if (text.charCodeAt(start + 1) === 47) {
      // 结束标签：只有 `</g>` 影响嵌套深度。
      if (tagNameAt(text, start + 2) === 'g') {
        depth -= 1;
        if (depth === 0) return tagEnd;
      }
    } else if (text.charCodeAt(start + 1) !== 63 && text.charCodeAt(start + 1) !== 33) {
      // `<!DOCTYPE…>` / `<?…?>` 不算元素；其余是起始标签，只有 <g> 影响深度。
      const selfClosing = text.charCodeAt(tagEnd - 1) === 47;
      if (!selfClosing && tagNameAt(text, start + 1) === 'g') depth += 1;
    }
    index = tagEnd + 1;
  }
  return -1;
}

/** 定位成品里 `<g id="mapdoc-map">` 的开标签起点；找不到返回 -1 */
function findMapGroupOpen(text: string): number {
  const literal = text.indexOf(`<g id="${FINAL_MAP_GROUP_ID}"`);
  if (literal >= 0) {
    const following = text.charCodeAt(literal + `<g id="${FINAL_MAP_GROUP_ID}"`.length);
    if (following === 32 || following === 9 || following === 62) return literal;
  }
  // 兜底：属性顺序被改写过也认（`[^>]*` 只覆盖不含 `>` 的起始标签，g 标签属性足够）。
  const pattern = new RegExp(`<g\\s[^>]*\\bid="${FINAL_MAP_GROUP_ID}"(?=[\\s>])`);
  const match = pattern.exec(text);
  return match === null ? -1 : match.index;
}

/** 取出 `mapdoc-map` 组内的原文；定位失败返回 null */
function locateBaseInner(text: string): string | null {
  const openStart = findMapGroupOpen(text);
  if (openStart < 0) return null;
  const openTagEnd = findTagEnd(text, openStart);
  if (openTagEnd < 0) return null;
  const closeTagEnd = findMapGroupClose(text, openTagEnd);
  if (closeTagEnd < 0) return null;
  const closeStart = text.lastIndexOf('<', closeTagEnd);
  if (closeStart <= openTagEnd) return null;
  return text.slice(openTagEnd + 1, closeStart);
}

/** 读取内嵌可编辑源；坏数据只记 errors 并返回 null（不抛，交给调用方统一展示） */
function readSource(text: string, errors: string[]): FinalSource | null {
  const pattern = new RegExp(
    `<metadata\\s+id="${FINAL_SOURCE_METADATA_ID}"\\s*>([\\s\\S]*?)</metadata>`,
  );
  const match = pattern.exec(text);
  if (match === null) return null;
  const encoded = match[1] ?? '';
  let payload: unknown;
  try {
    payload = JSON.parse(decodeBase64Utf8(encoded));
  } catch (cause) {
    errors.push(`内嵌排版数据无法解码：${cause instanceof Error ? cause.message : String(cause)}`);
    return null;
  }
  if (!isRecord(payload) || payload['format'] !== PAGE_FINAL_SOURCE_FORMAT) {
    errors.push(`内嵌排版数据的 format 必须是 ${PAGE_FINAL_SOURCE_FORMAT}`);
    return null;
  }
  if (payload['version'] !== PAGE_FINAL_SOURCE_VERSION) {
    errors.push(
      `内嵌排版数据版本不受支持（需要 ${PAGE_FINAL_SOURCE_VERSION}，实际 ${String(payload['version'])}）`,
    );
    return null;
  }
  const documentText = payload['document'];
  const base = payload['base'];
  if (typeof documentText !== 'string' || !isRecord(base)) {
    errors.push('内嵌排版数据缺少 document/base 字段');
    return null;
  }
  const basePrefix = base['prefix'];
  const baseSuffix = base['suffix'];
  const baseSha256 = base['sha256'];
  const exact = base['exact'];
  if (typeof basePrefix !== 'string' || typeof baseSuffix !== 'string') {
    errors.push('内嵌排版数据缺少底图前后缀（base.prefix/base.suffix）');
    return null;
  }
  if (typeof baseSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(baseSha256)) {
    errors.push('内嵌排版数据缺少合法的底图摘要（base.sha256）');
    return null;
  }
  if (typeof exact !== 'boolean') {
    errors.push('内嵌排版数据缺少底图来源标志（base.exact）');
    return null;
  }
  return { documentText, basePrefix, baseSuffix, baseSha256, exact };
}

/** 读取尾部 marker；缺失返回 null，损坏记 warning 并返回 null */
function readMarker(text: string, warnings: string[]): FinalMarker | null {
  const pattern = /<!--\s*mapdoc-final:([A-Za-z0-9+/=\s]+?)\s*-->/;
  const match = pattern.exec(text);
  if (match === null) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(decodeBase64Utf8(match[1] ?? ''));
  } catch (cause) {
    warnings.push(
      `成品 SVG 的 marker 无法解析：${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return null;
  }
  if (!isRecord(payload)) {
    warnings.push('成品 SVG 的 marker 不是对象');
    return null;
  }
  const geo = payload['geo'];
  const page = payload['page'];
  if (typeof geo !== 'string' || typeof page !== 'string') {
    warnings.push('成品 SVG 的 marker 缺少 geo/page 摘要');
    return null;
  }
  const version = payload['version'];
  return {
    version: typeof version === 'number' ? version : 0,
    geo,
    page,
    counts: readMarkerCounts(payload['counts']),
  };
}

/** marker 的 counts 四键都是非负整数才收；否则 null（只用于展示/校验，不参与打开） */
function readMarkerCounts(value: unknown): FinalMarkerCounts | null {
  if (!isRecord(value)) return null;
  const keys = ['text', 'legend', 'colorbar', 'total'] as const;
  const counts: Partial<Record<(typeof keys)[number], number>> = {};
  for (const key of keys) {
    const entry = value[key];
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 0) return null;
    counts[key] = entry;
  }
  return {
    text: counts.text ?? 0,
    legend: counts.legend ?? 0,
    colorbar: counts.colorbar ?? 0,
    total: counts.total ?? 0,
  };
}

/**
 * 解析一份成品 SVG。
 * 为什么 `is_final` 用三个痕迹任一判断：正常情况下三者同时存在；但用户可能在外部工具里
 * 删掉注释（marker）或 metadata，只要还剩下 `mapdoc-overlay` / `mapdoc-map` 就该走成品流程，
 * 而不是把整份成品当底图（那会被 C2/C4 拒绝并给出令人困惑的「底图不符合契约」）。
 */
export function readFinalSvg(text: string): FinalSvgInfo {
  const errors: string[] = [];
  const warnings: string[] = [];
  const baseInner = locateBaseInner(text);
  const source = readSource(text, errors);
  const marker = readMarker(text, warnings);
  if (marker !== null && marker.version !== PAGE_FINAL_MARKER_VERSION) {
    warnings.push(
      `成品 SVG 的 marker 版本是 ${marker.version}（当前 ${PAGE_FINAL_MARKER_VERSION}），摘要口径可能不同`,
    );
  }
  const isFinal =
    baseInner !== null ||
    source !== null ||
    marker !== null ||
    text.includes(FINAL_OVERLAY_MARK) ||
    text.includes(FINAL_MARKER_MARK);
  return { is_final: isFinal, source, marker, base_inner: baseInner, errors, warnings };
}

/** 还原出来的底图原文与它的可信度 */
export interface FinalBaseText {
  /** 完整底图 SVG 文本（可直接交给 `createPageDocument`） */
  readonly text: string;
  /**
   * true = 前缀/后缀来自成品内嵌源，字节与导出时的底图完全一致（sha256 应成立）；
   * false = 旧版成品没有内嵌源，用 geo.base 合成外壳（只有 inner 可信，sha256 不成立）。
   */
  readonly exact: boolean;
}

/**
 * 从成品还原底图原文。
 * 为什么旧版要合成外壳：内联的 `inner` 就是底图根标签内的全部内容，缺的只是 XML 声明、
 * 根起始标签（含 viewBox）与收尾；geo.base 已经记录了 viewBox/宽高，可以拼出可渲染的外壳，
 * 让预览与再次合成都能用。返回 null 表示连 `mapdoc-map` 组都定位不到（不是本编辑器的成品）。
 */
export function reconstructFinalBase(final: FinalSvgInfo, geoBase: GeoBase): FinalBaseText | null {
  const inner = final.base_inner;
  if (inner === null) return null;
  if (final.source !== null) {
    return {
      text: `${final.source.basePrefix}${inner}${final.source.baseSuffix}`,
      exact: final.source.exact,
    };
  }
  const [x, y, width, height] = geoBase.view_box;
  const header =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ' +
    `width="${geoBase.width_pt}pt" height="${geoBase.height_pt}pt" ` +
    `viewBox="${x} ${y} ${width} ${height}">`;
  return { text: `${header}${inner}</svg>\n`, exact: false };
}
