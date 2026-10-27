/**
 * `render/compose-svg.ts`（浏览器内合成 final.svg）的单测。
 *
 * 为什么在 node 里测：composeFinalSvg 是纯函数（不读 DOM/时间/随机数），成品必须是
 * 字符串且同输入同字节；这里验证 §6 图层结构、marker 往返、map 空间缩放、halo/旋转/
 * 多行、图框刻度与越界 report，并确认与预览共用 page-layout/page-format 的口径。
 * 元信息：作者 compose，2026-10-28，无后端数据流（导出按钮直接调 composeFinalSvg）。
 */

import { describe, expect, it } from 'vitest';
import { readBaseSvg } from '../../src/core/base-svg';
import type { PageDocument } from '../../src/core/document';
import {
  geoDigest,
  normalizeScene,
  sceneDigest,
  type ColorbarItem,
  type Geo,
  type LegendItem,
  type TextItem,
} from '../../src/core/page';
import { defaultScene } from '../../src/core/page-layout';
import { escapeXmlAttribute, formatPageNumber } from '../../src/render/page-format';
import { composeFinalSvg, type ComposeResult } from '../../src/render/compose-svg';
import {
  BASE_DECLARATION,
  BASE_INFO,
  makeDocument,
  makeGeo,
  withoutBlocks,
} from '../fixtures/page-fixtures';

const num = (value: number): string => formatPageNumber(value);

interface Setup {
  readonly document: PageDocument;
  readonly scene: ReturnType<typeof defaultScene>;
  readonly result: ComposeResult;
}

/** 打开 fixture 文档 + 默认排版 + 合成一次（多数用例共用） */
function setup(geo: Geo = makeGeo()): Setup {
  const document = makeDocument(geo);
  const scene = defaultScene(document.geo, BASE_DECLARATION, { figure: 'fixture.svg' });
  return { document, scene, result: composeFinalSvg(document, scene) };
}

/** 抽出 marker 的 base64 并解码成对象（payload 只含 ASCII，因此直接 atob 即可） */
function decodeMarker(svg: string): Record<string, unknown> {
  const match = /<!-- mapdoc-final:([A-Za-z0-9+/=]+) -->/.exec(svg);
  expect(match).not.toBeNull();
  return JSON.parse(atob(match?.[1] ?? '')) as Record<string, unknown>;
}

/** 抽出根层 `<defs>…</defs>`（底图 inner 里也可能有 `<defs>`，这里只取第一个） */
function defsOf(svg: string): string {
  const end = svg.indexOf('</defs>');
  return end < 0 ? '' : svg.slice(0, end + '</defs>'.length);
}

/** 找第一个指定 kind 的元素（测试 fixture 形状固定，直接断言存在） */
function firstText(scene: ReturnType<typeof defaultScene>, role?: TextItem['role']): TextItem {
  const item = scene.items.find(
    (entry): entry is TextItem =>
      entry.kind === 'text' && (role === undefined || entry.role === role),
  );
  if (item === undefined)
    throw new Error(`缺少 text item${role === undefined ? '' : `（${role}）`}`);
  return item;
}

describe('composeFinalSvg：§6 结构与数值', () => {
  it('文件头/纸张/图层顺序符合 §6，且底图原文原样内联', () => {
    const { result } = setup();
    const svg = result.svg;
    // 根 svg：宽高带 pt，viewBox 与宽高一致（数值走 formatPageNumber，3 位小数去尾零）
    expect(
      svg.startsWith(
        '<?xml version="1.0" encoding="utf-8"?>\n' +
          '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ' +
          'width="841.89pt" height="595.276pt" viewBox="0 0 841.89 595.276" version="1.1">\n',
      ),
    ).toBe(true);
    expect(svg).toContain('<rect x="0" y="0" width="841.89" height="595.276" fill="#ffffff"/>\n');

    // 底图内联：defs（裁剪）→ map 组（带 clip-path）→ 原文切片 + 收尾；不出现 <image> 引底图
    expect(svg).toContain(
      '<defs>\n<clipPath id="mapdoc-map-clip">' +
        '<rect x="0" y="0" width="200" height="100"/></clipPath>\n',
    );
    expect(svg).toContain(
      '<g id="mapdoc-map" clip-path="url(#mapdoc-map-clip)" ' +
        'transform="translate(28,72) scale(3.099)">',
    );
    expect(svg).toContain(BASE_INFO.inner);
    expect(svg).toContain('scale(3.099)">\n <defs>');
    expect(svg).not.toContain('<image');

    // 图层顺序：defs → map → frame → overlay → marker；clipPath 在色标渐变之前（契约）
    const defsIndex = svg.indexOf('<defs>');
    const mapIndex = svg.indexOf('<g id="mapdoc-map"');
    const frameIndex = svg.indexOf('<g id="mapdoc-frame">');
    const overlayIndex = svg.indexOf('<g id="mapdoc-overlay">');
    const markerIndex = svg.indexOf('<!-- mapdoc-final:');
    expect(defsIndex).toBeGreaterThan(0);
    expect(mapIndex).toBeGreaterThan(defsIndex);
    expect(frameIndex).toBeGreaterThan(mapIndex);
    expect(overlayIndex).toBeGreaterThan(frameIndex);
    expect(markerIndex).toBeGreaterThan(overlayIndex);
    expect(svg.indexOf('<clipPath id="mapdoc-map-clip">')).toBeGreaterThan(defsIndex);
    expect(svg.indexOf('<linearGradient id="mapdoc-cbar-')).toBeGreaterThan(
      svg.indexOf('<clipPath id="mapdoc-map-clip">'),
    );
    expect(svg.endsWith('<!-- mapdoc-final:')).toBe(false);
    expect(svg).toMatch(/-->\n<\/svg>\n$/);

    // 成品里没有预览专用命中标记/class
    expect(svg).not.toContain('data-page-item');
    expect(svg).not.toContain('class="page-item');
    // 文字是 <text>，不是被转成路径
    expect(svg).toContain('<text ');
  });

  it('marker 解出 canonical counts/geo/scene/version，且与 report counts 一致', () => {
    const { document, scene, result } = setup();
    const payload = decodeMarker(result.svg);
    const expectedCounts = {
      colorbar: scene.items.filter((item) => item.kind === 'colorbar').length,
      legend: scene.items.filter((item) => item.kind === 'legend').length,
      text: scene.items.filter((item) => item.kind === 'text').length,
      total: scene.items.length,
    };
    expect(payload['version']).toBe(1);
    expect(payload['counts']).toEqual(expectedCounts);
    expect(result.report.counts).toEqual(expectedCounts);
    expect(payload['geo']).toBe(geoDigest(document.geo));
    expect(payload['scene']).toBe(sceneDigest(scene));
    expect(result.report.out_of_paper).toEqual([]);
    // canonical JSON：键排序且无空白（marker 里不会出现 ': '）
    expect(result.svg).not.toContain('mapdoc-final: ');
  });

  it('同一输入两次合成得到同字节，且不改动入参 scene', () => {
    const { document, scene, result } = setup();
    const clone = structuredClone(scene);
    const second = composeFinalSvg(document, clone);
    expect(second.svg).toBe(result.svg);
    expect(second.report).toEqual(result.report);
    // 入参 scene 未被规范化逻辑改写
    expect(scene).toEqual(clone);
  });

  it('空 scene：frame/overlay 保留空组，marker 计数为 0', () => {
    const { document, scene } = setup();
    scene.items = [];
    scene.frame.show = false;
    scene.frame.ticks = false;
    const result = composeFinalSvg(document, scene);
    expect(result.svg).toContain('<g id="mapdoc-frame"></g>');
    expect(result.svg).toContain('<g id="mapdoc-overlay"></g>');
    // defs 仍存在（裁剪底图），但没有 colorbar 就没有色标渐变
    expect(defsOf(result.svg)).toContain('<clipPath id="mapdoc-map-clip">');
    expect(result.svg).not.toContain('<linearGradient');
    expect(result.svg).not.toContain('mapdoc-cbar');
    expect(decodeMarker(result.svg)['counts']).toEqual({
      colorbar: 0,
      legend: 0,
      text: 0,
      total: 0,
    });
  });
});

describe('composeFinalSvg：底图裁剪（消除 matplotlib 图幅白底外溢）', () => {
  it('defs 始终存在，mapdoc-map-clip 的 rect 用 geo.base.view_box', () => {
    const { document, result } = setup();
    const [x, y, width, height] = document.geo.base.view_box;
    expect(defsOf(result.svg)).toContain(
      '<clipPath id="mapdoc-map-clip">' +
        `<rect x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${num(height)}"/>` +
        '</clipPath>',
    );
  });

  it('viewBox 有偏移时 clip rect 用偏移后的局部坐标（不是纸张坐标）', () => {
    const geo = makeGeo();
    geo.base.view_box = [38.88, 102.7728, 896.350289, 712.3824];
    const { result } = setup(geo);
    expect(defsOf(result.svg)).toContain(
      '<clipPath id="mapdoc-map-clip">' +
        '<rect x="38.88" y="102.773" width="896.35" height="712.382"/></clipPath>',
    );
  });

  it('无 colorbar：defs 只有 clipPath；有 colorbar：clipPath 在前、渐变在后', () => {
    const { document, scene } = setup();
    // 没有色标的 scene 只剩裁剪
    const stripped = structuredClone(scene);
    stripped.items = stripped.items.filter((item) => item.kind !== 'colorbar');
    const noColorbarDefs = defsOf(composeFinalSvg(document, stripped).svg);
    expect(noColorbarDefs).toContain('<clipPath id="mapdoc-map-clip">');
    expect(noColorbarDefs).toContain('</clipPath>');
    expect(noColorbarDefs).not.toContain('<linearGradient');
    expect(noColorbarDefs.match(/<clipPath /g)).toHaveLength(1);

    const withColorbarDefs = defsOf(setup().result.svg);
    const clipIndex = withColorbarDefs.indexOf('<clipPath id="mapdoc-map-clip">');
    const gradientIndex = withColorbarDefs.indexOf('<linearGradient ');
    expect(clipIndex).toBeGreaterThan(0);
    expect(gradientIndex).toBeGreaterThan(clipIndex);
    expect(withColorbarDefs).toContain('</defs>');
  });

  it('paper_color 非白：纸张用 scene 值，底图仍由 clip 裁掉纸外白底', () => {
    const { document, scene } = setup();
    scene.style.paper_color = '#ffeecc';
    const result = composeFinalSvg(document, scene);
    expect(result.svg).toContain(
      '<rect x="0" y="0" width="841.89" height="595.276" fill="#ffeecc"/>',
    );
    // map group 通过 clip-path 引用同一个 defs，白底不会画到纸面（结构断言；
    // 浏览器端由 verifier 用近白色底图 + 非白 paper_color 目视复验）
    expect(result.svg).toMatch(
      /<g id="mapdoc-map" clip-path="url\(#mapdoc-map-clip\)" transform="[^"]+">/,
    );
  });
});

describe('composeFinalSvg：text/map 空间（§5.1/§5.3）', () => {
  it('map 空间文字只变换起点、字号不乘 s；halo 先描边后填充', () => {
    const { document, scene, result } = setup();
    const geo = document.geo;
    const label = firstText(scene, 'label');
    // 合成前会 normalizeScene（3 位小数），地图缩放比要用规范化后的 map.width_pt
    const map = normalizeScene(scene).map;
    const s = map.width_pt / geo.base.width_pt;
    const px = map.x + label.x * s;
    const py = map.y + label.y * s;
    expect(label.space).toBe('map');
    // 起点过 §5.1；font-size 仍是 pt（不乘 s）
    const family = escapeXmlAttribute(scene.style.font_family);
    expect(result.svg).toContain(
      `<text x="${num(px)}" y="${num(py)}" text-anchor="${label.anchor}" ` +
        `font-family="${family}" ` +
        `font-size="${num(label.font_size_pt)}" fill="${label.halo?.color ?? label.color}" ` +
        `stroke="${label.halo?.color ?? label.color}" stroke-width="${num(label.halo?.width_pt ?? 0)}" ` +
        'paint-order="stroke">甲国</text>',
    );
  });

  it('多行 + 旋转：整组绕第一行锚点旋转，行距 = 字号 × 行高', () => {
    const { document, scene, result } = setup();
    const geo = document.geo;
    const label = scene.items.find(
      (item): item is TextItem =>
        item.kind === 'text' && item.space === 'map' && item.lines.length > 1,
    );
    expect(label).toBeDefined();
    if (label === undefined) return;
    const map = normalizeScene(scene).map;
    const s = map.width_pt / geo.base.width_pt;
    const px = map.x + label.x * s;
    const py = map.y + label.y * s;
    const group = new RegExp(
      `<g transform="rotate\\(${num(label.rotation_deg)} ${num(px)} ${num(py)}\\)">([\\s\\S]*?)</g>`,
    ).exec(result.svg);
    expect(group).not.toBeNull();
    const body = group?.[1] ?? '';
    const y1 = py;
    const y2 = py + label.font_size_pt * label.line_height;
    expect(body).toContain(`y="${num(y1)}"`);
    expect(body).toContain(`y="${num(y2)}"`);
    expect(body).toContain('>乙河</text>');
    expect(body).toContain('>第二行</text>');
    expect(body.match(/<text /g)).toHaveLength(2);
  });

  it('斜体/粗体/字体族与 XML 转义（文本只转 & < >）', () => {
    const { document, scene } = setup();
    const title = firstText(scene, 'title');
    title.lines = ['a & <b> "c" \'d\''];
    title.italic = true;
    title.bold = true;
    title.font_family = "Noto 'X' &";
    const result = composeFinalSvg(document, scene);
    expect(result.svg).toContain('font-style="italic"');
    expect(result.svg).toContain('font-weight="bold"');
    expect(result.svg).toContain('font-family="Noto &apos;X&apos; &amp;"');
    expect(result.svg).toContain(`>a &amp; &lt;b&gt; "c" 'd'</text>`);
  });
});

describe('composeFinalSvg：legend（§5.4）', () => {
  it('底板/标题/三种形状与三类 point marker 都按公式输出', () => {
    const { scene, result } = setup();
    const legend = scene.items.find((item): item is LegendItem => item.kind === 'legend');
    expect(legend).toBeDefined();
    if (legend === undefined) return;
    const svg = result.svg;
    // 底板：fill-opacity 只作用白底；描边/线宽来自 frame
    expect(svg).toContain(
      `<rect x="${num(legend.x)}" y="${num(legend.y)}" width="${num(legend.width_pt)}" ` +
        `height="100.8" fill="#ffffff" fill-opacity="0.94" stroke="#bbbbbb" stroke-width="0.8"/>`,
    );
    // 标题：宽度中点、基线 = y + padding + title_size
    expect(svg).toContain(
      `<text x="${num(legend.x + legend.width_pt / 2)}" ` +
        `y="${num(legend.y + legend.padding_pt + legend.title_size_pt)}" ` +
        'text-anchor="middle"',
    );
    expect(svg).toContain('>图例</text>');
    // line swatch
    expect(svg).toContain('<line x1="670.89" y1="102.8" x2="694.89" y2="102.8" stroke="#4a4a4a"');
    // rect swatch（fill 来自条目）
    expect(svg).toContain('fill="#9ecae1" stroke="#2e6f9e"');
    // point marker：star 多边形 / square 矩形 / circle 圆
    expect(svg).toMatch(/<polygon points="[^"]+" fill="#cc3333" stroke="#cc3333"/);
    expect(svg).toMatch(
      /<rect x="[-\d.]+" y="[-\d.]+" width="[-\d.]+" height="[-\d.]+" fill="#3333cc"/,
    );
    expect(svg).toMatch(/<circle cx="[-\d.]+" cy="[-\d.]+" r="[-\d.]+" fill="#33cc33"/);
    for (const label of ['国界', '湖泊', '星标', '方标', '圆标']) {
      expect(svg).toContain(`>${label}</text>`);
    }
  });

  it('map 空间图例：origin 过 §5.1、只有宽度乘 s', () => {
    const { document, scene } = setup();
    const geo = document.geo;
    const legend = scene.items.find((item): item is LegendItem => item.kind === 'legend');
    if (legend === undefined) throw new Error('缺少图例');
    legend.space = 'map';
    legend.x = 20;
    legend.y = 10;
    const result = composeFinalSvg(document, scene);
    const map = normalizeScene(scene).map;
    const s = map.width_pt / geo.base.width_pt;
    const x = map.x + 20 * s;
    const y = map.y + 10 * s;
    const width = legend.width_pt * s;
    expect(result.svg).toContain(
      `<rect x="${num(x)}" y="${num(y)}" width="${num(width)}" height="100.8"`,
    );
    // 标题字号/行高不随 s 缩放
    expect(result.svg).toContain(`font-size="${num(legend.title_size_pt)}"`);
  });
});

describe('composeFinalSvg：colorbar（§5.5）', () => {
  it('渐变 defs、矩形、标题（带单位）与刻度文本', () => {
    const { document, scene, result } = setup();
    const colorbar = scene.items.find((item): item is ColorbarItem => item.kind === 'colorbar');
    expect(colorbar).toBeDefined();
    if (colorbar === undefined) return;
    const svg = result.svg;
    expect(svg).toContain(
      `<linearGradient id="mapdoc-cbar-${colorbar.id}" x1="0" y1="100%" x2="0" y2="0%">`,
    );
    expect(svg).toContain('<stop offset="0" stop-color="#08306b"/>');
    expect(svg).toContain('<stop offset="0.5" stop-color="#6baed6"/>');
    expect(svg).toContain('<stop offset="1" stop-color="#ffffff"/>');
    expect(svg).toContain(
      `<rect x="${num(colorbar.x)}" y="${num(colorbar.y)}" ` +
        `width="${num(colorbar.width_pt)}" height="${num(colorbar.height_pt)}" ` +
        `fill="url(#mapdoc-cbar-${colorbar.id})"/>`,
    );
    // 标题基线 = y - 4，单位后缀由 colorbarTitleText 补
    expect(svg).toContain('>高程 (m)</text>');
    expect(svg).toContain(`y="${num(colorbar.y - 4)}"`);
    for (const value of document.geo.relief?.ticks ?? []) {
      expect(svg).toContain(`>${num(value)}</text>`);
    }
  });

  it('map 空间色标：宽高乘 s、原点过 §5.1', () => {
    const { document, scene } = setup();
    const geo = document.geo;
    const colorbar = scene.items.find((item): item is ColorbarItem => item.kind === 'colorbar');
    if (colorbar === undefined) throw new Error('缺少色标');
    colorbar.space = 'map';
    colorbar.x = 20;
    colorbar.y = 50;
    const result = composeFinalSvg(document, scene);
    const map = normalizeScene(scene).map;
    const s = map.width_pt / geo.base.width_pt;
    expect(result.svg).toContain(
      `<rect x="${num(map.x + 20 * s)}" y="${num(map.y + 50 * s)}" ` +
        `width="${num(colorbar.width_pt * s)}" height="${num(colorbar.height_pt * s)}" ` +
        `fill="url(#mapdoc-cbar-${colorbar.id})"/>`,
    );
    // 字号仍是 pt
    expect(result.svg).toContain(`font-size="${num(colorbar.label_size_pt)}"`);
  });

  it('geo.relief 为 null 而 scene 还有 colorbar 时抛「色标需要 geo.relief」', () => {
    const fullScene = setup().scene;
    const document = makeDocument(withoutBlocks(makeGeo(), ['relief']));
    expect(() => composeFinalSvg(document, fullScene)).toThrow('色标需要 geo.relief');
  });
});

describe('composeFinalSvg：图框/刻度（§5.2）', () => {
  it('图框矩形 + 经纬刻度线与基线都按公式输出', () => {
    const { document, scene, result } = setup();
    const geo = document.geo;
    const map = normalizeScene(scene).map;
    const s = map.width_pt / geo.base.width_pt;
    const mapHeight = (map.width_pt * geo.base.height_pt) / geo.base.width_pt;
    const mapBottom = map.y + mapHeight;
    const svg = result.svg;
    expect(svg).toContain(
      `<rect x="28" y="72" width="${num(map.width_pt)}" height="${num(mapHeight)}" fill="none" stroke="#000000" stroke-width="0.8"/>`,
    );
    // 第一条经度刻度（bottom）
    const lon = geo.graticule.lon[0];
    if (lon === undefined) throw new Error('缺少经度刻度');
    const px = map.x + lon.x * s;
    expect(svg).toContain(
      `<line x1="${num(px)}" y1="${num(mapBottom)}" x2="${num(px)}" ` +
        `y2="${num(mapBottom + scene.frame.tick_length_pt)}" ` +
        `stroke="#444444" stroke-width="0.8"/>`,
    );
    expect(svg).toContain(
      `y="${num(mapBottom + scene.frame.tick_length_pt + scene.frame.tick_gap_pt + scene.frame.tick_font_size_pt)}"`,
    );
    expect(svg).toContain('>0°</text>');
    // 纬度刻度：left 侧从 map.x 向左、标签 anchor=end
    const lat = geo.graticule.lat[0];
    if (lat === undefined) throw new Error('缺少纬度刻度');
    const py = map.y + lat.y * s;
    expect(svg).toContain(
      `<line x1="28" y1="${num(py)}" x2="${num(28 - scene.frame.tick_length_pt)}" ` +
        `y2="${num(py)}" stroke="#444444" stroke-width="0.8"/>`,
    );
    expect(svg).toContain('text-anchor="end"');
  });
});

describe('composeFinalSvg：report 越界告警', () => {
  it('item 越界：out_of_paper 按 items 顺序、告警带中文说明', () => {
    const { document, scene } = setup();
    const title = firstText(scene, 'title');
    title.x = -100;
    const note = firstText(scene, 'note');
    note.y = 10000;
    const result = composeFinalSvg(document, scene);
    expect(result.report.out_of_paper).toEqual([title.id, note.id]);
    expect(result.report.warnings).toContain(
      `item ${title.id}(text) 超出纸张范围，成品里可能被裁掉`,
    );
    expect(result.report.warnings).toContain(
      `item ${note.id}(text) 超出纸张范围，成品里可能被裁掉`,
    );
    // 越界只是告警：内容仍写进成品（由纸张裁掉）
    expect(result.svg).toContain('x="-100"');
  });

  it('地图越界只进 warnings（不占 out_of_paper）', () => {
    const { document, scene } = setup();
    scene.map.x = -50;
    const result = composeFinalSvg(document, scene);
    expect(result.report.warnings).toContain('地图超出纸张范围（成品会被裁切，仅告警）');
    expect(result.report.out_of_paper).toEqual([]);
  });
});

describe('composeFinalSvg：错误路径', () => {
  it('底图契约有错误时拒绝合成', () => {
    const document = makeDocument();
    const invalid: PageDocument = { ...document, base: readBaseSvg('<svg>no viewBox</svg>') };
    expect(() => composeFinalSvg(invalid, defaultScene(document.geo, BASE_DECLARATION))).toThrow(
      /底图未通过契约检查/,
    );
  });

  it('scene 走 normalizeScene（3 位小数）后再输出', () => {
    const { document, scene } = setup();
    scene.map.x = 28.00049;
    const result = composeFinalSvg(document, scene);
    // 28.00049 → 28（3 位小数），translate 用规范化后的值
    expect(result.svg).toContain(
      '<g id="mapdoc-map" clip-path="url(#mapdoc-map-clip)" ' +
        'transform="translate(28,72) scale(3.099)">',
    );
    expect(normalizeScene(scene).map.x).toBe(28);
  });
});
