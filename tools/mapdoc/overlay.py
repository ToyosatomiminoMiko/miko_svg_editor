"""scene → 叠加层 SVG 字符串(纯字符串, 不建 XML 树).

是什么: 按 scene.entities 数组顺序逐条生成 SVG 子元素, 拼成单个
``<g id="mapdoc-overlay" data-format="mapdoc-overlay" data-version="1">``; 没有图元时
不产出组. 同时给出越界对象/告警/计数, 供 report 与前端提示.
为什么: 成品与画布预览必须只有一种解释——圆弧按 ``arcGeometry``+``sweepOf`` 派生,
整圆弧输出 <circle>, 非整圆弧输出 A 命令, 3 位小数格式化后起终点重合的弧按 BUG-1 跳过;
数值一律用户单位且不带任何 CSS 单位后缀(A4), 否则 1pt 会被乘 4/3.
依赖: mapdoc.scene 的 Scene/实体类型; 文字与字体子集(P3)只留挂点.
元信息: 2026-10, mapdoc 垂直切片; 镜像 src/core/entities.ts、src/config/angle.ts、
src/render/export-svg.ts.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from . import scene as scene_mod

TAU = 2.0 * math.pi
# 与 src/config/angle.ts 的 SWEEP_EPS 一致: 起终点角差小于它就算整圆.
SWEEP_EPS = 1e-9
# 越界判定容差: 坐标恰好压在画布边界上不算越界.
BBOX_EPS = 1e-9

OVERLAY_ID = "mapdoc-overlay"
OVERLAY_DATA_FORMAT = "mapdoc-overlay"
OVERLAY_DATA_VERSION = "1"


def format_number(value: float) -> str:
    """按 3 位小数格式化并去掉尾零, 与 src/config/format.ts 的 formatNumber(v, 3) 同语义.

    - 非有限值输出 "0"(不让 NaN 进 SVG);
    - -0 归一成 "0";
    - 结果不带单位后缀: SVG 用户单位就是 1pt, 写 "pt" 会被按 CSS 单位再换算.
    """
    if not math.isfinite(value):
        return "0"
    rounded = round(float(value), 3)
    if rounded == 0:
        return "0"
    text = repr(float(rounded))
    return text[:-2] if text.endswith(".0") else text


def normalize_angle(angle: float) -> float:
    """把角度归一化到 [0, TAU), 镜像 src/config/angle.ts 的 normalizeAngle."""
    return ((angle % TAU) + TAU) % TAU


def sweep_of(start_angle: float, end_angle: float) -> float:
    """圆弧正向扫角, 范围 (0, TAU]; 同角(含浮点误差)返回 TAU 表示整圆.

    为什么同角不返回 0: 否则整圆弧会同时得到 canvas 画整圆、SVG 起终点重合不渲染、
    拾取区间塌缩三种结果(前端 BUG-1 的根因).
    """
    delta = normalize_angle(end_angle - start_angle)
    if delta < SWEEP_EPS or delta > TAU - SWEEP_EPS:
        return TAU
    return delta


def is_full_sweep(sweep: float) -> bool:
    """扫角是否代表整圆."""
    return sweep >= TAU - SWEEP_EPS


def arc_geometry(
    entity: scene_mod.ArcEntity, points: dict[int, scene_mod.Point]
) -> tuple[scene_mod.Point, float, float, float] | None:
    """由圆心/起点/终点派生 (圆心, 半径, 起始角, 终止角); 引用缺失返回 None."""
    center = points.get(entity.c)
    start = points.get(entity.a)
    end = points.get(entity.b)
    if center is None or start is None or end is None:
        return None
    radius = math.hypot(start.x - center.x, start.y - center.y)
    start_angle = math.atan2(start.y - center.y, start.x - center.x)
    end_angle = math.atan2(end.y - center.y, end.x - center.x)
    return center, radius, start_angle, end_angle


@dataclass(frozen=True)
class Overlay:
    """一次叠加层渲染的结果: 追加块(可选) + 报告数据."""

    defs_style: str | None
    group: str | None
    counts: dict[str, int]
    warnings: tuple[str, ...]
    out_of_canvas: tuple[int, ...]
    missing_glyphs: tuple[str, ...]


def _dash(style: scene_mod.Style, construction: bool) -> str:
    """构造线的 stroke-dasharray; 非构造对象返回空串."""
    if not construction:
        return ""
    first, second = style.construction_dash_pt
    return f' stroke-dasharray="{format_number(first)} {format_number(second)}"'


def _arc_bbox(
    center_x: float, center_y: float, radius: float, start_angle: float, sweep: float
) -> tuple[float, float, float, float]:
    """圆弧包围盒: 采样起终点 + 落在扫角区间内的四个基数角极值."""
    angles = [start_angle, start_angle + sweep]
    if not is_full_sweep(sweep):
        for quadrant in range(4):
            angle = quadrant * (TAU / 4.0)
            if normalize_angle(angle - start_angle) <= sweep:
                angles.append(angle)
    xs = [center_x + radius * math.cos(angle) for angle in angles]
    ys = [center_y + radius * math.sin(angle) for angle in angles]
    return min(xs), min(ys), max(xs), max(ys)


def _entity_bbox(
    entity: scene_mod.Entity,
    points: dict[int, scene_mod.Point],
    style: scene_mod.Style,
) -> tuple[float, float, float, float] | None:
    """图元的轴对齐包围盒; 引用缺失返回 None(校验阶段已挡住, 这里只做防御)."""
    if isinstance(entity, scene_mod.LineEntity):
        start = points.get(entity.a)
        end = points.get(entity.b)
        if start is None or end is None:
            return None
        return (
            min(start.x, end.x),
            min(start.y, end.y),
            max(start.x, end.x),
            max(start.y, end.y),
        )
    if isinstance(entity, scene_mod.CircleEntity):
        center = points.get(entity.c)
        if center is None:
            return None
        return (
            center.x - entity.r,
            center.y - entity.r,
            center.x + entity.r,
            center.y + entity.r,
        )
    if isinstance(entity, scene_mod.ArcEntity):
        geometry = arc_geometry(entity, points)
        if geometry is None:
            return None
        center, radius, start_angle, end_angle = geometry
        return _arc_bbox(center.x, center.y, radius, start_angle, sweep_of(start_angle, end_angle))
    if isinstance(entity, scene_mod.PointEntity):
        point = points.get(entity.p)
        if point is None:
            return None
        radius = style.point_radius_pt
        return (point.x - radius, point.y - radius, point.x + radius, point.y + radius)
    return None


def render_overlay(scan: scene_mod.Scene, width_pt: float, height_pt: float) -> Overlay:
    """把 scene 渲染成叠加层字符串与报告; 空 scene 返回 (None, None).

    参数 width_pt/height_pt 是底图 viewBox 尺寸, 只用于越界判定, 不写进输出.
    """
    style = scan.style
    points = {point.id: point for point in scan.points}
    children: list[str] = []
    warnings: list[str] = []
    out_of_canvas: list[int] = []

    for entity in scan.entities:
        # 越界判定用真实几何(3 位小数之前), 报告只给 id.
        bbox = _entity_bbox(entity, points, style)
        if bbox is not None:
            min_x, min_y, max_x, max_y = bbox
            if (
                min_x < -BBOX_EPS
                or min_y < -BBOX_EPS
                or max_x > width_pt + BBOX_EPS
                or max_y > height_pt + BBOX_EPS
            ):
                out_of_canvas.append(entity.id)

        if isinstance(entity, scene_mod.LineEntity):
            start = points[entity.a]
            end = points[entity.b]
            children.append(
                f'<line x1="{format_number(start.x)}" y1="{format_number(start.y)}" '
                f'x2="{format_number(end.x)}" y2="{format_number(end.y)}"'
                f"{_dash(style, entity.construction)}/>"
            )
        elif isinstance(entity, scene_mod.CircleEntity):
            center = points[entity.c]
            children.append(
                f'<circle cx="{format_number(center.x)}" cy="{format_number(center.y)}" '
                f'r="{format_number(entity.r)}"{_dash(style, entity.construction)}/>'
            )
        elif isinstance(entity, scene_mod.ArcEntity):
            geometry = arc_geometry(entity, points)
            if geometry is None:
                continue
            center, radius, start_angle, end_angle = geometry
            sweep = sweep_of(start_angle, end_angle)
            if is_full_sweep(sweep):
                children.append(
                    f'<circle cx="{format_number(center.x)}" '
                    f'cy="{format_number(center.y)}" '
                    f'r="{format_number(radius)}"{_dash(style, entity.construction)}/>'
                )
                continue
            end_angle_abs = start_angle + sweep
            start_x = center.x + radius * math.cos(start_angle)
            start_y = center.y + radius * math.sin(start_angle)
            end_x = center.x + radius * math.cos(end_angle_abs)
            end_y = center.y + radius * math.sin(end_angle_abs)
            x0, y0 = format_number(start_x), format_number(start_y)
            x1, y1 = format_number(end_x), format_number(end_y)
            if x0 == x1 and y0 == y1:
                # BUG-1: 非整圆弧格式化后起终点重合, 按 SVG 规范整段不渲染;
                # 这里直接跳过, 避免成品出现一条"看不见的弧".
                warnings.append(f"圆弧 {entity.id} 三位小数格式化后起终点重合, 按 BUG-1 跳过")
                continue
            large = 1 if sweep > math.pi else 0
            children.append(
                f'<path d="M {x0} {y0} A {format_number(radius)} {format_number(radius)} '
                f'0 {large} 1 {x1} {y1}"{_dash(style, entity.construction)}/>'
            )
        elif isinstance(entity, scene_mod.PointEntity):
            point = points[entity.p]
            radius = format_number(style.point_radius_pt)
            if entity.construction:
                children.append(
                    f'<circle cx="{format_number(point.x)}" cy="{format_number(point.y)}" '
                    f'r="{radius}" fill="none"{_dash(style, True)}/>'
                )
            else:
                children.append(
                    f'<circle cx="{format_number(point.x)}" cy="{format_number(point.y)}" '
                    f'r="{radius}" fill="{style.stroke}" stroke="none"/>'
                )

    if out_of_canvas:
        warnings.append(
            "越界图元: " + ", ".join(str(identifier) for identifier in out_of_canvas)
        )

    group: str | None = None
    if children:
        # 单个 <g> + 子元素顺序 = entities 顺序(层内 z 序只有这一条规则);
        # linecap/linejoin 显式写成与底图全局样式相同的值(A6), 使独立 /overlay.svg 目检一致;
        # 底图 author CSS 优先级更高, 因此不会反过来改底图.
        header = (
            f'<g id="{OVERLAY_ID}" data-format="{OVERLAY_DATA_FORMAT}" '
            f'data-version="{OVERLAY_DATA_VERSION}" fill="none" '
            f'stroke="{style.stroke}" '
            f'stroke-width="{format_number(style.stroke_width_pt)}" '
            f'stroke-linecap="butt" stroke-linejoin="round">'
        )
        group = header + "\n" + "\n".join(children) + "\n</g>"

    # P3 字体子集挂点: 有 text 实体时在这里返回 <defs><style>@font-face…</style></defs>;
    # 本轮不接受 text, 因此永远不产出字体块.
    defs_style: str | None = None

    return Overlay(
        defs_style=defs_style,
        group=group,
        counts=scene_mod.counts(scan),
        warnings=tuple(warnings),
        out_of_canvas=tuple(out_of_canvas),
        missing_glyphs=(),
    )
