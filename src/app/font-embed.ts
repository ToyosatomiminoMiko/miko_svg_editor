/**
 * 成品导出的字体子集内嵌(浏览器侧实现):把成品里实际用到的字形裁成子集并交给合成层.
 *
 * 是什么:`embedUsedFontFaces(svg)` 接收「还没嵌字体的成品 SVG」,扫出实际用到的字符与
 * 字体族/字重,用随包的字体资产 + harfbuzz wasm 裁出每份字体面,返回可以直接交给
 * `composeFinalSvg` 的 `font_faces`;拿不到资产/裁字失败时返回空面 + 中文告警,让成品
 * 退回「只写 font-family」的旧口径.
 * 为什么在这里(`app` 层):取 wasm 与字体资产要 `fetch`/`WebAssembly`,属于浏览器能力;
 * 裁字算法(`render/hb-subset.ts`)与 CSS 拼装(`render/embedded-font.ts`)都不碰网络/DOM,
 * 可以留在纯逻辑层在 node 里单测.
 * 为什么要预裁资产而不是读系统字体:浏览器没有「读已安装字体字节」的 API;随包的
 * `src/assets/fonts/` 是开发期用 `scripts/build_font_assets.py` 从同一套字体裁出的预裁件.
 * 元信息:作者 ToyosatomiminoMiko,2026-11-07.
 */

import wasmUrl from 'harfbuzzjs/dist/harfbuzz-subset.wasm?url';
import jetBrainsRegularUrl from '../assets/fonts/JetBrainsMonoSlashed-Regular.ttf?url';
import jetBrainsSemiBoldUrl from '../assets/fonts/JetBrainsMonoSlashed-SemiBold.ttf?url';
import jetBrainsBoldUrl from '../assets/fonts/JetBrainsMonoSlashed-Bold.ttf?url';
import notoCjkUrl from '../assets/fonts/NotoSansMonoCJKsc-VF.otf?url';
import { CJK_FONT_FAMILY, LATIN_FONT_FAMILY } from '../config/fonts';
import {
  customFamiliesOf,
  selectFontAssets,
  sfntFormatOf,
  type EmbeddedFontFace,
  type FontAssetSpec,
} from '../render/embedded-font';
import { createSubsetter, type FontSubsetter } from '../render/hb-subset';
import { collectUsedText } from '../render/used-text';

/** 一份随包字体资产:覆盖范围 + 资源 URL(由 Vite 的 `?url` 给出) */
interface FontAsset {
  readonly spec: FontAssetSpec;
  readonly url: string;
}

/**
 * 随包字体资产表.
 * 拉丁侧是三个静态面(与 miko_ui 随包的 400/600/700 woff2 同源);中文侧是一份可变面
 * (wght 400..700),页面文字目前只用到 400,但样式覆盖允许 100..900,可变面一份通吃.
 */
const FONT_ASSETS: readonly FontAsset[] = [
  {
    spec: { family: LATIN_FONT_FAMILY, weight_min: 400, weight_max: 400 },
    url: jetBrainsRegularUrl,
  },
  {
    spec: { family: LATIN_FONT_FAMILY, weight_min: 600, weight_max: 600 },
    url: jetBrainsSemiBoldUrl,
  },
  { spec: { family: LATIN_FONT_FAMILY, weight_min: 700, weight_max: 700 }, url: jetBrainsBoldUrl },
  { spec: { family: CJK_FONT_FAMILY, weight_min: 400, weight_max: 700 }, url: notoCjkUrl },
];

/** 一次内嵌的结果:要交给合成层的字体面 + 需要展示给用户的告警 */
export interface FontEmbedResult {
  readonly faces: readonly EmbeddedFontFace[];
  readonly warnings: readonly string[];
}

/** 已实例化的子集器(wasm 编译一次,多次导出复用);失败时置回 null 以便下次重试 */
let subsetterPromise: Promise<FontSubsetter> | null = null;

/** 资产字节缓存:同一份 URL 只取一次 */
const fontBytesCache = new Map<string, Promise<Uint8Array>>();

/**
 * 把成品里用到的字形裁成子集字体面.
 * 为什么分两步调用(`composeFinalSvg` -> 本函数 -> 再 `composeFinalSvg`):先合成一次才能
 * 知道「实际画出来的字符」(来自 items/图例/色标/刻度等多个来源),第二次合成把
 * `<style>@font-face</style>` 放进 `<defs>`;两次合成除字体外完全相同,字节可复现.
 */
export async function embedUsedFontFaces(svg: string): Promise<FontEmbedResult> {
  const used = collectUsedText(svg);
  if (used.chars.length === 0) return { faces: [], warnings: [] };

  const specs = FONT_ASSETS.map((asset) => asset.spec);
  const chosen = selectFontAssets(used, specs);
  const warnings: string[] = [];
  const custom = customFamiliesOf(used, specs);
  if (custom.length > 0) {
    warnings.push(
      `字体族 ${custom.join(', ')} 不在内置字体资产里:成品只写 font-family,字形由查看端本机字体决定`,
    );
  }
  if (chosen.length === 0) return { faces: [], warnings };

  try {
    const subsetter = await loadSubsetter();
    const faces: EmbeddedFontFace[] = [];
    for (const spec of chosen) {
      const asset = FONT_ASSETS.find((candidate) => candidate.spec === spec);
      if (asset === undefined) throw new Error(`缺少字体资产:${spec.family}`);
      const bytes = await loadFontBytes(asset.url);
      // 资产必须是 sfnt(woff/woff2 容器内嵌不进去,查看器不一定能解 brotli).
      sfntFormatOf(bytes);
      faces.push({
        family: spec.family,
        weight_min: spec.weight_min,
        weight_max: spec.weight_max,
        bytes: subsetter.subset(bytes, used.chars),
      });
    }
    return { faces: sortFaces(faces, used.families), warnings };
  } catch (error) {
    warnings.push(`字体子集化失败:${errorMessage(error)};成品只写 font-family`);
    return { faces: [], warnings };
  }
}

/** 字体面顺序:按族名在成品里出现的顺序,再按字重升序(成品字节可复现) */
function sortFaces(
  faces: readonly EmbeddedFontFace[],
  familyOrder: readonly string[],
): readonly EmbeddedFontFace[] {
  const rank = (family: string): number => {
    const index = familyOrder.indexOf(family);
    return index < 0 ? familyOrder.length : index;
  };
  return [...faces].sort(
    (left, right) =>
      rank(left.family) - rank(right.family) ||
      left.weight_min - right.weight_min ||
      left.weight_max - right.weight_max,
  );
}

/** wasm 编译 + 实例化(只做一次);失败时清缓存,允许下次导出重试 */
async function loadSubsetter(): Promise<FontSubsetter> {
  if (subsetterPromise === null) {
    subsetterPromise = (async () => {
      const response = await fetch(wasmUrl);
      if (!response.ok) throw new Error(`harfbuzz wasm 加载失败(HTTP ${response.status})`);
      const module = await WebAssembly.compile(await response.arrayBuffer());
      return createSubsetter(await WebAssembly.instantiate(module));
    })();
    subsetterPromise.catch(() => {
      subsetterPromise = null;
    });
  }
  return subsetterPromise;
}

/** 取一份字体资产字节(同 URL 只取一次);HTTP 失败时抛出中文错误 */
function loadFontBytes(url: string): Promise<Uint8Array> {
  const cached = fontBytesCache.get(url);
  if (cached !== undefined) return cached;
  const pending = (async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`字体资产加载失败(HTTP ${response.status}):${url}`);
    return new Uint8Array(await response.arrayBuffer());
  })();
  fontBytesCache.set(url, pending);
  // 失败不缓存,下次导出重新尝试.
  pending.catch(() => fontBytesCache.delete(url));
  return pending;
}

/** 把异常转成可直接展示的一行中文 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
