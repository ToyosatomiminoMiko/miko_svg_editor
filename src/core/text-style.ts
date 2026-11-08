/**
 * 分类文字样式的解析,批量应用与整表重建(纯逻辑,不碰 DOM).
 *
 * 是什么:把「样式设置」窗口的 20 个分类(6 个页面文字角色 + 14 个地图地名角色)与排版块
 * 的 `page.text_style` 覆盖表,`TextItem` 的显式样式字段互相换算--读分类当前有效样式,
 * 写入覆盖并把该分类全部 item 同步一遍,恢复默认,给单条 item 套分类样式,以及打开文件后
 * 按分类把整份排版的文字样式重建一遍(`resyncTextStyles`,保证分类样式是唯一真源).
 * 为什么放在 core:窗口(app/ui),默认排版(core/page-layout)与打开流程(core/open-map)
 * 必须共用同一套「默认值 + 覆盖」解析口径;各写一份会让「窗口显示的值」和「实际写进 item
 * 的值」漂移.默认值全部来自 `config/text-style.ts`,覆盖只落 `page.text_style`.
 * 为什么本文件不 import core/page-layout:默认排版要 import 本文件的解析函数,反向 import
 * 会形成 core 内部运行期环(架构检查会失败);默认字号只从 config/text-style.ts 取,
 * 不依赖纸张尺寸.
 * 渲染层不感知覆盖表:每次应用都逐条把解析值写回 item 的显式字段(render/* 口径不变).
 * 为什么地图分类的字号是「分类默认统一字号」而不是逐条地名字号:地图标注必须统一字号
 * (用户反馈),同一分类下的全部地名永远用同一个字号;字号属于样式,由 `config/text-style.ts`
 * 的 role 表给**纸张 mm 设计值**,不乘地图缩放,不看底图尺寸(见 `mapCategoryDefaultFontSizeMm`).
 * 为什么没有「旧文件迁移」:item 上的样式字段只是分类样式的物化结果,打开时必须能由分类
 * 重算出来(`resyncTextStyles`),所以旧 page 块不走逐条兼容--不合法就回退默认排版.
 * 元信息:作者 ToyosatomiminoMiko,2026-11-05.
 */

import {
  MAP_LABEL_ROLE_STYLES,
  MAP_LABEL_STYLE,
  PAGE_TEXT_DEFAULT_FONT_SIZE_MM,
  PAGE_TEXT_STYLES,
  TEXT_HALO,
  TEXT_STYLE_CATEGORY_META,
  isTextStyleCategoryId,
} from '../config/text-style';
import type { MapLabelRole, PageTextRole, TextStyleCategoryId } from '../config/text-style';
import { roundToPageDecimals } from './page';
import type { Geo, GeoLabel, Halo, PageLayout, TextItem, TextStyleOverride } from './page';

/* =========================== 对外类型 =========================== */

/**
 * 写窗口用的一次补丁:只带用户真的改了的字段.
 * 为什么用「字段缺席 = 保持原覆盖」而不是 null 哨兵:恢复默认有独立的 `resetTextStyle`
 * (整条覆盖删掉),补丁里不需要再表达「删掉字号」这一层含义.
 */
export interface TextStylePatch extends Omit<TextStyleOverride, 'font_size_mm'> {
  font_size_mm?: number;
}

/**
 * 可分字段恢复默认的字段 id(样式设置窗口每个数值控件旁的 reset 用).
 * 光晕宽度不是覆盖表的一级键(halo 是整对象),单列一个 id 表示「只把宽度回默认,颜色保留」.
 */
export type TextStyleResetField =
  'font_size_mm' | 'line_height' | 'letter_spacing_em' | 'halo_width_mm';

/** 覆盖解析后的样式字段(不含字号:地图分类的字号要按每条 item 回算底图数据) */
export interface ResolvedTextStyleFields {
  readonly color: string;
  readonly italic: boolean;
  readonly font_weight: number;
  readonly letter_spacing_em: number;
  readonly line_height: number;
  readonly halo: Halo | null;
}

/** 分类的当前有效样式(样式设置窗口显示 / 批量应用共用) */
export interface ResolvedTextStyle extends ResolvedTextStyleFields {
  /** 有效字号:地图分类恒为该分类的统一字号(覆盖 ?? 分类默认统一字号),页面分类按角色口径 */
  readonly font_size_mm: number;
}

/* =========================== 默认值与覆盖解析 =========================== */

/** cloneHalo 的用途:解引用 geo/config 里的共享对象,避免 layout 与真源共享可变引用 */
function cloneHalo(halo: Halo | null): Halo | null {
  return halo === null ? null : { color: halo.color, width_mm: halo.width_mm };
}

/** 两个光晕是否等价(批应用时判断 item 是否真的被改到) */
function sameHalo(left: Halo | null, right: Halo | null): boolean {
  if (left === null || right === null) return left === right;
  return left.color === right.color && left.width_mm === right.width_mm;
}

/**
 * 某分类的代码默认样式(不含字号).
 * 页面分类查 `PAGE_TEXT_STYLES`;地图分类 = 角色表颜色/斜体/光晕宽度 + 全局常量
 * (字重/字距/行高/光晕颜色),与 geo v2 生成口的样式口径逐字一致.
 * 防御分支:运行期传入未知地名角色(坏 geo 未经校验就进默认排版)时按 area 的样式兜底,
 * 与改造前 makeLabelItem 的回退口径一致.
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
    halo: {
      color: MAP_LABEL_STYLE.halo_color,
      width_mm: roleStyle.halo_width_mm ?? MAP_LABEL_STYLE.halo_width_mm,
    },
  };
}

/**
 * 合并覆盖与默认值:逐字段「覆盖 ?? 默认」.
 * `halo` 需要区分 undefined(用默认)与 null(显式关光晕),所以单独判断而不是 `??`.
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

/** 覆盖表里该分类的字号覆盖(数字才算;null/缺省 = 用分类默认字号) */
function fontSizeOverrideOf(layout: PageLayout, category: TextStyleCategoryId): number | undefined {
  const value = layout.text_style[category]?.font_size_mm;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 分类是否被用户显式设过字号覆盖(窗口字段状态/测试用;不影响字号解析口径) */
export function hasFontSizeOverride(layout: PageLayout, category: TextStyleCategoryId): boolean {
  return fontSizeOverrideOf(layout, category) !== undefined;
}

/**
 * 分类默认字号(没有 item 时窗口显示用).
 * 页面分类 = `PAGE_TEXT_DEFAULT_FONT_SIZE_MM[role]`:全部页面文字使用固定字号,
 * 不随纸张尺寸缩放;地图分类 = role 表的纸张 mm 设计字号(`mapCategoryDefaultFontSizeMm`),
 * 是前端样式常量,与底图尺寸/地图缩放/纸张尺寸都无关.
 *
 * `layout` 参数保留在签名里:窗口与其它解析函数共用同一调用形状,且今后若默认值需要
 * 依赖版式(例如按阅读距离),调用方不用改.
 */
export function defaultTextFontSizeMm(category: TextStyleCategoryId, _layout: PageLayout): number {
  if (TEXT_STYLE_CATEGORY_META[category].kind === 'map') {
    return mapCategoryDefaultFontSizeMm(category as MapLabelRole);
  }
  const role = category as PageTextRole;
  return PAGE_TEXT_DEFAULT_FONT_SIZE_MM[role];
}

/**
 * 地图分类的默认统一字号(§12.1):`MAP_LABEL_ROLE_STYLES[role].font_size_mm`,纸张 mm 设计常量.
 *
 * 为什么不再是「该分类地名 font_size_pt × 地图缩放」:字号属于前端文字样式,样式是排版设计
 * 决定,不能随着 Cartopy 底图尺寸/地图缩放漂移;同一 role 的地名在任何底图,任何纸张上都
 * 恒定同字号,想调就改「样式设置」里的分类覆盖.
 * 未知 role(坏数据绕过 validateGeo 的调试路径)按 `area` 的字号兜底--与颜色/斜体等字段的
 * 防御式回退是同一条口径.
 */
export function mapCategoryDefaultFontSizeMm(category: MapLabelRole): number {
  return (MAP_LABEL_ROLE_STYLES[category] ?? MAP_LABEL_ROLE_STYLES.area).font_size_mm;
}

/**
 * 地图分类写回 item 的统一字号(§12.1 的唯一口径):用户覆盖 ?? 分类默认统一字号.
 * `applyTextStyle` / `resetTextStyle` / `applyCategoryStyleToItem` / `readTextCategoryStyle`
 * 全部走这里,保证「窗口显示的数字」与「实际写进 item 的数字」永远一致,同分类所有 item 相等.
 */
function mapCategoryFontSizeMm(layout: PageLayout, category: MapLabelRole): number {
  return fontSizeOverrideOf(layout, category) ?? mapCategoryDefaultFontSizeMm(category);
}

/* =========================== 分类归属与查询 =========================== */

/** item -> 分类;非 text item(或无法判断)返回 null */
export function textCategoryOfItem(item: TextItem, geo: Geo): TextStyleCategoryId | null {
  // 非 text item 在类型上不会传进来(签名是 TextItem),运行期形状兜底避免误当页面文字.
  if (item.kind !== 'text') return null;
  // 手动新增的页面文字:分类就是它的角色.
  if (item.geo_label_id === null) return item.role;
  // 地图地名:地理真值是 geo.labels 的 role;查不到 id 时回退 item.role(固定 'label').
  const label = labelOfItem(item, geo);
  if (label !== undefined && isTextStyleCategoryId(label.role)) return label.role;
  return isTextStyleCategoryId(item.role) ? item.role : null;
}

/** 地图 item ↔ geo.labels 的关联(geo_label_id);查不到返回 undefined */
function labelOfItem(item: TextItem, geo: Geo): GeoLabel | undefined {
  if (item.geo_label_id === null) return undefined;
  return geo.labels.find((label) => label.id === item.geo_label_id);
}

/** 分类下的全部 text item(按 items 数组顺序) */
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
 * 页面分类的有效字号:覆盖 ?? 该分类其它 item 的实际字号 ?? 分类默认字号.
 *
 * 为什么回退「第一条 item 的实际字号」而不是直接回分类默认值:页面文字字号是固定设计值,
 * 但旧排版里可能保存着与当前默认不同的值(用户早先调过/版式遗留);若这里只看默认值,
 * `resyncTextStyles` 会在重新打开时把它改掉并误标脏(导出 -> 打开不再字节稳定).
 * 把「现存的分类字号」作为覆盖与默认值之间的真值,能保证打开既有排版不触碰文字样式;
 * 用户改字号时写覆盖,恢复默认时回默认,口径仍然单一.地图分类走 `mapCategoryFontSizeMm`.
 * @param exclude 单条切分类时排除自己(否则读到的会是切换前的字号)
 */
function pageFontSizeMm(
  layout: PageLayout,
  geo: Geo,
  category: TextStyleCategoryId,
  exclude?: TextItem,
): number {
  const override = fontSizeOverrideOf(layout, category);
  if (override !== undefined) return override;
  const first = itemsOfTextCategory(layout, geo, category).find((item) => item !== exclude);
  return first?.font_size_mm ?? defaultTextFontSizeMm(category, layout);
}

/** 分类当前的有效样式(窗口显示 / 应用共用同一口径) */
export function readTextCategoryStyle(
  layout: PageLayout,
  geo: Geo,
  category: TextStyleCategoryId,
): ResolvedTextStyle {
  const fields = resolveTextStyleFields(category, layout.text_style[category]);
  if (TEXT_STYLE_CATEGORY_META[category].kind === 'map') {
    // 地图分类固定「覆盖 ?? 分类默认统一字号」:窗口显示值必须与批量应用写回的统一值一致.
    return {
      ...fields,
      font_size_mm: mapCategoryFontSizeMm(layout, category as MapLabelRole),
    };
  }
  return {
    ...fields,
    font_size_mm: pageFontSizeMm(layout, geo, category),
  };
}

/* =========================== 写入 item =========================== */

/**
 * 地名「垂直中心 -> 第一行基线」的纸面偏移(与 core/page-layout.ts 的 makeLabelItem 同一公式):
 * `baseline_ratio × size − (行数−1) × size × line_height / 2`(size 单位 mm).
 * 分类改字号/行高时用 offset 差修正纸张坐标 y,保住用户手动拖过的位置.
 */
function labelBlockOffset(lineCount: number, fontSizeMm: number, lineHeight: number): number {
  return (
    MAP_LABEL_STYLE.baseline_ratio * fontSizeMm - ((lineCount - 1) * fontSizeMm * lineHeight) / 2
  );
}

/**
 * 把解析后的样式写进一条 text item(渲染只认 item 显式字段),返回是否真的改了.
 *
 * 地图地名(item.geo_label_id 非 null)额外修 y:字号/行高变化会改变「文字块垂直中心 ->
 * 第一行基线」的偏移,不改 y 会让整块文字上下跳.公式:
 *   newY = y + (offsetPaper(新字号, 新行高) − offsetPaper(旧字号, 旧行高))
 * 页面文字的 y 是第一行基线,字号变化不移动基线锚点,故不修 y.
 */
function writeItemStyle(item: TextItem, fields: ResolvedTextStyleFields, sizeMm: number): boolean {
  // 字号按导出精度取整后再比较:page 数字一律 3 位小数(normalizePage),不取整会让
  // 「重算值」与「文件里已归一化的值」差 1e-6,把每次打开都误判成样式改动.
  const fontSizeMm = roundToPageDecimals(sizeMm);
  const oldSize = item.font_size_mm;
  const oldLineHeight = item.line_height;
  const nextHalo = cloneHalo(fields.halo);
  const changed =
    oldSize !== fontSizeMm ||
    item.color !== fields.color ||
    item.italic !== fields.italic ||
    item.font_weight !== fields.font_weight ||
    item.letter_spacing_em !== fields.letter_spacing_em ||
    oldLineHeight !== fields.line_height ||
    !sameHalo(item.halo, nextHalo);
  if (!changed) return false;

  item.font_size_mm = fontSizeMm;
  item.color = fields.color;
  item.italic = fields.italic;
  item.font_weight = fields.font_weight;
  item.letter_spacing_em = fields.letter_spacing_em;
  item.line_height = fields.line_height;
  item.halo = nextHalo;
  if (item.geo_label_id !== null) {
    const lineCount = item.lines.length;
    item.y +=
      labelBlockOffset(lineCount, fontSizeMm, fields.line_height) -
      labelBlockOffset(lineCount, oldSize, oldLineHeight);
  }
  return true;
}

/**
 * 合并一次补丁:
 * - 字段缺席(`undefined`)= 保持原覆盖;
 * - `halo: null` = 显式关光晕(保留键,与缺席不同);
 * - 其余值直接写覆盖.结果为空对象时由调用方删除该分类条目(覆盖表不留空壳).
 */
function mergeTextStyleOverride(
  current: TextStyleOverride | undefined,
  patch: TextStylePatch,
): TextStyleOverride {
  const base = current ?? {};
  const next: TextStyleOverride = {};
  const size = 'font_size_mm' in patch ? patch.font_size_mm : base.font_size_mm;
  if (size !== undefined) next.font_size_mm = size;
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
 * 写入补丁:改 `layout.text_style[category]`,并把该分类全部 item 的显式样式字段同步一遍.
 * 返回被改到的 item 数.
 *
 * 地图分类的字号恒为「覆盖 ?? 分类默认统一字号」:即使本次补丁只改颜色,也会把该分类全部
 * item 的字号统一过去(§12.1:地图标注必须统一字号).
 * 页面分类的字号:覆盖 ?? 分类默认字号(与窗口显示口径一致).
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
  const items = itemsOfTextCategory(layout, geo, category);
  let changed = 0;

  if (TEXT_STYLE_CATEGORY_META[category].kind === 'page') {
    // 页面字号取该分类现有 item 的字号(窗口显示的同一口径):改颜色/行高时不会顺手把
    // 纸张缩放变化后的字号改掉;要改字号必须显式写 font_size_mm 覆盖.
    const fontSize = pageFontSizeMm(layout, geo, category);
    for (const item of items) {
      if (writeItemStyle(item, fields, fontSize)) changed += 1;
    }
    return changed;
  }

  const fontSize = mapCategoryFontSizeMm(layout, category as MapLabelRole);
  for (const item of items) {
    if (writeItemStyle(item, fields, fontSize)) changed += 1;
  }
  return changed;
}

/**
 * 删除该分类整个覆盖并恢复代码默认样式,返回被改到的 item 数.
 * 与「把补丁写成默认值」的区别:覆盖表条目真的被删掉(导出文件里不留与默认相同的冗余).
 * 地图分类字号回到「分类默认统一字号」;页面分类回到 `defaultTextFontSizeMm`(默认排版口径).
 */
export function resetTextStyle(
  layout: PageLayout,
  geo: Geo,
  category: TextStyleCategoryId,
): number {
  delete layout.text_style[category];
  const fields = defaultTextStyleFields(category);
  const items = itemsOfTextCategory(layout, geo, category);
  let changed = 0;

  if (TEXT_STYLE_CATEGORY_META[category].kind === 'page') {
    const fontSize = defaultTextFontSizeMm(category, layout);
    for (const item of items) {
      if (writeItemStyle(item, fields, fontSize)) changed += 1;
    }
    return changed;
  }

  const fontSize = mapCategoryFontSizeMm(layout, category as MapLabelRole);
  for (const item of items) {
    if (writeItemStyle(item, fields, fontSize)) changed += 1;
  }
  return changed;
}

/**
 * 单字段恢复默认:删掉该字段的覆盖,并把该分类全部 item 的样式重算一遍,返回改到的 item 数.
 *
 * 与 `applyTextStyle` 的区别:不是「把默认值写成覆盖」--覆盖表里不会留下与默认相同的冗余键;
 * 与 `resetTextStyle` 的区别:只动一个字段,该分类其它覆盖保留.
 * 字号必须显式写回:页面分类「无覆盖」的口径是「该分类现有 item 的字号」而不是固定默认,
 * 只删覆盖的话 item 仍保留旧字号(窗口数字不会变),所以页面分类按 `defaultTextFontSizeMm`
 * 写回固定默认值;地图分类按分类默认统一字号重算.
 * 光晕宽度是 halo 对象内的字段:保留当前光晕颜色,只把宽度换回默认;换完后与默认光晕完全
 * 相同时删掉 halo 键(不留冗余覆盖).当前分类没有光晕时什么都不做.
 */
export function resetTextStyleField(
  layout: PageLayout,
  geo: Geo,
  category: TextStyleCategoryId,
  field: TextStyleResetField,
): number {
  const current = layout.text_style[category];
  const next: TextStyleOverride = { ...(current ?? {}) };
  const defaults = defaultTextStyleFields(category);

  if (field === 'halo_width_mm') {
    const resolvedHalo = resolveTextStyleFields(category, current).halo;
    const defaultHalo = defaults.halo;
    if (resolvedHalo === null) return 0;
    const width = defaultHalo?.width_mm ?? TEXT_HALO.width_mm;
    const color = resolvedHalo.color;
    if (defaultHalo !== null && color === defaultHalo.color && width === defaultHalo.width_mm) {
      delete next.halo;
    } else {
      next.halo = { color, width_mm: width };
    }
  } else {
    delete next[field];
  }

  if (Object.keys(next).length === 0) delete layout.text_style[category];
  else layout.text_style[category] = next;

  const fields = resolveTextStyleFields(category, layout.text_style[category]);
  const items = itemsOfTextCategory(layout, geo, category);
  const isPage = TEXT_STYLE_CATEGORY_META[category].kind === 'page';
  const fontSize = !isPage
    ? mapCategoryFontSizeMm(layout, category as MapLabelRole)
    : field === 'font_size_mm'
      ? defaultTextFontSizeMm(category, layout)
      : pageFontSizeMm(layout, geo, category);
  let changed = 0;
  for (const item of items) {
    if (writeItemStyle(item, fields, fontSize)) changed += 1;
  }
  return changed;
}

/** 单条套用分类样式的选项 */
export interface ApplyCategoryStyleOptions {
  /**
   * 页面文字切分类时排除自己:角色已经改成新分类,若把自己算作「该分类现有 item」,
   * 读到的会是切换前的字号.重建整份排版(resyncTextStyles)不能排除自己--那条 item
   * 就是文件里的当前值,排除后会退回纸张默认字号,导致纸张改宽后重开误标脏.
   */
  readonly excludeSelf?: boolean;
}

/**
 * 单条 text item 的样式套用:用户把一条页面文字切换到新角色,或打开文件后按分类重建时用.
 * 页面字号口径与批量应用一致(覆盖 ?? 该分类现有 item 字号 ?? 默认);`excludeSelf` 只服务
 * 「切换角色」这一种调用,保证套用的是新分类的字号而不是旧分类的.地图 item 的字号恒为
 * 「覆盖 ?? 分类默认统一字号」(§12.1),与同类地名同字号.
 *
 * @returns 是否真的改动了这条 item(重建整份排版时用来统计/决定是否标脏)
 */
export function applyCategoryStyleToItem(
  layout: PageLayout,
  geo: Geo,
  item: TextItem,
  options: ApplyCategoryStyleOptions = {},
): boolean {
  const category = textCategoryOfItem(item, geo);
  if (category === null) return false;
  const fields = resolveTextStyleFields(category, layout.text_style[category]);
  const fontSize =
    TEXT_STYLE_CATEGORY_META[category].kind === 'map'
      ? mapCategoryFontSizeMm(layout, category as MapLabelRole)
      : pageFontSizeMm(layout, geo, category, options.excludeSelf === true ? item : undefined);
  return writeItemStyle(item, fields, fontSize);
}

/**
 * 按分类把整份排版的文字样式重建一遍,返回被改动的 item 数.
 *
 * 用途:打开带 page 块的文件后调用一次,把 item 上物化的样式字段与 `page.text_style` 对齐.
 * 为什么必须重建:item 上的字号/颜色等只是分类样式的物化结果,不是独立真值;文件里若残留
 * 逐条不同的样式(旧版本导出的 page 块,手改过的 JSON),不重建就会绕过「分类统一」设置.
 * 重建后与文件内容不一致由调用方标脏并告警,导出即写成新口径.
 */
export function resyncTextStyles(layout: PageLayout, geo: Geo): number {
  let changed = 0;
  for (const item of layout.items) {
    if (item.kind !== 'text') continue;
    if (applyCategoryStyleToItem(layout, geo, item)) changed += 1;
  }
  return changed;
}
