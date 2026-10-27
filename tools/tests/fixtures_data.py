"""studio 端到端测试用的最小纯底图 / geo / scene 样板（不是产品代码）.

是什么: 一份 200×100pt 的无文字底图 SVG、一份符合 docs/PAGE-EDITOR.md §3 的 geo、以及
make_scene() 生成的合法 scene 语义体.
为什么独立成模块: HTTP 集成测试、compose 测试都要用同一套样板; 放在工具模块里避免每个测试
重复拼大段字符串. 底图必须满足 §7 C1-C4(无 <text>/单 </svg>/合法 viewBox).
"""

from __future__ import annotations

from typing import Any

BASE_SVG = b"""<?xml version="1.0" encoding="utf-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="200pt" height="100pt" viewBox="0 0 200 100" version="1.1">
 <defs>
  <clipPath id="test-clip"><rect x="0" y="0" width="200" height="100"/></clipPath>
  <style type="text/css"><![CDATA[*{stroke-linejoin:round;stroke-linecap:butt}]]></style>
 </defs>
 <g id="figure_1">
  <g id="axes_1">
   <g id="patch_2">
    <path d="M 200 0 L 200 100 L 0 100 L 0 0 z" style="fill: #a2d0ee"/>
   </g>
   <g clip-path="url(#test-clip)">
    <path d="M0 80 C40 60 80 90 120 70 S180 50 200 60 L200 100 L0 100 Z"
          fill="#c8d8e8" stroke="#7a9ab8" stroke-width="0.5"/>
   </g>
  </g>
 </g>
</svg>
"""

# geo 里 __BASE_SHA__ 由测试在运行期替换成真实底图摘要.
GEO_TEMPLATE: dict[str, Any] = {
    "format": "mapdoc-geo",
    "version": 1,
    "base": {
        "sha256": "__BASE_SHA__",
        "view_box": [0, 0, 200, 100],
        "width_pt": 200,
        "height_pt": 100,
    },
    "graticule": {
        "lon": [
            {"value": 0, "label": "0°", "x": 50, "y": 50, "side": "bottom"},
            {"value": 10, "label": "10°E", "x": 150, "y": 50, "side": "bottom"},
        ],
        "lat": [
            {"value": 0, "label": "0°", "x": 50, "y": 70, "side": "left"},
            {"value": 10, "label": "10°N", "x": 50, "y": 30, "side": "left"},
        ],
        "style": {
            "stroke": "#808080",
            "width_pt": 0.5,
            "dash": [0.5, 0.825],
            "opacity": 0.4,
        },
    },
    "labels": [
        {
            "id": "label-city-甲城",
            "kind": "city",
            "text": "甲城",
            "lines": ["甲城"],
            "x": 80,
            "y": 60,
            "rotation_deg": 0,
            "anchor": "start",
            "font_size_pt": 8,
            "color": "#111111",
            "italic": False,
            "halo": {"color": "#ffffff", "width_pt": 2},
            "order": 0,
        }
    ],
    "relief": {
        "title": "高程",
        "unit": "m",
        "vmin": -100,
        "vmax": 100,
        "stops": [
            {"offset": 0, "color": "#08306b"},
            {"offset": 1, "color": "#ffffff"},
        ],
        "ticks": [-100, 0, 100],
    },
    "legend": {
        "title": "图例",
        "entries": [
            {
                "label": "国界",
                "shape": "line",
                "stroke": "#333333",
                "width_pt": 1,
                "dash": None,
                "fill": None,
                "opacity": 1,
                "marker": None,
            }
        ],
    },
    "suggestions": {
        "title": "测试图",
        "subtitle": "副标题",
        "notes": ["注 1：测试。"],
        "source": "测试来源",
        "area_annotation": [],
        "legend_title": "图例",
        "colorbar_title": "高程",
    },
}


def make_scene(base_sha: str) -> dict[str, Any]:
    """返回一份覆盖 text/legend/colorbar 的合法 scene（不含 figure）."""
    return {
        "format": "mapdoc-page",
        "version": 1,
        "base": {"sha256": base_sha, "width_pt": 200, "height_pt": 100},
        "paper": {
            "preset": "A5",
            "orientation": "landscape",
            "width_pt": 300,
            "height_pt": 200,
        },
        "map": {"x": 10, "y": 20, "width_pt": 180},
        "frame": {
            "show": True,
            "stroke": "#000000",
            "width_pt": 0.8,
            "ticks": True,
            "tick_length_pt": 4,
            "tick_font_size_pt": 6,
            "tick_color": "#444444",
            "tick_gap_pt": 1,
        },
        "style": {
            "paper_color": "#ffffff",
            "font_family": "Noto Sans Mono CJK SC, sans-serif",
            "color": "#111111",
        },
        "items": [
            {
                "id": 1,
                "kind": "text",
                "space": "page",
                "role": "title",
                "x": 150,
                "y": 14,
                "lines": ["测试标题"],
                "font_size_pt": 12,
                "font_family": None,
                "color": "#111111",
                "anchor": "middle",
                "rotation_deg": 0,
                "line_height": 1.3,
                "italic": False,
                "bold": False,
                "halo": None,
            },
            {
                "id": 2,
                "kind": "legend",
                "space": "page",
                "x": 200,
                "y": 30,
                "width_pt": 80,
                "title": "图例",
                "entries": [
                    {
                        "label": "国界",
                        "shape": "line",
                        "stroke": "#333333",
                        "width_pt": 1,
                        "dash": None,
                        "fill": None,
                        "opacity": 1,
                        "marker": None,
                    }
                ],
                "font_size_pt": 8,
                "title_size_pt": 10,
                "row_height_pt": 12,
                "padding_pt": 5,
                "swatch_width_pt": 18,
                "swatch_gap_pt": 4,
                "frame": {
                    "show": True,
                    "stroke": "#bbbbbb",
                    "width_pt": 0.8,
                    "fill": "#ffffff",
                    "opacity": 0.9,
                },
            },
            {
                "id": 3,
                "kind": "colorbar",
                "space": "page",
                "x": 210,
                "y": 120,
                "width_pt": 10,
                "height_pt": 50,
                "title": "高程",
                "unit": "m",
                "show_title": True,
                "show_ticks": True,
                "title_size_pt": 7,
                "label_size_pt": 6,
            },
        ],
        "seq": 4,
    }
