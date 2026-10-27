/**
 * `core/page.ts` 的 geo 归一化/摘要/序列化增量与 `core/page-layout.ts` 的 defaultScene
 * 可选块降级（无 legend / 无 relief / 无 suggestions）单测。
 *
 * 为什么要有这些用例：Cartopy 直出的 geo.json 允许缺 legend/relief/suggestions 整块
 * （例如没有图例的图），默认排版必须按「实际存在哪些块」决定右栏/横向一排，既不生成
 * 空图例框、不画没有数据的色标，也不能让地图/注记/色标重叠；同时「有 legend」的版式
 * 数值必须保持既有 A4 横向结果（回归 demo）。
 * 元信息：作者 compose，2026-10-28，无后端数据流（浏览器上传后先归一化 geo）。
 */

import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  geoDigest,
  normalizeGeo,
  serializeSceneFile,
  sha256Hex,
  sha256OfBytes,
  validateGeo,
  validateScene,
  type Geo,
  type GeoLegend,
  type GeoSuggestions,
  type Scene,
} from '../../src/core/page';
import { defaultScene } from '../../src/core/page-layout';
import {
  BASE_DECLARATION,
  BASE_SHA256,
  BASE_SVG_TEXT,
  makeDocument,
  makeGeo,
  withoutBlocks,
} from '../fixtures/page-fixtures';

/** 用 geo 生成一份默认排版（打开流程：normalizeGeo → defaultScene） */
function sceneOf(geo: Geo): Scene {
  return defaultScene(makeDocument(geo).geo, BASE_DECLARATION, { figure: 'fixture.svg' });
}

/** 把 geo 复制成可随意改字段的普通对象 */
function mutableGeo(geo: Geo): Record<string, unknown> {
  return structuredClone(geo) as unknown as Record<string, unknown>;
}

describe('sha256OfBytes / sha256Hex', () => {
  it('bytes 版本与字符串版本对 UTF-8 同源', () => {
    expect(sha256OfBytes(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256OfBytes(new TextEncoder().encode(BASE_SVG_TEXT))).toBe(BASE_SHA256);
    expect(sha256OfBytes(new TextEncoder().encode('中文底图'))).toBe(sha256Hex('中文底图'));
  });

  it('接受带 byteOffset 的 Uint8Array 视图', () => {
    const buffer = new TextEncoder().encode('xabc');
    const view = buffer.subarray(1);
    expect(sha256OfBytes(view)).toBe(sha256Hex('abc'));
  });
});

describe('canonicalJson', () => {
  it('键排序、无空白、数字 3 位小数、非有限值落 0', () => {
    expect(canonicalJson({ b: 1.23456, a: [1, { d: '中' }] })).toBe(
      '{"a":[1,{"d":"中"}],"b":1.235}',
    );
    expect(canonicalJson({ z: Number.NaN, y: Number.POSITIVE_INFINITY, x: -0.0004 })).toBe(
      '{"x":0,"y":0,"z":0}',
    );
  });

  it('对 geo 得到稳定串（顶层键按字典序）', () => {
    const textValue = canonicalJson(makeGeo());
    expect(textValue.startsWith('{"base":')).toBe(true);
    expect(textValue).toContain('"format":"mapdoc-geo"');
    expect(textValue).not.toContain('\n');
    expect(canonicalJson(makeGeo())).toBe(textValue);
  });
});

describe('geoDigest', () => {
  it('64 位小写 sha256、稳定、对改动敏感', () => {
    const geo = makeGeo();
    const digest = geoDigest(geo);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(geoDigest(structuredClone(geo))).toBe(digest);
    geo.relief!.vmax += 1;
    expect(geoDigest(geo)).not.toBe(digest);
  });
});

describe('serializeSceneFile（导出 scene.json）', () => {
  it('2 空格缩进、键排序、末尾一个换行、可解析且确定', () => {
    const scene = sceneOf(makeGeo());
    const textValue = serializeSceneFile(scene);
    expect(textValue.endsWith('\n')).toBe(true);
    expect(textValue).toContain('\n  "base": {');
    expect(textValue.endsWith('}\n')).toBe(true);

    const parsed = JSON.parse(textValue) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    expect(keys).toEqual([...keys].sort());
    expect(parsed['format']).toBe('mapdoc-page');
    expect(parsed['version']).toBe(1);
    // 规范化到 3 位小数：A4 横向 841.889764 → 841.89
    expect((parsed['paper'] as Record<string, number>)['width_pt']).toBe(841.89);
    expect(serializeSceneFile(scene)).toBe(textValue);
    // 解析回来的文档仍通过 scene 校验（导出文件可再次导入）
    expect(validateScene(parsed, makeGeo()).ok).toBe(true);
  });

  it('数字统一 3 位小数、不修改入参', () => {
    const scene = sceneOf(makeGeo());
    const before = scene.map.x;
    serializeSceneFile(scene);
    expect(scene.map.x).toBe(before);
  });
});

describe('validateGeo：可选块缺省/存在时的基础结构检查', () => {
  it('完整 geo 通过', () => {
    expect(validateGeo(makeGeo())).toEqual([]);
  });

  it('relief/legend/suggestions 整块缺省或显式 null 都合法', () => {
    expect(validateGeo(withoutBlocks(makeGeo(), ['legend', 'relief', 'suggestions']))).toEqual([]);
    const raw = mutableGeo(makeGeo());
    raw['legend'] = null;
    raw['relief'] = null;
    raw['suggestions'] = null;
    expect(validateGeo(raw)).toEqual([]);
  });

  it('块存在但字段缺省也合法（Cartopy 的 set_suggestions 只写调用方给出的字段）', () => {
    const raw = mutableGeo(makeGeo());
    // 真实 myanmar 产物：suggestions 只有部分字段、没有 notes/area_annotation
    raw['suggestions'] = { title: '缅甸地形图', subtitle: '副标题', colorbar_title: '高程' };
    raw['legend'] = { entries: [] }; // 缺 title
    delete (raw['relief'] as Record<string, unknown>)['ticks'];
    expect(validateGeo(raw)).toEqual([]);

    const normalized = normalizeGeo(raw as unknown as Geo);
    expect(normalized.suggestions.notes).toEqual([]);
    expect(normalized.suggestions.area_annotation).toEqual([]);
    expect(normalized.relief?.ticks).toEqual([]);
    expect(normalized.legend).toEqual({ title: '图例', entries: [] });

    const scene = sceneOf(raw as unknown as Geo);
    expect(scene.items.some((item) => item.kind === 'legend')).toBe(false);
    expect(validateScene(scene, normalized).ok).toBe(true);
  });

  it('结构坏时给出可定位的错误', () => {
    const badRelief = mutableGeo(makeGeo());
    (badRelief['relief'] as Record<string, unknown>)['stops'] = 'not-an-array';
    expect(validateGeo(badRelief)).toEqual(['geo.relief.stops: 必须是数组']);

    const badRange = mutableGeo(makeGeo());
    const relief = badRange['relief'] as Record<string, unknown>;
    relief['vmax'] = relief['vmin'];
    expect(validateGeo(badRange)).toContain('geo.relief: vmin/vmax 必须是有限数字且 vmax > vmin');

    const badLegend = mutableGeo(makeGeo());
    (badLegend['legend'] as Record<string, unknown>)['entries'] = null;
    expect(validateGeo(badLegend)).toEqual(['geo.legend.entries: 必须是数组']);

    const badSuggestions = mutableGeo(makeGeo());
    (badSuggestions['suggestions'] as Record<string, unknown>)['notes'] = 'x';
    expect(validateGeo(badSuggestions)).toEqual(['geo.suggestions.notes: 必须是数组']);
  });

  it('base/graticule/labels 仍是必需块', () => {
    const raw = mutableGeo(makeGeo());
    delete raw['base'];
    expect(validateGeo(raw)).toContain('geo.base: 必须是对象');
  });
});

describe('normalizeGeo：可选块补默认（返回新对象）', () => {
  it('三块全缺省 → 空图例、全空 suggestions、relief null', () => {
    const geo = withoutBlocks(makeGeo(), ['legend', 'relief', 'suggestions']);
    const normalized = normalizeGeo(geo);
    expect(normalized).not.toBe(geo);
    expect(normalized.relief).toBeNull();
    expect(normalized.legend).toEqual({ title: '图例', entries: [] } satisfies GeoLegend);
    expect(normalized.suggestions).toEqual({
      title: '',
      subtitle: '',
      notes: [],
      source: '',
      area_annotation: [],
      legend_title: '',
      colorbar_title: '',
    } satisfies GeoSuggestions);
    // 必需块原样保留（graticule 会克隆一层以便补 style 缺省）
    expect(normalized.base).toEqual(geo.base);
    expect(normalized.graticule).toEqual(geo.graticule);
    expect(normalized.labels).toBe(geo.labels);
  });

  it('graticule.style 缺省时补中性默认，validateGeo 仍通过', () => {
    const raw = mutableGeo(makeGeo());
    const graticule = raw['graticule'] as Record<string, unknown>;
    delete graticule['style'];
    expect(validateGeo(raw)).toEqual([]);
    const normalized = normalizeGeo(raw as unknown as Geo);
    expect(normalized.graticule.style).toEqual({
      stroke: '#808080',
      width_pt: 0.5,
      dash: [0.5, 0.825],
      opacity: 1,
    });
    // lon/lat 原样
    expect(normalized.graticule.lon).toEqual(makeGeo().graticule.lon);
    expect(normalized.graticule.lat).toEqual(makeGeo().graticule.lat);
  });

  it('真实 myanmar 型 geo（无 legend、suggestions 只有 4 键）全链路合法', () => {
    // 与 .work/cartopy-fixtures/myanmar_*.geo.json 同形：只有 relief/suggestions，
    // 且 suggestions 只写 {title,subtitle,source,colorbar_title}（Cartopy 只写调用方给的键）。
    const raw = mutableGeo(makeGeo());
    delete raw['legend'];
    raw['suggestions'] = {
      title: '缅甸地形图',
      subtitle: 'ETOPO 2022 | 流域: HydroSHEDS',
      source: '地形: NOAA NCEI ETOPO 2022',
      colorbar_title: '高程 / 水深',
    };
    expect(validateGeo(raw)).toEqual([]);

    const normalized = normalizeGeo(raw as unknown as Geo);
    expect(normalized.relief).not.toBeNull();
    expect(normalized.legend).toEqual({ title: '图例', entries: [] });
    expect(normalized.suggestions.notes).toEqual([]);
    expect(normalized.suggestions.area_annotation).toEqual([]);
    expect(normalized.suggestions.legend_title).toBe('');
    expect(normalized.suggestions.title).toBe('缅甸地形图');
    expect(normalized.suggestions.source).toBe('地形: NOAA NCEI ETOPO 2022');

    const scene = sceneOf(raw as unknown as Geo);
    // 无图例、无注记；标题/来源/色标仍在，scene 合法且不抛错
    expect(scene.items.some((item) => item.kind === 'legend')).toBe(false);
    expect(scene.items.some((item) => item.kind === 'text' && item.role === 'note')).toBe(false);
    expect(scene.items.some((item) => item.kind === 'text' && item.role === 'title')).toBe(true);
    expect(scene.items.some((item) => item.kind === 'text' && item.role === 'source')).toBe(true);
    expect(scene.items.some((item) => item.kind === 'colorbar')).toBe(true);
    expect(validateScene(scene, normalized).ok).toBe(true);
    // 没有图例时地图不再让出图例列宽（右栏只留窄列/无列）
    expect(scene.map.width_pt).toBeGreaterThan(841.889764 - 56 - 16 - 150);
  });

  it('显式 null 与缺省等价', () => {
    const raw = mutableGeo(makeGeo());
    raw['legend'] = null;
    raw['relief'] = null;
    raw['suggestions'] = null;
    const normalized = normalizeGeo(raw as unknown as Geo);
    expect(normalized.relief).toBeNull();
    expect(normalized.legend.entries).toEqual([]);
    expect(normalized.suggestions.notes).toEqual([]);
  });

  it('结构坏块被替换为默认值，部分坏的 suggestions 逐字段兜底', () => {
    const raw = mutableGeo(makeGeo());
    raw['legend'] = { title: '坏图例', entries: 'x' };
    raw['relief'] = { title: '高程', unit: 'm', vmin: 1, vmax: 1, stops: [], ticks: [] };
    const suggestions = raw['suggestions'] as Record<string, unknown>;
    suggestions['notes'] = ['保留一', 2];
    suggestions['title'] = 7;
    const normalized = normalizeGeo(raw as unknown as Geo);
    expect(normalized.legend).toEqual({ title: '图例', entries: [] });
    expect(normalized.relief).toBeNull();
    expect(normalized.suggestions.notes).toEqual(['保留一', '2']);
    expect(normalized.suggestions.title).toBe('');
  });

  it('合法块保留语义但克隆 stops/ticks（不与上传对象共享可变引用）', () => {
    const geo = makeGeo();
    const normalized = normalizeGeo(geo);
    expect(normalized.relief).toEqual(geo.relief);
    expect(normalized.relief).not.toBe(geo.relief);
    expect(normalized.relief!.stops).not.toBe(geo.relief!.stops);
    expect(normalized.legend).toEqual(geo.legend);
    expect(normalized.suggestions).toEqual(geo.suggestions);
  });

  it('不改写入参（缺失块不会被打上默认值）', () => {
    const geo = withoutBlocks(makeGeo(), ['legend', 'relief', 'suggestions']);
    normalizeGeo(geo);
    expect('legend' in geo).toBe(false);
    expect('relief' in geo).toBe(false);
    expect('suggestions' in geo).toBe(false);
  });
});

describe('defaultScene：有图例时保持 A4 横向既有数值（回归）', () => {
  it('地图/右栏/字号与降级前一致', () => {
    const geo = normalizeGeo(makeGeo());
    const scene = sceneOf(geo);
    // 内容宽 = 841.889764 - 56；地图宽 = 内容宽 - 栏间距 16 - 图例列 150
    const contentWidth = 841.889764 - 56;
    expect(scene.map.x).toBe(28);
    expect(scene.map.y).toBe(72);
    expect(scene.map.width_pt).toBeCloseTo(contentWidth - 16 - 150, 9);

    const legend = scene.items.find((item) => item.kind === 'legend');
    expect(legend?.kind).toBe('legend');
    if (legend?.kind === 'legend') {
      expect(legend.x).toBeCloseTo(28 + scene.map.width_pt + 16, 9);
      expect(legend.y).toBe(72);
      expect(legend.font_size_pt).toBeCloseTo(9, 9);
      expect(legend.entries).toHaveLength(5);
    }
    const colorbar = scene.items.find((item) => item.kind === 'colorbar');
    expect(colorbar?.kind).toBe('colorbar');
    expect(validateScene(scene, geo).ok).toBe(true);
  });
});

describe('defaultScene：无 legend 降级（不生成空图例框）', () => {
  it('只有注记+色标时地图变宽、右栏从栏顶开始且不重叠', () => {
    const geo = normalizeGeo(withoutBlocks(makeGeo(), ['legend']));
    const scene = sceneOf(geo);
    expect(scene.items.some((item) => item.kind === 'legend')).toBe(false);

    const note = scene.items.find((item) => item.kind === 'text' && item.role === 'note');
    const colorbar = scene.items.find((item) => item.kind === 'colorbar');
    expect(note?.kind).toBe('text');
    expect(colorbar?.kind).toBe('colorbar');
    if (note?.kind !== 'text' || colorbar?.kind !== 'colorbar') return;

    const contentWidth = 841.889764 - 56;
    const compactRightWidth = 150 * 0.7; // compactRightColumnWidth：0.7 × 右栏最小宽
    expect(scene.map.width_pt).toBeCloseTo(contentWidth - 16 - compactRightWidth, 9);
    // 右栏紧贴地图右侧，注记从栏顶（地图顶）开始
    expect(note.x).toBeCloseTo(scene.map.x + scene.map.width_pt + 16, 9);
    expect(note.y).toBeCloseTo(72, 9);
    // 注记/色标都在纸内，且色标不压注记（色标在注记块下方）
    const noteBottom = note.y + note.lines.length * note.font_size_pt * note.line_height;
    expect(colorbar.y).toBeGreaterThanOrEqual(noteBottom);
    expect(colorbar.x + colorbar.width_pt).toBeLessThanOrEqual(841.889764 - 28 + 1e-6);
    expect(validateScene(scene, geo).ok).toBe(true);
  });

  it('无 legend 也无注记（myanmar 型：只有 relief + 标题）也能合法渲染', () => {
    const raw = mutableGeo(makeGeo());
    delete raw['legend'];
    const suggestions = raw['suggestions'] as Record<string, unknown>;
    suggestions['notes'] = [];
    suggestions['source'] = '';
    const geo = normalizeGeo(raw as unknown as Geo);
    const scene = sceneOf(geo);
    expect(scene.items.some((item) => item.kind === 'legend')).toBe(false);
    expect(scene.items.some((item) => item.kind === 'colorbar')).toBe(true);
    expect(scene.items.some((item) => item.kind === 'text' && item.role === 'title')).toBe(true);
    expect(scene.items.some((item) => item.kind === 'text' && item.role === 'note')).toBe(false);
    expect(scene.items.some((item) => item.kind === 'text' && item.role === 'source')).toBe(false);
    expect(validateScene(scene, geo).ok).toBe(true);
  });
});

describe('defaultScene：无 relief / 无 suggestions 降级', () => {
  it('relief 为 null 时不生成色标，其余图例/注记保留', () => {
    const geo = normalizeGeo(withoutBlocks(makeGeo(), ['relief']));
    const scene = sceneOf(geo);
    expect(scene.items.some((item) => item.kind === 'colorbar')).toBe(false);
    expect(scene.items.some((item) => item.kind === 'legend')).toBe(true);
    expect(validateScene(scene, geo).ok).toBe(true);
  });

  it('suggestions 全空时不生成标题/副标题/注记/来源，只留图例与色标', () => {
    const geo = normalizeGeo(withoutBlocks(makeGeo(), ['suggestions']));
    const scene = sceneOf(geo);
    const pageTextRoles = scene.items
      .filter((item) => item.kind === 'text' && item.space === 'page')
      .map((item) => (item.kind === 'text' ? item.role : ''));
    expect(pageTextRoles).toEqual([]);
    expect(scene.items.some((item) => item.kind === 'legend')).toBe(true);
    expect(scene.items.some((item) => item.kind === 'colorbar')).toBe(true);
    expect(validateScene(scene, geo).ok).toBe(true);
  });

  it('三块全空：地图用满内容宽、只剩地名，scene 仍合法', () => {
    const geo = normalizeGeo(withoutBlocks(makeGeo(), ['legend', 'relief', 'suggestions']));
    const scene = sceneOf(geo);
    const contentWidth = 841.889764 - 56;
    expect(scene.map.width_pt).toBeCloseTo(contentWidth, 9);
    expect(scene.items.every((item) => item.kind === 'text' && item.space === 'map')).toBe(true);
    expect(scene.items).toHaveLength(geo.labels.length);
    const maxId = Math.max(...scene.items.map((item) => item.id));
    expect(scene.seq).toBe(maxId + 1);
    expect(validateScene(scene, geo).ok).toBe(true);
  });
});

describe('defaultScene：纵向版式降级', () => {
  it('A5 纵向且三块全空时不生成下方一排，地图仍用满内容宽', () => {
    const paper = {
      preset: 'A5' as const,
      orientation: 'portrait' as const,
      width_pt: 419.527559,
      height_pt: 595.275591,
    };
    const geo = normalizeGeo(withoutBlocks(makeGeo(), ['legend', 'relief', 'suggestions']));
    const scene = defaultScene(geo, BASE_DECLARATION, { figure: 'fixture.svg', paper });
    expect(scene.paper).toEqual(paper);
    expect(scene.map.width_pt).toBeCloseTo(paper.width_pt - 56, 9);
    expect(scene.items.every((item) => item.kind === 'text' && item.space === 'map')).toBe(true);
    expect(validateScene(scene, geo).ok).toBe(true);
  });

  it('A5 纵向且只有注记+色标时不生成图例，一排内互不重叠', () => {
    const paper = {
      preset: 'A5' as const,
      orientation: 'portrait' as const,
      width_pt: 419.527559,
      height_pt: 595.275591,
    };
    const geo = normalizeGeo(withoutBlocks(makeGeo(), ['legend']));
    const scene = defaultScene(geo, BASE_DECLARATION, { figure: 'fixture.svg', paper });
    expect(scene.items.some((item) => item.kind === 'legend')).toBe(false);
    const note = scene.items.find((item) => item.kind === 'text' && item.role === 'note');
    const colorbar = scene.items.find((item) => item.kind === 'colorbar');
    expect(note?.kind).toBe('text');
    expect(colorbar?.kind).toBe('colorbar');
    if (note?.kind !== 'text' || colorbar?.kind !== 'colorbar') return;
    // 注记从左边距开始（图例列不存在），色标仍贴右边距
    expect(note.x).toBeCloseTo(28, 9);
    expect(colorbar.x + colorbar.width_pt).toBeCloseTo(paper.width_pt - 28, 9);
    expect(note.x + 40).toBeLessThanOrEqual(colorbar.x + 1e-6);
    expect(validateScene(scene, geo).ok).toBe(true);
  });
});
