/**
 * SVG 文件下载适配器：只处理 Blob / <a download> / objectURL 的 DOM 生命周期。
 * 内容生成在 export-svg.buildSVG()，文件名与 revoke 延迟来自 config/export。
 */

import { EXPORT_FILENAME, EXPORT_REVOKE_MS } from '../config';

/**
 * 触发浏览器下载。
 * <a> 必须先挂到 document 上再 click：Firefox 不认脱离文档的临时链接（BUG-6）。
 * click 之后立刻 remove，objectURL 延迟 revoke，给下载留出读取时间。
 */
export function downloadSvg(svg: string, filename: string = EXPORT_FILENAME): void {
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), EXPORT_REVOKE_MS);
}
