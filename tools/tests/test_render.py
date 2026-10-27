"""render.py 单测: §5 公式字符串与 format_number.

覆盖: format_number 的 3 位小数/去尾零/-0/非有限值; §5.1 变换; 图框矩形与四侧刻度
（含 mirror 基线与越界过滤）的逐字 golden 字符串; text 多行/旋转/halo/转义/map 空间;
legend 高度派生与三类 swatch、行位与标签基线; colorbar 渐变 defs/tick 坐标映射/标题单位;
render_overlay 的顺序与确定性; analyze 越界 item.
"""

from __future__ import annotations

import unittest

from mapdoc import geo, page, render

BASE_SHA = "a" * 64


def make_scene_doc(items: list[dict] | None = None) -> dict:
    """200x100 纸张、地图 100x50（scale=0.5）的最小 scene."""
    return {
        "format": page.FORMAT,
        "version": page.VERSION,
        "figure": "fixture.svg",
        "base": {"sha256": BASE_SHA, "width_pt": 200.0, "height_pt": 100.0},
        "paper": {
            "preset": "Custom",
            "orientation": "landscape",
            "width_pt": 200.0,
            "height_pt": 100.0,
        },
        "map": {"x": 20.0, "y": 10.0, "width_pt": 100.0},
        "frame": {
            "show": True,
            "stroke": "#000000",
            "width_pt": 0.8,
            "ticks": True,
            "tick_length_pt": 5.0,
            "tick_font_size_pt": 7.0,
            "tick_color": "#444444",
            "tick_gap_pt": 2.0,
        },
        "style": {
            "paper_color": "#ffffff",
            "font_family": "Test Sans",
            "color": "#111111",
        },
        "items": items or [],
        "seq": 100,
    }


def make_text_item(
    identifier: int = 1,
    *,
    x: float = 100.0,
    y: float = 20.0,
    lines: list[str] | None = None,
    font_size: float = 10.0,
    anchor: str = "middle",
    rotation: float = 0.0,
    space: str = "page",
    halo: dict | None = None,
    color: str = "#111111",
) -> dict:
    """text item 构造器（默认旋转 0、无 halo）."""
    return {
        "id": identifier,
        "kind": "text",
        "space": space,
        "role": "label",
        "x": x,
        "y": y,
        "lines": lines if lines is not None else ["甲"],
        "font_size_pt": font_size,
        "font_family": None,
        "color": color,
        "anchor": anchor,
        "rotation_deg": rotation,
        "line_height": 1.2,
        "italic": False,
        "bold": False,
        "halo": halo,
    }


def make_legend_entry(label: str, shape: str, **overrides: object) -> dict:
    """图例条目构造器（覆盖行为只为测试几何）."""
    entry = {
        "label": label,
        "shape": shape,
        "stroke": "#4a4a4a",
        "width_pt": 1.4,
        "dash": None,
        "fill": None,
        "opacity": 1.0,
        "marker": None,
    }
    entry.update(overrides)
    return entry


def make_legend_item(identifier: int = 2) -> dict:
    """legend item: 3 行（line/rect/star）, 高度派生 72.8."""
    return {
        "id": identifier,
        "kind": "legend",
        "space": "page",
        "x": 10.0,
        "y": 10.0,
        "width_pt": 180.0,
        "title": "图例",
        "entries": [
            make_legend_entry("国界", "line", dash=[2, 2], opacity=0.5),
            make_legend_entry(
                "湖泊", "rect", stroke="#000000", width_pt=0.5, fill="#ff0000"
            ),
            make_legend_entry(
                "城市",
                "point",
                stroke="#000000",
                width_pt=0.5,
                fill="#00ff00",
                marker="star",
            ),
        ],
        "font_size_pt": 9.0,
        "title_size_pt": 12.0,
        "row_height_pt": 14.0,
        "padding_pt": 7.0,
        "swatch_width_pt": 24.0,
        "swatch_gap_pt": 6.0,
        "frame": {
            "show": True,
            "stroke": "#bbbbbb",
            "width_pt": 0.8,
            "fill": "#ffffff",
            "opacity": 0.94,
        },
    }


def make_colorbar_item(identifier: int = 4) -> dict:
    """colorbar item: 14x60, 标题带单位."""
    return {
        "id": identifier,
        "kind": "colorbar",
        "space": "page",
        "x": 100.0,
        "y": 20.0,
        "width_pt": 14.0,
        "height_pt": 60.0,
        "title": "高程 / 水深",
        "unit": "m",
        "show_title": True,
        "show_ticks": True,
        "title_size_pt": 8.0,
        "label_size_pt": 7.0,
    }


def make_geo_doc() -> dict:
    """与 make_scene_doc 的 200x100/base 对齐的 geo（含越界 lon 刻度）."""
    return {
        "format": geo.FORMAT,
        "version": geo.VERSION,
        "base": {
            "sha256": BASE_SHA,
            "view_box": [0, 0, 200, 100],
            "width_pt": 200.0,
            "height_pt": 100.0,
        },
        "graticule": {
            "lon": [
                {"value": 10, "label": "10°E", "x": 100.0, "y": 100.0, "side": "bottom"},
                {"value": 20, "label": "20°E", "x": 100.0, "y": 0.0, "side": "top"},
                # x=1000 → page x = 520 > paper.width, 必须被过滤.
                {"value": 30, "label": "30°E", "x": 1000.0, "y": 100.0, "side": "bottom"},
            ],
            "lat": [
                {"value": 40, "label": "40°N", "x": 0.0, "y": 25.0, "side": "left"},
                {"value": 50, "label": "50°N", "x": 200.0, "y": 25.0, "side": "right"},
            ],
        },
        "relief": {
            "title": "高程 / 水深",
            "unit": "m",
            "vmin": -10,
            "vmax": 10,
            "stops": [
                {"offset": 0, "color": "#08306b"},
                {"offset": 1, "color": "#ffffff"},
            ],
            "ticks": [-10, 0, 10],
        },
    }


def make_geo() -> geo.Geo:
    """解析成 typed Geo."""
    return geo.parse_geo(make_geo_doc())


def make_scene(items: list[dict] | None = None) -> dict:
    """规范化后的 scene（render 的输入口径）."""
    return page.normalize_scene(make_scene_doc(items), figure="fixture.svg")


class FormatNumberTest(unittest.TestCase):
    def test_three_decimals_and_trailing_zeros(self) -> None:
        self.assertEqual(render.format_number(28.0), "28")
        self.assertEqual(render.format_number(28.5), "28.5")
        self.assertEqual(render.format_number(1.2344), "1.234")
        self.assertEqual(render.format_number(1.2346), "1.235")
        self.assertEqual(render.format_number(-1.2346), "-1.235")
        self.assertEqual(render.format_number(100), "100")

    def test_zero_and_negative_zero(self) -> None:
        self.assertEqual(render.format_number(0), "0")
        self.assertEqual(render.format_number(-0.0), "0")
        self.assertEqual(render.format_number(0.0004), "0")

    def test_non_finite_falls_back_to_zero(self) -> None:
        self.assertEqual(render.format_number(float("nan")), "0")
        self.assertEqual(render.format_number(float("inf")), "0")

    def test_rejects_non_number(self) -> None:
        with self.assertRaises(TypeError):
            render.format_number("1.0")  # type: ignore[arg-type]


class TransformTest(unittest.TestCase):
    def test_map_transform_uses_geo_base(self) -> None:
        scene = make_scene()
        typed = make_geo()
        self.assertEqual(render.map_transform(scene, typed), (0.5, 20.0, 10.0))
        self.assertEqual(render.map_rect(scene, typed), (20.0, 10.0, 100.0, 50.0))

    def test_map_space_page_point(self) -> None:
        scene = make_scene()
        typed = make_geo()
        self.assertEqual(render._page_point(scene, typed, "map", 100.0, 50.0), (70.0, 35.0))
        self.assertEqual(render._page_point(scene, typed, "page", 100.0, 50.0), (100.0, 50.0))


class FrameTest(unittest.TestCase):
    def expected_frame(self) -> str:
        """按 §5.2 手算的完整图框字符串（golden）."""
        children = [
            '<rect x="20" y="10" width="100" height="50" fill="none" '
            'stroke="#000000" stroke-width="0.8"/>',
            # lon bottom: px = 20 + 100*0.5 = 70, 线 60→65, 基线 65+2+7=74
            '<line x1="70" y1="60" x2="70" y2="65" stroke="#444444" stroke-width="0.8"/>',
            '<text x="70" y="74" text-anchor="middle" font-family="Test Sans" '
            'font-size="7" fill="#444444">10°E</text>',
            # lon top: 线 10→5, 基线 5-2=3
            '<line x1="70" y1="10" x2="70" y2="5" stroke="#444444" stroke-width="0.8"/>',
            '<text x="70" y="3" text-anchor="middle" font-family="Test Sans" '
            'font-size="7" fill="#444444">20°E</text>',
            # lat left: py = 10 + 25*0.5 = 22.5, 线 20→15, label x=13, 基线 +2.45
            '<line x1="20" y1="22.5" x2="15" y2="22.5" stroke="#444444" stroke-width="0.8"/>',
            '<text x="13" y="24.95" text-anchor="end" font-family="Test Sans" '
            'font-size="7" fill="#444444">40°N</text>',
            # lat right: 线 120→125, label x=127, anchor=start
            '<line x1="120" y1="22.5" x2="125" y2="22.5" stroke="#444444" stroke-width="0.8"/>',
            '<text x="127" y="24.95" text-anchor="start" font-family="Test Sans" '
            'font-size="7" fill="#444444">50°N</text>',
        ]
        return '<g id="mapdoc-frame">\n' + "\n".join(children) + "\n</g>"

    def test_frame_golden(self) -> None:
        self.assertEqual(render.render_frame(make_scene(), make_geo()), self.expected_frame())

    def test_out_of_paper_tick_is_filtered(self) -> None:
        rendered = render.render_frame(make_scene(), make_geo())
        self.assertNotIn("30°E", rendered)
        self.assertEqual(rendered.count("<line"), 4)

    def test_hidden_frame_is_empty_group(self) -> None:
        doc = make_scene_doc()
        doc["frame"]["show"] = False
        doc["frame"]["ticks"] = False
        scene = page.normalize_scene(doc, figure="fixture.svg")
        self.assertEqual(render.render_frame(scene, make_geo()), '<g id="mapdoc-frame"></g>')


class TextTest(unittest.TestCase):
    def test_single_line_golden(self) -> None:
        scene = make_scene([make_text_item()])
        expected = (
            '<text x="100" y="20" text-anchor="middle" font-family="Test Sans" '
            'font-size="10" fill="#111111">甲</text>'
        )
        self.assertEqual(render.render_items(scene, make_geo()), expected)

    def test_multi_line_baselines(self) -> None:
        scene = make_scene([make_text_item(lines=["甲", "乙"], font_size=10.0)])
        rendered = render.render_items(scene, make_geo())
        self.assertIn('x="100" y="20"', rendered)
        self.assertIn('x="100" y="32"', rendered)  # 20 + 1*10*1.2

    def test_rotation_wraps_lines_in_group(self) -> None:
        scene = make_scene([make_text_item(lines=["甲", "乙"], rotation=45.0)])
        rendered = render.render_items(scene, make_geo())
        self.assertTrue(rendered.startswith('<g transform="rotate(45 100 20)">'), rendered)
        self.assertTrue(rendered.endswith("</g>"), rendered)
        self.assertEqual(rendered.count("<text"), 2)

    def test_halo_draws_copy_first(self) -> None:
        scene = make_scene(
            [
                make_text_item(
                    halo={"color": "#ffffff", "width_pt": 3.0}, color="#ff0000"
                )
            ]
        )
        rendered = render.render_items(scene, make_geo())
        halo_prefix = '<text x="100" y="20" text-anchor="middle" ' 'font-family="Test Sans" font-size="10" fill="#ffffff"'
        self.assertIn(halo_prefix + ' stroke="#ffffff" stroke-width="3"', rendered)
        self.assertIn('paint-order="stroke"', rendered)
        self.assertIn('fill="#ff0000"', rendered)
        self.assertLess(rendered.index('fill="#ffffff"'), rendered.index('fill="#ff0000"'))

    def test_text_is_xml_escaped(self) -> None:
        scene = make_scene([make_text_item(lines=["a & b < c > d"])])
        rendered = render.render_items(scene, make_geo())
        self.assertIn("a &amp; b &lt; c &gt; d", rendered)

    def test_map_space_transforms_origin(self) -> None:
        scene = make_scene([make_text_item(x=100.0, y=50.0, space="map")])
        rendered = render.render_items(scene, make_geo())
        # x = 20 + 100*0.5 = 70, y = 10 + 50*0.5 = 35; 字号不缩放.
        self.assertIn('<text x="70" y="35"', rendered)
        self.assertIn('font-size="10"', rendered)


class LegendTest(unittest.TestCase):
    def setUp(self) -> None:
        self.scene = make_scene([make_legend_item()])
        self.rendered = render.render_items(self.scene, make_geo())

    def test_derived_height_and_title(self) -> None:
        # p=7, row_h=14, title_h=12*1.4=16.8, height=14+16.8+3*14=72.8
        self.assertIn(
            '<rect x="10" y="10" width="180" height="72.8" fill="#ffffff" '
            'fill-opacity="0.94" stroke="#bbbbbb" stroke-width="0.8"/>',
            self.rendered,
        )
        self.assertIn(
            '<text x="100" y="29" text-anchor="middle" font-family="Test Sans" '
            'font-size="12" fill="#111111">图例</text>',
            self.rendered,
        )

    def test_line_swatch(self) -> None:
        self.assertIn(
            '<line x1="17" y1="40.8" x2="41" y2="40.8" stroke="#4a4a4a" '
            'stroke-width="1.4" stroke-dasharray="2 2" opacity="0.5"/>',
            self.rendered,
        )

    def test_rect_swatch(self) -> None:
        # 第 2 行中心 54.8, rect 高 9*0.9=8.1 → y=50.75
        self.assertIn(
            '<rect x="17" y="50.75" width="24" height="8.1" fill="#ff0000" '
            'stroke="#000000" stroke-width="0.5" opacity="1"/>',
            self.rendered,
        )

    def test_point_swatch_star(self) -> None:
        self.assertIn('<polygon points="29,63.85', self.rendered)
        self.assertIn('fill="#00ff00"', self.rendered)

    def test_label_baselines(self) -> None:
        self.assertIn('x="47" y="43.95"', self.rendered)
        self.assertIn('x="47" y="57.95"', self.rendered)
        self.assertIn('x="47" y="71.95"', self.rendered)
        self.assertIn('text-anchor="start"', self.rendered)

    def test_title_affects_height(self) -> None:
        item = make_legend_item(identifier=5)
        item["title"] = ""
        scene = make_scene([item])
        rendered = render.render_items(scene, make_geo())
        # title_h = 0 → height = 14 + 0 + 42 = 56
        self.assertIn('height="56"', rendered)
        self.assertNotIn(">图例</text>", rendered)


class ColorbarTest(unittest.TestCase):
    def setUp(self) -> None:
        self.scene = make_scene([make_colorbar_item()])
        self.typed = make_geo()
        self.rendered = render.render_items(self.scene, self.typed)

    def test_gradient_defs(self) -> None:
        self.assertEqual(
            render.render_defs(self.scene, self.typed),
            "<defs>\n"
            '<linearGradient id="mapdoc-cbar-4" x1="0" y1="100%" x2="0" y2="0%">\n'
            '<stop offset="0" stop-color="#08306b"/>\n'
            '<stop offset="1" stop-color="#ffffff"/>\n'
            "</linearGradient>\n"
            "</defs>",
        )

    def test_no_defs_without_colorbar(self) -> None:
        scene = make_scene([make_text_item()])
        self.assertEqual(render.render_defs(scene, self.typed), "")

    def test_bar_and_title(self) -> None:
        self.assertIn(
            '<rect x="100" y="20" width="14" height="60" '
            'fill="url(#mapdoc-cbar-4)"/>',
            self.rendered,
        )
        self.assertIn(
            '<text x="107" y="16" text-anchor="middle" font-family="Test Sans" '
            'font-size="8" fill="#111111">高程 / 水深 (m)</text>',
            self.rendered,
        )

    def test_tick_mapping(self) -> None:
        # v=-10 → ty=80; v=0 → ty=50; v=10 → ty=20; 短线 114→117, 标签 x=119.
        self.assertIn(
            '<line x1="114" y1="80" x2="117" y2="80" stroke="#111111"/>', self.rendered
        )
        self.assertIn(
            '<line x1="114" y1="50" x2="117" y2="50" stroke="#111111"/>', self.rendered
        )
        self.assertIn(
            '<line x1="114" y1="20" x2="117" y2="20" stroke="#111111"/>', self.rendered
        )
        self.assertIn('<text x="119" y="82.45"', self.rendered)
        self.assertIn('anchor="start"', self.rendered)
        self.assertIn(">-10</text>", self.rendered)

    def test_every_relief_tick_is_drawn(self) -> None:
        # §5.5 对每个 tick 套线性映射, 不裁剪（前端 colorbarLayout 同口径）.
        doc = make_geo_doc()
        doc["relief"]["ticks"] = [-20, 0, 20]
        typed = geo.parse_geo(doc)
        scene = make_scene([make_colorbar_item()])
        rendered = render.render_items(scene, typed)
        self.assertIn(">-20</text>", rendered)
        self.assertIn(">20</text>", rendered)
        self.assertIn(">0</text>", rendered)

    def test_missing_relief_raises(self) -> None:
        doc = make_geo_doc()
        doc.pop("relief")
        typed = geo.parse_geo(doc)
        with self.assertRaises(ValueError):
            render.render_items(self.scene, typed)


class OverlayTest(unittest.TestCase):
    def test_item_order_follows_array(self) -> None:
        text = make_text_item(1, lines=["先"])
        legend = make_legend_item(2)
        scene = make_scene([text, legend])
        rendered = render.render_overlay(scene, make_geo())
        self.assertTrue(rendered.startswith('<g id="mapdoc-overlay">\n'), rendered)
        self.assertLess(rendered.index("先"), rendered.index("图例"))

    def test_empty_overlay_group(self) -> None:
        self.assertEqual(
            render.render_overlay(make_scene(), make_geo()),
            '<g id="mapdoc-overlay"></g>',
        )

    def test_rendering_is_deterministic(self) -> None:
        scene = make_scene(
            [
                make_text_item(1, lines=["甲", "乙"]),
                make_legend_item(2),
                make_colorbar_item(3),
            ]
        )
        first = render.render_overlay(scene, make_geo())
        second = render.render_overlay(scene, make_geo())
        self.assertEqual(first, second)
        self.assertEqual(
            render.render_items(scene, make_geo()),
            render.render_items(scene, make_geo()),
        )


class MapSpaceItemTest(unittest.TestCase):
    """map 空间 item: origin 过 §5.1, 只有 width/height 乘 s, 字号/padding 保持 pt."""

    def test_legend_map_space_scales_width_only(self) -> None:
        item = make_legend_item(identifier=7)
        item["space"] = "map"
        item["x"] = 100.0  # page x = 20 + 100*0.5 = 70
        item["y"] = 50.0  # page y = 10 + 50*0.5 = 35
        item["entries"] = [make_legend_entry("国界", "line")]
        scene = make_scene([item])
        rendered = render.render_items(scene, make_geo())
        # width 180*0.5=90; 高度仍是 pt: 14+16.8+14=44.8
        self.assertIn('x="70" y="35" width="90" height="44.8"', rendered)
        # 标题基线 y+padding+title_size = 35+7+12 = 54; 字号 12 不缩.
        self.assertIn('<text x="115" y="54"', rendered)
        self.assertIn('font-size="12"', rendered)
        # 标签基线 35+7+16.8+7+3.15 = 68.95; x = 70+7+24+6 = 107.
        self.assertIn('x="107" y="68.95"', rendered)

    def test_colorbar_map_space_scales_size_only(self) -> None:
        item = make_colorbar_item(identifier=8)
        item["space"] = "map"
        item["x"] = 100.0  # page x = 70
        item["y"] = 50.0  # page y = 35
        scene = make_scene([item])
        rendered = render.render_items(scene, make_geo())
        # width 14*0.5=7, height 60*0.5=30.
        self.assertIn('x="70" y="35" width="7" height="30"', rendered)
        # title 基线 y-4 = 31（不随 s）; 标题 x = 70 + 3.5 = 73.5.
        self.assertIn('<text x="73.5" y="31"', rendered)
        # tick 短线 77→80, 标签 x=82; 字号 7 不缩.
        self.assertIn('<line x1="77" y1="65" x2="80" y2="65" stroke="#111111"/>', rendered)
        self.assertIn('<text x="82" y="67.45"', rendered)


class AnalyzeTest(unittest.TestCase):
    def test_out_of_paper_text(self) -> None:
        scene = make_scene([make_text_item(1, x=500.0, y=20.0), make_text_item(2)])
        out_of_paper, warnings = render.analyze(scene, make_geo())
        self.assertEqual(out_of_paper, [1])
        self.assertEqual(len(warnings), 1)
        self.assertIn("item 1(text)", warnings[0])

    def test_out_of_paper_legend_uses_derived_height(self) -> None:
        item = make_legend_item(2)
        item["y"] = 50.0  # 50 + 72.8 > 100 → 越界
        item["space"] = "page"
        scene = make_scene([item])
        out_of_paper, _warnings = render.analyze(scene, make_geo())
        self.assertEqual(out_of_paper, [2])

    def test_inside_items_are_not_reported(self) -> None:
        scene = make_scene([make_text_item(1), make_colorbar_item(2)])
        self.assertEqual(render.analyze(scene, make_geo()), ([], []))


if __name__ == "__main__":
    unittest.main()
