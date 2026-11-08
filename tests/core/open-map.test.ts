/**
 * `core/open-map.ts`(打开地图的两条路径)的单测.
 *
 * 为什么在 node 里测:打开流程是纯逻辑(输入是文件字节),两条路径共用
 * `createPageDocument` 的一致性校验;这里验证:
 * - `base.svg + geo.json` 按原口径打开,且「导出 -> 重新打开 -> 再导出」字节幂等;
 * - 只上传本编辑器导出的成品 SVG 就能恢复排版,再导出与第一次逐字节相同;
 * - 打开合法 page 块后,item 上残留的逐条文字样式会被按分类重建(分类是唯一真源);
 * - 旧格式一律不再迁移:旧 page 块(缺 text_style / geo_label_id)判不合法 -> 默认排版;
 *   旧版成品(无内嵌可编辑源)直接拒绝;marker.page 只按当前口径比对;
 * - 带 BOM 的底图/JSON 不会因重编码而误报 sha 不配套;
 * - 拿错文件 / 缺文件时给中文原因.
 * 元信息:作者 ToyosatomiminoMiko,2026-11-05.
 */

import { describe, expect, it } from 'vitest';
import { openMapFromUploads, type MapUploadFile } from '../../src/core/open-map';
import { decodeBase64Utf8, encodeBase64Utf8 } from '../../src/core/base64';
import {
  canonicalJson,
  pageDigest,
  roundToPageDecimals,
  serializeMapDocFile,
  sha256OfBytes,
  type PageLayout,
  type TextItem,
} from '../../src/core/page';
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

/** 去掉成品里的内嵌源 metadata(模拟旧版本导出的成品) */
function stripSourceMetadata(svg: string): string {
  return svg.replace(/<metadata id="mapdoc-source">[^<]*<\/metadata>\n/, '');
}

/** 文本 -> 上传项字节(UTF-8) */
function encoded(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** 上传项:底图或成品 SVG */
function svgUpload(text: string, name = 'fixture.svg'): MapUploadFile {
  return { name, bytes: encoded(text) };
}

/** 上传项:geo.json */
function geoUpload(text: string, name = 'fixture.geo.json'): MapUploadFile {
  return { name, bytes: encoded(text) };
}

describe('openMapFromUploads:底图 + geo.json(原有路径)', () => {
  it('恢复 page 排版,且「导出 -> 重新打开 -> 再导出」字节一致', () => {
    const { document, layout, geoText } = fixture();
    const opened = openMapFromUploads([svgUpload(BASE_SVG_TEXT), geoUpload(geoText)]);
    expect(opened.source).toBe('base');
    expect(opened.dirty).toBe(false);
    expect(opened.warnings).toEqual([]);
    expect(opened.document.geo.base.sha256).toBe(document.geo.base.sha256);
    expect(pageDigest(opened.layout)).toBe(pageDigest(layout));
    // 再导出的 geo.json 与打开的文件逐字节一致(幂等)
    expect(serializeMapDocFile(opened.document.geo, opened.layout)).toBe(geoText);
  });

  it('geo.json 没有 page 块 -> 默认排版并标脏', () => {
    const { document } = fixture();
    const cartopyGeo = `${JSON.stringify(makeGeo(), null, 2)}\n`;
    const opened = openMapFromUploads([svgUpload(BASE_SVG_TEXT), geoUpload(cartopyGeo)]);
    expect(opened.dirty).toBe(true);
    expect(opened.layout.items.length).toBeGreaterThan(0);
    expect(opened.document.geo.base.sha256).toBe(document.geo.base.sha256);
  });
});

describe('openMapFromUploads:只上传成品 SVG(单文件再编辑)', () => {
  it('恢复内嵌排版,底图逐字节还原,再导出与第一次逐字节相同', () => {
    const { document, layout, composed } = fixture();
    const opened = openMapFromUploads([svgUpload(composed)]);
    expect(opened.source).toBe('final');
    expect(opened.dirty).toBe(false);
    expect(opened.warnings).toEqual([]);
    expect(opened.document.base.inner).toBe(document.base.inner);
    expect(new TextDecoder().decode(opened.document.baseBytes)).toBe(BASE_SVG_TEXT);
    expect(pageDigest(opened.layout)).toBe(pageDigest(layout));
    // 成品往返必须字节稳定(内嵌源 + 渲染内容都由同一套纯函数重建)
    expect(composeFinalSvg(opened.document, opened.layout).svg).toBe(composed);
  });
});

describe('openMapFromUploads:旧版成品(无内嵌源)一律拒绝', () => {
  it('即使给了配套 geo.json 也不再迁移', () => {
    const { geoText, composed } = fixture();
    expect(() =>
      openMapFromUploads([svgUpload(stripSourceMetadata(composed)), geoUpload(geoText)]),
    ).toThrow(/旧版本导出/);
  });
});

describe('openMapFromUploads:BOM 与内嵌源优先', () => {
  it('带 UTF-8 BOM 的底图/geo.json 不会因重编码而误报 sha 不配套', () => {
    const bomBase = `\uFEFF${BASE_SVG_TEXT}`;
    const geo = makeGeo();
    geo.base.sha256 = sha256OfBytes(encoded(bomBase));
    const bomGeoText = `\uFEFF${serializeMapDocFile(geo, defaultPageLayout(geo))}`;
    const opened = openMapFromUploads([svgUpload(bomBase), geoUpload(bomGeoText)]);
    expect(opened.source).toBe('base');
    expect(opened.document.baseSha256).toBe(geo.base.sha256);
    expect(opened.document.base.inner).toBe(makeDocument(geo).base.inner);
    // 成品 -> 单文件重开时,BOM 随 prefix 一起被内嵌,sha 仍成立
    const composed = composeFinalSvg(opened.document, opened.layout).svg;
    const reopened = openMapFromUploads([svgUpload(composed)]);
    expect(reopened.document.baseSha256).toBe(geo.base.sha256);
    // 比较时必须保留 BOM(TextDecoder 默认会剥掉,会误判成「少了 BOM」)
    expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(reopened.document.baseBytes)).toBe(
      bomBase,
    );
  });

  it('成品自带内嵌源 + 无 page 的 Cartopy geo.json -> 用内嵌排版并告警', () => {
    const { composed } = fixture();
    const cartopyGeo = `${JSON.stringify(makeGeo(), null, 2)}\n`;
    const opened = openMapFromUploads([svgUpload(composed), geoUpload(cartopyGeo)]);
    expect(opened.source).toBe('final');
    expect(opened.dirty).toBe(false);
    expect(opened.warnings.some((warning) => warning.includes('不含 page'))).toBe(true);
  });
});

describe('openMapFromUploads:错误路径给中文原因', () => {
  it('只给底图,没有 geo.json', () => {
    expect(() => openMapFromUploads([svgUpload(BASE_SVG_TEXT)])).toThrow(/缺少 geo.json/);
  });

  it('旧版成品没有内嵌源,又没有 geo.json', () => {
    const { composed } = fixture();
    expect(() => openMapFromUploads([svgUpload(stripSourceMetadata(composed))])).toThrow(
      /不含内嵌可编辑源/,
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

  it('成品 SVG 与所选 geo.json 不配套(marker 摘要不一致)', () => {
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
 * 旧格式不再迁移:只保留「分类样式 -> item 样式」这一条生成链路
 * ====================================================================== */

/** 去掉本改造新增的两个字段,模拟旧版本导出的 page 块(无 text_style / geo_label_id) */
function legacyLayoutOf(geo: ReturnType<typeof makeGeo>): PageLayout {
  const stripped = structuredClone(defaultPageLayout(geo)) as unknown as Record<string, unknown>;
  delete stripped['text_style'];
  for (const item of stripped['items'] as Record<string, unknown>[]) {
    if (item['kind'] === 'text') delete item['geo_label_id'];
  }
  return stripped as unknown as PageLayout;
}

/** 用旧字段序列化 geo.json(page 块缺 text_style / geo_label_id) */
function legacyGeoText(geo: ReturnType<typeof makeGeo>, layout: PageLayout): string {
  const doc = JSON.parse(serializeMapDocFile(geo, layout)) as Record<string, unknown>;
  const page = doc['page'] as Record<string, unknown>;
  delete page['text_style'];
  for (const item of page['items'] as Record<string, unknown>[]) {
    if (item['kind'] === 'text') delete item['geo_label_id'];
  }
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** 把成品 SVG 的 marker.page 换成给定摘要(模拟摘要口径不一致的旧成品) */
function replaceMarkerPage(svg: string, page: string): string {
  const pattern = /<!--\s*mapdoc-final:([A-Za-z0-9+/=\s]+?)\s*-->/;
  const match = pattern.exec(svg);
  if (match === null) throw new Error('成品缺少 mapdoc-final marker');
  const payload = JSON.parse(decodeBase64Utf8(match[1] ?? '')) as Record<string, unknown>;
  payload['page'] = page;
  return svg.replace(match[0], `<!-- mapdoc-final:${encodeBase64Utf8(canonicalJson(payload))} -->`);
}

/** layout 里的地图地名文字 item(保持 items 顺序) */
function mapTextItems(layout: PageLayout): TextItem[] {
  return layout.items.filter(
    (item): item is TextItem => item.kind === 'text' && item.geo_label_id !== null,
  );
}

describe('打开旧 page 块:不迁移,按不合法处理并回退默认排版', () => {
  it('缺 text_style / geo_label_id 的 page 块 -> 默认排版 + 告警 + 标脏', () => {
    const geo = makeDocument(makeGeo()).geo;
    const opened = openMapFromUploads([
      svgUpload(BASE_SVG_TEXT),
      geoUpload(legacyGeoText(geo, legacyLayoutOf(geo))),
    ]);
    expect(opened.source).toBe('base');
    expect(opened.dirty).toBe(true);
    expect(opened.warnings.some((warning) => warning.includes('page 排版块不合法'))).toBe(true);
    expect(opened.layout.text_style).toEqual({});
    // 回退的是默认排版:每个地图地名 item 都有分类来源 id
    const items = mapTextItems(opened.layout);
    expect(items).toHaveLength(geo.labels.length);
    for (const item of items) expect(item.geo_label_id).not.toBeNull();
  });
});

describe('打开合法 page 块:逐条残留样式按分类重建(唯一真源)', () => {
  it('item 上被改过的样式被分类样式覆盖,标脏并告警,再导出字节稳定', () => {
    const { document, layout } = fixture();
    const tampered = structuredClone(layout);
    for (const item of tampered.items) {
      if (item.kind !== 'text') continue;
      item.font_size_mm = 40;
      item.color = '#ff00ff';
    }
    const geoText = serializeMapDocFile(document.geo, tampered);

    const opened = openMapFromUploads([svgUpload(BASE_SVG_TEXT), geoUpload(geoText)]);
    expect(opened.source).toBe('base');
    expect(opened.dirty).toBe(true);
    expect(
      opened.warnings.some((warning) => warning.includes('逐条文字样式已按分类设置统一')),
    ).toBe(true);

    // 重建结果:地图分类的逐条样式(含字号)回到分类样式;页面分类颜色/行高回默认,
    // 但字号保留文件里的值--页面默认字号随纸张 k 缩放,重开不能把旧纸面的字号改掉.
    const fresh = defaultPageLayout(document.geo);
    const freshTexts = fresh.items.filter((item) => item.kind === 'text');
    const openedTexts = opened.layout.items.filter((item) => item.kind === 'text');
    expect(openedTexts).toHaveLength(freshTexts.length);
    openedTexts.forEach((item, index) => {
      const expected = freshTexts[index]!;
      expect(item.kind).toBe('text');
      if (item.kind !== 'text' || expected.kind !== 'text') return;
      if (item.geo_label_id !== null) {
        expect(item.font_size_mm).toBeCloseTo(expected.font_size_mm, 3);
      } else {
        expect(item.font_size_mm).toBe(40);
      }
      expect(item.color).toBe(expected.color);
      expect(item.line_height).toBe(expected.line_height);
    });

    // 重建后即新口径:重新打开再导出字节稳定,不标脏
    const exported = serializeMapDocFile(opened.document.geo, opened.layout);
    const reopened = openMapFromUploads([svgUpload(BASE_SVG_TEXT), geoUpload(exported)]);
    expect(reopened.dirty).toBe(false);
    expect(reopened.warnings).toEqual([]);
    expect(serializeMapDocFile(reopened.document.geo, reopened.layout)).toBe(exported);
  });
});

describe('成品 marker.page 只按当前口径比对(不做旧摘要兼容)', () => {
  it('配套 geo.json 的排版与 marker.page 不一致 -> 拒绝', () => {
    const { layout, geoText, composed } = fixture();
    const other = structuredClone(layout);
    const first = other.items[0]!;
    // 第一条是标题(带左右居中约束,x 的差异会被 normalizePage 拉回中心),改 y 才能
    // 稳定制造「排版摘要不同」;这样测的仍是 marker 口径,而不是居中约束.
    first.y += 1;
    const mismatched = replaceMarkerPage(composed, pageDigest(other));
    expect(mismatched).not.toBe(composed);
    expect(() => openMapFromUploads([svgUpload(mismatched), geoUpload(geoText)])).toThrow(/不配套/);
  });

  it('完全对不上的摘要仍然拒绝', () => {
    const { composed, geoText } = fixture();
    const bogus = replaceMarkerPage(composed, 'f'.repeat(64));
    expect(() => openMapFromUploads([svgUpload(bogus), geoUpload(geoText)])).toThrow(/不配套/);
  });
});

describe('openMapFromUploads:左右居中约束在打开时贴合纸张中心', () => {
  it('手改居中标题的 x/anchor -> 纠回纸张中心,标脏并告警;再导出后打开干净', () => {
    const { geoText } = fixture();
    const parsed = JSON.parse(geoText) as {
      page: { items: Record<string, unknown>[] };
    };
    const titleRaw = parsed.page.items.find(
      (item) => item['kind'] === 'text' && item['role'] === 'title',
    );
    if (titleRaw === undefined) throw new Error('fixture 缺少标题');
    // 绕过 serializeMapDocFile 的 normalizePage,模拟手改过的 page 块
    titleRaw['x'] = 5;
    titleRaw['anchor'] = 'start';
    const tamperedText = `${JSON.stringify(parsed, null, 2)}\n`;

    const opened = openMapFromUploads([svgUpload(BASE_SVG_TEXT), geoUpload(tamperedText)]);
    expect(opened.dirty).toBe(true);
    expect(opened.warnings.some((warning) => warning.includes('左右居中约束'))).toBe(true);
    const openedTitle = opened.layout.items.find(
      (item): item is TextItem =>
        item.kind === 'text' && item.geo_label_id === null && item.role === 'title',
    );
    if (openedTitle === undefined) throw new Error('打开结果缺少标题');
    expect(openedTitle.x).toBe(roundToPageDecimals(opened.layout.paper.width_mm / 2));
    expect(openedTitle.anchor).toBe('middle');

    // 纠偏后导出的文件再打开必须干净(幂等:约束已经落成纸张中心)
    const exported = serializeMapDocFile(opened.document.geo, opened.layout);
    const reopened = openMapFromUploads([svgUpload(BASE_SVG_TEXT), geoUpload(exported)]);
    expect(reopened.dirty).toBe(false);
    expect(reopened.warnings).toEqual([]);
  });
});

describe('打开时页面文字字号保持(纸张改宽不重排的导出->打开幂等)', () => {
  it('只改 paper.width_mm 不重排:重开不因 resync 按新纸面默认字号改写而标脏', () => {
    const { document, layout } = fixture();
    const resized = structuredClone(layout);
    const titleBefore = resized.items.find(
      (item): item is TextItem => item.kind === 'text' && item.role === 'title',
    );
    if (titleBefore === undefined) throw new Error('fixture 缺少标题');
    const titleSize = titleBefore.font_size_mm;
    resized.paper.width_mm = 700; // 模拟侧栏改宽(排版不会自动重排)
    const geoText = serializeMapDocFile(document.geo, resized);

    const opened = openMapFromUploads([svgUpload(BASE_SVG_TEXT), geoUpload(geoText)]);
    expect(opened.dirty).toBe(false);
    expect(opened.warnings).toEqual([]);
    const title = opened.layout.items.find(
      (item): item is TextItem => item.kind === 'text' && item.role === 'title',
    );
    if (title === undefined) throw new Error('打开结果缺少标题');
    // 页面字号沿用文件里的旧纸面值;位置按新纸张宽度由居中约束贴合
    expect(title.font_size_mm).toBe(titleSize);
    expect(title.x).toBe(roundToPageDecimals(700 / 2));
  });
});

describe('旧 pt page 块:不迁移,不告警,直接回退默认排版', () => {
  it('paper 用 width_pt/height_pt 的旧 page 块被静默忽略', () => {
    const geo = makeGeo();
    const legacyPage = {
      paper: {
        preset: 'A4',
        orientation: 'landscape',
        width_pt: 841.889764,
        height_pt: 595.275591,
      },
      map: { x: 28, y: 72, width_pt: 400 },
      frame: {
        show: true,
        stroke: '#000000',
        width_pt: 0.8,
        ticks: true,
        tick_length_pt: 5,
        tick_font_size_pt: 7,
        tick_color: '#444444',
        tick_gap_pt: 2,
      },
      style: {
        paper_color: '#ffffff',
        font_family: 'monospace',
        color: '#111111',
      },
      items: [],
      seq: 1,
    };
    const text = `${JSON.stringify({ ...geo, page: legacyPage }, null, 2)}\n`;
    const opened = openMapFromUploads([
      svgUpload(BASE_SVG_TEXT),
      geoUpload(text, 'fixture.geo.json'),
    ]);
    expect(opened.dirty).toBe(true);
    expect(opened.warnings.some((warning) => warning.includes('page 排版块不合法'))).toBe(false);
    expect(opened.layout.paper.width_mm).toBe(297);
    expect(opened.layout.margin).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });
});
