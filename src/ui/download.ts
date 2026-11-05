/**
 * 文件导出适配器:优先弹系统保存对话框让用户自选位置,环境不支持时退回浏览器下载.
 *
 * 是什么:`downloadText` 供出版排版编辑器导出 `geo.json` / `final.svg`;`downloadSvg` 沿用
 * 草图页的 `sketch.svg` 下载.两个入口都只处理 Blob / `<a download>` / objectURL / 文件句柄的
 * DOM 生命周期,「下什么文件」「叫什么名字」留在调用方.
 * 为什么优先 `showSaveFilePicker`:浏览器默认下载只会落到下载目录,导出时无法指定位置;
 * File System Access API 是唯一能唤起系统保存对话框的标准入口,但只在安全上下文
 * (HTTPS / localhost)的 Chromium 系浏览器可用,所以其余情况必须回退到 objectURL +
 * `<a download>`(至少不丢导出).`lib.dom` 还没有该 API 的类型,本文件只声明用到的成员.
 * 元信息:作者 ToyosatomiminoMiko,2026-11-05.
 */

import { EXPORT_FILENAME, EXPORT_REVOKE_MS } from '../config/export';
import { PAGE_DOWNLOAD_REVOKE_MS } from '../config/page';

/**
 * 导出结果:`saved` = 已写进用户在保存对话框里选的路径;`downloaded` = 退回浏览器默认下载;
 * `cancelled` = 用户在保存对话框点了取消(调用方不能当作已导出,脏标记要保留).
 */
export type SaveOutcome = 'saved' | 'downloaded' | 'cancelled';

/* ---------------- File System Access API 的最小类型 ---------------- */

/** 保存对话框的文件类型过滤器(扩展名 + 人类可读描述) */
interface FilePickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}

/** `showSaveFilePicker` 的入参(只声明本文件用到的字段) */
interface FilePickerOptions {
  suggestedName?: string;
  types?: FilePickerAcceptType[];
}

/** 可写文件流(只声明 write/close) */
interface WritableFileLike {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}

/** 文件句柄(只声明 createWritable) */
interface FileHandleLike {
  createWritable(): Promise<WritableFileLike>;
}

type ShowSaveFilePickerLike = (options?: FilePickerOptions) => Promise<FileHandleLike>;

/**
 * MIME -> 保存对话框里的文件类型过滤器(含默认扩展名).
 * 为什么从 MIME 反查:调用方只传 MIME,过滤器描述与扩展名集中在这里,避免每个导出点各写一份;
 * 未知 MIME 不传 filter,让对话框接受任意文件名.
 */
const SAVE_PICKER_TYPES: Readonly<Record<string, FilePickerAcceptType>> = {
  'image/svg+xml': { description: 'SVG 图片', accept: { 'image/svg+xml': ['.svg'] } },
  'application/json': { description: 'JSON 文件', accept: { 'application/json': ['.json'] } },
};

/** 取 `window.showSaveFilePicker`;不存在时返回 null(非安全上下文 / Firefox / Safari 等) */
function resolveSavePicker(): ShowSaveFilePickerLike | null {
  if (typeof window === 'undefined') return null;
  const picker = (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  return typeof picker === 'function' ? (picker.bind(window) as ShowSaveFilePickerLike) : null;
}

/**
 * 是否用户在保存对话框点了取消.
 * 为什么不用 `instanceof DOMException`:错误可能来自别的 realm,只按 name 判断更稳.
 */
function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

/**
 * 触发浏览器默认下载.
 *
 * 为什么 `<a>` 必须先挂到 document 上再 click:Firefox 不认脱离文档的临时链接(BUG-6).
 * click 之后立刻 remove;objectURL 延迟 revoke,给下载留出读取时间.
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

/**
 * 保存一个文件:有保存对话框就写用户选的路径,否则/取消/写入失败退回默认下载.
 *
 * 为什么写入失败也退回下载:选中的路径不可写(磁盘满/句柄失效)时,导出内容还在内存里,
 * 直接丢掉用户准备好的成果比再下载一次更糟.
 */
async function saveBlob(blob: Blob, filename: string, revokeAfterMs: number): Promise<SaveOutcome> {
  const picker = resolveSavePicker();
  if (picker === null) {
    triggerDownload(blob, filename, revokeAfterMs);
    return 'downloaded';
  }
  const type = SAVE_PICKER_TYPES[blob.type];
  let handle: FileHandleLike;
  try {
    handle = await picker({
      suggestedName: filename,
      ...(type === undefined ? {} : { types: [type] }),
    });
  } catch (error) {
    if (isAbortError(error)) return 'cancelled';
    // 权限策略拦住 / 没有用户手势等:退回默认下载,用户仍然拿得到文件
    triggerDownload(blob, filename, revokeAfterMs);
    return 'downloaded';
  }
  try {
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return 'saved';
  } catch {
    triggerDownload(blob, filename, revokeAfterMs);
    return 'downloaded';
  }
}

/** 导出文本文件:`mime` 决定保存对话框的过滤器与浏览器对下载文件的识别 */
export async function downloadText(
  text: string,
  filename: string,
  mime: string,
): Promise<SaveOutcome> {
  return saveBlob(new Blob([text], { type: mime }), filename, PAGE_DOWNLOAD_REVOKE_MS);
}

/** 下载草图页导出的 SVG(保留旧入口:草图页维持浏览器默认下载,不弹保存对话框) */
export function downloadSvg(svg: string, filename: string = EXPORT_FILENAME): void {
  triggerDownload(new Blob([svg], { type: 'image/svg+xml' }), filename, EXPORT_REVOKE_MS);
}
