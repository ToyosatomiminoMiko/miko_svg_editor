/**
 * 全项目字体栈的唯一真源(界面 + 画布 + 页面预览 + 成品 SVG 共用同一串).
 *
 * 是什么:拉丁主字体 `'JetBrains Mono Slashed'` + 中文兜底 `'Noto Sans Mono CJK SC'`
 * 的 `font-family` 串.界面侧由 `src/styles.css :root` 的 `--font-family-base` 消费
 * (miko_ui 的控件与画布 token `--code-font-family` / `--dim-font` 都读它);页面侧由
 * `PAGE_DEFAULT_FONT_FAMILY`(`config/page.ts`)写进 `page.style.font_family` 与每个
 * `<text>` 的 `font-family`.
 * 为什么写成「拉丁主字体 + CJK 兜底」:'JetBrains Mono Slashed' 不含中日韩字形,浏览器
 * 会逐字落到栈里的下一族;把 CJK 等宽放在第二位,中英混排就都是等宽,不会掉进比例字体.
 * 为什么不是「CJK 在前」:Noto CJK 同样覆盖拉丁字母,放前面会让英文/数字全走 Noto CJK,
 * 'JetBrains Mono Slashed' 永远用不上.
 * 为什么不用 'JetBrains Mono Slashed Medium':miko_ui 随包发布的 `@font-face` 族名是
 * `'JetBrains Mono Slashed'`(weight 400/600/700),本机安装的同款字体也带这个族名;
 * 写 Medium 别名会让「网页字体(随包 woff2)」与「打印时本机字体(Inkscape 等)」分家.
 * 为什么末尾保留通用等宽:两族都装不上的机器仍要维持等宽观感;`ui-monospace` /
 * `SFMono-Regular` / `Menlo` / `Consolas` 是各平台的系统等宽,`monospace` 是最终兜底.
 * 与 CSS 的同步:两处字面量(`src/config/fonts.ts` 与 `src/styles.css :root`)必须逐字
 * 一致,`tests/core/fonts.test.ts` 直接读 styles.css 源码断言--漂移不会报错,只会让界面
 * 与成品静默用成两种字体,所以由测试盯着.
 * 元信息:作者 ToyosatomiminoMiko,2026-11-07.
 */
export const FONT_FAMILY_STACK =
  "'JetBrains Mono Slashed', 'Noto Sans Mono CJK SC', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
