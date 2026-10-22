/**
 * selection.ts 的选择语义与 state 交互（node 环境）。
 * 框选方向是唯一定义：由下往上拖（终点 y 更小）= 交叉选择，由上往下 = 窗口选择。
 * 夹具把屏幕坐标固定为 800×600、zoom=1、世界原点在屏幕中心，便于手算世界矩形。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { DRAG_THRESHOLD_PX } from '../src/config';
import { cam } from '../src/camera';
import { addLine, addPt, clearModel } from '../src/model';
import {
  applyMarquee,
  clearHover,
  clickSelect,
  isCrossing,
  selectionSummary,
  updateHover,
  updateMarquee,
} from '../src/selection';
import { resetInteraction, selectOnly, state } from '../src/state';
import type { Marquee } from '../src/types';

beforeEach(() => {
  clearModel();
  resetInteraction();
  cam.x = 0;
  cam.y = 0;
  cam.z = 1;
  cam.viewportW = 800;
  cam.viewportH = 600;
  state.snapEnabled = true;
});

/** 世界 (100,0)-(200,0) 的直线：屏幕 (500,300)-(600,300) */
function lineFixture(): ReturnType<typeof addLine> {
  return addLine(addPt(100, 0), addPt(200, 0));
}

/** 屏幕矩形 [-50,50]²（世界单位）对应的框选参数 */
const crossingMarquee: Marquee = {
  s0: { x: 350, y: 350 },
  currentS: { x: 450, y: 250 },
  active: true,
  add: false,
};
const windowMarquee: Marquee = {
  s0: { x: 350, y: 250 },
  currentS: { x: 450, y: 350 },
  active: true,
  add: false,
};

describe('isCrossing', () => {
  it('由下往上拖是交叉选择', () => {
    expect(isCrossing({ x: 0, y: 100 }, { x: 10, y: 50 })).toBe(true);
  });

  it('由上往下拖是窗口选择', () => {
    expect(isCrossing({ x: 0, y: 0 }, { x: 10, y: 50 })).toBe(false);
  });
});

describe('clickSelect', () => {
  it('点优先于图元', () => {
    const p = addPt(150, 0);
    lineFixture();
    const result = clickSelect({ x: 150, y: 0 }, 1, false);
    expect(result.hit).toBe('point');
    expect(state.selection.pts).toEqual([p.id]);
    expect(state.selection.ents).toEqual([]);
    expect(result.dragPoints).toEqual([p]);
    expect(result.startMarquee).toBe(false);
  });

  it('点中图元：选中图元并给出端点作为拖拽点', () => {
    const line = lineFixture();
    const result = clickSelect({ x: 150, y: 0 }, 1, false);
    expect(result.hit).toBe('entity');
    expect(state.selection.ents).toEqual([line.id]);
    expect(state.selection.pts).toEqual([]);
    expect(result.dragPoints).toHaveLength(2);
  });

  it('点中空白：清空选择并开始框选', () => {
    const p = addPt(0, 0);
    selectOnly([], [p.id]);
    const result = clickSelect({ x: 300, y: 300 }, 1, false);
    expect(result.hit).toBe('empty');
    expect(result.startMarquee).toBe(true);
    expect(state.selection).toEqual({ ents: [], pts: [] });
  });

  it('Shift 点击同一点：从选择里切掉', () => {
    const p = addPt(0, 0);
    selectOnly([], [p.id]);
    const result = clickSelect({ x: 0, y: 0 }, 1, true);
    expect(result.hit).toBe('point');
    expect(state.selection.pts).toEqual([]);
    expect(result.startMarquee).toBe(false);
  });

  it('Shift 点击空白：保留已有选择并开始累加框选', () => {
    const p = addPt(0, 0);
    selectOnly([], [p.id]);
    const result = clickSelect({ x: 300, y: 300 }, 1, true);
    expect(result.startMarquee).toBe(true);
    expect(state.selection.pts).toEqual([p.id]);
  });

  it('Shift 点击未选中的图元：加入选择', () => {
    const line = lineFixture();
    clickSelect({ x: 300, y: 300 }, 1, true); // 空白处按下不清空
    const result = clickSelect({ x: 150, y: 0 }, 1, true);
    expect(result.hit).toBe('entity');
    expect(result.startMarquee).toBe(false);
    expect(state.selection.ents).toEqual([line.id]);
  });
});

describe('applyMarquee', () => {
  it('交叉选择：与矩形有任何重叠的图元都选中；点按是否在框内', () => {
    const inside = addLine(addPt(-10, 0), addPt(10, 0));
    const crossing = addLine(addPt(-100, 0), addPt(0, 0));
    const far = addLine(addPt(200, 200), addPt(300, 300));

    applyMarquee(crossingMarquee);

    expect(isCrossing(crossingMarquee.s0, crossingMarquee.currentS)).toBe(true);
    expect(state.selection.ents.sort()).toEqual([inside.id, crossing.id].sort());
    // 点选择只看是否在框内：inside 两端 + crossing 的 (0,0) 在框内，(-100,0) 不在
    expect(state.selection.pts).toHaveLength(3);
    expect(state.selection.ents).not.toContain(far.id);
  });

  it('窗口选择：只有完全落在框内的图元被选中', () => {
    const inside = addLine(addPt(-10, 0), addPt(10, 0));
    const partially = addLine(addPt(-100, 0), addPt(0, 0));

    applyMarquee(windowMarquee);

    expect(isCrossing(windowMarquee.s0, windowMarquee.currentS)).toBe(false);
    expect(state.selection.ents).toEqual([inside.id]);
    expect(state.selection.ents).not.toContain(partially.id);
  });

  it('add 为 true 时与已有选择求并集', () => {
    const inside = addLine(addPt(-10, 0), addPt(10, 0));
    const other = addPt(0, 0);
    selectOnly([], [other.id]);

    applyMarquee({ ...crossingMarquee, add: true });

    expect(state.selection.ents).toEqual([inside.id]);
    expect(state.selection.pts).toContain(other.id);
  });

  it('add 为 false 时覆盖已有选择', () => {
    addLine(addPt(-10, 0), addPt(10, 0));
    const stale = addPt(500, 500);
    selectOnly([], [stale.id]);

    applyMarquee(crossingMarquee);

    expect(state.selection.pts).not.toContain(stale.id);
  });
});

describe('updateHover / clearHover', () => {
  it('有吸附时记录 snap 与 hoverPt；图元悬停与点互斥', () => {
    const p = addPt(0, 0);
    addLine(addPt(100, 0), addPt(200, 0));

    updateHover({ x: 0, y: 0 }, 1);
    expect(state.hoverPt).toBe(p);
    expect(state.snap?.pt).toBe(p);
    expect(state.hoverEnt).toBeNull();
  });

  it('关闭吸附后 snap 为 null，但仍保留悬停高亮', () => {
    const p = addPt(0, 0);
    state.snapEnabled = false;
    updateHover({ x: 0, y: 0 }, 1);
    expect(state.snap).toBeNull();
    expect(state.hoverPt).toBe(p);
  });

  it('clearHover 清空全部悬停/吸附标记', () => {
    addPt(0, 0);
    updateHover({ x: 0, y: 0 }, 1);
    clearHover();
    expect(state.snap).toBeNull();
    expect(state.hoverPt).toBeNull();
    expect(state.hoverEnt).toBeNull();
  });
});

describe('updateMarquee', () => {
  it('位移超过 DRAG_THRESHOLD_PX 才 active', () => {
    state.marquee = {
      s0: { x: 400, y: 300 },
      currentS: { x: 400, y: 300 },
      active: false,
      add: false,
    };
    updateMarquee({ x: 401, y: 300 });
    expect(state.marquee.active).toBe(false);
    updateMarquee({ x: 400 + DRAG_THRESHOLD_PX + 1, y: 300 });
    expect(state.marquee.active).toBe(true);
    expect(state.marquee.currentS).toEqual({ x: 400 + DRAG_THRESHOLD_PX + 1, y: 300 });
  });

  it('没有框选状态时安全返回', () => {
    expect(() => updateMarquee({ x: 1, y: 1 })).not.toThrow();
  });
});

describe('selectionSummary', () => {
  it('按选中内容给出文案', () => {
    expect(selectionSummary()).toBe('');
    selectOnly([1], []);
    expect(selectionSummary()).toBe('已选 1 个图元');
    selectOnly([], [2]);
    expect(selectionSummary()).toBe('已选 1 个点');
    selectOnly([1, 2], [3]);
    expect(selectionSummary()).toBe('已选 2 图元 + 1 点');
  });
});
