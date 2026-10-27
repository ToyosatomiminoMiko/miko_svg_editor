"""scene.json（format ``mapdoc-page`` v1）的常量、校验、规范化与摘要.

是什么: 全部只对 Python dict 操作——``validate_scene`` 按 docs/PAGE-EDITOR.md §4 逐字段
（白名单/类型/范围/item 各 kind/seq/纸张/map 派生/base 声明/颜色）校验, 返回可定位的中文
错误；``normalize_scene`` 把 scene 收敛成契约字段（3 位小数、补 figure、颜色小写）并给出
稳定 JSON；``canonical_bytes``/``scene_digest`` 是写盘与 final marker 的唯一序列化口径；
``map_height`` 按 §4 的纵横比派生地图高度；``item_counts`` 给 report/marker 的计数。

为什么: 浏览器与 Python 只共享这一份真值。规范化后键序与数字写法固定, 同一语义的 scene
得到同一个 sha256（写进 final marker, studio 也用它做 dirty 摘要）; 数值收敛用
「放大 10^3 后 floor(x+0.5)」而不是 Python 内置 round, 因为前者与 JS
``Math.round(v*1000)/1000`` 在 .xxx5 上的取舍一致, 避免前端预览与 Python 成品的最后一位
不同。``round_number`` 同时把整数值落成 JSON int（28.0 → 28）, 与 JS ``JSON.stringify``
对 Number 的输出一致, 否则 Python 会写出 ``28.0`` 造成跨语言 digest 不一致.

元信息: 2026-10, 出版排版编辑器 Python 合成侧; 契约见 docs/PAGE-EDITOR.md §4/§5/§6.1.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Mapping
from typing import Any, Final

# 契约身份: 写盘与校验都要求这两个字段精确等于常量.
FORMAT: Final[str] = "mapdoc-page"
VERSION: Final[int] = 1
PAGE_FORMAT: Final[str] = FORMAT
PAGE_VERSION: Final[int] = VERSION

# §4/§4.1 的枚举; 顺序即前端下拉框顺序, 校验只做成员判断.
PAPER_PRESETS: Final[tuple[str, ...]] = ("A5", "A4", "A3", "Letter", "Custom")
ORIENTATIONS: Final[tuple[str, ...]] = ("portrait", "landscape")
ITEM_KINDS: Final[tuple[str, ...]] = ("text", "legend", "colorbar")
ITEM_SPACES: Final[tuple[str, ...]] = ("page", "map")
TEXT_ROLES: Final[tuple[str, ...]] = (
    "title",
    "subtitle",
    "label",
    "annotation",
    "note",
    "source",
)
TEXT_ANCHORS: Final[tuple[str, ...]] = ("start", "middle", "end")
LEGEND_SHAPES: Final[tuple[str, ...]] = ("line", "rect", "point")
LEGEND_MARKERS: Final[tuple[str, ...]] = ("star", "square", "circle")

# §4 的数量与尺寸上限; 超限是错误而不是截断, 避免静默丢内容.
MAX_ITEMS: Final[int] = 500
MAX_TEXT_LINES: Final[int] = 40
MAX_LINE_CHARS: Final[int] = 200
MAX_LEGEND_ENTRIES: Final[int] = 50
PAPER_MIN_PT: Final[float] = 50.0
PAPER_MAX_PT: Final[float] = 5000.0
MAP_MIN_WIDTH_PT: Final[float] = 1.0
# 数字统一保留 3 位小数(§4/§5): 渲染输出的 format_number 与此同一口径.
DECIMALS: Final[int] = 3

_SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
_COLOR_RE = re.compile(r"#[0-9a-fA-F]{6}\Z")

_SCENE_KEYS: Final[frozenset[str]] = frozenset(
    {"format", "version", "figure", "base", "paper", "map", "frame", "style", "items", "seq"}
)
_BASE_KEYS: Final[frozenset[str]] = frozenset({"sha256", "width_pt", "height_pt"})
_PAPER_KEYS: Final[frozenset[str]] = frozenset(
    {"preset", "orientation", "width_pt", "height_pt"}
)
_MAP_KEYS: Final[frozenset[str]] = frozenset({"x", "y", "width_pt"})
_FRAME_KEYS: Final[frozenset[str]] = frozenset(
    {
        "show",
        "stroke",
        "width_pt",
        "ticks",
        "tick_length_pt",
        "tick_font_size_pt",
        "tick_color",
        "tick_gap_pt",
    }
)
_STYLE_KEYS: Final[frozenset[str]] = frozenset(
    {"paper_color", "font_family", "color"}
)
_HALO_KEYS: Final[frozenset[str]] = frozenset({"color", "width_pt"})

_ITEM_COMMON_KEYS: Final[frozenset[str]] = frozenset({"id", "kind", "space"})
_TEXT_ITEM_KEYS: Final[frozenset[str]] = _ITEM_COMMON_KEYS | frozenset(
    {
        "role",
        "x",
        "y",
        "lines",
        "font_size_pt",
        "font_family",
        "color",
        "anchor",
        "rotation_deg",
        "line_height",
        "italic",
        "bold",
        "halo",
    }
)
_LEGEND_ENTRY_KEYS: Final[frozenset[str]] = frozenset(
    {"label", "shape", "stroke", "width_pt", "dash", "fill", "opacity", "marker"}
)
_LEGEND_FRAME_KEYS: Final[frozenset[str]] = frozenset(
    {"show", "stroke", "width_pt", "fill", "opacity"}
)
_LEGEND_ITEM_KEYS: Final[frozenset[str]] = _ITEM_COMMON_KEYS | frozenset(
    {
        "x",
        "y",
        "width_pt",
        "title",
        "entries",
        "font_size_pt",
        "title_size_pt",
        "row_height_pt",
        "padding_pt",
        "swatch_width_pt",
        "swatch_gap_pt",
        "frame",
    }
)
_COLORBAR_ITEM_KEYS: Final[frozenset[str]] = _ITEM_COMMON_KEYS | frozenset(
    {
        "x",
        "y",
        "width_pt",
        "height_pt",
        "title",
        "unit",
        "show_title",
        "show_ticks",
        "title_size_pt",
        "label_size_pt",
    }
)
_ITEM_KEYS: Final[dict[str, frozenset[str]]] = {
    "text": _TEXT_ITEM_KEYS,
    "legend": _LEGEND_ITEM_KEYS,
    "colorbar": _COLORBAR_ITEM_KEYS,
}


class SceneError(ValueError):
    """scene 结构不合法（normalize 遇到缺失/类型错误时抛）; studio 可映射成 invalid_scene.

    为什么用异常承载 errors: validate_scene 走返回值便于前端一次性展示全部问题, 而
    normalize_scene 属于"合法输入才该被调用"的路径, 一旦失败就是调用方漏了校验, 直接抛。
    """

    def __init__(self, errors: str | tuple[str, ...] | list[str]):
        if isinstance(errors, str):
            self.errors: tuple[str, ...] = (errors,)
        else:
            self.errors = tuple(errors)
        super().__init__("; ".join(self.errors) or "scene 不合法")


# ---------------------------------------------------------------------------
# 数值与序列化: 跨语言一致性的唯一口径
# ---------------------------------------------------------------------------


def round_number(value: float, digits: int = DECIMALS) -> int | float:
    """按 JS ``Math.round(v * 10^d) / 10^d`` 的语义收敛, 整数值返回 int.

    为什么不用内置 round: Python 是银行家舍入（且对 float 的十进制展开做正确舍入），在
    ``0.3125`` 这类恰好落在中点的二进制小数上会给出 0.312, 而 JS 的
    ``Math.round``/``toFixed`` 对正数给 0.313; 前端预览与本文件的成品必须同口径。
    负数的中点按 Math.round 向 +∞ 取（-0.3125 → -0.312）。
    非有限值归 0: 上层校验已经拦掉 NaN/Inf, 这里只是防御, 避免把 NaN 写进 JSON。
    """
    number = float(value)
    if not math.isfinite(number):
        return 0
    factor = 10.0**digits
    scaled = number * factor
    if not math.isfinite(scaled):
        # 极大值乘 10^3 会溢出; 直接退回定点字符串解析, 结果仍是 3 位小数.
        rounded = float(f"{number:.{digits}f}")
    else:
        rounded = math.floor(scaled + 0.5) / factor
    if rounded == 0:
        return 0
    if float(rounded).is_integer():
        return int(rounded)
    return rounded


def canonical_json(doc: Any) -> str:
    """契约指定的规范 JSON: 键排序、无多余空白、保留非 ASCII 原文.

    为什么 ensure_ascii=False: 标签/图例是中文, 保留原文让 scene.json 可读, 同时
    digest 只依赖字符串本身而与语言环境无关; allow_nan=False 保证不会写出非法 JSON。
    """
    return json.dumps(
        doc, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False
    )


def canonical_bytes(scene: dict[str, Any]) -> bytes:
    """scene.json 的落盘字节: 规范 JSON + 恰好一个换行（便于 git diff 与行尾规范）."""
    return (canonical_json(scene) + "\n").encode("utf-8")


def scene_digest(scene: dict[str, Any]) -> str:
    """规范化 scene JSON（不含末尾换行）的 sha256, 写进 final marker 供溯源."""
    return hashlib.sha256(canonical_json(scene).encode("utf-8")).hexdigest()


def _utf16_length(text: str) -> int:
    """按 JS ``String.length`` 计字符数（UTF-16 code unit）, 保证与前端"每行 ≤200"同口径."""
    return len(text.encode("utf-16-le")) // 2


def _display(value: Any) -> str:
    """错误信息里的值展示: 字符串加引号, 避免 "x 必须..." 与真实值混淆."""
    if isinstance(value, str):
        return f"{value!r}"
    return repr(value)


# ---------------------------------------------------------------------------
# 校验基础件
# ---------------------------------------------------------------------------


def _is_number(value: Any) -> bool:
    """数字判定: 排除 bool（Python 里 True 是 int 的子类, 会骗过 isinstance）."""
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _check_exact_keys(
    errors: list[str], obj: Mapping[str, Any], allowed: frozenset[str], path: str
) -> None:
    """字段白名单: 未知字段与缺失字段都报错（§4 是封闭契约, 不做前向兼容）."""
    present = set(obj)
    for key in sorted(present - allowed):
        errors.append(f"{path} 未知字段 {key}")
    for key in sorted(allowed - present):
        errors.append(f"{path} 缺少字段 {key}")


def _finite_number(
    errors: list[str],
    value: Any,
    path: str,
    *,
    gt: float | None = None,
    ge: float | None = None,
    lt: float | None = None,
    le: float | None = None,
) -> float | None:
    """有限数字 + 开/闭区间检查; 失败返回 None, 调用方不再二次报错."""
    if not _is_number(value):
        errors.append(f"{path} 必须是数字（得到 {_display(value)}）")
        return None
    number = float(value)
    if not math.isfinite(number):
        errors.append(f"{path} 必须是有限数字（得到 {_display(value)}）")
        return None
    if gt is not None and not number > gt:
        errors.append(f"{path} 必须 > {_display(gt)}（得到 {_display(value)}）")
    if ge is not None and not number >= ge:
        errors.append(f"{path} 必须 >= {_display(ge)}（得到 {_display(value)}）")
    if lt is not None and not number < lt:
        errors.append(f"{path} 必须 < {_display(lt)}（得到 {_display(value)}）")
    if le is not None and not number <= le:
        errors.append(f"{path} 必须 <= {_display(le)}（得到 {_display(value)}）")
    return number


def _positive_int(errors: list[str], value: Any, path: str) -> int | None:
    """正整数（bool 不算）; 失败返回 None."""
    if not isinstance(value, int) or isinstance(value, bool):
        errors.append(f"{path} 必须是正整数（得到 {_display(value)}）")
        return None
    if value <= 0:
        errors.append(f"{path} 必须是正整数（得到 {_display(value)}）")
        return None
    return value


def _string(
    errors: list[str], value: Any, path: str, *, allow_empty: bool = True
) -> str | None:
    """字符串检查; 非字符串或不允许的空串报错."""
    if not isinstance(value, str):
        errors.append(f"{path} 必须是字符串（得到 {_display(value)}）")
        return None
    if not allow_empty and not value:
        errors.append(f"{path} 不能为空")
        return None
    return value


def _optional_string(errors: list[str], value: Any, path: str) -> str | None:
    """可为 null 的字符串（font_family/dash/fill/marker 之类）."""
    if value is None:
        return None
    return _string(errors, value, path, allow_empty=False)


def _boolean(errors: list[str], value: Any, path: str) -> bool | None:
    """布尔检查; 不接受 0/1."""
    if not isinstance(value, bool):
        errors.append(f"{path} 必须是布尔值（得到 {_display(value)}）")
        return None
    return value


def _enum(
    errors: list[str], value: Any, allowed: tuple[str, ...], path: str
) -> str | None:
    """枚举成员检查; 错误信息列出全部合法值."""
    if not isinstance(value, str) or value not in allowed:
        errors.append(
            f"{path} 必须是 {'|'.join(allowed)} 之一（得到 {_display(value)}）"
        )
        return None
    return value


def _color(errors: list[str], value: Any, path: str) -> str | None:
    """严格 ``#rrggbb``: 三位简写/颜色名/函数都不接受（§4）."""
    if not isinstance(value, str) or _COLOR_RE.fullmatch(value) is None:
        errors.append(f"{path} 必须是 #rrggbb 颜色（得到 {_display(value)}）")
        return None
    return value


def _sha256(errors: list[str], value: Any, path: str) -> str | None:
    """64 位小写十六进制 sha256."""
    if not isinstance(value, str) or _SHA256_RE.fullmatch(value) is None:
        errors.append(f"{path} 必须是 64 位小写十六进制 sha256（得到 {_display(value)}）")
        return None
    return value


def _dash(
    errors: list[str], value: Any, path: str
) -> tuple[float, float] | None:
    """stroke-dasharray: null 或两个非负数字."""
    if value is None:
        return None
    if not isinstance(value, list) or len(value) != 2:
        errors.append(f"{path} 必须是 null 或长度为 2 的数字数组（得到 {_display(value)}）")
        return None
    first = _finite_number(errors, value[0], f"{path}[0]", ge=0)
    second = _finite_number(errors, value[1], f"{path}[1]", ge=0)
    if first is None or second is None:
        return None
    return first, second


def _opacity(errors: list[str], value: Any, path: str) -> float | None:
    """opacity: 0..1 闭区间."""
    return _finite_number(errors, value, path, ge=0, le=1)


# ---------------------------------------------------------------------------
# 校验: §4 全字段
# ---------------------------------------------------------------------------


def validate_scene(doc: Any) -> list[str]:
    """按契约 §4 校验 scene, 返回中文错误列表（空列表 = 合法）.

    为什么返回列表而不是抛异常: PUT 请求要把全部问题一次性回给前端; 单项错误信息
    都带 ``items[i](kind).field`` 这样的路径, 前端可直接高亮对应控件。
    """
    errors: list[str] = []
    if not isinstance(doc, Mapping):
        return ["scene 必须是 JSON 对象"]

    _check_exact_keys(errors, doc, _SCENE_KEYS, "scene")
    if doc.get("format") != FORMAT:
        errors.append(f"scene.format 必须是 {FORMAT!r}（得到 {_display(doc.get('format'))}）")
    if doc.get("version") != VERSION or isinstance(doc.get("version"), bool):
        errors.append(f"scene.version 必须是 {VERSION}（得到 {_display(doc.get('version'))}）")
    _string(errors, doc.get("figure"), "scene.figure", allow_empty=False)

    _validate_base(errors, doc.get("base"))
    _validate_paper(errors, doc.get("paper"))
    _validate_map(errors, doc.get("map"))
    _validate_frame(errors, doc.get("frame"))
    _validate_style(errors, doc.get("style"))

    seq_value = doc.get("seq")
    seq = _positive_int(errors, seq_value, "seq")

    items = doc.get("items")
    item_ids: list[int] = []
    if not isinstance(items, list):
        errors.append(f"items 必须是数组（得到 {_display(type(items).__name__)}）")
    else:
        if len(items) > MAX_ITEMS:
            # 超上限时只继续校验前 MAX_ITEMS 个: 错误列表已经足够定位, 不做无谓的笛卡尔爆炸.
            errors.append(f"items 超过上限 {MAX_ITEMS}（得到 {len(items)}）")
        for index, item in enumerate(items[:MAX_ITEMS]):
            item_id = _validate_item(errors, item, index, set(item_ids))
            if item_id is not None:
                item_ids.append(item_id)

    if seq is not None and item_ids:
        largest = max(item_ids)
        if seq <= largest:
            errors.append(f"seq 必须大于所有 item id（seq={seq}, 最大 id={largest}）")
    return errors


def _validate_base(errors: list[str], base: Any) -> None:
    """base 声明: 前端回传、服务器用真实底图复核（§4/§7）."""
    if not isinstance(base, Mapping):
        errors.append(f"base 必须是对象（得到 {_display(base)}）")
        return
    _check_exact_keys(errors, base, _BASE_KEYS, "base")
    _sha256(errors, base.get("sha256"), "base.sha256")
    _finite_number(errors, base.get("width_pt"), "base.width_pt", gt=0)
    _finite_number(errors, base.get("height_pt"), "base.height_pt", gt=0)


def _validate_paper(errors: list[str], paper: Any) -> None:
    """纸张: 预设/方向仅 UI 记忆, 真正决定画布的是 width_pt/height_pt."""
    if not isinstance(paper, Mapping):
        errors.append(f"paper 必须是对象（得到 {_display(paper)}）")
        return
    _check_exact_keys(errors, paper, _PAPER_KEYS, "paper")
    _enum(errors, paper.get("preset"), PAPER_PRESETS, "paper.preset")
    _enum(errors, paper.get("orientation"), ORIENTATIONS, "paper.orientation")
    _finite_number(
        errors, paper.get("width_pt"), "paper.width_pt", ge=PAPER_MIN_PT, le=PAPER_MAX_PT
    )
    _finite_number(
        errors, paper.get("height_pt"), "paper.height_pt", ge=PAPER_MIN_PT, le=PAPER_MAX_PT
    )


def _validate_map(errors: list[str], mapping: Any) -> None:
    """地图摆放: x/y 有限即可（越界只告警）, 宽度必须 > 1pt 才有意义."""
    if not isinstance(mapping, Mapping):
        errors.append(f"map 必须是对象（得到 {_display(mapping)}）")
        return
    _check_exact_keys(errors, mapping, _MAP_KEYS, "map")
    _finite_number(errors, mapping.get("x"), "map.x")
    _finite_number(errors, mapping.get("y"), "map.y")
    _finite_number(errors, mapping.get("width_pt"), "map.width_pt", gt=MAP_MIN_WIDTH_PT)


def _validate_frame(errors: list[str], frame: Any) -> None:
    """图框与刻度样式; map.height 由 base 纵横比派生, 不在 scene 里."""
    if not isinstance(frame, Mapping):
        errors.append(f"frame 必须是对象（得到 {_display(frame)}）")
        return
    _check_exact_keys(errors, frame, _FRAME_KEYS, "frame")
    _boolean(errors, frame.get("show"), "frame.show")
    _color(errors, frame.get("stroke"), "frame.stroke")
    _finite_number(errors, frame.get("width_pt"), "frame.width_pt", ge=0)
    _boolean(errors, frame.get("ticks"), "frame.ticks")
    _finite_number(errors, frame.get("tick_length_pt"), "frame.tick_length_pt", ge=0)
    _finite_number(errors, frame.get("tick_font_size_pt"), "frame.tick_font_size_pt", gt=0)
    _color(errors, frame.get("tick_color"), "frame.tick_color")
    _finite_number(errors, frame.get("tick_gap_pt"), "frame.tick_gap_pt", ge=0)


def _validate_style(errors: list[str], style: Any) -> None:
    """全局兜底样式: 文字默认字体/颜色与纸张底色."""
    if not isinstance(style, Mapping):
        errors.append(f"style 必须是对象（得到 {_display(style)}）")
        return
    _check_exact_keys(errors, style, _STYLE_KEYS, "style")
    _color(errors, style.get("paper_color"), "style.paper_color")
    _string(errors, style.get("font_family"), "style.font_family", allow_empty=False)
    _color(errors, style.get("color"), "style.color")


def _validate_item(
    errors: list[str], item: Any, index: int, seen_ids: set[int]
) -> int | None:
    """校验一个 item, 返回合法 id（供 seq/唯一性检查）; 失败返回 None."""
    if not isinstance(item, Mapping):
        errors.append(f"items[{index}] 必须是对象（得到 {_display(item)}）")
        return None
    kind = item.get("kind")
    if not isinstance(kind, str) or kind not in ITEM_KINDS:
        errors.append(
            f"items[{index}].kind 必须是 {'|'.join(ITEM_KINDS)} 之一（得到 {_display(kind)}）"
        )
        return None
    path = f"items[{index}]({kind})"
    _check_exact_keys(errors, item, _ITEM_KEYS[kind], path)
    item_id = _positive_int(errors, item.get("id"), f"{path}.id")
    if item_id is not None:
        if item_id in seen_ids:
            errors.append(f"{path}.id 重复（id={item_id} 已被别的 item 使用）")
        seen_ids.add(item_id)
    _enum(errors, item.get("space"), ITEM_SPACES, f"{path}.space")
    if kind == "text":
        _validate_text_item(errors, item, path)
    elif kind == "legend":
        _validate_legend_item(errors, item, path)
    else:
        _validate_colorbar_item(errors, item, path)
    return item_id


def _validate_text_item(errors: list[str], item: Mapping[str, Any], path: str) -> None:
    """text item（§4.1）：1..40 行、每行 ≤200 个 UTF-16 code unit, 无自动换行."""
    _enum(errors, item.get("role"), TEXT_ROLES, f"{path}.role")
    _finite_number(errors, item.get("x"), f"{path}.x")
    _finite_number(errors, item.get("y"), f"{path}.y")
    lines = item.get("lines")
    if not isinstance(lines, list):
        errors.append(f"{path}.lines 必须是字符串数组（得到 {_display(lines)}）")
    else:
        if not 1 <= len(lines) <= MAX_TEXT_LINES:
            errors.append(
                f"{path}.lines 行数必须在 1..{MAX_TEXT_LINES} 之间（得到 {len(lines)}）"
            )
        for line_index, line in enumerate(lines):
            line_path = f"{path}.lines[{line_index}]"
            if not isinstance(line, str):
                errors.append(f"{line_path} 必须是字符串（得到 {_display(line)}）")
            elif _utf16_length(line) > MAX_LINE_CHARS:
                errors.append(
                    f"{line_path} 超过 {MAX_LINE_CHARS} 字符上限"
                    f"（得到 {_utf16_length(line)}）"
                )
    _finite_number(errors, item.get("font_size_pt"), f"{path}.font_size_pt", gt=0)
    _optional_string(errors, item.get("font_family"), f"{path}.font_family")
    _color(errors, item.get("color"), f"{path}.color")
    _enum(errors, item.get("anchor"), TEXT_ANCHORS, f"{path}.anchor")
    _finite_number(errors, item.get("rotation_deg"), f"{path}.rotation_deg")
    _finite_number(errors, item.get("line_height"), f"{path}.line_height", gt=0)
    _boolean(errors, item.get("italic"), f"{path}.italic")
    _boolean(errors, item.get("bold"), f"{path}.bold")
    _validate_halo(errors, item.get("halo"), f"{path}.halo")


def _validate_halo(errors: list[str], halo: Any, path: str) -> None:
    """光晕: null 或 {color, width_pt}; width 必须 > 0 才有描边效果."""
    if halo is None:
        return
    if not isinstance(halo, Mapping):
        errors.append(f"{path} 必须是 null 或对象（得到 {_display(halo)}）")
        return
    _check_exact_keys(errors, halo, _HALO_KEYS, path)
    _color(errors, halo.get("color"), f"{path}.color")
    _finite_number(errors, halo.get("width_pt"), f"{path}.width_pt", gt=0)


def _validate_legend_item(errors: list[str], item: Mapping[str, Any], path: str) -> None:
    """legend item（§4.1/§5.4）：高度不落盘, 由 padding/title/entries 派生."""
    _finite_number(errors, item.get("x"), f"{path}.x")
    _finite_number(errors, item.get("y"), f"{path}.y")
    _finite_number(errors, item.get("width_pt"), f"{path}.width_pt", gt=0)
    _string(errors, item.get("title"), f"{path}.title")
    entries = item.get("entries")
    if not isinstance(entries, list):
        errors.append(f"{path}.entries 必须是数组（得到 {_display(entries)}）")
    else:
        if len(entries) > MAX_LEGEND_ENTRIES:
            errors.append(
                f"{path}.entries 超过上限 {MAX_LEGEND_ENTRIES}"
                f"（得到 {len(entries)}）"
            )
        for entry_index, entry in enumerate(entries[:MAX_LEGEND_ENTRIES]):
            _validate_legend_entry(
                errors, entry, f"{path}.entries[{entry_index}]"
            )
    _finite_number(errors, item.get("font_size_pt"), f"{path}.font_size_pt", gt=0)
    _finite_number(errors, item.get("title_size_pt"), f"{path}.title_size_pt", gt=0)
    _finite_number(errors, item.get("row_height_pt"), f"{path}.row_height_pt", ge=0)
    _finite_number(errors, item.get("padding_pt"), f"{path}.padding_pt", ge=0)
    _finite_number(errors, item.get("swatch_width_pt"), f"{path}.swatch_width_pt", ge=0)
    _finite_number(errors, item.get("swatch_gap_pt"), f"{path}.swatch_gap_pt", ge=0)
    _validate_legend_frame(errors, item.get("frame"), f"{path}.frame")


def _validate_legend_frame(errors: list[str], frame: Any, path: str) -> None:
    """图例底板: 白底半透明矩形 + 描边."""
    if not isinstance(frame, Mapping):
        errors.append(f"{path} 必须是对象（得到 {_display(frame)}）")
        return
    _check_exact_keys(errors, frame, _LEGEND_FRAME_KEYS, path)
    _boolean(errors, frame.get("show"), f"{path}.show")
    _color(errors, frame.get("stroke"), f"{path}.stroke")
    _finite_number(errors, frame.get("width_pt"), f"{path}.width_pt", ge=0)
    _color(errors, frame.get("fill"), f"{path}.fill")
    _opacity(errors, frame.get("opacity"), f"{path}.opacity")


def _validate_legend_entry(errors: list[str], entry: Any, path: str) -> None:
    """图例条目: line/rect/point 三种形状; point 必须给 marker, 其余必须为 null."""
    if not isinstance(entry, Mapping):
        errors.append(f"{path} 必须是对象（得到 {_display(entry)}）")
        return
    _check_exact_keys(errors, entry, _LEGEND_ENTRY_KEYS, path)
    _string(errors, entry.get("label"), f"{path}.label")
    shape = _enum(errors, entry.get("shape"), LEGEND_SHAPES, f"{path}.shape")
    _optional_string(errors, entry.get("stroke"), f"{path}.stroke")
    stroke = entry.get("stroke")
    if stroke is not None:
        _color(errors, stroke, f"{path}.stroke")
    _finite_number(errors, entry.get("width_pt"), f"{path}.width_pt", ge=0)
    _dash(errors, entry.get("dash"), f"{path}.dash")
    fill = entry.get("fill")
    if fill is not None:
        _color(errors, fill, f"{path}.fill")
    _opacity(errors, entry.get("opacity"), f"{path}.opacity")
    marker = entry.get("marker")
    if shape == "point":
        _enum(errors, marker, LEGEND_MARKERS, f"{path}.marker")
    elif marker is not None:
        errors.append(f"{path}.marker 只有 point 形状才允许非 null（得到 {_display(marker)}）")


def _validate_colorbar_item(errors: list[str], item: Mapping[str, Any], path: str) -> None:
    """colorbar item（§4.1/§5.5）：配色与刻度来自 geo.relief, scene 只存摆放/文字."""
    _finite_number(errors, item.get("x"), f"{path}.x")
    _finite_number(errors, item.get("y"), f"{path}.y")
    _finite_number(errors, item.get("width_pt"), f"{path}.width_pt", gt=0)
    _finite_number(errors, item.get("height_pt"), f"{path}.height_pt", gt=0)
    _string(errors, item.get("title"), f"{path}.title")
    _string(errors, item.get("unit"), f"{path}.unit")
    _boolean(errors, item.get("show_title"), f"{path}.show_title")
    _boolean(errors, item.get("show_ticks"), f"{path}.show_ticks")
    _finite_number(errors, item.get("title_size_pt"), f"{path}.title_size_pt", gt=0)
    _finite_number(errors, item.get("label_size_pt"), f"{path}.label_size_pt", gt=0)


# ---------------------------------------------------------------------------
# 规范化: 契约字段 + 3 位小数
# ---------------------------------------------------------------------------


def _base_parts(base: Any) -> dict[str, Any]:
    """接受 dict 或带属性的对象（geo.GeoBase / contract.BaseInfo）, 抽出三字段."""
    if isinstance(base, Mapping):
        return {key: base[key] for key in ("sha256", "width_pt", "height_pt")}
    try:
        return {key: getattr(base, key) for key in ("sha256", "width_pt", "height_pt")}
    except AttributeError as exc:  # pragma: no cover - 属于调用方编程错误
        raise SceneError(f"base 声明缺少字段: {exc}") from exc


def _round(value: Any) -> int | float:
    """规范化时的数值收敛; 统一走 round_number 保证与渲染字符串同口径."""
    return round_number(float(value))


def _normalize_frame(frame: Mapping[str, Any]) -> dict[str, Any]:
    """顶层 frame: 布尔原样, 颜色小写, 数值 3 位."""
    return {
        "show": bool(frame["show"]),
        "stroke": str(frame["stroke"]).lower(),
        "width_pt": _round(frame["width_pt"]),
        "ticks": bool(frame["ticks"]),
        "tick_length_pt": _round(frame["tick_length_pt"]),
        "tick_font_size_pt": _round(frame["tick_font_size_pt"]),
        "tick_color": str(frame["tick_color"]).lower(),
        "tick_gap_pt": _round(frame["tick_gap_pt"]),
    }


def _normalize_halo(halo: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """光晕原样收敛; null 保持 null（不发明默认值）."""
    if halo is None:
        return None
    return {
        "color": str(halo["color"]).lower(),
        "width_pt": _round(halo["width_pt"]),
    }


def _normalize_legend_entry(entry: Mapping[str, Any]) -> dict[str, Any]:
    """图例条目: dash/fill/marker 的 null 语义保留."""
    dash = entry["dash"]
    return {
        "label": str(entry["label"]),
        "shape": str(entry["shape"]),
        "stroke": None if entry["stroke"] is None else str(entry["stroke"]).lower(),
        "width_pt": _round(entry["width_pt"]),
        "dash": None if dash is None else [_round(dash[0]), _round(dash[1])],
        "fill": None if entry["fill"] is None else str(entry["fill"]).lower(),
        "opacity": _round(entry["opacity"]),
        "marker": entry["marker"],
    }


def _normalize_legend_frame(frame: Mapping[str, Any]) -> dict[str, Any]:
    """图例底板."""
    return {
        "show": bool(frame["show"]),
        "stroke": str(frame["stroke"]).lower(),
        "width_pt": _round(frame["width_pt"]),
        "fill": str(frame["fill"]).lower(),
        "opacity": _round(frame["opacity"]),
    }


def _normalize_text_item(item: Mapping[str, Any]) -> dict[str, Any]:
    """text item 的契约字段; lines 原样（不做换行/去空白, 空白是作者意图）."""
    return {
        "id": int(item["id"]),
        "kind": "text",
        "space": item["space"],
        "role": item["role"],
        "x": _round(item["x"]),
        "y": _round(item["y"]),
        "lines": [str(line) for line in item["lines"]],
        "font_size_pt": _round(item["font_size_pt"]),
        "font_family": item["font_family"],
        "color": str(item["color"]).lower(),
        "anchor": item["anchor"],
        "rotation_deg": _round(item["rotation_deg"]),
        "line_height": _round(item["line_height"]),
        "italic": bool(item["italic"]),
        "bold": bool(item["bold"]),
        "halo": _normalize_halo(item["halo"]),
    }


def _normalize_legend_item(item: Mapping[str, Any]) -> dict[str, Any]:
    """legend item; 高度不落盘（渲染时再按 §5.4 派生）."""
    return {
        "id": int(item["id"]),
        "kind": "legend",
        "space": item["space"],
        "x": _round(item["x"]),
        "y": _round(item["y"]),
        "width_pt": _round(item["width_pt"]),
        "title": str(item["title"]),
        "entries": [
            _normalize_legend_entry(entry) for entry in item["entries"]
        ],
        "font_size_pt": _round(item["font_size_pt"]),
        "title_size_pt": _round(item["title_size_pt"]),
        "row_height_pt": _round(item["row_height_pt"]),
        "padding_pt": _round(item["padding_pt"]),
        "swatch_width_pt": _round(item["swatch_width_pt"]),
        "swatch_gap_pt": _round(item["swatch_gap_pt"]),
        "frame": _normalize_legend_frame(item["frame"]),
    }


def _normalize_colorbar_item(item: Mapping[str, Any]) -> dict[str, Any]:
    """colorbar item; 配色/刻度来自 geo.relief, 这里只有摆放与文字."""
    return {
        "id": int(item["id"]),
        "kind": "colorbar",
        "space": item["space"],
        "x": _round(item["x"]),
        "y": _round(item["y"]),
        "width_pt": _round(item["width_pt"]),
        "height_pt": _round(item["height_pt"]),
        "title": str(item["title"]),
        "unit": str(item["unit"]),
        "show_title": bool(item["show_title"]),
        "show_ticks": bool(item["show_ticks"]),
        "title_size_pt": _round(item["title_size_pt"]),
        "label_size_pt": _round(item["label_size_pt"]),
    }


def _normalize_item(item: Mapping[str, Any]) -> dict[str, Any]:
    """按 kind 分派; 未知 kind 属于调用方漏校验, 直接抛 SceneError."""
    kind = item.get("kind")
    if kind == "text":
        return _normalize_text_item(item)
    if kind == "legend":
        return _normalize_legend_item(item)
    if kind == "colorbar":
        return _normalize_colorbar_item(item)
    raise SceneError(f"未知 item kind: {_display(kind)}")


def normalize_scene(
    doc: Mapping[str, Any], *, figure: str, base: Any = None
) -> dict[str, Any]:
    """把 scene 收敛成契约字段并补 figure, 返回可直接 canonical_bytes 的 dict.

    参数:
      figure: 服务端注入的成品 SVG 路径（PUT 体不含 figure, §8）;
      base:   可选覆盖 base 声明（新建默认排版时用服务器实测的底图信息）;
              为 None 时保留 doc 里的声明（服务器据此报告 base_changed）。
    """
    if not isinstance(doc, Mapping):
        raise SceneError("scene 必须是 JSON 对象")
    try:
        claim = _base_parts(base) if base is not None else _base_parts(doc["base"])
        paper = doc["paper"]
        mapping = doc["map"]
        frame = doc["frame"]
        style = doc["style"]
        items = doc["items"]
    except KeyError as exc:
        raise SceneError(f"scene 缺少字段 {exc}") from exc

    scene: dict[str, Any] = {
        "format": FORMAT,
        "version": VERSION,
        "figure": str(figure),
        "base": {
            "sha256": str(claim["sha256"]),
            "width_pt": _round(claim["width_pt"]),
            "height_pt": _round(claim["height_pt"]),
        },
        "paper": {
            "preset": paper["preset"],
            "orientation": paper["orientation"],
            "width_pt": _round(paper["width_pt"]),
            "height_pt": _round(paper["height_pt"]),
        },
        "map": {
            "x": _round(mapping["x"]),
            "y": _round(mapping["y"]),
            "width_pt": _round(mapping["width_pt"]),
        },
        "frame": _normalize_frame(frame),
        "style": {
            "paper_color": str(style["paper_color"]).lower(),
            "font_family": str(style["font_family"]),
            "color": str(style["color"]).lower(),
        },
        "items": [_normalize_item(item) for item in items],
        "seq": int(doc["seq"]),
    }
    return scene


# ---------------------------------------------------------------------------
# 派生与统计
# ---------------------------------------------------------------------------


def map_height(scene: Mapping[str, Any], base: Any) -> float:
    """地图高度 = map.width_pt × base.height_pt / base.width_pt（§4/§5.1 纵横比）.

    base 用底图的真实尺寸（compose 传 geo.base, 前端传 /api/doc 的 base 实测值）;
    结果不在这里取整, 由输出层 format_number 统一收敛, 避免二次舍入误差累积。
    这里只要求 width_pt/height_pt（不要求 sha256）, 方便调用方只带尺寸。
    """
    if isinstance(base, Mapping):
        base_width = float(base["width_pt"])
        base_height = float(base["height_pt"])
    else:
        base_width = float(getattr(base, "width_pt"))
        base_height = float(getattr(base, "height_pt"))
    if not base_width > 0 or not math.isfinite(base_width):
        raise SceneError(f"base.width_pt 必须 > 0（得到 {base_width!r}）")
    width = float(scene["map"]["width_pt"])
    return width * base_height / base_width


def item_counts(scene: Mapping[str, Any]) -> dict[str, int]:
    """§6.1 marker/report 的计数: 四种键固定出现（0 也要写）."""
    counts = {"text": 0, "legend": 0, "colorbar": 0, "total": 0}
    for item in scene.get("items", ()):  # type: ignore[attr-defined]
        kind = item.get("kind")
        if kind in counts:
            counts[kind] += 1
        counts["total"] += 1
    return counts
