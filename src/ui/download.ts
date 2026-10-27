/**
 * 文件下载适配器：只处理 Blob / `<a download>` / objectURL 的 DOM 生命周期。
 *
 * 是什么：`downloadSvg` 供草图页导出 `sketch.svg`（内容由 `render/export-svg.ts` 生成）；
 * `downloadText` 是通用版本，供出版排版编辑器导出 `scene.json` / `final.svg`。
 * 为什么两者分成两个入口：草图页的文件名与 revoke 延迟来自 `config/export.ts`，
 * 排版页的两份导出各有 MIME 与命名规则（`core/document.ts`），把「下什么文件」留在
 * 调用方，这里只负责「把字符串变成一个下载」。
 * 元信息：作者 frontend，2026-10-27；2026-10-28 增加通用 downloadText。
 */

import { EXPORT_FILENAME, EXPORT_REVOKE_MS } from '../config/export';
import { PAGE_DOWNLOAD_REVOKE_MS } from '../config/page';

/**
 * 触发浏览器下载。
 *
 * 为什么 `<a>` 必须先挂到 document 上再 click：Firefox 不认脱离文档的临时链接（BUG-6）。
 * click 之后立刻 remove；objectURL 延迟 revoke，给下载留出读取时间。
 */
function triggerDownload(blob: Blob, filename: string, revokeAfterMs: number): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), revokeAfterMs);
}

/** 通用文本下载：`mime` 决定浏览器如何识别 `scene.json` / `final.svg` */
export function downloadText(text: string, filename: string, mime: string): void {
  triggerDownload(new Blob([text], { type: mime }), filename, PAGE_DOWNLOAD_REVOKE_MS);
}

/** 下载草图页导出的 SVG（保留旧入口，避免草图页跟着改文件名口径） */
export function downloadSvg(svg: string, filename: string = EXPORT_FILENAME): void {
  triggerDownload(new Blob([svg], { type: 'image/svg+xml' }), filename, EXPORT_REVOKE_MS);
}
