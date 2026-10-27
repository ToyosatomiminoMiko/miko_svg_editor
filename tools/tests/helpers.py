"""测试夹具: 小底图字节、payload 构造器与 Scene 构造辅助.

是什么: 所有单测共用的小尺寸合法底图(200x100 viewBox)、默认 style 字典、
以及把 payload → Scene 的便捷函数, 避免每个测试重复写契约字段.
为什么: 单测不该依赖 demo/ 下 10 MB 的真实底图(它由 prepare_demo.py 生成且被 gitignore);
真实底图的契约检查放在 check_contract.py 与 test_contract.py 的可跳过用例里.
元信息: 2026-10, mapdoc 垂直切片.
"""

from __future__ import annotations

import copy
from pathlib import Path

from mapdoc import contract, scene

# 合法底图: C1(viewBox)/C3(</svg> 唯一且在末尾)/C6(无 marker); 不含 text 所以 C8 不适用.
BASE_SVG = (
    '<?xml version="1.0" encoding="utf-8" standalone="no"?>\n'
    '<svg xmlns="http://www.w3.org/2000/svg" width="200pt" height="100pt" '
    'viewBox="0 0 200 100" version="1.1">\n'
    " <defs>\n"
    '  <style type="text/css"><![CDATA[\n'
    "*{stroke-linejoin: round; stroke-linecap: butt}\n"
    "  ]]></style>\n"
    " </defs>\n"
    ' <rect x="0" y="0" width="200" height="100" fill="#ffffff"/>\n'
    "</svg>\n"
).encode("utf-8")

# 带 text 与内嵌 WOFF 的底图: 用来验证 C8 通过, 以及 compose 不改底图字体块.
TEXT_BASE_SVG = (
    '<?xml version="1.0" encoding="utf-8" standalone="no"?>\n'
    '<svg xmlns="http://www.w3.org/2000/svg" width="200pt" height="100pt" '
    'viewBox="0 0 200 100" version="1.1">\n'
    " <defs>\n"
    '  <style type="text/css"><![CDATA[\n'
    "*{stroke-linejoin: round; stroke-linecap: butt}\n"
    '@font-face { font-family: "Fixture"; src: url("data:font/woff;base64,'
    'QUJD") format("woff") }\n'
    "  ]]></style>\n"
    " </defs>\n"
    ' <text x="10" y="20" font-size="8">Fixture 标签</text>\n'
    "</svg>\n"
).encode("utf-8")

# 无 text 但有 marker 的底图: 用来验证 C6 拒绝已被写过的底图.
MARKED_BASE_SVG = BASE_SVG.replace(
    b"</svg>\n", b"<!-- mapdoc-final:AAAA -->\n</svg>\n"
)

# 兜底字体族/色值等只在需要覆盖时改这里, 保持默认值与 scene.DEFAULT_STYLE 一致.
DEFAULT_STYLE: dict[str, object] = {
    "stroke": "#c62828",
    "stroke_width_pt": 1.0,
    "construction_dash_pt": [4.0, 4.0],
    "point_radius_pt": 1.6,
    "font_family": "Noto Sans Mono CJK SC",
    "font_size_pt": 9.0,
    "text_color": "#111111",
}


def style(**overrides: object) -> dict[str, object]:
    """返回默认 style 的副本(可覆盖字段)."""
    result = copy.deepcopy(DEFAULT_STYLE)
    result.update(overrides)
    return result


def base_info(data: bytes = BASE_SVG, path: Path | None = None) -> scene.BaseInfo:
    """按夹具底图构造服务器侧 BaseInfo(与 studio 的解析口径一致: 3 位小数)."""
    check = contract.read_base_check(data)
    assert not check.errors, check.errors
    return scene.BaseInfo(
        path=path,
        sha256=contract.sha256(data),
        width_pt=scene.round3(check.width_pt),
        height_pt=scene.round3(check.height_pt),
    )


def base_claim(info: scene.BaseInfo | None = None) -> dict[str, object]:
    """构造 PUT 语义体里的 base 声明."""
    source = info or base_info()
    return {
        "sha256": source.sha256,
        "width_pt": source.width_pt,
        "height_pt": source.height_pt,
    }


def point(identifier: int, x: float, y: float, fixed: bool = False) -> dict[str, object]:
    """构造一个 scene 点对象."""
    return {"id": identifier, "x": x, "y": y, "fixed": fixed}


def payload(
    *,
    base: dict[str, object] | None = None,
    ack_base_change: bool = False,
    style_body: dict[str, object] | None = None,
    seq: int = 100,
    points: list[dict[str, object]] | None = None,
    entities: list[dict[str, object]] | None = None,
    constraints: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    """构造 PUT 语义体(顶层字段与契约 §2 一致)."""
    return {
        "base": base if base is not None else base_claim(),
        "ack_base_change": ack_base_change,
        "style": style_body if style_body is not None else style(),
        "seq": seq,
        "points": points if points is not None else [],
        "entities": entities if entities is not None else [],
        "constraints": constraints if constraints is not None else [],
    }


def make_scene(
    body: dict[str, object] | None = None,
    *,
    base: scene.BaseInfo | None = None,
    figure: str = "demo/figures/Volga/map.svg",
) -> scene.Scene:
    """payload → 校验 → build_scene; 单测里最常用的入口."""
    if body is None:
        body = payload()
    parsed = scene.parse_payload(body)
    return scene.build_scene(parsed, base or base_info(), figure)


def canonical_json(scan: scene.Scene) -> dict[str, object]:
    """规范化字节 → dict, 便于断言字段(键序由字节测试单独覆盖)."""
    import json

    return json.loads(scene.canonical_bytes(scan))


def scene_document(scan: scene.Scene) -> dict[str, object]:
    """规范化文档的普通 dict 版本, 用于"写盘后重新读入"的往返测试."""
    return scene.canonical_document(scan)


def full_geometry_entities() -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    """返回 (points, entities): 覆盖 line/circle/arc/point 四种图元与构造标记."""
    points = [
        point(1, 0.0, 0.0),
        point(2, 100.0, 0.0),
        point(3, 100.0, 100.0),
        point(4, 0.0, 100.0),
        point(5, 50.0, 50.0),
    ]
    entities: list[dict[str, object]] = [
        {"id": 6, "type": "line", "a": 1, "b": 2, "construction": False},
        {"id": 7, "type": "line", "a": 3, "b": 4, "construction": True},
        {"id": 8, "type": "circle", "c": 5, "r": 12.5, "construction": False},
        {"id": 9, "type": "arc", "c": 5, "a": 2, "b": 3, "construction": False},
        {"id": 10, "type": "point", "p": 1, "construction": False},
        {"id": 11, "type": "point", "p": 2, "construction": True},
    ]
    return points, entities


def all_constraints() -> list[dict[str, object]]:
    """16 种约束各一条, 覆盖应有数值字段(含 angleSector/offset/leaderAngle)."""
    return [
        {"id": 20, "type": "coincident", "a": 1, "b": 2},
        {"id": 21, "type": "horizontal", "e": 6},
        {"id": 22, "type": "vertical", "e": 7},
        {"id": 23, "type": "parallel", "e1": 6, "e2": 7},
        {"id": 24, "type": "perpendicular", "e1": 6, "e2": 7},
        {"id": 25, "type": "equalLength", "e1": 6, "e2": 7},
        {"id": 26, "type": "collinear", "e1": 6, "e2": 7},
        {"id": 27, "type": "pointOnLine", "e": 6, "p": 5},
        {"id": 28, "type": "pointOnCircle", "e": 8, "p": 5},
        {"id": 29, "type": "tangentLineCircle", "line": 6, "circ": 8},
        {"id": 30, "type": "tangentCircleCircle", "e1": 8, "e2": 9},
        {"id": 31, "type": "concentric", "e1": 8, "e2": 9},
        {"id": 32, "type": "equalRadius", "e1": 8, "e2": 9},
        {
            "id": 33,
            "type": "distancePointPoint",
            "a": 1,
            "b": 2,
            "distance": 40.0,
            "offset": -8.0,
        },
        {"id": 34, "type": "radius", "e": 8, "radius": 12.5, "leaderAngle": 0.7},
        {
            "id": 35,
            "type": "angleLineLine",
            "e1": 6,
            "e2": 7,
            "angle": 30.0,
            "offset": 30.0,
            "angleSector": 1,
        },
    ]


def full_constraint_payload() -> dict[str, object]:
    """16 种约束全字段往返测试用的完整 payload."""
    points, entities = full_geometry_entities()
    return payload(
        seq=200,
        points=points,
        entities=entities,
        constraints=all_constraints(),
    )
