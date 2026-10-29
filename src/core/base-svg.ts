/**
 * 底图（Cartopy 产出的纯几何 SVG）契约检查与根标签内原文切片（纯逻辑，不碰 DOM）。
 *
 * 是什么：`readBaseSvg(text)` 对上传的底图做 C1–C4 检查，给出 viewBox / 纸张尺寸与
 * 「根 `<svg>` 起始标签之后、最后一个 `</svg>` 之前」的原文 `inner`；`inner` 是合成
 * `final.svg` 时原样内联的唯一来源。同时给出 `inner` 之前/之后的原文（`prefix` / `suffix`），
 * 使「成品 SVG 内嵌的可编辑源」能把底图字节逐字节还原（见 `core/final-svg.ts`）。
 * 为什么单独一层：成品必须把底图字节原样嵌进 `<g id="mapdoc-map">`，一旦把「已经合成过的
 * 成品」再当底图，就会越嵌越深；C4 专门拦这种误操作。检查全部是字符串级扫描（不解析
 * 整棵 XML），10 MB 底图也能在毫秒级完成。
 * 口径来源：C1–C4 与中文错误文案沿用本项目无后端改造前的底图契约（该 Python 实现已随
 * `tools/` 删除，语义见 `docs/PAGE-EDITOR.md` §7），但输入是浏览器已经按 UTF-8 解码好的
 * 文本字符串，所以偏移量是 UTF-16 code unit 下标，只用于本进程内切片，不跨语言比较。
 * 元信息：作者 compose，2026-10-28，无后端数据流（浏览器上传 base.svg + geo.json）；
 *         2026-10-29 增加 prefix/suffix 并公开 findTagEnd（成品 SVG 再编辑用）。
 */

/** 一次底图契约检查的完整结果；`errors` 为空才允许打开/合成 */
export interface BaseSvgInfo {
  /** 根 `<svg>` 的 `viewBox="x y w h"`；C1 失败时为 null */
  readonly view_box: readonly [number, number, number, number] | null;
  /** 底图宽度（pt，取 viewBox 第三项；C1 失败为 0） */
  readonly width_pt: number;
  /** 底图高度（pt，取 viewBox 第四项；C1 失败为 0） */
  readonly height_pt: number;
  /** 根起始标签之后、最后一个 `</svg>` 之前的原文；C1 失败时为 '' */
  readonly inner: string;
  /**
   * `inner` 之前的原文（XML 声明 + 根 `<svg>` 起始标签，直到 `>` 为止）。
   * 与 `inner`、`suffix` 首尾相接就是完整底图原文；C1 失败时为 ''。
   * 为什么需要：成品 SVG 内嵌源只保存这段前后缀（几十到几百字节），
   * 就能在重新打开时逐字节还原底图、让 sha256 仍然成立。
   */
  readonly prefix: string;
  /** `inner` 之后的原文（最后一个 `</svg>` 及其后的收尾换行）；C1/C3 失败时为 '' */
  readonly suffix: string;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

/** 根 `<svg` 起始标记：C1 只接受后面紧跟空白、`/` 或 `>` 的写法 */
const SVG_OPEN = '<svg';
/** 根收尾标记：C3 要求它恰好出现 1 次且位于文件末尾（允许一个换行） */
const SVG_CLOSE = '</svg>';
/** 叠加层身份标记：C4 要求底图里不出现，否则会重复内联排版层 */
const OVERLAY_MARK = 'mapdoc-overlay';
/** final marker 标记：C4 要求底图里不出现 */
const FINAL_MARK = 'mapdoc-final';

/** 根标签里的 viewBox 属性（单/双引号） */
const VIEWBOX_ATTR = /viewBox\s*=\s*(["'])(.*?)\1/;
/** 根标签里的 width/height 属性；只用于「声明画布尺寸与 viewBox 是否一致」的告警 */
const ROOT_WIDTH_ATTR = /(?:^|\s)width\s*=\s*["']([0-9.]+)\s*(?:pt|px)?["']/;
const ROOT_HEIGHT_ATTR = /(?:^|\s)height\s*=\s*["']([0-9.]+)\s*(?:pt|px)?["']/;

/**
 * 从 start 起找未处于引号内的 `>`；找不到返回 -1。
 *
 * 为什么不能直接 `indexOf('>')`：属性值（如 data URI 字体/图片）里可能含 `>`，
 * 只有按引号状态扫描才能定位根起始标签真正的收尾。
 * 为什么公开：`core/final-svg.ts` 定位成品里 `<g id="mapdoc-map">` 的结束位置时也按同一
 * 引号规则扫描，共用一份口径，避免两处对「标签结束」判断不一致。
 */
export function findTagEnd(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === '>') return index;
    if (char === '"' || char === "'") {
      const closing = text.indexOf(char, index + 1);
      if (closing < 0) return -1;
      index = closing + 1;
      continue;
    }
    index += 1;
  }
  return -1;
}

/** 返回根 `<svg` 元素起始偏移；找不到返回 -1（只接受紧跟空白/`/`/`>` 的写法） */
function findRoot(text: string): number {
  let index = 0;
  while (index < text.length) {
    index = text.indexOf(SVG_OPEN, index);
    if (index < 0) return -1;
    const following = text.charAt(index + SVG_OPEN.length);
    if (
      following === ' ' ||
      following === '\t' ||
      following === '\r' ||
      following === '\n' ||
      following === '>' ||
      following === '/'
    ) {
      return index;
    }
    index += SVG_OPEN.length;
  }
  return -1;
}

/** 从根起始标签里解析 `viewBox="minx miny w h"`；形状不对返回 null */
function parseViewBox(rootTag: string): readonly [number, number, number, number] | null {
  const match = VIEWBOX_ATTR.exec(rootTag);
  if (match === null) return null;
  const parts = (match[2] ?? '').trim().split(/\s+/);
  if (parts.length !== 4) return null;
  const values: number[] = [];
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isFinite(value)) return null;
    values.push(value);
  }
  const [x = 0, y = 0, width = 0, height = 0] = values;
  return [x, y, width, height];
}

/**
 * 取根标签上 width/height 属性的数值（去掉 pt/px），用于和 viewBox 对账。
 * 分开匹配两个属性，不依赖它们在起始标签里的先后顺序；缺一个就返回 null。
 */
function rootSizeAttrs(rootTag: string): readonly [number, number] | null {
  const widthMatch = ROOT_WIDTH_ATTR.exec(rootTag);
  const heightMatch = ROOT_HEIGHT_ATTR.exec(rootTag);
  if (widthMatch === null || heightMatch === null) return null;
  const width = Number(widthMatch[1]);
  const height = Number(heightMatch[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  return [width, height];
}

/** 统计子串出现次数（C3 用；不重叠计数即原语义） */
function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = text.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * 检查底图文本是否满足 C1–C4，并返回 viewBox 尺寸与内联原文（纯函数）。
 *
 * - C1：有根 `<svg>`，合法 viewBox，w/h > 0；
 * - C2：不含 `<text`（纯地图，注释/标题/刻度文字都不允许）；
 * - C3：`</svg>` 恰好 1 次且位于文件末尾（允许最多一个换行）；
 * - C4：不含 mapdoc-overlay / mapdoc-final 痕迹。
 *
 * 为什么 C1 失败时仍填 viewBox 解析到一半的数值：调用方（打开流程）会把 errors 非空
 * 直接拒绝，这里保留能解析出的信息只用于错误提示；`inner` 则一律置空，避免对半坏文件
 * 做字节拼接。
 */
export function readBaseSvg(text: string): BaseSvgInfo {
  const errors: string[] = [];
  const warnings: string[] = [];
  let viewBox: readonly [number, number, number, number] | null = null;
  let widthPt = 0;
  let heightPt = 0;
  let innerStart = 0;
  let c1Failed = false;

  // C1: 根 <svg> + 合法 viewBox。偏移即使在 C1 失败时也尽量填（找不到时保持 0）。
  const rootStart = findRoot(text);
  if (rootStart < 0) {
    errors.push('C1: 找不到根 <svg 元素');
    c1Failed = true;
  } else {
    const rootTagEnd = findTagEnd(text, rootStart);
    if (rootTagEnd < 0) {
      errors.push('C1: 根 <svg> 起始标签没有闭合');
      c1Failed = true;
    } else {
      innerStart = rootTagEnd + 1;
      const rootTag = text.slice(rootStart, rootTagEnd + 1);
      viewBox = parseViewBox(rootTag);
      if (viewBox === null) {
        errors.push('C1: 根 <svg> 缺少合法的 viewBox="x y w h"');
        c1Failed = true;
      } else {
        widthPt = viewBox[2];
        heightPt = viewBox[3];
        if (!(widthPt > 0) || !(heightPt > 0)) {
          errors.push(`C1: viewBox 宽高必须 > 0, 得到 ${widthPt}x${heightPt}`);
          c1Failed = true;
        }
      }
      const declared = rootSizeAttrs(rootTag);
      if (viewBox !== null && declared !== null) {
        if (
          Math.abs(declared[0] - viewBox[2]) > 0.01 ||
          Math.abs(declared[1] - viewBox[3]) > 0.01
        ) {
          warnings.push(
            `根 width/height 与 viewBox 尺寸不一致: ${declared[0]}x${declared[1]} vs ${viewBox[2]}x${viewBox[3]}`,
          );
        }
      }
    }
  }

  // C3: </svg> 唯一且在末尾（后缀允许空 / 一个 "\n" / "\r\n"）。
  const closeCount = countOccurrences(text, SVG_CLOSE);
  let innerEnd = 0;
  if (closeCount !== 1) {
    errors.push(`C3: </svg> 应恰好出现 1 次, 实际 ${closeCount} 次`);
  } else {
    innerEnd = text.lastIndexOf(SVG_CLOSE);
    const tail = text.slice(innerEnd + SVG_CLOSE.length);
    if (tail !== '' && tail !== '\n' && tail !== '\r\n') {
      errors.push('C3: </svg> 之后只允许一个换行, 实际还有其它字节');
    }
  }

  // C2: 纯底图里不允许任何 <text>/<textPath>/<tspan> 之类文字元素（按前缀判断）。
  if (text.includes('<text')) {
    errors.push('C2: 底图里不允许出现 <text> 元素');
  }

  // C4: 不允许叠加层/final marker 痕迹，否则 compose 会从已被写过的字节继续拼。
  if (text.includes(OVERLAY_MARK)) errors.push('C4: 底图包含 mapdoc-overlay 痕迹');
  if (text.includes(FINAL_MARK)) errors.push('C4: 底图包含 mapdoc-final marker');

  const inner = c1Failed || innerEnd < innerStart ? '' : text.slice(innerStart, innerEnd);
  // prefix/suffix 只用于「成品 SVG 内嵌源 → 逐字节还原底图」：
  // C1 失败时连根标签都不可信，宁可留空让调用方拒绝；C3 失败时定位不到收尾，suffix 留空。
  const prefix = c1Failed ? '' : text.slice(0, innerStart);
  const suffix = c1Failed || closeCount !== 1 ? '' : text.slice(innerEnd);

  return {
    view_box: viewBox,
    width_pt: widthPt,
    height_pt: heightPt,
    inner,
    prefix,
    suffix,
    errors,
    warnings,
  };
}
