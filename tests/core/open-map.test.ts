/**
 * `core/open-map.ts`（打开地图的三条路径）的单测。
 *
 * 为什么在 node 里测：打开流程是纯逻辑（输入是文件字节），三条路径共用
 * `createPageDocument` 的一致性校验；这里验证：
 * - `base.svg + geo.json` 仍按原口径打开，且「导出 → 重新打开 → 再导出」字节幂等；
 * - 只上传本编辑器导出的成品 SVG 就能恢复排版，再导出与第一次逐字节相同；
 * - 旧版成品（没有内嵌源）+ 配套 geo.json 能迁移打开、再导出后仍可单文件重开；
 * - 带 BOM 的底图/JSON 不会因重编码而误报 sha 不配套；
 * - 拿错文件 / 缺文件时给中文原因。
 * 元信息：作者 lead，2026-10-29，服务于「成品 SVG 可直接再编辑」数据流。
 */

import { describe, expect, it } from 'vitest';
import { openMapFromUploads, type MapUploadFile } from '../../src/core/open-map';
import { pageDigest, serializeMapDocFile, sha256OfBytes } from '../../src/core/page';
import { defaultPageLayout } from '../../src/core/page-layout';
import { composeFinalSvg } from '../../src/render/compose-svg';
import { BASE_SVG_TEXT, makeDocument, makeGeo } from '../fixtures/page-fixtures';

/** 用 fixture 文档 + 默认排版构造「底图 + geo.json + 成品 SVG」三份素材 */
function fixture() {
  const document = makeDocument(makeGeo());
  const layout = defaultPageLayout(document.geo);
  const geoText = serializeMapDocFile(document.geo, layout);
  const composed = composeFinalSvg(document, layout).svg;
  return { document, layout, geoText, composed };
}

/** 去掉成品里的内嵌源 metadata（模拟旧版本导出的成品） */
function stripSourceMetadata(svg: string): string {
  return svg.replace(/<metadata id="mapdoc-source">[^<]*<\/metadata>\n/, '');
}

/** 文本 → 上传项字节（UTF-8） */
function encoded(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** 上传项：底图或成品 SVG */
function svgUpload(text: string, name = 'fixture.svg'): MapUploadFile {
  return { name, bytes: encoded(text) };
}

/** 上传项：geo.json */
function geoUpload(text: string, name = 'fixture.geo.json'): MapUploadFile {
  return { name, bytes: encoded(text) };
}

describe('openMapFromUploads：底图 + geo.json（原有路径）', () => {
  it('恢复 page 排版，且「导出 → 重新打开 → 再导出」字节一致', () => {
    const { document, layout, geoText } = fixture();
    const opened = openMapFromUploads([svgUpload(BASE_SVG_TEXT), geoUpload(geoText)]);
    expect(opened.source).toBe('base');
    expect(opened.dirty).toBe(false);
    expect(opened.warnings).toEqual([]);
    expect(opened.document.geo.base.sha256).toBe(document.geo.base.sha256);
    expect(pageDigest(opened.layout)).toBe(pageDigest(layout));
    // 再导出的 geo.json 与打开的文件逐字节一致（幂等）
    expect(serializeMapDocFile(opened.document.geo, opened.layout)).toBe(geoText);
  });

  it('geo.json 没有 page 块 → 默认排版并标脏', () => {
    const { document } = fixture();
    const cartopyGeo = `${JSON.stringify(makeGeo(), null, 2)}\n`;
    const opened = openMapFromUploads([svgUpload(BASE_SVG_TEXT), geoUpload(cartopyGeo)]);
    expect(opened.dirty).toBe(true);
    expect(opened.layout.items.length).toBeGreaterThan(0);
    expect(opened.document.geo.base.sha256).toBe(document.geo.base.sha256);
  });
});

describe('openMapFromUploads：只上传成品 SVG（单文件再编辑）', () => {
  it('恢复内嵌排版，底图逐字节还原，再导出与第一次逐字节相同', () => {
    const { document, layout, composed } = fixture();
    const opened = openMapFromUploads([svgUpload(composed)]);
    expect(opened.source).toBe('final');
    expect(opened.dirty).toBe(false);
    expect(opened.warnings).toEqual([]);
    expect(opened.document.base.inner).toBe(document.base.inner);
    expect(new TextDecoder().decode(opened.document.baseBytes)).toBe(BASE_SVG_TEXT);
    expect(pageDigest(opened.layout)).toBe(pageDigest(layout));
    // 成品往返必须字节稳定（内嵌源 + 渲染内容都由同一套纯函数重建）
    expect(composeFinalSvg(opened.document, opened.layout).svg).toBe(composed);
  });
});

describe('openMapFromUploads：旧版成品 + 配套 geo.json（迁移路径）', () => {
  it('能打开、给出告警，且再导出的渲染内容与原成品一致', () => {
    const { geoText, composed } = fixture();
    const legacy = stripSourceMetadata(composed);
    const opened = openMapFromUploads([svgUpload(legacy), geoUpload(geoText)]);
    expect(opened.source).toBe('final-with-geo');
    expect(opened.dirty).toBe(false);
    expect(opened.warnings.some((warning) => warning.includes('旧版导出'))).toBe(true);
    // 重新导出会补上内嵌源；去掉 metadata 后渲染部分必须与原成品逐字节一致
    const reexported = composeFinalSvg(opened.document, opened.layout).svg;
    expect(stripSourceMetadata(reexported)).toBe(legacy);
  });

  it('迁移后再导出的成品必须能单文件重新打开（exact=false 的外壳摘要）', () => {
    const { geoText, composed } = fixture();
    const legacy = stripSourceMetadata(composed);
    const migrated = openMapFromUploads([svgUpload(legacy), geoUpload(geoText)]);
    const reexported = composeFinalSvg(migrated.document, migrated.layout).svg;
    // 单文件重开：不能拿 geo.base.sha256（原底图）校验合成外壳
    const reopened = openMapFromUploads([svgUpload(reexported)]);
    expect(reopened.source).toBe('final');
    expect(reopened.warnings.some((warning) => warning.includes('迁移'))).toBe(true);
    // 连续往返仍字节稳定
    expect(composeFinalSvg(reopened.document, reopened.layout).svg).toBe(reexported);
    // 再叠一份配套 geo.json 也仍以内嵌源为准打开
    const withGeo = openMapFromUploads([svgUpload(reexported), geoUpload(geoText)]);
    expect(withGeo.source).toBe('final');
  });
});

describe('openMapFromUploads：BOM 与内嵌源优先', () => {
  it('带 UTF-8 BOM 的底图/geo.json 不会因重编码而误报 sha 不配套', () => {
    const bomBase = `\uFEFF${BASE_SVG_TEXT}`;
    const geo = makeGeo();
    geo.base.sha256 = sha256OfBytes(encoded(bomBase));
    const bomGeoText = `\uFEFF${serializeMapDocFile(geo, defaultPageLayout(geo))}`;
    const opened = openMapFromUploads([svgUpload(bomBase), geoUpload(bomGeoText)]);
    expect(opened.source).toBe('base');
    expect(opened.document.baseSha256).toBe(geo.base.sha256);
    expect(opened.document.base.inner).toBe(makeDocument(geo).base.inner);
    // 成品 → 单文件重开时，BOM 随 prefix 一起被内嵌，sha 仍成立
    const composed = composeFinalSvg(opened.document, opened.layout).svg;
    const reopened = openMapFromUploads([svgUpload(composed)]);
    expect(reopened.document.baseSha256).toBe(geo.base.sha256);
    // 比较时必须保留 BOM（TextDecoder 默认会剥掉，会误判成「少了 BOM」）
    expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(reopened.document.baseBytes)).toBe(
      bomBase,
    );
  });

  it('成品自带内嵌源 + 无 page 的 Cartopy geo.json → 用内嵌排版并告警', () => {
    const { composed } = fixture();
    const cartopyGeo = `${JSON.stringify(makeGeo(), null, 2)}\n`;
    const opened = openMapFromUploads([svgUpload(composed), geoUpload(cartopyGeo)]);
    expect(opened.source).toBe('final');
    expect(opened.dirty).toBe(false);
    expect(opened.warnings.some((warning) => warning.includes('不含 page'))).toBe(true);
  });
});

describe('openMapFromUploads：错误路径给中文原因', () => {
  it('只给底图、没有 geo.json', () => {
    expect(() => openMapFromUploads([svgUpload(BASE_SVG_TEXT)])).toThrow(/缺少 geo.json/);
  });

  it('旧版成品没有内嵌源、又没有 geo.json', () => {
    const { composed } = fixture();
    expect(() => openMapFromUploads([svgUpload(stripSourceMetadata(composed))])).toThrow(
      /不含内嵌排版数据/,
    );
  });

  it('底图与 geo.json 的 sha256 不配套', () => {
    const geo = makeGeo();
    geo.base.sha256 = '0'.repeat(64);
    const text = `${JSON.stringify(geo, null, 2)}\n`;
    expect(() => openMapFromUploads([svgUpload(BASE_SVG_TEXT), geoUpload(text)])).toThrow(
      /sha256 不一致/,
    );
  });

  it('成品 SVG 与所选 geo.json 不配套（marker 摘要不一致）', () => {
    const { composed } = fixture();
    const geo = makeGeo();
    geo.suggestions.title = '另一份地图';
    const other = serializeMapDocFile(geo, defaultPageLayout(makeDocument(geo).geo));
    expect(() => openMapFromUploads([svgUpload(composed), geoUpload(other)])).toThrow(/不配套/);
  });

  it('传两个 JSON / 没有 SVG / 不识别文件', () => {
    const { geoText } = fixture();
    expect(() =>
      openMapFromUploads([
        svgUpload(BASE_SVG_TEXT),
        geoUpload(geoText),
        geoUpload(geoText, 'b.json'),
      ]),
    ).toThrow(/只能上传一个 geo.json/);
    expect(() => openMapFromUploads([geoUpload(geoText)])).toThrow(/缺少 \.svg/);
    expect(() =>
      openMapFromUploads([
        svgUpload(BASE_SVG_TEXT),
        { name: 'x.png', bytes: new Uint8Array([0xff, 0xfe]) },
      ]),
    ).toThrow(/不识别的文件/);
  });
});
