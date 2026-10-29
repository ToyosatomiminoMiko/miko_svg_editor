/**
 * 浏览器内合成 final.svg：`PageDocument + layout → SVG 字符串 + report`（纯函数，node 可测）。
 *
 * 是什么：把底图根标签内的原文原样嵌进带 `clip-path` 的 `<g id="mapdoc-map">`，再按
 * `docs/PAGE-EDITOR.md` §6 的图层顺序拼出纸张、图框刻度、items 与 `mapdoc-final` marker；
 * 同时在 `<metadata id="mapdoc-source">` 写入「整份 geo.json 原文 + 底图前后缀」，让成品
 * 单文件就能被重新打开继续编辑（§6.2）。此外给出元素计数、越界告警与越界 item id（`report`）。
 * 为什么在 render 层而不是 core：输出是 SVG 字符串，要复用 `render/page-format.ts` 的数值/
 * 转义口径；排版几何仍全部来自 `core/page-layout.ts`（与 `render/page-svg.ts` 预览同一套公式）。
 * 确定性：不读 DOM、时间、随机数；同一 (base.inner, baseSha256, geo, layout) 输入两次得到同字节。
 * 与无后端改造前的合成实现相比：图层顺序、空组写法、marker 形状沿用其字节布局，但排版几何改由
 * page-layout 统一提供，所以不要求与旧输出逐字节一致；数值格式仍走 formatPageNumber。
 * 为什么 map group 必须 `clip-path`：底图根内自带覆盖整个 Figure 的图幅白底 path，预览用
 * `<image>` 天然只显示地图矩形，成品不裁剪会在非白纸色下把白底铺满整页（见 §6）。
 * 元信息：作者 compose，2026-10-28，无后端数据流（浏览器内导出成品）；
 *         2026-10-29 增加内嵌可编辑源 metadata（成品可再次编辑，见 core/final-svg.ts）。
 */

import {
  PAGE_FINAL_MARKER_VERSION,
  PAGE_FINAL_SOURCE_FORMAT,
  PAGE_FINAL_SOURCE_VERSION,
} from '../config/page';
import { encodeBase64Utf8 } from '../core/base64';
import type { PageDocument } from '../core/document';
import {
  canonicalJson,
  geoDigest,
  normalizePage,
  pageDigest,
  serializeMapDocFile,
  type ColorbarItem,
  type Geo,
  type GeoRelief,
  type LegendEntry,
  type LegendItem,
  type PageItem,
  type PageLayout,
  type TextItem,
} from '../core/page';
import {
  colorbarLayout,
  frameTickLayout,
  itemPlacement,
  legendLayout,
  mapHeightPt,
  mapTransform,
  textLayout,
} from '../core/page-layout';
import {
  colorbarGradientId,
  dashArray,
  escapeXmlAttribute,
  escapeXmlText,
  formatPageNumber,
  gradientOffset,
  opacityValue,
} from './page-format';

/* =========================== 对外类型（spec §2 契约） =========================== */

/** report 里的元素计数：四种键固定出现（0 也写） */
export interface ComposeCounts {
  readonly text: number;
  readonly legend: number;
  readonly colorbar: number;
  readonly total: number;
}

/** 合成报告：越界只告警，不阻止导出（纸张外的内容会被裁掉） */
export interface ComposeReport {
  readonly counts: ComposeCounts;
  readonly warnings: readonly string[];
  readonly out_of_paper: readonly number[];
}

/** 合成结果：成品字节与报告 */
export interface ComposeResult {
  readonly svg: string;
  readonly report: ComposeReport;
}

/** 越界判定容差：恰好压在纸张边界上不算越界（与预览的判定口径同值） */
const BBOX_EPS = 1e-6;
/** 五角星内半径 ÷ 外接半径 = (3-√5)/2 ≈ 0.381966（matplotlib 五角星比例，预览同值） */
const STAR_INNER_RATIO = (3 - Math.sqrt(5)) / 2;

/** 数字 → SVG 文本（统一走 page-format，成品与预览同一口径） */
const num = (value: number): string => formatPageNumber(value);
/** 属性值转义（颜色/字体栈里可能有引号或 &） */
const attr = (value: string): string => escapeXmlAttribute(value);
/** 文本节点转义（用户输入可能含 & < >） */
const text = (value: string): string => escapeXmlText(value);

/* =========================== 图层与基础元素 =========================== */

/**
 * 图层组包装：空组也保留（`<g id="mapdoc-frame"></g>`），让成品图层结构稳定、便于 diff。
 * 换行布局固定：子元素各占一行、组内不加缩进（确定性字节的一部分）。
 */
function group(id: string, children: readonly string[]): string {
  if (children.length === 0) return `<g id="${id}"></g>`;
  return `<g id="${id}">\n${children.join('\n')}\n</g>`;
}

interface TextElementOptions {
  readonly anchor: string;
  readonly family: string;
  readonly fontSize: number;
  readonly fill: string;
  readonly italic: boolean;
  readonly bold: boolean;
  /** 非 null 时这是 halo 副本：fill/stroke 都用光晕色并带 paint-order=stroke */
  readonly halo: { readonly color: string; readonly width_pt: number } | null;
}

/**
 * 一个 `<text>` 元素（§5.3）。
 * 属性顺序沿用旧 compose：x/y → text-anchor → font-family → font-size → 字重/斜体 → fill →
 * halo 的 stroke/stroke-width/paint-order。halo 副本同时填光晕色，才能在浅色底图上描边。
 */
function textElement(x: number, y: number, value: string, options: TextElementOptions): string {
  const attributes = [
    `x="${num(x)}"`,
    `y="${num(y)}"`,
    `text-anchor="${options.anchor}"`,
    `font-family="${attr(options.family)}"`,
    `font-size="${num(options.fontSize)}"`,
  ];
  if (options.italic) attributes.push('font-style="italic"');
  if (options.bold) attributes.push('font-weight="bold"');
  attributes.push(`fill="${attr(options.fill)}"`);
  if (options.halo !== null) {
    attributes.push(`stroke="${attr(options.halo.color)}"`);
    attributes.push(`stroke-width="${num(options.halo.width_pt)}"`);
    attributes.push('paint-order="stroke"');
  }
  return `<text ${attributes.join(' ')}>${text(value)}</text>`;
}

/* =========================== text（§5.3） =========================== */

/**
 * 一个 text item：逐行基线 `y = py + i*font_size*line_height`（由 textLayout 提供）。
 * 为什么 halo 行全部先画：与预览 haloGroup→fillGroup 的层序一致，多行时不会出现
 * 「上一行 halo 盖住下一行填充」的视觉差（单行时两种顺序等价）。
 * 多行整体绕第一行锚点旋转；不旋转时直接输出各行（与旧 compose 相同，不额外包组）。
 */
function renderTextItem(item: TextItem, layout: PageLayout, geo: Geo): string[] {
  const text = textLayout(item, geo, layout);
  const family = item.font_family ?? layout.style.font_family;
  const haloChildren: string[] = [];
  const fillChildren: string[] = [];
  for (const line of text.lines) {
    if (item.halo !== null) {
      haloChildren.push(
        textElement(text.px, line.y, line.text, {
          anchor: item.anchor,
          family,
          fontSize: item.font_size_pt,
          fill: item.halo.color,
          italic: item.italic,
          bold: item.bold,
          halo: item.halo,
        }),
      );
    }
    fillChildren.push(
      textElement(text.px, line.y, line.text, {
        anchor: item.anchor,
        family,
        fontSize: item.font_size_pt,
        fill: item.color,
        italic: item.italic,
        bold: item.bold,
        halo: null,
      }),
    );
  }
  const children = [...haloChildren, ...fillChildren];
  if (item.rotation_deg !== 0) {
    return [
      `<g transform="rotate(${num(item.rotation_deg)} ${num(text.px)} ${num(text.py)})">`,
      ...children,
      '</g>',
    ];
  }
  return children;
}

/* =========================== legend（§5.4） =========================== */

/** 图例线/矩形共用的描边属性（stroke/dash 为 null 时不写属性，与旧 compose 一致） */
function legendStrokeAttributes(entry: LegendEntry): string[] {
  const attributes: string[] = [];
  if (entry.stroke !== null) {
    attributes.push(`stroke="${attr(entry.stroke)}"`);
    attributes.push(`stroke-width="${num(entry.width_pt)}"`);
  }
  const dash = dashArray(entry.dash);
  if (dash !== undefined) attributes.push(`stroke-dasharray="${dash}"`);
  return attributes;
}

/** 五角星顶点：外点 -90°+k*72°，内点半径 outer*(3-√5)/2（预览同几何） */
function starPoints(cx: number, cy: number, outer: number): string {
  const inner = outer * STAR_INNER_RATIO;
  const points: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    const radius = index % 2 === 0 ? outer : inner;
    const angle = -Math.PI / 2 + index * (Math.PI / 5);
    points.push(`${num(cx + radius * Math.cos(angle))},${num(cy + radius * Math.sin(angle))}`);
  }
  return points.join(' ');
}

/** point 形状的标记：star/square/circle（半径/边长按 §5.4，单位 pt） */
function pointMarker(entry: LegendEntry, cx: number, cy: number, fontSize: number): string {
  // fill 取条目 fill，缺省时退到 stroke（只描边的点也有可见填充）；都为空则 none。
  const fill = entry.fill ?? entry.stroke;
  const attributes: string[] = [fill === null ? 'fill="none"' : `fill="${attr(fill)}"`];
  if (entry.stroke !== null) {
    attributes.push(`stroke="${attr(entry.stroke)}"`);
    attributes.push(`stroke-width="${num(entry.width_pt)}"`);
  }
  attributes.push(`opacity="${opacityValue(entry.opacity)}"`);
  const suffix = attributes.join(' ');
  switch (entry.marker ?? 'circle') {
    case 'star': {
      return `<polygon points="${starPoints(cx, cy, fontSize * 0.55)}" ${suffix}/>`;
    }
    case 'square': {
      const side = fontSize * 0.7;
      return (
        `<rect x="${num(cx - side / 2)}" y="${num(cy - side / 2)}" ` +
        `width="${num(side)}" height="${num(side)}" ${suffix}/>`
      );
    }
    case 'circle':
      return `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(fontSize * 0.35)}" ${suffix}/>`;
  }
}

/** 一个 legend item：底板、标题、逐行 swatch+label；高度由 §5.4 公式派生（不落 layout） */
function renderLegendItem(item: LegendItem, layout: PageLayout, geo: Geo): string[] {
  const placement = itemPlacement(item, layout, geo);
  // 只有宽度随 map 空间缩放；字号/行高/padding 是 pt，不随底图缩放（legendLayout 同口径）。
  const effective: LegendItem = { ...item, x: placement.x, y: placement.y };
  const legend = legendLayout(effective, placement.scale);
  const width = item.width_pt * placement.scale;
  const children: string[] = [];
  const frame = item.frame;
  if (frame.show) {
    // 底板透明度是 fill-opacity，只影响白底不影响描边（与预览一致）。
    children.push(
      `<rect x="${num(placement.x)}" y="${num(placement.y)}" ` +
        `width="${num(width)}" height="${num(legend.height)}" ` +
        `fill="${attr(frame.fill)}" fill-opacity="${opacityValue(frame.opacity)}" ` +
        `stroke="${attr(frame.stroke)}" stroke-width="${num(frame.width_pt)}"/>`,
    );
  }
  if (item.title.length > 0) {
    children.push(
      textElement(legend.titleX, legend.titleBaseline, item.title, {
        anchor: 'middle',
        family: layout.style.font_family,
        fontSize: item.title_size_pt,
        fill: layout.style.color,
        italic: false,
        bold: false,
        halo: null,
      }),
    );
  }
  item.entries.forEach((entry, index) => {
    const row = legend.rows[index];
    if (row === undefined) return;
    switch (entry.shape) {
      case 'line': {
        const attributes = [
          `x1="${num(row.swatchX0)}"`,
          `y1="${num(row.centerY)}"`,
          `x2="${num(row.swatchX1)}"`,
          `y2="${num(row.centerY)}"`,
          ...legendStrokeAttributes(entry),
          `opacity="${opacityValue(entry.opacity)}"`,
        ];
        children.push(`<line ${attributes.join(' ')}/>`);
        break;
      }
      case 'rect': {
        const height = item.font_size_pt * 0.9;
        const fill = entry.fill ?? 'none';
        const attributes = [
          `fill="${attr(fill)}"`,
          ...legendStrokeAttributes(entry),
          `opacity="${opacityValue(entry.opacity)}"`,
        ];
        children.push(
          `<rect x="${num(row.swatchX0)}" y="${num(row.centerY - height / 2)}" ` +
            `width="${num(row.swatchX1 - row.swatchX0)}" height="${num(height)}" ` +
            `${attributes.join(' ')}/>`,
        );
        break;
      }
      case 'point':
        children.push(
          pointMarker(entry, (row.swatchX0 + row.swatchX1) / 2, row.centerY, item.font_size_pt),
        );
        break;
    }
    children.push(
      textElement(row.labelX, row.labelBaseline, entry.label, {
        anchor: 'start',
        family: layout.style.font_family,
        fontSize: item.font_size_pt,
        fill: layout.style.color,
        italic: false,
        bold: false,
        halo: null,
      }),
    );
  });
  return children;
}

/* =========================== colorbar（§5.5） =========================== */

/**
 * 一个 colorbar item：渐变矩形 + 标题 + 右侧刻度短线与标签。
 * 标题只在 show_title 且标题非空时画（§5.5「title（show_title）」）；单位后缀由
 * `colorbarTitleText` 统一补，避免标题里重复单位。
 */
function renderColorbarItem(
  item: ColorbarItem,
  layout: PageLayout,
  geo: Geo,
  relief: GeoRelief,
): string[] {
  const placement = itemPlacement(item, layout, geo);
  const effective: ColorbarItem = { ...item, x: placement.x, y: placement.y };
  const bar = colorbarLayout(effective, relief, placement.scale);
  const children: string[] = [];
  if (item.show_title && item.title.length > 0) {
    children.push(
      textElement(bar.titleX, bar.titleBaseline, bar.titleText, {
        anchor: 'middle',
        family: layout.style.font_family,
        fontSize: item.title_size_pt,
        fill: layout.style.color,
        italic: false,
        bold: false,
        halo: null,
      }),
    );
  }
  children.push(
    `<rect x="${num(placement.x)}" y="${num(placement.y)}" ` +
      `width="${num(bar.width)}" height="${num(bar.height)}" ` +
      `fill="url(#${colorbarGradientId(item.id)})"/>`,
  );
  for (const tick of bar.ticks) {
    children.push(
      `<line x1="${num(tick.x1)}" y1="${num(tick.ty)}" ` +
        `x2="${num(tick.x2)}" y2="${num(tick.ty)}" stroke="${attr(layout.style.color)}"/>`,
    );
    children.push(
      textElement(tick.labelX, tick.labelBaseline, num(tick.value), {
        anchor: 'start',
        family: layout.style.font_family,
        fontSize: item.label_size_pt,
        fill: layout.style.color,
        italic: false,
        bold: false,
        halo: null,
      }),
    );
  }
  return children;
}

/* =========================== 图框/刻度（§5.2） =========================== */

/** 图框矩形 + 刻度短线 + 刻度文字；frame.show/ticks 关闭时对应部分为空 */
function renderFrame(layout: PageLayout, geo: Geo): string {
  const children: string[] = [];
  const { frame, map } = layout;
  const height = mapHeightPt(geo, map);
  if (frame.show) {
    children.push(
      `<rect x="${num(map.x)}" y="${num(map.y)}" width="${num(map.width_pt)}" ` +
        `height="${num(height)}" fill="none" stroke="${attr(frame.stroke)}" ` +
        `stroke-width="${num(frame.width_pt)}"/>`,
    );
  }
  if (frame.ticks) {
    for (const tick of frameTickLayout(layout, geo)) {
      children.push(
        `<line x1="${num(tick.x1)}" y1="${num(tick.y1)}" ` +
          `x2="${num(tick.x2)}" y2="${num(tick.y2)}" stroke="${attr(frame.tick_color)}" ` +
          // 与旧 compose 一致：刻度短线线宽取 frame.width_pt（不是 SVG 默认 1）
          `stroke-width="${num(frame.width_pt)}"/>`,
      );
      children.push(
        textElement(tick.textX, tick.textY, tick.label, {
          anchor: tick.anchor,
          family: layout.style.font_family,
          fontSize: frame.tick_font_size_pt,
          fill: frame.tick_color,
          italic: false,
          bold: false,
          halo: null,
        }),
      );
    }
  }
  return group('mapdoc-frame', children);
}

/* =========================== defs（底图裁剪 + 色标渐变） =========================== */

/**
 * `<defs>`：第一项固定是 `mapdoc-map-clip`（把底图裁剪到地图框），之后是 colorbar 渐变。
 *
 * 为什么必须裁剪：Cartopy 底图根标签内自带 matplotlib 的图幅白底（`patch_1` path 覆盖
 * 整个原始 Figure），原样内联后会溢出地图矩形铺满整页；默认白纸看不出，但
 * `layout.style.paper_color` 非白时成品与预览（`<image>` 天然按地图矩形裁剪）明显不一致。
 * 为什么 rect 用 `geo.base.view_box`：map group 的 transform 已把底图坐标映射到纸面，
 * 局部坐标系里地图框就是 viewBox，clip 后与预览的裁剪范围逐点一致。
 * 为什么 defs 始终输出：即使没有 colorbar 也需要 clipPath；固定结构也让成品可 diff。
 */
function renderDefs(layout: PageLayout, geo: Geo, relief: GeoRelief | null): string {
  const [viewX = 0, viewY = 0, viewWidth = 0, viewHeight = 0] = geo.base.view_box;
  const clipPath =
    '<clipPath id="mapdoc-map-clip">' +
    `<rect x="${num(viewX)}" y="${num(viewY)}" ` +
    `width="${num(viewWidth)}" height="${num(viewHeight)}"/>` +
    '</clipPath>';
  const gradients: string[] = [];
  for (const item of layout.items) {
    if (item.kind !== 'colorbar') continue;
    // 调用方已保证「有 colorbar ⇒ relief 非 null」；这里再判一次是为了类型收窄。
    if (relief === null) throw new Error('色标需要 geo.relief');
    const stops = relief.stops.map(
      (stop) => `<stop offset="${gradientOffset(stop.offset)}" stop-color="${attr(stop.color)}"/>`,
    );
    gradients.push(
      `<linearGradient id="${colorbarGradientId(item.id)}" ` +
        'x1="0" y1="100%" x2="0" y2="0%">\n' +
        `${stops.join('\n')}\n</linearGradient>`,
    );
  }
  // 顺序是契约：clipPath 在前、渐变在后（同一 defs 里，便于对照与 diff）。
  return `<defs>\n${[clipPath, ...gradients].join('\n')}\n</defs>`;
}

/* =========================== 越界分析与计数 =========================== */

/** 元素在纸张坐标里的近似包围盒（文字按锚点、不含旋转/字宽，只用于越界告警） */
function itemBBox(
  item: PageItem,
  layout: PageLayout,
  geo: Geo,
): readonly [number, number, number, number] {
  switch (item.kind) {
    case 'text': {
      const text = textLayout(item, geo, layout);
      return [text.px, text.py, text.px, text.py];
    }
    case 'legend': {
      const placement = itemPlacement(item, layout, geo);
      const legendBox = legendLayout({ ...item, x: placement.x, y: placement.y }, placement.scale);
      const width = item.width_pt * placement.scale;
      return [placement.x, placement.y, placement.x + width, placement.y + legendBox.height];
    }
    case 'colorbar': {
      const placement = itemPlacement(item, layout, geo);
      return [
        placement.x,
        placement.y,
        placement.x + item.width_pt * placement.scale,
        placement.y + item.height_pt * placement.scale,
      ];
    }
  }
}

/** 越界 item id（按 items 顺序）与中文告警；只提示不拒绝（§4） */
function analyze(
  layout: PageLayout,
  geo: Geo,
): { readonly out_of_paper: number[]; readonly warnings: string[] } {
  const paperWidth = layout.paper.width_pt;
  const paperHeight = layout.paper.height_pt;
  const outOfPaper: number[] = [];
  const warnings: string[] = [];
  for (const item of layout.items) {
    const [minX, minY, maxX, maxY] = itemBBox(item, layout, geo);
    if (
      minX < -BBOX_EPS ||
      minY < -BBOX_EPS ||
      maxX > paperWidth + BBOX_EPS ||
      maxY > paperHeight + BBOX_EPS
    ) {
      outOfPaper.push(item.id);
      warnings.push(`item ${item.id}(${item.kind}) 超出纸张范围，成品里可能被裁掉`);
    }
  }
  // §4: map.x/y 只要求有限，越界是告警而不是错误——成品里地图会被纸张裁掉。
  const height = mapHeightPt(geo, layout.map);
  if (
    layout.map.x < -BBOX_EPS ||
    layout.map.y < -BBOX_EPS ||
    layout.map.x + layout.map.width_pt > paperWidth + BBOX_EPS ||
    layout.map.y + height > paperHeight + BBOX_EPS
  ) {
    warnings.push('地图超出纸张范围（成品会被裁切，仅告警）');
  }
  return { out_of_paper: outOfPaper, warnings };
}

/** 元素计数：四种键固定出现（0 也写），供 report 与 marker 共用 */
function countItems(items: readonly PageItem[]): ComposeCounts {
  let textCount = 0;
  let legendCount = 0;
  let colorbarCount = 0;
  for (const item of items) {
    switch (item.kind) {
      case 'text':
        textCount += 1;
        break;
      case 'legend':
        legendCount += 1;
        break;
      case 'colorbar':
        colorbarCount += 1;
        break;
    }
  }
  return { text: textCount, legend: legendCount, colorbar: colorbarCount, total: items.length };
}

/* =========================== marker 与内嵌可编辑源 =========================== */

/**
 * final marker：`<!-- mapdoc-final:BASE64(canonicalJson(payload)) -->`（§6.1）。
 * 为什么用 base64 包 JSON：XML 注释里不能出现 `--`，而 JSON 文本完全可能。
 */
function makeMarker(counts: ComposeCounts, geo: Geo, layout: PageLayout): string {
  const payload = {
    counts: {
      colorbar: counts.colorbar,
      legend: counts.legend,
      text: counts.text,
      total: counts.total,
    },
    geo: geoDigest(geo),
    page: pageDigest(layout),
    version: PAGE_FINAL_MARKER_VERSION,
  };
  return `<!-- mapdoc-final:${encodeBase64Utf8(canonicalJson(payload))} -->`;
}

/**
 * 内嵌可编辑源：`<metadata id="mapdoc-source">BASE64(canonicalJson(payload))</metadata>`（§6.2）。
 *
 * payload = 整份 geo.json 原文（`serializeMapDocFile(geo, layout)` 的字节）+ 底图 `prefix`/`suffix`
 * + 还原后的底图摘要 `base.sha256` 与来源标志 `base.exact`。
 * 为什么把 geo.json 原文整段放进 metadata：重新打开时排版与地理块都来自同一次导出的字节，
 * 「导出 → 重新打开 → 再导出」可以做到字节幂等，不需要从渲染结果反推排版。
 * 为什么底图只存前后缀：`inner` 已在 `mapdoc-map` 组内，前后缀只有几十字节；
 * 两者首尾相接就能逐字节还原底图，让 `geo.base.sha256` 继续成立。
 * 为什么还要 `exact`：旧版成品迁移时底图外壳是合成的（字节与原 base.svg 不同），
 * 重开时不能再拿 `geo.base.sha256` 校验，只能对照内嵌的 `base.sha256`。
 */
function makeSourceMetadata(document: PageDocument, layout: PageLayout): string {
  const baseSha256 = document.baseSha256.toLowerCase();
  const exact = baseSha256 === document.geo.base.sha256.toLowerCase();
  const payload = {
    base: {
      prefix: document.base.prefix,
      suffix: document.base.suffix,
      sha256: baseSha256,
      exact,
    },
    document: serializeMapDocFile(document.geo, layout),
    format: PAGE_FINAL_SOURCE_FORMAT,
    version: PAGE_FINAL_SOURCE_VERSION,
  };
  return `<metadata id="mapdoc-source">${encodeBase64Utf8(canonicalJson(payload))}</metadata>\n`;
}

/* =========================== 合成入口 =========================== */

/**
 * 合成 final.svg。
 *
 * 结构见 `docs/PAGE-EDITOR.md` §6：纸张底色 → `<defs>`（mapdoc-map-clip + 可选色标渐变）
 * → `mapdoc-map`（底图原文，按 clip 裁剪到地图框）→ `mapdoc-frame` → `mapdoc-overlay`
 * （items 按数组序）→ marker → `</svg>`。
 *
 * 为什么先 `normalizePage`：digest 与渲染都必须只接受契约字段 + 3 位小数，
 * 避免同一语义出现多种字节；layout 合法性由编辑器保证（新建/导入时已校验）。
 * `geo.relief` 为 null 而 layout 里仍有 colorbar 时抛 `Error('色标需要 geo.relief')`：
 * 这种 layout 无法画出有意义的色标，静默跳过会让成品与预览不一致。
 */
export function composeFinalSvg(document: PageDocument, layout: PageLayout): ComposeResult {
  if (document.base.errors.length > 0) {
    throw new Error(`底图未通过契约检查，无法合成 final.svg：${document.base.errors.join('；')}`);
  }
  const normalized = normalizePage(layout);
  const geo = document.geo;
  const relief = geo.relief;
  if (relief === null && normalized.items.some((item) => item.kind === 'colorbar')) {
    throw new Error('色标需要 geo.relief');
  }

  const paper = normalized.paper;
  const widthText = num(paper.width_pt);
  const heightText = num(paper.height_pt);
  const transform = mapTransform(geo, normalized.map);

  // §6 文件头与纸张底色；根 svg 宽高带 pt 单位、viewBox 用无单位用户坐标（1 单位 = 1pt）。
  const head =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ' +
    `width="${widthText}pt" height="${heightText}pt" ` +
    `viewBox="0 0 ${widthText} ${heightText}" version="1.1">\n` +
    `<rect x="0" y="0" width="${widthText}" height="${heightText}" ` +
    `fill="${attr(normalized.style.paper_color)}"/>\n`;
  const defs = renderDefs(normalized, geo, relief);
  // clip-path 引用同一 defs 里的 mapdoc-map-clip：底图局部坐标（viewBox）之外的内容
  // （matplotlib 图幅白底等）不会画到纸面上，与预览 <image> 的裁剪范围一致。
  const mapOpen =
    '<g id="mapdoc-map" clip-path="url(#mapdoc-map-clip)" ' +
    `transform="translate(${num(transform.tx)},${num(transform.ty)}) ` +
    `scale(${num(transform.s)})">`;
  const frame = renderFrame(normalized, geo);
  const overlayChildren = normalized.items.map((item) => {
    switch (item.kind) {
      case 'text':
        return renderTextItem(item, normalized, geo);
      case 'legend':
        return renderLegendItem(item, normalized, geo);
      case 'colorbar':
        // 上面已保证 relief 非 null；这里再判一次只为类型收窄。
        if (relief === null) throw new Error('色标需要 geo.relief');
        return renderColorbarItem(item, normalized, geo, relief);
    }
  });
  const overlay = group('mapdoc-overlay', overlayChildren.flat());

  const { out_of_paper: outOfPaper, warnings } = analyze(normalized, geo);
  const counts = countItems(normalized.items);
  const marker = makeMarker(counts, geo, normalized);

  // 图层顺序与空组写法沿用旧 compose：head 末尾已有换行；
  // metadata（内嵌可编辑源）紧跟纸张底色，defs 始终存在（含底图裁剪）。
  const parts = [
    head,
    makeSourceMetadata(document, normalized),
    `${defs}\n`,
    mapOpen,
    document.base.inner,
    '</g>\n',
    `${frame}\n`,
    `${overlay}\n`,
    marker,
    '\n</svg>\n',
  ];

  return {
    svg: parts.join(''),
    report: { counts, warnings, out_of_paper: outOfPaper },
  };
}
