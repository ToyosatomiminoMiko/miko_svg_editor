/**
 * 成品字体内嵌的「纯逻辑」部分:选哪些面要嵌,以及把子集字体写成 `<style>@font-face</style>`.
 *
 * 是什么:`FontAssetSpec` 描述一份内置字体资产覆盖的族名与字重区间;`selectFontAssets`
 * 按成品实际用到的字体族/字重挑出要嵌的面;`sfntFormatOf` 从字节认出 TrueType 还是
 * OpenType(CFF);`renderEmbeddedFontStyle` 把子集字体字节编码成 base64 并拼成 CSS.
 * 为什么放在 render 层:`@font-face` 的 CSS 文本会原样写进成品 SVG,字节确定性由本层负责
 * (族名引号,字重区间,`format()` 提示都必须固定);选面规则与画布/预览无关,是输出口径.
 * 为什么只嵌「内置资产」里有的族:浏览器读不到系统字体字节,只能用随包资产裁字;自定义
 * 字体串(手改 JSON)没有资产可裁,由调用方告警并保持「只写 font-family」的旧行为.
 * 元信息:作者 ToyosatomiminoMiko,2026-11-07.
 */

import { SYSTEM_FALLBACK_FAMILIES } from '../config/fonts';
import { encodeBase64Bytes } from '../core/base64';
import type { UsedText } from './used-text';

/** 一份可内嵌的字体资产:族名 + 它覆盖的字重区间(区间按 `@font-face` 的语义解释) */
export interface FontAssetSpec {
  /** 与成品里 `font-family` 字符串里的族名完全一致 */
  readonly family: string;
  /** 覆盖的最小字重(含) */
  readonly weight_min: number;
  /** 覆盖的最大字重(含) */
  readonly weight_max: number;
}

/** 待写入成品的一份字体面:族名 + 字重区间 + 已裁好的子集字体字节 */
export interface EmbeddedFontFace {
  readonly family: string;
  readonly weight_min: number;
  readonly weight_max: number;
  readonly bytes: Uint8Array;
}

/** 字体文件的 sfnt 版本标识(前 4 字节) */
const SFNT_TRUE_TYPE = 0x00010000;
const SFNT_TRUE_TYPE_APPLE = 0x74727565; // 'true'
const SFNT_OPEN_TYPE = 0x4f54544f; // 'OTTO'
const SFNT_TYPE1 = 0x74797031; // 'typ1'

/**
 * 通用字体族:CSS 关键字与项目字体栈里的系统等宽兜底,没有可嵌的字体文件,也不算
 * 「自定义字体」;成品里它们本来就在 `font-family` 栈末尾,查看端自己有就用.
 */
const GENERIC_FAMILIES: ReadonlySet<string> = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'emoji',
  'math',
  'fangsong',
  ...SYSTEM_FALLBACK_FAMILIES,
]);

/**
 * 从字体字节认出 `@font-face` 的 `format()` 值.
 * 为什么按 sfnt 首 4 字节判断:woff/woff2 是容器,不能直接内嵌(查看器不一定能解 brotli);
 * 我们能拿到并裁的只有 sfnt(TrueType 的 `glyf` 或 OpenType 的 `CFF`/`CFF2`).
 */
export function sfntFormatOf(bytes: Uint8Array): 'truetype' | 'opentype' {
  if (bytes.byteLength < 4) throw new Error('字体字节不足 4 字节');
  const tag =
    ((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0);
  if (tag === SFNT_OPEN_TYPE) return 'opentype';
  if (tag === SFNT_TRUE_TYPE || tag === SFNT_TRUE_TYPE_APPLE || tag === SFNT_TYPE1) {
    return 'truetype';
  }
  throw new Error(`不是可内嵌的字体字节(sfnt 版本 0x${tag.toString(16)})`);
}

/**
 * 按成品实际用到的族名/字重挑出要内嵌的资产.
 * 规则:族名被引用 -> 每个用到的字重挑「该族里离它最近的一份资产」;字重落在资产区间内时
 * 区间本身就会命中(CJK 可变面 400..700 一份通吃),静态面(400/600/700 各一份)则按距离选,
 * 与 CSS 字重匹配「取最近可用面」的语义一致.未引用通用族/自定义族不在这里处理.
 */
export function selectFontAssets(
  used: UsedText,
  assets: readonly FontAssetSpec[],
): readonly FontAssetSpec[] {
  const chosen = new Set<FontAssetSpec>();
  for (const family of used.families) {
    const candidates = assets.filter((asset) => asset.family === family);
    if (candidates.length === 0) continue;
    for (const weight of used.weights) {
      const nearest = nearestAsset(candidates, weight);
      if (nearest !== null) chosen.add(nearest);
    }
  }
  return [...chosen];
}

/** 距离字重最近的一份资产;距离相同取字重更低的一份(与 CSS 的 <400/<=500 规则同向) */
function nearestAsset(candidates: readonly FontAssetSpec[], weight: number): FontAssetSpec | null {
  let best: FontAssetSpec | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance =
      weight < candidate.weight_min
        ? candidate.weight_min - weight
        : weight > candidate.weight_max
          ? weight - candidate.weight_max
          : 0;
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * 成品里引用了,但不在内置资产里的非通用字体族(自定义字体串).
 * 这些字族没法内嵌,成品只能按旧口径只写 `font-family`,由查看端本机字体决定字形.
 */
export function customFamiliesOf(
  used: UsedText,
  assets: readonly FontAssetSpec[],
): readonly string[] {
  const known = new Set(assets.map((asset) => asset.family));
  return used.families.filter((family) => !known.has(family) && !GENERIC_FAMILIES.has(family));
}

/**
 * 把字体面写成成品 `<defs>` 里的 `<style>` 元素;没有字体面时返回空串.
 *
 * 为什么用 CDATA:SVG 是 XML,`<style>` 里的 CSS 若含 `&`/`<` 会被当成标记;base64 虽然
 * 不含这些字符,但统一用 CDATA 可以避免以后改 CSS 时踩坑,也与旧 Python 实现的产物同构.
 * 为什么带一行许可注释:两份字体都是 SIL OFL 1.1,条款要求分发字体软件时附带版权/许可
 * 声明;成品里的子集也是字体软件的一部分,注释里写明来源与许可.
 * 元信息:作者 ToyosatomiminoMiko,2026-11-07.
 */
export function renderEmbeddedFontStyle(faces: readonly EmbeddedFontFace[]): string {
  if (faces.length === 0) return '';
  const families = [...new Set(faces.map((face) => face.family))];
  const licence =
    '/* 内嵌字体子集仅含本图用到的字形: ' +
    families.map((family) => `${family} (SIL OFL 1.1)`).join(', ') +
    '. */';
  const rules = faces.map((face) => renderFontFaceRule(face));
  return `<style type="text/css"><![CDATA[\n${licence}\n${rules.join('\n')}\n]]></style>\n`;
}

/** 一条 `@font-face` 规则(属性顺序固定,保证成品字节可复现) */
function renderFontFaceRule(face: EmbeddedFontFace): string {
  const format = sfntFormatOf(face.bytes);
  const mime = format === 'opentype' ? 'font/otf' : 'font/ttf';
  const weight =
    face.weight_min === face.weight_max
      ? String(face.weight_min)
      : `${face.weight_min} ${face.weight_max}`;
  const base64 = encodeBase64Bytes(face.bytes);
  return (
    '@font-face { ' +
    `font-family: ${cssString(face.family)}; ` +
    'font-style: normal; ' +
    `font-weight: ${weight}; ` +
    `src: url("data:${mime};base64,${base64}") format("${format}"); ` +
    '}'
  );
}

/** CSS 字符串字面量:双引号包裹,转义反斜杠与双引号(CSS 里换行非法,这里直接去掉) */
function cssString(value: string): string {
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', ' ');
  return `"${escaped}"`;
}
