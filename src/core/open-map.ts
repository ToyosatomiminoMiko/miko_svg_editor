/**
 * 「打开地图」的纯逻辑:上传文件 -> `OpenedMap`(文档 + 初始排版 + 脏标记 + 告警)
 * (纯逻辑,不碰 DOM).
 *
 * 是什么:只支持两条打开路径,最终都固化成同一份 `PageDocument`:
 * 1. `base.svg + geo.json`:Cartopy 直出的两份文件(page 块缺省 -> 默认排版);
 * 2. 只上传一份**本编辑器导出的成品 SVG**:内嵌了整份 geo.json 与底图前后缀,单文件即可
 *    恢复排版并继续编辑(见 `core/final-svg.ts`).
 * 旧版本导出的成品(没有内嵌可编辑源)不再支持:底图字节无法还原成可编辑文档,一律拒绝并
 * 提示用 `base.svg + geo.json` 重新打开,重新导出,避免半还原的「假文档」继续流传.
 * 为什么放在 core 而不是组合根:分栏,UTF-8 解码,格式校验,layout 恢复,sha/marker 对照
 * 全是纯逻辑,放在这里可以在 node 里单测;`app/page-main.ts` 只负责把 `File` 读成字节,
 * 装配编辑器与展示中文错误.
 * 打开口径(详见 `docs/PAGE-EDITOR.md` §8):core 严格解码 UTF-8(保留 BOM,保证重编码后
 * sha/逐字节还原仍成立;JSON 在 parse 前单独去掉 BOM);geo 校验 format/字段;底图 C1–C4;
 * sha256 / viewBox / 尺寸一致;`page` 块缺省 -> 默认排版(标脏),存在且合法 -> 恢复排版并把
 * 每条文字样式按分类重建一遍(不一致则标脏 + 告警),把 `center_h` 居中项按纸张宽度重新贴合,
 * 不合法只告警并回退默认排版.
 * 元信息:作者 ToyosatomiminoMiko,2026-11-05.
 */

import { PAGE_GEO_FORMAT } from '../config/page';
import { readBaseSvg } from './base-svg';
import { classifyUploadFile, createPageDocument, type PageDocument } from './document';
import { readFinalSvg, reconstructFinalBase, type FinalSvgInfo } from './final-svg';
import {
  enforceHorizontalCenter,
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
import { defaultPageLayout, enforceAutoWrap } from './page-layout';
import { resyncTextStyles } from './text-style';
import type { MeasureText } from './types';

/** 一个上传文件的原始字节与文件名(core 不认识 `File`/DOM,UTF-8 解码也在 core 内做) */
export interface MapUploadFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/**
 * 严格 UTF-8 解码,且**保留 BOM**(`ignoreBOM: true`).
 * 为什么不像默认那样剥掉 BOM:底图 sha256 是对原始字节算的,剥掉后重编码会少 3 字节,
 * 带 BOM 的底图会误报「与 geo.json 不配套」;保留 U+FEFF 后 `TextEncoder` 能原样还原.
 * 坏字节直接拒绝:有损文本会让 sha256 与切片都不可信.
 * JSON 需要单独去 BOM(`JSON.parse` 不接受 U+FEFF),见 `stripBom`.
 */
function decodeUtf8(bytes: Uint8Array, fileName: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (cause) {
    throw new Error(`${fileName} 不是合法的 UTF-8 文本`, { cause });
  }
}

/** 去掉开头的 UTF-8 BOM 字符(U+FEFF);JSON.parse 不接受它 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 打开选项:默认版式折行/图例宽度需要文本测量器 */
export interface OpenMapOptions {
  readonly measureText?: MeasureText;
}

/** 打开来源:底图 + geo.json / 成品 SVG 单文件(旧版成品已不再支持) */
export type OpenedMapSource = 'base' | 'final';

/** 一次成功打开得到的全部状态 */
export interface OpenedMap {
  readonly document: PageDocument;
  /** 初始排版:来自 page 块(恢复)或 defaultPageLayout(默认版式) */
  readonly layout: PageLayout;
  /** 是否有未导出的修改:没有 page 块 / page 块不合法 / 导入了不能合成的元素时为 true */
  readonly dirty: boolean;
  readonly source: OpenedMapSource;
  readonly warnings: readonly string[];
}

/** 上传说明:多处错误文案共用 */
const UPLOAD_HINT = '需要配套的 base.svg + geo.json,或本编辑器导出的成品 SVG';

/** 把未知值收窄成「非 null 的普通对象」 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 解析好格式的 geo 文档(还没做字段校验/归一化) */
interface ParsedGeo {
  readonly fileName: string;
  readonly value: unknown;
}

/** 解析 JSON 文本并确认是单文件地图文档(`format=mapdoc-geo`) */
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
      `${fileName} 是旧版 scene.json:排版已并入 geo.json,请改用 Cartopy 产出的 geo.json(或本编辑器导出的 geo.json)`,
    );
  }
  if (format !== PAGE_GEO_FORMAT) {
    throw new Error(`${fileName} 不是 geo.json(format 必须是 ${PAGE_GEO_FORMAT}).${UPLOAD_HINT}`);
  }
  return { fileName, value };
}

/** 校验并归一化 geo;错误一次性给出前几条(中文) */
function checkedGeo(parsed: ParsedGeo): Geo {
  const errors = validateGeo(parsed.value);
  if (errors.length > 0) {
    throw new Error(`geo.json 校验失败:${errors.slice(0, 3).join(';')}`);
  }
  return normalizeGeo(parsed.value as Geo);
}

/** geo 文档顶层的可选 `page` 块(没有就是 null -> 默认排版) */
function pageValueOf(parsed: ParsedGeo): unknown {
  return isRecord(parsed.value) ? (parsed.value[MAP_DOC_PAGE_KEY] ?? null) : null;
}

/**
 * 是否是旧版 pt 口径的 page 块(本版不再兼容,静默回退默认排版).
 *
 * 为什么单独识别:旧 page 块的 paper 用 `width_pt/height_pt`,item 带 `space`/`*_pt` 字段;
 * 这些字段在新契约里都不存在,校验必然失败.旧文件不迁移也不该用「page 块不合法」的告警
 * 制造噪音(用户已确认不向后兼容),所以这一类直接当「没有 pages 块」处理.
 * 注意只认 pt/space 这类结构性旧字段:其它不合法 page 块仍然告警(用户能知道排版丢了).
 */
function isLegacyPtPage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const paper = value['paper'];
  if (isRecord(paper)) {
    if (typeof paper['width_pt'] === 'number' || typeof paper['height_pt'] === 'number') {
      return true;
    }
  }
  const items = value['items'];
  if (!Array.isArray(items)) return false;
  return items.some(
    (item) =>
      isRecord(item) &&
      (Object.hasOwn(item, 'space') ||
        Object.hasOwn(item, 'wrap_width_pt') ||
        Object.hasOwn(item, 'font_size_pt')),
  );
}

/**
 * 生成初始排版:page 块存在且通过校验就用它(已导出态,不标脏),否则回退默认排版(标脏).
 *
 * page 块不合法不拒绝整个文件:地理数据仍然可用,用户只是丢了一次排版;
 * 给出告警并回退默认版式,比「文件打不开」更可恢复.旧 pt 口径 page 块除外(不迁移,不告警).
 */
function buildPageLayout(
  geo: Geo,
  pageValue: unknown,
  measureText: MeasureText | undefined,
): { layout: PageLayout; dirty: boolean; warnings: string[] } {
  const warnings: string[] = [];
  const makeDefault = (): PageLayout => defaultPageLayout(geo, { measureText });
  let layout: PageLayout;
  let dirty: boolean;
  if (pageValue === null || pageValue === undefined || isLegacyPtPage(pageValue)) {
    layout = makeDefault();
    dirty = true;
  } else {
    const result = validatePage(pageValue, geo);
    if (!result.ok) {
      warnings.push(
        `geo.json 里的 page 排版块不合法,已改用默认排版:${result.errors.slice(0, 3).join(';')}`,
      );
      layout = makeDefault();
      dirty = true;
    } else {
      // 先保留原始形状,等 resync/居中约束统计完「改动了什么」再统一 normalize,
      // 否则 normalizePage 内部就会把 x 纠回中心,打开告警里说不清是哪一步改的.
      layout = result.layout;
      warnings.push(...result.warnings);
      dirty = false;
    }
  }

  // page 块里的文字样式必须由分类重算:item 上的字段只是分类样式的物化结果,旧版本导出
  // 或手改过的文件可能残留逐条不同的样式,不重建就会绕过「分类统一」设置.
  // 两条恢复路径(page 块,成品内嵌源)都会经过这里,所以只需调一次.
  const resynced = resyncTextStyles(layout, geo);
  if (resynced > 0) {
    warnings.push(`旧排版中的逐条文字样式已按分类设置统一(${resynced} 条),导出后会写成新口径`);
    dirty = true;
  }

  // 左右居中约束是派生值:手改过的 page 块里 x 可能偏离纸张中心,打开时按当前纸张宽度
  // 重新贴合(与样式重建分开告警,用户能分清「样式被统一」和「位置被约束纠正」).
  const recentered = enforceHorizontalCenter(layout);
  if (recentered > 0) {
    warnings.push(`排版中的左右居中约束已按纸张宽度重新贴合(${recentered} 条),导出后会写成新口径`);
    dirty = true;
  }

  // 注记/来源自动折行是派生量:缺 text/wrap_width_mm 或手改过 lines,
  // 打开时按当前字号/字距与存储宽度统一重排;与样式统一/居中纠偏分开告警.
  const rewrapped = enforceAutoWrap(layout, measureText);
  if (rewrapped > 0) {
    warnings.push(`排版中的注记/来源已按折行宽度自动重排(${rewrapped} 条),导出后会写成新口径`);
    dirty = true;
  }

  // 最后统一数值口径(3 位小数 + 居中约束再兜底一次),与导出/签名完全一致.
  layout = normalizePage(layout);

  // geo 没有 relief(Cartopy 不画色标)时,排版里的 colorbar 无法合成:
  // 预览会静默跳过,导出 SVG 会抛「色标需要 geo.relief」.与其让用户到导出时才看到失败,
  // 不如在导入时移除并明确告警;保持其他元素位置不变(不触发重排).
  if (geo.relief === null) {
    const colorbars = layout.items.filter((item) => item.kind === 'colorbar');
    if (colorbars.length > 0) {
      layout.items = layout.items.filter((item) => item.kind !== 'colorbar');
      warnings.push(
        `该底图的 geo 没有 relief 色标数据,已移除排版中的 ${colorbars.length} 个色标元素`,
      );
      dirty = true;
    }
  }
  return { layout, dirty, warnings };
}

/** 检查一批上传文件的分栏,返回唯一的 SVG 与至多一个 JSON */
interface UploadBatches {
  readonly svg: MapUploadFile;
  readonly json: readonly MapUploadFile[];
}

function bucketUploads(files: readonly MapUploadFile[]): UploadBatches {
  if (files.length === 0) {
    throw new Error(`没有收到文件:请选择或拖入 base.svg 与 geo.json(也可以只拖一份成品 SVG)`);
  }
  const svgs: MapUploadFile[] = [];
  const jsons: MapUploadFile[] = [];
  const unknown: string[] = [];
  for (const file of files) {
    // .svg 后缀可能装两种内容:Cartopy 底图或本编辑器的成品(由内容再判).
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
    throw new Error(`不识别的文件:${unknown.join(',')}.只接受 .svg 与 .json`);
  }
  const svg = svgs[0];
  if (svg === undefined) {
    throw new Error(`缺少 .svg:请选择底图 .svg 或本编辑器导出的成品 SVG`);
  }
  if (svgs.length > 1) {
    throw new Error(
      `只能上传一个 .svg(收到了 ${svgs.length} 个:${svgs.map((item) => item.name).join(',')})`,
    );
  }
  if (jsons.length > 1) {
    throw new Error(
      `只能上传一个 geo.json(收到了 ${jsons.length} 个:${jsons.map((item) => item.name).join(',')})`,
    );
  }
  return { svg, json: jsons };
}

/** 底图 + geo.json(原有路径) */
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
 * marker.page 是否与当前排版一致.
 * 只按当前 `pageDigest` 比较:旧口径摘要的成品属于已删除的迁移链路,不再放宽校验
 * (否则会打开「样式与当前分类口径不一致」的旧文件,回到统一设置之前的状态).
 */
function markerPageMatches(markerPage: string, layout: PageLayout): boolean {
  return markerPage === pageDigest(layout);
}

/**
 * marker 与文档摘要对照(单文件路径):不一致只告警,因为内嵌源才是可编辑真值;
 * 外部工具改过成品时 marker 可能停留在旧值,此时仍应允许打开,由用户重新导出.
 */
function markerWarnings(final: FinalSvgInfo, geo: Geo, layout: PageLayout): string[] {
  const marker = final.marker;
  if (marker === null) {
    return ['成品 SVG 缺少尾部 marker:无法校验内嵌排版与渲染内容是否一致(文件可能经外部工具改写)'];
  }
  const warnings: string[] = [];
  if (marker.geo !== geoDigest(geo)) {
    warnings.push('成品 SVG 的 marker 与内嵌 geo 摘要不一致(文件可能被外部修改过)');
  }
  if (!markerPageMatches(marker.page, layout)) {
    warnings.push('成品 SVG 的 marker 与内嵌排版摘要不一致(文件可能被外部修改过)');
  }
  return warnings;
}

/** 只上传一份本编辑器导出的成品 SVG(内嵌源 + 底图前后缀) */
function openFromFinalOnly(
  svgFileName: string,
  svgText: string,
  measureText: MeasureText | undefined,
): OpenedMap {
  const final = readFinalSvg(svgText);
  if (!final.is_final) {
    throw new Error(
      `缺少 geo.json:请把与底图配套的 geo.json 一起上传;也可以只上传一份本编辑器导出的成品 SVG(自带排版)`,
    );
  }
  if (final.errors.length > 0) {
    throw new Error(`成品 SVG 的内嵌排版数据不可用:${final.errors.slice(0, 3).join(';')}`);
  }
  const source = final.source;
  if (source === null) {
    throw new Error(
      '这份成品 SVG 不含内嵌可编辑源(旧版本导出或被其它工具改写),不再支持打开:请用对应的 base.svg + geo.json 重新打开并重新导出',
    );
  }
  const parsed = parseGeoDocument(source.documentText, `${svgFileName} 的内嵌 geo.json`);
  const geo = checkedGeo(parsed);
  const built = buildPageLayout(geo, pageValueOf(parsed), measureText);
  const reconstruct = reconstructFinalBase(final);
  if (reconstruct === null) {
    throw new Error('无法从成品 SVG 定位底图图层(mapdoc-map):文件可能被改写');
  }
  // 内嵌前后缀就是原始底图字节,sha256 必须成立(失败即文件被改过或配错 geo).
  const document = createPageDocument(svgFileName, reconstruct, geo);
  // 内嵌源声明的底图摘要也必须与还原结果一致:两者任一不符都说明文件被改过.
  if (document.baseSha256 !== source.baseSha256) {
    throw new Error('成品 SVG 的内嵌底图摘要与还原结果不一致:文件可能被修改');
  }
  const warnings = [
    ...document.base.warnings,
    ...built.warnings,
    ...final.warnings,
    ...markerWarnings(final, geo, built.layout),
  ];
  return {
    document,
    layout: built.layout,
    dirty: built.dirty,
    source: 'final',
    warnings,
  };
}

/**
 * 成品自带内嵌源,但用户又额外选了 geo.json:内嵌源是渲染内容的真值,优先用它;
 * 所选 JSON 只做交叉校验.
 * 为什么不再走 marker.page 全量配对:Cartopy 原始 geo.json 没有 `page` 块,
 * 而「成品 + 该 geo」其实等价于只打开成品(底图身份相同),旧实现会因 page 缺失误拒.
 * 若所选 JSON 带排版且与成品不一致,仍必须拒绝:那多半是配错了文件,继续打开会得到假文档.
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
      if (
        marker.geo !== geoDigest(providedGeo) ||
        !markerPageMatches(marker.page, providedLayout)
      ) {
        throw new Error(
          '所选的 geo.json 与这份成品 SVG 不配套(marker 摘要不一致):请选择导出该 SVG 时同时导出的 geo.json,或只打开成品 SVG',
        );
      }
    } else {
      if (marker.geo !== geoDigest(providedGeo)) {
        throw new Error(
          '所选的 geo.json 与这份成品 SVG 不配套(geo 摘要不一致):请选择与成品对应的 geo.json,或只打开成品 SVG',
        );
      }
      notices.push('所选 geo.json 不含 page 排版:已改用成品 SVG 自带的排版');
    }
  } else {
    notices.push('成品 SVG 缺少 marker,无法校验所选 geo.json 是否配套:已改用成品 SVG 自带的排版');
  }
  const opened = openFromFinalOnly(svgFileName, svgText, measureText);
  return { ...opened, warnings: [...notices, ...opened.warnings] };
}

/**
 * 打开一次「地图」:分类 -> 校验 -> 文档 + 排版.
 *
 * 分派规则(只按内容,不按文件名):
 * - 先按「底图 + geo」校验 SVG;不是底图但含成品痕迹时才走成品路径;
 * - 成品自带内嵌源:优先用内嵌排版(有 JSON 时只交叉校验,带 page 且不一致才拒绝);
 * - 成品没有内嵌源:必须带配套 geo.json(旧版迁移路径);
 * - 没有 JSON 且 SVG 不是自带内嵌源的成品:提示补 geo.json.
 * 任何失败都抛出可直接展示的中文 Error.
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
    throw new Error(`底图不符合契约:${base.errors.slice(0, 3).join(';')}`);
  }
  // 内嵌源齐全时优先用内嵌排版(所选 JSON 只交叉校验);没有内嵌源即旧版成品,一律拒绝.
  if (final.source === null) {
    throw new Error(
      '这份成品 SVG 是旧版本导出的(没有内嵌可编辑源),不再支持打开:请用对应的 base.svg + geo.json 重新打开并重新导出',
    );
  }
  return openFromFinalWithProvidedGeo(batches.svg.name, svgText, final, parsed, measureText);
}
