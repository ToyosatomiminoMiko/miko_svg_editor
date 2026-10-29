/**
 * 文字样式单一真源（`config/text-style.ts`）与 geo v2 样式/坐标换算的单测。
 *
 * 为什么要有这些用例：geo v2 把样式从生成端搬到前端后，颜色/斜体必须按 role 查表，
 * 字重/字距/行高/描边必须是全局常量；同时地名 `y` 的语义从「第一行基线」改成「文字块垂直中心」，
 * 前端换算必须与旧实现视觉等价。这些口径都是「改风格只改一处」的前提，所以逐条钉住。
 * 元信息：作者 frontend，2026-10-29，随 geo v2 文字样式统一落地。
 */

import { describe, expect, it } from 'vitest';
import {
  MAP_LABEL_ROLES,
  MAP_LABEL_ROLE_STYLES,
  MAP_LABEL_STYLE,
  PAGE_TEXT_STYLES,
  TEXT_HALO,
  type MapLabelRole,
} from '../../src/config/text-style';
import { validateGeo, type Geo, type PageLayout, type TextItem } from '../../src/core/page';
import {
  defaultPageLayout,
  fallbackTextMeasure,
  fontShorthand,
  textBlockWidth,
} from '../../src/core/page-layout';
import { makeDocument, makeGeo } from '../fixtures/page-fixtures';

/** 用 geo 生成默认排版（打开流程：normalizeGeo → defaultPageLayout） */
function layoutOf(geo: Geo): PageLayout {
  return defaultPageLayout(makeDocument(geo).geo);
}

/** 默认排版里的 map 空间文字（地名标注），保持 geo.labels 的 order 顺序 */
function mapLabels(layout: PageLayout): TextItem[] {
  return layout.items.filter(
    (item): item is TextItem => item.kind === 'text' && item.space === 'map',
  );
}

/** 把 geo 复制成可随意改字段的普通对象 */
function mutableGeo(geo: Geo): Record<string, unknown> {
  return structuredClone(geo) as unknown as Record<string, unknown>;
}

describe('MAP_LABEL_ROLE_STYLES：§2 角色表', () => {
  it('14 个 role，颜色/斜体与规格逐字一致', () => {
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

describe('MAP_LABEL_STYLE：全局标注常量', () => {
  it('字重/字距/行高/描边宽度全部来自 MAP_LABEL_STYLE，旋转固定 0', () => {
    for (const item of mapLabels(layoutOf(makeGeo()))) {
      expect(item.font_weight).toBe(MAP_LABEL_STYLE.font_weight);
      expect(item.letter_spacing_em).toBe(MAP_LABEL_STYLE.letter_spacing_em);
      expect(item.line_height).toBe(MAP_LABEL_STYLE.line_height);
      expect(item.halo).toEqual({
        color: MAP_LABEL_STYLE.halo_color,
        width_pt: MAP_LABEL_STYLE.halo_width_pt,
      });
      expect(item.rotation_deg).toBe(0);
    }
  });

  it('常量取值与规格一致（400 / 0 / 1.2 / #ffffff / 2 / 0.36）', () => {
    expect(MAP_LABEL_STYLE).toEqual({
      font_weight: 400,
      letter_spacing_em: 0,
      line_height: 1.2,
      halo_color: '#ffffff',
      halo_width_pt: 2,
      baseline_ratio: 0.36,
    });
  });
});

describe('geo v2：文字块垂直中心 → 第一行基线', () => {
  it('单行：基线 = 中心 + baseline_ratio × 字号（换算回 map 坐标）', () => {
    const geo = makeGeo();
    const layout = layoutOf(geo);
    const scale = layout.map.width_pt / geo.base.width_pt;
    const item = mapLabels(layout)[0]!;
    const label = geo.labels[0]!;

    expect(item.lines).toEqual(['甲国']);
    // 纸面坐标：基线 = 中心 + 0.36 × size
    expect((item.y - label.y) * scale).toBeCloseTo(
      MAP_LABEL_STYLE.baseline_ratio * item.font_size_pt,
      9,
    );
    expect(item.y).toBeCloseTo(
      label.y + (MAP_LABEL_STYLE.baseline_ratio * item.font_size_pt) / scale,
      9,
    );
  });

  it('多行：整块中心到第一行基线再减 (行数-1)×step/2', () => {
    const geo = makeGeo();
    const layout = layoutOf(geo);
    const scale = layout.map.width_pt / geo.base.width_pt;
    const item = mapLabels(layout)[1]!;
    const label = geo.labels[1]!;

    expect(item.lines).toEqual(['乙河', '第二行']);
    const step = item.font_size_pt * MAP_LABEL_STYLE.line_height;
    const offsetPaper =
      MAP_LABEL_STYLE.baseline_ratio * item.font_size_pt - ((item.lines.length - 1) * step) / 2;
    expect((item.y - label.y) * scale).toBeCloseTo(offsetPaper, 9);
    expect(item.y).toBeCloseTo(label.y + offsetPaper / scale, 9);
  });

  it('字号仍按地图缩放 s 换算并夹到 4..40pt', () => {
    const geo = makeGeo();
    const layout = layoutOf(geo);
    const scale = layout.map.width_pt / geo.base.width_pt;
    for (const item of mapLabels(layout)) {
      expect(item.font_size_pt).toBeGreaterThanOrEqual(4);
      expect(item.font_size_pt).toBeLessThanOrEqual(40);
    }
    expect(mapLabels(layout)[0]!.font_size_pt).toBeCloseTo(12 * scale, 9);
  });
});

describe('PAGE_TEXT_STYLES / TEXT_HALO：页面文字默认样式', () => {
  it('六个角色全部 400/0/1.35/无光晕/#111111', () => {
    const roles = ['title', 'subtitle', 'label', 'annotation', 'note', 'source'] as const;
    for (const role of roles) {
      expect(PAGE_TEXT_STYLES[role]).toEqual({
        color: '#111111',
        italic: false,
        font_weight: 400,
        letter_spacing_em: 0,
        line_height: 1.35,
        halo: null,
      });
    }
    expect(TEXT_HALO).toEqual({ color: '#ffffff', width_pt: 2 });
  });

  it('默认排版的页面文字 item 用角色样式，注记/来源块高用对应行高', () => {
    const layout = layoutOf(makeGeo());
    const pageTexts = layout.items.filter(
      (item): item is TextItem => item.kind === 'text' && item.space === 'page',
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

describe('fontShorthand / textBlockWidth：字重与字距口径', () => {
  it('400 保持旧串，非 400 前置字重（仍能被字号解析）', () => {
    expect(fontShorthand(12, 'sans-serif')).toBe('12px sans-serif');
    expect(fontShorthand(12, 'sans-serif', 400)).toBe('12px sans-serif');
    expect(fontShorthand(12, 'sans-serif', 700)).toBe('700 12px sans-serif');
    // 无 DOM 估算器从简写里取字号：不能被字重数字骗到
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
      space: 'page',
      x: 0,
      y: 0,
      font_size_pt: 10,
      font_weight: 400,
      line_height: 1.35,
      font_family: null,
      lines: ['甲乙丙'],
      letter_spacing_em: 0,
    };
    // 3 个 CJK 字符 × 10pt = 30pt
    expect(textBlockWidth(item, fallbackTextMeasure.width, 'sans-serif')).toBeCloseTo(30, 9);
    // 字距 0.5em：+ 0.5 × 10 × (3-1) = +10pt
    expect(
      textBlockWidth({ ...item, letter_spacing_em: 0.5 }, fallbackTextMeasure.width, 'sans-serif'),
    ).toBeCloseTo(40, 9);
    // 负字距同样只作用在字符之间（不会把宽度算成负数）
    expect(
      textBlockWidth({ ...item, letter_spacing_em: -0.1 }, fallbackTextMeasure.width, 'sans-serif'),
    ).toBeCloseTo(28, 9);
  });
});

describe('validateGeo：v2 契约与 labels 逐条校验', () => {
  it('完整 v2 geo 通过', () => {
    expect(validateGeo(makeGeo())).toEqual([]);
  });

  it('拒绝 v1 并给出重新生成文案', () => {
    const geo = mutableGeo(makeGeo());
    geo['version'] = 1;
    expect(validateGeo(geo)).toContain('geo.version: 旧 v1 契约，请用更新后的 Cartopy 重新生成');
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
