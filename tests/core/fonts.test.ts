/**
 * 全项目字体栈的契约:`config/fonts.ts` 的 `FONT_FAMILY_STACK` 是唯一真源,
 * 页面默认值(`config/page.ts`)与界面 CSS(`src/styles.css`)只能是它.
 *
 * 为什么要有这组断言:字体栈同时被 TS(页面/成品)与 CSS(界面/画布)消费,两边各写一次
 * 字面量,没有编译期联系;只改一边不会报错,界面与成品会静默用成两种字体,所以读源码
 * 把两处钉在一起.
 * 为什么字体顺序也要断言:'JetBrains Mono Slashed' 不含 CJK 字形,顺序写反(把 CJK 放前)
 * 会让英文/数字全落到 Noto CJK,名义上「用了 JetBrains」实际一次都用不上.
 */

import { describe, expect, it } from 'vitest';
import { FONT_FAMILY_STACK } from '../../src/config/fonts';
import { PAGE_DEFAULT_FONT_FAMILY } from '../../src/config/page';

/**
 * 读源码用的最小 node:fs 接口.
 * 为什么不直接 `import 'node:fs'`:tsconfig 只带 vite/client 类型(没装 @types/node),直接
 * import 会让 typecheck 失败;与 `vite.config.ts` 取内置模块是同一条路--Node 20.16+ 的
 * `process.getBuiltinModule` 在运行期返回同一批模块,这里只声明用到的成员.
 * 为什么不用 `import stylesCss from '...css?raw'`:vitest 默认把 CSS 导入桩成空串
 * (`css: false`),?raw 会先被 Vite 的 CSS 插件截走,拿不到源码.
 */
interface FsLike {
  readFileSync(target: URL | string, encoding: 'utf8'): string;
}
interface NodeProcessLike {
  getBuiltinModule(id: string): unknown;
}

const fs = (globalThis as unknown as { process: NodeProcessLike }).process.getBuiltinModule(
  'fs',
) as FsLike;

/** 去掉引号,按逗号切成族名(只关心顺序与族名,书写风格交给其它规则) */
function familiesOf(stack: string): string[] {
  return stack
    .split(',')
    .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
    .filter((part) => part.length > 0);
}

/** 空白折叠:比较两处字面量时只允许排版空白不同(换行/缩进) */
const collapse = (value: string): string => value.replace(/\s+/g, ' ').trim();

/** 从 styles.css 源码里取出 --font-family-base 的声明值 */
function cssFontStack(): string {
  const source = fs.readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');
  const match = /--font-family-base:\s*([^;]+);/.exec(source);
  if (match?.[1] === undefined) throw new Error('src/styles.css 缺少 --font-family-base 覆盖');
  return collapse(match[1]);
}

describe('全项目字体栈', () => {
  it('拉丁主字体在前,中文等宽兜底在后,通用等宽收尾', () => {
    const families = familiesOf(FONT_FAMILY_STACK);
    expect(families[0]).toBe('JetBrains Mono Slashed');
    expect(families[1]).toBe('Noto Sans Mono CJK SC');
    expect(families.at(-1)).toBe('monospace');
  });

  it('页面默认字体栈就是全项目字体栈', () => {
    expect(PAGE_DEFAULT_FONT_FAMILY).toBe(FONT_FAMILY_STACK);
  });

  it('界面 CSS 的 --font-family-base 与 TS 常量一致(只允许空白差异)', () => {
    expect(cssFontStack()).toBe(collapse(FONT_FAMILY_STACK));
  });
});
