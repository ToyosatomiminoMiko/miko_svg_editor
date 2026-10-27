/**
 * `core/page-layout.ts` 的 §5.7 item 几何框（`itemBoundsPt`）单测。
 *
 * 为什么要有这些用例：预览里的选中框与点击命中盒都改成「由 scene.json + §5 公式 + 字体
 * 行盒」推出的声明几何框（不再用 DOM getBBox，也不再有外扩容差）。这里把每条推导钉住：
 * 水平边界来自锚点 + 前进宽度，垂直边界来自行基线 + 字体行盒，旋转来自 §5.3 的
 * rotate(rotation_deg px py)，图例/色标用 §5.4/§5.5 的声明框并按 map 空间缩放。
 * 元信息：作者 frontend，2026-10-28，无后端数据流（上传后排版/选中框同源）。
 */

import { describe, expect, it } from 'vitest';
import type { ColorbarItem, LegendItem, TextItem } from '../../src/core/page';
import {
  defaultScene,
  fallbackTextMeasure,
  itemBoundsPt,
  itemPlacement,
  legendLayout,
  mapPointToPage,
  mapTransform,
  textBlockWidth,
  textLayout,
} from '../../src/core/page-layout';
import { BASE_DECLARATION, makeDocument } from '../fixtures/page-fixtures';

const document = makeDocument();
const geo = document.geo;
const scene = defaultScene(geo, BASE_DECLARATION, { figure: 'fixture.svg' });

/** 取默认排版里的第一个指定 kind 元素；没有就抛（fixture 一定给了 legend/colorbar） */
function firstOf<K extends 'text' | 'legend' | 'colorbar'>(
  kind: K,
): Extract<TextItem | LegendItem | ColorbarItem, { kind: K }> {
  const item = scene.items.find(
    (candidate): candidate is Extract<TextItem | LegendItem | ColorbarItem, { kind: K }> =>
      candidate.kind === kind,
  );
  if (!item) throw new Error(`默认排版缺少 ${kind} 元素`);
  return item;
}

describe('itemBoundsPt：text 水平边界', () => {
  const base = firstOf('text');

  it.each([
    ['start', (px: number, _width: number) => px],
    ['middle', (px: number, width: number) => px - width / 2],
    ['end', (px: number, width: number) => px - width],
  ] as const)('anchor=%s 时左边界由锚点与前进宽度推出', (anchor, left) => {
    const item: TextItem = { ...base, anchor, rotation_deg: 0 };
    const layout = textLayout(item, geo, scene);
    const width = textBlockWidth(item, fallbackTextMeasure.width, scene.style.font_family);
    const bounds = itemBoundsPt(item, scene, geo);
    expect(bounds.width).toBeCloseTo(width, 10);
    expect(bounds.x).toBeCloseTo(left(layout.px, width), 10);
    expect(bounds.y).toBeCloseTo(layout.py - fallbackTextMeasure.ascent(fontOf(item)), 10);
  });

  it('宽高按实测字体行盒而不是固定外扩：垂直 = 首行上伸 .. 末行下伸', () => {
    const item: TextItem = {
      ...base,
      space: 'page',
      x: 100,
      y: 60,
      anchor: 'middle',
      rotation_deg: 0,
      font_size_pt: 10,
      line_height: 1.4,
      lines: ['第一行', '第二行', '第三行'],
    };
    const layout = textLayout(item, geo, scene);
    const font = fontOf(item);
    const ascent = fallbackTextMeasure.ascent(font);
    const descent = fallbackTextMeasure.descent(font);
    const bounds = itemBoundsPt(item, scene, geo);
    const step = item.font_size_pt * item.line_height;
    expect(bounds.y).toBeCloseTo(layout.py - ascent, 10);
    expect(bounds.height).toBeCloseTo((item.lines.length - 1) * step + ascent + descent, 10);
  });
});

describe('itemBoundsPt：text 旋转与坐标空间', () => {
  const base = firstOf('text');
  const flat: TextItem = { ...base, rotation_deg: 0 };

  it('旋转框记录 §5.3 的 rotate(rotation_deg px py)，不改变未旋转几何', () => {
    const rotated: TextItem = { ...flat, rotation_deg: -30 };
    const plain = itemBoundsPt(flat, scene, geo);
    const turned = itemBoundsPt(rotated, scene, geo);
    const layout = textLayout(rotated, geo, scene);
    expect(turned.rotation_deg).toBe(-30);
    expect(turned.rotationX).toBeCloseTo(layout.px, 10);
    expect(turned.rotationY).toBeCloseTo(layout.py, 10);
    expect(turned.x).toBeCloseTo(plain.x, 10);
    expect(turned.y).toBeCloseTo(plain.y, 10);
    expect(turned.width).toBeCloseTo(plain.width, 10);
    expect(turned.height).toBeCloseTo(plain.height, 10);
  });

  it('map 空间过 §5.1 变换后再加字体行盒', () => {
    const item: TextItem = { ...flat, space: 'map', x: 80, y: 40 };
    const layout = textLayout(item, geo, scene);
    const origin = mapPointToPage(mapTransform(geo, scene.map), item);
    expect(layout.px).toBeCloseTo(origin.x, 10);
    expect(layout.py).toBeCloseTo(origin.y, 10);
    const bounds = itemBoundsPt(item, scene, geo);
    expect(bounds.rotationX).toBeCloseTo(origin.x, 10);
    expect(bounds.rotationY).toBeCloseTo(origin.y, 10);
  });
});

describe('itemBoundsPt：legend / colorbar 声明框', () => {
  it('page 空间图例：x/y/width 来自 scene，高度来自 §5.4 公式', () => {
    const item = firstOf('legend');
    const bounds = itemBoundsPt(item, scene, geo);
    expect(bounds.x).toBeCloseTo(item.x, 10);
    expect(bounds.y).toBeCloseTo(item.y, 10);
    expect(bounds.width).toBeCloseTo(item.width_pt, 10);
    expect(bounds.height).toBeCloseTo(legendLayout(item).height, 10);
    expect(bounds.rotation_deg).toBe(0);
  });

  it('map 空间图例：原点走 §5.1、宽高按 s 缩放', () => {
    const item: LegendItem = { ...firstOf('legend'), space: 'map', x: 320, y: 240 };
    const placement = itemPlacement(item, scene, geo);
    const bounds = itemBoundsPt(item, scene, geo);
    expect(bounds.x).toBeCloseTo(placement.x, 10);
    expect(bounds.y).toBeCloseTo(placement.y, 10);
    expect(bounds.width).toBeCloseTo(item.width_pt * placement.scale, 10);
    expect(bounds.height).toBeCloseTo(
      legendLayout({ ...item, x: placement.x, y: placement.y }, placement.scale).height,
      10,
    );
  });

  it('色标：宽高都按 map 空间 s 缩放（与 §5.5 声明框一致）', () => {
    const item: ColorbarItem = { ...firstOf('colorbar'), space: 'map', x: 320, y: 240 };
    const placement = itemPlacement(item, scene, geo);
    const bounds = itemBoundsPt(item, scene, geo);
    expect(bounds.x).toBeCloseTo(placement.x, 10);
    expect(bounds.y).toBeCloseTo(placement.y, 10);
    expect(bounds.width).toBeCloseTo(item.width_pt * placement.scale, 10);
    expect(bounds.height).toBeCloseTo(item.height_pt * placement.scale, 10);
  });
});

describe('字体行盒回退口径', () => {
  it('无 canvas 时按字号 × 0.8em / 0.2em（浏览器用 CSS font 的 fontBoundingBox）', () => {
    expect(fallbackTextMeasure.ascent('10px sans-serif')).toBeCloseTo(8, 10);
    expect(fallbackTextMeasure.descent('10px sans-serif')).toBeCloseTo(2, 10);
    expect(fallbackTextMeasure.ascent('12px sans-serif')).toBeCloseTo(9.6, 10);
  });
});

/** 与 itemBoundsPt 内部一致的字体简写（item.font_family 优先，否则 scene.style） */
function fontOf(item: TextItem): string {
  return `${item.font_size_pt}px ${item.font_family ?? scene.style.font_family}`;
}
