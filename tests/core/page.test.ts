/**
 * `core/page.ts`(契约 codec/校验)与 `core/page-layout.ts`(§5 布局公式)的单测.
 *
 * 为什么是 node 环境:这两层必须不碰 DOM--文本测量以参数注入,默认回退是纯字符宽度估算;
 * 这里用固定 geo/base 检查默认排版,刻度/图例/色标位置与序列化确定性.
 * 元信息:作者 ToyosatomiminoMiko,2026-11-05.
 */

import { describe, expect, it } from 'vitest';
import {
  allocateItemId,
  countItems,
  enforceHorizontalCenter,
  itemById,
  itemSummary,
  normalizePage,
  roundToPageDecimals,
  pageDigest,
  serializeMapDocFile,
  serializePage,
  sha256Hex,
  validateGeo,
  validatePage,
  type Geo,
  type PageLayout,
  type TextItem,
} from '../../src/core/page';
import {
  colorbarLayout,
  colorbarTitleText,
  defaultPageLayout,
  fallbackMeasureText,
  fontShorthand,
  frameTickLayout,
  legendLayout,
  mapHeightMm,
  mapPointToPage,
  mapTransform,
  pagePointToMap,
  textLayout,
  wrapParagraphs,
  wrapText,
} from '../../src/core/page-layout';
import {
  colorbarGradientId,
  dashArray,
  escapeXmlAttribute,
  escapeXmlText,
  formatPageNumber,
  gradientOffset,
  opacityValue,
} from '../../src/render/page-format';

/** 构造一份最小 geo:底图 896.350289 × 712.3824,含 2 条经度/2 条纬度刻度,2 个地名 */
function makeGeo(): Geo {
  return {
    format: 'mapdoc-geo',
    version: 2,
    base: {
      sha256: 'a'.repeat(64),
      view_box: [38.88, 102.7728, 896.350289, 712.3824],
      width_pt: 896.350289,
      height_pt: 712.3824,
    },
    graticule: {
      lon: [
        { value: 35, label: '35°E', x: 169.527973, y: 815.1552, side: 'bottom' },
        { value: 40, label: '40°E', x: 369.1355, y: 815.1552, side: 'bottom' },
      ],
      lat: [
        { value: 46, label: '46°N', x: 50.88, y: 731.037789, side: 'left' },
        { value: 50, label: '50°N', x: 50.88, y: 531.037789, side: 'right' },
      ],
      style: { stroke: '#808080', width_pt: 0.5, dash: [0.5, 0.825], opacity: 0.4 },
    },
    labels: [
      {
        id: 'label-country-A',
        role: 'country',
        text: '甲国',
        x: 719.381081,
        y: 703.365097,
        anchor: 'middle',
        font_size_pt: 12,
        order: 0,
      },
      {
        id: 'label-river-B',
        role: 'river',
        text: '乙河',
        x: 300,
        y: 400,
        anchor: 'start',
        font_size_pt: 9,
        order: 1,
      },
    ],
    relief: {
      title: '高程 / 水深',
      unit: 'm',
      vmin: -2500,
      vmax: 2500,
      stops: [
        { offset: 0, color: '#08306b' },
        { offset: 1, color: '#ffffff' },
      ],
      ticks: [-2000, -1000, 0, 1000, 2000],
    },
    legend: {
      title: '图例',
      entries: [
        {
          label: '国界',
          shape: 'line',
          stroke: '#4a4a4a',
          width_pt: 1.4,
          dash: null,
          fill: null,
          opacity: 1,
          marker: null,
        },
        {
          label: '湖泊',
          shape: 'rect',
          stroke: '#2e6f9e',
          width_pt: 0.8,
          dash: null,
          fill: '#9ecae1',
          opacity: 1,
          marker: null,
        },
        {
          label: '城市',
          shape: 'point',
          stroke: '#cc3333',
          width_pt: 0.6,
          dash: null,
          fill: '#cc3333',
          opacity: 1,
          marker: 'circle',
        },
      ],
    },
    suggestions: {
      title: '伏尔加河流域地形图',
      subtitle: 'ETOPO 2022 | 流域: HydroSHEDS | 国界: GADM 4.1',
      notes: [
        '注 1:这是一段足够长的右栏注记,用来验证默认排版会按右栏可用宽度折行后写进 lines 数组,而不是交给渲染期自动换行.',
        '注 2:第二行注记.',
      ],
      source: '地形: NOAA NCEI ETOPO 2022(15″) | 流域: HydroSHEDS | 国界: GADM 4.1',
      area_annotation: ['伏尔加河流域', '约 141 万 km²'],
      legend_title: '图例',
      colorbar_title: '高程 / 水深',
    },
  };
}

/** 默认排版结果(多数用例共用) */
function makeScene(): PageLayout {
  return defaultPageLayout(makeGeo());
}

describe('formatPageNumber(与 Python 侧同语义)', () => {
  it('3 位小数,去尾零,无单位', () => {
    expect(formatPageNumber(28)).toBe('28');
    expect(formatPageNumber(28.0)).toBe('28');
    expect(formatPageNumber(28.5)).toBe('28.5');
    expect(formatPageNumber(0.3125)).toBe('0.313');
    expect(formatPageNumber(1.2346)).toBe('1.235');
    expect(formatPageNumber(100)).toBe('100');
    expect(formatPageNumber(-0)).toBe('0');
    expect(formatPageNumber(-0.0004)).toBe('0');
  });

  it('非有限值落成 0', () => {
    expect(formatPageNumber(Number.NaN)).toBe('0');
    expect(formatPageNumber(Number.POSITIVE_INFINITY)).toBe('0');
  });

  it('虚线/透明度/渐变 offset 属性', () => {
    expect(dashArray(null)).toBeUndefined();
    expect(dashArray([0.5, 0.825])).toBe('0.5 0.825');
    expect(opacityValue(0.94)).toBe('0.94');
    expect(opacityValue(1.2)).toBe('1');
    expect(gradientOffset(1)).toBe('1');
    expect(colorbarGradientId(4)).toBe('mapdoc-cbar-4');
  });

  it('XML 转义', () => {
    expect(escapeXmlText('a & <b> c')).toBe('a &amp; &lt;b&gt; c');
    expect(escapeXmlAttribute('a"b\'c&')).toBe('a&quot;b&apos;c&amp;');
  });
});

describe('规范化与序列化', () => {
  it('roundToPageDecimals 用 JS Math.round 语义并归一负零', () => {
    expect(roundToPageDecimals(0.3125)).toBe(0.313);
    expect(roundToPageDecimals(-0.0004)).toBe(0);
    expect(roundToPageDecimals(28.0000001)).toBe(28);
  });

  it('serializePage 键排序,无空白,数字 3 位小数', () => {
    const layout = makeScene();
    const text = serializePage(layout);
    expect(text.startsWith('{"frame":')).toBe(true);
    // 无缩进/分隔空白(字符串内部的空格不算,如字体栈与副标题)
    expect(text).not.toContain('": ');
    expect(text).not.toContain('", "');
    expect(text).not.toContain('\n');
    // 规范化:A4 宽度 841.889764 -> 841.89
    expect(text).toContain('"width_mm":297');
    // 键序稳定:同一 layout 两次序列化结果一致
    expect(serializePage(makeScene())).toBe(text);
  });

  it('normalizePage 不修改入参且 3 位小数', () => {
    const layout = makeScene();
    layout.paper.width_mm = 297.00049;
    const normalized = normalizePage(layout);
    expect(normalized).not.toBe(layout);
    expect(normalized.paper.width_mm).toBe(297);
    expect(layout.paper.width_mm).toBeCloseTo(297.00049, 6);
  });

  it('sha256Hex 标准向量', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('pageDigest 稳定且对改动敏感', () => {
    const layout = makeScene();
    const digest = pageDigest(layout);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(pageDigest(normalizePage(layout))).toBe(digest);
    layout.map.x += 1;
    expect(pageDigest(layout)).not.toBe(digest);
  });
});

describe('validatePage', () => {
  it('defaultPageLayout 通过校验且 geo 校验无错误', () => {
    const geometry = makeGeo();
    expect(validateGeo(geometry)).toEqual([]);
    const layout = defaultPageLayout(geometry);
    const result = validatePage(layout, geometry);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.layout.items.length).toBeGreaterThan(5);
      expect(result.warnings).toEqual([]);
    }
  });

  it('拒绝非法纸张尺寸,重复 id,seq 不大于最大 id', () => {
    const layout = makeScene();
    layout.paper.width_mm = 10;
    expect(validatePage(layout).ok).toBe(false);

    const duplicate = makeScene();
    duplicate.items.push({ ...duplicate.items[0]! });
    expect(validatePage(duplicate).ok).toBe(false);

    const badSeq = makeScene();
    badSeq.seq = 1;
    expect(validatePage(badSeq).ok).toBe(false);
  });

  it('拒绝非法颜色与空 lines', () => {
    const layout = makeScene();
    const text = layout.items.find((item): item is TextItem => item.kind === 'text')!;
    text.color = 'red';
    expect(validatePage(layout).ok).toBe(false);

    const empty = makeScene();
    const firstText = empty.items.find((item): item is TextItem => item.kind === 'text')!;
    firstText.lines = [];
    expect(validatePage(empty).ok).toBe(false);
  });

  it('拒绝非法字重/字距(100..900 整数,-1..2 有限数)', () => {
    for (const weight of [50, 950, 450.5, Number.NaN]) {
      const layout = makeScene();
      const text = layout.items.find((item): item is TextItem => item.kind === 'text')!;
      text.font_weight = weight;
      expect(validatePage(layout).ok).toBe(false);
    }
    for (const spacing of [-1.5, 2.5, Number.NaN]) {
      const layout = makeScene();
      const text = layout.items.find((item): item is TextItem => item.kind === 'text')!;
      text.letter_spacing_em = spacing;
      expect(validatePage(layout).ok).toBe(false);
    }
    // 边界值合法:权重 100/900,字距 -1/2
    for (const [weight, spacing] of [
      [100, -1],
      [900, 2],
    ] as const) {
      const layout = makeScene();
      const text = layout.items.find((item): item is TextItem => item.kind === 'text')!;
      text.font_weight = weight;
      text.letter_spacing_em = spacing;
      expect(validatePage(layout).ok).toBe(true);
    }
  });

  it('地图越界只告警不报错', () => {
    const layout = makeScene();
    layout.map.x = -50;
    const result = validatePage(layout, makeGeo());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('元素辅助函数', () => {
    const layout = makeScene();
    expect(countItems(layout)).toBe(layout.items.length);
    expect(itemById(layout, layout.items[0]!.id)).toBe(layout.items[0]);
    const before = layout.seq;
    const id = allocateItemId(layout);
    expect(id).toBe(before);
    expect(layout.seq).toBe(before + 1);
    expect(itemSummary(layout.items[0]!).length).toBeGreaterThan(0);
  });
});

describe('defaultPageLayout(§9 初始排版)', () => {
  it('A4 横向:纸张 mm,页边距默认 0,地图占左侧,右栏三块,标题/副标题/来源都在', () => {
    const layout = makeScene();
    expect(layout.paper).toEqual({
      preset: 'A4',
      orientation: 'landscape',
      width_mm: 297,
      height_mm: 210,
      locked: false,
    });
    expect(layout.margin).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    // 初始版式的内部内缩 10mm / 地图顶 26mm(不是页边距)
    expect(layout.map.x).toBe(10);
    expect(layout.map.y).toBe(26);
    expect(layout.map.width_mm).toBeGreaterThan(1);
    expect(layout.map.x + layout.map.width_mm).toBeLessThan(297);

    const roles = layout.items
      .filter((item): item is TextItem => item.kind === 'text' && item.geo_label_id === null)
      .map((item) => item.role);
    expect(roles).toContain('title');
    expect(roles).toContain('subtitle');
    expect(roles).toContain('note');
    expect(roles).toContain('source');

    const legend = layout.items.find((item) => item.kind === 'legend')!;
    const colorbar = layout.items.find((item) => item.kind === 'colorbar')!;
    expect(legend.kind).toBe('legend');
    expect(colorbar.kind).toBe('colorbar');
    // 右栏:legend -> notes -> colorbar 自上而下
    if (legend.kind === 'legend' && colorbar.kind === 'colorbar') {
      const note = layout.items.find(
        (item) => item.kind === 'text' && item.role === 'note',
      ) as TextItem;
      expect(legend.y).toBeLessThan(note.y);
      expect(colorbar.y).toBeGreaterThan(note.y);
      expect(legend.x).toBeCloseTo(colorbar.x - (legend.width_mm - colorbar.width_mm) / 2, 9);
    }
  });

  it('全部地名都作为纸张坐标文字铺上,id 唯一,seq 大于最大 id', () => {
    const layout = makeScene();
    const labels = layout.items.filter(
      (item): item is TextItem => item.kind === 'text' && item.geo_label_id !== null,
    );
    expect(labels).toHaveLength(makeGeo().labels.length);
    expect(labels[0]!.lines).toEqual(['甲国']);
    // 地名字号按地图缩放比换算(Lead 联调结论:否则相对原图放大 1.7 倍压字)
    const scale = layout.map.width_mm / makeGeo().base.width_pt;
    // 地图分类字号恒统一:country 只有一条 12pt -> 中位数 × s,夹 1.5..15mm 并保留 1 位小数
    const expectedSize = Math.round(Math.min(15, Math.max(1.5, 12 * scale)) * 10) / 10;
    expect(labels[0]!.font_size_mm).toBe(expectedSize);
    // 颜色/斜体来自 role 表;描边宽度是纸面常量(不随 s 缩放),旋转统一 0
    expect(labels[0]!.color).toBe('#3a3a3a');
    expect(labels[0]!.italic).toBe(false);
    expect(labels[0]!.halo).toEqual({ color: '#ffffff', width_mm: 0.18 });
    expect(labels[1]!.color).toBe('#2d6ea6');
    expect(labels[1]!.italic).toBe(true);
    expect(labels[1]!.rotation_deg).toBe(0);
    expect(labels[1]!.anchor).toBe('start');

    const ids = layout.items.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(layout.seq).toBe(Math.max(...ids) + 1);
  });

  it('注记按右栏宽度折行写入 lines(自动折行口径)', () => {
    const layout = makeScene();
    const note = layout.items.find(
      (item): item is TextItem => item.kind === 'text' && item.role === 'note',
    )!;
    expect(note.lines.length).toBeGreaterThan(2);
    expect(note.anchor).toBe('start');
    const legend = layout.items.find((item) => item.kind === 'legend')!;
    const font = fontShorthand(note.font_size_mm, layout.style.font_family);
    for (const line of note.lines) {
      expect(fallbackMeasureText(line, font)).toBeLessThanOrEqual(legend.width_mm);
    }
  });

  it('legend width 按最长 label 测量,右栏宽度足够', () => {
    const layout = makeScene();
    const legend = layout.items.find((item) => item.kind === 'legend');
    expect(legend?.kind).toBe('legend');
    if (legend?.kind !== 'legend') return;
    const geo = makeGeo();
    const font = fontShorthand(legend.font_size_mm, layout.style.font_family);
    const maxLabel = Math.max(
      ...geo.legend.entries.map((entry) => fallbackMeasureText(entry.label, font)),
    );
    expect(legend.width_mm).toBeGreaterThanOrEqual(
      legend.padding_mm * 2 + legend.swatch_width_mm + legend.swatch_gap_mm + maxLabel,
    );
  });

  it('保留传入纸张(默认排版不重置纸张)', () => {
    const paper = {
      preset: 'A5' as const,
      orientation: 'landscape' as const,
      width_mm: 210,
      height_mm: 148,
      locked: false,
    };
    const layout = defaultPageLayout(makeGeo(), { paper });
    expect(layout.paper).toEqual(paper);
    expect(layout.paper).not.toBe(paper);
    expect(layout.map.x).toBe(10);
  });
});

describe('纸张自适应(defaultPageLayout 的 k)', () => {
  it('A5 横向默认排版:注记与色标不重叠,不越过页底预留区', () => {
    const geo = makeGeo();
    const a5 = {
      preset: 'A5' as const,
      orientation: 'landscape' as const,
      width_mm: 210,
      height_mm: 148,
      locked: false,
    };
    const layout = defaultPageLayout(geo, { paper: a5 });
    expect(validatePage(layout, geo).ok).toBe(true);

    const note = layout.items.find(
      (item): item is TextItem => item.kind === 'text' && item.role === 'note',
    );
    const colorbar = layout.items.find((item) => item.kind === 'colorbar');
    expect(note).toBeDefined();
    expect(colorbar?.kind).toBe('colorbar');
    if (!note || colorbar?.kind !== 'colorbar') return;

    // k:A5 横向 / A4 横向(长边比长边,短边比短边,夹在 0.62..1.6)
    const k = Math.min(1.6, Math.max(0.62, Math.min(a5.width_mm / 297, a5.height_mm / 210)));
    expect(k).toBeLessThan(1);
    const inset = 10;
    const sourceReserved = 9 * k;

    // 色标不压注记,且不越过页底(内部内缩 + 来源预留区)
    const noteLastBaseline =
      note.y + (note.lines.length - 1) * note.font_size_mm * note.line_height;
    expect(colorbar.y).toBeGreaterThan(noteLastBaseline);
    expect(colorbar.y + colorbar.height_mm).toBeLessThanOrEqual(
      a5.height_mm - inset - sourceReserved + 1e-6,
    );
    expect(colorbar.height_mm).toBeGreaterThanOrEqual(14);

    // 图例/版式间距按 k 缩小;页面文字字号固定(mm),地名字号只跟地图缩放 s
    const legend = layout.items.find((item) => item.kind === 'legend');
    if (legend?.kind === 'legend') expect(legend.font_size_mm).toBeCloseTo(3 * k, 9);
    expect(note.font_size_mm).toBeCloseTo(3, 9);
    const title = layout.items.find(
      (item): item is TextItem => item.kind === 'text' && item.role === 'title',
    );
    const sourceText = layout.items.find(
      (item): item is TextItem => item.kind === 'text' && item.role === 'source',
    );
    expect(title?.font_size_mm).toBeCloseTo(6, 9);
    expect(sourceText?.font_size_mm).toBeCloseTo(2, 9);
    const label = layout.items.find(
      (item): item is TextItem => item.kind === 'text' && item.geo_label_id !== null,
    );
    // 地图分类统一字号 = 该分类地名原始字号中位数 × s,夹 1.5..15mm,保留 1 位小数
    const labelScale = layout.map.width_mm / geo.base.width_pt;
    expect(label?.font_size_mm).toBe(
      Math.round(Math.min(15, Math.max(1.5, 12 * labelScale)) * 10) / 10,
    );

    // 来源仍在页内,地图不越过来源预留区
    const source = layout.items.find(
      (item): item is TextItem => item.kind === 'text' && item.role === 'source',
    );
    expect(source?.y).toBeLessThanOrEqual(a5.height_mm - inset);
    expect(
      layout.map.y + (layout.map.width_mm * geo.base.height_pt) / geo.base.width_pt,
    ).toBeLessThan(a5.height_mm - inset);
  });

  it('A4 横向 k=1:版式与 mm 默认值一致', () => {
    const layout = makeScene();
    const legend = layout.items.find((item) => item.kind === 'legend');
    if (legend?.kind === 'legend') expect(legend.font_size_mm).toBeCloseTo(3, 9);
    const note = layout.items.find(
      (item): item is TextItem => item.kind === 'text' && item.role === 'note',
    );
    expect(note?.font_size_mm).toBeCloseTo(3, 9);
    expect(layout.map.y).toBe(26);
  });
  it('A4/A5 纵向:地图用满内容宽,下方一排三块,互不覆盖且不越界', () => {
    const geo = makeGeo();
    const cases = [
      { widthMm: 210, heightMm: 297 },
      { widthMm: 148, heightMm: 210 },
    ];
    for (const { widthMm, heightMm } of cases) {
      const paper = {
        preset: widthMm === 210 ? ('A4' as const) : ('A5' as const),
        orientation: 'portrait' as const,
        width_mm: widthMm,
        height_mm: heightMm,
        locked: false,
      };
      const layout = defaultPageLayout(geo, { paper });
      expect(validatePage(layout, geo).ok).toBe(true);

      const k = Math.min(
        1.6,
        Math.max(
          0.62,
          Math.min(Math.max(widthMm, heightMm) / 297, Math.min(widthMm, heightMm) / 210),
        ),
      );

      // 地图用满内容宽度,标题仍在页顶
      expect(layout.map.x).toBe(10);
      expect(layout.map.width_mm).toBeCloseTo(widthMm - 20, 9);
      expect(layout.map.y).toBeCloseTo(26, 9);

      const legend = layout.items.find((item) => item.kind === 'legend');
      const note = layout.items.find(
        (item): item is TextItem => item.kind === 'text' && item.role === 'note',
      );
      const colorbar = layout.items.find((item) => item.kind === 'colorbar');
      expect(legend?.kind).toBe('legend');
      expect(note).toBeDefined();
      expect(colorbar?.kind).toBe('colorbar');
      if (legend?.kind !== 'legend' || !note || colorbar?.kind !== 'colorbar') continue;

      const legendHeight = legendLayout(legend).height;
      const mapBottom =
        layout.map.y + (layout.map.width_mm * geo.base.height_pt) / geo.base.width_pt;
      // 纵向一排要让开经度刻度标签(tick 字号不随 k 缩),并额外留出注记字形上沿
      const noteSize = note.font_size_mm;
      const tickLabelBottom =
        layout.frame.tick_length_mm +
        layout.frame.tick_gap_mm +
        layout.frame.tick_font_size_mm * 1.2;
      const tickExtent = layout.frame.ticks
        ? tickLabelBottom + Math.max(6 * k, noteSize * 0.8 + 1.4)
        : 0;
      expect(legend.y).toBeCloseTo(mapBottom + Math.max(4 * k, tickExtent), 9);
      expect(legend.y).toBeGreaterThan(mapBottom);

      // 三块同一排:图例在左,注记居中,色标贴右,互不相交
      expect(legend.x).toBe(10);
      expect(legend.y).toBeCloseTo(note.y, 9);
      expect(legend.x + legend.width_mm).toBeLessThanOrEqual(note.x + 1e-9);
      expect(note.x).toBeLessThan(colorbar.x);
      expect(colorbar.x + colorbar.width_mm).toBeCloseTo(widthMm - 10, 9);

      const noteFont = fontShorthand(note.font_size_mm, layout.style.font_family);
      const noteWidth = Math.max(...note.lines.map((line) => fallbackMeasureText(line, noteFont)));
      expect(note.x + noteWidth).toBeLessThanOrEqual(colorbar.x + 1e-6);

      // 色标标题(基线 y-1.4)在整排之内,不画到地图底/刻度标签上
      const titleBlock = 3 * k * 1.4 + 1.4;
      const rowHeight = Math.max(
        legendHeight,
        note.lines.length * note.font_size_mm * note.line_height,
        14 + titleBlock,
      );
      const rowBottom = legend.y + rowHeight;
      const bottomLimit = heightMm - 10 - 9 * k;
      expect(colorbar.height_mm).toBeCloseTo(
        Math.max(14, Math.min(64 * k, rowHeight - titleBlock)),
        6,
      );
      expect(colorbar.y + colorbar.height_mm).toBeCloseTo(rowBottom, 6);
      expect(colorbar.y - 1.4).toBeGreaterThan(legend.y);
      expect(rowBottom).toBeLessThanOrEqual(bottomLimit + 1e-6);
      expect(legendHeight).toBeLessThanOrEqual(bottomLimit + 1e-6);

      const noteBottom = note.y + (note.lines.length - 1) * note.font_size_mm * note.line_height;
      expect(noteBottom).toBeLessThanOrEqual(rowBottom + 1e-6);

      const source = layout.items.find(
        (item): item is TextItem => item.kind === 'text' && item.role === 'source',
      );
      expect(source?.y).toBeLessThanOrEqual(heightMm - 10);
    }
  });
});

describe('§5.1 坐标变换', () => {
  it('底图坐标 -> 纸张坐标并反解', () => {
    const geo = makeGeo();
    const layout = makeScene();
    const transform = mapTransform(geo, layout.map);
    const s = layout.map.width_mm / geo.base.width_pt;
    expect(transform.s).toBeCloseTo(s, 12);
    expect(transform.tx).toBeCloseTo(layout.map.x - geo.base.view_box[0] * s, 9);
    expect(transform.ty).toBeCloseTo(layout.map.y - geo.base.view_box[1] * s, 9);

    const page = mapPointToPage(transform, { x: geo.base.view_box[0], y: geo.base.view_box[1] });
    expect(page.x).toBeCloseTo(layout.map.x, 9);
    expect(page.y).toBeCloseTo(layout.map.y, 9);

    const back = pagePointToMap(transform, { x: page.x + 100 * s, y: page.y + 50 * s });
    expect(back.x).toBeCloseTo(geo.base.view_box[0] + 100, 9);
    expect(back.y).toBeCloseTo(geo.base.view_box[1] + 50, 9);
  });

  it('地图高度按纵横比派生', () => {
    const geo = makeGeo();
    const layout = makeScene();
    expect(mapHeightMm(geo, layout.map)).toBeCloseTo(
      (layout.map.width_mm * geo.base.height_pt) / geo.base.width_pt,
      12,
    );
  });
});

describe('§5.2 图框/刻度', () => {
  it('经度 bottom:线向下,基线 = 框底 + 刻度长 + gap + 字号', () => {
    const geo = makeGeo();
    const layout = makeScene();
    const ticks = frameTickLayout(layout, geo);
    const lon = ticks.filter((tick) => tick.axis === 'lon');
    expect(lon).toHaveLength(2);
    const first = lon[0]!;
    const transform = mapTransform(geo, layout.map);
    const mapBottom = layout.map.y + mapHeightMm(geo, layout.map);
    expect(first.x1).toBeCloseTo(transform.tx + geo.graticule.lon[0]!.x * transform.s, 9);
    expect(first.y1).toBeCloseTo(mapBottom, 9);
    expect(first.y2).toBeCloseTo(mapBottom + layout.frame.tick_length_mm, 9);
    expect(first.textY).toBeCloseTo(
      mapBottom +
        layout.frame.tick_length_mm +
        layout.frame.tick_gap_mm +
        layout.frame.tick_font_size_mm,
      9,
    );
    expect(first.anchor).toBe('middle');
  });

  it('纬度 left/right:线向外,基线 = py + 字号×0.35', () => {
    const geo = makeGeo();
    const layout = makeScene();
    const ticks = frameTickLayout(layout, geo).filter((tick) => tick.axis === 'lat');
    expect(ticks).toHaveLength(2);
    const left = ticks.find((tick) => tick.side === 'left')!;
    const right = ticks.find((tick) => tick.side === 'right')!;
    const transform = mapTransform(geo, layout.map);
    const py = transform.ty + geo.graticule.lat[0]!.y * transform.s;
    expect(left.x1).toBeCloseTo(layout.map.x, 9);
    expect(left.x2).toBeCloseTo(layout.map.x - layout.frame.tick_length_mm, 9);
    expect(left.textX).toBeCloseTo(
      layout.map.x - layout.frame.tick_length_mm - layout.frame.tick_gap_mm,
      9,
    );
    expect(left.textY).toBeCloseTo(py + layout.frame.tick_font_size_mm * 0.35, 9);
    expect(left.anchor).toBe('end');
    expect(right.anchor).toBe('start');
    expect(right.textX).toBeCloseTo(
      layout.map.x + layout.map.width_mm + layout.frame.tick_length_mm + layout.frame.tick_gap_mm,
      9,
    );
  });

  it('纸张外的刻度被过滤', () => {
    const geo = makeGeo();
    const layout = makeScene();
    geo.graticule.lon.push({ value: 1, label: '1°E', x: 100000, y: 0, side: 'bottom' });
    expect(frameTickLayout(layout, geo).filter((tick) => tick.axis === 'lon')).toHaveLength(2);
  });
});

describe('§5.4 图例', () => {
  it('高度公式与行位置', () => {
    const layout = makeScene();
    const legend = layout.items.find((item) => item.kind === 'legend');
    if (legend?.kind !== 'legend') throw new Error('缺少图例');
    const legendBox = legendLayout(legend);
    const padding = legend.padding_mm;
    const rowHeight = Math.max(legend.row_height_mm, legend.font_size_mm * 1.5);
    const titleHeight = legend.title.length > 0 ? legend.title_size_mm * 1.4 : 0;
    expect(legendBox.height).toBeCloseTo(
      padding * 2 + titleHeight + legend.entries.length * rowHeight,
      9,
    );
    expect(legendBox.titleBaseline).toBeCloseTo(legend.y + padding + legend.title_size_mm, 9);
    const firstRow = legendBox.rows[0]!;
    expect(firstRow.centerY).toBeCloseTo(legend.y + padding + titleHeight + rowHeight * 0.5, 9);
    expect(firstRow.labelBaseline).toBeCloseTo(firstRow.centerY + legend.font_size_mm * 0.35, 9);
    expect(firstRow.swatchX0).toBeCloseTo(legend.x + padding, 9);
    expect(firstRow.swatchX1).toBeCloseTo(firstRow.swatchX0 + legend.swatch_width_mm, 9);
    expect(firstRow.labelX).toBeCloseTo(firstRow.swatchX1 + legend.swatch_gap_mm, 9);
  });
});

describe('§5.5 色标', () => {
  it('tick 位置按 vmin/vmax 线性映射,标题居中且带单位', () => {
    const layout = makeScene();
    const colorbar = layout.items.find((item) => item.kind === 'colorbar');
    if (colorbar?.kind !== 'colorbar') throw new Error('缺少色标');
    // fixture 的 geo 一定带 relief;类型上 relief 可空(无色标的 geo),这里取非空断言
    const relief = makeGeo().relief!;
    const bar = colorbarLayout(colorbar, relief);
    expect(bar.titleText).toBe('高程 / 水深 (m)');
    expect(bar.titleX).toBeCloseTo(colorbar.x + colorbar.width_mm / 2, 9);
    expect(bar.titleBaseline).toBeCloseTo(colorbar.y - 1.4, 9);
    const tick0 = bar.ticks[0]!;
    expect(tick0.ty).toBeCloseTo(
      colorbar.y +
        colorbar.height_mm * (1 - (tick0.value - relief.vmin) / (relief.vmax - relief.vmin)),
      9,
    );
    expect(tick0.x1).toBeCloseTo(colorbar.x + colorbar.width_mm, 9);
    expect(tick0.x2).toBeCloseTo(colorbar.x + colorbar.width_mm + 1, 9);
    expect(tick0.labelX).toBeCloseTo(colorbar.x + colorbar.width_mm + 2, 9);
    expect(tick0.labelBaseline).toBeCloseTo(tick0.ty + colorbar.label_size_mm * 0.35, 9);
  });

  it('色标标题不重复单位', () => {
    const layout = makeScene();
    const colorbar = layout.items.find((item) => item.kind === 'colorbar');
    if (colorbar?.kind !== 'colorbar') throw new Error('缺少色标');
    const withUnit = { ...colorbar, title: '高程 (m)' };
    expect(colorbarTitleText(withUnit)).toBe('高程 (m)');
    expect(colorbarTitleText({ ...colorbar, unit: '' })).toBe(colorbar.title);
  });
});

describe('§5.3 文字布局', () => {
  it('多行基线 = 首行 + i × 字号 × 行高', () => {
    const layout = makeScene();
    const label = layout.items.find(
      (item): item is TextItem => item.kind === 'text' && item.geo_label_id !== null,
    )!;
    const text = textLayout(label);
    // 地名打开时已换算成纸张坐标:文本起点就是 item.x/item.y,不再有第二套变换.
    expect(text.px).toBeCloseTo(label.x, 9);
    expect(text.py).toBeCloseTo(label.y, 9);
    expect(text.lines[0]!.y).toBeCloseTo(text.py, 9);

    const multi = { ...label, lines: ['一', '二', '三'], line_height: 1.5 };
    const multiLayout = textLayout(multi);
    const step = multi.font_size_mm * 1.5;
    expect(multiLayout.lines.map((line) => line.y)).toEqual([
      expect.closeTo(multiLayout.py, 9),
      expect.closeTo(multiLayout.py + step, 9),
      expect.closeTo(multiLayout.py + step * 2, 9),
    ]);
  });
});

describe('文字折行', () => {
  it('按宽度折行,保留显式换行,超长词硬切', () => {
    const font = fontShorthand(9, 'sans-serif');
    const lines = wrapText('abcdefghij', font, 30);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(fallbackMeasureText(line, font)).toBeLessThanOrEqual(30);
    }
    const paragraphs = wrapParagraphs(['第一行\n第二行'], font, 500);
    expect(paragraphs[0]).toBe('第一行');
    expect(paragraphs[1]).toBe('第二行');
  });
});

/* ======================================================================
 * 分类文字样式:page.text_style 与 text item geo_label_id
 * ====================================================================== */

/** 把 layout 克隆成可写任意坏数据的普通对象(validatePage 接收 unknown) */
function mutablePage(): Record<string, unknown> {
  return structuredClone(makeScene()) as unknown as Record<string, unknown>;
}

/** 校验 page 块并只取错误清单(ok 时返回空数组) */
function errorsOf(value: unknown): readonly string[] {
  const result = validatePage(value);
  return result.ok ? [] : result.errors;
}

describe('page.text_style 校验(§1.1)', () => {
  it('defaultPageLayout 回写 text_style:{} 且通过校验;text item 都带 geo_label_id', () => {
    const layout = makeScene();
    expect(layout.text_style).toEqual({});
    expect(validatePage(layout, makeGeo()).ok).toBe(true);
    for (const item of layout.items) {
      if (item.kind !== 'text') continue;
      // 地图地名 item 记录来源 label.id;页面文字恒为 null
      if (item.geo_label_id !== null) expect(typeof item.geo_label_id).toBe('string');
      else expect(item.geo_label_id).toBeNull();
    }
  });

  it('合法覆盖(7 个字段)通过校验', () => {
    // 覆盖只允许 7 个已知键;字号是绝对值(不存在 null = 跟随旧数据的写法).
    const page = mutablePage();
    page['text_style'] = {
      title: {
        font_size_mm: 20,
        color: '#111111',
        italic: false,
        font_weight: 600,
        letter_spacing_em: 0.02,
        line_height: 1.35,
        halo: null,
      },
      city: { color: '#222222', font_size_mm: 9.5, halo: { color: '#ffffff', width_mm: 2 } },
      river: { font_size_mm: 8.5 },
    };
    expect(errorsOf(page)).toEqual([]);
  });

  it('text_style 非对象 / 未知分类 / 未知字段 / 值不是对象都报错', () => {
    const notObject = mutablePage();
    notObject['text_style'] = 'nope';
    expect(errorsOf(notObject)).toContain('text_style: 必须是对象');

    const unknownCategory = mutablePage();
    unknownCategory['text_style'] = { 'not-a-category': {} };
    expect(errorsOf(unknownCategory)).toContain('text_style.not-a-category: 不是合法分类 id');

    const unknownField = mutablePage();
    unknownField['text_style'] = { title: { junk: true } };
    expect(errorsOf(unknownField)).toContain('text_style.title.junk: 未知字段');

    const badValue = mutablePage();
    badValue['text_style'] = { title: 'red' };
    expect(errorsOf(badValue)).toContain('text_style.title: 必须是对象');
  });

  it('逐字段取值范围(所有分类的 font_size_mm 都不允许 null)', () => {
    const cases: readonly [unknown, string][] = [
      [
        { title: { font_size_mm: 0 } },
        'text_style.title.font_size_mm: 必须是 0.35..180 的有限数字',
      ],
      [
        { title: { font_size_mm: 501 } },
        'text_style.title.font_size_mm: 必须是 0.35..180 的有限数字',
      ],
      [
        { title: { font_size_mm: Number.NaN } },
        'text_style.title.font_size_mm: 必须是 0.35..180 的有限数字',
      ],
      [
        { title: { font_size_mm: null } },
        'text_style.title.font_size_mm: 必须是 0.35..180 的有限数字',
      ],
      [
        { city: { font_size_mm: null } },
        'text_style.city.font_size_mm: 必须是 0.35..180 的有限数字',
      ],
      [{ city: { font_size_mm: -1 } }, 'text_style.city.font_size_mm: 必须是 0.35..180 的有限数字'],
      [{ title: { color: 'red' } }, 'text_style.title.color: 必须是 #rrggbb'],
      [{ title: { italic: 'yes' } }, 'text_style.title.italic: 必须是布尔值'],
      [{ title: { font_weight: 450.5 } }, 'text_style.title.font_weight: 必须是 100..900 的整数'],
      [
        { title: { letter_spacing_em: 2.5 } },
        'text_style.title.letter_spacing_em: 必须是 -1..2 的有限数字',
      ],
      [{ title: { line_height: 0.4 } }, 'text_style.title.line_height: 必须是 0.5..5 的有限数字'],
    ];
    for (const [textStyle, message] of cases) {
      const page = mutablePage();
      page['text_style'] = textStyle;
      expect(errorsOf(page)).toContain(message);
    }

    // 边界合法:字号 0.35/180,字距 -1/2,行高 0.5/5,字重 100/900,光晕宽度 0
    const boundary = makeScene();
    boundary.text_style = {
      title: {
        font_size_mm: 0.35,
        letter_spacing_em: -1,
        line_height: 0.5,
        font_weight: 100,
      },
      city: {
        font_size_mm: 180,
        letter_spacing_em: 2,
        line_height: 5,
        font_weight: 900,
        halo: { color: '#000000', width_mm: 0 },
      },
    };
    expect(errorsOf(boundary)).toEqual([]);
  });

  it('halo 必须是 null 或 { color, width_mm: 0..7 },未知字段报错', () => {
    const cases: readonly [unknown, string][] = [
      [{ title: { halo: 1 } }, 'text_style.title.halo: 必须是对象或 null'],
      [{ title: { halo: {} } }, 'text_style.title.halo.color: 缺少字段'],
      [
        { title: { halo: { color: '#fff', width_mm: 2 } } },
        'text_style.title.halo.color: 必须是 #rrggbb',
      ],
      [
        { title: { halo: { color: '#ffffff', width_mm: 8 } } },
        'text_style.title.halo.width_mm: 必须是 0..7 的有限数字',
      ],
      [
        { title: { halo: { color: '#ffffff', width_mm: 2, junk: 1 } } },
        'text_style.title.halo.junk: 未知字段',
      ],
    ];
    for (const [textStyle, message] of cases) {
      const page = mutablePage();
      page['text_style'] = textStyle;
      expect(errorsOf(page)).toContain(message);
    }
  });

  it('导出 page 块包含 text_style(只落用户改过的字段)', () => {
    const layout = makeScene();
    layout.text_style = { title: { color: '#ff0000', font_size_mm: 20 } };
    const parsed = JSON.parse(serializeMapDocFile(makeGeo(), layout)) as {
      page: { text_style: unknown };
    };
    expect(parsed.page.text_style).toEqual({ title: { color: '#ff0000', font_size_mm: 20 } });
  });
});

describe('text item geo_label_id 校验(§1.2):分类来源必填,不是兼容字段', () => {
  /** 取第一个地图地名/页面文字的 text item(validatePage 接收 unknown,按可写对象操作) */
  function textItemOf(
    page: Record<string, unknown>,
    kind: 'page' | 'map',
  ): Record<string, unknown> {
    const items = page['items'] as Record<string, unknown>[];
    const index = items.findIndex((item) => {
      if (item['kind'] !== 'text') return false;
      const geoLabelId = item['geo_label_id'];
      return kind === 'map' ? geoLabelId !== null : geoLabelId === null;
    });
    if (index < 0) throw new Error(`没有${kind === 'map' ? '地图地名' : '页面文字'}元素`);
    return items[index]!;
  }

  it('地图地名缺省 / 空串 / 非字符串都报错', () => {
    const missing = mutablePage();
    delete textItemOf(missing, 'map')['geo_label_id'];
    expect(errorsOf(missing).some((error) => error.includes('缺少字段'))).toBe(true);

    const empty = mutablePage();
    textItemOf(empty, 'map')['geo_label_id'] = '';
    expect(errorsOf(empty).some((error) => error.includes('必须是非空来源 id 或 null'))).toBe(true);

    const wrongType = mutablePage();
    textItemOf(wrongType, 'map')['geo_label_id'] = 42;
    expect(errorsOf(wrongType).some((error) => error.includes('必须是非空来源 id 或 null'))).toBe(
      true,
    );
  });

  it('提供 geo 时地图地名 id 必须能查到;地图地名不能开左右居中', () => {
    const unknownId = mutablePage();
    textItemOf(unknownId, 'map')['geo_label_id'] = 'label-does-not-exist';
    const result = validatePage(unknownId, makeGeo());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((error) => error.includes('在 geo.labels 里找不到 id'))).toBe(true);

    const centeredLabel = mutablePage();
    textItemOf(centeredLabel, 'map')['center_h'] = true;
    expect(
      errorsOf(centeredLabel).some((error) => error.includes('地图地名不能启用左右居中')),
    ).toBe(true);

    // 默认排版本身必须完全合法(含每一条地图地名的来源 id)
    expect(validatePage(makeScene(), makeGeo()).ok).toBe(true);
  });
});

describe('normalizePage:text_style / geo_label_id 补默认(§1.1/§1.2)', () => {
  it('缺省 text_style -> {},旧 text item 补 geo_label_id:null,且不修改入参', () => {
    const raw = mutablePage();
    delete raw['text_style'];
    const items = raw['items'] as Record<string, unknown>[];
    for (const item of items) {
      if (item['kind'] === 'text') delete item['geo_label_id'];
    }
    const before = structuredClone(raw);
    const normalized = normalizePage(raw as unknown as PageLayout);
    expect(normalized.text_style).toEqual({});
    for (const item of normalized.items) {
      if (item.kind === 'text') expect(item.geo_label_id).toBeNull();
    }
    expect(raw).toEqual(before);
  });

  it('覆盖表收敛:未知分类/未知字段丢弃,空对象清理,地图 null 删除,halo null 保留,深拷贝', () => {
    const raw = mutablePage();
    raw['text_style'] = {
      title: { color: '#123456', halo: null, junk: 1 },
      city: { font_size_mm: null, color: '#222222' },
      river: {},
      'not-a-category': { color: '#000000' },
    };
    const normalized = normalizePage(raw as unknown as PageLayout);
    expect(normalized.text_style).toEqual({
      title: { color: '#123456', halo: null },
      city: { color: '#222222' },
    });
    expect(normalized.text_style.title).not.toBe(
      (raw['text_style'] as Record<string, unknown>)['title'],
    );
    // 空覆盖对象不落盘
    expect(normalized.text_style.river).toBeUndefined();
  });

  it('覆盖里的数字按 page 口径 3 位小数', () => {
    const raw = mutablePage();
    raw['text_style'] = { title: { font_size_mm: 20.1234, line_height: 1.3375 } };
    const normalized = normalizePage(raw as unknown as PageLayout);
    expect(normalized.text_style.title?.font_size_mm).toBe(20.123);
    expect(normalized.text_style.title?.line_height).toBe(1.338);
  });
});

/* ======================================================================
 * 左右居中约束:text item center_h
 * ====================================================================== */

/** 取默认排版里指定角色的页面文字 */
function pageTextOf(layout: PageLayout, role: TextItem['role']): TextItem {
  const item = layout.items.find(
    (entry): entry is TextItem =>
      entry.kind === 'text' && entry.geo_label_id === null && entry.role === role,
  );
  if (item === undefined) throw new Error(`默认排版里没有 ${role} 页面文字`);
  return item;
}

describe('text item center_h:页面文字左右居中约束', () => {
  it('默认排版:标题/副标题/来源开启且落在纸张中心,注记/手动地名/地图地名关闭', () => {
    const layout = makeScene();
    const paperCenter = roundToPageDecimals(layout.paper.width_mm / 2);
    for (const role of ['title', 'subtitle', 'source'] as const) {
      const item = pageTextOf(layout, role);
      expect(item.center_h).toBe(true);
      expect(item.x).toBe(paperCenter);
      expect(item.anchor).toBe('middle');
    }
    // 注记是默认排版里唯一的自由摆放页面文字(手动地名/标注要用户新增)
    expect(pageTextOf(layout, 'note').center_h).toBe(false);
    const mapTexts = layout.items.filter(
      (item): item is TextItem => item.kind === 'text' && item.geo_label_id !== null,
    );
    expect(mapTexts.length).toBeGreaterThan(0);
    for (const item of mapTexts) expect(item.center_h).toBe(false);
  });

  it('enforceHorizontalCenter:只动 center_h 的页面文字并返回改动条数', () => {
    const layout = makeScene();
    const title = pageTextOf(layout, 'title');
    title.x = 5;
    title.anchor = 'start';
    const note = pageTextOf(layout, 'note');
    note.x = 5;
    expect(enforceHorizontalCenter(layout)).toBe(1);
    expect(title.x).toBe(roundToPageDecimals(layout.paper.width_mm / 2));
    expect(title.anchor).toBe('middle');
    expect(note.x).toBe(5);
    expect(enforceHorizontalCenter(layout)).toBe(0);
  });

  it('normalizePage:缺省补 false;页面文字 true 收敛 x/anchor;地图地名残留 true 收敛 false', () => {
    const raw = structuredClone(makeScene()) as unknown as Record<string, unknown>;
    const rawItems = raw['items'] as Record<string, unknown>[];
    for (const item of rawItems) {
      if (item['kind'] === 'text') delete item['center_h'];
    }
    const titleRaw = rawItems.find((item) => item['kind'] === 'text' && item['role'] === 'title');
    if (titleRaw === undefined) throw new Error('缺少标题');
    titleRaw['center_h'] = true;
    titleRaw['x'] = 3;
    titleRaw['anchor'] = 'start';
    const mapRaw = rawItems.find(
      (item) => item['kind'] === 'text' && item['geo_label_id'] !== null,
    );
    if (mapRaw === undefined) throw new Error('缺少地图文字');
    mapRaw['center_h'] = true;

    const normalized = normalizePage(raw as unknown as PageLayout);
    const paperCenter = roundToPageDecimals(normalized.paper.width_mm / 2);
    for (const item of normalized.items) {
      if (item.kind !== 'text') continue;
      expect(item.center_h).toBe(item.id === (titleRaw['id'] as number));
    }
    const title = itemById(normalized, titleRaw['id'] as number);
    if (title?.kind !== 'text') throw new Error('标题丢失');
    expect(title.x).toBe(paperCenter);
    expect(title.anchor).toBe('middle');
    expect(normalized.items.length).toBe(rawItems.length);
  });

  it('validatePage:center_h 必须是布尔;地图地名 true 报错;默认排版合法', () => {
    const missing = structuredClone(makeScene()) as unknown as Record<string, unknown>;
    const missingItems = missing['items'] as Record<string, unknown>[];
    const pageItem = missingItems.find(
      (item) => item['kind'] === 'text' && item['geo_label_id'] === null,
    );
    if (pageItem === undefined) throw new Error('缺少页面文字');
    delete pageItem['center_h'];
    expect(errorsOf(missing).some((error) => error.includes('center_h: 必须是布尔值'))).toBe(true);

    const badMap = structuredClone(makeScene()) as unknown as Record<string, unknown>;
    const mapItem = (badMap['items'] as Record<string, unknown>[]).find(
      (item) => item['kind'] === 'text' && item['geo_label_id'] !== null,
    );
    if (mapItem === undefined) throw new Error('缺少地图文字');
    mapItem['center_h'] = true;
    expect(errorsOf(badMap).some((error) => error.includes('地图地名不能启用左右居中'))).toBe(true);

    expect(errorsOf(makeScene())).toEqual([]);
  });
});

describe('页边距与纸张锁(page.margin / paper.locked)', () => {
  it('默认排版:四边页边距 0,纸张未锁定', () => {
    const layout = makeScene();
    expect(layout.margin).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(layout.paper.locked).toBe(false);
  });

  it('normalizePage:页边距夹到纸张内,坏值落 0;locked 缺省/坏值落 false', () => {
    const layout = structuredClone(makeScene());
    layout.paper.locked = undefined as unknown as boolean;
    layout.margin = {
      top: -5,
      right: 999,
      bottom: 12.3456,
      left: Number.NaN,
    };
    const normalized = normalizePage(layout);
    expect(normalized.margin.top).toBe(0);
    expect(normalized.margin.left).toBe(0);
    expect(normalized.margin.bottom).toBe(12.346);
    expect(normalized.margin.right).toBe(normalized.paper.width_mm);
    expect(normalized.paper.locked).toBe(false);
  });

  it('validatePage:margin 必须四边非负有限,paper.locked 必须布尔', () => {
    const missingLock = structuredClone(makeScene()) as unknown as Record<string, unknown>;
    delete (missingLock['paper'] as Record<string, unknown>)['locked'];
    expect(
      errorsOf(missingLock).some((error) => error.includes('paper.locked: 必须是布尔值')),
    ).toBe(true);

    const badMargin = structuredClone(makeScene()) as unknown as Record<string, unknown>;
    (badMargin['margin'] as Record<string, unknown>)['left'] = -1;
    expect(
      errorsOf(badMargin).some((error) => error.includes('margin.left: 必须是非负有限数字')),
    ).toBe(true);
  });

  it('导出 -> 重新打开:页边距与纸张锁原样保留且通过校验', () => {
    const layout = makeScene();
    layout.paper.locked = true;
    layout.margin = { top: 5, right: 6, bottom: 7, left: 8 };
    const parsed = JSON.parse(serializeMapDocFile(makeGeo(), layout)) as {
      page: { margin: unknown; paper: { locked: boolean } };
    };
    expect(parsed.page.margin).toEqual({ top: 5, right: 6, bottom: 7, left: 8 });
    expect(parsed.page.paper.locked).toBe(true);
    expect(validatePage(parsed.page, makeGeo()).ok).toBe(true);
  });
});
