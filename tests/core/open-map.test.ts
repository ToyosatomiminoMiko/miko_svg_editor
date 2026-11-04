/**
 * `core/open-map.ts`（打开地图的三条路径）的单测。
 *
 * 为什么在 node 里测：打开流程是纯逻辑（输入是文件字节），三条路径共用
 * `createPageDocument` 的一致性校验；这里验证：
 * - `base.svg + geo.json` 仍按原口径打开，且「导出 → 重新打开 → 再导出」字节幂等；
 * - 只上传本编辑器导出的成品 SVG 就能恢复排版，再导出与第一次逐字节相同；
 * - 旧版成品（没有内嵌源）+ 配套 geo.json 能迁移打开、再导出后仍可单文件重开；
 * - 带 BOM 的底图/JSON 不会因重编码而误报 sha 不配套；
 * - 拿错文件 / 缺文件时给中文原因；
 * - 改造前导出的 page 块（无 text_style / geo_label_id）打开时补 geo_label_id、不标脏。
 * 元信息：作者 lead，2026-10-29，服务于「成品 SVG 可直接再编辑」数据流；
 *         作者 core-dev，2026-11-05，补旧 page 块 `reconcileGeoLabelIds`（§5.3）。
 */

import { describe, expect, it } from 'vitest';
import { openMapFromUploads, type MapUploadFile } from '../../src/core/open-map';
import { decodeBase64Utf8, encodeBase64Utf8 } from '../../src/core/base64';
import {
  canonicalJson,
  legacyPageDigest,
  pageDigest,
  serializeMapDocFile,
  sha256OfBytes,
  type PageLayout,
  type TextItem,
} from '../../src/core/page';
import { defaultPageLayout } from '../../src/core/page-layout';
import { applyTextStyle } from '../../src/core/text-style';
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

/* ======================================================================
 * 2026-11-05 旧 page 块迁移：恢复后补 geo_label_id（§5.3）
 * ====================================================================== */

/** 默认排版去掉本改造新增字段，模拟改造前导出的 page 块（无 text_style / geo_label_id） */
function legacyLayoutOf(geo: ReturnType<typeof makeGeo>): PageLayout {
  const stripped = structuredClone(defaultPageLayout(geo)) as unknown as Record<string, unknown>;
  delete stripped['text_style'];
  for (const item of stripped['items'] as Record<string, unknown>[]) {
    if (item['kind'] === 'text') delete item['geo_label_id'];
  }
  return stripped as unknown as PageLayout;
}

/** 用「改造前字段」的 page 块序列化 geo.json（模拟旧版导出文件） */
function legacyGeoText(geo: ReturnType<typeof makeGeo>, layout: PageLayout): string {
  const doc = JSON.parse(serializeMapDocFile(geo, layout)) as Record<string, unknown>;
  const page = doc['page'] as Record<string, unknown>;
  delete page['text_style'];
  for (const item of page['items'] as Record<string, unknown>[]) {
    if (item['kind'] === 'text') delete item['geo_label_id'];
  }
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** 把成品 SVG 的 marker.page 换成给定摘要（模拟改造前导出：marker 用旧口径 pageDigest） */
function replaceMarkerPage(svg: string, page: string): string {
  const pattern = /<!--\s*mapdoc-final:([A-Za-z0-9+/=\s]+?)\s*-->/;
  const match = pattern.exec(svg);
  if (match === null) throw new Error('成品缺少 mapdoc-final marker');
  const payload = JSON.parse(decodeBase64Utf8(match[1] ?? '')) as Record<string, unknown>;
  payload['page'] = page;
  return svg.replace(match[0], `<!-- mapdoc-final:${encodeBase64Utf8(canonicalJson(payload))} -->`);
}

/** layout 里的地图地名文字 item（保持 items 顺序，与 geo.labels 的 order 一致） */
function mapTextItems(layout: PageLayout): TextItem[] {
  return layout.items.filter(
    (item): item is TextItem => item.kind === 'text' && item.space === 'map',
  );
}

describe('openMapFromUploads：旧 page 块补 geo_label_id（§5.3）', () => {
  it('base + geo：恢复后按 text/x/anchor 还原，只补 id、不标脏', () => {
    const geo = makeDocument(makeGeo()).geo;
    const oldLayout = legacyLayoutOf(geo);
    const opened = openMapFromUploads([
      svgUpload(BASE_SVG_TEXT),
      geoUpload(legacyGeoText(geo, oldLayout)),
    ]);
    expect(opened.source).toBe('base');
    expect(opened.dirty).toBe(false);
    // 旧 page 块没有 text_style：归一化补 {}（不改变「已导出态」判断）
    expect(opened.layout.text_style).toEqual({});

    const labels = [...geo.labels].sort((a, b) => a.order - b.order);
    const openedItems = mapTextItems(opened.layout);
    const oldItems = mapTextItems(oldLayout);
    expect(openedItems).toHaveLength(labels.length);
    openedItems.forEach((item, index) => {
      // 只剩 id 被补：文字/字体/颜色/位置与旧 layout 一致（page 数字经 3 位小数归一化）
      expect(item.geo_label_id).toBe(labels[index]!.id);
      expect(item.lines).toEqual(oldItems[index]!.lines);
      expect(item.font_size_pt).toBeCloseTo(oldItems[index]!.font_size_pt, 3);
      expect(item.color).toBe(oldItems[index]!.color);
      expect(item.y).toBeCloseTo(oldItems[index]!.y, 3);
    });

    // 再导出会带上新字段；重新打开再导出字节稳定（迁移后即幂等）
    const exported = serializeMapDocFile(opened.document.geo, opened.layout);
    const reopened = openMapFromUploads([svgUpload(BASE_SVG_TEXT), geoUpload(exported)]);
    expect(reopened.dirty).toBe(false);
    expect(serializeMapDocFile(reopened.document.geo, reopened.layout)).toBe(exported);
  });

  it('成品内嵌源：恢复后同样补齐（不标脏，marker 摘要不一致只告警）', () => {
    const document = makeDocument(makeGeo());
    const oldLayout = legacyLayoutOf(document.geo);
    // 用旧字段 layout 合成成品：内嵌源里的 page 块也就没有 text_style / geo_label_id
    const composed = composeFinalSvg(document, oldLayout).svg;
    const opened = openMapFromUploads([svgUpload(composed)]);
    expect(opened.source).toBe('final');
    expect(opened.dirty).toBe(false);

    const labels = [...document.geo.labels].sort((a, b) => a.order - b.order);
    const items = mapTextItems(opened.layout);
    expect(items).toHaveLength(labels.length);
    items.forEach((item, index) => expect(item.geo_label_id).toBe(labels[index]!.id));

    // marker 的 page 摘要按「补 id 前」的排版算，补齐后必然不一致：只告警、不阻止打开
    expect(opened.warnings.some((warning) => warning.includes('排版摘要不一致'))).toBe(true);
  });

  it('样式覆盖随 geo.json 往返：重开后覆盖表与 item 显式字段都还在、再导出字节稳定', () => {
    const { document, layout } = fixture();
    const country = mapTextItems(layout)[0]!;
    applyTextStyle(layout, document.geo, 'title', { color: '#ff0000', font_size_pt: 24 });
    applyTextStyle(layout, document.geo, 'country', { color: '#00ff00', font_size_pt: 9 });
    const geoText = serializeMapDocFile(document.geo, layout);

    const opened = openMapFromUploads([svgUpload(BASE_SVG_TEXT), geoUpload(geoText)]);
    expect(opened.source).toBe('base');
    expect(opened.dirty).toBe(false);
    expect(opened.layout.text_style).toEqual({
      title: { color: '#ff0000', font_size_pt: 24 },
      country: { color: '#00ff00', font_size_pt: 9 },
    });
    const reopenedTitle = opened.layout.items.find(
      (item): item is TextItem => item.kind === 'text' && item.role === 'title',
    )!;
    expect(reopenedTitle.color).toBe('#ff0000');
    expect(reopenedTitle.font_size_pt).toBe(24);
    const reopenedCountry = mapTextItems(opened.layout).find(
      (item) => item.geo_label_id === country.geo_label_id,
    )!;
    expect(reopenedCountry.color).toBe('#00ff00');
    expect(reopenedCountry.font_size_pt).toBe(9);
    // 覆盖表 + 已同步的 item 一起往返：字节稳定
    expect(serializeMapDocFile(opened.document.geo, opened.layout)).toBe(geoText);
  });
});

describe('openMapFromUploads：改造前导出的成品 marker 兼容（§5.3）', () => {
  it('旧口径 marker.page 不被误判：单文件打开无告警、不标脏', () => {
    const { layout, composed } = fixture();
    const legacyMarkerSvg = replaceMarkerPage(composed, legacyPageDigest(layout));
    expect(legacyPageDigest(layout)).not.toBe(pageDigest(layout));
    const opened = openMapFromUploads([svgUpload(legacyMarkerSvg)]);
    expect(opened.source).toBe('final');
    expect(opened.dirty).toBe(false);
    expect(opened.warnings).toEqual([]);
  });

  it('旧成品 + 当时的 geo.json 仍能打开（迁移路径与内嵌源路径都不误拒）', () => {
    const document = makeDocument(makeGeo());
    const layout = defaultPageLayout(document.geo);
    const legacyMarkerSvg = replaceMarkerPage(
      composeFinalSvg(document, layout).svg,
      legacyPageDigest(layout),
    );
    const geoText = legacyGeoText(document.geo, legacyLayoutOf(document.geo));

    // 旧版成品（无内嵌源）+ 配套 geo.json → 迁移路径
    const migrated = openMapFromUploads([
      svgUpload(stripSourceMetadata(legacyMarkerSvg)),
      geoUpload(geoText),
    ]);
    expect(migrated.source).toBe('final-with-geo');
    expect(migrated.dirty).toBe(false);
    expect(mapTextItems(migrated.layout).every((item) => item.geo_label_id !== null)).toBe(true);

    // 内嵌源 + 配套 geo.json → 内嵌排版优先路径
    const withGeo = openMapFromUploads([svgUpload(legacyMarkerSvg), geoUpload(geoText)]);
    expect(withGeo.source).toBe('final');
    expect(withGeo.dirty).toBe(false);
  });

  it('真正不配套的 marker.page（既非当前也非旧口径）仍然拒绝', () => {
    const { composed, geoText } = fixture();
    const bogus = replaceMarkerPage(composed, 'f'.repeat(64));
    expect(() =>
      openMapFromUploads([svgUpload(stripSourceMetadata(bogus)), geoUpload(geoText)]),
    ).toThrow(/不配套/);
  });
});
