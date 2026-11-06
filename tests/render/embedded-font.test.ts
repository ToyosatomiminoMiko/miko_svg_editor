/**
 * `render/embedded-font.ts` 的单测:选面规则,sfnt 格式识别,`@font-face` CSS 的字节口径.
 *
 * 为什么这些断言重要:这段 CSS 会原样写进成品 SVG,族名/字重区间/`format()` 任写错一处,
 * 成品在别的机器上就会掉回本机字体;选面规则错则会漏嵌某个字重的字(例如 700 的标题),
 * 或把用不到的字重也塞进成品.
 * 元信息:作者 ToyosatomiminoMiko,2026-11-07.
 */

import { describe, expect, it } from 'vitest';
import {
  customFamiliesOf,
  renderEmbeddedFontStyle,
  selectFontAssets,
  sfntFormatOf,
  type EmbeddedFontFace,
  type FontAssetSpec,
} from '../../src/render/embedded-font';
import type { UsedText } from '../../src/render/used-text';

/** 与 `app/font-embed.ts` 的资产表同构(测试不依赖资产文件的真实字节) */
const ASSETS: readonly FontAssetSpec[] = [
  { family: 'JetBrains Mono Slashed', weight_min: 400, weight_max: 400 },
  { family: 'JetBrains Mono Slashed', weight_min: 600, weight_max: 600 },
  { family: 'JetBrains Mono Slashed', weight_min: 700, weight_max: 700 },
  { family: 'Noto Sans Mono CJK SC', weight_min: 400, weight_max: 700 },
];

/** 构造 UsedText 的简写 */
function used(families: readonly string[], weights: readonly number[]): UsedText {
  return { chars: 'x', families, weights };
}

describe('sfntFormatOf', () => {
  it('OTTO 是 OpenType(CFF),0x00010000/true/typ1 是 TrueType', () => {
    expect(sfntFormatOf(new Uint8Array([0x4f, 0x54, 0x54, 0x4f]))).toBe('opentype');
    expect(sfntFormatOf(new Uint8Array([0x00, 0x01, 0x00, 0x00]))).toBe('truetype');
    expect(sfntFormatOf(new Uint8Array([0x74, 0x72, 0x75, 0x65]))).toBe('truetype');
    expect(sfntFormatOf(new Uint8Array([0x74, 0x79, 0x70, 0x31]))).toBe('truetype');
  });

  it('woff2 容器或垃圾字节明确报错', () => {
    expect(() => sfntFormatOf(new Uint8Array([0x77, 0x4f, 0x46, 0x32]))).toThrow(/不是可内嵌/);
    expect(() => sfntFormatOf(new Uint8Array([0x01]))).toThrow(/不足 4 字节/);
  });
});

describe('selectFontAssets:挑要嵌的字体面', () => {
  it('只嵌被引用的族,并按字重挑最近的静态面', () => {
    expect(selectFontAssets(used(['JetBrains Mono Slashed'], [400]), ASSETS)).toEqual([ASSETS[0]]);
    expect(selectFontAssets(used(['JetBrains Mono Slashed'], [700]), ASSETS)).toEqual([ASSETS[2]]);
    // 500 与 400/600 等距:取字重更低的一份(与 CSS 的字重匹配方向一致)
    expect(selectFontAssets(used(['JetBrains Mono Slashed'], [500]), ASSETS)).toEqual([ASSETS[0]]);
  });

  it('可变面一份通吃 400..700;多个字重会各挑一面', () => {
    expect(selectFontAssets(used(['Noto Sans Mono CJK SC'], [400, 700]), ASSETS)).toEqual([
      ASSETS[3],
    ]);
    expect(
      selectFontAssets(
        used(['JetBrains Mono Slashed', 'Noto Sans Mono CJK SC'], [400, 700]),
        ASSETS,
      ).map((asset) => `${asset.family}@${asset.weight_min}`),
    ).toEqual([
      'JetBrains Mono Slashed@400',
      'JetBrains Mono Slashed@700',
      'Noto Sans Mono CJK SC@400',
    ]);
  });

  it('只有通用族或自定义族时一个面都不嵌', () => {
    expect(selectFontAssets(used(['monospace', 'Custom Font'], [400]), ASSETS)).toEqual([]);
  });
});

describe('customFamiliesOf:能内嵌之外的自定义族', () => {
  it('项目字体栈里的系统等宽兜底不算自定义(不产生告警)', () => {
    expect(
      customFamiliesOf(
        used(['SFMono-Regular', 'Menlo', 'Consolas', 'monospace', 'ui-monospace'], [400]),
        ASSETS,
      ),
    ).toEqual([]);
  });

  it('已知族与通用族不算自定义,其余按出现顺序返回', () => {
    expect(
      customFamiliesOf(
        used(
          ['JetBrains Mono Slashed', 'Noto Sans Mono CJK SC', 'monospace', 'Custom Font'],
          [400],
        ),
        ASSETS,
      ),
    ).toEqual(['Custom Font']);
  });
});

describe('renderEmbeddedFontStyle:写进成品的 @font-face', () => {
  /** 字节 [0,1,0,0,1,2,3] 的标准 base64,同时充当 sfnt 的 TrueType 魔数 */
  const FACE: EmbeddedFontFace = {
    family: 'JetBrains Mono Slashed',
    weight_min: 400,
    weight_max: 400,
    bytes: new Uint8Array([0, 1, 0, 0, 1, 2, 3]),
  };

  it('没有字体面时返回空串(成品与旧口径逐字节一致)', () => {
    expect(renderEmbeddedFontStyle([])).toBe('');
  });

  it('CDATA + 一行许可注释 + 逐条 @font-face', () => {
    expect(renderEmbeddedFontStyle([FACE])).toBe(
      '<style type="text/css"><![CDATA[\n' +
        '/* 内嵌字体子集仅含本图用到的字形: JetBrains Mono Slashed (SIL OFL 1.1). */\n' +
        '@font-face { font-family: "JetBrains Mono Slashed"; font-style: normal; font-weight: 400; ' +
        'src: url("data:font/ttf;base64,AAEAAAECAw==") format("truetype"); }\n' +
        ']]></style>\n',
    );
  });

  it('可变面写字重区间,OpenType 用 font/otf + format("opentype")', () => {
    const style = renderEmbeddedFontStyle([
      {
        family: 'Noto Sans Mono CJK SC',
        weight_min: 400,
        weight_max: 700,
        bytes: new Uint8Array([0x4f, 0x54, 0x54, 0x4f, 1]),
      },
    ]);
    expect(style).toContain('font-weight: 400 700;');
    expect(style).toContain('url("data:font/otf;base64,');
    expect(style).toContain('format("opentype")');
  });
});
