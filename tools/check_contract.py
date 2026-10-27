#!/usr/bin/env python3
"""契约自检 CLI: 对 studio.toml 里配置的每张图检查「纯底图 + geo + scene → final」全链路.

是什么: 读底图做 C1-C4 检查(纯地图、无文字、无 marker); 读 geo 检查其 base 声明;
若 scene.json 存在, 用真实 compose 合成到 .build 下的临时文件, 验证:
  - final 是纸张尺寸的合法 SVG, 底图内容原样内联(矢量, 不是 <image>);
  - final marker 的 base/geo/scene 摘要与当前输入一致;
  - 同一输入连续合成两次字节完全相同.
为什么: 契约是前后端共同遵守的唯一真值, 这里必须走真实 compose(锁/原子写/渲染),
否则测不到实际保存路径. 没有 scene 时只在 [warn] 级别提示, 其余检查照跑.
用法: python3 tools/check_contract.py   (不接受命令行参数; 退出码 0=全绿, 1=有失败)
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from mapdoc import compose as compose_mod
from mapdoc import contract, geo as geo_mod, page as page_mod
from studio import StudioConfigError, load_config

TOOL_DIR = Path(__file__).resolve().parent


def _line(ok: bool | None, message: str) -> None:
    marker = "[ok]" if ok is True else "[fail]" if ok is False else "[warn]"
    print(f"{marker} {message}")


def _load_scene(figure) -> tuple[dict | None, str | None]:
    """读 scene.json; 不存在返回 (None, None); 不合法返回 (None, 错误)."""
    try:
        raw = figure.scene_path.read_bytes()
    except FileNotFoundError:
        return None, None
    except OSError as exc:
        return None, f"读取 scene 失败: {exc}"
    try:
        document = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        return None, f"scene.json 不是合法 JSON: {exc}"
    if not isinstance(document, dict):
        return None, "scene.json 顶层必须是对象"
    errors = page_mod.validate_scene(document)
    if errors:
        return None, "; ".join(errors)
    return document, None


def _check_final_bytes(
    base_bytes: bytes, final_bytes: bytes, scene: dict, geo_digest: str
) -> int:
    """检查 final 的结构; 返回失败数."""
    failures = 0
    if not final_bytes.startswith(b"<?xml"):
        failures += 1
        _line(False, "final 缺少 XML 声明")
    if not final_bytes.rstrip().endswith(b"</svg>"):
        failures += 1
        _line(False, "final 没有以 </svg> 结尾")

    # 底图内容必须原样内联(矢量); 出现指向底图的 <image> 引用即不合格.
    info = contract.read_base(base_bytes)
    inner = base_bytes[info.inner_start : info.inner_end]
    if inner and inner not in final_bytes:
        failures += 1
        _line(False, "final 里找不到原样内联的底图内容")
    else:
        _line(True, "final 内联的是底图原始字节(矢量)")

    marker = contract.read_marker(final_bytes)
    if marker is None:
        failures += 1
        _line(False, "final 缺少 mapdoc-final marker")
    else:
        if marker.get("scene") != page_mod.scene_digest(scene):
            failures += 1
            _line(False, "final marker 的 scene 摘要与当前 scene 不一致")
        else:
            _line(True, "final marker 的 scene 摘要一致")
        if marker.get("geo") != geo_digest:
            failures += 1
            _line(False, "final marker 的 geo 摘要与当前 geo.json 不一致")
        else:
            _line(True, "final marker 的 geo 摘要一致")

    # 纸张尺寸: 根 width/height 应等于 scene.paper.
    size = _root_size(final_bytes)
    paper = scene.get("paper", {})
    width = float(paper.get("width_pt", 0.0))
    height = float(paper.get("height_pt", 0.0))
    if size is None:
        failures += 1
        _line(False, "final 根 <svg> 缺少可解析的 width/height")
    elif abs(size[0] - width) > 0.01 or abs(size[1] - height) > 0.01:
        failures += 1
        _line(
            False,
            f"final 根尺寸 {size[0]:g}×{size[1]:g} 与纸张 {width:g}×{height:g} 不一致",
        )
    else:
        _line(True, f"final 是纸张尺寸 {width:g}×{height:g} pt")
    return failures


def _root_size(data: bytes) -> tuple[float, float] | None:
    """从根 <svg> 起始标签解析 width/height(pt); 解析不到返回 None.

    为什么不用 contract.read_base: final 里本来就有排版文字, 用底图契约去读会带一堆 C2
    错误; 这里只关心根尺寸.
    """
    start = data.find(b"<svg")
    if start < 0:
        return None
    end = data.find(b">", start)
    if end < 0:
        return None
    tag = data[start : end + 1].decode("utf-8", "replace")
    width = re.search(r'width\s*=\s*"([0-9.]+)pt"', tag)
    height = re.search(r'height\s*=\s*"([0-9.]+)pt"', tag)
    if width is None or height is None:
        return None
    try:
        return float(width.group(1)), float(height.group(1))
    except ValueError:
        return None


def _check_figure(key: str, figure) -> bool:
    """检查一张图; 打印逐项结果并返回是否全部通过."""
    print(f"\n== {key} ==")
    print(f"   final: {figure.final_path}")
    print(f"   base : {figure.base_path}")

    failures = 0
    try:
        base_bytes = figure.base_path.read_bytes()
    except OSError as exc:
        _line(False, f"底图不可读: {exc}")
        print("   提示: 先运行 python3 tools/prepare_demo.py")
        return False

    info = contract.read_base(base_bytes)
    if info.errors:
        for message in info.errors:
            _line(False, message)
        return False
    base_sha = contract.sha256(base_bytes)
    _line(
        True,
        f"C1-C4 通过 (纯地图, viewBox {info.view_box[2]:g}×{info.view_box[3]:g} pt, "
        f"{len(base_bytes)} 字节)",
    )
    print(f"   base sha256: {base_sha}")

    try:
        geo = geo_mod.read_geo(figure.geo_path)
    except FileNotFoundError:
        _line(False, "geo.json 缺失, 请先运行 python3 tools/prepare_demo.py")
        return False
    except geo_mod.GeoError as exc:
        _line(False, f"geo.json 不合法: {exc}")
        return False
    if geo.base.sha256 != base_sha:
        failures += 1
        _line(False, "geo.base.sha256 与当前底图不一致(需要重跑 prepare)")
    elif (
        abs(geo.base.width_pt - info.width_pt) > 0.01
        or abs(geo.base.height_pt - info.height_pt) > 0.01
    ):
        failures += 1
        _line(False, "geo.base 尺寸与当前底图不一致(需要重跑 prepare)")
    else:
        _line(
            True,
            f"geo.json 通过 (labels={len(geo.labels)}, "
            f"lon={len(geo.graticule.lon)}, lat={len(geo.graticule.lat)}, "
            f"legend={len(geo.legend.entries)})",
        )

    scene, scene_error = _load_scene(figure)
    if scene_error:
        _line(False, f"scene.json 不合法: {scene_error}")
        return False
    if scene is None:
        _line(None, "还没有 scene.json(在 map.html 里保存一次后可做完整合成自检)")
        return failures == 0

    temporary = figure.base_path.with_name(figure.base_path.name + ".check-final.svg")
    try:
        first = compose_mod.compose(
            scene, figure.base_path, figure.geo_path, temporary
        )
        first_bytes = temporary.read_bytes()
        second = compose_mod.compose(
            scene, figure.base_path, figure.geo_path, temporary
        )
        second_bytes = temporary.read_bytes()
    except compose_mod.ComposeError as exc:
        _line(False, f"compose 失败: {exc}")
        return False
    finally:
        temporary.unlink(missing_ok=True)

    _line(True, f"compose 成功 (items={first['counts']['total']})")
    if first_bytes != second_bytes:
        failures += 1
        _line(False, "同一输入连续两次 compose 的字节不一致")
    else:
        _line(True, "同一 (base, geo, scene) 合成字节稳定")
    failures += _check_final_bytes(
        base_bytes, first_bytes, scene, geo_mod.geo_digest(geo)
    )

    if not figure.final_path.is_file():
        _line(None, "final 尚未生成(在 map.html 保存或 POST /api/compose)")
        return failures == 0
    final_bytes = figure.final_path.read_bytes()
    marker = contract.read_marker(final_bytes)
    if marker is None:
        _line(None, "已存在的 final 里没有 marker(需要重新合成)")
    elif marker.get("scene") != page_mod.scene_digest(scene):
        _line(None, "已存在的 final 与当前 scene 不同步(重新保存一次即可)")
    else:
        _line(True, "已存在的 final 与当前 scene 同步")
    return failures == 0


def main() -> int:
    if len(sys.argv) > 1:
        print("错误: 这个脚本不接受命令行参数(图列表读 tools/studio.toml)", file=sys.stderr)
        return 2
    try:
        config = load_config()
    except StudioConfigError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 2

    failures = 0
    for key, figure in sorted(config.figures.items()):
        if not _check_figure(key, figure):
            failures += 1

    print()
    if failures:
        print(f"契约检查失败: {failures} 张图有问题", file=sys.stderr)
        return 1
    print("契约检查全绿")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
