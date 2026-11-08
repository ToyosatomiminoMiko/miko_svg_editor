/**
 * 文字样式单一真源(`config/text-style.ts`),geo v2 样式/坐标换算与分类样式数据层
 * (`core/text-style.ts` + `page.text_style`)的单测.
 *
 * 为什么要有这些用例:geo v2 把样式从生成端搬到前端后,颜色/斜体必须按 role 查表,
 * 字重/字距/行高/描边必须是全局常量;同时地名 `y` 的语义是「文字块垂直中心」,
 * 前端换算必须与生成端一致.样式统一在「样式设置」窗口按分类配置(覆盖落
 * `page.text_style`),所以「默认值真源,覆盖解析,批量应用,地图字号统一,旧文件还原」都要
 * 逐条钉住,否则窗口显示值与 item 实际值会漂移.
 * 地图分类字号恒统一:默认值取该分类地名原始字号的中位数 × 地图缩放;同一分类全部 item
 * 字号严格相等.
 * 元信息:作者 ToyosatomiminoMiko,2026-11-05.
 */

import { describe, expect, it } from 'vitest';
import {
  MAP_LABEL_DEFAULT_FONT_SIZE_MM,
  MAP_LABEL_ROLES,
  MAP_LABEL_ROLE_STYLES,
  MAP_LABEL_STYLE,
  PAGE_TEXT_DEFAULT_FONT_SIZE_MM,
  PAGE_TEXT_STYLES,
  TEXT_HALO,
  TEXT_STYLE_CATEGORY_IDS,
  TEXT_STYLE_CATEGORY_META,
  type MapLabelRole,
  type PageTextRole,
} from '../../src/config/text-style';
import {
  validateGeo,
  type Geo,
  type PageLayout,
  type TextItem,
  type TextStyleOverrides,
} from '../../src/core/page';
import {
  defaultPageLayout,
  fallbackTextMeasure,
  fontShorthand,
  mapTransform,
  textBlockWidth,
} from '../../src/core/page-layout';
import {
  applyCategoryStyleToItem,
  applyTextStyle,
  defaultTextFontSizeMm,
  hasFontSizeOverride,
  itemsOfTextCategory,
  mapCategoryDefaultFontSizeMm,
  readTextCategoryStyle,
  resetTextStyle,
  resetTextStyleField,
  resyncTextStyles,
  textCategoryOfItem,
} from '../../src/core/text-style';
import { makeDocument, makeGeo } from '../fixtures/page-fixtures';

/** 用 geo 生成默认排版(打开流程:normalizeGeo -> defaultPageLayout) */
function layoutOf(geo: Geo): PageLayout {
  return defaultPageLayout(makeDocument(geo).geo);
}

/** 默认排版里的 map 空间文字(地名标注),保持 geo.labels 的 order 顺序 */
function mapLabels(layout: PageLayout): TextItem[] {
  return layout.items.filter(
    (item): item is TextItem => item.kind === 'text' && item.geo_label_id !== null,
  );
}

/** 把 geo 复制成可随意改字段的普通对象 */
function mutableGeo(geo: Geo): Record<string, unknown> {
  return structuredClone(geo) as unknown as Record<string, unknown>;
}

describe('MAP_LABEL_ROLE_STYLES:§2 角色表', () => {
  it('14 个 role,颜色/斜体与规格逐字一致', () => {
    const expected: Record<MapLabelRole, { color: string; italic: boolean }> = {
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
    expect(MAP_LABEL_ROLES).toHaveLength(14);
    expect([...MAP_LABEL_ROLES].sort()).toEqual(Object.keys(expected).sort());
    for (const role of MAP_LABEL_ROLES) {
      expect(MAP_LABEL_ROLE_STYLES[role]).toEqual(expected[role]);
    }
  });

  it('每个 role 的地名 item 的颜色/斜体来自角色表', () => {
    const geo = makeGeo();
    geo.labels = MAP_LABEL_ROLES.map((role, index) => ({
      id: `label-${role}`,
      role,
      text: role,
      x: 20 + index * 8,
      y: 50,
      anchor: 'middle' as const,
      font_size_pt: 10,
      order: index,
    }));
    expect(validateGeo(geo)).toEqual([]);

    const labels = mapLabels(layoutOf(geo));
    expect(labels).toHaveLength(MAP_LABEL_ROLES.length);
    labels.forEach((item, index) => {
      const role = MAP_LABEL_ROLES[index]!;
      expect(item.color).toBe(MAP_LABEL_ROLE_STYLES[role].color);
      expect(item.italic).toBe(MAP_LABEL_ROLE_STYLES[role].italic);
    });
  });

  it('未知 role 时防御式回退到 area 的样式', () => {
    const geo = makeGeo();
    Object.assign(geo.labels[0]!, { role: 'not-a-role' });
    const item = mapLabels(layoutOf(geo))[0]!;
    expect(item.color).toBe(MAP_LABEL_ROLE_STYLES.area.color);
    expect(item.italic).toBe(MAP_LABEL_ROLE_STYLES.area.italic);
  });
});

describe('MAP_LABEL_STYLE:全局标注常量', () => {
  it('字重/字距/行高/描边宽度全部来自 MAP_LABEL_STYLE,旋转固定 0', () => {
    for (const item of mapLabels(layoutOf(makeGeo()))) {
      expect(item.font_weight).toBe(MAP_LABEL_STYLE.font_weight);
      expect(item.letter_spacing_em).toBe(MAP_LABEL_STYLE.letter_spacing_em);
      expect(item.line_height).toBe(MAP_LABEL_STYLE.line_height);
      expect(item.halo).toEqual({
        color: MAP_LABEL_STYLE.halo_color,
        width_mm: MAP_LABEL_STYLE.halo_width_mm,
      });
      expect(item.rotation_deg).toBe(0);
    }
  });

  it('常量取值与规格一致(400 / 0 / 1 / #ffffff / 0.18mm / 0.36)', () => {
    expect(MAP_LABEL_STYLE).toEqual({
      font_weight: 400,
      letter_spacing_em: 0,
      line_height: 1,
      halo_color: '#ffffff',
      halo_width_mm: 0.18,
      baseline_ratio: 0.36,
    });
  });
});

describe('geo v2:文字块垂直中心 -> 第一行基线', () => {
  it('单行:纸张基线 = map(中心).y + baseline_ratio × 字号', () => {
    const geo = makeGeo();
    const layout = layoutOf(geo);
    const transform = mapTransform(geo, layout.map);
    const item = mapLabels(layout)[0]!;
    const label = geo.labels[0]!;

    expect(item.lines).toEqual(['甲国']);
    // 地图地名打开时已换算成纸张坐标:基线 = 地图变换(中心) + 0.36 × size
    expect(item.y).toBeCloseTo(
      transform.ty + label.y * transform.s + MAP_LABEL_STYLE.baseline_ratio * item.font_size_mm,
      9,
    );
  });

  it('多行:整块中心到第一行基线再减 (行数-1)×step/2', () => {
    const geo = makeGeo();
    const layout = layoutOf(geo);
    const transform = mapTransform(geo, layout.map);
    const item = mapLabels(layout)[1]!;
    const label = geo.labels[1]!;

    expect(item.lines).toEqual(['乙河', '第二行']);
    const step = item.font_size_mm * MAP_LABEL_STYLE.line_height;
    const offsetPaper =
      MAP_LABEL_STYLE.baseline_ratio * item.font_size_mm - ((item.lines.length - 1) * step) / 2;
    expect(item.y).toBeCloseTo(transform.ty + label.y * transform.s + offsetPaper, 9);
  });

  it('字号 = 分类中位数 × 地图缩放 s,夹 1.5..15mm 并保留 1 位小数', () => {
    const geo = makeGeo();
    const layout = layoutOf(geo);
    const scale = layout.map.width_mm / geo.base.width_pt;
    for (const item of mapLabels(layout)) {
      expect(item.font_size_mm).toBeGreaterThanOrEqual(1.5);
      expect(item.font_size_mm).toBeLessThanOrEqual(15);
    }
    // fixture:country / river 各只有一条地名 -> 中位数就是那条的原始字号
    expect(mapLabels(layout)[0]!.font_size_mm).toBe(
      mapCategoryDefaultFontSizeMm('country', geo, scale),
    );
    expect(mapLabels(layout)[1]!.font_size_mm).toBe(
      mapCategoryDefaultFontSizeMm('river', geo, scale),
    );
    // 保留 1 位小数(中位数换算后不是任意长浮点)
    const size = mapLabels(layout)[0]!.font_size_mm;
    expect(size).toBe(Math.round(size * 10) / 10);
  });
});

describe('PAGE_TEXT_STYLES / TEXT_HALO:页面文字默认样式', () => {
  it('六个角色全部 400/0/1/无光晕/#111111', () => {
    const roles = ['title', 'subtitle', 'label', 'annotation', 'note', 'source'] as const;
    for (const role of roles) {
      expect(PAGE_TEXT_STYLES[role]).toEqual({
        color: '#111111',
        italic: false,
        font_weight: 400,
        letter_spacing_em: 0,
        line_height: 1,
        halo: null,
      });
    }
    expect(TEXT_HALO).toEqual({ color: '#ffffff', width_mm: 0 });
  });

  it('默认排版的页面文字 item 用角色样式,注记/来源块高用对应行高', () => {
    const layout = layoutOf(makeGeo());
    const pageTexts = layout.items.filter(
      (item): item is TextItem => item.kind === 'text' && item.geo_label_id === null,
    );
    expect(pageTexts.length).toBeGreaterThan(0);
    for (const item of pageTexts) {
      const style = PAGE_TEXT_STYLES[item.role];
      expect(item.color).toBe(style.color);
      expect(item.italic).toBe(style.italic);
      expect(item.font_weight).toBe(style.font_weight);
      expect(item.letter_spacing_em).toBe(style.letter_spacing_em);
      expect(item.line_height).toBe(style.line_height);
      expect(item.halo).toEqual(style.halo);
    }
    const note = pageTexts.find((item) => item.role === 'note');
    expect(note?.line_height).toBe(PAGE_TEXT_STYLES.note.line_height);
    const source = pageTexts.find((item) => item.role === 'source');
    expect(source?.line_height).toBe(PAGE_TEXT_STYLES.source.line_height);
  });
});

describe('fontShorthand / textBlockWidth:字重与字距口径', () => {
  it('400 保持旧串,非 400 前置字重(仍能被字号解析)', () => {
    expect(fontShorthand(12, 'sans-serif')).toBe('12px sans-serif');
    expect(fontShorthand(12, 'sans-serif', 400)).toBe('12px sans-serif');
    expect(fontShorthand(12, 'sans-serif', 700)).toBe('700 12px sans-serif');
    // 无 DOM 估算器从简写里取字号:不能被字重数字骗到
    expect(fallbackTextMeasure.width('甲', fontShorthand(10, 'sans-serif', 700))).toBeCloseTo(
      10,
      9,
    );
    expect(fallbackTextMeasure.ascent(fontShorthand(10, 'sans-serif', 700))).toBeCloseTo(8, 9);
  });

  it('textBlockWidth 在每行前进宽度上加字距 × 字号 × max(0, 字符数-1)', () => {
    const base = mapLabels(layoutOf(makeGeo()))[0]!;
    const item: TextItem = {
      ...base,
      x: 0,
      y: 0,
      font_size_mm: 10,
      font_weight: 400,
      line_height: 1.35,
      font_family: null,
      lines: ['甲乙丙'],
      letter_spacing_em: 0,
    };
    // 3 个 CJK 字符 × 10pt = 30pt
    expect(textBlockWidth(item, fallbackTextMeasure.width, 'sans-serif')).toBeCloseTo(30, 9);
    // 字距 0.5em:+ 0.5 × 10 × (3-1) = +10pt
    expect(
      textBlockWidth({ ...item, letter_spacing_em: 0.5 }, fallbackTextMeasure.width, 'sans-serif'),
    ).toBeCloseTo(40, 9);
    // 负字距同样只作用在字符之间(不会把宽度算成负数)
    expect(
      textBlockWidth({ ...item, letter_spacing_em: -0.1 }, fallbackTextMeasure.width, 'sans-serif'),
    ).toBeCloseTo(28, 9);
  });
});

describe('validateGeo:v2 契约与 labels 逐条校验', () => {
  it('完整 v2 geo 通过', () => {
    expect(validateGeo(makeGeo())).toEqual([]);
  });

  it('拒绝 v1 并给出重新生成文案', () => {
    const geo = mutableGeo(makeGeo());
    geo['version'] = 1;
    expect(validateGeo(geo)).toContain('geo.version: 旧 v1 契约,请用更新后的 Cartopy 重新生成');
  });

  it('拒绝未知 role', () => {
    const geo = mutableGeo(makeGeo());
    (geo['labels'] as Record<string, unknown>[])[0]!['role'] = 'unknown-role';
    expect(validateGeo(geo)).toContain(
      'geo.labels[0].role: 必须是 config/text-style.ts 里的合法地名角色',
    );
  });

  it('逐条校验 id/text/x/y/anchor/font_size_pt/order', () => {
    const duplicate = mutableGeo(makeGeo());
    (duplicate['labels'] as Record<string, unknown>[])[1]!['id'] = 'label-country-A';
    expect(validateGeo(duplicate)).toContain('geo.labels[1].id: id "label-country-A" 重复');

    const emptyId = mutableGeo(makeGeo());
    (emptyId['labels'] as Record<string, unknown>[])[0]!['id'] = '';
    expect(validateGeo(emptyId)).toContain('geo.labels[0].id: 必须是非空字符串');

    const badText = mutableGeo(makeGeo());
    delete (badText['labels'] as Record<string, unknown>[])[0]!['text'];
    expect(validateGeo(badText)).toContain('geo.labels[0].text: 必须是字符串');

    const badAnchor = mutableGeo(makeGeo());
    (badAnchor['labels'] as Record<string, unknown>[])[0]!['anchor'] = 'center';
    expect(validateGeo(badAnchor)).toContain('geo.labels[0].anchor: 必须是 start/middle/end');

    const badSize = mutableGeo(makeGeo());
    (badSize['labels'] as Record<string, unknown>[])[0]!['font_size_pt'] = 0;
    expect(validateGeo(badSize)).toContain('geo.labels[0].font_size_pt: 必须是正数');

    const badOrder = mutableGeo(makeGeo());
    (badOrder['labels'] as Record<string, unknown>[])[0]!['order'] = 1.5;
    expect(validateGeo(badOrder)).toContain('geo.labels[0].order: 必须是整数');

    const badCoord = mutableGeo(makeGeo());
    (badCoord['labels'] as Record<string, unknown>[])[0]!['x'] = Number.NaN;
    expect(validateGeo(badCoord)).toContain('geo.labels[0].x: 必须是有限数字');
  });

  it('labels 不是数组时报错', () => {
    const geo = mutableGeo(makeGeo());
    geo['labels'] = 'nope';
    expect(validateGeo(geo)).toEqual(['geo.labels: 必须是数组']);
  });
});

/* ======================================================================
 * 分类样式数据层(core/text-style.ts)与默认排版的覆盖解析
 * ====================================================================== */

/** 构造只含指定地图角色的 geo:每条角色一个 label,text 用「role-序号」保证唯一 */
function geoWithMapLabels(roles: readonly MapLabelRole[]): Geo {
  const geo = makeGeo();
  geo.labels = roles.map((role, index) => ({
    id: `label-${role}-${index}`,
    role,
    text: `${role}-${index}`,
    x: 40 + index * 23,
    y: 25 + index * 17,
    anchor: 'middle' as const,
    font_size_pt: 10,
    order: index,
  }));
  return geo;
}

/** 构造只含指定(role, 原始字号)地名的 geo:用来验证中位数默认统一字号 */
function geoWithLabelSizes(entries: readonly { role: MapLabelRole; font_size_pt: number }[]): Geo {
  const geo = makeGeo();
  geo.labels = entries.map((entry, index) => ({
    id: `label-${index}`,
    role: entry.role,
    text: `地名-${index}`,
    x: 20 + index * 15,
    y: 20 + index * 10,
    anchor: 'middle' as const,
    font_size_pt: entry.font_size_pt,
    order: index,
  }));
  return geo;
}

/** 期望的「分类默认统一字号」(按 §12.1 独立复算:中位数 × s,夹 1.5..15mm,1 位小数) */
function expectedDefaultSize(category: MapLabelRole, geo: Geo, mapScale: number): number {
  const sizes = geo.labels
    .filter((label) => label.role === category)
    .map((label) => label.font_size_pt)
    .filter((size) => Number.isFinite(size) && size > 0)
    .sort((left, right) => left - right);
  if (sizes.length === 0) return MAP_LABEL_DEFAULT_FONT_SIZE_MM;
  const middle = Math.floor(sizes.length / 2);
  const median =
    sizes.length % 2 === 1
      ? (sizes[middle] ?? 0)
      : ((sizes[middle - 1] ?? 0) + (sizes[middle] ?? 0)) / 2;
  return Math.round(Math.min(15, Math.max(1.5, median * mapScale)) * 10) / 10;
}

/** 地名「垂直中心 -> 第一行基线」的纸面偏移(与 core/page-layout.makeLabelItem 同公式) */
function labelOffsetPaper(lineCount: number, fontSizeMm: number, lineHeight: number): number {
  return (
    MAP_LABEL_STYLE.baseline_ratio * fontSizeMm - ((lineCount - 1) * fontSizeMm * lineHeight) / 2
  );
}

describe('mapCategoryDefaultFontSizeMm:中位数默认统一字号(§12.1)', () => {
  it('奇数个取中间值 × s', () => {
    const geo = geoWithLabelSizes([
      { role: 'city', font_size_pt: 8 },
      { role: 'city', font_size_pt: 13 },
      { role: 'city', font_size_pt: 9 },
    ]);
    expect(expectedDefaultSize('city', geo, 1)).toBe(9);
    expect(mapCategoryDefaultFontSizeMm('city', geo, 1)).toBe(9);
    expect(mapCategoryDefaultFontSizeMm('city', geo, 2)).toBe(15);
  });

  it('偶数个取中间两个的平均 × s', () => {
    const geo = geoWithLabelSizes([
      { role: 'city', font_size_pt: 8 },
      { role: 'city', font_size_pt: 12 },
    ]);
    expect(expectedDefaultSize('city', geo, 1)).toBe(10);
    expect(mapCategoryDefaultFontSizeMm('city', geo, 1)).toBe(10);
    expect(mapCategoryDefaultFontSizeMm('city', geo, 0.5)).toBe(5);
  });

  it('夹到 1.5..15mm,结果保留 1 位小数', () => {
    // 中位数 7.5 × 0.98 = 7.35 -> 7.4
    const geo = geoWithLabelSizes([
      { role: 'city', font_size_pt: 7 },
      { role: 'city', font_size_pt: 8 },
    ]);
    expect(mapCategoryDefaultFontSizeMm('city', geo, 0.98)).toBe(7.4);
    // 缩得太小 -> 1.5;放得太大 -> 15
    expect(mapCategoryDefaultFontSizeMm('city', geo, 0.1)).toBe(1.5);
    expect(mapCategoryDefaultFontSizeMm('city', geo, 100)).toBe(15);
  });

  it('该分类没有地名/字号全非法 -> MAP_LABEL_DEFAULT_FONT_SIZE_MM', () => {
    const otherRole = geoWithLabelSizes([{ role: 'river', font_size_pt: 9 }]);
    expect(mapCategoryDefaultFontSizeMm('city', otherRole, 3)).toBe(MAP_LABEL_DEFAULT_FONT_SIZE_MM);
    const invalid = geoWithLabelSizes([
      { role: 'city', font_size_pt: 0 },
      { role: 'city', font_size_pt: Number.NaN },
    ]);
    expect(mapCategoryDefaultFontSizeMm('city', invalid, 3)).toBe(MAP_LABEL_DEFAULT_FONT_SIZE_MM);
  });

  it('非法 mapScale 回退 1(不产生 NaN)', () => {
    const geo = geoWithLabelSizes([{ role: 'city', font_size_pt: 10 }]);
    expect(mapCategoryDefaultFontSizeMm('city', geo, Number.NaN)).toBe(10);
    expect(mapCategoryDefaultFontSizeMm('city', geo, 0)).toBe(10);
  });

  it('默认排版里同 role 的原始字号不同也统一到同一个字号', () => {
    const geo = geoWithLabelSizes([
      { role: 'city', font_size_pt: 8 },
      { role: 'city', font_size_pt: 12 },
      { role: 'city', font_size_pt: 9 },
    ]);
    const layout = defaultPageLayout(geo);
    const scale = layout.map.width_mm / geo.base.width_pt;
    const expected = mapCategoryDefaultFontSizeMm('city', geo, scale);
    const cityItems = itemsOfTextCategory(layout, geo, 'city');
    expect(cityItems).toHaveLength(3);
    for (const item of cityItems) expect(item.font_size_mm).toBe(expected);
  });
});

describe('分类映射:textCategoryOfItem / itemsOfTextCategory', () => {
  it('页面文字 item -> 自己的角色分类,geo_label_id 恒为 null', () => {
    const geo = makeGeo();
    const layout = defaultPageLayout(geo);
    const pageItems = layout.items.filter(
      (item): item is TextItem => item.kind === 'text' && item.geo_label_id === null,
    );
    expect(pageItems.length).toBeGreaterThan(0);
    for (const item of pageItems) {
      expect(item.geo_label_id).toBeNull();
      expect(textCategoryOfItem(item, geo)).toBe(item.role);
    }
  });

  it('14 个地图角色:item 用 geo_label_id 查 label.role 得到各自分类', () => {
    const geo = geoWithMapLabels(MAP_LABEL_ROLES);
    const layout = defaultPageLayout(geo);
    const labels = [...geo.labels].sort((a, b) => a.order - b.order);
    const items = mapLabels(layout);
    expect(items).toHaveLength(MAP_LABEL_ROLES.length);
    items.forEach((item, index) => {
      const label = labels[index]!;
      expect(item.geo_label_id).not.toBeNull();
      expect(item.role).toBe('label');
      expect(item.geo_label_id).toBe(label.id);
      expect(textCategoryOfItem(item, geo)).toBe(label.role);
      expect(itemsOfTextCategory(layout, geo, label.role)).toContain(item);
    });
  });

  it('查不到 label 时回退 item.role;非 text item 返回 null', () => {
    const geo = geoWithMapLabels(['city']);
    const layout = defaultPageLayout(geo);
    const item = mapLabels(layout)[0]!;
    item.geo_label_id = null;
    expect(textCategoryOfItem(item, geo)).toBe('label');
    const legend = layout.items.find((entry) => entry.kind === 'legend')!;
    expect(textCategoryOfItem(legend as unknown as TextItem, geo)).toBeNull();
  });
});

describe('默认排版按分类覆盖解析(§5.2)', () => {
  it('text_style 深拷贝回写,空覆盖对象被清理', () => {
    const override: TextStyleOverrides = { title: { color: '#ff0000', font_size_mm: 22 } };
    const layout = defaultPageLayout(makeGeo(), { text_style: override });
    expect(layout.text_style).toEqual(override);
    expect(layout.text_style).not.toBe(override);
    expect(layout.text_style.title).not.toBe(override.title);
    // 改入参不能影响 layout(深拷贝)
    override.title!.color = '#000000';
    expect(layout.text_style.title?.color).toBe('#ff0000');
    // 空覆盖对象 = 没有覆盖:不落盘空壳
    expect(defaultPageLayout(makeGeo(), { text_style: { city: {} } }).text_style).toEqual({});
  });

  it('无覆盖时两次生成逐字段一致(显式 {} 等于不传)', () => {
    expect(defaultPageLayout(makeGeo(), { text_style: {} })).toEqual(defaultPageLayout(makeGeo()));
  });

  it('页面文字覆盖:颜色/字号/行高/光晕生效,注记/来源折行与块高用解析值', () => {
    const geo = makeGeo();
    const plain = defaultPageLayout(geo);
    const layout = defaultPageLayout(geo, {
      text_style: {
        title: {
          color: '#ff0000',
          font_size_mm: 22,
          font_weight: 700,
          italic: true,
          letter_spacing_em: 0.05,
          line_height: 1.8,
          halo: { color: '#00ff00', width_mm: 1.5 },
        },
        note: { font_size_mm: 12, line_height: 1.6 },
        source: { font_size_mm: 9, line_height: 1.5 },
      },
    });
    const title = layout.items.find(
      (item): item is TextItem => item.kind === 'text' && item.role === 'title',
    )!;
    expect(title.font_size_mm).toBe(22);
    expect(title.color).toBe('#ff0000');
    expect(title.font_weight).toBe(700);
    expect(title.italic).toBe(true);
    expect(title.letter_spacing_em).toBe(0.05);
    expect(title.line_height).toBe(1.8);
    expect(title.halo).toEqual({ color: '#00ff00', width_mm: 1.5 });

    const note = layout.items.find(
      (item): item is TextItem => item.kind === 'text' && item.role === 'note',
    )!;
    const plainNote = plain.items.find(
      (item): item is TextItem => item.kind === 'text' && item.role === 'note',
    )!;
    expect(note.font_size_mm).toBe(12);
    expect(note.line_height).toBe(1.6);
    // 覆盖字号后按新字号折行:行数比默认(7.5pt×k)多
    expect(note.lines.length).toBeGreaterThan(plainNote.lines.length);

    const source = layout.items.find(
      (item): item is TextItem => item.kind === 'text' && item.role === 'source',
    )!;
    expect(source.font_size_mm).toBe(9);
    expect(source.line_height).toBe(1.5);
    // 多行来源的最后一行基线贴住页边距:块高必须用解析后的行高
    const expectedFirstY =
      layout.paper.height_mm - 10 - (source.lines.length - 1) * source.font_size_mm * 1.5;
    expect(source.y).toBeCloseTo(expectedFirstY, 9);

    expect(layout.text_style).toEqual({
      title: {
        color: '#ff0000',
        font_size_mm: 22,
        font_weight: 700,
        italic: true,
        letter_spacing_em: 0.05,
        line_height: 1.8,
        halo: { color: '#00ff00', width_mm: 1.5 },
      },
      note: { font_size_mm: 12, line_height: 1.6 },
      source: { font_size_mm: 9, line_height: 1.5 },
    });
  });

  it('地图地名覆盖:统一字号/颜色/行高/halo null 参与 y 换算,未覆盖角色不变', () => {
    const geo = geoWithMapLabels(['city', 'sea']);
    const plain = defaultPageLayout(geo);
    const layout = defaultPageLayout(geo, {
      text_style: { city: { color: '#222222', font_size_mm: 8, line_height: 1.6, halo: null } },
    });
    const city = layout.items.find(
      (item): item is TextItem => item.kind === 'text' && item.geo_label_id === 'label-city-0',
    )!;
    const cityLabel = geo.labels[0]!;
    const transform = mapTransform(geo, layout.map);
    expect(city.font_size_mm).toBe(8);
    expect(city.color).toBe('#222222');
    expect(city.line_height).toBe(1.6);
    expect(city.halo).toBeNull();
    expect(city.y).toBeCloseTo(
      transform.ty + cityLabel.y * transform.s + labelOffsetPaper(city.lines.length, 8, 1.6),
      9,
    );

    // 未覆盖的 sea 角色:逐字段等于默认(与 plain 同位置同值)
    const sea = layout.items.find(
      (item): item is TextItem => item.kind === 'text' && item.geo_label_id === 'label-sea-1',
    )!;
    const plainSea = plain.items.find(
      (item): item is TextItem => item.kind === 'text' && item.geo_label_id === 'label-sea-1',
    )!;
    expect(sea).toEqual(plainSea);
  });

  it('页面分类 halo 覆盖 null = 关光晕;地图分类 halo null 与缺省含义不同', () => {
    const geo = geoWithMapLabels(['city']);
    const pageHaloOff = defaultPageLayout(geo, { text_style: { title: { halo: null } } });
    const title = pageHaloOff.items.find(
      (item): item is TextItem => item.kind === 'text' && item.role === 'title',
    )!;
    expect(title.halo).toBeNull();
    // 页面文字默认本就无光晕;覆盖 halo 对象则打开
    const pageHaloOn = defaultPageLayout(geo, {
      text_style: { title: { halo: { color: '#123456', width_mm: 3 } } },
    });
    const titleOn = pageHaloOn.items.find(
      (item): item is TextItem => item.kind === 'text' && item.role === 'title',
    )!;
    expect(titleOn.halo).toEqual({ color: '#123456', width_mm: 3 });
  });
});

describe('applyTextStyle:分类批量应用(§3)', () => {
  it('页面分类:改覆盖并同步该分类全部 item,删除键回默认', () => {
    const geo = makeGeo();
    const layout = defaultPageLayout(geo);
    const title = layout.items.find(
      (item): item is TextItem => item.kind === 'text' && item.role === 'title',
    )!;
    // 人为加第二条标题,验证「分类批量」而不是只改第一条
    const second: TextItem = { ...title, id: layout.seq++, y: title.y + 30 };
    layout.items.push(second);

    const changed = applyTextStyle(layout, geo, 'title', {
      color: '#ff0000',
      font_size_mm: 24,
      halo: { color: '#00ff00', width_mm: 1.5 },
    });
    expect(changed).toBe(2);
    for (const item of [title, second]) {
      expect(item.color).toBe('#ff0000');
      expect(item.font_size_mm).toBe(24);
      expect(item.halo).toEqual({ color: '#00ff00', width_mm: 1.5 });
    }
    expect(layout.text_style.title).toEqual({
      color: '#ff0000',
      font_size_mm: 24,
      halo: { color: '#00ff00', width_mm: 1.5 },
    });

    // 只删颜色覆盖:字号/光晕覆盖保留,颜色回角色默认
    const reverted = applyTextStyle(layout, geo, 'title', { color: undefined });
    expect(reverted).toBe(2);
    for (const item of [title, second]) expect(item.color).toBe('#111111');
    expect(layout.text_style.title).toEqual({
      font_size_mm: 24,
      halo: { color: '#00ff00', width_mm: 1.5 },
    });
  });

  it('地图分类统一字号:全部 item 一致,按「文字块垂直中心」修正 y', () => {
    const geo = geoWithMapLabels(['city', 'city', 'area']);
    const layout = defaultPageLayout(geo);
    const scale = layout.map.width_mm / geo.base.width_pt;
    const cityItems = itemsOfTextCategory(layout, geo, 'city');
    expect(cityItems).toHaveLength(2);
    const before = cityItems.map((item) => ({
      item,
      y: item.y,
      size: item.font_size_mm,
      lineHeight: item.line_height,
      lineCount: item.lines.length,
    }));

    const changed = applyTextStyle(layout, geo, 'city', { font_size_mm: 9 });
    expect(changed).toBe(2);
    for (const snapshot of before) {
      const { item } = snapshot;
      expect(item.font_size_mm).toBe(9);
      const deltaPaper =
        labelOffsetPaper(snapshot.lineCount, 9, item.line_height) -
        labelOffsetPaper(snapshot.lineCount, snapshot.size, snapshot.lineHeight);
      expect(item.y).toBeCloseTo(snapshot.y + deltaPaper, 9);
    }
    // 未覆盖的 area 仍是「分类默认统一字号」(同一分类全部相等)
    const areaSize = mapCategoryDefaultFontSizeMm('area', geo, scale);
    for (const item of itemsOfTextCategory(layout, geo, 'area')) {
      expect(item.font_size_mm).toBe(areaSize);
    }
    expect(hasFontSizeOverride(layout, 'city')).toBe(true);
  });

  it('只改颜色也会把该分类字号统一(旧文件逐条不同 -> 收敛到默认统一字号)', () => {
    const geo = geoWithLabelSizes([
      { role: 'city', font_size_pt: 8 },
      { role: 'city', font_size_pt: 12 },
      { role: 'city', font_size_pt: 9 },
    ]);
    const layout = defaultPageLayout(geo);
    const scale = layout.map.width_mm / geo.base.width_pt;
    const expected = mapCategoryDefaultFontSizeMm('city', geo, scale);
    const items = itemsOfTextCategory(layout, geo, 'city');
    // 模拟旧 page 块:同一分类的字号逐条不同
    items[0]!.font_size_mm = 5;
    items[1]!.font_size_mm = 17;
    items[2]!.font_size_mm = 9;

    const changed = applyTextStyle(layout, geo, 'city', { color: '#123456' });
    expect(changed).toBe(3);
    for (const item of items) {
      expect(item.font_size_mm).toBe(expected);
      expect(item.color).toBe('#123456');
    }
  });

  it('手动拖过的地名在改字号后保持位置(y 差公式)', () => {
    const geo = geoWithMapLabels(['city']);
    const layout = defaultPageLayout(geo);
    const item = itemsOfTextCategory(layout, geo, 'city')[0]!;
    // 模拟用户把这条地名往下拖 7mm
    item.y += 7;
    const movedY = item.y;
    const oldSize = item.font_size_mm;
    const lineCount = item.lines.length;
    applyTextStyle(layout, geo, 'city', { font_size_mm: 12 });
    const deltaPaper =
      labelOffsetPaper(lineCount, 12, item.line_height) -
      labelOffsetPaper(lineCount, oldSize, MAP_LABEL_STYLE.line_height);
    expect(item.y).toBeCloseTo(movedY + deltaPaper, 9);
  });

  it('其它样式字段批量应用(颜色/斜体/字重/字距/行高/光晕关闭)', () => {
    const geo = geoWithMapLabels(['river', 'river']);
    const layout = defaultPageLayout(geo);
    const changed = applyTextStyle(layout, geo, 'river', {
      color: '#123456',
      italic: false,
      font_weight: 700,
      letter_spacing_em: 0.08,
      line_height: 1.5,
      halo: null,
    });
    expect(changed).toBe(2);
    for (const item of itemsOfTextCategory(layout, geo, 'river')) {
      expect(item.color).toBe('#123456');
      expect(item.italic).toBe(false);
      expect(item.font_weight).toBe(700);
      expect(item.letter_spacing_em).toBe(0.08);
      expect(item.line_height).toBe(1.5);
      expect(item.halo).toBeNull();
    }
  });

  it('applyCategoryStyleToItem:单条切角色后套新分类样式(字号排除自己)', () => {
    const geo = makeGeo();
    const layout = defaultPageLayout(geo);
    const title = layout.items.find(
      (item): item is TextItem => item.kind === 'text' && item.role === 'title',
    )!;
    const note = layout.items.find(
      (item): item is TextItem => item.kind === 'text' && item.role === 'note',
    )!;
    // 把标题改成注记角色:字号/颜色应变成 note 分类的有效值,而不是保留标题的 18pt
    const switched: TextItem = { ...title, role: 'note' };
    applyCategoryStyleToItem(layout, geo, switched);
    expect(switched.font_size_mm).toBeCloseTo(note.font_size_mm, 9);
    expect(switched.color).toBe(note.color);
    expect(switched.line_height).toBe(note.line_height);

    // 分类有覆盖时优先用覆盖值
    applyTextStyle(layout, geo, 'note', { color: '#ff0000', font_size_mm: 11 });
    const another: TextItem = { ...title, role: 'note' };
    applyCategoryStyleToItem(layout, geo, another);
    expect(another.color).toBe('#ff0000');
    expect(another.font_size_mm).toBe(11);
  });

  it('applyCategoryStyleToItem:地图 item 也按分类统一字号写回', () => {
    const geo = geoWithLabelSizes([
      { role: 'city', font_size_pt: 8 },
      { role: 'city', font_size_pt: 12 },
    ]);
    const layout = defaultPageLayout(geo);
    const scale = layout.map.width_mm / geo.base.width_pt;
    const item = itemsOfTextCategory(layout, geo, 'city')[0]!;
    // 模拟旧文件的逐条字号
    item.font_size_mm = 5;
    applyCategoryStyleToItem(layout, geo, item);
    expect(item.font_size_mm).toBe(mapCategoryDefaultFontSizeMm('city', geo, scale));
    expect(item.color).toBe(MAP_LABEL_ROLE_STYLES.city.color);
  });
});

describe('resetTextStyle:恢复代码默认(§3)', () => {
  it('页面分类:恢复默认颜色/字号/行高/光晕并删掉覆盖条目', () => {
    const geo = makeGeo();
    const layout = defaultPageLayout(geo);
    applyTextStyle(layout, geo, 'title', {
      color: '#ff0000',
      font_size_mm: 30,
      line_height: 2,
      halo: { color: '#00ff00', width_mm: 2 },
      italic: true,
    });
    const changed = resetTextStyle(layout, geo, 'title');
    expect(changed).toBe(1);
    const title = layout.items.find(
      (item): item is TextItem => item.kind === 'text' && item.role === 'title',
    )!;
    expect(title.color).toBe(PAGE_TEXT_STYLES.title.color);
    expect(title.font_size_mm).toBeCloseTo(PAGE_TEXT_DEFAULT_FONT_SIZE_MM.title, 9);
    expect(title.line_height).toBe(PAGE_TEXT_STYLES.title.line_height);
    expect(title.italic).toBe(PAGE_TEXT_STYLES.title.italic);
    expect(title.halo).toBeNull();
    expect(layout.text_style.title).toBeUndefined();
  });

  it('地图分类:字号回分类默认统一字号,y 回默认位置,颜色回角色表', () => {
    const geo = geoWithMapLabels(['city', 'city']);
    const plain = defaultPageLayout(geo);
    const plainItems = itemsOfTextCategory(plain, geo, 'city');
    const layout = defaultPageLayout(geo);
    const scale = layout.map.width_mm / geo.base.width_pt;
    const expectedSize = mapCategoryDefaultFontSizeMm('city', geo, scale);
    applyTextStyle(layout, geo, 'city', {
      color: '#222222',
      font_size_mm: 9,
      line_height: 1.6,
      halo: null,
    });
    resetTextStyle(layout, geo, 'city');
    const items = itemsOfTextCategory(layout, geo, 'city');
    items.forEach((item, index) => {
      expect(item.color).toBe(MAP_LABEL_ROLE_STYLES.city.color);
      expect(item.line_height).toBe(MAP_LABEL_STYLE.line_height);
      expect(item.halo).toEqual({
        color: MAP_LABEL_STYLE.halo_color,
        width_mm: MAP_LABEL_STYLE.halo_width_mm,
      });
      // 恢复默认后依然全分类统一
      expect(item.font_size_mm).toBe(expectedSize);
      expect(item.y).toBeCloseTo(plainItems[index]!.y, 9);
    });
    expect(layout.text_style.city).toBeUndefined();
  });
});

describe('resetTextStyleField:单字段恢复默认(样式窗口每个数值控件旁的 reset)', () => {
  it('页面分类字号:只删字号覆盖,其它覆盖保留,item 写回固定默认字号', () => {
    const geo = makeGeo();
    const layout = defaultPageLayout(geo);
    applyTextStyle(layout, geo, 'title', { color: '#ff0000', font_size_mm: 24, line_height: 2 });
    const title = layout.items.find(
      (item): item is TextItem => item.kind === 'text' && item.role === 'title',
    )!;

    const changed = resetTextStyleField(layout, geo, 'title', 'font_size_mm');
    expect(changed).toBe(1);
    expect(title.font_size_mm).toBeCloseTo(PAGE_TEXT_DEFAULT_FONT_SIZE_MM.title, 9);
    // 其它字段的覆盖不动
    expect(title.color).toBe('#ff0000');
    expect(title.line_height).toBe(2);
    expect(layout.text_style.title).toEqual({ color: '#ff0000', line_height: 2 });
  });

  it('页面分类字号没有覆盖但 item 是旧排版值(排版值):reset 也写回固定默认', () => {
    const geo = makeGeo();
    const layout = defaultPageLayout(geo);
    const title = layout.items.find(
      (item): item is TextItem => item.kind === 'text' && item.role === 'title',
    )!;
    // 模拟旧文件:item 保留早先的纸面字号,分类没有覆盖(窗口状态 = 排版值)
    title.font_size_mm = 12;
    expect(layout.text_style.title).toBeUndefined();

    const changed = resetTextStyleField(layout, geo, 'title', 'font_size_mm');
    expect(changed).toBe(1);
    expect(title.font_size_mm).toBeCloseTo(PAGE_TEXT_DEFAULT_FONT_SIZE_MM.title, 9);
    // 覆盖表不因「写默认值」新增条目
    expect(layout.text_style.title).toBeUndefined();
  });

  it('页面分类行高/字距:各自只删自己的键,值为代码默认', () => {
    const geo = makeGeo();
    const layout = defaultPageLayout(geo);
    applyTextStyle(layout, geo, 'note', { line_height: 2, letter_spacing_em: 0.2 });
    const note = layout.items.find(
      (item): item is TextItem => item.kind === 'text' && item.role === 'note',
    )!;

    expect(resetTextStyleField(layout, geo, 'note', 'line_height')).toBe(1);
    expect(note.line_height).toBe(PAGE_TEXT_STYLES.note.line_height);
    expect(layout.text_style.note).toEqual({ letter_spacing_em: 0.2 });

    expect(resetTextStyleField(layout, geo, 'note', 'letter_spacing_em')).toBe(1);
    expect(note.letter_spacing_em).toBe(PAGE_TEXT_STYLES.note.letter_spacing_em);
    // 覆盖全部回到默认后整条删除,不留空壳
    expect(layout.text_style.note).toBeUndefined();
  });

  it('地图分类字号:删覆盖后回到「分类默认统一字号」,同一分类仍严格相等', () => {
    const geo = geoWithLabelSizes([
      { role: 'city', font_size_pt: 8 },
      { role: 'city', font_size_pt: 12 },
    ]);
    const layout = defaultPageLayout(geo);
    const scale = layout.map.width_mm / geo.base.width_pt;
    const expected = mapCategoryDefaultFontSizeMm('city', geo, scale);
    applyTextStyle(layout, geo, 'city', { font_size_mm: 30 });
    expect(itemsOfTextCategory(layout, geo, 'city').map((item) => item.font_size_mm)).toEqual([
      30, 30,
    ]);

    expect(resetTextStyleField(layout, geo, 'city', 'font_size_mm')).toBe(2);
    for (const item of itemsOfTextCategory(layout, geo, 'city')) {
      expect(item.font_size_mm).toBe(expected);
    }
    expect(layout.text_style.city).toBeUndefined();
  });

  it('地图分类光晕宽度:颜色覆盖保留,宽度回默认;与默认完全相同时删掉 halo 键', () => {
    const geo = geoWithMapLabels(['river']);
    const layout = defaultPageLayout(geo);
    const river = itemsOfTextCategory(layout, geo, 'river')[0]!;

    // 只改宽度:reset 后与默认光晕完全一致,halo 键不该留(覆盖表不留冗余)
    applyTextStyle(layout, geo, 'river', {
      halo: { color: MAP_LABEL_STYLE.halo_color, width_mm: 8 },
    });
    expect(resetTextStyleField(layout, geo, 'river', 'halo_width_mm')).toBe(1);
    expect(river.halo).toEqual({
      color: MAP_LABEL_STYLE.halo_color,
      width_mm: MAP_LABEL_STYLE.halo_width_mm,
    });
    expect(layout.text_style.river).toBeUndefined();

    // 颜色也被覆盖:reset 宽度只动宽度,颜色覆盖保留
    applyTextStyle(layout, geo, 'river', {
      halo: { color: '#123456', width_mm: 8 },
    });
    expect(resetTextStyleField(layout, geo, 'river', 'halo_width_mm')).toBe(1);
    expect(river.halo).toEqual({ color: '#123456', width_mm: MAP_LABEL_STYLE.halo_width_mm });
    expect(layout.text_style.river).toEqual({
      halo: { color: '#123456', width_mm: MAP_LABEL_STYLE.halo_width_mm },
    });
  });

  it('页面分类光晕宽度:页面默认无光晕,reset 只把宽度回 TEXT_HALO,颜色覆盖保留', () => {
    const geo = makeGeo();
    const layout = defaultPageLayout(geo);
    const title = layout.items.find(
      (item): item is TextItem => item.kind === 'text' && item.role === 'title',
    )!;
    applyTextStyle(layout, geo, 'title', { halo: { color: '#00ff00', width_mm: 6 } });

    expect(resetTextStyleField(layout, geo, 'title', 'halo_width_mm')).toBe(1);
    expect(title.halo).toEqual({ color: '#00ff00', width_mm: TEXT_HALO.width_mm });
    expect(layout.text_style.title).toEqual({
      halo: { color: '#00ff00', width_mm: TEXT_HALO.width_mm },
    });
  });
});

describe('resyncTextStyles:打开后按分类重建 item 样式(唯一真源)', () => {
  it('干净排版重建 0 条(默认排版与分类一致)', () => {
    const geo = geoWithMapLabels(['city', 'river']);
    const layout = defaultPageLayout(geo);
    expect(resyncTextStyles(layout, geo)).toBe(0);
  });

  it('item 上被改过的字号/颜色/行高被分类样式覆盖,返回改动条数', () => {
    const geo = geoWithMapLabels(['city', 'city', 'river']);
    const layout = defaultPageLayout(geo);
    const texts = layout.items.filter((item): item is TextItem => item.kind === 'text');
    expect(texts.length).toBeGreaterThan(0);
    for (const item of texts) {
      item.font_size_mm = 40;
      item.color = '#ff00ff';
      item.line_height = 2;
    }
    expect(resyncTextStyles(layout, geo)).toBe(texts.length);

    // 重建结果:地图分类完全回到默认(字号也统一);页面分类的颜色/行高回到分类样式,
    // 但字号保留 item 里的值--页面默认字号随纸张 k 缩放,resync 不能把旧纸面的字号改掉.
    const fresh = defaultPageLayout(geo);
    const freshTexts = fresh.items.filter((item): item is TextItem => item.kind === 'text');
    texts.forEach((item, index) => {
      const expected = freshTexts[index]!;
      if (item.geo_label_id !== null) {
        expect(item.font_size_mm).toBeCloseTo(expected.font_size_mm, 9);
      } else {
        expect(item.font_size_mm).toBe(40);
      }
      expect(item.color).toBe(expected.color);
      expect(item.line_height).toBe(expected.line_height);
    });
    // 幂等:再跑一遍没有可改的
    expect(resyncTextStyles(layout, geo)).toBe(0);
  });

  it('页面文字按角色分类重建;覆盖表优先于默认值', () => {
    const geo = makeGeo();
    const layout = defaultPageLayout(geo);
    layout.text_style = { title: { color: '#abcdef', font_size_mm: 26 } };
    const title = layout.items.find(
      (item): item is TextItem => item.kind === 'text' && item.role === 'title',
    )!;
    title.color = '#000000';
    title.font_size_mm = 5;
    expect(resyncTextStyles(layout, geo)).toBeGreaterThan(0);
    expect(title.color).toBe('#abcdef');
    expect(title.font_size_mm).toBe(26);
  });

  it('纸张宽/方向改变但未重排:resync 不改页面字号(导出->打开幂等)', () => {
    const geo = geoWithMapLabels(['city']);
    const layout = defaultPageLayout(geo);
    const before = layout.items
      .filter((item): item is TextItem => item.kind === 'text')
      .map((item) => ({ id: item.id, size: item.font_size_mm, color: item.color }));
    // 模拟侧栏改纸张宽度:只改 paper,不重新 defaultPageLayout
    layout.paper.width_mm = 600;
    expect(resyncTextStyles(layout, geo)).toBe(0);
    const after = layout.items
      .filter((item): item is TextItem => item.kind === 'text')
      .map((item) => ({ id: item.id, size: item.font_size_mm, color: item.color }));
    expect(after).toEqual(before);
  });

  it('地图地名改名后(geo_label_id 指向的 label 文字已变)仍按分类统一,不动内容', () => {
    const geo = geoWithMapLabels(['city']);
    const layout = defaultPageLayout(geo);
    const item = mapLabels(layout)[0]!;
    item.lines = ['手动改过的地名'];
    const changed = resyncTextStyles(layout, geo);
    expect(changed).toBe(0);
    expect(item.lines).toEqual(['手动改过的地名']);
  });
});

describe('分类默认样式:与 config 真源一致(§2/§3)', () => {
  it('20 个分类的默认样式逐字段来自 config/text-style.ts', () => {
    const geo = makeGeo();
    const layout = defaultPageLayout(geo);
    expect(TEXT_STYLE_CATEGORY_IDS).toHaveLength(20);
    for (const category of TEXT_STYLE_CATEGORY_IDS) {
      const resolved = readTextCategoryStyle(layout, geo, category);
      if (TEXT_STYLE_CATEGORY_META[category].kind === 'page') {
        const style = PAGE_TEXT_STYLES[category as PageTextRole];
        expect(resolved.color).toBe(style.color);
        expect(resolved.italic).toBe(style.italic);
        expect(resolved.font_weight).toBe(style.font_weight);
        expect(resolved.letter_spacing_em).toBe(style.letter_spacing_em);
        expect(resolved.line_height).toBe(style.line_height);
        expect(resolved.halo).toEqual(style.halo);
        continue;
      }
      const roleStyle = MAP_LABEL_ROLE_STYLES[category as MapLabelRole];
      expect(resolved.color).toBe(roleStyle.color);
      expect(resolved.italic).toBe(roleStyle.italic);
      expect(resolved.font_weight).toBe(MAP_LABEL_STYLE.font_weight);
      expect(resolved.letter_spacing_em).toBe(MAP_LABEL_STYLE.letter_spacing_em);
      expect(resolved.line_height).toBe(MAP_LABEL_STYLE.line_height);
      expect(resolved.halo).toEqual({
        color: MAP_LABEL_STYLE.halo_color,
        width_mm: MAP_LABEL_STYLE.halo_width_mm,
      });
    }
  });

  it('defaultTextFontSizeMm:页面分类为固定默认字号(不随纸张缩放),地图分类为兜底字号', () => {
    const geo = makeGeo();
    const a5 = {
      preset: 'A5' as const,
      orientation: 'landscape' as const,
      width_mm: 210,
      height_mm: 148,
      locked: false,
    };
    const a5Layout = defaultPageLayout(geo, { paper: a5 });
    for (const role of ['title', 'subtitle', 'note', 'source'] as const) {
      expect(defaultTextFontSizeMm(role, a5Layout)).toBe(PAGE_TEXT_DEFAULT_FONT_SIZE_MM[role]);
    }
    // 标注/手动地名同为固定字号
    for (const role of ['annotation', 'label'] as const) {
      expect(defaultTextFontSizeMm(role, a5Layout)).toBe(PAGE_TEXT_DEFAULT_FONT_SIZE_MM[role]);
    }
    // A4 横向与 A5 横向的页面默认字号一致(取消「随纸张大小缩放」)
    const a4Layout = defaultPageLayout(geo);
    for (const role of ['title', 'subtitle', 'note', 'source'] as const) {
      expect(defaultTextFontSizeMm(role, a4Layout)).toBe(defaultTextFontSizeMm(role, a5Layout));
    }
    expect(defaultTextFontSizeMm('title', a4Layout)).toBeCloseTo(6, 9);
    expect(defaultTextFontSizeMm('note', a4Layout)).toBeCloseTo(3, 9);
    for (const category of MAP_LABEL_ROLES) {
      expect(defaultTextFontSizeMm(category, a4Layout)).toBe(MAP_LABEL_DEFAULT_FONT_SIZE_MM);
    }
  });

  it('readTextCategoryStyle 字号:地图分类恒为「覆盖 ?? 分类默认统一字号」', () => {
    const geo = geoWithLabelSizes([
      { role: 'city', font_size_pt: 8 },
      { role: 'city', font_size_pt: 12 },
    ]);
    const layout = defaultPageLayout(geo);
    const scale = layout.map.width_mm / geo.base.width_pt;
    const expected = mapCategoryDefaultFontSizeMm('city', geo, scale);

    // 1) 没写覆盖:显示分类默认统一字号,不读第一条 item 的实际字号(否则旧文件会与写回值不一致)
    const cityItems = itemsOfTextCategory(layout, geo, 'city');
    cityItems[0]!.font_size_mm = 5; // 模拟旧 page 块逐条不同的字号
    expect(readTextCategoryStyle(layout, geo, 'city').font_size_mm).toBe(expected);
    // 该分类没有地名(area 没有 label):回退 MAP_LABEL_DEFAULT_FONT_SIZE_MM
    expect(readTextCategoryStyle(layout, geo, 'area').font_size_mm).toBe(
      MAP_LABEL_DEFAULT_FONT_SIZE_MM,
    );
    // 2) 写覆盖后优先覆盖(改任意字段都会把 item 统一到该口径)
    applyTextStyle(layout, geo, 'city', { color: '#123456' });
    expect(readTextCategoryStyle(layout, geo, 'city').font_size_mm).toBe(expected);
    for (const item of itemsOfTextCategory(layout, geo, 'city')) {
      expect(item.font_size_mm).toBe(expected);
    }
    applyTextStyle(layout, geo, 'city', { font_size_mm: 7 });
    expect(readTextCategoryStyle(layout, geo, 'city').font_size_mm).toBe(7);

    // 页面分类:覆盖 ?? 该分类现有 item 的字号 ?? 默认字号.纸张缩放变化时 item 里
    // 保存的是旧纸面的字号,窗口必须显示它(否则导出->打开会被 resync 改字号并误标脏)
    const title = layout.items.find(
      (item): item is TextItem => item.kind === 'text' && item.role === 'title',
    )!;
    title.font_size_mm = 5; // 模拟纸张改宽后 item 里的旧纸面字号
    expect(readTextCategoryStyle(layout, geo, 'title').font_size_mm).toBe(5);
    applyTextStyle(layout, geo, 'title', { font_size_mm: 26 });
    expect(readTextCategoryStyle(layout, geo, 'title').font_size_mm).toBe(26);
  });
});
