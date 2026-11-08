/**
 * 导出契约回归测试(P0/P1 审计修复):编辑器能"写出来"的 page 块必须能被自己重新打开.
 *
 * 是什么:针对 2026-11-08 审计发现的 P0(样式/文字越界 -> 导出成功,重开时 validatePage
 * 拒绝并回退默认排版 -> 整份排版丢失)与三个 P1(可选 text_style 缺省抛 TypeError,
 * geo.base.sha256 漏检,成品+配套 geo 被误判不配套)的回归用例.
 * 为什么单独成文件:这些不是某个模块的单元行为,而是"UI 可写值 / 导出入口 / 打开入口"
 * 三者的契约闭环;集中在这里可以参数化地覆盖所有字段边界,并且直接断言导出前自检
 * (`exportPageErrors`)会拒绝越界值,接受边界值.
 * 元信息:作者 ToyosatomiminoMiko,2026-11-08.
 */
import { describe, expect, it } from 'vitest';
import { openMapFromUploads, type MapUploadFile } from '../../src/core/open-map';
import {
  exportPageErrors,
  serializeMapDocFile,
  validateGeo,
  validatePage,
  type PageLayout,
  type TextItem,
} from '../../src/core/page';
import { defaultPageLayout } from '../../src/core/page-layout';
import { composeFinalSvg } from '../../src/render/compose-svg';
import { BASE_SVG_TEXT, makeDocument, makeGeo } from '../fixtures/page-fixtures';

function scene(): { document: ReturnType<typeof makeDocument>; layout: PageLayout } {
  const document = makeDocument(makeGeo());
  const layout = defaultPageLayout(document.geo);
  return { document, layout };
}

function textItemOf(layout: PageLayout, role: TextItem['role']): TextItem {
  const item = layout.items.find(
    (candidate): candidate is TextItem => candidate.kind === 'text' && candidate.role === role,
  );
  if (item === undefined) throw new Error(`fixture 缺少 ${role} 文字`);
  return item;
}

function upload(text: string, name: string): MapUploadFile {
  return { name, bytes: new TextEncoder().encode(text) };
}

describe('导出前自检 exportPageErrors:越界值必须被拒(否则重开丢整份排版)', () => {
  const cases: readonly [string, (layout: PageLayout) => void, string][] = [
    ['纸张宽 2mm', (layout) => (layout.paper.width_mm = 2), 'paper.width_mm'],
    ['纸张高 3000mm', (layout) => (layout.paper.height_mm = 3000), 'paper.height_mm'],
    [
      '样式覆盖字号 200',
      (layout) =>
        (layout.text_style['title'] = { ...layout.text_style['title'], font_size_mm: 200 }),
      'text_style.title.font_size_mm',
    ],
    [
      '样式覆盖行高 6',
      (layout) => (layout.text_style['title'] = { ...layout.text_style['title'], line_height: 6 }),
      'text_style.title.line_height',
    ],
    [
      '样式覆盖字距 3',
      (layout) =>
        (layout.text_style['title'] = { ...layout.text_style['title'], letter_spacing_em: 3 }),
      'text_style.title.letter_spacing_em',
    ],
    [
      '样式覆盖光晕宽 8',
      (layout) =>
        (layout.text_style['city'] = {
          ...layout.text_style['city'],
          halo: { color: '#ffffff', width_mm: 8 },
        }),
      'text_style.city.halo.width_mm',
    ],
    [
      'item 光晕宽为负',
      (layout) => {
        const item = textItemOf(layout, 'title');
        item.halo = { color: '#ffffff', width_mm: -1 };
      },
      'halo.width_mm',
    ],
    [
      '非自动折行文字单行 201 字',
      (layout) => (textItemOf(layout, 'title').lines = ['字'.repeat(201)]),
      '超过 200 字符',
    ],
    [
      '非自动折行文字 41 行',
      (layout) =>
        (textItemOf(layout, 'title').lines = Array.from({ length: 41 }, (_, i) => `行${i}`)),
      '需要 1..40 行',
    ],
    [
      '图例框线宽 0',
      (layout) => {
        const legend = layout.items.find((item) => item.kind === 'legend');
        if (legend?.kind !== 'legend') throw new Error('fixture 缺少图例');
        legend.frame.width_mm = 0;
      },
      'frame.width_mm',
    ],
    [
      '图例宽度 0',
      (layout) => {
        const legend = layout.items.find((item) => item.kind === 'legend');
        if (legend?.kind !== 'legend') throw new Error('fixture 缺少图例');
        legend.width_mm = 0;
      },
      'width_mm: 必须大于 0',
    ],
    [
      '色标宽 0',
      (layout) => {
        const colorbar = layout.items.find((item) => item.kind === 'colorbar');
        if (colorbar?.kind !== 'colorbar') throw new Error('fixture 缺少色标');
        colorbar.width_mm = 0;
      },
      'width_mm: 必须大于 0',
    ],
    ['地图宽 1', (layout) => (layout.map.width_mm = 1), 'map.width_mm'],
    ['图框线宽为负', (layout) => (layout.frame.width_mm = -1), 'frame.width_mm'],
    [
      '地图元素超过 500 个',
      (layout) => {
        const base = layout.items[0];
        if (base === undefined) throw new Error('fixture 缺少元素');
        layout.items = Array.from({ length: 501 }, (_, index) => ({ ...base, id: index + 1 }));
        layout.seq = 502;
      },
      '最多 500',
    ],
  ];

  for (const [label, mutate, expected] of cases) {
    it(label, () => {
      const { document, layout } = scene();
      mutate(layout);
      const errors = exportPageErrors(layout, document.geo);
      expect(errors.length, label).toBeGreaterThan(0);
      expect(errors.join(';'), label).toContain(expected);
    });
  }

  it('边界值合法(字号 0.35/180,行高 0.5/5,字距 -1/2,光晕 0/7):自检通过', () => {
    const { document, layout } = scene();
    layout.text_style['title'] = {
      font_size_mm: 0.35,
      line_height: 0.5,
      letter_spacing_em: -1,
    };
    layout.text_style['city'] = {
      font_size_mm: 180,
      line_height: 5,
      letter_spacing_em: 2,
      halo: { color: '#ffffff', width_mm: 7 },
    };
    // item 侧也同步到同一合法值(item 字段是分类样式的物化结果)
    for (const item of layout.items) {
      if (item.kind === 'text' && item.role === 'title') {
        item.font_size_mm = 0.35;
        item.line_height = 0.5;
        item.letter_spacing_em = -1;
      }
      if (item.kind === 'text' && item.geo_label_id !== null) {
        item.font_size_mm = 180;
        item.line_height = 5;
        item.letter_spacing_em = 2;
        item.halo = { color: '#ffffff', width_mm: 7 };
      }
    }
    expect(exportPageErrors(layout, document.geo)).toEqual([]);
  });

  it('光晕宽度 0 是合法口径(页面分类开光晕的默认宽度):item/覆盖/自检都不拒绝', () => {
    const { document, layout } = scene();
    const title = textItemOf(layout, 'title');
    title.halo = { color: '#ffffff', width_mm: 0 };
    layout.text_style['title'] = { halo: { color: '#ffffff', width_mm: 0 } };
    expect(validatePage(layout, document.geo).ok).toBe(true);
    expect(exportPageErrors(layout, document.geo)).toEqual([]);
  });
});

describe('打开流程回归:可选字段缺省/配套产物不得抛 TypeError 或被误拒', () => {
  it('page 块只缺可选 text_style:打开成功且不标脏', () => {
    const { document, layout } = scene();
    const geoText = serializeMapDocFile(document.geo, layout);
    const parsed = JSON.parse(geoText) as Record<string, unknown>;
    const page = parsed['page'] as Record<string, unknown>;
    delete page['text_style'];
    const opened = openMapFromUploads([
      upload(BASE_SVG_TEXT, 'fixture.svg'),
      upload(JSON.stringify(parsed), 'fixture.geo.json'),
    ]);
    expect(opened.source).toBe('base');
    expect(opened.dirty).toBe(false);
    expect(opened.layout.items.length).toBe(layout.items.length);
  });

  it('成品 SVG + 导出时的配套 geo.json(存储 page 与 marker 一致):不得误判不配套', () => {
    const { document, layout } = scene();
    // 模拟"旧排版":item 上残留一条与分类默认不一致的逐条样式,打开时 resync 会统一它.
    // 旧实现拿 resync 后的 layout 去比 marker.page,必然失配并抛"JSON 拿错了".
    textItemOf(layout, 'title').color = '#ff0000';
    const geoText = serializeMapDocFile(document.geo, layout);
    const finalSvg = composeFinalSvg(document, layout).svg;
    const opened = openMapFromUploads([
      upload(finalSvg, 'fixture.svg'),
      upload(geoText, 'fixture.geo.json'),
    ]);
    expect(opened.source).toBe('final');
    expect(opened.dirty).toBe(true);
    expect(opened.warnings.some((warning) => warning.includes('文字样式已按分类设置统一'))).toBe(
      true,
    );
  });

  it('validateGeo:base.sha256 缺失/非字符串/非 64 位十六进制都要在字段校验阶段拒绝', () => {
    const variants: readonly [unknown, string][] = [
      [undefined, 'geo.base.sha256'],
      [123, 'geo.base.sha256'],
      ['deadbeef', 'geo.base.sha256'],
      ['z'.repeat(64), 'geo.base.sha256'],
    ];
    for (const [value, expected] of variants) {
      const geo = structuredClone(makeGeo()) as unknown as Record<string, unknown>;
      const base = geo['base'] as Record<string, unknown>;
      if (value === undefined) delete base['sha256'];
      else base['sha256'] = value;
      const errors = validateGeo(geo);
      expect(errors.some((error) => error.includes(expected))).toBe(true);
    }
    // 大写十六进制合法(摘要比较大小写不敏感)
    const upper = structuredClone(makeGeo());
    upper.base.sha256 = upper.base.sha256.toUpperCase();
    expect(validateGeo(upper)).toEqual([]);
  });

  it('默认排版把超长标题收敛到契约上限(≤200 字),生成后即可通过校验', () => {
    const geo = makeGeo();
    geo.suggestions.title = '字'.repeat(250);
    geo.suggestions.subtitle = '副'.repeat(250);
    const layout = defaultPageLayout(geo);
    const title = textItemOf(layout, 'title');
    const subtitle = textItemOf(layout, 'subtitle');
    expect(title.lines[0]?.length).toBe(200);
    expect(subtitle.lines[0]?.length).toBe(200);
    expect(validatePage(layout, geo).ok).toBe(true);
  });
});
