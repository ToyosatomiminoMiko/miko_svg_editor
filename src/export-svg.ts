/**
 * SVG 导出。只导出图元（线/圆/圆弧），点与约束不输出。
 * 圆弧用 SVG 的 A 命令描述，角度沿用屏幕坐标（y 向下，顺时针为正）。
 */

import { P, ends, model, modelBounds } from './model';

export function buildSVG(): string | null {
  const bb = modelBounds();
  if (!bb) return null;
  const { minx, miny, bw, bh } = bb;
  // 以包围盒尺寸估算一个与画面观感接近的线宽
  const strokeWidth = Math.max(0.2, Math.max(bw, bh) / 500);

  const n = (v: number): string => {
    const s = (+v.toFixed(4)).toString();
    return s === '-0' ? '0' : s;
  };

  const body: string[] = [];
  for (const e of model.ents.values()) {
    const dash = e.construction ? ' stroke-dasharray="4 4"' : '';
    if (e.type === 'line') {
      const [a, b] = ends(e);
      body.push(
        `<line x1="${n(a.x)}" y1="${n(a.y)}" x2="${n(b.x)}" y2="${n(b.y)}"${dash}/>`,
      );
    } else if (e.type === 'circle') {
      const c = P(e.c);
      if (!c) continue;
      body.push(
        `<circle cx="${n(c.x)}" cy="${n(c.y)}" r="${n(Math.abs(e.r))}"${dash}/>`,
      );
    } else {
      const c = P(e.c);
      if (!c) continue;
      const r = Math.abs(e.r);
      let sweep = e.a1 - e.a0;
      while (sweep <= 0) sweep += Math.PI * 2;
      const x0 = c.x + r * Math.cos(e.a0);
      const y0 = c.y + r * Math.sin(e.a0);
      const x1 = c.x + r * Math.cos(e.a0 + sweep);
      const y1 = c.y + r * Math.sin(e.a0 + sweep);
      const large = sweep > Math.PI ? 1 : 0;
      body.push(
        `<path d="M ${n(x0)} ${n(y0)} A ${n(r)} ${n(r)} 0 ${large} 1 ${n(x1)} ${n(y1)}"${dash}/>`,
      );
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(minx)} ${n(miny)} ${n(bw)} ${n(bh)}" width="${n(bw)}" height="${n(bh)}">
<g fill="none" stroke="#111" stroke-width="${strokeWidth}" stroke-linecap="round">
${body.join('\n')}
</g>
</svg>`;
}

export function exportSVG(): void {
  const svg = buildSVG();
  if (!svg) {
    window.alert('草图是空的');
    return;
  }
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'sketch.svg';
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
