/**
 * 尺寸输入框的纯解析函数：字符串 → 数值/错误 的翻译，不碰 DOM 与模型。
 * 独立成文件是为了能在 node 环境直接单测（hint-editor 走 notify → overlays.css，带 DOM 依赖）。
 * 语义：空串/纯空白、非有限、<= 0 都是非法；允许小数与指数写法（如 1.5e3），
 * 不再依赖 Number('') === 0 的隐式行为。
 */

export type ParseDimResult = { ok: true; value: number } | { ok: false; reason: string };

/** 十进制数字：允许正负号、小数、指数；拒绝 0x10 / Infinity / 空串这类宽松解析 */
const DECIMAL_INPUT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** 解析尺寸输入；长度/半径必须是有限正数 */
export function parseDimInput(raw: string): ParseDimResult {
  const text = raw.trim();
  if (!text) return { ok: false, reason: '请输入数值' };
  if (!DECIMAL_INPUT.test(text)) return { ok: false, reason: '请输入有效数值' };
  const value = Number(text);
  if (!Number.isFinite(value)) return { ok: false, reason: '数值超出范围' };
  if (value <= 0) return { ok: false, reason: '数值必须大于 0' };
  return { ok: true, value };
}
