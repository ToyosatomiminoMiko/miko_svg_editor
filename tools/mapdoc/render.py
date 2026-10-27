"""scene + geo → 排版层 SVG 字符串（§5 布局公式的唯一 Python 实现）.

是什么: 纯函数把规范化后的 scene 与 typed geo 变成成品里的三段字符串——色标渐变
``render_defs``、图框+经纬网刻度 ``render_frame``、items 绘制 ``render_items``（外层由
``render_overlay`` 包成 ``<g id="mapdoc-overlay">``）。另有 ``format_number``（跨语言数字
格式）、``map_transform``（§5.1 的 s/tx/ty）、``analyze``（越界 item 与告警）。

为什么: 浏览器预览与 Python 合成必须只有一种解释, 而 §5 里没有写死的实现细节在这里
统一拍板——图例/色标在 map 空间时 origin 走 §5.1 且长度量按 s 缩放（page 空间 s=1 与公式
逐字一致）；刻度只画落在纸张内的; 文字 halo 是「先 halo 副本、后填充」; 渐变 id 固定为
``mapdoc-cbar-<item.id>``; 所有数值先经 format_number（3 位小数去尾零、无单位后缀, 1 用户
单位 = 1pt）再进属性, 所以同一输入永远得到同一字符串。文本内容做 XML 转义, 属性值额外
转义双引号, 其余字节拼接不经过 XML 树。

依赖: page.py 的 round_number/map_height; geo.py 的 Geo。
元信息: 2026-10, 出版排版编辑器 Python 合成侧; 契约见 docs/PAGE-EDITOR.md §5.
"""

from __future__ import annotations

import math
from typing import Any

from . import page as page_mod
from .geo import Geo

# 越界判定容差: 恰好压在纸张边界上不算越界（与旧 overlay 的 BBOX_EPS 同值）。
BBOX_EPS = 1e-6
# 星星内半径 ÷ 外接半径 = (3-√5)/2 ≈ 0.381966（matplotlib 五角星的比例, 前端同值）.
_STAR_INNER_RATIO = (3.0 - math.sqrt(5.0)) / 2.0
# 文字基线到视觉中心的近似偏移系数: cap-height 约 0.35em（§5.2/§5.4 的 *0.35 来源）.
_BASELINE_RATIO = 0.35


# ---------------------------------------------------------------------------
# 数字与转义
# ---------------------------------------------------------------------------


def format_number(value: float) -> str:
    """3 位小数、去尾零、无单位后缀; -0 与 NaN/Inf 归 "0"（与前端 formatNumber 同语义）.

    为什么返回 int 的字符串: page.round_number 会把整数值落成 int（28.0 → 28）,
    这样与 JS ``String(Math.round(v*1000)/1000)`` 的 "28" 一致; 否则 SVG 里写 "28.0"
    虽然合法, 但同一输入的字节会因 Python 版本/浮点表示不同而不稳定。
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"format_number 需要数字, 得到 {type(value).__name__}")
    number = float(value)
    if not math.isfinite(number):
        return "0"
    rounded = page_mod.round_number(number)
    if rounded == 0:
        return "0"
    if isinstance(rounded, int):
        return str(rounded)
    # 3 位定点后再去尾零: 用定点避免 repr 在极小/极大值上给出指数形式.
    text = f"{rounded:.3f}".rstrip("0")
    return text[:-1] if text.endswith(".") else text


def _escape_text(value: str) -> str:
    """文本节点转义: 只处理 & < >（§5.3），引号保持原样."""
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _escape_attr(value: str) -> str:
    """属性值转义: 双引号属性下转义 " 与 ', 与前端 escapeXmlAttribute 逐字一致.

    为什么连 ' 也转: font_family 里大量出现 'Noto Sans ...' 这种单引号, 前端 helper 统一转成
    &apos;; 两边输出一致, 成品与预览序列化对照时不会出现无意义的字节差。
    """
    return _escape_text(value).replace('"', "&quot;").replace("'", "&apos;")


# ---------------------------------------------------------------------------
# §5.1 坐标系
# ---------------------------------------------------------------------------


def map_transform(scene: dict[str, Any], geo: Geo) -> tuple[float, float, float]:
    """返回 (s, tx, ty): page(p) = (tx + p.x*s, ty + p.y*s)（§5.1）.

    为什么用 geo.base 而不是 scene.base 声明: 前者是服务器实测的底图坐标系, scene.base
    只是前端回传的声明; 声明过期由 compose 报告 base_changed, 几何仍按真实底图算。
    """
    base = geo.base
    scale = float(scene["map"]["width_pt"]) / base.width_pt
    tx = float(scene["map"]["x"]) - base.view_box[0] * scale
    ty = float(scene["map"]["y"]) - base.view_box[1] * scale
    return scale, tx, ty


def map_rect(scene: dict[str, Any], geo: Geo) -> tuple[float, float, float, float]:
    """地图框 (x, y, width, height); height 按 §4 纵横比派生."""
    return (
        float(scene["map"]["x"]),
        float(scene["map"]["y"]),
        float(scene["map"]["width_pt"]),
        page_mod.map_height(scene, geo.base),
    )


def _space_origin(
    item: dict[str, Any], scene: dict[str, Any], geo: Geo
) -> tuple[float, float, float]:
    """item 的 (x, y, 长度缩放系数 k).

    page 空间 k=1; map 空间 origin 过 §5.1 且 k=s——长度量（字号/行高/swatch）随之缩放,
    这样「放在地图坐标里的图例」和地图一起缩放。text 例外: 契约 §5.3 只变换起点、字号
    仍是 pt, 所以文字渲染不调用本函数处理字号。
    """
    if item.get("space") == "map":
        scale, tx, ty = map_transform(scene, geo)
        return tx + float(item["x"]) * scale, ty + float(item["y"]) * scale, scale
    return float(item["x"]), float(item["y"]), 1.0


def _page_point(
    scene: dict[str, Any], geo: Geo, space: str, x: float, y: float
) -> tuple[float, float]:
    """§5.1: page 空间原样, map 空间过 (tx + x*s, ty + y*s)."""
    if space == "map":
        scale, tx, ty = map_transform(scene, geo)
        return tx + x * scale, ty + y * scale
    return x, y


# ---------------------------------------------------------------------------
# 文本
# ---------------------------------------------------------------------------


def _text_element(
    x: float,
    y: float,
    text: str,
    *,
    anchor: str,
    family: str,
    font_size: float,
    fill: str,
    italic: bool,
    bold: bool,
    halo: dict[str, Any] | None = None,
) -> str:
    """一个 <text>; halo 副本的 fill/stroke 都用光晕色并带 paint-order=stroke（§5.3）."""
    attributes = [
        f'x="{format_number(x)}"',
        f'y="{format_number(y)}"',
        f'text-anchor="{anchor}"',
        f'font-family="{_escape_attr(family)}"',
        f'font-size="{format_number(font_size)}"',
    ]
    if italic:
        attributes.append('font-style="italic"')
    if bold:
        attributes.append('font-weight="bold"')
    attributes.append(f'fill="{_escape_attr(fill)}"')
    if halo is not None:
        attributes.append(f'stroke="{_escape_attr(str(halo["color"]))}"')
        attributes.append(f'stroke-width="{format_number(float(halo["width_pt"]))}"')
        attributes.append('paint-order="stroke"')
    return f'<text {" ".join(attributes)}>{_escape_text(text)}</text>'


def _render_text_item(
    item: dict[str, Any], scene: dict[str, Any], geo: Geo
) -> list[str]:
    """text item§5.3: 逐行基线 y=py+i*fs*lh; 多行整体绕第一行锚点旋转."""
    style = scene["style"]
    px, py = _page_point(scene, geo, item["space"], float(item["x"]), float(item["y"]))
    font_size = float(item["font_size_pt"])
    line_height = float(item["line_height"])
    family = item["font_family"] or style["font_family"]
    anchor = item["anchor"]
    color = item["color"]
    halo = item["halo"]
    italic = bool(item["italic"])
    bold = bool(item["bold"])

    # 为什么 halo 行全部先画: 与前端 haloGroup→fillGroup 的层序一致, 多行时不会出现
    # "上一行 halo 盖住下一行填充" 的视觉差（单行时两种顺序等价）。
    halo_children: list[str] = []
    fill_children: list[str] = []
    for index, line in enumerate(item["lines"]):
        baseline = py + index * font_size * line_height
        if halo is not None:
            halo_children.append(
                _text_element(
                    px,
                    baseline,
                    line,
                    anchor=anchor,
                    family=family,
                    font_size=font_size,
                    fill=halo["color"],
                    italic=italic,
                    bold=bold,
                    halo=halo,
                )
            )
        fill_children.append(
            _text_element(
                px,
                baseline,
                line,
                anchor=anchor,
                family=family,
                font_size=font_size,
                fill=color,
                italic=italic,
                bold=bold,
            )
        )
    children = halo_children + fill_children

    rotation = float(item["rotation_deg"])
    if rotation != 0:
        transform = (
            f'rotate({format_number(rotation)} '
            f'{format_number(px)} {format_number(py)})'
        )
        return [f'<g transform="{transform}">', *children, "</g>"]
    return children


# ---------------------------------------------------------------------------
# §5.2 图框与刻度
# ---------------------------------------------------------------------------


def _render_frame_rect(
    scene: dict[str, Any], geo: Geo
) -> str:
    """图框: fill=none 的矩形, stroke/线宽来自 frame."""
    frame = scene["frame"]
    x, y, width, height = map_rect(scene, geo)
    return (
        f'<rect x="{format_number(x)}" y="{format_number(y)}" '
        f'width="{format_number(width)}" height="{format_number(height)}" '
        f'fill="none" stroke="{_escape_attr(frame["stroke"])}" '
        f'stroke-width="{format_number(float(frame["width_pt"]))}"/>'
    )


def _render_lon_ticks(
    scene: dict[str, Any], geo: Geo, side: str
) -> list[str]:
    """经度刻度（bottom/top）: 竖线 + 居中标签, 只画 x 落在纸张内的（§5.2）."""
    frame = scene["frame"]
    paper_width = float(scene["paper"]["width_pt"])
    map_x, map_y, map_width, map_height = map_rect(scene, geo)
    tick_length = float(frame["tick_length_pt"])
    tick_font_size = float(frame["tick_font_size_pt"])
    tick_gap = float(frame["tick_gap_pt"])
    family = scene["style"]["font_family"]
    color = frame["tick_color"]
    width = float(frame["width_pt"])
    scale, tx, _ty = map_transform(scene, geo)

    children: list[str] = []
    for tick in geo.graticule.lon:
        if tick.side != side:
            continue
        px = tx + tick.x * scale
        if px < 0 or px > paper_width:
            continue
        if side == "bottom":
            start_y = map_y + map_height
            end_y = start_y + tick_length
            baseline = end_y + tick_gap + tick_font_size
        else:
            start_y = map_y
            end_y = start_y - tick_length
            baseline = end_y - tick_gap
        children.append(
            f'<line x1="{format_number(px)}" y1="{format_number(start_y)}" '
            f'x2="{format_number(px)}" y2="{format_number(end_y)}" '
            f'stroke="{_escape_attr(color)}" stroke-width="{format_number(width)}"/>'
        )
        children.append(
            _text_element(
                px,
                baseline,
                tick.label,
                anchor="middle",
                family=family,
                font_size=tick_font_size,
                fill=color,
                italic=False,
                bold=False,
            )
        )
    return children


def _render_lat_ticks(
    scene: dict[str, Any], geo: Geo, side: str
) -> list[str]:
    """纬度刻度（left/right）: 横线 + 端对齐标签, 只画 y 落在纸张内的（§5.2）."""
    frame = scene["frame"]
    paper_height = float(scene["paper"]["height_pt"])
    map_x, map_y, map_width, _height = map_rect(scene, geo)
    tick_length = float(frame["tick_length_pt"])
    tick_font_size = float(frame["tick_font_size_pt"])
    tick_gap = float(frame["tick_gap_pt"])
    family = scene["style"]["font_family"]
    color = frame["tick_color"]
    width = float(frame["width_pt"])
    scale, _tx, ty = map_transform(scene, geo)

    children: list[str] = []
    for tick in geo.graticule.lat:
        if tick.side != side:
            continue
        py = ty + tick.y * scale
        if py < 0 or py > paper_height:
            continue
        if side == "left":
            start_x = map_x
            end_x = start_x - tick_length
            label_x = end_x - tick_gap
            anchor = "end"
        else:
            start_x = map_x + map_width
            end_x = start_x + tick_length
            label_x = end_x + tick_gap
            anchor = "start"
        children.append(
            f'<line x1="{format_number(start_x)}" y1="{format_number(py)}" '
            f'x2="{format_number(end_x)}" y2="{format_number(py)}" '
            f'stroke="{_escape_attr(color)}" stroke-width="{format_number(width)}"/>'
        )
        children.append(
            _text_element(
                label_x,
                py + tick_font_size * _BASELINE_RATIO,
                tick.label,
                anchor=anchor,
                family=family,
                font_size=tick_font_size,
                fill=color,
                italic=False,
                bold=False,
            )
        )
    return children


def render_frame(scene: dict[str, Any], geo: Geo) -> str:
    """``<g id="mapdoc-frame">``: 图框 + 经纬网刻度; show/ticks 关闭时该部分为空."""
    frame = scene["frame"]
    children: list[str] = []
    if frame["show"]:
        children.append(_render_frame_rect(scene, geo))
    if frame["ticks"]:
        for side in ("bottom", "top"):
            children.extend(_render_lon_ticks(scene, geo, side))
        for side in ("left", "right"):
            children.extend(_render_lat_ticks(scene, geo, side))
    return _group("mapdoc-frame", children)


# ---------------------------------------------------------------------------
# §5.4 图例
# ---------------------------------------------------------------------------


def _legend_metrics(item: dict[str, Any]) -> tuple[float, float, float, float]:
    """图例 (padding, row_h, title_h, height)（§5.4）.

    为什么只有 width_pt 随 map 空间缩放: §5.4 是 pt 布局公式, 前端 legendLayout 对 map 空间
    也只缩放宽度（行高/字号/padding 保持 pt）, 两端必须同一口径。
    """
    padding = float(item["padding_pt"])
    font_size = float(item["font_size_pt"])
    row_height = max(float(item["row_height_pt"]), font_size * 1.5)
    title_height = float(item["title_size_pt"]) * 1.4 if item["title"] else 0.0
    height = padding * 2 + title_height + len(item["entries"]) * row_height
    return padding, row_height, title_height, height


def _line_attributes(
    stroke: str | None,
    width: float,
    dash: tuple[float, float] | list[float] | None,
) -> list[str]:
    """图例线/矩形共用的描边属性（dash 用空格分隔, §5.4/前端同值）."""
    attributes: list[str] = []
    if stroke is not None:
        attributes.append(f'stroke="{_escape_attr(stroke)}"')
        attributes.append(f'stroke-width="{format_number(width)}"')
    if dash is not None:
        attributes.append(
            f'stroke-dasharray="{format_number(float(dash[0]))} '
            f'{format_number(float(dash[1]))}"'
        )
    return attributes


def _star_points(cx: float, cy: float, outer: float) -> str:
    """五角星顶点: 外点 -90°+k*72°, 内点半径 outer*(3-√5)/2（前端同几何）."""
    inner = outer * _STAR_INNER_RATIO
    points: list[str] = []
    for index in range(10):
        radius = outer if index % 2 == 0 else inner
        angle = -math.pi / 2.0 + index * (math.pi / 5.0)
        points.append(
            f"{format_number(cx + radius * math.cos(angle))},"
            f"{format_number(cy + radius * math.sin(angle))}"
        )
    return " ".join(points)


def _point_marker(
    entry: dict[str, Any], cx: float, cy: float, font_size: float
) -> str:
    """point 形状的 marker: star/square/circle, 半径/边长按 §5.4（单位 pt）."""
    marker = entry["marker"]
    stroke = entry["stroke"]
    fill = entry["fill"] if entry["fill"] is not None else stroke
    opacity = float(entry["opacity"])
    attributes = [
        f'fill="{_escape_attr(fill)}"' if fill is not None else 'fill="none"'
    ]
    if stroke is not None:
        attributes.append(f'stroke="{_escape_attr(stroke)}"')
        attributes.append(
            f'stroke-width="{format_number(float(entry["width_pt"]))}"'
        )
    attributes.append(f'opacity="{format_number(opacity)}"')
    suffix = " ".join(attributes)
    if marker == "star":
        outer = font_size * 0.55
        return f'<polygon points="{_star_points(cx, cy, outer)}" {suffix}/>'
    if marker == "square":
        side = font_size * 0.7
        return (
            f'<rect x="{format_number(cx - side / 2)}" '
            f'y="{format_number(cy - side / 2)}" '
            f'width="{format_number(side)}" height="{format_number(side)}" {suffix}/>'
        )
    # circle（校验保证 marker 只可能是 star|square|circle）
    return (
        f'<circle cx="{format_number(cx)}" cy="{format_number(cy)}" '
        f'r="{format_number(font_size * 0.35)}" {suffix}/>'
    )


def _render_legend_item(
    item: dict[str, Any], scene: dict[str, Any], geo: Geo
) -> list[str]:
    """legend item§5.4: 底板、标题、逐行 swatch+label; 高度由公式派生."""
    style = scene["style"]
    x, y, scale = _space_origin(item, scene, geo)
    # 只有宽度随 map 空间缩放; 字号/行高/padding 是 pt, 不随底图缩放（前端 legendLayout 同口径）.
    width = float(item["width_pt"]) * scale
    padding, row_height, title_height, height = _legend_metrics(item)
    font_size = float(item["font_size_pt"])
    title_size = float(item["title_size_pt"])
    family = style["font_family"]
    text_color = style["color"]
    frame = item["frame"]

    children: list[str] = []
    if frame["show"]:
        # 前端约定（已 sync）: 底板透明度是 fill-opacity, 只影响白底不影响描边.
        children.append(
            f'<rect x="{format_number(x)}" y="{format_number(y)}" '
            f'width="{format_number(width)}" height="{format_number(height)}" '
            f'fill="{_escape_attr(frame["fill"])}" '
            f'fill-opacity="{format_number(float(frame["opacity"]))}" '
            f'stroke="{_escape_attr(frame["stroke"])}" '
            f'stroke-width="{format_number(float(frame["width_pt"]))}"/>'
        )
    if item["title"]:
        children.append(
            _text_element(
                x + width / 2,
                y + padding + title_size,
                item["title"],
                anchor="middle",
                family=family,
                font_size=title_size,
                fill=text_color,
                italic=False,
                bold=False,
            )
        )

    swatch_x0 = x + padding
    swatch_x1 = swatch_x0 + float(item["swatch_width_pt"])
    label_x = swatch_x1 + float(item["swatch_gap_pt"])
    for index, entry in enumerate(item["entries"]):
        center_y = y + padding + title_height + row_height * (index + 0.5)
        shape = entry["shape"]
        if shape == "line":
            attrs = _line_attributes(
                entry["stroke"], float(entry["width_pt"]), entry["dash"]
            )
            attrs.append(f'opacity="{format_number(float(entry["opacity"]))}"')
            children.append(
                f'<line x1="{format_number(swatch_x0)}" '
                f'y1="{format_number(center_y)}" '
                f'x2="{format_number(swatch_x1)}" '
                f'y2="{format_number(center_y)}" {" ".join(attrs)}/>'
            )
        elif shape == "rect":
            rect_height = font_size * 0.9
            attrs = _line_attributes(
                entry["stroke"], float(entry["width_pt"]), entry["dash"]
            )
            fill = entry["fill"] if entry["fill"] is not None else "none"
            attrs.insert(0, f'fill="{_escape_attr(fill)}"')
            attrs.append(f'opacity="{format_number(float(entry["opacity"]))}"')
            children.append(
                f'<rect x="{format_number(swatch_x0)}" '
                f'y="{format_number(center_y - rect_height / 2)}" '
                f'width="{format_number(swatch_x1 - swatch_x0)}" '
                f'height="{format_number(rect_height)}" {" ".join(attrs)}/>'
            )
        else:
            children.append(
                _point_marker(
                    entry,
                    (swatch_x0 + swatch_x1) / 2.0,
                    center_y,
                    font_size,
                )
            )
        children.append(
            _text_element(
                label_x,
                center_y + font_size * _BASELINE_RATIO,
                entry["label"],
                anchor="start",
                family=family,
                font_size=font_size,
                fill=text_color,
                italic=False,
                bold=False,
            )
        )
    return children


# ---------------------------------------------------------------------------
# §5.5 色标
# ---------------------------------------------------------------------------


def _relief_for(item: dict[str, Any], geo: Geo):
    """取 colorbar 需要的 geo.relief; 缺失或退化区间时给出可定位的中文错误."""
    if geo.relief is None:
        raise ValueError(f"colorbar item {item['id']} 需要 geo.relief, 但 geo 未提供")
    if not geo.relief.vmax > geo.relief.vmin:
        raise ValueError(
            f"colorbar item {item['id']} 的 geo.relief.vmin 必须 < vmax"
        )
    return geo.relief


def _tick_value(value: float) -> str:
    """色标刻度文本: 数字 3 位去尾零、无单位后缀（§3/§5.5）."""
    return format_number(value)


def _render_colorbar_item(
    item: dict[str, Any], scene: dict[str, Any], geo: Geo
) -> list[str]:
    """colorbar item§5.5: 渐变矩形 + 标题 + 右侧刻度短线与标签."""
    style = scene["style"]
    relief = _relief_for(item, geo)
    x, y, scale = _space_origin(item, scene, geo)
    width = float(item["width_pt"]) * scale
    height = float(item["height_pt"]) * scale
    family = style["font_family"]
    text_color = style["color"]
    # 字号与刻度外伸长度是 pt, 不随 map 空间缩放（前端 colorbarLayout 同口径）.
    title_size = float(item["title_size_pt"])
    label_size = float(item["label_size_pt"])

    children: list[str] = []
    if item["show_title"] and item["title"]:
        title = item["title"]
        unit = item["unit"].strip()
        # unit 非空且标题里还没写单位时补 " (unit)"; 单位后缀只出现在标题, 刻度数字不带单位.
        if unit and unit not in title:
            title = f"{title} ({unit})"
        children.append(
            _text_element(
                x + width / 2,
                y - 4,
                title,
                anchor="middle",
                family=family,
                font_size=title_size,
                fill=text_color,
                italic=False,
                bold=False,
            )
        )
    children.append(
        f'<rect x="{format_number(x)}" y="{format_number(y)}" '
        f'width="{format_number(width)}" height="{format_number(height)}" '
        f'fill="url(#mapdoc-cbar-{item["id"]})"/>'
    )
    if item["show_ticks"]:
        span = relief.vmax - relief.vmin
        for value in relief.ticks:
            # §5.5 对每个 tick 都套同一个线性映射（不裁剪）; geo 正常都在 [vmin, vmax] 内,
            # 越界值画出色标矩形是数据问题, 静默丢弃反而让成品与前端预览不一致.
            fraction = (value - relief.vmin) / span
            tick_y = y + height * (1.0 - fraction)
            children.append(
                f'<line x1="{format_number(x + width)}" '
                f'y1="{format_number(tick_y)}" '
                f'x2="{format_number(x + width + 3)}" '
                f'y2="{format_number(tick_y)}" '
                f'stroke="{_escape_attr(text_color)}"/>'
            )
            children.append(
                _text_element(
                    x + width + 5,
                    tick_y + label_size * _BASELINE_RATIO,
                    _tick_value(value),
                    anchor="start",
                    family=family,
                    font_size=label_size,
                    fill=text_color,
                    italic=False,
                    bold=False,
                )
            )
    return children


# ---------------------------------------------------------------------------
# 色标渐变 defs / items / overlay
# ---------------------------------------------------------------------------


def render_defs(scene: dict[str, Any], geo: Geo) -> str:
    """``<defs>`` 里的色标线性渐变（id ``mapdoc-cbar-<item.id>``, 下=vmin, 上=vmax）.

    为什么渐变放在独立 defs: 渐变可被文档后面任意元素按 id 引用, 放在 overlay 组内也能
    工作, 但独立一段让 compose 的图层顺序与 §6 一致、也让缺省时输出天然为空。
    """
    gradients: list[str] = []
    for item in scene["items"]:
        if item["kind"] != "colorbar":
            continue
        relief = _relief_for(item, geo)
        stops: list[str] = []
        for stop in relief.stops:
            stops.append(
                f'<stop offset="{format_number(float(stop.offset))}" '
                f'stop-color="{_escape_attr(stop.color)}"/>'
            )
        gradients.append(
            f'<linearGradient id="mapdoc-cbar-{item["id"]}" '
            f'x1="0" y1="100%" x2="0" y2="0%">\n'
            + "\n".join(stops)
            + "\n</linearGradient>"
        )
    if not gradients:
        return ""
    return "<defs>\n" + "\n".join(gradients) + "\n</defs>"


def _item_elements(scene: dict[str, Any], geo: Geo) -> list[str]:
    """按数组序（= z 序, §4.1）渲染全部 item, 返回子元素列表."""
    children: list[str] = []
    for item in scene["items"]:
        kind = item["kind"]
        if kind == "text":
            children.extend(_render_text_item(item, scene, geo))
        elif kind == "legend":
            children.extend(_render_legend_item(item, scene, geo))
        elif kind == "colorbar":
            children.extend(_render_colorbar_item(item, scene, geo))
        else:  # pragma: no cover - validate_scene 已挡住
            raise ValueError(f"未知 item kind: {kind}")
    return children


def render_items(scene: dict[str, Any], geo: Geo) -> str:
    """按数组序渲染全部 item, 返回子元素串（不含 <g> 包装）."""
    return "\n".join(_item_elements(scene, geo))


def _group(group_id: str, children: list[str]) -> str:
    """图层组包装: 空组也保留, 让成品的图层结构稳定（便于 diff 与前端定位）."""
    if not children:
        return f'<g id="{group_id}"></g>'
    return f'<g id="{group_id}">\n' + "\n".join(children) + "\n</g>"


def render_overlay(scene: dict[str, Any], geo: Geo) -> str:
    """``<g id="mapdoc-overlay">``: items 按数组序（§6）; marker 不在这里, 由 compose 追加."""
    return _group("mapdoc-overlay", _item_elements(scene, geo))


# ---------------------------------------------------------------------------
# 越界分析
# ---------------------------------------------------------------------------


def _item_bbox(
    item: dict[str, Any], scene: dict[str, Any], geo: Geo
) -> tuple[float, float, float, float]:
    """item 在纸张坐标里的近似包围盒; 文字按锚点（不含旋转/字宽, 只用于越界告警）."""
    kind = item["kind"]
    if kind == "text":
        px, py = _page_point(
            scene, geo, item["space"], float(item["x"]), float(item["y"])
        )
        return px, py, px, py
    x, y, scale = _space_origin(item, scene, geo)
    if kind == "legend":
        _padding, _row_height, _title_height, height = _legend_metrics(item)
        width = float(item["width_pt"]) * scale
        return x, y, x + width, y + height
    # colorbar
    return (
        x,
        y,
        x + float(item["width_pt"]) * scale,
        y + float(item["height_pt"]) * scale,
    )


def analyze(
    scene: dict[str, Any], geo: Geo
) -> tuple[list[int], list[str]]:
    """越界 item id（按 items 顺序）与对应中文告警; 只提示不拒绝（§4）."""
    paper_width = float(scene["paper"]["width_pt"])
    paper_height = float(scene["paper"]["height_pt"])
    out_of_paper: list[int] = []
    warnings: list[str] = []
    for item in scene["items"]:
        min_x, min_y, max_x, max_y = _item_bbox(item, scene, geo)
        if (
            min_x < -BBOX_EPS
            or min_y < -BBOX_EPS
            or max_x > paper_width + BBOX_EPS
            or max_y > paper_height + BBOX_EPS
        ):
            out_of_paper.append(int(item["id"]))
            warnings.append(
                f"item {item['id']}({item['kind']}) 超出纸张范围，成品里可能被裁掉"
            )
    return out_of_paper, warnings
