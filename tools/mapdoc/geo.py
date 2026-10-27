"""geo.json（format ``mapdoc-geo`` v1，只读）的 typed 访问、校验与摘要.

是什么: ``read_geo(path)`` 读文件并转成 frozen dataclass 树（GeoBase/Graticule/
Label/Relief/GeoLegend/Suggestions）, ``validate_geo(doc)`` 按 docs/PAGE-EDITOR.md §3
校验原始 dict, ``geo_digest(geo)`` 对规范化 geo JSON 取 sha256（final marker 的 "geo"）。

为什么: geo 是 cartopy 侧/准备脚本产出、前端与 Python 都只读的元数据。合成只需要
base（§5.1 变换的 viewBox/尺寸）、graticule（图框刻度）、relief（色标渐变与刻度）;
labels/legend/suggestions 是前端建默认排版用的, 这里仍然 typed 化并校验, 让口径只有一份。
可选块（labels/relief/legend/suggestions/style）缺省即 None/空, 这样提前出图的 geo
不会因为少写一块就让 compose 整体拒收; 但结构性错误（viewBox 宽高、刻度 side、颜色等）
一律报中文错误。digest 把数值收敛到 3 位小数、颜色小写, 与渲染输出的口径一致。

依赖: page.py 的 round_number/canonical_json/枚举常量（两边共享同一跨语言口径）。
元信息: 2026-10, 出版排版编辑器 Python 合成侧; 契约见 docs/PAGE-EDITOR.md §3.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

from . import page as page_mod

# 契约身份.
FORMAT: Final[str] = "mapdoc-geo"
VERSION: Final[int] = 1

# §3 枚举: 标注类别、经度刻度所在边、纬度刻度所在边.
LABEL_KINDS: Final[tuple[str, ...]] = (
    "country",
    "sea",
    "highland",
    "river",
    "city",
    "area",
    "other",
)
LON_SIDES: Final[tuple[str, ...]] = ("bottom", "top")
LAT_SIDES: Final[tuple[str, ...]] = ("left", "right")
# 图例形状/标记与 scene 共用同一套枚举, 直接复用 page 的定义, 避免两份字面量漂移.
LEGEND_SHAPES: Final[tuple[str, ...]] = page_mod.LEGEND_SHAPES
LEGEND_MARKERS: Final[tuple[str, ...]] = page_mod.LEGEND_MARKERS

_COLOR_RE = re.compile(r"#[0-9a-fA-F]{6}\Z")
_SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
# viewBox 与 width_pt/height_pt 的允许偏差: 两者都来自同一 viewBox, 只容忍 3 位小数舍入.
_SIZE_TOLERANCE_PT: Final[float] = 0.01


class GeoError(ValueError):
    """geo.json 缺失/不是合法 JSON/不符合 §3; compose 会把它映射成 GeoInvalid(503)."""

    def __init__(self, errors: str | tuple[str, ...] | list[str]):
        if isinstance(errors, str):
            self.errors: tuple[str, ...] = (errors,)
        else:
            self.errors = tuple(errors)
        super().__init__("; ".join(self.errors) or "geo 不合法")


# ---------------------------------------------------------------------------
# typed 模型: 只读的 frozen dataclass
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class GeoBase:
    """底图身份与坐标系: viewBox 的 minx/miny 决定 §5.1 的 tx/ty, w/h 决定缩放."""

    sha256: str
    view_box: tuple[float, float, float, float]
    width_pt: float
    height_pt: float


@dataclass(frozen=True)
class GraticuleTick:
    """一条经纬网刻度: 坐标在底图 viewBox 坐标系, side 决定画在哪一侧."""

    value: float
    label: str
    x: float
    y: float
    side: str


@dataclass(frozen=True)
class GraticuleStyle:
    """原图经纬线样式（只读记录; 成品图框刻度用 scene.frame 的颜色/字号）."""

    stroke: str
    width_pt: float
    dash: tuple[float, float] | None
    opacity: float


@dataclass(frozen=True)
class Graticule:
    """经度/纬度刻度表; style 可缺省（extract 的旧版本可能没给）."""

    lon: tuple[GraticuleTick, ...]
    lat: tuple[GraticuleTick, ...]
    style: GraticuleStyle | None


@dataclass(frozen=True)
class LabelHalo:
    """地名光晕; width_pt 是描边宽度, 颜色通常为纸张底色."""

    color: str
    width_pt: float


@dataclass(frozen=True)
class Label:
    """地名标注候选（底图坐标）; 前端建默认 scene 时逐条转成 text item."""

    id: str
    kind: str
    text: str
    lines: tuple[str, ...]
    x: float
    y: float
    rotation_deg: float
    anchor: str
    font_size_pt: float
    color: str
    italic: bool
    halo: LabelHalo | None
    order: int


@dataclass(frozen=True)
class ReliefStop:
    """色标 stops 的一项: offset ∈ [0,1] 从 vmin 侧开始."""

    offset: float
    color: str


@dataclass(frozen=True)
class Relief:
    """高程/水深配色与刻度; colorbar item 的全部数据来源（scene 不重复存）."""

    title: str
    unit: str
    vmin: float
    vmax: float
    stops: tuple[ReliefStop, ...]
    ticks: tuple[float, ...]


@dataclass(frozen=True)
class LegendEntry:
    """geo 图例条目（合成时不用; 前端建默认 legend item 时复制）."""

    label: str
    shape: str
    stroke: str | None
    width_pt: float
    dash: tuple[float, float] | None
    fill: str | None
    opacity: float
    marker: str | None


@dataclass(frozen=True)
class GeoLegend:
    """图例标题与条目."""

    title: str
    entries: tuple[LegendEntry, ...]


@dataclass(frozen=True)
class Suggestions:
    """默认文案候选: 只用于前端「从底图初始化」预填, 不参与合成."""

    title: str
    subtitle: str
    notes: tuple[str, ...]
    source: str
    area_annotation: tuple[str, ...]
    legend_title: str
    colorbar_title: str


@dataclass(frozen=True)
class Geo:
    """一份完整 geo 元数据; 所有下游代码只通过它拿数据."""

    format: str
    version: int
    base: GeoBase
    graticule: Graticule
    labels: tuple[Label, ...]
    relief: Relief | None
    legend: GeoLegend | None
    suggestions: Suggestions | None


# ---------------------------------------------------------------------------
# 校验: §3
# ---------------------------------------------------------------------------


def _is_number(value: Any) -> bool:
    """数字判定（排除 bool, 同 page.py 的理由）."""
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _finite(
    errors: list[str],
    value: Any,
    path: str,
    *,
    gt: float | None = None,
    ge: float | None = None,
    le: float | None = None,
) -> float | None:
    """有限数字 + 可选区间检查; 失败返回 None."""
    if not _is_number(value):
        errors.append(f"{path} 必须是数字（得到 {value!r}）")
        return None
    number = float(value)
    if not math.isfinite(number):
        errors.append(f"{path} 必须是有限数字（得到 {value!r}）")
        return None
    if gt is not None and not number > gt:
        errors.append(f"{path} 必须 > {gt}（得到 {value!r}）")
    if ge is not None and not number >= ge:
        errors.append(f"{path} 必须 >= {ge}（得到 {value!r}）")
    if le is not None and not number <= le:
        errors.append(f"{path} 必须 <= {le}（得到 {value!r}）")
    return number


def _string(errors: list[str], value: Any, path: str, *, allow_empty: bool = True) -> str | None:
    """字符串检查."""
    if not isinstance(value, str):
        errors.append(f"{path} 必须是字符串（得到 {value!r}）")
        return None
    if not allow_empty and not value:
        errors.append(f"{path} 不能为空")
        return None
    return value


def _optional_string(errors: list[str], value: Any, path: str) -> str | None:
    """null 或非空字符串."""
    if value is None:
        return None
    return _string(errors, value, path, allow_empty=False)


def _enum(
    errors: list[str], value: Any, allowed: tuple[str, ...], path: str
) -> str | None:
    """枚举成员检查."""
    if not isinstance(value, str) or value not in allowed:
        errors.append(f"{path} 必须是 {'|'.join(allowed)} 之一（得到 {value!r}）")
        return None
    return value


def _color(errors: list[str], value: Any, path: str) -> str | None:
    """严格 #rrggbb."""
    if not isinstance(value, str) or _COLOR_RE.fullmatch(value) is None:
        errors.append(f"{path} 必须是 #rrggbb 颜色（得到 {value!r}）")
        return None
    return value


def _sha(errors: list[str], value: Any, path: str) -> str | None:
    """64 位小写十六进制 sha256."""
    if not isinstance(value, str) or _SHA256_RE.fullmatch(value) is None:
        errors.append(f"{path} 必须是 64 位小写十六进制 sha256（得到 {value!r}）")
        return None
    return value


def _dash(errors: list[str], value: Any, path: str) -> tuple[float, float] | None:
    """null 或 [a, b] 两个非负数字."""
    if value is None:
        return None
    if not isinstance(value, list) or len(value) != 2:
        errors.append(f"{path} 必须是 null 或长度为 2 的数字数组（得到 {value!r}）")
        return None
    first = _finite(errors, value[0], f"{path}[0]", ge=0)
    second = _finite(errors, value[1], f"{path}[1]", ge=0)
    if first is None or second is None:
        return None
    return first, second


def _check_required(errors: list[str], obj: Mapping[str, Any], keys: Sequence[str], path: str) -> None:
    """必填字段（geo 允许额外键, 只查缺）."""
    for key in keys:
        if key not in obj:
            errors.append(f"{path} 缺少字段 {key}")


def _validate_base(errors: list[str], base: Any) -> None:
    """geo.base 必须与底图字节一致: viewBox 是 §5.1 变换的坐标系原点来源."""
    if not isinstance(base, Mapping):
        errors.append(f"geo.base 必须是对象（得到 {base!r}）")
        return
    _check_required(errors, base, ("sha256", "view_box", "width_pt", "height_pt"), "geo.base")
    _sha(errors, base.get("sha256"), "geo.base.sha256")
    view_box = base.get("view_box")
    view_width = view_height = None
    if not isinstance(view_box, (list, tuple)) or len(view_box) != 4:
        errors.append(f"geo.base.view_box 必须是 [x, y, w, h]（得到 {view_box!r}）")
    else:
        values = [
            _finite(errors, value, f"geo.base.view_box[{index}]")
            for index, value in enumerate(view_box)
        ]
        if all(value is not None for value in values):
            view_width, view_height = values[2], values[3]
            if not view_width > 0 or not view_height > 0:
                errors.append(
                    f"geo.base.view_box 的宽高必须 > 0（得到 {view_width}x{view_height}）"
                )
    width = _finite(errors, base.get("width_pt"), "geo.base.width_pt", gt=0)
    height = _finite(errors, base.get("height_pt"), "geo.base.height_pt", gt=0)
    if width is not None and view_width is not None:
        if abs(width - view_width) > _SIZE_TOLERANCE_PT:
            errors.append(
                "geo.base.width_pt 必须等于 view_box 宽度"
                f"（{width} vs {view_width}）"
            )
    if height is not None and view_height is not None:
        if abs(height - view_height) > _SIZE_TOLERANCE_PT:
            errors.append(
                "geo.base.height_pt 必须等于 view_box 高度"
                f"（{height} vs {view_height}）"
            )


def _validate_tick(
    errors: list[str], tick: Any, sides: tuple[str, ...], path: str
) -> None:
    """一条经纬网刻度: label 只能是标签候选（不解析度数/方向）."""
    if not isinstance(tick, Mapping):
        errors.append(f"{path} 必须是对象（得到 {tick!r}）")
        return
    _check_required(errors, tick, ("value", "label", "x", "y", "side"), path)
    _finite(errors, tick.get("value"), f"{path}.value")
    _string(errors, tick.get("label"), f"{path}.label")
    _finite(errors, tick.get("x"), f"{path}.x")
    _finite(errors, tick.get("y"), f"{path}.y")
    _enum(errors, tick.get("side"), sides, f"{path}.side")


def _validate_graticule(errors: list[str], graticule: Any) -> None:
    """经纬度刻度表: lon 用 bottom|top, lat 用 left|right（§3）."""
    if not isinstance(graticule, Mapping):
        errors.append(f"geo.graticule 必须是对象（得到 {graticule!r}）")
        return
    _check_required(errors, graticule, ("lon", "lat"), "geo.graticule")
    for axis, sides in (("lon", LON_SIDES), ("lat", LAT_SIDES)):
        ticks = graticule.get(axis)
        if not isinstance(ticks, list):
            errors.append(f"geo.graticule.{axis} 必须是数组（得到 {ticks!r}）")
            continue
        for index, tick in enumerate(ticks):
            _validate_tick(errors, tick, sides, f"geo.graticule.{axis}[{index}]")
    style = graticule.get("style")
    if style is not None:
        if not isinstance(style, Mapping):
            errors.append(f"geo.graticule.style 必须是对象（得到 {style!r}）")
            return
        _check_required(errors, style, ("stroke", "width_pt", "opacity"), "geo.graticule.style")
        _color(errors, style.get("stroke"), "geo.graticule.style.stroke")
        _finite(errors, style.get("width_pt"), "geo.graticule.style.width_pt", ge=0)
        _dash(errors, style.get("dash"), "geo.graticule.style.dash")
        _finite(
            errors,
            style.get("opacity"),
            "geo.graticule.style.opacity",
            ge=0,
            le=1,
        )


def _validate_label_halo(errors: list[str], halo: Any, path: str) -> None:
    """地名光晕: null 或 {color, width_pt}."""
    if halo is None:
        return
    if not isinstance(halo, Mapping):
        errors.append(f"{path} 必须是 null 或对象（得到 {halo!r}）")
        return
    _check_required(errors, halo, ("color", "width_pt"), path)
    _color(errors, halo.get("color"), f"{path}.color")
    _finite(errors, halo.get("width_pt"), f"{path}.width_pt", gt=0)


def _validate_labels(errors: list[str], labels: Any) -> None:
    """地名候选: 坐标在底图坐标系, lines 缺省时由 text 单行补齐."""
    if not isinstance(labels, list):
        errors.append(f"geo.labels 必须是数组（得到 {labels!r}）")
        return
    for index, label in enumerate(labels):
        path = f"geo.labels[{index}]"
        if not isinstance(label, Mapping):
            errors.append(f"{path} 必须是对象（得到 {label!r}）")
            continue
        _check_required(
            errors,
            label,
            ("id", "kind", "text", "x", "y"),
            path,
        )
        _string(errors, label.get("id"), f"{path}.id", allow_empty=False)
        _enum(errors, label.get("kind"), LABEL_KINDS, f"{path}.kind")
        _string(errors, label.get("text"), f"{path}.text")
        _finite(errors, label.get("x"), f"{path}.x")
        _finite(errors, label.get("y"), f"{path}.y")
        lines = label.get("lines")
        if lines is not None:
            if not isinstance(lines, list) or not lines:
                errors.append(f"{path}.lines 必须是非空字符串数组（得到 {lines!r}）")
            else:
                for line_index, line in enumerate(lines):
                    _string(errors, line, f"{path}.lines[{line_index}]")
        if "rotation_deg" in label:
            _finite(errors, label.get("rotation_deg"), f"{path}.rotation_deg")
        if "anchor" in label:
            _enum(errors, label.get("anchor"), page_mod.TEXT_ANCHORS, f"{path}.anchor")
        if "font_size_pt" in label:
            _finite(errors, label.get("font_size_pt"), f"{path}.font_size_pt", gt=0)
        if "color" in label:
            _color(errors, label.get("color"), f"{path}.color")
        if "italic" in label and not isinstance(label.get("italic"), bool):
            errors.append(f"{path}.italic 必须是布尔值（得到 {label.get('italic')!r}）")
        if "halo" in label:
            _validate_label_halo(errors, label.get("halo"), f"{path}.halo")
        if "order" in label and not isinstance(label.get("order"), int):
            errors.append(f"{path}.order 必须是整数（得到 {label.get('order')!r}）")


def _validate_relief(errors: list[str], relief: Any) -> None:
    """色标: vmin < vmax, stops offset ∈ [0,1] 且颜色合法, ticks 是数字数组."""
    if not isinstance(relief, Mapping):
        errors.append(f"geo.relief 必须是对象（得到 {relief!r}）")
        return
    _check_required(errors, relief, ("title", "unit", "vmin", "vmax", "stops", "ticks"), "geo.relief")
    _string(errors, relief.get("title"), "geo.relief.title")
    _string(errors, relief.get("unit"), "geo.relief.unit")
    vmin = _finite(errors, relief.get("vmin"), "geo.relief.vmin")
    vmax = _finite(errors, relief.get("vmax"), "geo.relief.vmax")
    if vmin is not None and vmax is not None and not vmin < vmax:
        errors.append(f"geo.relief.vmin 必须 < vmax（得到 {vmin} vs {vmax}）")
    stops = relief.get("stops")
    if not isinstance(stops, list):
        errors.append(f"geo.relief.stops 必须是数组（得到 {stops!r}）")
    else:
        if len(stops) < 2:
            errors.append(f"geo.relief.stops 至少需要 2 项（得到 {len(stops)}）")
        for index, stop in enumerate(stops):
            path = f"geo.relief.stops[{index}]"
            if not isinstance(stop, Mapping):
                errors.append(f"{path} 必须是对象（得到 {stop!r}）")
                continue
            _check_required(errors, stop, ("offset", "color"), path)
            _finite(errors, stop.get("offset"), f"{path}.offset", ge=0, le=1)
            _color(errors, stop.get("color"), f"{path}.color")
    ticks = relief.get("ticks")
    if not isinstance(ticks, list):
        errors.append(f"geo.relief.ticks 必须是数组（得到 {ticks!r}）")
    else:
        for index, tick in enumerate(ticks):
            _finite(errors, tick, f"geo.relief.ticks[{index}]")


def _validate_legend_entry(errors: list[str], entry: Any, path: str) -> None:
    """geo 图例条目: 与 scene 的 legend entry 同形, point 必须有 marker."""
    if not isinstance(entry, Mapping):
        errors.append(f"{path} 必须是对象（得到 {entry!r}）")
        return
    _check_required(errors, entry, ("label", "shape"), path)
    _string(errors, entry.get("label"), f"{path}.label")
    shape = _enum(errors, entry.get("shape"), LEGEND_SHAPES, f"{path}.shape")
    if "stroke" in entry:
        _optional_string(errors, entry.get("stroke"), f"{path}.stroke")
        if entry.get("stroke") is not None:
            _color(errors, entry.get("stroke"), f"{path}.stroke")
    if "width_pt" in entry:
        _finite(errors, entry.get("width_pt"), f"{path}.width_pt", ge=0)
    if "dash" in entry:
        _dash(errors, entry.get("dash"), f"{path}.dash")
    if "fill" in entry and entry.get("fill") is not None:
        _color(errors, entry.get("fill"), f"{path}.fill")
    if "opacity" in entry:
        _finite(errors, entry.get("opacity"), f"{path}.opacity", ge=0, le=1)
    if "marker" in entry:
        marker = entry.get("marker")
        if shape == "point":
            _enum(errors, marker, LEGEND_MARKERS, f"{path}.marker")
        elif marker is not None:
            errors.append(f"{path}.marker 只有 point 形状才允许非 null（得到 {marker!r}）")


def _validate_legend(errors: list[str], legend: Any) -> None:
    """geo 图例: 标题 + 条目."""
    if not isinstance(legend, Mapping):
        errors.append(f"geo.legend 必须是对象（得到 {legend!r}）")
        return
    _check_required(errors, legend, ("title", "entries"), "geo.legend")
    _string(errors, legend.get("title"), "geo.legend.title")
    entries = legend.get("entries")
    if not isinstance(entries, list):
        errors.append(f"geo.legend.entries 必须是数组（得到 {entries!r}）")
        return
    for index, entry in enumerate(entries):
        _validate_legend_entry(errors, entry, f"geo.legend.entries[{index}]")


def _validate_suggestions(errors: list[str], suggestions: Any) -> None:
    """默认文案候选: 所有字段都可缺省, 出现时按类型校验."""
    if not isinstance(suggestions, Mapping):
        errors.append(f"geo.suggestions 必须是对象（得到 {suggestions!r}）")
        return
    for key in (
        "title",
        "subtitle",
        "source",
        "legend_title",
        "colorbar_title",
    ):
        if key in suggestions:
            _string(errors, suggestions.get(key), f"geo.suggestions.{key}")
    for key in ("notes", "area_annotation"):
        if key in suggestions:
            values = suggestions.get(key)
            if not isinstance(values, list):
                errors.append(f"geo.suggestions.{key} 必须是字符串数组（得到 {values!r}）")
                continue
            for index, value in enumerate(values):
                _string(errors, value, f"geo.suggestions.{key}[{index}]")


def validate_geo(doc: Any) -> list[str]:
    """按契约 §3 校验 geo, 返回中文错误列表（空 = 合法）."""
    errors: list[str] = []
    if not isinstance(doc, Mapping):
        return ["geo 必须是 JSON 对象"]
    if doc.get("format") != FORMAT:
        errors.append(f"geo.format 必须是 {FORMAT!r}（得到 {doc.get('format')!r}）")
    if doc.get("version") != VERSION or isinstance(doc.get("version"), bool):
        errors.append(f"geo.version 必须是 {VERSION}（得到 {doc.get('version')!r}）")
    _validate_base(errors, doc.get("base"))
    _validate_graticule(errors, doc.get("graticule"))
    if "labels" in doc:
        _validate_labels(errors, doc.get("labels"))
    if "relief" in doc:
        _validate_relief(errors, doc.get("relief"))
    if "legend" in doc:
        _validate_legend(errors, doc.get("legend"))
    if "suggestions" in doc:
        _validate_suggestions(errors, doc.get("suggestions"))
    return errors


# ---------------------------------------------------------------------------
# 解析: raw dict → typed Geo
# ---------------------------------------------------------------------------


def _tick(raw: Mapping[str, Any]) -> GraticuleTick:
    """构造刻度；调用前 validate_geo 已保证字段齐全."""
    return GraticuleTick(
        value=float(raw["value"]),
        label=str(raw["label"]),
        x=float(raw["x"]),
        y=float(raw["y"]),
        side=str(raw["side"]),
    )


def _style(raw: Any) -> GraticuleStyle | None:
    """原图经纬线样式; 缺省或 null 时 None."""
    if not isinstance(raw, Mapping):
        return None
    dash = raw.get("dash")
    return GraticuleStyle(
        stroke=str(raw["stroke"]),
        width_pt=float(raw["width_pt"]),
        dash=None if dash is None else (float(dash[0]), float(dash[1])),
        opacity=float(raw["opacity"]),
    )


def _label(raw: Mapping[str, Any]) -> Label:
    """地名候选; lines/anchor/font_size 等给前端稳定的默认值."""
    text = str(raw["text"])
    lines = raw.get("lines")
    halo = raw.get("halo")
    return Label(
        id=str(raw["id"]),
        kind=str(raw["kind"]),
        text=text,
        lines=tuple(str(line) for line in (lines if lines else [text])),
        x=float(raw["x"]),
        y=float(raw["y"]),
        rotation_deg=float(raw.get("rotation_deg", 0)),
        anchor=str(raw.get("anchor", "middle")),
        font_size_pt=float(raw.get("font_size_pt", 9)),
        color=str(raw.get("color", "#111111")),
        italic=bool(raw.get("italic", False)),
        halo=None
        if halo is None
        else LabelHalo(color=str(halo["color"]), width_pt=float(halo["width_pt"])),
        order=int(raw.get("order", 0)),
    )


def _relief(raw: Mapping[str, Any]) -> Relief:
    """色标; stops/ticks 保持原顺序（渲染按原 offset 写渐变）."""
    return Relief(
        title=str(raw["title"]),
        unit=str(raw["unit"]),
        vmin=float(raw["vmin"]),
        vmax=float(raw["vmax"]),
        stops=tuple(
            ReliefStop(offset=float(stop["offset"]), color=str(stop["color"]))
            for stop in raw["stops"]
        ),
        ticks=tuple(float(value) for value in raw["ticks"]),
    )


def _legend_entry(raw: Mapping[str, Any]) -> LegendEntry:
    """图例条目, 缺省字段补成 null/默认值."""
    dash = raw.get("dash")
    return LegendEntry(
        label=str(raw["label"]),
        shape=str(raw["shape"]),
        stroke=None if raw.get("stroke") is None else str(raw.get("stroke")),
        width_pt=float(raw.get("width_pt", 1)),
        dash=None if dash is None else (float(dash[0]), float(dash[1])),
        fill=None if raw.get("fill") is None else str(raw.get("fill")),
        opacity=float(raw.get("opacity", 1)),
        marker=None if raw.get("marker") is None else str(raw.get("marker")),
    )


def _suggestions(raw: Mapping[str, Any]) -> Suggestions:
    """默认文案; 列表字段缺省为空, 方便前端统一取值."""
    return Suggestions(
        title=str(raw.get("title", "")),
        subtitle=str(raw.get("subtitle", "")),
        notes=tuple(str(value) for value in raw.get("notes", ())),
        source=str(raw.get("source", "")),
        area_annotation=tuple(
            str(value) for value in raw.get("area_annotation", ())
        ),
        legend_title=str(raw.get("legend_title", "")),
        colorbar_title=str(raw.get("colorbar_title", "")),
    )


def parse_geo(doc: Any) -> Geo:
    """校验并转 typed Geo; 不合法抛 GeoError（带全部中文错误）."""
    errors = validate_geo(doc)
    if errors:
        raise GeoError(errors)
    assert isinstance(doc, Mapping)  # validate_geo 已保证
    base_raw = doc["base"]
    view_box_raw = base_raw["view_box"]
    graticule_raw = doc["graticule"]
    labels_raw = doc.get("labels", [])
    return Geo(
        format=FORMAT,
        version=VERSION,
        base=GeoBase(
            sha256=str(base_raw["sha256"]),
            view_box=(
                float(view_box_raw[0]),
                float(view_box_raw[1]),
                float(view_box_raw[2]),
                float(view_box_raw[3]),
            ),
            width_pt=float(base_raw["width_pt"]),
            height_pt=float(base_raw["height_pt"]),
        ),
        graticule=Graticule(
            lon=tuple(_tick(raw) for raw in graticule_raw["lon"]),
            lat=tuple(_tick(raw) for raw in graticule_raw["lat"]),
            style=_style(graticule_raw.get("style")),
        ),
        labels=tuple(_label(raw) for raw in labels_raw),
        relief=None if "relief" not in doc else _relief(doc["relief"]),
        legend=None if "legend" not in doc else GeoLegend(
            title=str(doc["legend"]["title"]),
            entries=tuple(_legend_entry(raw) for raw in doc["legend"]["entries"]),
        ),
        suggestions=None
        if "suggestions" not in doc
        else _suggestions(doc["suggestions"]),
    )


def read_geo(path: str | Path) -> Geo:
    """读取并校验 geo.json; 文件缺失/JSON 坏/不符合 §3 都抛 GeoError.

    为什么把 OSError 也包成 GeoError: compose 只处理三类 ComposeError, geo 的读取失败
    属于「geo 不可用」, 由调用方统一映射成 503 GeoInvalid, 不需要再区分 errno.
    """
    file_path = Path(path)
    try:
        data = file_path.read_bytes()
    except OSError as exc:
        raise GeoError(f"读取 geo 失败: {file_path}: {exc}") from exc
    try:
        doc = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise GeoError(f"geo.json 不是合法 JSON: {file_path}: {exc}") from exc
    try:
        return parse_geo(doc)
    except GeoError as exc:
        raise GeoError(tuple(f"{file_path.name}: {message}" for message in exc.errors)) from exc


# ---------------------------------------------------------------------------
# 规范化与摘要
# ---------------------------------------------------------------------------


def _round(value: float) -> int | float:
    """与渲染/场景共享的 3 位小数收敛."""
    return page_mod.round_number(float(value))


def _tick_dict(tick: GraticuleTick) -> dict[str, Any]:
    """刻度到规范 dict（digest 用）."""
    return {
        "value": _round(tick.value),
        "label": tick.label,
        "x": _round(tick.x),
        "y": _round(tick.y),
        "side": tick.side,
    }


def geo_to_dict(geo: Geo) -> dict[str, Any]:
    """typed Geo → 契约形状 dict（数值 3 位、颜色小写）, 作为 digest 的输入.

    为什么重新构造而不是保存原始 raw: digest 必须只依赖语义字段, 不能被文件里的键顺序、
    多余调试键或 6 位小数（§3 示例本身就有 6 位）影响。
    """
    graticule: dict[str, Any] = {
        "lon": [_tick_dict(tick) for tick in geo.graticule.lon],
        "lat": [_tick_dict(tick) for tick in geo.graticule.lat],
    }
    style = geo.graticule.style
    if style is not None:
        graticule["style"] = {
            "stroke": style.stroke.lower(),
            "width_pt": _round(style.width_pt),
            "dash": None
            if style.dash is None
            else [_round(style.dash[0]), _round(style.dash[1])],
            "opacity": _round(style.opacity),
        }
    doc: dict[str, Any] = {
        "format": geo.format,
        "version": geo.version,
        "base": {
            "sha256": geo.base.sha256,
            "view_box": [_round(value) for value in geo.base.view_box],
            "width_pt": _round(geo.base.width_pt),
            "height_pt": _round(geo.base.height_pt),
        },
        "graticule": graticule,
        "labels": [
            {
                "id": label.id,
                "kind": label.kind,
                "text": label.text,
                "lines": list(label.lines),
                "x": _round(label.x),
                "y": _round(label.y),
                "rotation_deg": _round(label.rotation_deg),
                "anchor": label.anchor,
                "font_size_pt": _round(label.font_size_pt),
                "color": label.color.lower(),
                "italic": label.italic,
                "halo": None
                if label.halo is None
                else {
                    "color": label.halo.color.lower(),
                    "width_pt": _round(label.halo.width_pt),
                },
                "order": label.order,
            }
            for label in geo.labels
        ],
    }
    if geo.relief is not None:
        doc["relief"] = {
            "title": geo.relief.title,
            "unit": geo.relief.unit,
            "vmin": _round(geo.relief.vmin),
            "vmax": _round(geo.relief.vmax),
            "stops": [
                {"offset": _round(stop.offset), "color": stop.color.lower()}
                for stop in geo.relief.stops
            ],
            "ticks": [_round(value) for value in geo.relief.ticks],
        }
    if geo.legend is not None:
        doc["legend"] = {
            "title": geo.legend.title,
            "entries": [
                {
                    "label": entry.label,
                    "shape": entry.shape,
                    "stroke": None if entry.stroke is None else entry.stroke.lower(),
                    "width_pt": _round(entry.width_pt),
                    "dash": None
                    if entry.dash is None
                    else [_round(entry.dash[0]), _round(entry.dash[1])],
                    "fill": None if entry.fill is None else entry.fill.lower(),
                    "opacity": _round(entry.opacity),
                    "marker": entry.marker,
                }
                for entry in geo.legend.entries
            ],
        }
    if geo.suggestions is not None:
        doc["suggestions"] = {
            "title": geo.suggestions.title,
            "subtitle": geo.suggestions.subtitle,
            "notes": list(geo.suggestions.notes),
            "source": geo.suggestions.source,
            "area_annotation": list(geo.suggestions.area_annotation),
            "legend_title": geo.suggestions.legend_title,
            "colorbar_title": geo.suggestions.colorbar_title,
        }
    return doc


def geo_digest(geo: Geo | Mapping[str, Any]) -> str:
    """规范化 geo JSON 的 sha256; 传 raw dict 时先 parse（不合法抛 GeoError）."""
    typed = parse_geo(geo) if isinstance(geo, Mapping) else geo
    return hashlib.sha256(
        page_mod.canonical_json(geo_to_dict(typed)).encode("utf-8")
    ).hexdigest()
