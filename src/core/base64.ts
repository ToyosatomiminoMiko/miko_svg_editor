/**
 * UTF-8 文本与标准 base64（带 padding）的互转（纯逻辑，不碰 DOM）。
 *
 * 是什么：`encodeBase64Utf8` 把任意 UTF-8 文本编成标准 base64；`decodeBase64Utf8` 反过来解码并
 * 严格按 UTF-8 还原。同时导出 bytes 级别的两个函数，供只需要字节的场景复用。
 * 为什么不用 `btoa`/`atob`：core 必须能在 node 单测里直接跑，而 `btoa` 只接受 Latin-1、`atob`
 * 在旧 node 上不存在；SVG 内嵌的载荷含中文（geo.json 原文、底图前缀里的注释），必须走 UTF-8
 * 字节再编码，不能按字符直接塞进 base64。
 * 为什么解码要严格：内嵌数据是「可再编辑的真值」，坏 base64/坏 UTF-8 应当明确报错（返回可展示的
 * 中文 Error），而不是替换成 U+FFFD 后继续拼出半坏文档。
 * 元信息：作者 lead，2026-10-29，服务于成品 SVG 的内嵌可编辑源（`core/final-svg.ts`）。
 */

/** 标准 base64 字母表（与 marker/内嵌源共用，保证编码结果可被通用工具解码） */
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 字符 → 6 位值的反查表；-1 表示不是 base64 字符 */
const BASE64_LOOKUP: readonly number[] = (() => {
  const table = new Array<number>(128).fill(-1);
  for (let index = 0; index < BASE64_ALPHABET.length; index += 1) {
    table[BASE64_ALPHABET.charCodeAt(index)] = index;
  }
  return table;
})();

/**
 * bytes → 标准 base64（带 `=` padding）。
 * 每 3 字节一组：第 4 个字符在只剩 1/2 字节时补 `=`，与通用 base64 解码器口径一致。
 */
export function encodeBase64Bytes(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const remaining = bytes.length - index;
    const byte0 = bytes[index] ?? 0;
    const byte1 = remaining > 1 ? (bytes[index + 1] ?? 0) : 0;
    const byte2 = remaining > 2 ? (bytes[index + 2] ?? 0) : 0;
    output += BASE64_ALPHABET.charAt(byte0 >> 2);
    output += BASE64_ALPHABET.charAt(((byte0 & 0x03) << 4) | (byte1 >> 4));
    output += remaining > 1 ? BASE64_ALPHABET.charAt(((byte1 & 0x0f) << 2) | (byte2 >> 6)) : '=';
    output += remaining > 2 ? BASE64_ALPHABET.charAt(byte2 & 0x3f) : '=';
  }
  return output;
}

/** 文本 → 标准 base64（先按 UTF-8 取字节，中文/emoji 都能往返） */
export function encodeBase64Utf8(text: string): string {
  return encodeBase64Bytes(new TextEncoder().encode(text));
}

/**
 * 标准 base64 → bytes。
 * 为什么容忍空白：内嵌源最终可能被格式化工具按行折断，空白不承载数据；
 * 其它非法字符、长度不是 4 的倍数、`=` 出现在中间都按坏数据抛错。
 */
export function decodeBase64Bytes(encoded: string): Uint8Array {
  const compact = encoded.replace(/\s+/g, '');
  if (compact.length % 4 !== 0) {
    throw new Error('不是合法的 base64：长度必须是 4 的倍数');
  }
  let padding = 0;
  if (compact.endsWith('==')) padding = 2;
  else if (compact.endsWith('=')) padding = 1;
  // `=` 只允许出现在末尾（padding），中间出现 '=' 说明数据被截断或拼错。
  for (let index = 0; index < compact.length - padding; index += 1) {
    if (compact.charCodeAt(index) === 61) {
      throw new Error(`不是合法的 base64：第 ${index + 1} 个字符是不该出现的 '='`);
    }
  }
  const byteLength = (compact.length / 4) * 3 - padding;
  const bytes = new Uint8Array(byteLength);
  let byteIndex = 0;
  for (let index = 0; index < compact.length; index += 4) {
    const code0 = base64Value(compact, index);
    const code1 = base64Value(compact, index + 1);
    const code2 = index + 2 >= compact.length - padding ? 0 : base64Value(compact, index + 2);
    const code3 = index + 3 >= compact.length - padding ? 0 : base64Value(compact, index + 3);
    const packed = (code0 << 18) | (code1 << 12) | (code2 << 6) | code3;
    bytes[byteIndex] = (packed >> 16) & 0xff;
    byteIndex += 1;
    if (byteIndex < byteLength) {
      bytes[byteIndex] = (packed >> 8) & 0xff;
      byteIndex += 1;
    }
    if (byteIndex < byteLength) {
      bytes[byteIndex] = packed & 0xff;
      byteIndex += 1;
    }
  }
  return bytes;
}

/** 取 base64 字符的 6 位值；`=` padding 视为 0，非法字符抛错 */
function base64Value(encoded: string, index: number): number {
  const code = encoded.charCodeAt(index);
  if (code === 61) return 0; // '='
  const value = code < BASE64_LOOKUP.length ? (BASE64_LOOKUP[code] ?? -1) : -1;
  if (value < 0) {
    throw new Error(`不是合法的 base64：第 ${index + 1} 个字符不合法`);
  }
  return value;
}

/**
 * 标准 base64 → UTF-8 文本（严格解码）。
 * 坏 UTF-8（例如编码方按 Latin-1 写入）直接抛错，避免把有损文本当成可编辑真值。
 */
export function decodeBase64Utf8(encoded: string): string {
  const bytes = decodeBase64Bytes(encoded);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new Error('base64 内容不是合法的 UTF-8 文本', { cause });
  }
}
