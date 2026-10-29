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
 * 元信息：作者 frontend，2026-10-29，随 geo v2 文字样式统一落地（`.work/TEXT-STYLE-SPEC.md` §2）。
 */

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
