/**
 * `core/base-svg.ts`(底图契约 C1–C4 = `docs/PAGE-EDITOR.md` §7)的单测.
 *
 * 为什么在 node 里测:readBaseSvg 是纯字符串扫描,不碰 DOM;这里验证四类错误文案,
 * viewBox/尺寸解析,根标签内原文切片的边界,以及「根 width/height 与 viewBox 不一致」
 * 的告警.底图 fixture 是 200×100 的纯几何 SVG(无 `<text>`,含 defs/clipPath/style).
 * 元信息:作者 ToyosatomiminoMiko,2026-11-05.
 */

import { describe, expect, it } from 'vitest';
import { readBaseSvg } from '../../src/core/base-svg';
import { BASE_SVG_TEXT } from '../fixtures/page-fixtures';

/** 用任意内联 XML 构造一次检查结果(测试只关心字符串级契约) */
function check(textValue: string) {
  return readBaseSvg(textValue);
}

describe('readBaseSvg:合格底图', () => {
  it('fixture 通过 C1–C4,viewBox 与尺寸来自根标签', () => {
    const info = check(BASE_SVG_TEXT);
    expect(info.errors).toEqual([]);
    expect(info.warnings).toEqual([]);
    expect(info.view_box).toEqual([0, 0, 200, 100]);
    expect(info.width_pt).toBe(200);
    expect(info.height_pt).toBe(100);
  });

  it('inner = 根起始标签之后,最后一个 </svg> 之前的原文(可原样内联)', () => {
    const info = check(BASE_SVG_TEXT);
    expect(info.inner.startsWith('\n <defs>')).toBe(true);
    expect(info.inner).toContain('<clipPath id="pyrender-clip">');
    expect(info.inner).toContain('M0 80 C40 60 80 90 120 70');
    expect(info.inner.endsWith('\n </g>\n')).toBe(true);
    // 切片拼回原文:根起始标签 + inner + 收尾(fixture 末尾恰好一个换行)
    expect(
      `${BASE_SVG_TEXT.slice(0, BASE_SVG_TEXT.indexOf(info.inner))}${info.inner}</svg>\n`,
    ).toBe(BASE_SVG_TEXT);
  });

  it('prefix / inner / suffix 首尾相接就是完整原文(成品内嵌源逐字节还原用)', () => {
    const info = check(BASE_SVG_TEXT);
    expect(info.prefix.startsWith('<?xml version="1.0" encoding="utf-8"?>\n<svg ')).toBe(true);
    expect(info.prefix.endsWith('>')).toBe(true);
    expect(info.suffix).toBe('</svg>\n');
    expect(`${info.prefix}${info.inner}${info.suffix}`).toBe(BASE_SVG_TEXT);
  });

  it('根标签属性值里的 > 不会提前结束起始标签', () => {
    const info = check(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 20" data-note="a>b"><rect/></svg>',
    );
    expect(info.errors).toEqual([]);
    expect(info.view_box).toEqual([0, 0, 10, 20]);
    expect(info.inner).toBe('<rect/>');
    expect(`${info.prefix}${info.inner}${info.suffix}`).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 20" data-note="a>b"><rect/></svg>',
    );
  });

  it('只接受小写 <svg 且后面必须是空白,/ 或 >', () => {
    const info = check('<svgfoo viewBox="0 0 10 10"></svgfoo>');
    expect(info.errors[0]).toBe('C1: 找不到根 <svg 元素');
    expect(info.view_box).toBeNull();
    expect(info.inner).toBe('');
  });

  it('根 width/height 与 viewBox 不一致只告警(>0.01 才告警)', () => {
    const info = check('<svg width="210pt" height="100pt" viewBox="0 0 200 100"><g/></svg>\n');
    expect(info.errors).toEqual([]);
    expect(info.warnings).toEqual(['根 width/height 与 viewBox 尺寸不一致: 210x100 vs 200x100']);

    const close = check('<svg width="200.005pt" height="100pt" viewBox="0 0 200 100"><g/></svg>');
    expect(close.warnings).toEqual([]);
  });
});

describe('readBaseSvg:C1(根 svg / viewBox / 尺寸)', () => {
  it('没有根 <svg> 时报 C1 并留空切片的来源', () => {
    const info = check('<html><body>no svg here</body></html>');
    // C1 之外还会命中 C3(没有任何 </svg>):两者都保留,便于一次展示全部问题
    expect(info.errors[0]).toBe('C1: 找不到根 <svg 元素');
    expect(info.errors).toContain('C3: </svg> 应恰好出现 1 次, 实际 0 次');
    expect(info.view_box).toBeNull();
    expect(info.inner).toBe('');
    // 连根标签都不可信时,底图前后缀也留空(成品内嵌源不能拿半坏切片去还原字节)
    expect(info.prefix).toBe('');
    expect(info.suffix).toBe('');
  });

  it('根起始标签没闭合时报 C1', () => {
    const info = check('<svg viewBox="0 0 10 10"');
    expect(info.errors[0]).toBe('C1: 根 <svg> 起始标签没有闭合');
    expect(info.inner).toBe('');
    expect(info.prefix).toBe('');
    expect(info.suffix).toBe('');
  });

  it('缺少 viewBox 或 viewBox 形状不对时报 C1', () => {
    expect(check('<svg width="10" height="10"><g/></svg>').errors).toEqual([
      'C1: 根 <svg> 缺少合法的 viewBox="x y w h"',
    ]);
    expect(check('<svg viewBox="0 0 10"><g/></svg>').errors).toEqual([
      'C1: 根 <svg> 缺少合法的 viewBox="x y w h"',
    ]);
    expect(check('<svg viewBox="0 0 a 10"><g/></svg>').errors).toEqual([
      'C1: 根 <svg> 缺少合法的 viewBox="x y w h"',
    ]);
    expect(check('<svg viewBox="0 0 NaN 10"><g/></svg>').errors).toEqual([
      'C1: 根 <svg> 缺少合法的 viewBox="x y w h"',
    ]);
  });

  it('viewBox 宽高必须 > 0', () => {
    const info = check('<svg viewBox="0 0 0 100"><g/></svg>');
    expect(info.errors).toEqual(['C1: viewBox 宽高必须 > 0, 得到 0x100']);
    expect(info.width_pt).toBe(0);
    expect(info.height_pt).toBe(100);
    expect(info.inner).toBe('');
  });
});

describe('readBaseSvg:C2(纯底图,不允许文字)', () => {
  it('出现 <text 即报 C2(C1 仍通过时 inner 保留)', () => {
    const info = check('<svg viewBox="0 0 200 100"><g><text x="1">hi</text></g></svg>');
    expect(info.errors).toEqual(['C2: 底图里不允许出现 <text> 元素']);
    expect(info.inner).toBe('<g><text x="1">hi</text></g>');
  });

  it('textPath 之类以 <text 开头的前缀也算文字', () => {
    expect(check('<svg viewBox="0 0 1 1"><textPath>x</textPath></svg>').errors).toEqual([
      'C2: 底图里不允许出现 <text> 元素',
    ]);
  });
});

describe('readBaseSvg:C3(</svg> 唯一且在末尾)', () => {
  it('没有 </svg>,出现多次,末尾多余字节都报 C3', () => {
    expect(check('<svg viewBox="0 0 10 10"><g/>').errors).toEqual([
      'C3: </svg> 应恰好出现 1 次, 实际 0 次',
    ]);
    expect(check('<svg viewBox="0 0 10 10"><g/></svg></svg>').errors).toContain(
      'C3: </svg> 应恰好出现 1 次, 实际 2 次',
    );
    expect(check('<svg viewBox="0 0 10 10"><g/></svg>trailing').errors).toEqual([
      'C3: </svg> 之后只允许一个换行, 实际还有其它字节',
    ]);
  });

  it('末尾允许空,换行,CRLF 三种写法', () => {
    const body = '<svg viewBox="0 0 10 10"><g/></svg>';
    expect(check(body).errors).toEqual([]);
    expect(check(`${body}\n`).errors).toEqual([]);
    expect(check(`${body}\r\n`).errors).toEqual([]);
  });
});

describe('readBaseSvg:C4(不允许叠加层/final 痕迹)', () => {
  it('mapdoc-overlay / mapdoc-final 都会报 C4', () => {
    expect(check('<svg viewBox="0 0 10 10"><g id="mapdoc-overlay"/></svg>').errors).toEqual([
      'C4: 底图包含 mapdoc-overlay 痕迹',
    ]);
    expect(check('<svg viewBox="0 0 10 10"><!-- mapdoc-final:AAAA --></svg>').errors).toEqual([
      'C4: 底图包含 mapdoc-final marker',
    ]);
  });
});

describe('readBaseSvg:C5 活跃内容(会随 final.svg 分发执行)', () => {
  it('script(含命名空间前缀)/foreignObject/事件属性/javascript:/xml:base 都拒绝', () => {
    const cases: readonly [string, string][] = [
      ['<svg viewBox="0 0 10 10"><script>alert(1)</script></svg>', 'C5'],
      ['<svg viewBox="0 0 10 10"><svg:script>alert(1)</svg:script></svg>', 'C5'],
      ['<svg viewBox="0 0 10 10"><foreignObject><body onload="x"/></foreignObject></svg>', 'C5'],
      ['<svg viewBox="0 0 10 10"><rect onclick="x" width="1" height="1"/></svg>', 'C5'],
      ['<svg viewBox="0 0 10 10"><a href="javascript:alert(1)">x</a></svg>', 'C5'],
      ['<svg viewBox="0 0 10 10"><a href="java&#115;cript:alert(1)">x</a></svg>', 'C5'],
      ['<svg viewBox="0 0 10 10" xml:base="https://evil.example/"><g/></svg>', 'C5'],
    ];
    for (const [svgText, marker] of cases) {
      const errors = check(svgText).errors;
      expect(
        errors.some((error) => error.startsWith(marker)),
        svgText,
      ).toBe(true);
    }
  });

  it('合法纯几何底图(fixture 含 style/defs/clipPath)不误伤 C5', () => {
    expect(check(BASE_SVG_TEXT).errors).toEqual([]);
  });
});

describe('readBaseSvg:C6 XML 1.0 不允许的控制字符', () => {
  it('底图里出现 U+0001 时拒绝(否则整份 final.svg 非良构)', () => {
    const svgText = '<svg viewBox="0 0 10 10"><g>\u0001</g></svg>';
    const errors = check(svgText).errors;
    expect(errors.some((error) => error.includes('C6') && error.includes('U+1'))).toBe(true);
  });

  it('合法的 \\t / \\n / \\r 与常规文字不误伤', () => {
    expect(check('<svg viewBox="0 0 10 10">\n\t<g/>\r\n</svg>').errors).toEqual([]);
  });
});

describe('readBaseSvg:C7 文档级 CSS(<style> 会改到成品页面文字)', () => {
  it('fixture 的几何渲染类 style(CDATA)放行', () => {
    expect(check(BASE_SVG_TEXT).errors).toEqual([]);
  });

  it('选择器非 * / 非几何属性 / @import / url() 都拒绝', () => {
    const cases: readonly [string, string][] = [
      ['<svg viewBox="0 0 10 10"><style>text{fill:#ff0000}</style></svg>', '选择器'],
      ['<svg viewBox="0 0 10 10"><style>*{fill:#ff0000}</style></svg>', '属性'],
      [
        '<svg viewBox="0 0 10 10"><style>@import url(https://evil.example/x.css);</style></svg>',
        '@',
      ],
      ['<svg viewBox="0 0 10 10"><style>*{stroke:url(#paint)}</style></svg>', 'url'],
    ];
    for (const [svgText, marker] of cases) {
      const errors = check(svgText).errors;
      expect(
        errors.some((error) => error.startsWith('C7') && error.includes(marker)),
        svgText,
      ).toBe(true);
    }
  });
});
