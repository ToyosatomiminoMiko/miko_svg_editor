/**
 * 分类文字样式的解析、批量应用与旧文件还原（纯逻辑，不碰 DOM）。
 *
 * 是什么：把「样式设置」窗口的 20 个分类（6 个页面文字角色 + 14 个地图地名角色）与排版块
 * 的 `page.text_style` 覆盖表、`TextItem` 的显式样式字段互相换算——读分类当前有效样式、
 * 写入覆盖并把该分类全部 item 同步一遍、恢复默认、给单条 item 套分类样式，以及打开旧文件
 * 时还原 `geo_label_id`。
 * 为什么放在 core：窗口（app/ui）、默认排版（core/page-layout）与打开迁移（core/open-map）
 * 必须共用同一套「默认值 + 覆盖」解析口径；各写一份会让「窗口显示的值」和「实际写进 item
 * 的值」漂移。默认值全部来自 `config/text-style.ts`，覆盖只落 `page.text_style`。
 * 为什么本文件不 import core/page-layout：默认排版要 import 本文件的解析函数，反向 import
 * 会形成 core 内部运行期环（架构检查会失败）；纸张比例 k 从 config/page 的
 * `layoutScaleForPaper` 取（唯一真源）。
 * 渲染层不感知覆盖表：每次应用都逐条把解析值写回 item 的显式字段（render/* 口径不变）。
 * 为什么地图分类的字号是「分类默认统一字号」而不是逐条地名字号：地图标注必须统一字号
 * （用户反馈），同一分类下的全部地名永远用同一个字号；窗口删掉了「跟随底图」开关后，默认值
 * 取该分类地名原始字号的中位数 × 地图缩放（见 `mapCategoryDefaultFontSizePt`）。
 * 元信息：作者 core-dev，2026-11-05，随「按分类统一设置文字样式」落地
 * （`.work/STYLE-SETTINGS-SPEC.md` §3；同日按 §12 修订：删除「跟随底图数据」模式，
 * 地图分类字号恒统一）。
 */

import { layoutScaleForPaper } from '../config/page';
import {
  MAP_LABEL_DEFAULT_FONT_SIZE_PT,
  MAP_LABEL_ROLE_STYLES,
  MAP_LABEL_STYLE,
  PAGE_TEXT_DEFAULT_FONT_SIZE_PT,
  PAGE_TEXT_STYLES,
  TEXT_STYLE_CATEGORY_META,
  isTextStyleCategoryId,
} from '../config/text-style';
import type { MapLabelRole, PageTextRole, TextStyleCategoryId } from '../config/text-style';
import type { Geo, GeoLabel, Halo, PageLayout, TextItem, TextStyleOverride } from './page';

/* =========================== 对外类型 =========================== */

/**
 * 写窗口用的一次补丁。
 * 为什么 `font_size_pt` 允许 null（与 `TextStyleOverride` 不同）：这是旧 UI/旧数据的兼容
 * 写法，语义等价于「删掉该覆盖键、回分类默认统一字号」，与「没传该字段（保持原覆盖）」不同。
 */
export interface TextStylePatch extends Omit<TextStyleOverride, 'font_size_pt'> {
  font_size_pt?: number | null;
}

/** 覆盖解析后的样式字段（不含字号：地图分类的字号要按每条 item 回算底图数据） */
export interface ResolvedTextStyleFields {
  readonly color: string;
  readonly italic: boolean;
  readonly font_weight: number;
  readonly letter_spacing_em: number;
  readonly line_height: number;
  readonly halo: Halo | null;
}

/** 分类的当前有效样式（样式设置窗口显示 / 批量应用共用） */
export interface ResolvedTextStyle extends ResolvedTextStyleFields {
  /** 有效字号：地图分类恒为该分类的统一字号（覆盖 ?? 分类默认统一字号），页面分类按角色口径 */
  readonly font_size_pt: number;
}

/* =========================== 默认值与覆盖解析 =========================== */

/** cloneHalo 的用途：解引用 geo/config 里的共享对象，避免 layout 与真源共享可变引用 */
function cloneHalo(halo: Halo | null): Halo | null {
  return halo === null ? null : { color: halo.color, width_pt: halo.width_pt };
}

/** 两个光晕是否等价（批应用时判断 item 是否真的被改到） */
function sameHalo(left: Halo | null, right: Halo | null): boolean {
  if (left === null || right === null) return left === right;
  return left.color === right.color && left.width_pt === right.width_pt;
}

/**
 * 某分类的代码默认样式（不含字号）。
 * 页面分类查 `PAGE_TEXT_STYLES`；地图分类 = 角色表颜色/斜体 + 全局常量
 * （字重/字距/行高/光晕），与 geo v2 生成口的样式口径逐字一致。
 * 防御分支：运行期传入未知地名角色（坏 geo 未经校验就进默认排版）时按 area 的样式兜底，
 * 与改造前 makeLabelItem 的回退口径一致。
 */
export function defaultTextStyleFields(category: TextStyleCategoryId): ResolvedTextStyleFields {
  const meta = TEXT_STYLE_CATEGORY_META[category];
  if (meta !== undefined && meta.kind === 'page') {
    const style = PAGE_TEXT_STYLES[category as PageTextRole];
    return {
      color: style.color,
      italic: style.italic,
      font_weight: style.font_weight,
      letter_spacing_em: style.letter_spacing_em,
      line_height: style.line_height,
      halo: cloneHalo(style.halo),
    };
  }
  const roleStyle = MAP_LABEL_ROLE_STYLES[category as MapLabelRole] ?? MAP_LABEL_ROLE_STYLES.area;
  return {
    color: roleStyle.color,
    italic: roleStyle.italic,
    font_weight: MAP_LABEL_STYLE.font_weight,
    letter_spacing_em: MAP_LABEL_STYLE.letter_spacing_em,
    line_height: MAP_LABEL_STYLE.line_height,
    halo: { color: MAP_LABEL_STYLE.halo_color, width_pt: MAP_LABEL_STYLE.halo_width_pt },
  };
}

/**
 * 合并覆盖与默认值：逐字段「覆盖 ?? 默认」。
 * `halo` 需要区分 undefined（用默认）与 null（显式关光晕），所以单独判断而不是 `??`。
 */
export function resolveTextStyleFields(
  category: TextStyleCategoryId,
  override: TextStyleOverride | undefined,
): ResolvedTextStyleFields {
  const base = defaultTextStyleFields(category);
  if (override === undefined) return base;
  return {
    color: override.color ?? base.color,
    italic: override.italic ?? base.italic,
    font_weight: override.font_weight ?? base.font_weight,
    letter_spacing_em: override.letter_spacing_em ?? base.letter_spacing_em,
    line_height: override.line_height ?? base.line_height,
    halo: override.halo === undefined ? base.halo : cloneHalo(override.halo),
  };
}

/** 覆盖表里该分类的字号覆盖（数字才算；null/缺省 = 用分类默认字号） */
function fontSizeOverrideOf(layout: PageLayout, category: TextStyleCategoryId): number | undefined {
  const value = layout.text_style[category]?.font_size_pt;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 分类是否被用户显式设过字号覆盖（窗口字段状态/测试用；不影响字号解析口径） */
export function hasFontSizeOverride(layout: PageLayout, category: TextStyleCategoryId): boolean {
  return fontSizeOverrideOf(layout, category) !== undefined;
}

/**
 * 分类默认字号（没有 item 时窗口显示用）。
 * 页面分类 = `PAGE_TEXT_DEFAULT_FONT_SIZE_PT[role]`：标题/副标题/注记/来源是默认排版里
 * 按纸张比例 k 缩放的纸面字号；标注/地名（手动文字）是固定字号、不乘 k（与新建文字一致）。
 * 地图分类 = `MAP_LABEL_DEFAULT_FONT_SIZE_PT`（分类默认统一字号按该分类地名中位数算，
 * 见 `mapCategoryDefaultFontSizePt`；这里只用于完全没有地名时的兜底显示）。
 */
export function defaultTextFontSizePt(category: TextStyleCategoryId, layout: PageLayout): number {
  if (TEXT_STYLE_CATEGORY_META[category].kind === 'map') {
    return MAP_LABEL_DEFAULT_FONT_SIZE_PT;
  }
  const role = category as PageTextRole;
  const baseSize = PAGE_TEXT_DEFAULT_FONT_SIZE_PT[role];
  // 与默认排版（core/page-layout.ts）同一口径：只有这四类随纸张自适应比例缩放。
  if (role === 'title' || role === 'subtitle' || role === 'note' || role === 'source') {
    return baseSize * layoutScaleForPaper(layout.paper.width_pt, layout.paper.height_pt);
  }
  return baseSize;
}

/**
 * 地图缩放比 s：底图坐标 → 纸面（§5.1）。字号按它换算（地名只跟地图缩放，不跟纸张 k）。
 * 底图宽度非正时回退 1，避免除零把字号算成 Infinity/NaN。
 */
export function mapScaleOf(geo: Geo, layout: PageLayout): number {
  const scale = layout.map.width_pt / geo.base.width_pt;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** 地图分类统一字号的小数口径：保留 1 位小数（§12.1，`Math.round(x*10)/10`） */
function roundFontSizeTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * 地图分类的默认统一字号（§12.1）：取该分类全部 `geo.labels`（`role === category`）的
 * `font_size_pt` 中位数 × 地图缩放 s，夹到 4..40，保留 1 位小数；
 * 该分类没有地名或字号全非法 → `MAP_LABEL_DEFAULT_FONT_SIZE_PT`。
 *
 * 为什么按分类取中位数：地图标注必须统一字号（用户反馈），中位数是「这批地名原本的典型
 * 层级」的代表值，换算成纸面字号后分类整体最接近原图观感；偶数个取中间两个的平均。
 * 为什么先剔除非法字号：默认排版可能在不经过 validateGeo 的路径（单测/调试）被直接调用，
 * 非有限或非正的字号会把中位数算成 NaN。
 * 4..40 与改造前逐条字号的口径一致：太小小到不可读，太大压住地图。
 *
 * @param mapScale 地图缩放 s（`layout.map.width_pt / geo.base.width_pt`，调用方用 `mapScaleOf`）
 */
export function mapCategoryDefaultFontSizePt(
  category: MapLabelRole,
  geo: Geo,
  mapScale: number,
): number {
  const sizes = geo.labels
    .filter((label) => label.role === category)
    .map((label) => label.font_size_pt)
    .filter((size) => Number.isFinite(size) && size > 0)
    .sort((left, right) => left - right);
  if (sizes.length === 0) return MAP_LABEL_DEFAULT_FONT_SIZE_PT;
  const middle = Math.floor(sizes.length / 2);
  const median =
    sizes.length % 2 === 1
      ? (sizes[middle] ?? 0)
      : ((sizes[middle - 1] ?? 0) + (sizes[middle] ?? 0)) / 2;
  const scale = Number.isFinite(mapScale) && mapScale > 0 ? mapScale : 1;
  return roundFontSizeTenth(Math.min(40, Math.max(4, median * scale)));
}

/**
 * 地图分类写回 item 的统一字号（§12.1 的唯一口径）：用户覆盖 ?? 分类默认统一字号。
 * `applyTextStyle` / `resetTextStyle` / `applyCategoryStyleToItem` / `readTextCategoryStyle`
 * 全部走这里，保证「窗口显示的数字」与「实际写进 item 的数字」永远一致、同分类所有 item 相等。
 */
function mapCategoryFontSizePt(
  layout: PageLayout,
  geo: Geo,
  category: MapLabelRole,
  mapScale: number,
): number {
  return (
    fontSizeOverrideOf(layout, category) ?? mapCategoryDefaultFontSizePt(category, geo, mapScale)
  );
}

/* =========================== 分类归属与查询 =========================== */

/** item → 分类；非 text item（或无法判断）返回 null */
export function textCategoryOfItem(item: TextItem, geo: Geo): TextStyleCategoryId | null {
  // 非 text item 在类型上不会传进来（签名是 TextItem），运行期形状兜底避免误当页面文字。
  if (item.kind !== 'text') return null;
  if (item.space === 'page') return item.role;
  // 地图地名：地理真值是 geo.labels 的 role；旧文件缺 id 时回退 item.role（固定 'label'）。
  const label = labelOfItem(item, geo);
  if (label !== undefined && isTextStyleCategoryId(label.role)) return label.role;
  return isTextStyleCategoryId(item.role) ? item.role : null;
}

/** 地图 item ↔ geo.labels 的关联（geo_label_id）；查不到返回 undefined */
function labelOfItem(item: TextItem, geo: Geo): GeoLabel | undefined {
  if (item.geo_label_id === null) return undefined;
  return geo.labels.find((label) => label.id === item.geo_label_id);
}

/** 分类下的全部 text item（按 items 数组顺序） */
export function itemsOfTextCategory(
  layout: PageLayout,
  geo: Geo,
  category: TextStyleCategoryId,
): TextItem[] {
  return layout.items.filter(
    (item): item is TextItem => item.kind === 'text' && textCategoryOfItem(item, geo) === category,
  );
}

/**
 * 页面分类的有效字号：覆盖 → 该分类第一条 item 的实际字号 → 默认字号。
 * 「第一条 item 实际字号」是旧文件兼容：页面文字迁移前可以逐条有不同字号，窗口先展示
 * 第一条的值，用户一旦写覆盖就统一到覆盖值。
 * @param exclude 单条应用时排除自己（否则切换角色后读到的是切换前的字号）
 */
function pageFontSizePt(
  layout: PageLayout,
  geo: Geo,
  category: TextStyleCategoryId,
  exclude?: TextItem,
): number {
  const override = fontSizeOverrideOf(layout, category);
  if (override !== undefined) return override;
  const first = itemsOfTextCategory(layout, geo, category).find((item) => item !== exclude);
  return first?.font_size_pt ?? defaultTextFontSizePt(category, layout);
}

/** 分类当前的有效样式（窗口显示 / 应用共用同一口径） */
export function readTextCategoryStyle(
  layout: PageLayout,
  geo: Geo,
  category: TextStyleCategoryId,
): ResolvedTextStyle {
  const fields = resolveTextStyleFields(category, layout.text_style[category]);
  if (TEXT_STYLE_CATEGORY_META[category].kind === 'map') {
    // 地图分类固定「覆盖 ?? 分类默认统一字号」：旧 page 块里 item 字号可能逐条不同，
    // 窗口不能读第一条的实际字号，否则显示值会与「改任意字段后写回的统一值」不一致。
    return {
      ...fields,
      font_size_pt: mapCategoryFontSizePt(
        layout,
        geo,
        category as MapLabelRole,
        mapScaleOf(geo, layout),
      ),
    };
  }
  return {
    ...fields,
    font_size_pt: pageFontSizePt(layout, geo, category),
  };
}

/* =========================== 写入 item =========================== */

/**
 * 地名「垂直中心 → 第一行基线」的纸面偏移（与 core/page-layout.ts 的 makeLabelItem 同一公式）：
 * `baseline_ratio × size − (行数−1) × size × line_height / 2`。
 * 分类改字号/行高时用 offset 差修正 map 坐标 y，保住用户手动拖过的位置。
 */
function labelBlockOffset(lineCount: number, fontSizePt: number, lineHeight: number): number {
  return (
    MAP_LABEL_STYLE.baseline_ratio * fontSizePt - ((lineCount - 1) * fontSizePt * lineHeight) / 2
  );
}

/**
 * 把解析后的样式写进一条 text item（渲染只认 item 显式字段），返回是否真的改了。
 *
 * 地图 item 额外修 y：字号/行高变化会改变「文字块垂直中心 → 第一行基线」的偏移，不改 y
 * 会让整块文字上下跳。公式：
 *   newY = y + (offsetPaper(新字号, 新行高) − offsetPaper(旧字号, 旧行高)) / mapScale
 * 页面 item 的 y 是第一行基线，字号变化不移动基线锚点，故不修 y。
 */
function writeItemStyle(
  item: TextItem,
  fields: ResolvedTextStyleFields,
  fontSizePt: number,
  mapScale: number,
): boolean {
  const oldSize = item.font_size_pt;
  const oldLineHeight = item.line_height;
  const nextHalo = cloneHalo(fields.halo);
  const changed =
    oldSize !== fontSizePt ||
    item.color !== fields.color ||
    item.italic !== fields.italic ||
    item.font_weight !== fields.font_weight ||
    item.letter_spacing_em !== fields.letter_spacing_em ||
    oldLineHeight !== fields.line_height ||
    !sameHalo(item.halo, nextHalo);
  if (!changed) return false;

  item.font_size_pt = fontSizePt;
  item.color = fields.color;
  item.italic = fields.italic;
  item.font_weight = fields.font_weight;
  item.letter_spacing_em = fields.letter_spacing_em;
  item.line_height = fields.line_height;
  item.halo = nextHalo;
  if (item.space === 'map') {
    const lineCount = item.lines.length;
    item.y +=
      (labelBlockOffset(lineCount, fontSizePt, fields.line_height) -
        labelBlockOffset(lineCount, oldSize, oldLineHeight)) /
      mapScale;
  }
  return true;
}

/**
 * 合并一次补丁：
 * - `undefined` = 删除该覆盖键（回默认值）；
 * - `font_size_pt: null` = 旧数据兼容（等价删除该覆盖键，回分类默认字号）；
 * - `halo: null` = 显式关光晕（保留键，与删除不同）；
 * - 其余值直接写覆盖。结果为空对象时由调用方删除该分类条目（覆盖表不留空壳）。
 */
function mergeTextStyleOverride(
  current: TextStyleOverride | undefined,
  patch: TextStylePatch,
): TextStyleOverride {
  const base = current ?? {};
  const next: TextStyleOverride = {};
  const size = 'font_size_pt' in patch ? patch.font_size_pt : base.font_size_pt;
  if (size !== undefined && size !== null) next.font_size_pt = size;
  const color = 'color' in patch ? patch.color : base.color;
  if (color !== undefined) next.color = color;
  const italic = 'italic' in patch ? patch.italic : base.italic;
  if (italic !== undefined) next.italic = italic;
  const weight = 'font_weight' in patch ? patch.font_weight : base.font_weight;
  if (weight !== undefined) next.font_weight = weight;
  const spacing = 'letter_spacing_em' in patch ? patch.letter_spacing_em : base.letter_spacing_em;
  if (spacing !== undefined) next.letter_spacing_em = spacing;
  const lineHeight = 'line_height' in patch ? patch.line_height : base.line_height;
  if (lineHeight !== undefined) next.line_height = lineHeight;
  const halo = 'halo' in patch ? patch.halo : base.halo;
  if (halo !== undefined) next.halo = cloneHalo(halo);
  return next;
}

/* =========================== 批量应用 =========================== */

/**
 * 写入补丁：改 `layout.text_style[category]`，并把该分类全部 item 的显式样式字段同步一遍。
 * 返回被改到的 item 数。
 *
 * 地图分类的字号恒为「覆盖 ?? 分类默认统一字号」：即使本次补丁只改颜色，也会把该分类全部
 * item 的字号统一过去（§12.1：地图标注必须统一字号，旧文件逐条不同的字号在这里被收敛）。
 * 页面分类的字号：覆盖 → 该分类第一条 item 的实际字号 → 默认（与窗口显示口径一致）。
 */
export function applyTextStyle(
  layout: PageLayout,
  geo: Geo,
  category: TextStyleCategoryId,
  patch: TextStylePatch,
): number {
  const next = mergeTextStyleOverride(layout.text_style[category], patch);
  const empty = Object.keys(next).length === 0;
  if (empty) delete layout.text_style[category];
  else layout.text_style[category] = next;

  const fields = resolveTextStyleFields(category, empty ? undefined : next);
  const mapScale = mapScaleOf(geo, layout);
  const items = itemsOfTextCategory(layout, geo, category);
  let changed = 0;

  if (TEXT_STYLE_CATEGORY_META[category].kind === 'page') {
    const fontSize = pageFontSizePt(layout, geo, category);
    for (const item of items) {
      if (writeItemStyle(item, fields, fontSize, mapScale)) changed += 1;
    }
    return changed;
  }

  const fontSize = mapCategoryFontSizePt(layout, geo, category as MapLabelRole, mapScale);
  for (const item of items) {
    if (writeItemStyle(item, fields, fontSize, mapScale)) changed += 1;
  }
  return changed;
}

/**
 * 删除该分类整个覆盖并恢复代码默认样式，返回被改到的 item 数。
 * 与「把补丁写成默认值」的区别：覆盖表条目真的被删掉（导出文件里不留与默认相同的冗余）。
 * 地图分类字号回到「分类默认统一字号」；页面分类回到 `defaultTextFontSizePt`（默认排版口径）。
 */
export function resetTextStyle(
  layout: PageLayout,
  geo: Geo,
  category: TextStyleCategoryId,
): number {
  delete layout.text_style[category];
  const fields = defaultTextStyleFields(category);
  const mapScale = mapScaleOf(geo, layout);
  const items = itemsOfTextCategory(layout, geo, category);
  let changed = 0;

  if (TEXT_STYLE_CATEGORY_META[category].kind === 'page') {
    const fontSize = defaultTextFontSizePt(category, layout);
    for (const item of items) {
      if (writeItemStyle(item, fields, fontSize, mapScale)) changed += 1;
    }
    return changed;
  }

  const fontSize = mapCategoryFontSizePt(layout, geo, category as MapLabelRole, mapScale);
  for (const item of items) {
    if (writeItemStyle(item, fields, fontSize, mapScale)) changed += 1;
  }
  return changed;
}

/**
 * 单条 text item 的样式套用：用户把一条页面文字切换到新角色后，立刻套上新分类的有效样式。
 * 字号口径与批量应用不同——要排除 item 自己（role 已经改成新分类，若把它算作「第一条
 * item」，读到的会是切换前的字号）：覆盖 → 该分类其它 item 的实际字号 → 默认字号。
 * 地图 item 走自己的地图分类：字号恒为「覆盖 ?? 分类默认统一字号」（§12.1），保证切换后与
 * 该分类其它地名同字号。
 */
export function applyCategoryStyleToItem(layout: PageLayout, geo: Geo, item: TextItem): void {
  const mapScale = mapScaleOf(geo, layout);
  if (item.space === 'map') {
    const category = textCategoryOfItem(item, geo);
    if (category === null) return;
    const fields = resolveTextStyleFields(category, layout.text_style[category]);
    const fontSize = mapCategoryFontSizePt(layout, geo, category as MapLabelRole, mapScale);
    writeItemStyle(item, fields, fontSize, mapScale);
    return;
  }
  const category = textCategoryOfItem(item, geo);
  if (category === null) return;
  const fields = resolveTextStyleFields(category, layout.text_style[category]);
  writeItemStyle(item, fields, pageFontSizePt(layout, geo, category, item), mapScale);
}

/* =========================== 旧文件迁移 =========================== */

/**
 * 打开旧 page 块时还原 `geo_label_id`（规格 §5.3）：
 * 对 space=map、role=label、geo_label_id=null 的 item，按
 * `lines.join('\n') === label.text`、`|x − label.x| < 1e-6`、anchor 相同匹配 `geo.labels`；
 * 多个候选取 `|item.y − label.y|` 最小者。只补 id，不改样式（调用方也不标脏）。
 *
 * 为什么容差是 1e-6 而 y 用「最近」：x 是生成时原样落盘的锚点，应当精确相等（容差只吸收
 * JSON 往返误差）；y 在 v2 语义里是「文字块垂直中心」，而 item.y 已按旧口径换算成基线，
 * 不同 label 的 y 可能靠得很近，取最近中心比要求相等更稳。
 */
export function reconcileGeoLabelIds(layout: PageLayout, geo: Geo): number {
  let filled = 0;
  for (const item of layout.items) {
    if (item.kind !== 'text' || item.space !== 'map' || item.role !== 'label') continue;
    if (item.geo_label_id !== null && item.geo_label_id !== undefined) continue;
    const text = item.lines.join('\n');
    let matched: GeoLabel | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const label of geo.labels) {
      if (label.text !== text) continue;
      if (Math.abs(label.x - item.x) >= 1e-6) continue;
      if (label.anchor !== item.anchor) continue;
      const distance = Math.abs(label.y - item.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        matched = label;
      }
    }
    if (matched !== null) {
      item.geo_label_id = matched.id;
      filled += 1;
    }
  }
  return filled;
}
