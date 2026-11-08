/**
 * 页面文字「自动折行」的单测:注记与来源在默认排版写入折行字段,宽度/字号/字距变化后
 * 重算 lines,来源按页底对齐,手动换行保留,非自动折行角色不受影响,旧 page 块打开时
 * 补齐并能稳定往返.
 *
 * 为什么单独一份:折行是「派生约束」(lines 由 text + 宽度 + 字体测量推出),涉及
 * `core/page.ts` 的字段校验/规范化,`core/page-layout.ts` 的 enforceAutoWrap 与默认排版,
 * `core/open-map.ts` 的打开补齐三处;集中在一份文件里能一次跑完往返(idempotent)口径.
 * 为什么注记与来源共用一份:两者是同一套契约(`isAutoWrapTextItem`),只有默认摆放不同
 * (注记首行固定,来源页底对齐),同一份用例能保证两条路径不会各自漂移.
 * 元信息:作者 ToyosatomiminoMiko,2026-11-06.
 */

import { describe, expect, it } from 'vitest';
import { PAGE_AUTO_WRAP_MIN_MM, PAGE_DEFAULT_MARGIN_MM } from '../../src/config/page';
import {
  isAutoWrapTextItem,
  normalizePage,
  roundToPageDecimals,
  serializeMapDocFile,
  textContentOf,
  validatePage,
  type PageLayout,
  type TextItem,
  type TextRole,
} from '../../src/core/page';
import {
  defaultPageLayout,
  enforceAutoWrap,
  fallbackMeasureText,
  fontShorthand,
} from '../../src/core/page-layout';
import { openMapFromUploads, type MapUploadFile } from '../../src/core/open-map';
import { BASE_SVG_TEXT, makeDocument } from '../fixtures/page-fixtures';

const document = makeDocument();
const geo = document.geo;

/** 取一份默认排版里指定角色的页面文字 item;没有就抛(默认排版一定有) */
function pageTextOf(layout: PageLayout, role: TextRole): TextItem {
  const item = layout.items.find(
    (candidate): candidate is TextItem =>
      candidate.kind === 'text' && candidate.role === role && candidate.geo_label_id === null,
  );
  if (item === undefined) throw new Error(`排版里缺少 ${role} item`);
  return item;
}

const noteOf = (layout: PageLayout): TextItem => pageTextOf(layout, 'note');
const sourceOf = (layout: PageLayout): TextItem => pageTextOf(layout, 'source');
const titleOf = (layout: PageLayout): TextItem => pageTextOf(layout, 'title');

/** 折行结果里最长一行的前进宽度(按无 DOM 估算,与默认排版同一口径) */
function widestLine(item: TextItem, layout: PageLayout): number {
  const font = fontShorthand(
    item.font_size_mm,
    item.font_family ?? layout.style.font_family,
    item.font_weight,
  );
  const spacing = item.letter_spacing_em * item.font_size_mm;
  return Math.max(
    0,
    ...item.lines.map(
      (line) => fallbackMeasureText(line, font) + spacing * Math.max(0, [...line].length - 1),
    ),
  );
}

/** 行距步长(pt):字号 × 行高 */
function stepOf(item: TextItem): number {
  return item.font_size_mm * item.line_height;
}

/** 文字块最后一行的基线 y;来源靠它判定「页底对齐」是否被折行破坏 */
function lastBaselineOf(item: TextItem): number {
  return item.y + (item.lines.length - 1) * stepOf(item);
}

function fileOf(name: string, text: string): MapUploadFile {
  return { name, bytes: new TextEncoder().encode(text) };
}

describe('默认排版:注记与来源都带原始内容与折行宽度', () => {
  it('注记:lines 由 text 按 wrap_width_mm 折出来,且不超过宽度', () => {
    const layout = defaultPageLayout(geo);
    const note = noteOf(layout);
    expect(note.text).toBe(geo.suggestions.notes.join('\n'));
    expect(note.wrap_width_mm).not.toBeNull();
    expect(note.wrap_width_mm ?? 0).toBeGreaterThan(PAGE_AUTO_WRAP_MIN_MM);
    // fixture 的注记文案超过右栏宽度:默认排版即折成多行
    expect(note.lines.length).toBeGreaterThan(1);
    expect(widestLine(note, layout)).toBeLessThanOrEqual((note.wrap_width_mm ?? 0) + 1e-9);
  });

  it('来源:左右居中,原始文案与内容宽落盘,最后一行仍贴页底边距', () => {
    const layout = defaultPageLayout(geo);
    const source = sourceOf(layout);
    expect(source.text).toBe(geo.suggestions.source);
    expect(source.center_h).toBe(true);
    expect(source.anchor).toBe('middle');
    expect(source.x).toBe(roundToPageDecimals(layout.paper.width_mm / 2));
    // 居中文案的折行宽度 = 初始版式内容宽(左右各内缩 10mm),不是半页宽
    const contentWidth = roundToPageDecimals(layout.paper.width_mm - 20);
    expect(source.wrap_width_mm).toBe(contentWidth);
    expect(widestLine(source, layout)).toBeLessThanOrEqual(contentWidth + 1e-9);
    expect(lastBaselineOf(source)).toBeCloseTo(layout.paper.height_mm - 10, 6);
  });

  it('只有注记/来源带自动折行字段;标题/地图地名全为 null', () => {
    const layout = defaultPageLayout(geo);
    for (const item of layout.items) {
      if (item.kind !== 'text') continue;
      expect(isAutoWrapTextItem(item)).toBe(
        item.geo_label_id === null && (item.role === 'note' || item.role === 'source'),
      );
      if (!isAutoWrapTextItem(item)) {
        expect(item.text).toBeNull();
        expect(item.wrap_width_mm).toBeNull();
      }
    }
  });

  it('textContentOf:开启折行返回原始内容,否则拼回 lines', () => {
    const layout = defaultPageLayout(geo);
    expect(textContentOf(noteOf(layout))).toBe(noteOf(layout).text ?? '');
    expect(textContentOf(sourceOf(layout))).toBe(sourceOf(layout).text ?? '');
    const title = titleOf(layout);
    expect(textContentOf(title)).toBe(title.lines.join('\n'));
  });
});

describe('enforceAutoWrap:可重复执行,随内容/宽度/字号/字距重排', () => {
  it('默认排版自洽:再跑一次 0 改动', () => {
    const layout = defaultPageLayout(geo);
    expect(enforceAutoWrap(layout)).toBe(0);
    expect(enforceAutoWrap(layout)).toBe(0);
  });

  it('注记改窄宽度行数变多;改回原宽度恢复原 lines(原始内容没被折断弄丢)', () => {
    const layout = defaultPageLayout(geo);
    const original = [...noteOf(layout).lines];
    const wide = noteOf(layout).wrap_width_mm ?? 0;
    const narrow = Math.max(PAGE_AUTO_WRAP_MIN_MM, wide / 2);
    noteOf(layout).wrap_width_mm = narrow;
    expect(enforceAutoWrap(layout)).toBeGreaterThan(0);
    const narrowCount = noteOf(layout).lines.length;
    expect(narrowCount).toBeGreaterThan(original.length);

    noteOf(layout).wrap_width_mm = wide;
    expect(enforceAutoWrap(layout)).toBeGreaterThan(0);
    expect(noteOf(layout).lines).toEqual(original);
  });

  it('注记字号变大会重排(字号参与前进宽度)', () => {
    const layout = defaultPageLayout(geo);
    const before = noteOf(layout).lines.length;
    noteOf(layout).font_size_mm = noteOf(layout).font_size_mm * 2;
    expect(enforceAutoWrap(layout)).toBeGreaterThan(0);
    expect(noteOf(layout).lines.length).toBeGreaterThan(before);
  });

  it('注记字距变大同样参与折行测量', () => {
    const layout = defaultPageLayout(geo);
    const note = noteOf(layout);
    note.wrap_width_mm = 120;
    note.letter_spacing_em = 0;
    enforceAutoWrap(layout);
    const noSpacing = note.lines.length;

    note.letter_spacing_em = 1;
    expect(enforceAutoWrap(layout)).toBeGreaterThan(0);
    expect(note.lines.length).toBeGreaterThan(noSpacing);
  });

  it('来源内容变长:自动折行且块向上长,最后一行基线不动', () => {
    const layout = defaultPageLayout(geo);
    const source = sourceOf(layout);
    const baselineBefore = lastBaselineOf(source);
    const yBefore = source.y;
    source.text = `数据来源:${'地形与版权说明文字'.repeat(20)}`;
    expect(enforceAutoWrap(layout)).toBeGreaterThan(0);
    expect(source.lines.length).toBeGreaterThan(1);
    expect(source.y).toBeLessThan(yBefore);
    // 行数变化只让块向上长,页底那一行不跟着下移
    expect(Math.abs(lastBaselineOf(source) - baselineBefore)).toBeLessThan(0.002);
    expect(widestLine(source, layout)).toBeLessThanOrEqual((source.wrap_width_mm ?? 0) + 1e-9);
  });

  it('来源折行宽度改小 -> 行数变多;改回原宽度恢复原分行', () => {
    const layout = defaultPageLayout(geo);
    const source = sourceOf(layout);
    source.text = `数据来源:${'地形与版权说明文字'.repeat(20)}`;
    enforceAutoWrap(layout);
    const original = [...source.lines];
    const wide = source.wrap_width_mm ?? 0;

    source.wrap_width_mm = Math.max(PAGE_AUTO_WRAP_MIN_MM, wide / 2);
    expect(enforceAutoWrap(layout)).toBeGreaterThan(0);
    expect(source.lines.length).toBeGreaterThan(original.length);

    source.wrap_width_mm = wide;
    expect(enforceAutoWrap(layout)).toBeGreaterThan(0);
    expect(source.lines).toEqual(original);
  });

  it('来源字号变大后重排,最后一行不会掉出页底边距', () => {
    const layout = defaultPageLayout(geo);
    const source = sourceOf(layout);
    source.text = `数据来源:${'地形与版权说明文字'.repeat(20)}`;
    enforceAutoWrap(layout);
    const before = source.lines.length;
    source.font_size_mm = source.font_size_mm * 2;
    expect(enforceAutoWrap(layout)).toBeGreaterThan(0);
    expect(source.lines.length).toBeGreaterThan(before);
    const pageBottom = layout.paper.height_mm - PAGE_DEFAULT_MARGIN_MM;
    // y 收敛到 3 位小数,兜底后的最后一行最多超出台面半千分之一 pt(可忽略)
    expect(lastBaselineOf(source)).toBeLessThanOrEqual(pageBottom + 0.001);
  });

  it('手动换行保留为强制分段;强制换行不参与折行合并(注记与来源同一口径)', () => {
    const layout = defaultPageLayout(geo);
    const note = noteOf(layout);
    note.text = '第一段文字\n第二段文字';
    note.wrap_width_mm = 500;
    expect(enforceAutoWrap(layout)).toBeGreaterThan(0);
    expect(note.lines).toEqual(['第一段文字', '第二段文字']);

    const source = sourceOf(layout);
    source.text = '来源第一段\n来源第二段';
    source.wrap_width_mm = 500;
    expect(enforceAutoWrap(layout)).toBeGreaterThan(0);
    expect(source.lines).toEqual(['来源第一段', '来源第二段']);
  });

  it('空内容保留一条空行(契约要求 lines 至少 1 行)', () => {
    const layout = defaultPageLayout(geo);
    const note = noteOf(layout);
    note.text = '';
    expect(enforceAutoWrap(layout)).toBeGreaterThan(0);
    expect(note.lines).toEqual(['']);
  });

  it('宽度夹到下限并收敛到 3 位小数(与 page 落盘精度一致)', () => {
    const layout = defaultPageLayout(geo);
    const source = sourceOf(layout);
    source.wrap_width_mm = 5;
    expect(enforceAutoWrap(layout)).toBeGreaterThan(0);
    expect(source.wrap_width_mm).toBe(PAGE_AUTO_WRAP_MIN_MM);

    source.wrap_width_mm = 123.45678;
    expect(enforceAutoWrap(layout)).toBeGreaterThan(0);
    expect(source.wrap_width_mm).toBe(123.457);
  });

  it('非自动折行文字被清掉折行字段,lines 保持不变', () => {
    const layout = defaultPageLayout(geo);
    const title = titleOf(layout);
    const lines = [...title.lines];
    title.text = '被误写的内容';
    title.wrap_width_mm = 60;
    expect(enforceAutoWrap(layout)).toBeGreaterThan(0);
    expect(title.text).toBeNull();
    expect(title.wrap_width_mm).toBeNull();
    expect(title.lines).toEqual(lines);
  });
});

describe('契约字段:校验与规范化', () => {
  it('validatePage:注记/来源带折行字段合法;负宽度与其它角色上的字段报错', () => {
    const layout = defaultPageLayout(geo);
    const parsed = JSON.parse(serializeMapDocFile(geo, layout)) as {
      page: Record<string, unknown>;
    };
    const page = parsed.page;
    expect(validatePage(page, geo).ok).toBe(true);

    const badPage = structuredClone(page);
    const sourceItem = (badPage['items'] as Record<string, unknown>[]).find(
      (item) => item['role'] === 'source',
    );
    if (sourceItem === undefined) throw new Error('page 块缺少来源 item');
    sourceItem['wrap_width_mm'] = -1;
    const bad = validatePage(badPage, geo);
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors.some((error) => error.includes('wrap_width_mm'))).toBe(true);

    const movedPage = structuredClone(page);
    const titleItem = (movedPage['items'] as Record<string, unknown>[]).find(
      (item) => item['role'] === 'title',
    );
    if (titleItem === undefined) throw new Error('page 块缺少标题 item');
    titleItem['text'] = '标题不该自动折行';
    titleItem['wrap_width_mm'] = 100;
    const moved = validatePage(movedPage, geo);
    expect(moved.ok).toBe(false);
    if (moved.ok) return;
    expect(moved.errors.some((error) => error.includes('只有页面注记/来源'))).toBe(true);
  });

  it('normalizePage:保留注记/来源字段,清掉其它文字上的残留字段', () => {
    const layout = defaultPageLayout(geo);
    const title = titleOf(layout);
    title.text = '残留';
    title.wrap_width_mm = 88;
    const normalized = normalizePage(layout);
    const normalizedNote = noteOf(normalized);
    expect(normalizedNote.text).toBe(noteOf(layout).text);
    expect(normalizedNote.wrap_width_mm).toBe(noteOf(layout).wrap_width_mm);
    const normalizedSource = sourceOf(normalized);
    expect(normalizedSource.text).toBe(sourceOf(layout).text);
    expect(normalizedSource.wrap_width_mm).toBe(sourceOf(layout).wrap_width_mm);
    const normalizedTitle = titleOf(normalized);
    expect(normalizedTitle.text).toBeNull();
    expect(normalizedTitle.wrap_width_mm).toBeNull();
  });
});

describe('打开旧 page 块:补齐折行字段并保持导出一致', () => {
  it('旧排版没有 text/wrap_width_mm -> 注记与来源都补齐并标脏,再导出重开干净', () => {
    const layout = defaultPageLayout(geo);
    const exported = serializeMapDocFile(geo, layout);
    const parsed = JSON.parse(exported) as { page: { items: Record<string, unknown>[] } };
    // 模拟本次改动前导出的 page 块:文字 item 没有自动折行字段
    for (const item of parsed.page.items) {
      if (item['kind'] !== 'text') continue;
      delete item['text'];
      delete item['wrap_width_mm'];
    }
    const legacyText = `${JSON.stringify(parsed, null, 2)}\n`;

    const opened = openMapFromUploads([
      fileOf('fixture.svg', BASE_SVG_TEXT),
      fileOf('fixture.geo.json', legacyText),
    ]);
    expect(opened.dirty).toBe(true);
    expect(opened.warnings.some((warning) => warning.includes('注记/来源'))).toBe(true);

    // 补齐后按「已折好的 lines」当原始内容,行本身不变;来源仍贴页底
    const openedSource = sourceOf(opened.layout);
    expect(openedSource.wrap_width_mm).not.toBeNull();
    expect(openedSource.text).not.toBeNull();
    expect(openedSource.text).toBe(openedSource.lines.join('\n'));
    expect(lastBaselineOf(openedSource)).toBeCloseTo(opened.layout.paper.height_mm - 10, 6);
    // 注记按「x 到右页边距」补宽度,也不再是 null
    const openedNote = noteOf(opened.layout);
    expect(openedNote.wrap_width_mm).not.toBeNull();
    expect(openedNote.text).not.toBeNull();

    // 导出 -> 重新打开 -> 再导出:字节稳定,且不再标脏/告警
    const reExported = serializeMapDocFile(opened.document.geo, opened.layout);
    const reopened = openMapFromUploads([
      fileOf('fixture.svg', BASE_SVG_TEXT),
      fileOf('fixture.geo.json', reExported),
    ]);
    expect(reopened.dirty).toBe(false);
    expect(reopened.warnings).toEqual([]);
    expect(serializeMapDocFile(reopened.document.geo, reopened.layout)).toBe(reExported);
  });
});
