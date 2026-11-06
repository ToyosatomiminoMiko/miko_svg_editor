/**
 * `render/used-text.ts` 的单测:从成品 SVG 里收集用到的字符/字体族/字重.
 *
 * 为什么这些断言重要:字体子集只保留这里收集到的字符;漏一个字符,成品里那个字就掉回
 * 查看端本机字体(甚至方框);多收一串没画出来的字符只会让子集变大.族名与字重没收集对,
 * 内嵌的 `@font-face` 就会与 `<text>` 的样式对不上.
 * 元信息:作者 ToyosatomiminoMiko,2026-11-07.
 */

import { describe, expect, it } from 'vitest';
import { collectUsedText, unescapeXml } from '../../src/render/used-text';

/** 一份缩小的成品片段:两条 text,一条默认族名栈,一条自定义族名 + 700 字重 */
const SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg">',
  '<g id="mapdoc-overlay">',
  '<text x="1" y="2" text-anchor="middle" ' +
    'font-family="&apos;JetBrains Mono Slashed&apos;, &apos;Noto Sans Mono CJK SC&apos;, monospace" ' +
    'font-size="9" fill="#111111">伏尔加 &amp; Volga</text>',
  '<text x="3" y="4" text-anchor="start" font-family="&apos;Custom Font&apos;, monospace" ' +
    'font-size="7" font-weight="700" fill="#111111">河2</text>',
  '</g>',
  '</svg>',
].join('\n');

describe('collectUsedText:字符集', () => {
  it('去掉实体转义,去重,按码点升序', () => {
    const used = collectUsedText(SVG);
    const codepoints = [...used.chars].map((character) => character.codePointAt(0) ?? 0);
    expect(codepoints).toEqual([...codepoints].sort((left, right) => left - right));
    expect(new Set(codepoints).size).toBe(codepoints.length);
    expect(used.chars).toContain('&');
    expect(used.chars).toContain('伏');
    expect(used.chars).not.toContain('amp');
  });

  it('没有 text 时为空', () => {
    const used = collectUsedText('<svg></svg>');
    expect(used.chars).toBe('');
    expect(used.families).toEqual([]);
    expect(used.weights).toEqual([]);
  });
});

describe('collectUsedText:字体族与字重', () => {
  it('族名去掉引号并按首次出现顺序去重,字重缺省按 400 计', () => {
    const used = collectUsedText(SVG);
    expect(used.families).toEqual([
      'JetBrains Mono Slashed',
      'Noto Sans Mono CJK SC',
      'monospace',
      'Custom Font',
    ]);
    expect(used.weights).toEqual([400, 700]);
  });
});

describe('unescapeXml', () => {
  it('只还原一遍实体(&amp;lt; 保持为字面量)', () => {
    expect(unescapeXml('&lt;伏&gt; &amp;lt;')).toBe('<伏> &lt;');
    expect(unescapeXml('&quot;a&quot; &apos;b&apos;')).toBe('"a" \'b\'');
  });
});
