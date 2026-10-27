/**
 * 打开的地图文档（纯逻辑，不碰 DOM）：上传进来的「底图 + geo」这一对文件在内存里的表示，
 * 以及按文件名/内容格式识别三类上传文件的规则。
 *
 * 是什么：`PageDocument` = 底图文件字节 + 底图契约解析结果 + 规范化后的 geo；`classifyUploadFile`
 * 按文件名后缀给出候选类型，`classifyJsonFormat` 再按 `format` 字段区分 geo.json / scene.json。
 * 为什么要有这一层：旧数据流由后端告诉前端 base/geo/scene 的路径与尺寸（该后端已移除，见
 * `docs/PAGE-EDITOR.md` §8）；现在这些事实全部来自浏览器里用户选中的文件，一次校验后固化成
 * `PageDocument`，编辑器与合成器都只读它，不再关心 `File`/`Blob` 的生命周期。
 * 为什么 base 同时保留 bytes 与解析结果：bytes 用于预览的 objectURL 和 sha256（必须对原始
 * 字节求摘要）；`base.inner`（根标签内的原文）是成品内联底图的唯一来源。
 * 元信息：作者 lead，2026-10-28，无后端数据流（上传 base.svg + geo.json）。
 */

import type { BaseSvgInfo } from './base-svg';
import type { Geo } from './page';

/** 一次「打开地图」得到的不可变文档；scene 由调用方另外载入（可以是上传的，也可以是默认排版） */
export interface PageDocument {
  /** 上传的底图文件名（如 `volga_....svg`），用于标题与导出文件名 */
  readonly baseFileName: string;
  /** 底图文件名去掉 `.svg` 后缀；导出 `scene.json` / `final.svg` 都用它 */
  readonly baseStem: string;
  /** 底图原始字节：求 sha256、建预览 objectURL、合成时校验都靠它 */
  readonly baseBytes: Uint8Array;
  /** 底图字节的 sha256（小写十六进制），与 geo.base.sha256 对照 */
  readonly baseSha256: string;
  /** 底图契约 C1–C4 的解析结果（errors 为空才允许打开） */
  readonly base: BaseSvgInfo;
  /** 规范化后的 geo（可选块已补默认值，见 core/page.ts 的 normalizeGeo） */
  readonly geo: Geo;
}

/** 上传文件的候选类型：按文件名后缀先分桶，JSON 再按内容 format 细分 */
export type UploadKind = 'base' | 'geo' | 'scene' | 'json' | 'unknown';

/**
 * 按文件名后缀判断上传文件候选类型。
 *
 * 为什么 `.json` 单独返回 `json`：浏览器拿不到内容前无法区分 geo/scene，`.json` 必须读取并
 * 解析后由 `classifyJsonFormat` 按 `format` 字段判定；`.geo.json` / `.scene.json` 只是给
 * 命名规范的文件一个快速路径（内容仍以 format 为准，避免用户改错扩展名就误判）。
 */
export function classifyUploadFile(fileName: string): UploadKind {
  const lower = fileName.trim().toLowerCase();
  if (lower.endsWith('.svg')) return 'base';
  if (lower.endsWith('.geo.json')) return 'geo';
  if (lower.endsWith('.scene.json')) return 'scene';
  if (lower.endsWith('.json')) return 'json';
  return 'unknown';
}

/**
 * 按 JSON 内容里的 `format` 字段判断这是 geo 还是 scene。
 * 返回 null 表示两者都不是（用户可能传了别的 JSON）。
 */
export function classifyJsonFormat(value: unknown): 'geo' | 'scene' | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const format = (value as Record<string, unknown>)['format'];
  if (format === 'mapdoc-geo') return 'geo';
  if (format === 'mapdoc-page') return 'scene';
  return null;
}

/** 底图文件名 → 导出用的 stem：去掉末尾 `.svg`（大小写不敏感），空名字回退 `map` */
export function baseStemOf(fileName: string): string {
  const trimmed = fileName.trim();
  const stem = trimmed.toLowerCase().endsWith('.svg') ? trimmed.slice(0, -4) : trimmed;
  return stem.length > 0 ? stem : 'map';
}

/** 导出的 scene.json 文件名：`<stem>.scene.json` */
export function sceneFileNameOf(document: PageDocument): string {
  return `${document.baseStem}.scene.json`;
}

/** 导出的成品文件名：`<stem>.svg`（与 Cartopy 的底图同名，便于成对归档） */
export function finalFileNameOf(document: PageDocument): string {
  return `${document.baseStem}.svg`;
}
