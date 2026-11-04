/**
 * 地图文字样式常量的唯一真源（geo v2 的 role 表 + 页面文字角色默认样式）。
 *
 * 是什么：地图地名按语义角色 `role` 取颜色/斜体（`MAP_LABEL_ROLE_STYLES`）；描边、字距、行高、
 * 字重是全局常量（`MAP_LABEL_STYLE`）；页面文字（标题/副标题/地名 item/注记/来源）的默认样式
 * 按角色查 `PAGE_TEXT_STYLES`；侧栏打开光晕时的默认值用 `TEXT_HALO`。
 * 为什么集中在这一层：生成端（Cartopy）的 geo.json v2 只输出 `role` + 文字 + 位置 + 锚点 + 字号，
 * 不再输出任何样式；预览（`render/page-svg.ts`）与成品（`render/compose-svg.ts`）必须逐字同源，
 * 所以样式值只允许出现在这里，core/render/ui/app 只能引用，不许再写死。
 * 已知口径：字号仍是每条标注的数据（层级），不在本文件；地图几何/填色用的 `COLOR_*` 与文字样式
 * 脱钩。角色枚举也以这里为准（Python 侧只镜像枚举，不存样式值）。
 * 分类口径（2026-11-05 起）：页面文字角色与地图地名角色共同构成「样式设置」窗口的分类
 * （`TEXT_STYLE_CATEGORY_GROUPS`）；每个分类的默认样式查 `PAGE_TEXT_STYLES` / `MAP_LABEL_ROLE_STYLES`
 * + `MAP_LABEL_STYLE`，用户在窗口里改的覆盖值只落 `page.text_style`（core/page.ts），不回到本文件。
 * 元信息：作者 frontend，2026-10-29，随 geo v2 文字样式统一落地（`.work/TEXT-STYLE-SPEC.md` §2）；
 *         作者 lead，2026-11-05，增加分类元信息与页面文字默认字号（`.work/STYLE-SETTINGS-SPEC.md`）。
 */

import {
  PAGE_NOTE_SIZE_PT,
  PAGE_SOURCE_SIZE_PT,
  PAGE_SUBTITLE_SIZE_PT,
  PAGE_TITLE_SIZE_PT,
} from './page';

/* ---------------- 地图地名：语义角色表 ---------------- */

/** geo.json v2 `labels[].role` 的全部合法取值（顺序即文档顺序） */
export const MAP_LABEL_ROLES = [
  'country',
  'country-name',
  'sea',
  'city',
  'city-reference',
  'river',
  'highland',
  'area',
  'area-muted',
  'area-accent-1',
  'area-accent-2',
  'area-accent-3',
  'area-accent-4',
  'area-basin',
] as const;

export type MapLabelRole = (typeof MAP_LABEL_ROLES)[number];

/** 一个地图地名角色对应的文字样式（只有颜色与斜体，其余是全局常量） */
export interface MapLabelRoleStyle {
  /** 文字填充色 */
  readonly color: string;
  /** 是否斜体（水名/山名/流域名等） */
  readonly italic: boolean;
}

/**
 * 按语义角色取色：颜色的唯一真源。
 * 为什么按角色而不是按图种：同一语义（国名/海名/城市/行政区/强调区）在五个图种里应当同色，
 * 旧实现每个图种各自硬编码一份，改风格要改五处且容易漂移。
 */
export const MAP_LABEL_ROLE_STYLES: Record<MapLabelRole, MapLabelRoleStyle> = {
  country: { color: '#3a3a3a', italic: false },
  'country-name': { color: '#8b0000', italic: false },
  sea: { color: '#1f4e79', italic: true },
  city: { color: '#111111', italic: false },
  'city-reference': { color: '#555555', italic: false },
  river: { color: '#2d6ea6', italic: true },
  highland: { color: '#6d4a33', italic: true },
  area: { color: '#111111', italic: false },
  'area-muted': { color: '#666666', italic: false },
  'area-accent-1': { color: '#4a1486', italic: false },
  'area-accent-2': { color: '#005a32', italic: false },
  'area-accent-3': { color: '#0d47a1', italic: false },
  'area-accent-4': { color: '#a63603', italic: false },
  'area-basin': { color: '#1b5c8c', italic: true },
};

/** 所有地图标注共用的文字样式常量（要改风格只改这里） */
export const MAP_LABEL_STYLE = {
  /** 字体粗细（数字字重，SVG font-weight） */
  font_weight: 400,
  /** 字距（em，相对字号） */
  letter_spacing_em: 0,
  /** 行高倍数（多行地名共用一套） */
  line_height: 1.2,
  /** 描边颜色（光晕） */
  halo_color: '#ffffff',
  /** 描边宽度（纸面 pt，不随地图缩放） */
  halo_width_pt: 2,
  /**
   * 「文字块垂直中心 → 第一行基线」的经验比例。
   * 为什么是 0.36：旧实现把同一偏移直接烤进 map 坐标（`0.36*size - (n-1)*step/2`），
   * 这里保持同值，保证底图坐标 → 纸面后视觉位置与旧图一致。
   */
  baseline_ratio: 0.36,
} as const;

/* ---------------- 页面文字：角色默认样式 ---------------- */

/** 页面文字元素的语义角色（文本 item 的 `role`） */
export type PageTextRole = 'title' | 'subtitle' | 'label' | 'annotation' | 'note' | 'source';

/** 一个页面文字角色对应的默认样式（新建文字/默认排版/侧栏兜底共用） */
export interface PageTextStyle {
  readonly color: string;
  readonly italic: boolean;
  readonly font_weight: number;
  readonly letter_spacing_em: number;
  readonly line_height: number;
  /** null = 默认不开光晕 */
  readonly halo: { readonly color: string; readonly width_pt: number } | null;
}

/**
 * 页面文字的角色默认样式。
 * 为什么六个角色当前完全相同：统一排版口径先冻结成一套（400/0/1.35/无光晕/#111111），
 * 角色拆分只为以后能按角色微调；引用处必须走本表，不许各自写 1.35 或 #111111。
 */
export const PAGE_TEXT_STYLES: Record<PageTextRole, PageTextStyle> = {
  title: {
    color: '#111111',
    italic: false,
    font_weight: 400,
    letter_spacing_em: 0,
    line_height: 1.35,
    halo: null,
  },
  subtitle: {
    color: '#111111',
    italic: false,
    font_weight: 400,
    letter_spacing_em: 0,
    line_height: 1.35,
    halo: null,
  },
  label: {
    color: '#111111',
    italic: false,
    font_weight: 400,
    letter_spacing_em: 0,
    line_height: 1.35,
    halo: null,
  },
  annotation: {
    color: '#111111',
    italic: false,
    font_weight: 400,
    letter_spacing_em: 0,
    line_height: 1.35,
    halo: null,
  },
  note: {
    color: '#111111',
    italic: false,
    font_weight: 400,
    letter_spacing_em: 0,
    line_height: 1.35,
    halo: null,
  },
  source: {
    color: '#111111',
    italic: false,
    font_weight: 400,
    letter_spacing_em: 0,
    line_height: 1.35,
    halo: null,
  },
};

/** 侧栏/新建文字打开光晕时的默认描边（颜色与宽度） */
export const TEXT_HALO = { color: '#ffffff', width_pt: 2 } as const;

/* ---------------- 样式设置：分类元信息 ---------------- */

/**
 * 新建标注/手动地名文字的默认字号（pt）。
 * 为什么单独一条：默认排版里标题/副标题/注记/来源的字号要乘纸张比例 k，而工具栏「文字」
 * 新建出来的 item 是固定字号；统一放在分类元信息旁边，新建入口不再各自写死 10。
 */
export const PAGE_TEXT_NEW_FONT_SIZE_PT = 10;

/** 页面文字分类在 A4 基准下的默认字号（pt）；默认排版会再乘纸张比例 k（标注/地名除外） */
export const PAGE_TEXT_DEFAULT_FONT_SIZE_PT: Record<PageTextRole, number> = {
  title: PAGE_TITLE_SIZE_PT,
  subtitle: PAGE_SUBTITLE_SIZE_PT,
  annotation: PAGE_TEXT_NEW_FONT_SIZE_PT,
  note: PAGE_NOTE_SIZE_PT,
  source: PAGE_SOURCE_SIZE_PT,
  label: PAGE_TEXT_NEW_FONT_SIZE_PT,
};

/** 地图地名在拿不到底图字号时的兜底字号（pt，纸面） */
export const MAP_LABEL_DEFAULT_FONT_SIZE_PT = 10;

/** 样式设置窗口里的分类 id：页面文字角色 + 地图地名角色（两套枚举不相交） */
export type TextStyleCategoryId = PageTextRole | MapLabelRole;

/** 分类属于「页面文字」还是「地图标注」（决定字号/默认值来源） */
export type TextStyleCategoryKind = 'page' | 'map';

/** 一个样式分类：id、窗口里的显示名、来源类别 */
export interface TextStyleCategoryMeta {
  readonly id: TextStyleCategoryId;
  readonly label: string;
  readonly kind: TextStyleCategoryKind;
}

/** 样式设置窗口里的一组分类（页面文字 / 地图标注） */
export interface TextStyleCategoryGroup {
  readonly id: TextStyleCategoryKind;
  readonly label: string;
  readonly categories: readonly TextStyleCategoryMeta[];
}

/**
 * 分类清单的唯一真源（顺序即窗口列表顺序）。
 * 为什么以语义 role 为分类、不合并成「城市/行政区」两大类：`area-accent-1` ~ `area-accent-4`
 * 本身承载强调语义（控制区/主张区/特区…），合并会丢掉区分色；按 role 分类既满足
 * 「统一按分类设置」，又保住生成端已有的语义色。
 * 为什么页面文字里保留 `label`（地名）：工具栏「文字」允许手动新增地名文字，它不属于任何
 * geo 地名角色，必须有独立分类。
 */
export const TEXT_STYLE_CATEGORY_META: Readonly<
  Record<TextStyleCategoryId, TextStyleCategoryMeta>
> = {
  title: { id: 'title', label: '标题', kind: 'page' },
  subtitle: { id: 'subtitle', label: '副标题', kind: 'page' },
  annotation: { id: 'annotation', label: '标注', kind: 'page' },
  note: { id: 'note', label: '注记', kind: 'page' },
  source: { id: 'source', label: '来源', kind: 'page' },
  label: { id: 'label', label: '地名（手动）', kind: 'page' },
  city: { id: 'city', label: '城市', kind: 'map' },
  'city-reference': { id: 'city-reference', label: '境外参照城市', kind: 'map' },
  area: { id: 'area', label: '行政区', kind: 'map' },
  'area-muted': { id: 'area-muted', label: '弱化行政区', kind: 'map' },
  'area-accent-1': { id: 'area-accent-1', label: '强调区 1', kind: 'map' },
  'area-accent-2': { id: 'area-accent-2', label: '强调区 2', kind: 'map' },
  'area-accent-3': { id: 'area-accent-3', label: '强调区 3', kind: 'map' },
  'area-accent-4': { id: 'area-accent-4', label: '强调区 4', kind: 'map' },
  country: { id: 'country', label: '国名', kind: 'map' },
  'country-name': { id: 'country-name', label: '本国名', kind: 'map' },
  sea: { id: 'sea', label: '海域', kind: 'map' },
  river: { id: 'river', label: '河流', kind: 'map' },
  highland: { id: 'highland', label: '山系/地貌', kind: 'map' },
  'area-basin': { id: 'area-basin', label: '流域', kind: 'map' },
};

/** 页面文字分类的窗口顺序 */
const PAGE_TEXT_CATEGORY_ORDER = [
  'title',
  'subtitle',
  'annotation',
  'note',
  'source',
  'label',
] as const satisfies readonly TextStyleCategoryId[];

/** 地图标注分类的窗口顺序（按用户最常调的城市/行政区靠前，语义色靠后） */
const MAP_LABEL_CATEGORY_ORDER = [
  'city',
  'city-reference',
  'area',
  'area-muted',
  'area-accent-1',
  'area-accent-2',
  'area-accent-3',
  'area-accent-4',
  'country',
  'country-name',
  'sea',
  'river',
  'highland',
  'area-basin',
] as const satisfies readonly TextStyleCategoryId[];

/** 样式设置窗口的两组分类（页面文字 / 地图标注） */
export const TEXT_STYLE_CATEGORY_GROUPS: readonly TextStyleCategoryGroup[] = [
  {
    id: 'page',
    label: '页面文字',
    categories: PAGE_TEXT_CATEGORY_ORDER.map((id) => TEXT_STYLE_CATEGORY_META[id]),
  },
  {
    id: 'map',
    label: '地图标注',
    categories: MAP_LABEL_CATEGORY_ORDER.map((id) => TEXT_STYLE_CATEGORY_META[id]),
  },
];

/** 全部分类 id（含顺序）；校验 `page.text_style` 的键时用它 */
export const TEXT_STYLE_CATEGORY_IDS: readonly TextStyleCategoryId[] = [
  ...PAGE_TEXT_CATEGORY_ORDER,
  ...MAP_LABEL_CATEGORY_ORDER,
];

/** 是否为合法分类 id（`page.text_style` 键校验的唯一入口） */
export function isTextStyleCategoryId(value: string): value is TextStyleCategoryId {
  return Object.hasOwn(TEXT_STYLE_CATEGORY_META, value);
}
