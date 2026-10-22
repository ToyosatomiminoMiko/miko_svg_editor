/**
 * SVG 导出：导出图元（线/圆/圆弧/点），约束与尺寸不输出。
 * 纯函数：输入全局 model，输出 SVG 字符串，不碰 window/document（下载由 ui/download.ts 负责）。
 * 圆弧扫角语义统一走 config/angle.sweepOf：起终点同角（整圆）导出 <circle>，
 * 其余用 A 命令；否则起终点格式化后重合，按规范整段不渲染（BUG-1）。
 * 点图元导出为小实心圆，构造点是空心虚线圆。
 */

import {
  DEFAULT_EXPORT_STYLE,
  EXPORT_DECIMALS,
  EXPORT_POINT_RADIUS_FACTOR,
  EXPORT_STROKE_MIN,
  EXPORT_STROKE_REF,
  formatNumber,
  isFullSweep,
  sweepOf,
} from './config';
import type { ExportStyle } from './config';
import { assertNever } from './entities';
import { sketchBounds } from './geometry';
import { ends, getPoint, model } from './model';
import type { Entity, Vec } from './types';

/** 导出整张草图为 SVG；没有可导出的图元时返回 null（提示文案由调用方处理） */
export function buildSVG(style: Partial<ExportStyle> = {}): string | null {
  // 空判定只看图元：model.isEmpty() 还会算上临时点/尺寸，而导出只关心有没有可导出的几何
  if (model.ents.size === 0) return null;
  const bb = sketchBounds();
  if (!bb) return null;

  const merged: ExportStyle = { ...DEFAULT_EXPORT_STYLE, ...style };
  const n = (v: number): string => formatNumber(v, EXPORT_DECIMALS);
  // 以包围盒尺寸估算一个与画面观感接近的线宽
  const strokeWidth = Math.max(EXPORT_STROKE_MIN, Math.max(bb.bw, bb.bh) / EXPORT_STROKE_REF);
  const dash = (e: Entity): string => (e.construction ? ` stroke-dasharray="${merged.dash}"` : '');
  const circle = (c: Vec, r: number, extra: string): string =>
    `<circle cx="${n(c.x)}" cy="${n(c.y)}" r="${n(r)}"${extra}/>`;

  const body: string[] = [];
  for (const e of model.ents.values()) {
    switch (e.type) {
      case 'line': {
        const [a, b] = ends(e);
        body.push(`<line x1="${n(a.x)}" y1="${n(a.y)}" x2="${n(b.x)}" y2="${n(b.y)}"${dash(e)}/>`);
        break;
      }
      case 'circle': {
        const c = getPoint(e.c);
        if (c) body.push(circle(c, e.r, dash(e)));
        break;
      }
      case 'arc': {
        const c = getPoint(e.c);
        if (!c) break;
        const sweep = sweepOf(e.a0, e.a1);
        if (isFullSweep(sweep)) {
          body.push(circle(c, e.r, dash(e)));
          break;
        }
        const x0 = c.x + e.r * Math.cos(e.a0);
        const y0 = c.y + e.r * Math.sin(e.a0);
        const x1 = c.x + e.r * Math.cos(e.a0 + sweep);
        const y1 = c.y + e.r * Math.sin(e.a0 + sweep);
        const large = sweep > Math.PI ? 1 : 0;
        body.push(
          `<path d="M ${n(x0)} ${n(y0)} A ${n(e.r)} ${n(e.r)} 0 ${large} 1 ${n(x1)} ${n(y1)}"${dash(e)}/>`,
        );
        break;
      }
      case 'point': {
        const p = getPoint(e.p);
        if (!p) break;
        const r = strokeWidth * EXPORT_POINT_RADIUS_FACTOR;
        // 普通点：实心小圆（不吃描边）；构造点：空心虚线圈，与构造线语义一致
        body.push(
          e.construction
            ? `<circle cx="${n(p.x)}" cy="${n(p.y)}" r="${n(r)}" fill="none"${dash(e)}/>`
            : `<circle cx="${n(p.x)}" cy="${n(p.y)}" r="${n(r)}" fill="${merged.stroke}" stroke="none"/>`,
        );
        break;
      }
      default:
        assertNever(e);
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(bb.minx)} ${n(bb.miny)} ${n(bb.bw)} ${n(bb.bh)}" width="${n(bb.bw)}" height="${n(bb.bh)}">
<g fill="none" stroke="${merged.stroke}" stroke-width="${n(strokeWidth)}" stroke-linecap="${merged.lineCap}">
${body.join('\n')}
</g>
</svg>`;
}
