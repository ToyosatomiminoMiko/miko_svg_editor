/**
 * 注记自动折行的单测:默认排版写入折行字段,宽度/字号/字距变化后重算 lines,
 * 手动换行保留,非注记文字不受影响,旧 page 块打开时补齐并能稳定往返.
 *
 * 为什么单独一份:折行是「派生约束」(lines 由 text + 宽度 + 字体测量推出),涉及
 * `core/page.ts` 的字段校验/规范化,`core/page-layout.ts` 的 enforceNoteWrap 与默认排版,
 * `core/open-map.ts` 的打开补齐三处;集中在一份文件里能一次跑完往返(idempotent)口径.
 * 元信息:作者 ToyosatomiminoMiko,2026-11-06.
 */

import { describe, expect, it } from 'vitest';
import { PAGE_NOTE_WRAP_MIN_PT } from '../../src/config/page';
import {
  isAutoWrapTextItem,
  normalizePage,
  serializeMapDocFile,
  textContentOf,
  validatePage,
  type PageLayout,
  type TextItem,
} from '../../src/core/page';
import {
  defaultPageLayout,
  enforceNoteWrap,
  fallbackMeasureText,
  fontShorthand,
} from '../../src/core/page-layout';
import { openMapFromUploads, type MapUploadFile } from '../../src/core/open-map';
import { BASE_SVG_TEXT, makeDocument } from '../fixtures/page-fixtures';

const document = makeDocument();
const geo = document.geo;

/** 取一份默认排版里的注记 item;没有就抛(fixture 一定有 suggestions.notes) */
function noteOf(layout: PageLayout): TextItem {
  const item = layout.items.find(
    (candidate): candidate is TextItem =>
      candidate.kind === 'text' && candidate.role === 'note' && candidate.space === 'page',
  );
  if (item === undefined) throw new Error('排版里缺少注记 item');
  return item;
}

/** 取默认排版里的第一条标题 item */
function titleOf(layout: PageLayout): TextItem {
  const item = layout.items.find(
    (candidate): candidate is TextItem =>
      candidate.kind === 'text' && candidate.role === 'title' && candidate.space === 'page',
  );
  if (item === undefined) throw new Error('排版里缺少标题 item');
  return item;
}

/** 折行结果里最长一行的前进宽度(按无 DOM 估算,与默认排版同一口径) */
function widestLine(item: TextItem, layout: PageLayout): number {
  const font = fontShorthand(
    item.font_size_pt,
    item.font_family ?? layout.style.font_family,
    item.font_weight,
  );
  const spacing = item.letter_spacing_em * item.font_size_pt;
  return Math.max(
    0,
    ...item.lines.map(
      (line) => fallbackMeasureText(line, font) + spacing * Math.max(0, [...line].length - 1),
    ),
  );
}

function fileOf(name: string, text: string): MapUploadFile {
  return { name, bytes: new TextEncoder().encode(text) };
}

describe('默认排版:注记带原始内容与折行宽度', () => {
  it('lines 由 text 按 wrap_width_pt 折出来,且不超过宽度', () => {
    const layout = defaultPageLayout(geo);
    const note = noteOf(layout);
    expect(note.text).toBe(geo.suggestions.notes.join('\n'));
    expect(note.wrap_width_pt).not.toBeNull();
    expect(note.wrap_width_pt ?? 0).toBeGreaterThan(PAGE_NOTE_WRAP_MIN_PT);
    // fixture 的注记文案超过右栏宽度:默认排版即折成多行
    expect(note.lines.length).toBeGreaterThan(1);
    expect(widestLine(note, layout)).toBeLessThanOrEqual((note.wrap_width_pt ?? 0) + 1e-9);
  });

  it('只有注记带自动折行字段;标题/来源/地图地名全为 null', () => {
    const layout = defaultPageLayout(geo);
    for (const item of layout.items) {
      if (item.kind !== 'text') continue;
      expect(isAutoWrapTextItem(item)).toBe(item.role === 'note' && item.space === 'page');
      if (!isAutoWrapTextItem(item)) {
        expect(item.text).toBeNull();
        expect(item.wrap_width_pt).toBeNull();
      }
    }
  });

  it('textContentOf:开启折行返回原始内容,否则拼回 lines', () => {
    const layout = defaultPageLayout(geo);
    const note = noteOf(layout);
    expect(textContentOf(note)).toBe(note.text ?? '');
    const title = titleOf(layout);
    expect(textContentOf(title)).toBe(title.lines.join('\n'));
  });
});

describe('enforceNoteWrap:可重复执行,随内容/宽度/字号/字距重排', () => {
  it('默认排版自洽:再跑一次 0 改动', () => {
    const layout = defaultPageLayout(geo);
    expect(enforceNoteWrap(layout)).toBe(0);
    expect(enforceNoteWrap(layout)).toBe(0);
  });

  it('改窄宽度行数变多;改回原宽度恢复原 lines(原始内容没被折断弄丢)', () => {
    const layout = defaultPageLayout(geo);
    const original = [...noteOf(layout).lines];
    const wide = noteOf(layout).wrap_width_pt ?? 0;
    const narrow = Math.max(PAGE_NOTE_WRAP_MIN_PT, wide / 2);
    noteOf(layout).wrap_width_pt = narrow;
    expect(enforceNoteWrap(layout)).toBeGreaterThan(0);
    const narrowCount = noteOf(layout).lines.length;
    expect(narrowCount).toBeGreaterThan(original.length);

    noteOf(layout).wrap_width_pt = wide;
    expect(enforceNoteWrap(layout)).toBeGreaterThan(0);
    expect(noteOf(layout).lines).toEqual(original);
  });

  it('字号变大会重排(字号参与前进宽度)', () => {
    const layout = defaultPageLayout(geo);
    const before = noteOf(layout).lines.length;
    noteOf(layout).font_size_pt = noteOf(layout).font_size_pt * 2;
    expect(enforceNoteWrap(layout)).toBeGreaterThan(0);
    expect(noteOf(layout).lines.length).toBeGreaterThan(before);
  });

  it('字距变大同样参与折行测量', () => {
    const layout = defaultPageLayout(geo);
    const note = noteOf(layout);
    note.wrap_width_pt = 120;
    note.letter_spacing_em = 0;
    enforceNoteWrap(layout);
    const noSpacing = note.lines.length;

    note.letter_spacing_em = 1;
    expect(enforceNoteWrap(layout)).toBeGreaterThan(0);
    expect(note.lines.length).toBeGreaterThan(noSpacing);
  });

  it('手动换行保留为强制分段;强制换行不参与折行合并', () => {
    const layout = defaultPageLayout(geo);
    const note = noteOf(layout);
    note.text = '第一段文字\n第二段文字';
    note.wrap_width_pt = 500;
    expect(enforceNoteWrap(layout)).toBeGreaterThan(0);
    expect(note.lines).toEqual(['第一段文字', '第二段文字']);
  });

  it('空内容保留一条空行(契约要求 lines 至少 1 行)', () => {
    const layout = defaultPageLayout(geo);
    const note = noteOf(layout);
    note.text = '';
    expect(enforceNoteWrap(layout)).toBeGreaterThan(0);
    expect(note.lines).toEqual(['']);
  });

  it('宽度夹到下限并收敛到 3 位小数(与 page 落盘精度一致)', () => {
    const layout = defaultPageLayout(geo);
    const note = noteOf(layout);
    note.wrap_width_pt = 5;
    expect(enforceNoteWrap(layout)).toBeGreaterThan(0);
    expect(note.wrap_width_pt).toBe(PAGE_NOTE_WRAP_MIN_PT);

    note.wrap_width_pt = 123.45678;
    expect(enforceNoteWrap(layout)).toBeGreaterThan(0);
    expect(note.wrap_width_pt).toBe(123.457);
  });

  it('非注记文字被清掉折行字段,lines 保持不变', () => {
    const layout = defaultPageLayout(geo);
    const title = titleOf(layout);
    const lines = [...title.lines];
    title.text = '被误写的内容';
    title.wrap_width_pt = 60;
    expect(enforceNoteWrap(layout)).toBeGreaterThan(0);
    expect(title.text).toBeNull();
    expect(title.wrap_width_pt).toBeNull();
    expect(title.lines).toEqual(lines);
  });
});

describe('契约字段:校验与规范化', () => {
  it('validatePage:注记带折行字段合法;折行字段出现在标题/地图地名上报错', () => {
    const layout = defaultPageLayout(geo);
    const parsed = JSON.parse(serializeMapDocFile(geo, layout)) as {
      page: Record<string, unknown>;
    };
    const page = parsed.page;
    expect(validatePage(page, geo).ok).toBe(true);

    const notePage = structuredClone(page);
    const noteItem = (notePage['items'] as Record<string, unknown>[]).find(
      (item) => item['role'] === 'note',
    );
    if (noteItem === undefined) throw new Error('page 块缺少注记 item');
    noteItem['wrap_width_pt'] = -1;
    const bad = validatePage(notePage, geo);
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors.some((error) => error.includes('wrap_width_pt'))).toBe(true);

    noteItem['wrap_width_pt'] = 100;
    const movedPage = structuredClone(page);
    const titleItem = (movedPage['items'] as Record<string, unknown>[]).find(
      (item) => item['role'] === 'title',
    );
    if (titleItem === undefined) throw new Error('page 块缺少标题 item');
    titleItem['text'] = '标题不该自动折行';
    titleItem['wrap_width_pt'] = 100;
    const moved = validatePage(movedPage, geo);
    expect(moved.ok).toBe(false);
    if (moved.ok) return;
    expect(moved.errors.some((error) => error.includes('只有页面注记'))).toBe(true);
  });

  it('normalizePage:保留注记字段,清掉其它文字上的残留字段', () => {
    const layout = defaultPageLayout(geo);
    const title = titleOf(layout);
    title.text = '残留';
    title.wrap_width_pt = 88;
    const normalized = normalizePage(layout);
    const normalizedNote = noteOf(normalized);
    expect(normalizedNote.text).toBe(noteOf(layout).text);
    expect(normalizedNote.wrap_width_pt).toBe(noteOf(layout).wrap_width_pt);
    const normalizedTitle = titleOf(normalized);
    expect(normalizedTitle.text).toBeNull();
    expect(normalizedTitle.wrap_width_pt).toBeNull();
  });
});

describe('打开旧 page 块:补齐折行字段并保持导出一致', () => {
  it('旧排版没有 text/wrap_width_pt -> 补齐并标脏,再导出重开干净', () => {
    const layout = defaultPageLayout(geo);
    const exported = serializeMapDocFile(geo, layout);
    const parsed = JSON.parse(exported) as { page: { items: Record<string, unknown>[] } };
    // 模拟本次改动前导出的 page 块:文字 item 没有自动折行字段
    for (const item of parsed.page.items) {
      if (item['kind'] !== 'text') continue;
      delete item['text'];
      delete item['wrap_width_pt'];
    }
    const legacyText = `${JSON.stringify(parsed, null, 2)}\n`;

    const opened = openMapFromUploads([
      fileOf('fixture.svg', BASE_SVG_TEXT),
      fileOf('fixture.geo.json', legacyText),
    ]);
    expect(opened.dirty).toBe(true);
    expect(opened.warnings.some((warning) => warning.includes('注记'))).toBe(true);
    const openedNote = noteOf(opened.layout);
    expect(openedNote.wrap_width_pt).not.toBeNull();
    expect(openedNote.text).not.toBeNull();
    // 补齐后按「已折好的 lines」当原始内容,行本身不变
    expect(openedNote.text).toBe(openedNote.lines.join('\n'));

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
