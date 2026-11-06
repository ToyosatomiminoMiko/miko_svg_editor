/**
 * 从成品 SVG 里收集「这份成品到底用了哪些文字」:字符集,字体族与字重(纯字符串处理).
 *
 * 是什么:`collectUsedText(svg)` 扫一遍本编辑器合成出的 SVG,把每个 `<text>` 的字符内容
 * (反转义后去重,按码点升序),`font-family` 里出现的族名(首次出现顺序),以及
 * `font-weight` 里出现的字重(升序;没写属性按 400 计)收集起来.
 * 为什么扫成品而不是扫排版数据:成品里的文字来自 text item,地图地名,图例条目,色标刻度,
 * 图框刻度等多个来源,并各自带自己的样式口径;扫已合成好的字符串等于「以实际画出来的字为准」,
 * 字体子集不会漏掉任何一类文字,也不会多带上没画出来的字符.
 * 为什么只做我们自己输出格式的解析:成品是本仓库 `render/compose-svg.ts` 生成的已知结构
 * (`<text ...>内容</text>`,无嵌套子元素,属性值里的 `<>` 已转义),不需要通用 XML 解析器.
 * 元信息:作者 ToyosatomiminoMiko,2026-11-07.
 */

/** 成品里实际用到的文字信息 */
export interface UsedText {
  /** 去重并按码点升序的字符(供字体子集化使用) */
  readonly chars: string;
  /** `font-family` 里出现的字体族名(去掉引号,按首次出现顺序去重) */
  readonly families: readonly string[];
  /** `font-weight` 里出现的数字字重(升序去重;缺省属性按 400 计) */
  readonly weights: readonly number[];
}

/** 一个 `<text ...>正文</text>`;正文不含嵌套元素,属性值里的尖括号已转义 */
const TEXT_ELEMENT = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;

/** 开标签里的一个属性;成品只写双引号属性 */
const ATTRIBUTE = /([A-Za-z_:][A-Za-z0-9_:.-]*)="([^"]*)"/g;

/** SVG/XML 预定义实体;成品只输出这五个(见 `escapeXmlText` / `escapeXmlAttribute`) */
const ENTITY = /&(amp|lt|gt|quot|apos);/g;
const UNESCAPED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** 反转义 XML 实体;单次替换,避免 `&amp;lt;` 被二次还原成 `<` */
export function unescapeXml(text: string): string {
  return text.replace(ENTITY, (_match, name: string) => UNESCAPED[name] ?? _match);
}

/**
 * 收集成品 SVG 里实际用到的文字.
 * 为什么字重缺省按 400 计:成品对 400 不写 `font-weight` 属性(见 `fontWeightValue`),
 * 子集策略要按「400 也存在」来决定嵌入哪些面的字体.
 */
export function collectUsedText(svg: string): UsedText {
  const characters = new Set<number>();
  const families: string[] = [];
  const weights = new Set<number>();
  TEXT_ELEMENT.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TEXT_ELEMENT.exec(svg)) !== null) {
    const attributes = readAttributes(match[1] ?? '');
    for (const character of unescapeXml(match[2] ?? '')) {
      const codepoint = character.codePointAt(0);
      if (codepoint !== undefined) characters.add(codepoint);
    }
    const family = attributes.get('font-family');
    if (family !== undefined) {
      for (const token of unescapeXml(family).split(',')) {
        const name = token.trim().replace(/^['"]|['"]$/g, '');
        if (name.length > 0 && !families.includes(name)) families.push(name);
      }
    }
    const weight = attributes.get('font-weight');
    weights.add(parseWeight(weight));
  }
  return {
    chars: codepointsToString(characters),
    families,
    weights: [...weights].sort((left, right) => left - right),
  };
}

/** 解析开标签属性;同名属性以最后一次为准(与 XML 解析器的实际语义不冲突:成品不会重复) */
function readAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  ATTRIBUTE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTRIBUTE.exec(source)) !== null) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined) attributes.set(name, value);
  }
  return attributes;
}

/** 数字字重;缺省或非法值按 400(成品只可能写 100..900 的整数) */
function parseWeight(value: string | undefined): number {
  if (value === undefined) return 400;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 400;
}

/** 码点集合 -> 字符串(按码点升序,保证子集输入与产物字节可复现) */
function codepointsToString(codepoints: ReadonlySet<number>): string {
  return [...codepoints]
    .sort((left, right) => left - right)
    .map((codepoint) => String.fromCodePoint(codepoint))
    .join('');
}
