/**
 * 排版编辑器单测的共享 fixture：200×100 小底图 + 与之配套的 geo / PageDocument 工厂。
 *
 * 是什么：把 `tests/fixtures/base-200x100.svg`（旧 tools 测试的纯几何底图，621 字节）读成
 * 字符串，预先算好它的 sha256 与契约解析结果，并给出一份「含 legend/relief/suggestions」
 * 的小 geo 与 PageDocument 构造器。
 * 为什么单独一份：base-svg / page-geo / compose-svg 三个单测都要同一份底图与 geo，
 * 复制粘贴容易让三处数值漂移；这里只服务 node 单测，不进入产品构建。
 * 注意：geo.base.sha256 必须等于底图字节的 sha256（打开流程的一致性检查），所以运行时算，
 * 不写死常量。
 * 元信息：作者 compose，2026-10-28，无后端数据流（上传 base.svg + geo.json）。
 */

import baseSvgText from './base-200x100.svg?raw';
import { readBaseSvg } from '../../src/core/base-svg';
import type { PageDocument } from '../../src/core/document';
import { normalizeGeo, sha256OfBytes, type Geo } from '../../src/core/page';

/** 小底图原文（200×100pt，无 <text>，含 <defs>/clipPath/<style> 与一条 path） */
export const BASE_SVG_TEXT: string = baseSvgText;
/** 底图原始字节（打开流程里就是 File → ArrayBuffer 的这一步） */
export const BASE_BYTES: Uint8Array = new TextEncoder().encode(BASE_SVG_TEXT);
/** 底图字节的 sha256，用于 geo.base.sha256 与 marker 断言 */
export const BASE_SHA256: string = sha256OfBytes(BASE_BYTES);
/** 底图契约解析结果（errors 为空才允许打开） */
export const BASE_INFO = readBaseSvg(BASE_SVG_TEXT);
/**
 * 构造一份完整的 200×100 geo：2 条经度 + 2 条纬度刻度、2 个地名（含 halo/旋转/多行）、
 * 高程色标、5 种图例条目（line/rect/point×3 marker）、完整默认文案。
 * 每次调用返回新对象，测试可以放心改字段。
 */
export function makeGeo(): Geo {
  return {
    format: 'mapdoc-geo',
    version: 1,
    base: {
      sha256: BASE_SHA256,
      view_box: [0, 0, 200, 100],
      width_pt: 200,
      height_pt: 100,
    },
    graticule: {
      lon: [
        { value: 0, label: '0°', x: 20, y: 100, side: 'bottom' },
        { value: 90, label: '90°E', x: 180, y: 100, side: 'bottom' },
      ],
      lat: [
        { value: 0, label: '0°', x: 0, y: 20, side: 'left' },
        { value: 50, label: '50°N', x: 200, y: 80, side: 'right' },
      ],
      style: { stroke: '#808080', width_pt: 0.5, dash: [0.5, 0.825], opacity: 0.4 },
    },
    labels: [
      {
        id: 'label-country-A',
        kind: 'country',
        text: '甲国',
        lines: ['甲国'],
        x: 100,
        y: 50,
        rotation_deg: 0,
        anchor: 'middle',
        font_size_pt: 12,
        color: '#3a3a3a',
        italic: false,
        halo: { color: '#ffffff', width_pt: 3 },
        order: 0,
      },
      {
        id: 'label-river-B',
        kind: 'river',
        text: '乙河\n第二行',
        lines: ['乙河', '第二行'],
        x: 160,
        y: 80,
        rotation_deg: -30,
        anchor: 'start',
        font_size_pt: 9,
        color: '#335577',
        italic: true,
        halo: null,
        order: 1,
      },
    ],
    relief: {
      title: '高程',
      unit: 'm',
      vmin: -100,
      vmax: 100,
      stops: [
        { offset: 0, color: '#08306b' },
        { offset: 0.5, color: '#6baed6' },
        { offset: 1, color: '#ffffff' },
      ],
      ticks: [-100, 0, 100],
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
          label: '星标',
          shape: 'point',
          stroke: '#cc3333',
          width_pt: 0.6,
          dash: null,
          fill: '#cc3333',
          opacity: 1,
          marker: 'star',
        },
        {
          label: '方标',
          shape: 'point',
          stroke: '#3333cc',
          width_pt: 0.6,
          dash: [1, 1],
          fill: null,
          opacity: 1,
          marker: 'square',
        },
        {
          label: '圆标',
          shape: 'point',
          stroke: '#33cc33',
          width_pt: 0.6,
          dash: null,
          fill: '#33cc33',
          opacity: 1,
          marker: 'circle',
        },
      ],
    },
    suggestions: {
      title: '测试图',
      subtitle: '副标题文本',
      notes: [
        '注：这是一段用于验证折行的注记文字，长度需要超过右栏宽度，才会被折成多行写入 lines 数组。',
      ],
      source: '来源：fixture',
      area_annotation: ['区域注记'],
      legend_title: '',
      colorbar_title: '',
    },
  };
}

/** 把 geo 的某个可选块删掉（模拟老版 Cartopy 不写 legend/relief/suggestions 的产物） */
export function withoutBlocks(
  geo: Geo,
  keys: readonly ('legend' | 'relief' | 'suggestions')[],
): Geo {
  const cloned = structuredClone(geo) as unknown as Record<string, unknown>;
  for (const key of keys) delete cloned[key];
  return cloned as unknown as Geo;
}

/** 构造打开后的 PageDocument；geo 缺省用 `makeGeo()` 并走 normalizeGeo（模拟打开流程） */
export function makeDocument(geo: Geo = makeGeo()): PageDocument {
  return {
    baseFileName: 'fixture.svg',
    baseStem: 'fixture',
    baseBytes: BASE_BYTES,
    baseSha256: BASE_SHA256,
    base: BASE_INFO,
    geo: normalizeGeo(geo),
  };
}
