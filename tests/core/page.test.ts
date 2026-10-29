/**
 * `core/page.ts`（契约 codec/校验）与 `core/page-layout.ts`（§5 布局公式）的单测。
 *
 * 为什么是 node 环境：这两层必须不碰 DOM——文本测量以参数注入，默认回退是纯字符宽度估算；
 * 这里用固定 geo/base 检查默认排版、刻度/图例/色标位置与序列化确定性。
 * 元信息：作者 frontend，2026-10-27，随 `docs/PAGE-EDITOR.md` 新契约落地。
 */

import { describe, expect, it } from 'vitest';
import {
  allocateItemId,
  countItems,
  itemById,
  itemSummary,
  normalizePage,
  roundToPageDecimals,
  pageDigest,
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
  mapHeightPt,
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

/** 构造一份最小 geo：底图 896.350289 × 712.3824，含 2 条经度/2 条纬度刻度、2 个地名 */
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
        '注 1：这是一段足够长的右栏注记，用来验证默认排版会按右栏可用宽度折行后写进 lines 数组，而不是交给渲染期自动换行。',
        '注 2：第二行注记。',
      ],
      source: '地形: NOAA NCEI ETOPO 2022（15″） | 流域: HydroSHEDS | 国界: GADM 4.1',
      area_annotation: ['伏尔加河流域', '约 141 万 km²'],
      legend_title: '图例',
      colorbar_title: '高程 / 水深',
    },
  };
}

/** 默认排版结果（多数用例共用） */
function makeScene(): PageLayout {
  return defaultPageLayout(makeGeo());
}

describe('formatPageNumber（与 Python 侧同语义）', () => {
  it('3 位小数、去尾零、无单位', () => {
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

  it('serializePage 键排序、无空白、数字 3 位小数', () => {
    const layout = makeScene();
    const text = serializePage(layout);
    expect(text.startsWith('{"frame":')).toBe(true);
    // 无缩进/分隔空白（字符串内部的空格不算，如字体栈与副标题）
    expect(text).not.toContain('": ');
    expect(text).not.toContain('", "');
    expect(text).not.toContain('\n');
    // 规范化：A4 宽度 841.889764 → 841.89
    expect(text).toContain('"width_pt":841.89');
    // 键序稳定：同一 layout 两次序列化结果一致
    expect(serializePage(makeScene())).toBe(text);
  });

  it('normalizePage 不修改入参且 3 位小数', () => {
    const layout = makeScene();
    const normalized = normalizePage(layout);
    expect(normalized).not.toBe(layout);
    expect(normalized.paper.width_pt).toBe(841.89);
    expect(layout.paper.width_pt).toBe(841.889764);
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

  it('拒绝非法纸张尺寸、重复 id、seq 不大于最大 id', () => {
    const layout = makeScene();
    layout.paper.width_pt = 10;
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

  it('拒绝非法字重/字距（100..900 整数、-1..2 有限数）', () => {
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
    // 边界值合法：权重 100/900、字距 -1/2
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

describe('defaultPageLayout（§9 初始排版）', () => {
  it('A4 横向、页边距 28、地图占左侧、右栏三块、标题/副标题/来源都在', () => {
    const layout = makeScene();
    expect(layout.paper).toEqual({
      preset: 'A4',
      orientation: 'landscape',
      width_pt: 841.889764,
      height_pt: 595.275591,
    });
    expect(layout.map.x).toBe(28);
    expect(layout.map.y).toBe(72);
    expect(layout.map.width_pt).toBeGreaterThan(1);
    expect(layout.map.x + layout.map.width_pt).toBeLessThan(841.889764);

    const roles = layout.items
      .filter((item): item is TextItem => item.kind === 'text' && item.space === 'page')
      .map((item) => item.role);
    expect(roles).toContain('title');
    expect(roles).toContain('subtitle');
    expect(roles).toContain('note');
    expect(roles).toContain('source');

    const legend = layout.items.find((item) => item.kind === 'legend')!;
    const colorbar = layout.items.find((item) => item.kind === 'colorbar')!;
    expect(legend.kind).toBe('legend');
    expect(colorbar.kind).toBe('colorbar');
    // 右栏：legend → notes → colorbar 自上而下
    if (legend.kind === 'legend' && colorbar.kind === 'colorbar') {
      const note = layout.items.find(
        (item) => item.kind === 'text' && item.role === 'note',
      ) as TextItem;
      expect(legend.y).toBeLessThan(note.y);
      expect(colorbar.y).toBeGreaterThan(note.y);
      expect(legend.x).toBeCloseTo(colorbar.x - (legend.width_pt - colorbar.width_pt) / 2, 9);
    }
  });

  it('全部地名都作为 map 空间文字铺上，id 唯一、seq 大于最大 id', () => {
    const layout = makeScene();
    const labels = layout.items.filter(
      (item): item is TextItem => item.kind === 'text' && item.space === 'map',
    );
    expect(labels).toHaveLength(makeGeo().labels.length);
    expect(labels[0]!.lines).toEqual(['甲国']);
    // 地名字号按地图缩放比换算（Lead 联调结论：否则相对原图放大 1.7 倍压字）
    const scale = layout.map.width_pt / makeGeo().base.width_pt;
    expect(labels[0]!.font_size_pt).toBeCloseTo(12 * scale, 9);
    // 颜色/斜体来自 role 表；描边宽度是纸面常量（不随 s 缩放），旋转统一 0
    expect(labels[0]!.color).toBe('#3a3a3a');
    expect(labels[0]!.italic).toBe(false);
    expect(labels[0]!.halo).toEqual({ color: '#ffffff', width_pt: 2 });
    expect(labels[1]!.color).toBe('#2d6ea6');
    expect(labels[1]!.italic).toBe(true);
    expect(labels[1]!.rotation_deg).toBe(0);
    expect(labels[1]!.anchor).toBe('start');

    const ids = layout.items.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(layout.seq).toBe(Math.max(...ids) + 1);
  });

  it('notes 按右栏宽度折行写入 lines（不自动换行）', () => {
    const layout = makeScene();
    const note = layout.items.find(
      (item): item is TextItem => item.kind === 'text' && item.role === 'note',
    )!;
    expect(note.lines.length).toBeGreaterThan(2);
    expect(note.anchor).toBe('start');
    const legend = layout.items.find((item) => item.kind === 'legend')!;
    const font = fontShorthand(note.font_size_pt, layout.style.font_family);
    for (const line of note.lines) {
      expect(fallbackMeasureText(line, font)).toBeLessThanOrEqual(legend.width_pt);
    }
  });

  it('legend width 按最长 label 测量，右栏宽度足够', () => {
    const layout = makeScene();
    const legend = layout.items.find((item) => item.kind === 'legend');
    expect(legend?.kind).toBe('legend');
    if (legend?.kind !== 'legend') return;
    const geo = makeGeo();
    const font = fontShorthand(legend.font_size_pt, layout.style.font_family);
    const maxLabel = Math.max(
      ...geo.legend.entries.map((entry) => fallbackMeasureText(entry.label, font)),
    );
    expect(legend.width_pt).toBeGreaterThanOrEqual(
      legend.padding_pt * 2 + legend.swatch_width_pt + legend.swatch_gap_pt + maxLabel,
    );
  });

  it('保留传入纸张（重新排默认版式不重置纸张）', () => {
    const paper = {
      preset: 'A5' as const,
      orientation: 'landscape' as const,
      width_pt: 595.275591,
      height_pt: 419.527559,
    };
    const layout = defaultPageLayout(makeGeo(), { paper, margin_pt: 20 });
    expect(layout.paper).toEqual(paper);
    expect(layout.paper).not.toBe(paper);
    expect(layout.map.x).toBe(20);
  });
});

describe('纸张自适应（defaultPageLayout 的 k）', () => {
  it('A5 横向重新排默认版式：注记与色标不重叠、不越过页底预留区', () => {
    const geo = makeGeo();
    const a5 = {
      preset: 'A5' as const,
      orientation: 'landscape' as const,
      width_pt: 595.275591,
      height_pt: 419.527559,
    };
    const layout = defaultPageLayout(geo, { paper: a5, margin_pt: 28 });
    const result = validatePage(layout, geo);
    expect(result.ok).toBe(true);

    const note = layout.items.find(
      (item): item is TextItem => item.kind === 'text' && item.role === 'note',
    );
    const colorbar = layout.items.find((item) => item.kind === 'colorbar');
    expect(note).toBeDefined();
    expect(colorbar?.kind).toBe('colorbar');
    if (!note || colorbar?.kind !== 'colorbar') return;

    // k：A5 横向相对 A4 横向的比例（夹在 0.62..1.6）
    const k = Math.min(
      1.6,
      Math.max(0.62, Math.min(a5.width_pt / 841.889764, a5.height_pt / 595.275591)),
    );
    expect(k).toBeLessThan(1);

    // 注记最后一行基线 + 色标整体在页底之前，且色标不压注记
    const noteLastBaseline =
      note.y + (note.lines.length - 1) * note.font_size_pt * note.line_height;
    expect(colorbar.y).toBeGreaterThan(noteLastBaseline);
    expect(colorbar.y + colorbar.height_pt).toBeLessThanOrEqual(a5.height_pt - 28 - 24 * k + 1e-6);
    expect(colorbar.height_pt).toBeGreaterThanOrEqual(40);

    // 图例/注记/来源字号按 k 缩小；地名字号只跟地图缩放 s
    const legend = layout.items.find((item) => item.kind === 'legend');
    if (legend?.kind === 'legend') expect(legend.font_size_pt).toBeCloseTo(9 * k, 9);
    expect(note.font_size_pt).toBeCloseTo(7.5 * k, 9);
    const label = layout.items.find(
      (item): item is TextItem => item.kind === 'text' && item.space === 'map',
    );
    expect(label?.font_size_pt).toBeCloseTo(12 * (layout.map.width_pt / geo.base.width_pt), 9);

    // 来源仍在页内、且地图不越过来源预留区
    const source = layout.items.find(
      (item): item is TextItem => item.kind === 'text' && item.role === 'source',
    );
    expect(source?.y).toBeLessThanOrEqual(a5.height_pt - 28);
    expect(
      layout.map.y + (layout.map.width_pt * geo.base.height_pt) / geo.base.width_pt,
    ).toBeLessThan(a5.height_pt - 28);
  });

  it('A4 横向 k=1：版式与既有默认值一致', () => {
    const layout = makeScene();
    const legend = layout.items.find((item) => item.kind === 'legend');
    if (legend?.kind === 'legend') expect(legend.font_size_pt).toBeCloseTo(9, 9);
    const note = layout.items.find(
      (item): item is TextItem => item.kind === 'text' && item.role === 'note',
    );
    expect(note?.font_size_pt).toBeCloseTo(7.5, 9);
    expect(layout.map.y).toBe(72);
  });
  it('A4/A5 纵向：地图用满内容宽、下方一排三块、互不覆盖且不越界', () => {
    const geo = makeGeo();
    const cases = [
      {
        paper: {
          preset: 'A4' as const,
          orientation: 'portrait' as const,
          width_pt: 595.275591,
          height_pt: 841.889764,
        },
      },
      {
        paper: {
          preset: 'A5' as const,
          orientation: 'portrait' as const,
          width_pt: 419.527559,
          height_pt: 595.275591,
        },
      },
    ];
    for (const { paper } of cases) {
      const layout = defaultPageLayout(geo, { paper, margin_pt: 28 });
      expect(validatePage(layout, geo).ok).toBe(true);

      const longSide = Math.max(paper.width_pt, paper.height_pt);
      const shortSide = Math.min(paper.width_pt, paper.height_pt);
      const k = Math.min(
        1.6,
        Math.max(0.62, Math.min(longSide / 841.889764, shortSide / 595.275591)),
      );

      // 地图用满内容宽度，标题仍在页顶
      expect(layout.map.x).toBe(28);
      expect(layout.map.width_pt).toBeCloseTo(paper.width_pt - 56, 9);
      expect(layout.map.y).toBeCloseTo(28 + 44 * k, 9);

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
        layout.map.y + (layout.map.width_pt * geo.base.height_pt) / geo.base.width_pt;
      // 纵向一排要让开经度刻度标签（tick 字号不随 k 缩），并额外留出注记字形上沿：
      // notes 首行基线 = rowY，group 上沿约再高 0.9em。
      const noteSize = note.font_size_pt;
      const tickExtent = layout.frame.ticks
        ? layout.frame.tick_length_pt +
          layout.frame.tick_gap_pt +
          layout.frame.tick_font_size_pt +
          Math.max(16 * k, noteSize * 0.9 + 4)
        : 0;
      expect(legend.y).toBeCloseTo(mapBottom + Math.max(12 * k, tickExtent), 9);
      expect(legend.y).toBeGreaterThan(mapBottom);

      // 三块中最靠上的上沿（注记含 ascent）要高于刻度标签底部 + 4
      const tickLabelBottom =
        mapBottom +
        layout.frame.tick_length_pt +
        layout.frame.tick_gap_pt +
        layout.frame.tick_font_size_pt +
        layout.frame.tick_font_size_pt * 0.2;
      const noteTop = note.y - note.font_size_pt * 0.8;
      const topmost = Math.min(legend.y, colorbar.y, noteTop);
      expect(topmost).toBeGreaterThanOrEqual(tickLabelBottom + 4 - 1e-6);

      // 三块同一排：图例在左、注记居中、色标贴右，互不相交
      expect(legend.x).toBe(28);
      expect(legend.y).toBeCloseTo(note.y, 9);
      expect(legend.x + legend.width_pt).toBeLessThanOrEqual(note.x + 1e-9);
      expect(note.x).toBeLessThan(colorbar.x);
      expect(colorbar.x + colorbar.width_pt).toBeCloseTo(paper.width_pt - 28, 9);

      const noteFont = fontShorthand(note.font_size_pt, layout.style.font_family);
      const noteWidth = Math.max(...note.lines.map((line) => fallbackMeasureText(line, noteFont)));
      expect(note.x + noteWidth).toBeLessThanOrEqual(colorbar.x + 1e-6);

      // 色标标题（基线 y-4）在整排之内，不画到地图底/刻度标签上
      const titleBlock = 8 * k * 1.4 + 4;
      const rowHeight = Math.max(
        legendHeight,
        note.lines.length * note.font_size_pt * note.line_height,
        40 + titleBlock,
      );
      const rowBottom = legend.y + rowHeight;
      const bottomLimit = paper.height_pt - 28 - 24 * k;
      expect(colorbar.height_pt).toBeCloseTo(
        Math.max(40, Math.min(180 * k, rowHeight - titleBlock)),
        6,
      );
      expect(colorbar.y + colorbar.height_pt).toBeCloseTo(rowBottom, 6);
      expect(colorbar.y - 4).toBeGreaterThan(legend.y);
      expect(rowBottom).toBeLessThanOrEqual(bottomLimit + 1e-6);
      expect(legendHeight).toBeLessThanOrEqual(bottomLimit + 1e-6);

      const noteBottom = note.y + (note.lines.length - 1) * note.font_size_pt * note.line_height;
      expect(noteBottom).toBeLessThanOrEqual(rowBottom + 1e-6);

      const source = layout.items.find(
        (item): item is TextItem => item.kind === 'text' && item.role === 'source',
      );
      expect(source?.y).toBeLessThanOrEqual(paper.height_pt - 28);
    }
  });
});

describe('§5.1 坐标变换', () => {
  it('底图坐标 → 纸张坐标并反解', () => {
    const geo = makeGeo();
    const layout = makeScene();
    const transform = mapTransform(geo, layout.map);
    const s = layout.map.width_pt / geo.base.width_pt;
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
    expect(mapHeightPt(geo, layout.map)).toBeCloseTo(
      (layout.map.width_pt * geo.base.height_pt) / geo.base.width_pt,
      12,
    );
  });
});

describe('§5.2 图框/刻度', () => {
  it('经度 bottom：线向下、基线 = 框底 + 刻度长 + gap + 字号', () => {
    const geo = makeGeo();
    const layout = makeScene();
    const ticks = frameTickLayout(layout, geo);
    const lon = ticks.filter((tick) => tick.axis === 'lon');
    expect(lon).toHaveLength(2);
    const first = lon[0]!;
    const transform = mapTransform(geo, layout.map);
    const mapBottom = layout.map.y + mapHeightPt(geo, layout.map);
    expect(first.x1).toBeCloseTo(transform.tx + geo.graticule.lon[0]!.x * transform.s, 9);
    expect(first.y1).toBeCloseTo(mapBottom, 9);
    expect(first.y2).toBeCloseTo(mapBottom + layout.frame.tick_length_pt, 9);
    expect(first.textY).toBeCloseTo(
      mapBottom +
        layout.frame.tick_length_pt +
        layout.frame.tick_gap_pt +
        layout.frame.tick_font_size_pt,
      9,
    );
    expect(first.anchor).toBe('middle');
  });

  it('纬度 left/right：线向外、基线 = py + 字号×0.35', () => {
    const geo = makeGeo();
    const layout = makeScene();
    const ticks = frameTickLayout(layout, geo).filter((tick) => tick.axis === 'lat');
    expect(ticks).toHaveLength(2);
    const left = ticks.find((tick) => tick.side === 'left')!;
    const right = ticks.find((tick) => tick.side === 'right')!;
    const transform = mapTransform(geo, layout.map);
    const py = transform.ty + geo.graticule.lat[0]!.y * transform.s;
    expect(left.x1).toBeCloseTo(layout.map.x, 9);
    expect(left.x2).toBeCloseTo(layout.map.x - layout.frame.tick_length_pt, 9);
    expect(left.textX).toBeCloseTo(
      layout.map.x - layout.frame.tick_length_pt - layout.frame.tick_gap_pt,
      9,
    );
    expect(left.textY).toBeCloseTo(py + layout.frame.tick_font_size_pt * 0.35, 9);
    expect(left.anchor).toBe('end');
    expect(right.anchor).toBe('start');
    expect(right.textX).toBeCloseTo(
      layout.map.x + layout.map.width_pt + layout.frame.tick_length_pt + layout.frame.tick_gap_pt,
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
    const padding = legend.padding_pt;
    const rowHeight = Math.max(legend.row_height_pt, legend.font_size_pt * 1.5);
    const titleHeight = legend.title.length > 0 ? legend.title_size_pt * 1.4 : 0;
    expect(legendBox.height).toBeCloseTo(
      padding * 2 + titleHeight + legend.entries.length * rowHeight,
      9,
    );
    expect(legendBox.titleBaseline).toBeCloseTo(legend.y + padding + legend.title_size_pt, 9);
    const firstRow = legendBox.rows[0]!;
    expect(firstRow.centerY).toBeCloseTo(legend.y + padding + titleHeight + rowHeight * 0.5, 9);
    expect(firstRow.labelBaseline).toBeCloseTo(firstRow.centerY + legend.font_size_pt * 0.35, 9);
    expect(firstRow.swatchX0).toBeCloseTo(legend.x + padding, 9);
    expect(firstRow.swatchX1).toBeCloseTo(firstRow.swatchX0 + legend.swatch_width_pt, 9);
    expect(firstRow.labelX).toBeCloseTo(firstRow.swatchX1 + legend.swatch_gap_pt, 9);
  });
});

describe('§5.5 色标', () => {
  it('tick 位置按 vmin/vmax 线性映射，标题居中且带单位', () => {
    const layout = makeScene();
    const colorbar = layout.items.find((item) => item.kind === 'colorbar');
    if (colorbar?.kind !== 'colorbar') throw new Error('缺少色标');
    // fixture 的 geo 一定带 relief；类型上 relief 可空（无色标的 geo），这里取非空断言
    const relief = makeGeo().relief!;
    const bar = colorbarLayout(colorbar, relief);
    expect(bar.titleText).toBe('高程 / 水深 (m)');
    expect(bar.titleX).toBeCloseTo(colorbar.x + colorbar.width_pt / 2, 9);
    expect(bar.titleBaseline).toBeCloseTo(colorbar.y - 4, 9);
    const tick0 = bar.ticks[0]!;
    expect(tick0.ty).toBeCloseTo(
      colorbar.y +
        colorbar.height_pt * (1 - (tick0.value - relief.vmin) / (relief.vmax - relief.vmin)),
      9,
    );
    expect(tick0.x1).toBeCloseTo(colorbar.x + colorbar.width_pt, 9);
    expect(tick0.x2).toBeCloseTo(colorbar.x + colorbar.width_pt + 3, 9);
    expect(tick0.labelX).toBeCloseTo(colorbar.x + colorbar.width_pt + 5, 9);
    expect(tick0.labelBaseline).toBeCloseTo(tick0.ty + colorbar.label_size_pt * 0.35, 9);
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
  it('多行基线 = 首行 + i × 字号 × 行高；map 空间过变换', () => {
    const geo = makeGeo();
    const layout = makeScene();
    const label = layout.items.find(
      (item): item is TextItem => item.kind === 'text' && item.space === 'map',
    )!;
    const text = textLayout(label, geo, layout);
    const transform = mapTransform(geo, layout.map);
    expect(text.px).toBeCloseTo(transform.tx + label.x * transform.s, 9);
    expect(text.py).toBeCloseTo(transform.ty + label.y * transform.s, 9);
    expect(text.lines[0]!.y).toBeCloseTo(text.py, 9);

    const multi = { ...label, lines: ['一', '二', '三'], line_height: 1.5 };
    const multiLayout = textLayout(multi, geo, layout);
    const step = multi.font_size_pt * 1.5;
    expect(multiLayout.lines.map((line) => line.y)).toEqual([
      expect.closeTo(multiLayout.py, 9),
      expect.closeTo(multiLayout.py + step, 9),
      expect.closeTo(multiLayout.py + step * 2, 9),
    ]);
  });
});

describe('文字折行', () => {
  it('按宽度折行、保留显式换行、超长词硬切', () => {
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
