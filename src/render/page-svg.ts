/**
 * 预览 SVG：`scene + geo → SVG DOM`（纸张白底、底图 `<image>`、图框/刻度、items）。
 *
 * 是什么：把 `docs/PAGE-EDITOR.md` §5 的布局公式落成浏览器里的 SVG 节点，供编辑器
 * 所见即所得预览。根 `<svg>` 的 `viewBox`（缩放/平移）由调用方（`app/page-editor.ts`）
 * 维护；本模块只维护根节点内部的分层与内容。
 * 为什么用 `document.createElementNS` 而不是拼字符串 / `innerHTML`：文本来自用户输入，
 * 只有文本节点（`textContent`）与属性写入两条路，天然不存在标签注入；同时保留
 * 底图 `<image>` 的惰性加载（重绘时复用同一个 image 节点，不闪烁）。
 * 预览与成品的差异只在「交互辅助」：命中矩形、选中虚线框只在预览出现，不参与成品。
 * 元信息：作者 frontend，2026-10-27，随 `docs/PAGE-EDITOR.md` 新契约落地。
 */

import { PAGE_SELECTION_DASH, PAGE_SELECTION_PAD_PT } from '../config/page';
import type {
  ColorbarItem,
  Geo,
  LegendEntry,
  LegendItem,
  PageItem,
  Scene,
  TextItem,
} from '../core/page';
import {
  colorbarLayout,
  frameTickLayout,
  fontShorthand,
  legendLayout,
  mapHeightPt,
  mapPointToPage,
  mapTransform,
  textLayout,
} from '../core/page-layout';
import type { MeasureText } from '../core/types';
import {
  colorbarGradientId,
  colorValue,
  dashArray,
  fontSizeValue,
  formatPageNumber,
  gradientOffset,
  opacityValue,
} from './page-format';

/* =========================== 选项与分层 =========================== */

export interface PageSvgOptions {
  /** 底图地址：上传底图字节的 objectURL（由 app/page-main.ts 创建并 revoke） */
  readonly baseUrl: string;
  /** 当前选中元素 id；null = 无选中 */
  readonly selectedId: number | null;
  /** 文本测量器：只用于预览命中矩形（不改变视觉） */
  readonly measureText?: MeasureText;
  /** 是否给元素挂命中标记；导出/静态预览可关掉 */
  readonly interactive?: boolean;
}

/** 根 SVG 内固定分层；重复渲染只更新内容，不复建底图 image */
interface PageLayers {
  readonly defs: SVGDefsElement;
  readonly paper: SVGRectElement;
  readonly baseImage: SVGImageElement;
  readonly frame: SVGGElement;
  readonly overlay: SVGGElement;
  readonly selection: SVGGElement;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const layersByRoot = new WeakMap<SVGSVGElement, PageLayers>();

/** 建一个 SVG 元素（几何/文本属性一律字符串） */
function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Readonly<Record<string, string | undefined>> = {},
  ...children: (Node | string)[]
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== undefined) element.setAttribute(name, value);
  }
  for (const child of children) {
    if (typeof child === 'string') element.append(document.createTextNode(child));
    else element.append(child);
  }
  return element;
}

/** 首次渲染时建层；根节点被外部替换时重建 */
function ensureLayers(root: SVGSVGElement): PageLayers {
  const cached = layersByRoot.get(root);
  if (cached && root.contains(cached.paper)) return cached;

  const defs = svg('defs', { class: 'page-defs' });
  const paper = svg('rect', { class: 'page-paper' });
  const baseImage = svg('image', { class: 'page-base-image', preserveAspectRatio: 'none' });
  const frame = svg('g', { class: 'page-frame' });
  const overlay = svg('g', { class: 'page-overlay' });
  const selection = svg('g', { class: 'page-selection' });
  root.replaceChildren(defs, paper, baseImage, frame, overlay, selection);

  const layers: PageLayers = { defs, paper, baseImage, frame, overlay, selection };
  layersByRoot.set(root, layers);
  return layers;
}

/* =========================== 文字（§5.3） =========================== */

interface TextVisualOptions {
  readonly fontFamily: string;
  readonly halo: boolean;
}

/** 一批文字行：`halo=true` 时用光晕样式（先描边后填充的副本） */
function createTextLines(
  item: TextItem,
  layout: { readonly px: number; readonly py: number },
  style: { readonly anchor: string; readonly color: string },
  options: TextVisualOptions,
): SVGTextElement[] {
  const fontFamily = item.font_family ?? options.fontFamily;
  const step = item.font_size_pt * item.line_height;
  return item.lines.map((line, index) => {
    const attributes: Record<string, string> = {
      x: formatPageNumber(layout.px),
      y: formatPageNumber(layout.py + index * step),
      'font-size': fontSizeValue(item.font_size_pt),
      'font-family': fontFamily,
      'text-anchor': style.anchor,
      fill: style.color,
    };
    if (options.halo) {
      attributes.fill = item.halo?.color ?? style.color;
      attributes.stroke = item.halo?.color ?? style.color;
      attributes['stroke-width'] = formatPageNumber(item.halo?.width_pt ?? 0);
      attributes['paint-order'] = 'stroke';
    }
    if (item.italic) attributes['font-style'] = 'italic';
    if (item.bold) attributes['font-weight'] = 'bold';
    return svg('text', attributes, line);
  });
}

/** 文字命中矩形：只用于预览点选（不参与成品） */
function createTextHitBox(
  item: TextItem,
  layout: ReturnType<typeof textLayout>,
  measure: MeasureText,
  fontFamily: string,
): SVGRectElement {
  const width = Math.max(
    1,
    ...item.lines.map((line) =>
      measure(line, fontShorthand(item.font_size_pt, item.font_family ?? fontFamily)),
    ),
  );
  const step = item.font_size_pt * item.line_height;
  const top = layout.py - item.font_size_pt * 0.8;
  const bottom = layout.py + (item.lines.length - 1) * step + item.font_size_pt * 0.25;
  const left =
    item.anchor === 'start'
      ? layout.px
      : item.anchor === 'end'
        ? layout.px - width
        : layout.px - width / 2;
  return svg('rect', {
    x: formatPageNumber(left - PAGE_SELECTION_PAD_PT),
    y: formatPageNumber(top - PAGE_SELECTION_PAD_PT),
    width: formatPageNumber(width + PAGE_SELECTION_PAD_PT * 2),
    height: formatPageNumber(bottom - top + PAGE_SELECTION_PAD_PT * 2),
    fill: 'transparent',
    stroke: 'none',
    'pointer-events': 'all',
  });
}

/** 一个 text 元素（含光晕/旋转/命中） */
function renderTextItem(
  item: TextItem,
  scene: Scene,
  geo: Geo,
  options: PageSvgOptions,
): SVGGElement {
  const layout = textLayout(item, geo, scene);
  const group = svg('g', {
    class: 'page-item page-item-text',
    'data-page-item': String(item.id),
  });
  if (item.rotation_deg !== 0) {
    group.setAttribute(
      'transform',
      `rotate(${formatPageNumber(item.rotation_deg)} ${formatPageNumber(layout.px)} ${formatPageNumber(layout.py)})`,
    );
  }
  if (options.interactive !== false && options.measureText) {
    group.append(createTextHitBox(item, layout, options.measureText, scene.style.font_family));
  }
  const style = { anchor: item.anchor, color: item.color };
  if (item.halo) {
    const haloGroup = svg('g', { class: 'page-text-halo' });
    for (const line of createTextLines(item, layout, style, {
      fontFamily: scene.style.font_family,
      halo: true,
    })) {
      haloGroup.append(line);
    }
    group.append(haloGroup);
  }
  const fillGroup = svg('g', { class: 'page-text-fill' });
  for (const line of createTextLines(item, layout, style, {
    fontFamily: scene.style.font_family,
    halo: false,
  })) {
    fillGroup.append(line);
  }
  group.append(fillGroup);
  return group;
}

/* =========================== 图例（§5.4） =========================== */

/** 图例条目的一个色块（线/矩形/点标记） */
function createLegendSwatch(
  entry: LegendEntry,
  geometry: { readonly x0: number; readonly x1: number; readonly centerY: number },
  fontPt: number,
): SVGElement {
  const { x0, x1, centerY } = geometry;
  const y = formatPageNumber(centerY);
  const opacity = opacityValue(entry.opacity);
  const stroke = colorValue(entry.stroke);
  const fill = colorValue(entry.fill);
  switch (entry.shape) {
    case 'line': {
      const attributes: Record<string, string> = {
        x1: formatPageNumber(x0),
        y1: y,
        x2: formatPageNumber(x1),
        y2: y,
        stroke,
        'stroke-width': formatPageNumber(entry.width_pt),
        opacity,
      };
      const dash = dashArray(entry.dash);
      if (dash !== undefined) attributes['stroke-dasharray'] = dash;
      return svg('line', attributes);
    }
    case 'rect': {
      const height = fontPt * 0.9;
      const attributes: Record<string, string> = {
        x: formatPageNumber(x0),
        y: formatPageNumber(centerY - height / 2),
        width: formatPageNumber(x1 - x0),
        height: formatPageNumber(height),
        fill,
        stroke,
        'stroke-width': formatPageNumber(entry.width_pt),
        opacity,
      };
      return svg('rect', attributes);
    }
    case 'point': {
      const cx = (x0 + x1) / 2;
      const attributes: Record<string, string> = {
        fill,
        stroke,
        'stroke-width': formatPageNumber(entry.width_pt),
        opacity,
      };
      switch (entry.marker ?? 'circle') {
        case 'star': {
          const outer = fontPt * 0.55;
          const inner = outer * ((3 - Math.sqrt(5)) / 2);
          const points: string[] = [];
          for (let index = 0; index < 10; index += 1) {
            const radius = index % 2 === 0 ? outer : inner;
            const angle = ((-90 + index * 36) * Math.PI) / 180;
            points.push(
              `${formatPageNumber(cx + radius * Math.cos(angle))},${formatPageNumber(centerY + radius * Math.sin(angle))}`,
            );
          }
          return svg('polygon', { ...attributes, points: points.join(' ') });
        }
        case 'square': {
          const side = fontPt * 0.7;
          return svg('rect', {
            ...attributes,
            x: formatPageNumber(cx - side / 2),
            y: formatPageNumber(centerY - side / 2),
            width: formatPageNumber(side),
            height: formatPageNumber(side),
          });
        }
        case 'circle':
          return svg('circle', {
            ...attributes,
            cx: formatPageNumber(cx),
            cy: y,
            r: formatPageNumber(fontPt * 0.35),
          });
      }
    }
  }
}

/** 一个 legend 元素；`sizeScale` 只用于 map 空间（宽度乘 s，其余保持 pt） */
function renderLegendItem(
  item: LegendItem,
  scene: Scene,
  geo: Geo,
  options: PageSvgOptions,
): SVGGElement {
  const transform = mapTransform(geo, scene.map);
  const sizeScale = item.space === 'map' ? transform.s : 1;
  const origin = item.space === 'map' ? mapPointToPage(transform, item) : { x: 0, y: 0 };
  const effective: LegendItem = item.space === 'map' ? { ...item, x: origin.x, y: origin.y } : item;
  const layout = legendLayout(effective, sizeScale);
  const width = item.width_pt * sizeScale;

  const group = svg('g', {
    class: 'page-item page-item-legend',
    'data-page-item': String(item.id),
  });
  if (item.frame.show) {
    group.append(
      svg('rect', {
        x: formatPageNumber(effective.x),
        y: formatPageNumber(effective.y),
        width: formatPageNumber(width),
        height: formatPageNumber(layout.height),
        fill: item.frame.fill,
        'fill-opacity': opacityValue(item.frame.opacity),
        stroke: item.frame.stroke,
        'stroke-width': formatPageNumber(item.frame.width_pt),
      }),
    );
  }
  if (item.title.length > 0) {
    group.append(
      svg(
        'text',
        {
          x: formatPageNumber(layout.titleX),
          y: formatPageNumber(layout.titleBaseline),
          'font-size': fontSizeValue(item.title_size_pt),
          'font-family': scene.style.font_family,
          'text-anchor': 'middle',
          fill: scene.style.color,
        },
        item.title,
      ),
    );
  }
  item.entries.forEach((entry, index) => {
    const row = layout.rows[index];
    if (!row) return;
    group.append(
      createLegendSwatch(
        entry,
        { x0: row.swatchX0, x1: row.swatchX1, centerY: row.centerY },
        item.font_size_pt,
      ),
    );
    group.append(
      svg(
        'text',
        {
          x: formatPageNumber(row.labelX),
          y: formatPageNumber(row.labelBaseline),
          'font-size': fontSizeValue(item.font_size_pt),
          'font-family': scene.style.font_family,
          'text-anchor': 'start',
          fill: scene.style.color,
        },
        entry.label,
      ),
    );
  });
  // 预览命中区：图例通常只有描边，直接点空白列也要能选中
  if (options.interactive !== false) {
    group.append(
      svg('rect', {
        x: formatPageNumber(effective.x),
        y: formatPageNumber(effective.y),
        width: formatPageNumber(width),
        height: formatPageNumber(layout.height),
        fill: 'transparent',
        stroke: 'none',
        'pointer-events': 'all',
      }),
    );
  }
  return group;
}

/* =========================== 色标（§5.5） =========================== */

/** 一个 colorbar 元素；渐变定义写在根 `<defs>` 里（id 按契约固定） */
function renderColorbarItem(
  item: ColorbarItem,
  scene: Scene,
  geo: Geo,
  options: PageSvgOptions,
): SVGGElement {
  const transform = mapTransform(geo, scene.map);
  const sizeScale = item.space === 'map' ? transform.s : 1;
  const origin = item.space === 'map' ? mapPointToPage(transform, item) : { x: 0, y: 0 };
  const effective: ColorbarItem =
    item.space === 'map' ? { ...item, x: origin.x, y: origin.y } : item;

  const group = svg('g', {
    class: 'page-item page-item-colorbar',
    'data-page-item': String(item.id),
  });
  // geo 没有 relief（Cartopy 不画色标）时，scene 里残留的 colorbar 无法取色带/刻度：
  // 直接跳过该元素而不是让预览崩溃（导出 composeFinalSvg 会给出明确错误）。
  const relief = geo.relief;
  if (relief === null) return group;
  const layout = colorbarLayout(effective, relief, sizeScale);

  group.append(
    svg('rect', {
      x: formatPageNumber(effective.x),
      y: formatPageNumber(effective.y),
      width: formatPageNumber(layout.width),
      height: formatPageNumber(layout.height),
      fill: `url(#${colorbarGradientId(item.id)})`,
      stroke: 'none',
    }),
  );
  if (item.show_title) {
    group.append(
      svg(
        'text',
        {
          x: formatPageNumber(layout.titleX),
          y: formatPageNumber(layout.titleBaseline),
          'font-size': fontSizeValue(item.title_size_pt),
          'font-family': scene.style.font_family,
          'text-anchor': 'middle',
          fill: scene.style.color,
        },
        layout.titleText,
      ),
    );
  }
  for (const tick of layout.ticks) {
    group.append(
      svg('line', {
        x1: formatPageNumber(tick.x1),
        y1: formatPageNumber(tick.ty),
        x2: formatPageNumber(tick.x2),
        y2: formatPageNumber(tick.ty),
        stroke: scene.style.color,
      }),
    );
    group.append(
      svg(
        'text',
        {
          x: formatPageNumber(tick.labelX),
          y: formatPageNumber(tick.labelBaseline),
          'font-size': fontSizeValue(item.label_size_pt),
          'font-family': scene.style.font_family,
          'text-anchor': 'start',
          fill: scene.style.color,
        },
        formatPageNumber(tick.value),
      ),
    );
  }
  if (options.interactive !== false) {
    group.append(
      svg('rect', {
        x: formatPageNumber(effective.x),
        y: formatPageNumber(effective.y),
        width: formatPageNumber(layout.width),
        height: formatPageNumber(layout.height),
        fill: 'transparent',
        stroke: 'none',
        'pointer-events': 'all',
      }),
    );
  }
  return group;
}

/* =========================== 图框/刻度（§5.2） =========================== */

/** 图框矩形 + 刻度短线 + 刻度文字 */
function renderFrame(layer: SVGGElement, scene: Scene, geo: Geo, fontFamily: string): void {
  const children: SVGElement[] = [];
  const { frame, map } = scene;
  const height = mapHeightPt(geo, map);
  if (frame.show) {
    children.push(
      svg('rect', {
        class: 'page-frame-rect',
        x: formatPageNumber(map.x),
        y: formatPageNumber(map.y),
        width: formatPageNumber(map.width_pt),
        height: formatPageNumber(height),
        fill: 'none',
        stroke: frame.stroke,
        'stroke-width': formatPageNumber(frame.width_pt),
      }),
    );
  }
  if (frame.ticks) {
    for (const tick of frameTickLayout(scene, geo)) {
      children.push(
        svg('line', {
          class: 'page-frame-tick',
          x1: formatPageNumber(tick.x1),
          y1: formatPageNumber(tick.y1),
          x2: formatPageNumber(tick.x2),
          y2: formatPageNumber(tick.y2),
          stroke: frame.tick_color,
          // 与成品合成一致：刻度短线线宽取 frame.width_pt（不是 SVG 默认 1）
          'stroke-width': formatPageNumber(frame.width_pt),
        }),
        svg(
          'text',
          {
            class: 'page-frame-tick-label',
            x: formatPageNumber(tick.textX),
            y: formatPageNumber(tick.textY),
            'font-size': fontSizeValue(frame.tick_font_size_pt),
            'font-family': fontFamily,
            'text-anchor': tick.anchor,
            fill: frame.tick_color,
          },
          tick.label,
        ),
      );
    }
  }
  layer.replaceChildren(...children);
}

/* =========================== 渐变定义 =========================== */

/** colorbar 渐变（y1=100% 下 = vmin，y2=0% 上 = vmax，契约 §5.5） */
function renderGradientDefs(defs: SVGDefsElement, scene: Scene, geo: Geo): void {
  // 没有 relief 就没有可画的色带：清空 defs（预览跳过 colorbar，合成侧会报错）。
  const relief = geo.relief;
  if (relief === null) {
    defs.replaceChildren();
    return;
  }
  const gradients = scene.items
    .filter((item): item is ColorbarItem => item.kind === 'colorbar')
    .map((item) => {
      const stops = relief.stops.map((stop) =>
        svg('stop', {
          offset: gradientOffset(stop.offset),
          'stop-color': stop.color,
        }),
      );
      return svg(
        'linearGradient',
        {
          id: colorbarGradientId(item.id),
          x1: '0',
          y1: '100%',
          x2: '0',
          y2: '0%',
        },
        ...stops,
      );
    });
  defs.replaceChildren(...gradients);
}

/* =========================== 选中框 =========================== */

/** 选中元素的虚线外框：读实际渲染包围盒，避免为每种 kind 再写一份包围盒公式 */
function renderSelection(layer: SVGGElement, selectedId: number | null): void {
  layer.replaceChildren();
  if (selectedId === null) return;
  const root = layer.parentElement;
  const target = root?.querySelector<SVGGElement>(`[data-page-item="${selectedId}"]`);
  if (target === null || target === undefined) return;
  let box: DOMRect;
  try {
    box = target.getBBox();
  } catch {
    // 元素尚未布局（隐藏/未挂载）时没有包围盒：静默跳过选中框，不影响内容
    return;
  }
  layer.append(
    svg('rect', {
      class: 'page-selection-box',
      x: formatPageNumber(box.x - PAGE_SELECTION_PAD_PT),
      y: formatPageNumber(box.y - PAGE_SELECTION_PAD_PT),
      width: formatPageNumber(box.width + PAGE_SELECTION_PAD_PT * 2),
      height: formatPageNumber(box.height + PAGE_SELECTION_PAD_PT * 2),
      fill: 'none',
      'stroke-dasharray': PAGE_SELECTION_DASH,
      'vector-effect': 'non-scaling-stroke',
    }),
  );
}

/* =========================== 渲染入口 =========================== */

/**
 * 渲染整页到调用方提供的根 `<svg>`。
 *
 * 只改根节点内部；`viewBox`/尺寸由调用方控制。重复调用会复用 `<image>`（底图不重新请求），
 * 其余层按 scene 重建——编辑期每帧重建几十个节点，成本远小于一次重排。
 */
export function renderPageSvg(
  root: SVGSVGElement,
  scene: Scene,
  geo: Geo,
  options: PageSvgOptions,
): void {
  const layers = ensureLayers(root);

  layers.paper.setAttribute('x', '0');
  layers.paper.setAttribute('y', '0');
  layers.paper.setAttribute('width', formatPageNumber(scene.paper.width_pt));
  layers.paper.setAttribute('height', formatPageNumber(scene.paper.height_pt));
  layers.paper.setAttribute('fill', scene.style.paper_color);

  layers.baseImage.setAttribute('x', formatPageNumber(scene.map.x));
  layers.baseImage.setAttribute('y', formatPageNumber(scene.map.y));
  layers.baseImage.setAttribute('width', formatPageNumber(scene.map.width_pt));
  layers.baseImage.setAttribute('height', formatPageNumber(mapHeightPt(geo, scene.map)));
  layers.baseImage.setAttribute('href', options.baseUrl);
  layers.baseImage.setAttribute('preserveAspectRatio', 'none');

  renderFrame(layers.frame, scene, geo, scene.style.font_family);
  renderGradientDefs(layers.defs, scene, geo);

  const items = scene.items.map((item: PageItem) => {
    switch (item.kind) {
      case 'text':
        return renderTextItem(item, scene, geo, options);
      case 'legend':
        return renderLegendItem(item, scene, geo, options);
      case 'colorbar':
        return renderColorbarItem(item, scene, geo, options);
    }
  });
  layers.overlay.replaceChildren(...items);

  // 选中框必须挂查在 overlay 之后：此时 item 组已布局，getBBox 才有值
  renderSelection(layers.selection, options.selectedId);
}

/** 供编辑器/调试使用：拿到当前根节点的最内层元素组（不含命中矩形） */
export function pageSelectionBox(root: SVGSVGElement, id: number): DOMRect | null {
  const target = root.querySelector<SVGGElement>(`[data-page-item="${id}"]`);
  if (!target) return null;
  try {
    return target.getBBox();
  } catch {
    return null;
  }
}
