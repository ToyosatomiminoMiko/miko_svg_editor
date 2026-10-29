/**
 * `core/final-svg.ts`（成品 SVG 的内嵌可编辑源读取 / 底图还原）的单测。
 *
 * 为什么在 node 里测：成品是 `composeFinalSvg` 的纯函数输出，内嵌源读取/还原同样是纯字符串
 * 逻辑；这里验证三件事——导出时写入的源能原样解出、`mapdoc-map` 原样定位、无内嵌源的旧版
 * 成品也能还原出可渲染的底图外壳（exact=false）。
 * 元信息：作者 lead，2026-10-29，服务于「成品 SVG 可直接再编辑」数据流。
 */

import { describe, expect, it } from 'vitest';
import { encodeBase64Utf8 } from '../../src/core/base64';
import { readBaseSvg } from '../../src/core/base-svg';
import { readFinalSvg, reconstructFinalBase, type FinalSvgInfo } from '../../src/core/final-svg';
import { geoDigest, pageDigest, serializeMapDocFile } from '../../src/core/page';
import { defaultPageLayout } from '../../src/core/page-layout';
import { composeFinalSvg } from '../../src/render/compose-svg';
import {
  BASE_INFO,
  BASE_SHA256,
  BASE_SVG_TEXT,
  makeDocument,
  makeGeo,
} from '../fixtures/page-fixtures';

/** 用 fixture 文档 + 默认排版合成一次成品 */
function composeFixture() {
  const document = makeDocument(makeGeo());
  const layout = defaultPageLayout(document.geo);
  const result = composeFinalSvg(document, layout);
  return { document, layout, svg: result.svg };
}

/** 去掉内嵌源 metadata，模拟「旧版本导出」的成品 */
function stripSourceMetadata(svg: string): string {
  return svg.replace(/<metadata id="mapdoc-source">[^<]*<\/metadata>\n/, '');
}

describe('readFinalSvg：本编辑器导出的成品', () => {
  it('识别成品并解出完整内嵌 geo.json、底图前后缀与 marker', () => {
    const { document, layout, svg } = composeFixture();
    const info: FinalSvgInfo = readFinalSvg(svg);
    expect(info.is_final).toBe(true);
    expect(info.errors).toEqual([]);
    expect(info.warnings).toEqual([]);
    expect(info.source).not.toBeNull();
    // 内嵌 document 必须是「导出 geo.json」的同一份字节文本（含 page 块）
    expect(info.source?.documentText).toBe(serializeMapDocFile(document.geo, layout));
    expect(info.source?.documentText).toContain('"page"');
    expect(info.source?.basePrefix).toBe(document.base.prefix);
    expect(info.source?.baseSuffix).toBe(document.base.suffix);
    // 还原后的底图摘要与来源标志（exact=false 时用于跳过 geo sha 校验）
    expect(info.source?.baseSha256).toBe(BASE_SHA256);
    expect(info.source?.exact).toBe(true);
    // mapdoc-map 组内容 = 底图 inner（逐字节）
    expect(info.base_inner).toBe(BASE_INFO.inner);
    // marker 摘要与输入一致
    expect(info.marker?.version).toBe(2);
    expect(info.marker?.geo).toBe(geoDigest(document.geo));
    expect(info.marker?.page).toBe(pageDigest(layout));
    expect(info.marker?.counts?.total).toBe(layout.items.length);
  });

  it('前后缀 + 内联 inner 逐字节还原底图（sha256 因此仍成立）', () => {
    const { document, svg } = composeFixture();
    const info = readFinalSvg(svg);
    const reconstructed = reconstructFinalBase(info, document.geo.base);
    expect(reconstructed).not.toBeNull();
    expect(reconstructed?.exact).toBe(true);
    expect(reconstructed?.text).toBe(BASE_SVG_TEXT);
    // 自己再解析一遍：契约仍通过，inner 与原底图一致（说明切片没有多/少一个换行）
    const base = readBaseSvg(reconstructed?.text ?? '');
    expect(base.errors).toEqual([]);
    expect(base.inner).toBe(BASE_INFO.inner);
    expect(base.view_box).toEqual([0, 0, 200, 100]);
  });

  it('非成品（Cartopy 底图）不误判', () => {
    const info = readFinalSvg(BASE_SVG_TEXT);
    expect(info.is_final).toBe(false);
    expect(info.source).toBeNull();
    expect(info.marker).toBeNull();
    expect(info.base_inner).toBeNull();
    expect(info.errors).toEqual([]);
  });
});

describe('readFinalSvg：旧版成品（没有内嵌源）', () => {
  it('仍能定位 inner，并用 geo.base 合成可渲染的底图外壳', () => {
    const { document, svg } = composeFixture();
    const legacy = stripSourceMetadata(svg);
    expect(legacy).not.toContain('mapdoc-source');
    const info = readFinalSvg(legacy);
    expect(info.is_final).toBe(true);
    expect(info.source).toBeNull();
    expect(info.marker).not.toBeNull();
    expect(info.base_inner).toBe(BASE_INFO.inner);

    const reconstructed = reconstructFinalBase(info, document.geo.base);
    expect(reconstructed?.exact).toBe(false);
    const base = readBaseSvg(reconstructed?.text ?? '');
    expect(base.errors).toEqual([]);
    expect(base.inner).toBe(BASE_INFO.inner);
    expect(base.view_box).toEqual([0, 0, 200, 100]);
    expect(base.width_pt).toBe(200);
    expect(base.height_pt).toBe(100);
  });
});

describe('readFinalSvg：坏数据不崩、给出可展示原因', () => {
  it('内嵌源 base64 损坏 → errors 非空且 source 为 null', () => {
    const { svg } = composeFixture();
    const broken = svg.replace(/(<metadata id="mapdoc-source">)[^<]*(<\/metadata>)/, '$1!!!$2');
    const info = readFinalSvg(broken);
    expect(info.is_final).toBe(true);
    expect(info.source).toBeNull();
    expect(info.errors[0]).toContain('内嵌排版数据无法解码');
    // 坏源不影响 inner 定位：仍可用于「成品 + geo.json」路径
    expect(info.base_inner).toBe(BASE_INFO.inner);
  });

  it('内嵌源格式/版本不对 → errors 说明原因', () => {
    const { svg } = composeFixture();
    const payload = encodeBase64Utf8(
      JSON.stringify({ format: 'other', version: 1, document: '{}', base: {} }),
    );
    const replaced = svg.replace(
      /(<metadata id="mapdoc-source">)[^<]*(<\/metadata>)/,
      `$1${payload}$2`,
    );
    const info = readFinalSvg(replaced);
    expect(info.source).toBeNull();
    expect(info.errors[0]).toContain('format');

    const wrongVersion = encodeBase64Utf8(
      JSON.stringify({
        format: 'mapdoc-final-source',
        version: 99,
        document: '{}',
        base: { prefix: '', suffix: '' },
      }),
    );
    const info2 = readFinalSvg(
      svg.replace(/(<metadata id="mapdoc-source">)[^<]*(<\/metadata>)/, `$1${wrongVersion}$2`),
    );
    expect(info2.source).toBeNull();
    expect(info2.errors[0]).toContain('版本');
  });

  it('marker 损坏只告警（内嵌源仍是真值）', () => {
    const { svg } = composeFixture();
    const broken = svg.replace(/<!-- mapdoc-final:[\s\S]*?-->/, '<!-- mapdoc-final:AAAA -->');
    const info = readFinalSvg(broken);
    expect(info.is_final).toBe(true);
    expect(info.marker).toBeNull();
    expect(info.warnings[0]).toContain('marker');
    expect(info.source).not.toBeNull();
  });
});
