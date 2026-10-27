"""scene v1 的解析、校验、规范化与摘要.

是什么: 把浏览器 PUT 的语义体或已落盘的 scene.json 变成不可变的 Scene 对象, 并提供
规范化字节(canonical_bytes)与 sha256(digest). 规范化是写盘、marker 比较与前端
"需要合成"判断的唯一口径.
为什么: 键排序 + 数值 3 位小数 + 紧凑分隔符 + 无尾换行必须只有一份实现, 否则同一份
语义内容会因序列化细节产生不同 digest; 校验坚持"拒绝而不是修复", 避免静默丢字段(I4).
依赖: 只用标准库 json/math/pathlib; 不读 SVG(底图声明由 contract 解析后经 BaseInfo 传入).
元信息: 2026-10, mapdoc 垂直切片; 契约见 docs/merge/DESIGN.md 3.3.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

FORMAT = "mapdoc-scene"
VERSION = 1

# 数量上限与文本上限: 与 DESIGN §3.3 一致; 文本本轮不实现但校验口径先留着.
MAX_COUNT = 2000
MAX_TEXT_COUNT = 500
MAX_TEXT_CHARS = 200

# 画布尺寸容差: 客户端声明的 width/height 与真实底图差超过该值即 canvas_changed.
CANVAS_TOLERANCE_PT = 0.01

# 单个字符串字段的长度上限: 任何超长输入都按非法场景拒绝, 不做静默截断.
MAX_STRING_CHARS = 1000

_SHA256_RE = re.compile(r"[0-9a-f]{64}")
_HEX_COLOR_RE = re.compile(r"#[0-9a-fA-F]{6}")

# 约束元数据镜像: key = 约束种类, 值 = ((引用字段, 引用种类, 可接受的图元种类), ...).
# 与 src/config/constraints-meta.ts 的 CONSTRAINT_META.refs 一一对应; 未知种类直接拒绝.
_LINE = ("line",)
_CURVE = ("circle", "arc")
CONSTRAINT_META: dict[str, tuple[tuple[str, str, tuple[str, ...]], ...]] = {
    "coincident": (("a", "point", ()), ("b", "point", ())),
    "horizontal": (("e", "entity", _LINE),),
    "vertical": (("e", "entity", _LINE),),
    "parallel": (("e1", "entity", _LINE), ("e2", "entity", _LINE)),
    "perpendicular": (("e1", "entity", _LINE), ("e2", "entity", _LINE)),
    "equalLength": (("e1", "entity", _LINE), ("e2", "entity", _LINE)),
    "collinear": (("e1", "entity", _LINE), ("e2", "entity", _LINE)),
    "pointOnLine": (("e", "entity", _LINE), ("p", "point", ())),
    "pointOnCircle": (("e", "entity", _CURVE), ("p", "point", ())),
    "tangentLineCircle": (("line", "entity", _LINE), ("circ", "entity", _CURVE)),
    "tangentCircleCircle": (("e1", "entity", _CURVE), ("e2", "entity", _CURVE)),
    "concentric": (("e1", "entity", _CURVE), ("e2", "entity", _CURVE)),
    "equalRadius": (("e1", "entity", _CURVE), ("e2", "entity", _CURVE)),
    "distancePointPoint": (("a", "point", ()), ("b", "point", ())),
    "radius": (("e", "entity", _CURVE),),
    "angleLineLine": (("e1", "entity", _LINE), ("e2", "entity", _LINE)),
}

# 约束的数值字段: 每种约束只允许这些键; 三处尺寸的目标值是必需的, 作者态摆放字段可选.
_REQUIRED_NUMBERS: dict[str, tuple[str, ...]] = {
    "distancePointPoint": ("distance",),
    "radius": ("radius",),
    "angleLineLine": ("angle",),
}
_OPTIONAL_NUMBERS: dict[str, tuple[str, ...]] = {
    "distancePointPoint": ("offset",),
    "radius": ("leaderAngle",),
    "angleLineLine": ("offset", "angleSector"),
}
# 公开别名: 测试与未来工具按种类查询数值字段集合时不必依赖私有名.
CONSTRAINT_REQUIRED_NUMBERS = _REQUIRED_NUMBERS
CONSTRAINT_OPTIONAL_NUMBERS = _OPTIONAL_NUMBERS

# 约束对象上所有可能出现的数值属性: 重放校验时要能发现"这种约束不该有该字段".
_ALL_NUMBER_FIELDS = (
    "distance",
    "radius",
    "angle",
    "offset",
    "leaderAngle",
    "angleSector",
)


class SceneError(ValueError):
    """scene 不合法; code 固定是 invalid_scene, 供 studio 直接映射 400."""

    code = "invalid_scene"


def _bad(message: str) -> None:
    raise SceneError(message)


# ---------------------------------------------------------------- 数值与字段


def round3(value: float) -> float:
    """把数值舍到 3 位小数并把 -0 归一成 0; 规范化与画布比较共用同一口径."""
    rounded = round(float(value) + 0.0, 3)
    return 0.0 if rounded == 0 else rounded


def _is_number(value: object) -> bool:
    # bool 是 int 的子类: JSON 里的 true 不能被当成 1.
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _number(value: object, where: str) -> float:
    if not _is_number(value):
        _bad(f"{where} 必须是数字")
    number = float(value)  # type: ignore[arg-type]
    if not math.isfinite(number):
        _bad(f"{where} 必须是有限数字")
    return number


def _integer(value: object, where: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        _bad(f"{where} 必须是整数")
    return int(value)  # type: ignore[arg-type]


def _boolean(value: object, where: str) -> bool:
    if not isinstance(value, bool):
        _bad(f"{where} 必须是布尔值")
    return value


def _string(value: object, where: str) -> str:
    if not isinstance(value, str):
        _bad(f"{where} 必须是字符串")
    if len(value) > MAX_STRING_CHARS:
        _bad(f"{where} 超过 {MAX_STRING_CHARS} 字符")
    return value


def _mapping(value: object, where: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        _bad(f"{where} 必须是 JSON 对象")
    return value  # type: ignore[return-value]


def _sequence(value: object, where: str) -> list[Any]:
    if not isinstance(value, list):
        _bad(f"{where} 必须是 JSON 数组")
    return value  # type: ignore[return-value]


def _reject_unknown(
    obj: dict[str, Any], allowed: set[str], where: str
) -> None:
    """未知字段一律拒绝: 静默丢弃会让"保存"看起来成功但数据已丢(I4)."""
    unknown = sorted(set(obj) - allowed)
    if unknown:
        _bad(f"{where} 有未知字段: {', '.join(unknown)}")


def _figure_path(value: object) -> str:
    """校验 scene.figure: 用 / 分隔的路径(仓库内相对路径优先), 不允许 .. 与反斜杠.

    绝对路径只在图位于仓库之外时出现(配置允许绝对路径), 它是元信息;
    服务器永远用 studio.toml 派生的路径做 IO, 不会按 scene.figure 访问文件.
    """
    figure = _string(value, "figure")
    if not figure:
        _bad("figure 不能为空")
    if "\x00" in figure or "\\" in figure:
        _bad("figure 不能包含 NUL 或反斜杠")
    parts = figure.split("/")
    if any(part == ".." for part in parts):
        _bad("figure 不能包含 ..")
    if not figure.startswith("/") and any(part in ("", ".") for part in parts):
        _bad("figure 不能包含空段或 .")
    return figure


def _sha256(value: object, where: str) -> str:
    if not isinstance(value, str) or _SHA256_RE.fullmatch(value) is None:
        _bad(f"{where} 必须是 64 位小写十六进制 sha256")
    return value


def _color(value: object, where: str) -> str:
    if not isinstance(value, str) or _HEX_COLOR_RE.fullmatch(value) is None:
        _bad(f"{where} 必须是 #rrggbb 颜色")
    # 规范化统一小写, 保证同色不同大小写不会产生不同 digest.
    return value.lower()


# ---------------------------------------------------------------- 数据类


@dataclass(frozen=True)
class BaseInfo:
    """服务器从真实底图解析得到的声明; path 只在本进程用, 不进规范化字节."""

    path: Path | None
    sha256: str
    width_pt: float
    height_pt: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "sha256": self.sha256,
            "width_pt": round3(self.width_pt),
            "height_pt": round3(self.height_pt),
        }


@dataclass(frozen=True)
class BaseClaim:
    """浏览器回传的底图声明; 只参与变更检测, 不落盘."""

    sha256: str
    width_pt: float
    height_pt: float


@dataclass(frozen=True)
class Style:
    """场景级默认样式: 几何线色/线宽/虚线 + 点半径 + 文字默认字号/字色/源字族."""

    stroke: str
    stroke_width_pt: float
    construction_dash_pt: tuple[float, float]
    point_radius_pt: float
    font_family: str
    font_size_pt: float
    text_color: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "stroke": self.stroke,
            "stroke_width_pt": round3(self.stroke_width_pt),
            "construction_dash_pt": [
                round3(self.construction_dash_pt[0]),
                round3(self.construction_dash_pt[1]),
            ],
            "point_radius_pt": round3(self.point_radius_pt),
            "font_family": self.font_family,
            "font_size_pt": round3(self.font_size_pt),
            "text_color": self.text_color,
        }


DEFAULT_STYLE = Style(
    stroke="#c62828",
    stroke_width_pt=1.0,
    construction_dash_pt=(4.0, 4.0),
    point_radius_pt=1.6,
    font_family="Noto Sans Mono CJK SC",
    font_size_pt=9.0,
    text_color="#111111",
)


@dataclass(frozen=True)
class Point:
    id: int
    x: float
    y: float
    fixed: bool

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "x": round3(self.x), "y": round3(self.y), "fixed": self.fixed}


@dataclass(frozen=True)
class LineEntity:
    id: int
    a: int
    b: int
    construction: bool


@dataclass(frozen=True)
class CircleEntity:
    id: int
    c: int
    r: float
    construction: bool


@dataclass(frozen=True)
class ArcEntity:
    id: int
    c: int
    a: int
    b: int
    construction: bool


@dataclass(frozen=True)
class PointEntity:
    id: int
    p: int
    construction: bool


Entity = LineEntity | CircleEntity | ArcEntity | PointEntity


@dataclass(frozen=True)
class Constraint:
    """约束的字段与前端 Constraint 一一对应; None 表示该字段没有出现."""

    id: int
    type: str
    e: int | None = None
    e1: int | None = None
    e2: int | None = None
    line: int | None = None
    circ: int | None = None
    a: int | None = None
    b: int | None = None
    p: int | None = None
    distance: float | None = None
    radius: float | None = None
    angle: float | None = None
    offset: float | None = None
    leaderAngle: float | None = None
    angleSector: int | None = None


@dataclass(frozen=True)
class ScenePayload:
    """浏览器 PUT 的语义体: 含底图声明与 ack, 二者都不进规范化字节."""

    base: BaseClaim
    ack_base_change: bool
    style: Style
    seq: int
    points: tuple[Point, ...]
    entities: tuple[Entity, ...]
    constraints: tuple[Constraint, ...]


@dataclass(frozen=True)
class Scene:
    """完整场景 = 落盘内容: figure + 底图声明 + style + seq + 三个有序数组."""

    figure: str
    base: BaseInfo
    style: Style
    seq: int
    points: tuple[Point, ...]
    entities: tuple[Entity, ...]
    constraints: tuple[Constraint, ...]


# ---------------------------------------------------------------- 解析


def _parse_style(value: object) -> Style:
    obj = _mapping(value, "style")
    allowed = {
        "stroke",
        "stroke_width_pt",
        "construction_dash_pt",
        "point_radius_pt",
        "font_family",
        "font_size_pt",
        "text_color",
    }
    _reject_unknown(obj, allowed, "style")
    missing = sorted(allowed - set(obj))
    if missing:
        _bad(f"style 缺少字段: {', '.join(missing)}")

    dash = _sequence(obj["construction_dash_pt"], "style.construction_dash_pt")
    if len(dash) != 2:
        _bad("style.construction_dash_pt 必须是两个数字")
    dash_pair = (
        _number(dash[0], "style.construction_dash_pt[0]"),
        _number(dash[1], "style.construction_dash_pt[1]"),
    )
    if dash_pair[0] < 0 or dash_pair[1] < 0 or dash_pair == (0.0, 0.0):
        _bad("style.construction_dash_pt 必须非负且不能全为 0")

    family = _string(obj["font_family"], "style.font_family")
    if not family.strip():
        _bad("style.font_family 不能为空")

    stroke_width = _number(obj["stroke_width_pt"], "style.stroke_width_pt")
    if stroke_width <= 0:
        _bad("style.stroke_width_pt 必须 > 0")
    point_radius = _number(obj["point_radius_pt"], "style.point_radius_pt")
    if point_radius <= 0:
        _bad("style.point_radius_pt 必须 > 0")
    font_size = _number(obj["font_size_pt"], "style.font_size_pt")
    if font_size <= 0:
        _bad("style.font_size_pt 必须 > 0")

    return Style(
        stroke=_color(obj["stroke"], "style.stroke"),
        stroke_width_pt=round3(stroke_width),
        construction_dash_pt=(round3(dash_pair[0]), round3(dash_pair[1])),
        point_radius_pt=round3(point_radius),
        font_family=family,
        font_size_pt=round3(font_size),
        text_color=_color(obj["text_color"], "style.text_color"),
    )


def _parse_points(value: object) -> tuple[Point, ...]:
    items = _sequence(value, "points")
    points: list[Point] = []
    for index, item in enumerate(items):
        where = f"points[{index}]"
        obj = _mapping(item, where)
        _reject_unknown(obj, {"id", "x", "y", "fixed"}, where)
        missing = sorted({"id", "x", "y", "fixed"} - set(obj))
        if missing:
            _bad(f"{where} 缺少字段: {', '.join(missing)}")
        points.append(
            Point(
                id=_integer(obj["id"], f"{where}.id"),
                x=round3(_number(obj["x"], f"{where}.x")),
                y=round3(_number(obj["y"], f"{where}.y")),
                fixed=_boolean(obj["fixed"], f"{where}.fixed"),
            )
        )
    return tuple(points)


def _parse_entities(value: object) -> tuple[Entity, ...]:
    items = _sequence(value, "entities")
    entities: list[Entity] = []
    for index, item in enumerate(items):
        where = f"entities[{index}]"
        obj = _mapping(item, where)
        if "type" not in obj:
            _bad(f"{where} 缺少字段: type")
        kind = _string(obj["type"], f"{where}.type")
        if kind == "text":
            # 本轮 P3 缺席: 两侧一致地拒绝, 而不是静默丢弃注记.
            _bad("text 注记未实现（P3）")
        if kind not in ("line", "circle", "arc", "point"):
            _bad(f"{where}.type 未知: {kind}")

        allowed = {"id", "type", "construction"}
        if kind == "line":
            allowed |= {"a", "b"}
        elif kind == "circle":
            allowed |= {"c", "r"}
        elif kind == "arc":
            allowed |= {"c", "a", "b"}
        elif kind == "point":
            allowed |= {"p"}
        _reject_unknown(obj, allowed, where)
        missing = sorted(allowed - set(obj))
        if missing:
            _bad(f"{where} 缺少字段: {', '.join(missing)}")

        construction = _boolean(obj["construction"], f"{where}.construction")
        identifier = _integer(obj["id"], f"{where}.id")
        if kind == "line":
            entities.append(
                LineEntity(
                    id=identifier,
                    a=_integer(obj["a"], f"{where}.a"),
                    b=_integer(obj["b"], f"{where}.b"),
                    construction=construction,
                )
            )
        elif kind == "circle":
            entities.append(
                CircleEntity(
                    id=identifier,
                    c=_integer(obj["c"], f"{where}.c"),
                    r=round3(_number(obj["r"], f"{where}.r")),
                    construction=construction,
                )
            )
        elif kind == "arc":
            entities.append(
                ArcEntity(
                    id=identifier,
                    c=_integer(obj["c"], f"{where}.c"),
                    a=_integer(obj["a"], f"{where}.a"),
                    b=_integer(obj["b"], f"{where}.b"),
                    construction=construction,
                )
            )
        else:
            entities.append(
                PointEntity(
                    id=identifier,
                    p=_integer(obj["p"], f"{where}.p"),
                    construction=construction,
                )
            )
    return tuple(entities)


def _parse_constraints(value: object) -> tuple[Constraint, ...]:
    items = _sequence(value, "constraints")
    constraints: list[Constraint] = []
    for index, item in enumerate(items):
        where = f"constraints[{index}]"
        obj = _mapping(item, where)
        if "type" not in obj:
            _bad(f"{where} 缺少字段: type")
        kind = _string(obj["type"], f"{where}.type")
        meta = CONSTRAINT_META.get(kind)
        if meta is None:
            _bad(f"{where}.type 未知: {kind}")
        ref_keys = {ref[0] for ref in meta}
        required_numbers = _REQUIRED_NUMBERS.get(kind, ())
        optional_numbers = _OPTIONAL_NUMBERS.get(kind, ())
        allowed = {"id", "type"} | ref_keys | set(required_numbers) | set(optional_numbers)
        _reject_unknown(obj, allowed, where)
        missing = sorted(({"id"} | ref_keys | set(required_numbers)) - set(obj))
        if missing:
            _bad(f"{where} 缺少字段: {', '.join(missing)}")

        values: dict[str, Any] = {"id": _integer(obj["id"], f"{where}.id"), "type": kind}
        for key, _, _ in meta:
            values[key] = _integer(obj[key], f"{where}.{key}")
        for key in required_numbers:
            values[key] = round3(_number(obj[key], f"{where}.{key}"))
        for key in optional_numbers:
            if key not in obj:
                continue
            if key == "angleSector":
                sector = _integer(obj[key], f"{where}.angleSector")
                if not 0 <= sector <= 3:
                    _bad(f"{where}.angleSector 必须是 0..3 的象限位")
                values[key] = sector
            else:
                values[key] = round3(_number(obj[key], f"{where}.{key}"))
        constraints.append(Constraint(**values))
    return tuple(constraints)


def _parse_claim(value: object) -> BaseClaim:
    obj = _mapping(value, "base")
    _reject_unknown(obj, {"sha256", "width_pt", "height_pt"}, "base")
    missing = sorted({"sha256", "width_pt", "height_pt"} - set(obj))
    if missing:
        _bad(f"base 缺少字段: {', '.join(missing)}")
    width = _number(obj["width_pt"], "base.width_pt")
    height = _number(obj["height_pt"], "base.height_pt")
    if width <= 0 or height <= 0:
        _bad("base 宽高必须 > 0")
    return BaseClaim(
        sha256=_sha256(obj["sha256"], "base.sha256"),
        width_pt=width,
        height_pt=height,
    )


def parse_payload(document: object) -> ScenePayload:
    """解析并校验 PUT 语义体; 任何不符合契约的内容抛 SceneError(拒绝而非修复)."""
    obj = _mapping(document, "payload")
    allowed = {"base", "ack_base_change", "style", "seq", "points", "entities", "constraints"}
    _reject_unknown(obj, allowed, "payload")
    missing = sorted({"base", "style", "seq", "points", "entities", "constraints"} - set(obj))
    if missing:
        _bad(f"payload 缺少字段: {', '.join(missing)}")

    payload = ScenePayload(
        base=_parse_claim(obj["base"]),
        ack_base_change=_boolean(obj.get("ack_base_change", False), "ack_base_change"),
        style=_parse_style(obj["style"]),
        seq=_integer(obj["seq"], "seq"),
        points=_parse_points(obj["points"]),
        entities=_parse_entities(obj["entities"]),
        constraints=_parse_constraints(obj["constraints"]),
    )
    errors = _content_errors(payload.points, payload.entities, payload.constraints, payload.seq)
    if errors:
        _bad(errors[0])
    return payload


def scene_from_document(document: object) -> Scene:
    """解析已落盘的 scene.json(带 format/version/figure/base)并做完整校验."""
    obj = _mapping(document, "scene")
    allowed = {
        "format",
        "version",
        "figure",
        "base",
        "style",
        "seq",
        "points",
        "entities",
        "constraints",
    }
    _reject_unknown(obj, allowed, "scene")
    missing = sorted(allowed - set(obj))
    if missing:
        _bad(f"scene 缺少字段: {', '.join(missing)}")

    if obj["format"] != FORMAT:
        _bad(f"scene.format 必须是 {FORMAT}")
    version = _integer(obj["version"], "scene.version")
    if version != VERSION:
        _bad(f"scene.version 必须是 {VERSION}, 得到 {version}")

    base_obj = _mapping(obj["base"], "scene.base")
    _reject_unknown(base_obj, {"sha256", "width_pt", "height_pt"}, "scene.base")
    base_missing = sorted({"sha256", "width_pt", "height_pt"} - set(base_obj))
    if base_missing:
        _bad(f"scene.base 缺少字段: {', '.join(base_missing)}")
    base = BaseInfo(
        path=None,
        sha256=_sha256(base_obj["sha256"], "scene.base.sha256"),
        width_pt=round3(_number(base_obj["width_pt"], "scene.base.width_pt")),
        height_pt=round3(_number(base_obj["height_pt"], "scene.base.height_pt")),
    )
    if base.width_pt <= 0 or base.height_pt <= 0:
        _bad("scene.base 宽高必须 > 0")

    style = _parse_style(obj["style"])
    seq = _integer(obj["seq"], "scene.seq")
    points = _parse_points(obj["points"])
    entities = _parse_entities(obj["entities"])
    constraints = _parse_constraints(obj["constraints"])

    errors = _content_errors(points, entities, constraints, seq)
    if errors:
        _bad(errors[0])

    return Scene(
        figure=_figure_path(obj["figure"]),
        base=base,
        style=style,
        seq=seq,
        points=points,
        entities=entities,
        constraints=constraints,
    )


# ---------------------------------------------------------------- 内容校验


def _content_errors(
    points: tuple[Point, ...],
    entities: tuple[Entity, ...],
    constraints: tuple[Constraint, ...],
    seq: int,
) -> list[str]:
    """检查 id 空间/引用/seq/数量上限; 返回全部问题(调用方决定抛第一个还是全列)."""
    errors: list[str] = []
    if len(points) > MAX_COUNT:
        errors.append(f"points 数量 {len(points)} 超过上限 {MAX_COUNT}")
    if len(entities) > MAX_COUNT:
        errors.append(f"entities 数量 {len(entities)} 超过上限 {MAX_COUNT}")
    if len(constraints) > MAX_COUNT:
        errors.append(f"constraints 数量 {len(constraints)} 超过上限 {MAX_COUNT}")
    # 本轮拒绝 text 实体, 所以 texts 恒为 0; 上限判断保留给 P3 打开 text 时复用.

    # id 全局唯一: 点/图元/约束共用同一个 seq 空间, 冲突会让"下一个可用 id"失效.
    owners: dict[int, str] = {}
    for point in points:
        if point.id <= 0:
            errors.append(f"点 id 必须 > 0, 得到 {point.id}")
        if point.id in owners:
            errors.append(f"id {point.id} 同时被{owners[point.id]}与点占用")
        else:
            owners[point.id] = "点"
    for entity in entities:
        if entity.id <= 0:
            errors.append(f"图元 id 必须 > 0, 得到 {entity.id}")
        if entity.id in owners:
            errors.append(f"id {entity.id} 同时被{owners[entity.id]}与图元占用")
        else:
            owners[entity.id] = "图元"
    for constraint in constraints:
        if constraint.id <= 0:
            errors.append(f"约束 id 必须 > 0, 得到 {constraint.id}")
        if constraint.id in owners:
            errors.append(f"id {constraint.id} 同时被{owners[constraint.id]}与约束占用")
        else:
            owners[constraint.id] = "约束"

    # seq 必须严格大于所有已用 id, 且至少为 1.
    max_id = max(owners) if owners else 0
    if not isinstance(seq, int) or isinstance(seq, bool):
        errors.append("seq 必须是整数")
    else:
        if seq < 1:
            errors.append(f"seq 必须 >= 1, 得到 {seq}")
        elif seq <= max_id:
            errors.append(f"seq {seq} 必须大于最大 id {max_id}")

    point_by_id = {point.id: point for point in points}
    entity_by_id = {entity.id: entity for entity in entities}

    def entity_kind(entity: Entity) -> str:
        if isinstance(entity, LineEntity):
            return "line"
        if isinstance(entity, CircleEntity):
            return "circle"
        if isinstance(entity, ArcEntity):
            return "arc"
        return "point"

    # 图元引用: 端点必须是已存在的点; 圆/圆弧半径必须 > 0; 圆弧圆心不得与端点重合.
    for entity in entities:
        kind = entity_kind(entity)
        ids = []
        if isinstance(entity, LineEntity):
            ids = [entity.a, entity.b]
        elif isinstance(entity, CircleEntity):
            ids = [entity.c]
        elif isinstance(entity, ArcEntity):
            ids = [entity.c, entity.a, entity.b]
        elif isinstance(entity, PointEntity):
            ids = [entity.p]
        for reference in ids:
            if reference not in point_by_id:
                errors.append(f"{kind} {entity.id} 引用了不存在的点 {reference}")
        if isinstance(entity, CircleEntity) and entity.r <= 0:
            errors.append(f"圆 {entity.id} 半径必须 > 0, 得到 {entity.r}")
        if isinstance(entity, ArcEntity):
            center = point_by_id.get(entity.c)
            start = point_by_id.get(entity.a)
            end = point_by_id.get(entity.b)
            if center is not None and start is not None:
                if math.hypot(start.x - center.x, start.y - center.y) <= 0:
                    errors.append(f"圆弧 {entity.id} 的起点与圆心重合, 半径必须 > 0")
            if center is not None and end is not None:
                if math.hypot(end.x - center.x, end.y - center.y) <= 0:
                    errors.append(f"圆弧 {entity.id} 的终点与圆心重合, 半径必须 > 0")

    # 约束引用: 字段集合由元数据决定; point 引用点、entity 引用图元并核对可接受种类.
    for constraint in constraints:
        meta = CONSTRAINT_META.get(constraint.type)
        if meta is None:
            errors.append(f"约束 {constraint.id} 类型未知: {constraint.type}")
            continue
        for key, ref_kind, accepts in meta:
            reference = getattr(constraint, key)
            if reference is None:
                errors.append(f"约束 {constraint.id}({constraint.type}) 缺少引用 {key}")
                continue
            if ref_kind == "point":
                if reference not in point_by_id:
                    errors.append(
                        f"约束 {constraint.id}({constraint.type}) 引用了不存在的点 {key}={reference}"
                    )
            else:
                target = entity_by_id.get(reference)
                if target is None:
                    errors.append(
                        f"约束 {constraint.id}({constraint.type}) 引用了不存在的图元 {key}={reference}"
                    )
                elif accepts and entity_kind(target) not in accepts:
                    errors.append(
                        f"约束 {constraint.id}({constraint.type}) 的 {key} 需要 "
                        f"{'/'.join(accepts)}, 实际 {entity_kind(target)}"
                    )
        # 数值字段: 该种类没有声明的字段必须为空(否则保存了无效作者态).
        allowed_numbers = set(_REQUIRED_NUMBERS.get(constraint.type, ())) | set(
            _OPTIONAL_NUMBERS.get(constraint.type, ())
        )
        for field in _ALL_NUMBER_FIELDS:
            if field not in allowed_numbers and getattr(constraint, field) is not None:
                errors.append(f"约束 {constraint.id}({constraint.type}) 不允许字段 {field}")
    return errors


def check_refs(scan: Scene) -> list[str]:
    """返回 scene 内部引用/seq/数量问题; 空列表表示引用层面合法."""
    return _content_errors(scan.points, scan.entities, scan.constraints, scan.seq)


# ---------------------------------------------------------------- 构建与规范化


def build_scene(payload: ScenePayload, base: BaseInfo, figure: str) -> Scene:
    """把语义体与服务器侧底图信息合并成可落盘的 Scene; 底图以服务器为准."""
    if base.sha256 and not _SHA256_RE.fullmatch(base.sha256):
        _bad("服务器底图 sha256 不合法")
    if not base.width_pt > 0 or not base.height_pt > 0:
        _bad("服务器底图宽高必须 > 0")
    return Scene(
        figure=_figure_path(figure),
        base=BaseInfo(
            path=base.path,
            sha256=base.sha256,
            width_pt=round3(base.width_pt),
            height_pt=round3(base.height_pt),
        ),
        style=payload.style,
        seq=payload.seq,
        points=payload.points,
        entities=payload.entities,
        constraints=payload.constraints,
    )


def empty_scene(
    figure: str,
    base: BaseInfo | None,
    style: Style = DEFAULT_STYLE,
    seq: int = 1,
) -> Scene:
    """构造空场景: 没有点/图元/约束, seq=1; 底图缺失时用占位声明(sha 为空)."""
    fallback = base or BaseInfo(path=None, sha256="", width_pt=0.0, height_pt=0.0)
    return Scene(
        figure=figure,
        base=fallback,
        style=style,
        seq=seq,
        points=(),
        entities=(),
        constraints=(),
    )


def counts(scan: Scene) -> dict[str, int]:
    """marker 与 report 用的计数(本轮 texts 恒为 0)."""
    return {
        "points": len(scan.points),
        "entities": len(scan.entities),
        "constraints": len(scan.constraints),
        "texts": 0,
    }


def _constraint_to_dict(constraint: Constraint) -> dict[str, Any]:
    result: dict[str, Any] = {"id": constraint.id, "type": constraint.type}
    for field in (
        "e",
        "e1",
        "e2",
        "line",
        "circ",
        "a",
        "b",
        "p",
    ):
        value = getattr(constraint, field)
        if value is not None:
            result[field] = value
    for field in _ALL_NUMBER_FIELDS:
        value = getattr(constraint, field)
        if value is not None:
            result[field] = value if field == "angleSector" else round3(value)
    return result


def _entity_to_dict(entity: Entity) -> dict[str, Any]:
    if isinstance(entity, LineEntity):
        return {
            "id": entity.id,
            "type": "line",
            "a": entity.a,
            "b": entity.b,
            "construction": entity.construction,
        }
    if isinstance(entity, CircleEntity):
        return {
            "id": entity.id,
            "type": "circle",
            "c": entity.c,
            "r": round3(entity.r),
            "construction": entity.construction,
        }
    if isinstance(entity, ArcEntity):
        return {
            "id": entity.id,
            "type": "arc",
            "c": entity.c,
            "a": entity.a,
            "b": entity.b,
            "construction": entity.construction,
        }
    if isinstance(entity, PointEntity):
        return {
            "id": entity.id,
            "type": "point",
            "p": entity.p,
            "construction": entity.construction,
        }
    raise TypeError(f"未知图元类型: {type(entity)!r}")


def canonical_document(scan: Scene) -> dict[str, Any]:
    """把 Scene 变成规范的普通 dict(不含 path/ack), 供 canonical_bytes 序列化."""
    return {
        "format": FORMAT,
        "version": VERSION,
        "figure": scan.figure,
        "base": scan.base.to_dict(),
        "style": scan.style.to_dict(),
        "seq": scan.seq,
        "points": [point.to_dict() for point in scan.points],
        "entities": [_entity_to_dict(entity) for entity in scan.entities],
        "constraints": [_constraint_to_dict(constraint) for constraint in scan.constraints],
    }


def canonical_bytes(scan: Scene) -> bytes:
    """规范化字节: 键排序 + 3 位小数 + 紧凑分隔符 + UTF-8, 无尾换行."""
    text = json.dumps(
        canonical_document(scan),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )
    return text.encode("utf-8")


def digest(scan: Scene) -> str:
    """规范化字节的 sha256; 写盘、marker 与"需要合成"判断共用."""
    from .contract import sha256  # 局部导入: contract 不依赖 scene, 避免循环

    return sha256(canonical_bytes(scan))


def validate_scene(scan: Scene) -> list[str]:
    """重新走一遍"规范化 → 解析"以校验任意构造出来的 Scene; 返回全部/首个问题.

    为什么不在 compose 里信任调用方: I4 要求非法 scene 一定不写文件,
    所以合成前必须再验一次(成本是 O(内容大小) 的纯内存操作).
    """
    try:
        document = canonical_document(scan)
        again = scene_from_document(document)
        if canonical_bytes(again) != canonical_bytes(scan):
            return ["scene 规范化前后不一致"]
    except SceneError as exc:
        return [str(exc)]
    except (KeyError, TypeError, ValueError, AttributeError) as exc:
        return [f"scene 无法规范化: {exc}"]
    return []


def load(path: Path) -> Scene | None:
    """读取已落盘的 scene.json; 不存在返回 None, 内容不合法抛 SceneError."""
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise SceneError(f"读取 scene 文件失败: {path}: {exc}") from exc
    try:
        document = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SceneError(f"scene 文件不是合法 JSON: {exc}") from exc
    return scene_from_document(document)
