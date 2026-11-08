/**
 * `core/page-layout.ts` 的 §5.7 item 几何框(`itemBoundsMm`)单测.
 *
 * 为什么要有这些用例:预览里的选中框与点击命中盒都改成「由 geo.json 的 page 块 + §5 公式 + 字体
 * 行盒」推出的声明几何框(不再用 DOM getBBox,也不再有外扩容差).这里把每条推导钉住:
 * 水平边界来自锚点 + 内容宽度(自动折行的注记/来源取折行宽度,其余取最长行前进宽度),
 * 垂直边界来自行基线 + 字体行盒,旋转来自 §5.3 的 rotate(rotation_deg px py),
 * 图例/色标用 §5.4/§5.5 的声明框(纸张 mm,不再有 map 空间缩放).
 * 元信息:作者 ToyosatomiminoMiko,2026-11-05.
 */

import { describe, expect, it } from 'vitest';
import {
  PAGE_AUTO_WRAP_MIN_MM,
  PAGE_SOURCE_CLEARANCE_MM,
  PAGE_SOURCE_RESERVED_MM,
  layoutScaleForPaper,
} from '../../src/config/page';
import { roundToPageDecimals } from '../../src/core/page';
import type { ColorbarItem, Geo, LegendItem, PageLayout, TextItem } from '../../src/core/page';
import {
  defaultAutoWrapWidth,
  defaultPageLayout,
  effectiveAutoWrapWidth,
  enforceAutoWrap,
  fallbackTextMeasure,
  fontShorthand,
  frameTickLayout,
  itemBoundsMm,
  legendLayout,
  mapHeightMm,
  remapMapLabelItems,
  textBlockWidth,
  textLayout,
} from '../../src/core/page-layout';
import { makeDocument, makeGeo } from '../fixtures/page-fixtures';

const document = makeDocument();
const geo = document.geo;
const layout = defaultPageLayout(geo);

/** 取默认排版里的第一个指定 kind 元素;没有就抛(fixture 一定给了 legend/colorbar) */
function firstOf<K extends 'text' | 'legend' | 'colorbar'>(
  kind: K,
): Extract<TextItem | LegendItem | ColorbarItem, { kind: K }> {
  const item = layout.items.find(
    (candidate): candidate is Extract<TextItem | LegendItem | ColorbarItem, { kind: K }> =>
      candidate.kind === kind,
  );
  if (!item) throw new Error(`默认排版缺少 ${kind} 元素`);
  return item;
}

describe('itemBoundsMm:text 水平边界', () => {
  const base = firstOf('text');

  it.each([
    ['start', (px: number, _width: number) => px],
    ['middle', (px: number, width: number) => px - width / 2],
    ['end', (px: number, width: number) => px - width],
  ] as const)('anchor=%s 时左边界由锚点与前进宽度推出', (anchor, left) => {
    const item: TextItem = { ...base, anchor, rotation_deg: 0 };
    const text = textLayout(item);
    const width = textBlockWidth(item, fallbackTextMeasure.width, layout.style.font_family);
    const bounds = itemBoundsMm(item, layout, fallbackTextMeasure);
    const font = fontOf(item);
    const ascent = fallbackTextMeasure.ascent(font);
    const descent = fallbackTextMeasure.descent(font);
    const step = item.font_size_mm * item.line_height;
    const halfLeading = Math.max(0, (step - (ascent + descent)) / 2);
    expect(bounds.width).toBeCloseTo(width, 10);
    expect(bounds.x).toBeCloseTo(left(text.px, width), 10);
    expect(bounds.y).toBeCloseTo(text.py - ascent - halfLeading, 10);
  });

  it('宽高按实测字体行盒 + 半行距:垂直 = 首行上沿 .. 末行下沿', () => {
    const item: TextItem = {
      ...base,
      x: 100,
      y: 60,
      anchor: 'middle',
      rotation_deg: 0,
      font_size_mm: 10,
      line_height: 1.4,
      lines: ['第一行', '第二行', '第三行'],
    };
    const text = textLayout(item);
    const font = fontOf(item);
    const ascent = fallbackTextMeasure.ascent(font);
    const descent = fallbackTextMeasure.descent(font);
    const step = item.font_size_mm * item.line_height;
    const halfLeading = Math.max(0, (step - (ascent + descent)) / 2);
    const bounds = itemBoundsMm(item, layout, fallbackTextMeasure);
    expect(bounds.y).toBeCloseTo(text.py - ascent - halfLeading, 10);
    expect(bounds.height).toBeCloseTo(
      (item.lines.length - 1) * step + ascent + descent + halfLeading * 2,
      10,
    );
  });

  it('单行选中框随行高变高;行高小于字体行盒时半行距为 0(不裁字)', () => {
    const item: TextItem = {
      ...firstOf('text'),
      x: 100,
      y: 60,
      anchor: 'middle',
      rotation_deg: 0,
      font_size_mm: 10,
      lines: ['单行'],
    };
    const tight = itemBoundsMm({ ...item, line_height: 1 }, layout, fallbackTextMeasure);
    const loose = itemBoundsMm({ ...item, line_height: 1.5 }, layout, fallbackTextMeasure);
    const compressed = itemBoundsMm({ ...item, line_height: 0.5 }, layout, fallbackTextMeasure);
    expect(loose.height).toBeGreaterThan(tight.height);
    expect(tight.height).toBeCloseTo(10, 10);
    expect(loose.height).toBeCloseTo(15, 10);
    // 字体行盒是 1.0em(回退 0.8+0.2),0.5 行高的负半行距被夹到 0
    expect(compressed.height).toBeCloseTo(tight.height, 10);
  });
});

describe('itemBoundsMm:自动折行文字的横向框 = 折行宽度设置', () => {
  /** 取一份新默认排版里指定角色的页面文字(fixture 的注记/来源都带折行字段) */
  function pageTextOf(target: PageLayout, role: 'note' | 'source' | 'title'): TextItem {
    const item = target.items.find(
      (candidate): candidate is TextItem =>
        candidate.kind === 'text' && candidate.role === role && candidate.geo_label_id === null,
    );
    if (item === undefined) throw new Error(`默认排版缺少 ${role} item`);
    return item;
  }

  it('短文案 + 大折行宽度:框显示设置宽度,而不是文字实际宽度', () => {
    const target = defaultPageLayout(geo);
    const note: TextItem = {
      ...pageTextOf(target, 'note'),
      wrap_width_mm: 300,
      text: '短',
      lines: ['短'],
    };
    const textWidth = textBlockWidth(note, fallbackTextMeasure.width, target.style.font_family);
    const bounds = itemBoundsMm(note, target, fallbackTextMeasure);
    expect(bounds.width).toBeCloseTo(300, 10);
    expect(bounds.width).toBeGreaterThan(textWidth);
  });

  it.each([
    ['start', (px: number, _width: number) => px],
    ['middle', (px: number, width: number) => px - width / 2],
    ['end', (px: number, width: number) => px - width],
  ] as const)('anchor=%s:框宽 = 折行宽度,左右边界按锚点展开', (anchor, left) => {
    const target = defaultPageLayout(geo);
    const note: TextItem = {
      ...pageTextOf(target, 'note'),
      anchor,
      center_h: false,
      wrap_width_mm: 120,
    };
    expect(effectiveAutoWrapWidth(target, note)).toBe(120);
    const text = textLayout(note);
    const bounds = itemBoundsMm(note, target, fallbackTextMeasure);
    expect(bounds.width).toBeCloseTo(120, 10);
    expect(bounds.x).toBeCloseTo(left(text.px, 120), 10);
  });

  it('来源(左右居中):框宽 = 内容宽,框以锚点 x 为中心', () => {
    const target = defaultPageLayout(geo);
    const source = pageTextOf(target, 'source');
    const width = effectiveAutoWrapWidth(target, source) ?? 0;
    const text = textLayout(source);
    const bounds = itemBoundsMm(source, target, fallbackTextMeasure);
    expect(width).toBeGreaterThan(0);
    expect(bounds.width).toBeCloseTo(width, 10);
    expect(bounds.x).toBeCloseTo(text.px - width / 2, 10);
  });

  it('宽度先夹到下限/收敛到 3 位小数再画框(与 enforceAutoWrap 落盘值一致)', () => {
    const target = defaultPageLayout(geo);
    const note = pageTextOf(target, 'note');
    note.wrap_width_mm = 5;
    expect(enforceAutoWrap(target)).toBeGreaterThan(0);
    expect(note.wrap_width_mm).toBe(PAGE_AUTO_WRAP_MIN_MM);
    expect(itemBoundsMm(note, target, fallbackTextMeasure).width).toBeCloseTo(
      PAGE_AUTO_WRAP_MIN_MM,
      10,
    );

    note.wrap_width_mm = 123.45678;
    expect(enforceAutoWrap(target)).toBeGreaterThan(0);
    expect(note.wrap_width_mm).toBe(123.457);
    expect(itemBoundsMm(note, target, fallbackTextMeasure).width).toBeCloseTo(123.457, 10);
  });

  it('wrap_width_mm 缺省(旧 page 块):框,面板读数,enforce 写入值同源', () => {
    const target = defaultPageLayout(geo);
    const note = pageTextOf(target, 'note');
    note.wrap_width_mm = null;
    const fallback = defaultAutoWrapWidth(target, note);
    expect(effectiveAutoWrapWidth(target, note)).toBe(fallback);
    expect(itemBoundsMm(note, target, fallbackTextMeasure).width).toBeCloseTo(fallback, 10);
    enforceAutoWrap(target);
    expect(note.wrap_width_mm).toBe(fallback);
    expect(itemBoundsMm(note, target, fallbackTextMeasure).width).toBeCloseTo(fallback, 10);
  });

  it('非自动折行文字忽略折行字段,横向仍取最长行前进宽度', () => {
    const target = defaultPageLayout(geo);
    const title: TextItem = { ...pageTextOf(target, 'title'), wrap_width_mm: 60 };
    expect(effectiveAutoWrapWidth(target, title)).toBeNull();
    const expected = textBlockWidth(title, fallbackTextMeasure.width, target.style.font_family);
    expect(itemBoundsMm(title, target, fallbackTextMeasure).width).toBeCloseTo(expected, 10);
  });

  it('地图地名(不参与折行)横向框仍按各行前进宽度', () => {
    const target = defaultPageLayout(geo);
    const label = target.items.find(
      (candidate): candidate is TextItem =>
        candidate.kind === 'text' && candidate.geo_label_id !== null,
    );
    if (label === undefined) throw new Error('默认排版缺少地图地名');
    expect(effectiveAutoWrapWidth(target, label)).toBeNull();
    const expected = textBlockWidth(label, fallbackTextMeasure.width, target.style.font_family);
    expect(itemBoundsMm(label, target, fallbackTextMeasure).width).toBeCloseTo(expected, 10);
  });
});

describe('itemBoundsMm:text 旋转', () => {
  const base = firstOf('text');
  const flat: TextItem = { ...base, rotation_deg: 0 };

  it('旋转框记录 §5.3 的 rotate(rotation_deg px py),不改变未旋转几何', () => {
    const rotated: TextItem = { ...flat, rotation_deg: -30 };
    const plain = itemBoundsMm(flat, layout, fallbackTextMeasure);
    const turned = itemBoundsMm(rotated, layout, fallbackTextMeasure);
    const text = textLayout(rotated);
    expect(turned.rotation_deg).toBe(-30);
    expect(turned.rotationX).toBeCloseTo(text.px, 10);
    expect(turned.rotationY).toBeCloseTo(text.py, 10);
    expect(turned.x).toBeCloseTo(plain.x, 10);
    expect(turned.y).toBeCloseTo(plain.y, 10);
    expect(turned.width).toBeCloseTo(plain.width, 10);
    expect(turned.height).toBeCloseTo(plain.height, 10);
  });
});

describe('itemBoundsMm:legend / colorbar 声明框', () => {
  it('图例:x/y/width 来自 layout,高度来自 §5.4 公式', () => {
    const item = firstOf('legend');
    const bounds = itemBoundsMm(item, layout, fallbackTextMeasure);
    expect(bounds.x).toBeCloseTo(item.x, 10);
    expect(bounds.y).toBeCloseTo(item.y, 10);
    expect(bounds.width).toBeCloseTo(item.width_mm, 10);
    expect(bounds.height).toBeCloseTo(legendLayout(item).height, 10);
    expect(bounds.rotation_deg).toBe(0);
  });

  it('色标:宽高来自 layout(纸张坐标,不再按地图缩放)', () => {
    const item = firstOf('colorbar');
    const bounds = itemBoundsMm(item, layout, fallbackTextMeasure);
    expect(bounds.x).toBeCloseTo(item.x, 10);
    expect(bounds.y).toBeCloseTo(item.y, 10);
    expect(bounds.width).toBeCloseTo(item.width_mm, 10);
    expect(bounds.height).toBeCloseTo(item.height_mm, 10);
  });
});

describe('字体行盒回退口径', () => {
  it('无 canvas 时按字号 × 0.8em / 0.2em(浏览器用 CSS font 的 fontBoundingBox)', () => {
    expect(fallbackTextMeasure.ascent('10px sans-serif')).toBeCloseTo(8, 10);
    expect(fallbackTextMeasure.descent('10px sans-serif')).toBeCloseTo(2, 10);
    expect(fallbackTextMeasure.ascent('12px sans-serif')).toBeCloseTo(9.6, 10);
  });
});

/** 与 itemBoundsMm 内部一致的字体简写(item.font_family 优先,否则 layout.style;含字重) */
function fontOf(item: TextItem): string {
  return fontShorthand(
    item.font_size_mm,
    item.font_family ?? layout.style.font_family,
    item.font_weight,
  );
}

describe('remapMapLabelItems:移动/缩放地图时地名跟着地图走', () => {
  it('平移到 x+10:地名纸张坐标同步 +10,页面文字不动', () => {
    const target = defaultPageLayout(geo);
    const label = target.items.find(
      (candidate): candidate is TextItem =>
        candidate.kind === 'text' && candidate.geo_label_id !== null,
    );
    if (label === undefined) throw new Error('缺少地图地名');
    const pageText = target.items.find(
      (candidate): candidate is TextItem =>
        candidate.kind === 'text' && candidate.geo_label_id === null,
    );
    if (pageText === undefined) throw new Error('缺少页面文字');
    const before = { x: label.x, y: label.y };
    const pageBefore = { x: pageText.x, y: pageText.y };
    const previousMap = { ...target.map };
    target.map.x += 10;
    const changed = remapMapLabelItems(target, geo, previousMap);
    expect(changed).toBeGreaterThan(0);
    expect(label.x).toBeCloseTo(before.x + 10, 9);
    expect(label.y).toBeCloseTo(before.y, 9);
    expect(pageText.x).toBeCloseTo(pageBefore.x, 9);
    expect(pageText.y).toBeCloseTo(pageBefore.y, 9);
  });

  it('缩放地图:地名按新旧缩放比换算相对地图的偏移', () => {
    const target = defaultPageLayout(geo);
    const label = target.items.find(
      (candidate): candidate is TextItem =>
        candidate.kind === 'text' && candidate.geo_label_id !== null,
    );
    if (label === undefined) throw new Error('缺少地图地名');
    const previousMap = { ...target.map };
    const offsetBefore = label.x - previousMap.x;
    const scale = 2;
    target.map = { ...target.map, width_mm: target.map.width_mm * scale };
    remapMapLabelItems(target, geo, previousMap);
    // 相对地图左上角的偏移按 2 倍放大
    expect(label.x).toBeCloseTo(target.map.x + offsetBefore * scale, 6);
  });
});

describe('defaultAutoWrapWidth:页边距参与回退宽度', () => {
  it('设了左右页边距后,可用折行宽度按版心边线推', () => {
    const target = defaultPageLayout(geo);
    const note = target.items.find(
      (candidate): candidate is TextItem => candidate.kind === 'text' && candidate.role === 'note',
    );
    if (note === undefined) throw new Error('缺少注记');
    note.wrap_width_mm = null;
    target.margin = { top: 0, right: 30, bottom: 0, left: 20 };
    expect(defaultAutoWrapWidth(target, note)).toBeCloseTo(
      roundToPageDecimals(Math.max(PAGE_AUTO_WRAP_MIN_MM, target.paper.width_mm - 30 - note.x)),
      9,
    );
  });
});

describe('defaultPageLayout:页底预留随来源折行/底部刻度动态变化(回归)', () => {
  /** 页边距内部内缩(mm),与 defaultPageLayout 的 inset 一致 */
  const INSET = 10;

  /**
   * fixture 底图是 200×100;宽度约束时页底预留不会改变地图尺寸,所以把底图改成
   * 200×400(宽高比 2),让「可用高度」成为地图的限制,才能直接断言预留高度.
   */
  function tallGeo(source: string): Geo {
    const geo = makeGeo();
    geo.base.height_pt = 400;
    geo.base.view_box = [0, 0, 200, 400];
    geo.suggestions = { ...geo.suggestions, source };
    return geo;
  }

  /** 布局里的来源 item(页面文字,geo_label_id 为 null) */
  function sourceOf(target: PageLayout): TextItem {
    const item = target.items.find(
      (candidate): candidate is TextItem =>
        candidate.kind === 'text' && candidate.role === 'source' && candidate.geo_label_id === null,
    );
    if (item === undefined) throw new Error('默认排版缺少来源');
    return item;
  }

  /** 复算页底预留:底部刻度带 + 折行后来源块高 + 净空,与既有最小值取大 */
  function reservedOf(
    target: PageLayout,
    targetGeo: Geo,
  ): { reserved: number; band: number; block: number } {
    const source = target.items.find(
      (candidate): candidate is TextItem =>
        candidate.kind === 'text' && candidate.role === 'source' && candidate.geo_label_id === null,
    );
    const band =
      target.frame.ticks && targetGeo.graticule.lon.some((tick) => tick.side !== 'top')
        ? target.frame.tick_length_mm + target.frame.tick_gap_mm + target.frame.tick_font_size_mm
        : 0;
    const block =
      source === undefined
        ? 0
        : (source.lines.length - 1) * source.font_size_mm * source.line_height +
          source.font_size_mm;
    const k = layoutScaleForPaper(target.paper.width_mm, target.paper.height_mm);
    return {
      reserved: Math.max(PAGE_SOURCE_RESERVED_MM * k, band + block + PAGE_SOURCE_CLEARANCE_MM),
      band,
      block,
    };
  }

  it('短来源(1 行):预留 = 刻度带 + 块高 + 净空(大于既有最小值),来源首行基线按净空让开刻度文字', () => {
    const geo = tallGeo('来源:fixture');
    const layout = defaultPageLayout(geo);
    const source = sourceOf(layout);
    expect(source.lines).toHaveLength(1);

    const { reserved, band, block } = reservedOf(layout, geo);
    // fixture:6(刻度带) + 2(一行来源) + PAGE_SOURCE_CLEARANCE_MM;大于旧固定值 9
    expect(band).toBeCloseTo(6, 9);
    expect(block).toBeCloseTo(source.font_size_mm, 9);
    expect(reserved).toBeCloseTo(band + block + PAGE_SOURCE_CLEARANCE_MM, 9);
    expect(reserved).toBeGreaterThan(PAGE_SOURCE_RESERVED_MM);
    // 高度约束下:地图底边 = 页底(扣内缩) - 实际预留
    const mapBottom = layout.map.y + mapHeightMm(geo, layout.map);
    expect(mapBottom).toBeCloseTo(layout.paper.height_mm - INSET - reserved, 9);

    // 来源首行基线 - 底部刻度文字基线 = 来源字号 + 净空;等价于刻度文字底边在来源块顶之上.
    const bottomTicks = frameTickLayout(layout, geo).filter((tick) => tick.side === 'bottom');
    expect(bottomTicks.length).toBeGreaterThan(0);
    const tickTextY = bottomTicks[0]!.textY;
    expect(tickTextY).toBeCloseTo(mapBottom + band, 9);
    expect(source.y - tickTextY).toBeCloseTo(source.font_size_mm + PAGE_SOURCE_CLEARANCE_MM, 9);
    expect(source.y - tickTextY).toBeGreaterThan(0);
  });

  it('来源折成多行:预留变大,地图高度进一步变小,首行基线与刻度仍保持净空', () => {
    const shortGeo = tallGeo('来源:fixture');
    const shortLayout = defaultPageLayout(shortGeo);
    const longGeo = tallGeo(`来源:${'超长来源文案'.repeat(80)}`);
    const longLayout = defaultPageLayout(longGeo);

    const longSource = sourceOf(longLayout);
    expect(longSource.lines.length).toBeGreaterThan(2);
    const shortReserved = reservedOf(shortLayout, shortGeo).reserved;
    const { reserved, band } = reservedOf(longLayout, longGeo);
    expect(reserved).toBeGreaterThan(shortReserved);
    expect(reserved).toBeCloseTo(
      band +
        (longSource.lines.length - 1) * longSource.font_size_mm * longSource.line_height +
        longSource.font_size_mm +
        PAGE_SOURCE_CLEARANCE_MM,
      9,
    );

    // 折行越多地图越矮(高度约束下),且来源块顶始终给刻度文字留出净空
    expect(mapHeightMm(longGeo, longLayout.map)).toBeLessThan(
      mapHeightMm(shortGeo, shortLayout.map),
    );
    const mapBottom = longLayout.map.y + mapHeightMm(longGeo, longLayout.map);
    expect(mapBottom).toBeCloseTo(longLayout.paper.height_mm - INSET - reserved, 9);
    const bottomTicks = frameTickLayout(longLayout, longGeo).filter(
      (tick) => tick.side === 'bottom',
    );
    expect(bottomTicks.length).toBeGreaterThan(0);
    expect(longSource.y - bottomTicks[0]!.textY).toBeCloseTo(
      longSource.font_size_mm + PAGE_SOURCE_CLEARANCE_MM,
      9,
    );
  });

  it('无来源 / 无底部刻度:退回既有最小预留 PAGE_SOURCE_RESERVED_MM × k', () => {
    // 经度刻度全部标到 top(不再占用页底),来源为空 -> 只有既有最小值生效
    const geo = tallGeo('');
    geo.graticule = {
      ...geo.graticule,
      lon: geo.graticule.lon.map((tick) => ({ ...tick, side: 'top' as const })),
    };
    const layout = defaultPageLayout(geo);
    expect(layout.items.some((item) => item.kind === 'text' && item.role === 'source')).toBe(false);
    const { reserved, band, block } = reservedOf(layout, geo);
    expect(band).toBe(0);
    expect(block).toBe(0);
    const k = layoutScaleForPaper(layout.paper.width_mm, layout.paper.height_mm);
    expect(reserved).toBeCloseTo(PAGE_SOURCE_RESERVED_MM * k, 9);
    const mapBottom = layout.map.y + mapHeightMm(geo, layout.map);
    expect(mapBottom).toBeCloseTo(layout.paper.height_mm - INSET - reserved, 9);
  });
});
