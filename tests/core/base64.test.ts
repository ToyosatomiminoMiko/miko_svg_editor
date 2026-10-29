/**
 * `core/base64.ts`（成品 SVG 内嵌源用的 UTF-8 base64 编解码）的单测。
 *
 * 为什么单独测：内嵌源是「可再编辑的真值」，编解码必须能往返中文/emoji、能拒绝坏数据；
 * 这里同时锁定已知编码结果（标准字母表 + padding），避免以后换成非标准变体。
 * 元信息：作者 lead，2026-10-29，服务于「成品 SVG 可直接再编辑」数据流。
 */

import { describe, expect, it } from 'vitest';
import {
  decodeBase64Bytes,
  decodeBase64Utf8,
  encodeBase64Bytes,
  encodeBase64Utf8,
} from '../../src/core/base64';

describe('encodeBase64Utf8 / decodeBase64Utf8：UTF-8 往返', () => {
  it.each([
    ['', ''],
    ['a', 'YQ=='],
    ['ab', 'YWI='],
    ['abc', 'YWJj'],
    ['中文', '5Lit5paH'],
    ['a & <b> "c" \'d\'', 'YSAmIDxiPiAiYyIgJ2Qn'],
    ['😀', '8J+YgA=='],
  ])('%j ↔ %j', (text, encoded) => {
    expect(encodeBase64Utf8(text)).toBe(encoded);
    expect(decodeBase64Utf8(encoded)).toBe(text);
  });

  it('空文本与超长文本都能往返', () => {
    const long = '中文地图排版'.repeat(1000);
    expect(decodeBase64Utf8(encodeBase64Utf8(long))).toBe(long);
  });
});

describe('decodeBase64：坏数据必须报错', () => {
  it('长度不是 4 的倍数', () => {
    expect(() => decodeBase64Utf8('YWJ')).toThrow('长度必须是 4 的倍数');
  });

  it('非法字符', () => {
    expect(() => decodeBase64Utf8('Y!Jj')).toThrow('不是合法的 base64');
  });

  it("'=' 只允许出现在末尾作为 padding", () => {
    expect(() => decodeBase64Utf8('YQ==YQ==')).toThrow("不该出现的 '='");
  });

  it('按字节解码时不校验 UTF-8（交给 decodeBase64Utf8）', () => {
    // 0xff 是非法 UTF-8 起始字节：bytes 层照常返回，UTF-8 层必须拒绝。
    const bytes = decodeBase64Bytes('/w==');
    expect([...bytes]).toEqual([0xff]);
    expect(() => decodeBase64Utf8('/w==')).toThrow('不是合法的 UTF-8');
  });

  it('容忍换行/空白（内嵌源可能被格式化工具折行）', () => {
    expect(decodeBase64Utf8('5Lit\n5paH')).toBe('中文');
  });

  it('bytes 编解码往返', () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255]);
    expect([...decodeBase64Bytes(encodeBase64Bytes(bytes))]).toEqual([...bytes]);
  });
});
