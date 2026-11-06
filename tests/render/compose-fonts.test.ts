/**
 * `composeFinalSvg` 的字体子集选项:嵌入 `<defs><style>@font-face</style></defs>` 时成品的样子.
 *
 * 为什么单独一组:字体嵌入是「成品可选载荷」,不传 `font_faces` 时字节必须与旧口径完全一致
 * (老文件的可复现性);传了之后只应多出 `<defs>` 开头的那一段 style,其余图层,metadata,
 * marker 与 report 都不能变.
 * 元信息:作者 ToyosatomiminoMiko,2026-11-07.
 */

import { describe, expect, it } from 'vitest';
import { openMapFromUploads } from '../../src/core/open-map';
import { serializeMapDocFile } from '../../src/core/page';
import { defaultPageLayout } from '../../src/core/page-layout';
import { composeFinalSvg } from '../../src/render/compose-svg';
import type { EmbeddedFontFace } from '../../src/render/embedded-font';
import { createSubsetter } from '../../src/render/hb-subset';
import { collectUsedText } from '../../src/render/used-text';
import { makeDocument, makeGeo } from '../fixtures/page-fixtures';
import { readBytes } from '../fixtures/node-fs';

const WASM = new URL('../../node_modules/harfbuzzjs/dist/harfbuzz-subset.wasm', import.meta.url);
const JETBRAINS = new URL(
  '../../src/assets/fonts/JetBrainsMonoSlashed-Regular.ttf',
  import.meta.url,
);
const NOTO_CJK = new URL('../../src/assets/fonts/NotoSansMonoCJKsc-VF.otf', import.meta.url);

/** 用 fixture 文档裁出两份字体面(与 `app/font-embed.ts` 走同一条裁字路径) */
async function embedFaces(svg: string): Promise<readonly EmbeddedFontFace[]> {
  const wasm = await WebAssembly.compile(readBytes(WASM));
  const subsetter = createSubsetter(await WebAssembly.instantiate(wasm));
  const chars = collectUsedText(svg).chars;
  return [
    {
      family: 'JetBrains Mono Slashed',
      weight_min: 400,
      weight_max: 400,
      bytes: subsetter.subset(readBytes(JETBRAINS), chars),
    },
    {
      family: 'Noto Sans Mono CJK SC',
      weight_min: 400,
      weight_max: 700,
      bytes: subsetter.subset(readBytes(NOTO_CJK), chars),
    },
  ];
}

describe('composeFinalSvg:字体子集', () => {
  const document = makeDocument(makeGeo());
  const layout = defaultPageLayout(document.geo);
  const draft = composeFinalSvg(document, layout);

  it('不传 font_faces 时成品里没有 @font-face(旧口径不变)', () => {
    // 底图自己的 <style> 会随 base inner 原样进成品,这里只关心我们不再注入字体载荷.
    expect(draft.svg).not.toContain('@font-face');
    expect(draft.svg).not.toContain('data:font/');
    expect(composeFinalSvg(document, layout, { font_faces: [] }).svg).toBe(draft.svg);
  });

  it('成品实际画出了文字,字符集非空', () => {
    const used = collectUsedText(draft.svg);
    expect(used.chars.length).toBeGreaterThan(0);
    expect(used.families).toContain('JetBrains Mono Slashed');
    expect(used.families).toContain('Noto Sans Mono CJK SC');
  });

  it('注入 @font-face 后只多出 defs 开头的一段 style,其余字节不变', async () => {
    const faces = await embedFaces(draft.svg);
    const embedded = composeFinalSvg(document, layout, { font_faces: faces });
    expect(embedded.svg).toContain('<style type="text/css"><![CDATA[');
    expect(embedded.svg).toContain('@font-face { font-family: "JetBrains Mono Slashed"');
    expect(embedded.svg).toContain('@font-face { font-family: "Noto Sans Mono CJK SC"');
    expect(embedded.svg).toContain('url("data:font/ttf;base64,');
    expect(embedded.svg).toContain('url("data:font/otf;base64,');
    // style 在 clipPath 之前(defs 的第一项)
    expect(embedded.svg.indexOf('<style')).toBeLessThan(
      embedded.svg.indexOf('<clipPath id="mapdoc-map-clip">'),
    );
    // 去掉 style 段后与草稿逐字节相同
    const stripped = embedded.svg.replace(
      /<style type="text\/css"><!\[CDATA\[[\s\S]*?\]\]><\/style>\n/,
      '',
    );
    expect(stripped).toBe(draft.svg);
    // report(计数/告警/越界)与不嵌字体时一致
    expect(embedded.report).toEqual(draft.report);
  });

  it('内嵌字体后的成品仍能被单文件重新打开(style 不影响内嵌源/底图还原)', async () => {
    const faces = await embedFaces(draft.svg);
    const svg = composeFinalSvg(document, layout, { font_faces: faces }).svg;
    const opened = openMapFromUploads([
      { name: 'final.svg', bytes: new TextEncoder().encode(svg) },
    ]);
    expect(opened.source).toBe('final');
    expect(opened.document.baseSha256).toBe(document.baseSha256);
    expect(serializeMapDocFile(opened.document.geo, opened.layout)).toBe(
      serializeMapDocFile(document.geo, layout),
    );
  });

  it('同一份字体面重复合成得到同一份字节', async () => {
    const faces = await embedFaces(draft.svg);
    const first = composeFinalSvg(document, layout, { font_faces: faces });
    const second = composeFinalSvg(document, layout, { font_faces: faces });
    expect(second.svg).toBe(first.svg);
  });
});
