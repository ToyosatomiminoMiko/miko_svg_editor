/**
 * 「打开地图」的纯逻辑：上传文件 → `OpenedMap`（文档 + 初始排版 + 脏标记 + 告警）
 * （纯逻辑，不碰 DOM）。
 *
 * 是什么：支持三条打开路径，最终都固化成同一份 `PageDocument`：
 * 1. `base.svg + geo.json`：Cartopy 直出的两份文件（原有路径）；
 * 2. 只上传一份**本编辑器导出的成品 SVG**：内嵌了整份 geo.json 与底图前后缀，单文件即可
 *    恢复排版并继续编辑（见 `core/final-svg.ts`）；
 * 3. 成品 SVG + 配套 `geo.json`：旧版本导出的成品没有内嵌源，用成品内联的底图图层 +
 *    所选 geo.json 重新拼出可编辑文档（底图字节无法逐字节还原，会明确告警）。
 * 为什么放在 core 而不是组合根：分栏、UTF-8 解码、格式校验、layout 恢复、sha/marker 对照
 * 全是纯逻辑，放在这里可以在 node 里单测三条路径；`app/page-main.ts` 只负责把 `File` 读成
 * 字节、装配编辑器与展示中文错误。
 * 打开口径（详见 `docs/PAGE-EDITOR.md` §8）：core 严格解码 UTF-8（保留 BOM，保证重编码后
 * sha/逐字节还原仍成立；JSON 在 parse 前单独去掉 BOM）；geo 校验 format/字段；底图 C1–C4；
 * sha256 / viewBox / 尺寸一致（成品合成的底图外壳例外，见上）；
 * `page` 块缺省 → 默认排版（标脏），存在且合法 → 恢复排版，不合法只告警并回退默认排版。
 * 元信息：作者 lead，2026-10-29，从 `app/page-main.ts` 抽出并新增成品 SVG 两条打开路径。
 */

import { PAGE_GEO_FORMAT } from '../config/page';
import { readBaseSvg } from './base-svg';
import { classifyUploadFile, createPageDocument, type PageDocument } from './document';
import { readFinalSvg, reconstructFinalBase, type FinalSvgInfo } from './final-svg';
import {
  geoDigest,
  MAP_DOC_PAGE_KEY,
  normalizeGeo,
  normalizePage,
  pageDigest,
  validateGeo,
  validatePage,
  type Geo,
  type PageLayout,
} from './page';
import { defaultPageLayout } from './page-layout';
import type { MeasureText } from './types';

/** 一个上传文件的原始字节与文件名（core 不认识 `File`/DOM，UTF-8 解码也在 core 内做） */
export interface MapUploadFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/**
 * 严格 UTF-8 解码，且**保留 BOM**（`ignoreBOM: true`）。
 * 为什么不像默认那样剥掉 BOM：底图 sha256 是对原始字节算的，剥掉后重编码会少 3 字节，
 * 带 BOM 的底图会误报「与 geo.json 不配套」；保留 U+FEFF 后 `TextEncoder` 能原样还原。
 * 坏字节直接拒绝：有损文本会让 sha256 与切片都不可信。
 * JSON 需要单独去 BOM（`JSON.parse` 不接受 U+FEFF），见 `stripBom`。
 */
function decodeUtf8(bytes: Uint8Array, fileName: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (cause) {
    throw new Error(`${fileName} 不是合法的 UTF-8 文本`, { cause });
  }
}

/** 去掉开头的 UTF-8 BOM 字符（U+FEFF）；JSON.parse 不接受它 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 打开选项：默认版式折行/图例宽度需要文本测量器 */
export interface OpenMapOptions {
  readonly measureText?: MeasureText;
}

/** 打开来源：底图 + geo / 成品 SVG 单文件 / 成品 SVG + geo.json */
export type OpenedMapSource = 'base' | 'final' | 'final-with-geo';

/** 一次成功打开得到的全部状态 */
export interface OpenedMap {
  readonly document: PageDocument;
  /** 初始排版：来自 page 块（恢复）或 defaultPageLayout（默认版式） */
  readonly layout: PageLayout;
  /** 是否有未导出的修改：没有 page 块 / page 块不合法 / 导入了不能合成的元素时为 true */
  readonly dirty: boolean;
  readonly source: OpenedMapSource;
  readonly warnings: readonly string[];
}

/** 上传说明：多处错误文案共用 */
const UPLOAD_HINT = '需要配套的 base.svg + geo.json，或本编辑器导出的成品 SVG';

/** 把未知值收窄成「非 null 的普通对象」 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 解析好格式的 geo 文档（还没做字段校验/归一化） */
interface ParsedGeo {
  readonly fileName: string;
  readonly value: unknown;
}

/** 解析 JSON 文本并确认是单文件地图文档（`format=mapdoc-geo`） */
function parseGeoDocument(text: string, fileName: string): ParsedGeo {
  let value: unknown;
  try {
    value = JSON.parse(stripBom(text)) as unknown;
  } catch (cause) {
    throw new Error(`${fileName} 不是合法的 JSON`, { cause });
  }
  const format = isRecord(value) ? value['format'] : undefined;
  if (format === 'mapdoc-page') {
    throw new Error(
      `${fileName} 是旧版 scene.json：排版已并入 geo.json，请改用 Cartopy 产出的 geo.json（或本编辑器导出的 geo.json）`,
    );
  }
  if (format !== PAGE_GEO_FORMAT) {
    throw new Error(
      `${fileName} 不是 geo.json（format 必须是 ${PAGE_GEO_FORMAT}）。${UPLOAD_HINT}`,
    );
  }
  return { fileName, value };
}

/** 校验并归一化 geo；错误一次性给出前几条（中文） */
function checkedGeo(parsed: ParsedGeo): Geo {
  const errors = validateGeo(parsed.value);
  if (errors.length > 0) {
    throw new Error(`geo.json 校验失败：${errors.slice(0, 3).join('；')}`);
  }
  return normalizeGeo(parsed.value as Geo);
}

/** geo 文档顶层的可选 `page` 块（没有就是 null → 默认排版） */
function pageValueOf(parsed: ParsedGeo): unknown {
  return isRecord(parsed.value) ? (parsed.value[MAP_DOC_PAGE_KEY] ?? null) : null;
}

/**
 * 生成初始排版：page 块存在且通过校验就用它（已导出态，不标脏），否则回退默认排版（标脏）。
 *
 * page 块不合法不拒绝整个文件：地理数据仍然可用，用户只是丢了一次排版；
 * 给出告警并回退默认版式，比「文件打不开」更可恢复。
 */
function buildPageLayout(
  geo: Geo,
  pageValue: unknown,
  measureText: MeasureText | undefined,
): { layout: PageLayout; dirty: boolean; warnings: string[] } {
  const warnings: string[] = [];
  const makeDefault = (): PageLayout => defaultPageLayout(geo, { measureText });
  if (pageValue === null || pageValue === undefined) {
    return { layout: makeDefault(), dirty: true, warnings };
  }
  const result = validatePage(pageValue, geo);
  let layout: PageLayout;
  let dirty: boolean;
  if (!result.ok) {
    warnings.push(
      `geo.json 里的 page 排版块不合法，已改用默认排版：${result.errors.slice(0, 3).join('；')}`,
    );
    layout = makeDefault();
    dirty = true;
  } else {
    layout = normalizePage(result.layout);
    warnings.push(...result.warnings);
    dirty = false;
  }

  // geo 没有 relief（Cartopy 不画色标）时，排版里的 colorbar 无法合成：
  // 预览会静默跳过、导出 SVG 会抛「色标需要 geo.relief」。与其让用户到导出时才看到失败，
  // 不如在导入时移除并明确告警；保持其他元素位置不变（不触发重排）。
  if (geo.relief === null) {
    const colorbars = layout.items.filter((item) => item.kind === 'colorbar');
    if (colorbars.length > 0) {
      layout.items = layout.items.filter((item) => item.kind !== 'colorbar');
      warnings.push(
        `该底图的 geo 没有 relief 色标数据，已移除排版中的 ${colorbars.length} 个色标元素`,
      );
      dirty = true;
    }
  }
  return { layout, dirty, warnings };
}

/** 检查一批上传文件的分栏，返回唯一的 SVG 与至多一个 JSON */
interface UploadBatches {
  readonly svg: MapUploadFile;
  readonly json: readonly MapUploadFile[];
}

function bucketUploads(files: readonly MapUploadFile[]): UploadBatches {
  if (files.length === 0) {
    throw new Error(`没有收到文件：请选择或拖入 base.svg 与 geo.json（也可以只拖一份成品 SVG）`);
  }
  const svgs: MapUploadFile[] = [];
  const jsons: MapUploadFile[] = [];
  const unknown: string[] = [];
  for (const file of files) {
    // .svg 后缀可能装两种内容：Cartopy 底图或本编辑器的成品（由内容再判）。
    switch (classifyUploadFile(file.name)) {
      case 'base':
        svgs.push(file);
        break;
      case 'geo':
      case 'json':
        jsons.push(file);
        break;
      case 'unknown':
        unknown.push(file.name);
        break;
    }
  }
  if (unknown.length > 0) {
    throw new Error(`不识别的文件：${unknown.join('、')}。只接受 .svg 与 .json`);
  }
  const svg = svgs[0];
  if (svg === undefined) {
    throw new Error(`缺少 .svg：请选择底图 .svg 或本编辑器导出的成品 SVG`);
  }
  if (svgs.length > 1) {
    throw new Error(
      `只能上传一个 .svg（收到了 ${svgs.length} 个：${svgs.map((item) => item.name).join('、')}）`,
    );
  }
  if (jsons.length > 1) {
    throw new Error(
      `只能上传一个 geo.json（收到了 ${jsons.length} 个：${jsons.map((item) => item.name).join('、')}）`,
    );
  }
  return { svg, json: jsons };
}

/** 底图 + geo.json（原有路径） */
function openFromBaseAndGeo(
  svgFileName: string,
  svgText: string,
  parsed: ParsedGeo,
  measureText: MeasureText | undefined,
): OpenedMap {
  const geo = checkedGeo(parsed);
  const built = buildPageLayout(geo, pageValueOf(parsed), measureText);
  const document = createPageDocument(svgFileName, svgText, geo);
  return {
    document,
    layout: built.layout,
    dirty: built.dirty,
    source: 'base',
    warnings: [...document.base.warnings, ...built.warnings],
  };
}

/**
 * marker 与文档摘要对照（单文件路径）：不一致只告警，因为内嵌源才是可编辑真值；
 * 外部工具改过成品时 marker 可能停留在旧值，此时仍应允许打开、由用户重新导出。
 */
function markerWarnings(final: FinalSvgInfo, geo: Geo, layout: PageLayout): string[] {
  const marker = final.marker;
  if (marker === null) {
    return [
      '成品 SVG 缺少尾部 marker：无法校验内嵌排版与渲染内容是否一致（文件可能经外部工具改写）',
    ];
  }
  const warnings: string[] = [];
  if (marker.geo !== geoDigest(geo)) {
    warnings.push('成品 SVG 的 marker 与内嵌 geo 摘要不一致（文件可能被外部修改过）');
  }
  if (marker.page !== pageDigest(layout)) {
    warnings.push('成品 SVG 的 marker 与内嵌排版摘要不一致（文件可能被外部修改过）');
  }
  return warnings;
}

/**
 * marker 与**所选 geo.json** 对照（成品 + geo 路径）：这里不一致必须拒绝——
 * 用户明确给了另一份 JSON，若摘要对不上，极可能是拿错了配套文件，继续打开会得到
 * 「底图/排版互相错位」的假文档，比报错更难恢复。
 */
function assertMarkerPairing(final: FinalSvgInfo, geo: Geo, layout: PageLayout): void {
  const marker = final.marker;
  if (marker === null) return;
  if (marker.geo !== geoDigest(geo) || marker.page !== pageDigest(layout)) {
    throw new Error(
      '所选的 geo.json 与这份成品 SVG 不配套（marker 摘要不一致）：请选择导出该 SVG 时同时导出的 geo.json',
    );
  }
}

/** 只上传一份本编辑器导出的成品 SVG（内嵌源 + 底图前后缀） */
function openFromFinalOnly(
  svgFileName: string,
  svgText: string,
  measureText: MeasureText | undefined,
): OpenedMap {
  const final = readFinalSvg(svgText);
  if (!final.is_final) {
    throw new Error(
      `缺少 geo.json：请把与底图配套的 geo.json 一起上传；也可以只上传一份本编辑器导出的成品 SVG（自带排版）`,
    );
  }
  if (final.errors.length > 0) {
    throw new Error(`成品 SVG 的内嵌排版数据不可用：${final.errors.slice(0, 3).join('；')}`);
  }
  const source = final.source;
  if (source === null) {
    throw new Error(
      '这份成品 SVG 不含内嵌排版数据（旧版本导出或被其它工具改写）：请把当时导出的 geo.json 一起上传（成品 SVG + geo.json），或改用 base.svg + geo.json 打开',
    );
  }
  const parsed = parseGeoDocument(source.documentText, `${svgFileName} 的内嵌 geo.json`);
  const geo = checkedGeo(parsed);
  const built = buildPageLayout(geo, pageValueOf(parsed), measureText);
  const reconstruct = reconstructFinalBase(final, geo.base);
  if (reconstruct === null) {
    throw new Error('无法从成品 SVG 定位底图图层（mapdoc-map）：文件可能被改写');
  }
  // exact=true：前后缀来自原始底图，还原字节必须与 geo.base.sha256 一致；
  // exact=false：旧版迁移时合成外壳，字节必然不同，只能对照内嵌 base.sha256。
  const document = createPageDocument(svgFileName, reconstruct.text, geo, {
    verifyBaseSha256: reconstruct.exact,
  });
  const warnings = [
    ...document.base.warnings,
    ...built.warnings,
    ...final.warnings,
    ...markerWarnings(final, geo, built.layout),
  ];
  if (!reconstruct.exact) {
    if (document.baseSha256 !== source.baseSha256) {
      throw new Error('成品 SVG 的内嵌底图摘要与还原结果不一致：文件可能被修改');
    }
    warnings.push(
      '成品内嵌底图是旧版迁移时合成的外壳（与原 base.svg 字节不同），不影响继续编辑与导出',
    );
  }
  return {
    document,
    layout: built.layout,
    dirty: built.dirty,
    source: 'final',
    warnings,
  };
}

/** 成品 SVG + 配套 geo.json（仅旧版成品：没有内嵌源） */
function openFromFinalWithGeo(
  svgFileName: string,
  final: FinalSvgInfo,
  parsed: ParsedGeo,
  measureText: MeasureText | undefined,
): OpenedMap {
  const geo = checkedGeo(parsed);
  const built = buildPageLayout(geo, pageValueOf(parsed), measureText);
  const warnings = [...final.warnings];
  assertMarkerPairing(final, geo, built.layout);
  const reconstruct = reconstructFinalBase(final, geo.base);
  if (reconstruct === null) {
    throw new Error('无法从成品 SVG 定位底图图层（mapdoc-map）：文件可能被改写');
  }
  const document = createPageDocument(svgFileName, reconstruct.text, geo, {
    verifyBaseSha256: false,
  });
  warnings.push(
    '成品 SVG 没有内嵌排版数据（旧版导出）：底图按 geo.base 合成外壳，字节与原 base.svg 不同；再导出会补上内嵌源',
  );
  return {
    document,
    layout: built.layout,
    dirty: built.dirty,
    source: 'final-with-geo',
    warnings: [...document.base.warnings, ...built.warnings, ...warnings],
  };
}

/**
 * 成品自带内嵌源、但用户又额外选了 geo.json：内嵌源是渲染内容的真值，优先用它；
 * 所选 JSON 只做交叉校验。
 * 为什么不再走 marker.page 全量配对：Cartopy 原始 geo.json 没有 `page` 块，
 * 而「成品 + 该 geo」其实等价于只打开成品（底图身份相同），旧实现会因 page 缺失误拒。
 * 若所选 JSON 带排版且与成品不一致，仍必须拒绝：那多半是配错了文件，继续打开会得到假文档。
 */
function openFromFinalWithProvidedGeo(
  svgFileName: string,
  svgText: string,
  final: FinalSvgInfo,
  parsed: ParsedGeo,
  measureText: MeasureText | undefined,
): OpenedMap {
  const providedGeo = checkedGeo(parsed);
  const hasPage = pageValueOf(parsed) !== null;
  const marker = final.marker;
  const notices: string[] = [];
  if (marker !== null) {
    if (hasPage) {
      const providedLayout = buildPageLayout(providedGeo, pageValueOf(parsed), measureText).layout;
      if (marker.geo !== geoDigest(providedGeo) || marker.page !== pageDigest(providedLayout)) {
        throw new Error(
          '所选的 geo.json 与这份成品 SVG 不配套（marker 摘要不一致）：请选择导出该 SVG 时同时导出的 geo.json，或只打开成品 SVG',
        );
      }
    } else {
      if (marker.geo !== geoDigest(providedGeo)) {
        throw new Error(
          '所选的 geo.json 与这份成品 SVG 不配套（geo 摘要不一致）：请选择与成品对应的 geo.json，或只打开成品 SVG',
        );
      }
      notices.push('所选 geo.json 不含 page 排版：已改用成品 SVG 自带的排版');
    }
  } else {
    notices.push('成品 SVG 缺少 marker，无法校验所选 geo.json 是否配套：已改用成品 SVG 自带的排版');
  }
  const opened = openFromFinalOnly(svgFileName, svgText, measureText);
  return { ...opened, warnings: [...notices, ...opened.warnings] };
}

/**
 * 打开一次「地图」：分类 → 校验 → 文档 + 排版。
 *
 * 分派规则（只按内容，不按文件名）：
 * - 先按「底图 + geo」校验 SVG；不是底图但含成品痕迹时才走成品路径；
 * - 成品自带内嵌源：优先用内嵌排版（有 JSON 时只交叉校验，带 page 且不一致才拒绝）；
 * - 成品没有内嵌源：必须带配套 geo.json（旧版迁移路径）；
 * - 没有 JSON 且 SVG 不是自带内嵌源的成品：提示补 geo.json。
 * 任何失败都抛出可直接展示的中文 Error。
 */
export function openMapFromUploads(
  files: readonly MapUploadFile[],
  options: OpenMapOptions = {},
): OpenedMap {
  const batches = bucketUploads(files);
  const measureText = options.measureText;
  const svgText = decodeUtf8(batches.svg.bytes, batches.svg.name);
  const geoUpload = batches.json[0];
  if (geoUpload === undefined) {
    return openFromFinalOnly(batches.svg.name, svgText, measureText);
  }
  const geoText = decodeUtf8(geoUpload.bytes, geoUpload.name);
  const parsed = parseGeoDocument(geoText, geoUpload.name);
  const base = readBaseSvg(svgText);
  if (base.errors.length === 0) {
    return openFromBaseAndGeo(batches.svg.name, svgText, parsed, measureText);
  }
  const final = readFinalSvg(svgText);
  if (!final.is_final) {
    throw new Error(`底图不符合契约：${base.errors.slice(0, 3).join('；')}`);
  }
  // 自带内嵌源时优先用内嵌排版（所选 JSON 只交叉校验）；没有内嵌源才走旧版迁移路径。
  if (final.source !== null) {
    return openFromFinalWithProvidedGeo(batches.svg.name, svgText, final, parsed, measureText);
  }
  return openFromFinalWithGeo(batches.svg.name, final, parsed, measureText);
}
