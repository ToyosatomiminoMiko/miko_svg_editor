/**
 * `render/hb-subset.ts`(harfbuzz wasm 绑定)的单测:用随包字体资产真的裁一次字.
 *
 * 为什么在 node 里跑真 wasm:这段绑定唯一的风险是调用序列/内存指针写错(wasm 崩溃不抛
 * 可读错误,只会返回 0 或空字节);用真实资产裁出真实子集,再按 sfnt 魔数断言产物类型,
 * 能挡住绝大多数错.子集字节的确定性也要断言:成品要可复现.
 * 元信息:作者 ToyosatomiminoMiko,2026-11-07.
 */

import { describe, expect, it } from 'vitest';
import { sfntFormatOf } from '../../src/render/embedded-font';
import { createSubsetter, type FontSubsetter } from '../../src/render/hb-subset';
import { readBytes } from '../fixtures/node-fs';

const WASM = new URL('../../node_modules/harfbuzzjs/dist/harfbuzz-subset.wasm', import.meta.url);
const JETBRAINS = new URL(
  '../../src/assets/fonts/JetBrainsMonoSlashed-Regular.ttf',
  import.meta.url,
);
const NOTO_CJK = new URL('../../src/assets/fonts/NotoSansMonoCJKsc-VF.otf', import.meta.url);

/** 每个用例单独实例化 wasm(harfbuzz 的 wasm 可以反复实例化,互不影响) */
async function makeSubsetter(): Promise<FontSubsetter> {
  const wasm = await WebAssembly.compile(readBytes(WASM));
  return createSubsetter(await WebAssembly.instantiate(wasm));
}

describe('createSubsetter:裁拉丁字体(TrueType)', () => {
  it('裁出比原字体小得多的 TrueType 子集', async () => {
    const subsetter = await makeSubsetter();
    const font = readBytes(JETBRAINS);
    const subset = subsetter.subset(font, 'Volga 流域 1.2');
    expect(sfntFormatOf(subset)).toBe('truetype');
    expect(subset.byteLength).toBeGreaterThan(100);
    expect(subset.byteLength).toBeLessThan(font.byteLength);
  });

  it('同一输入两次得到同一份字节(成品可复现)', async () => {
    const subsetter = await makeSubsetter();
    const font = readBytes(JETBRAINS);
    const first = subsetter.subset(font, 'Volga');
    const second = subsetter.subset(font, 'Volga');
    expect(second).toEqual(first);
  });
});

describe('createSubsetter:裁 CJK 可变面(OpenType CFF2)', () => {
  it('裁出 OpenType 子集,且同一份 wasm 可以连续裁多份', async () => {
    const subsetter = await makeSubsetter();
    const font = readBytes(NOTO_CJK);
    const subset = subsetter.subset(font, '伏尔加河流域图');
    expect(sfntFormatOf(subset)).toBe('opentype');
    expect(subset.byteLength).toBeGreaterThan(100);
    expect(subset.byteLength).toBeLessThan(font.byteLength);

    const again = subsetter.subset(font, '伏尔加河');
    expect(sfntFormatOf(again)).toBe('opentype');
    expect(again.byteLength).toBeLessThan(subset.byteLength);
  });

  it('字体里没有的字符会被静默丢弃,不会让整个子集失败', async () => {
    const subsetter = await makeSubsetter();
    const font = readBytes(NOTO_CJK);
    const subset = subsetter.subset(font, '伏尔加\u{1f600}');
    expect(sfntFormatOf(subset)).toBe('opentype');
  });
});
