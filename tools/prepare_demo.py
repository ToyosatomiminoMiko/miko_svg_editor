#!/usr/bin/env python3
"""从只读 Cartopy 仓的 Volga 成品 SVG 抽取纯底图与 geo.json, 写进本仓 demo 目录.

是什么: 读 ``SOURCE_SVG``(成品图: 地形/水系/矢量 + 文字/图例/色标/图框), 调
``extract.extract`` 剥出 ``.build/<stem>.base.svg``(纯地图, 无文字, viewBox 裁到地图框)
与 ``<stem>.geo.json``(地图框/经纬刻度/地名/配色图例/默认文案); 不写 final, 不碰 scene.

为什么: 本轮 Cartopy 仓不能改, 前端编辑器需要「纯底图 + 只读地理元数据」作为输入;
final.svg 与 scene.json 归 studio/compose 管, prepare 只负责这层一次性物化.
幂等: 每次都由源字节重新抽取; 目标文件内容没变就不写盘, 因此重复运行是 no-op.
写盘: 先 ``contract.read_base`` 校验底图, 再用 ``fsutil.atomic_write_bytes`` 原子替换.

用法: python3 tools/prepare_demo.py   (不接受命令行参数)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from mapdoc import contract, extract, fsutil

# 本文件所在目录 = tools/; 仓库根 = 上一级(与旧实现一致, 不依赖当前工作目录).
TOOL_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOL_DIR.parent

# 只读源: Cartopy 仓现有交付物. 本轮只接 Volga 一张图.
SOURCE_DIR = Path("/mnt/IVSTINIANVS/__projects_python/Cartopy_file/Volga")
FIGURE_STEM = "volga_basin_topography_etopo2022_lambert_conformal"
SOURCE_SVG = SOURCE_DIR / (FIGURE_STEM + ".svg")

# 产物落点: base 在 .build/, geo 与 final/scene 同目录(见 docs/PAGE-EDITOR.md §2).
DEMO_DIR = REPO_ROOT / "demo" / "figures" / "Volga"
BASE_DIR = DEMO_DIR / ".build"
BASE_SVG = BASE_DIR / (FIGURE_STEM + ".base.svg")
GEO_JSON = DEMO_DIR / (FIGURE_STEM + ".geo.json")


def _write_if_changed(path: Path, data: bytes) -> bool:
    """内容相同则跳过, 不同才原子写; 返回是否真的写了盘(用于打印幂等状态)."""
    try:
        if path.read_bytes() == data:
            return False
    except OSError:
        pass
    fsutil.atomic_write_bytes(path, data)
    return True


def _check_geo_base(info: contract.BaseInfo, geo: dict) -> list[str]:
    """校验底图与 geo.base 声明互相自洽; 返回错误列表(空 = 通过)."""
    errors: list[str] = []
    base = geo.get("base") if isinstance(geo, dict) else None
    if not isinstance(base, dict):
        return ["geo.base 缺失或不是对象"]
    view_box = base.get("view_box")
    if not (
        isinstance(view_box, list)
        and len(view_box) == 4
        and info.view_box is not None
        and all(abs(float(a) - float(b)) <= 1e-9 for a, b in zip(view_box, info.view_box))
    ):
        errors.append(f"geo.base.view_box 与底图 viewBox 不一致: {view_box!r} vs {info.view_box!r}")
    for key in ("width_pt", "height_pt"):
        expected = info.width_pt if key == "width_pt" else info.height_pt
        value = base.get(key)
        if not isinstance(value, (int, float)) or abs(float(value) - expected) > 1e-9:
            errors.append(f"geo.base.{key} 与底图尺寸不一致: {value!r} vs {expected}")
    return errors


def main() -> int:
    if len(sys.argv) > 1:
        print("错误: 这个脚本不接受命令行参数(源与落点写在脚本里)", file=sys.stderr)
        return 2

    try:
        source_bytes = SOURCE_SVG.read_bytes()
    except OSError as exc:
        print(f"错误: 读不到源 SVG: {SOURCE_SVG}: {exc}", file=sys.stderr)
        return 1

    try:
        base_bytes, geo = extract.extract(source_bytes)
    except extract.ExtractError as exc:
        print(f"错误: 无法从成品抽取底图/geo: {exc}", file=sys.stderr)
        return 1

    # 底图必须先过 C1..C4 契约, 否则后面的 compose 都会建立在坏字节上.
    info = contract.read_base(base_bytes)
    if info.errors:
        print("错误: 抽取出的底图不满足契约(C1..C4):", file=sys.stderr)
        for message in info.errors:
            print(f"  - {message}", file=sys.stderr)
        return 1
    if info.warnings:
        for message in info.warnings:
            print(f"警告: {message}", file=sys.stderr)

    # studio 会用 geo.base.sha256 与底图复核, 两者必须逐字节一致.
    base_sha = contract.sha256(base_bytes)
    if geo.get("base", {}).get("sha256") != base_sha:
        print("错误: geo.base.sha256 与底图实际 sha256 不一致", file=sys.stderr)
        return 1
    consistency_errors = _check_geo_base(info, geo)
    if consistency_errors:
        print("错误: geo 与底图不自洽:", file=sys.stderr)
        for message in consistency_errors:
            print(f"  - {message}", file=sys.stderr)
        return 1

    geo_bytes = json.dumps(geo, ensure_ascii=False, indent=2).encode("utf-8") + b"\n"
    DEMO_DIR.mkdir(parents=True, exist_ok=True)
    BASE_DIR.mkdir(parents=True, exist_ok=True)
    wrote_base = _write_if_changed(BASE_SVG, base_bytes)
    wrote_geo = _write_if_changed(GEO_JSON, geo_bytes)

    lon = len(geo["graticule"]["lon"])
    lat = len(geo["graticule"]["lat"])
    labels = len(geo["labels"])
    entries = len(geo["legend"]["entries"])
    stops = len(geo["relief"]["stops"])
    ticks = len(geo["relief"]["ticks"])
    notes = len(geo["suggestions"]["notes"])
    x0, y0, width, height = geo["base"]["view_box"]

    print(f"源 SVG:  {SOURCE_SVG}")
    print(f"         {len(source_bytes)} 字节, sha256={contract.sha256(source_bytes)}")
    print(f"底图:    {BASE_SVG} ({'已更新' if wrote_base else '未变'})")
    print(f"         {len(base_bytes)} 字节, sha256={base_sha}")
    print(f"         无 <text>, 字体已剥离, viewBox=[{x0}, {y0}, {width}, {height}]")
    print(f"geo:     {GEO_JSON} ({'已更新' if wrote_geo else '未变'}), {len(geo_bytes)} 字节")
    print(
        "         刻度 lon={} lat={}, 地名={}, 图例={}, 色标 stops={} ticks={}, 注记={}".format(
            lon, lat, labels, entries, stops, ticks, notes
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
