/**
 * SVG 导出：导出图元，约束与尺寸不输出。
 * 纯函数：输入全局 model，输出 SVG 字符串，不碰 window/document（下载由 ui/download.ts 负责）。
 * 图元已多态归一到几何基元（线段 / 圆弧 / 点），这里只按基元生成标签：
 * 整圆弧（sweep = TAU）导出 <circle>，其余弧用 A 命令；否则起终点格式化后重合，
 * 按规范整段不渲染（BUG-1）。点图元导出为小实心圆，构造点是空心虚线圆。
 */

import {
  DEFAULT_EXPORT_STYLE,
  EXPORT_DECIMALS,
  EXPORT_POINT_RADIUS_FACTOR,
  EXPORT_STROKE_MIN,
  EXPORT_STROKE_REF,
  formatNumber,
  isFullSweep,
} from '../config';
import type { ExportStyle } from '../config';
import { model, primitiveOf } from '../core/model';
import { sketchBounds } from '../core/geometry';
import type { Vec } from '../core/types';

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
  const dash = (construction: boolean): string =>
    construction ? ` stroke-dasharray="${merged.dash}"` : '';
  const circle = (c: Vec, r: number, extra: string): string =>
    `<circle cx="${n(c.x)}" cy="${n(c.y)}" r="${n(r)}"${extra}/>`;

  const body: string[] = [];
  for (const e of model.ents.values()) {
    const prim = primitiveOf(e);
    if (!prim) continue;
    switch (prim.kind) {
      case 'segment':
        body.push(
          `<line x1="${n(prim.a.x)}" y1="${n(prim.a.y)}" x2="${n(prim.b.x)}" y2="${n(prim.b.y)}"${dash(e.construction)}/>`,
        );
        break;
      case 'circular': {
        const { center, radius, start, sweep } = prim;
        if (isFullSweep(sweep)) {
          body.push(circle(center, radius, dash(e.construction)));
          break;
        }
        const endAng = start + sweep;
        const startPt = {
          x: center.x + radius * Math.cos(start),
          y: center.y + radius * Math.sin(start),
        };
        const endPt = {
          x: center.x + radius * Math.cos(endAng),
          y: center.y + radius * Math.sin(endAng),
        };
        const large = sweep > Math.PI ? 1 : 0;
        body.push(
          `<path d="M ${n(startPt.x)} ${n(startPt.y)} A ${n(radius)} ${n(radius)} 0 ${large} 1 ${n(endPt.x)} ${n(endPt.y)}"${dash(e.construction)}/>`,
        );
        break;
      }
      case 'dot': {
        // 普通点：实心小圆（不吃描边）；构造点：空心虚线圈，与构造线语义一致
        const r = strokeWidth * EXPORT_POINT_RADIUS_FACTOR;
        body.push(
          e.construction
            ? `<circle cx="${n(prim.at.x)}" cy="${n(prim.at.y)}" r="${n(r)}" fill="none"${dash(true)}/>`
            : `<circle cx="${n(prim.at.x)}" cy="${n(prim.at.y)}" r="${n(r)}" fill="${merged.stroke}" stroke="none"/>`,
        );
        break;
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(bb.minx)} ${n(bb.miny)} ${n(bb.bw)} ${n(bb.bh)}" width="${n(bb.bw)}" height="${n(bb.bh)}">
<g fill="none" stroke="${merged.stroke}" stroke-width="${n(strokeWidth)}" stroke-linecap="${merged.lineCap}">
${body.join('\n')}
</g>
</svg>`;
}
