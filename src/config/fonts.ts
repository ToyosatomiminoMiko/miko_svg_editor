/**
 * 全项目字体栈的唯一真源(界面 + 画布 + 页面预览 + 成品 SVG 共用同一串).
 *
 * 是什么:拉丁主字体 `'JetBrains Mono Slashed'` + 中文兜底 `'Noto Sans Mono CJK SC'`
 * 的 `font-family` 串,以及两族名对应的成品内嵌子集资产规则(见 `render/embedded-font.ts`)
 * 用到的族名常量.界面侧由 `src/styles.css :root` 的 `--font-family-base` 消费
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

/** 拉丁主字体族名(与 miko_ui 的 `@font-face` 一致,成品内嵌子集也用这个族名) */
export const LATIN_FONT_FAMILY = 'JetBrains Mono Slashed';

/** 中文等宽兜底族名(系统字体,成品内嵌子集用这一族的预裁资产) */
export const CJK_FONT_FAMILY = 'Noto Sans Mono CJK SC';

/**
 * 字体栈末尾的系统等宽兜底族(不随包).它们只在本机装了两族之外的机器上生效,成品内嵌时
 * 特意识别为「预期内的系统兜底」而不是「不认识的自定义字体」,不会触发告警.
 */
export const SYSTEM_FALLBACK_FAMILIES = [
  'ui-monospace',
  'SFMono-Regular',
  'Menlo',
  'Consolas',
  'monospace',
] as const;

/** 界面/预览/成品的 `font-family` 串:拉丁主字体在前,中文兜底在后,通用等宽收尾 */
export const FONT_FAMILY_STACK =
  `'${LATIN_FONT_FAMILY}', '${CJK_FONT_FAMILY}', ` + SYSTEM_FALLBACK_FAMILIES.join(', ');
