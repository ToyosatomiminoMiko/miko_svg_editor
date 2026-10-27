"""overlay 生成规则的单测.

覆盖: 数字格式(无单位后缀/去尾零)、元素白名单、单 `<g>` 子元素序、整圆弧→`<circle>`、
非整圆弧 A 命令与 large 标志、BUG-1 跳过、构造线虚线、点的实心/空心、越界报告、空场景.
"""

from __future__ import annotations

import unittest
import xml.etree.ElementTree as ET

from mapdoc import overlay

from . import helpers


def _overlay(body: dict[str, object] | None = None) -> overlay.Overlay:
    scan = helpers.make_scene(body)
    return overlay.render_overlay(scan, 200.0, 100.0)


class NumberFormatTest(unittest.TestCase):
    def test_format_number(self) -> None:
        self.assertEqual(overlay.format_number(1.0), "1")
        self.assertEqual(overlay.format_number(1.23456), "1.235")
        self.assertEqual(overlay.format_number(-0.0), "0")
        self.assertEqual(overlay.format_number(0.0004), "0")
        self.assertEqual(overlay.format_number(1265.854289), "1265.854")
        self.assertEqual(overlay.format_number(float("nan")), "0")
        self.assertEqual(overlay.format_number(float("inf")), "0")

    def test_output_has_no_css_unit_suffix(self) -> None:
        group = _overlay(
            helpers.payload(
                points=[helpers.point(1, 1.5, 2.5), helpers.point(2, 30.25, 40.75)],
                entities=[{"id": 3, "type": "line", "a": 1, "b": 2, "construction": False}],
                seq=4,
            )
        ).group
        assert group is not None
        self.assertNotIn("pt", group)
        self.assertNotIn("px", group)
        self.assertNotIn("mm", group)


class GeometryTest(unittest.TestCase):
    def test_line_circle_and_construction(self) -> None:
        result = _overlay(
            helpers.payload(
                points=[
                    helpers.point(1, 0.0, 0.0),
                    helpers.point(2, 100.25, 50.5),
                    helpers.point(3, 50.0, 50.0),
                ],
                entities=[
                    {"id": 4, "type": "line", "a": 1, "b": 2, "construction": False},
                    {"id": 5, "type": "line", "a": 2, "b": 3, "construction": True},
                    {"id": 6, "type": "circle", "c": 3, "r": 12.5, "construction": True},
                ],
                seq=7,
            )
        )
        group = result.group
        assert group is not None
        self.assertIn('<line x1="0" y1="0" x2="100.25" y2="50.5"/>', group)
        self.assertIn('stroke-dasharray="4 4"', group)
        self.assertIn('<circle cx="50" cy="50" r="12.5"', group)
        self.assertEqual(result.counts, {"points": 3, "entities": 3, "constraints": 0, "texts": 0})

    def test_partial_arc_uses_a_command(self) -> None:
        result = _overlay(
            helpers.payload(
                points=[
                    helpers.point(1, 50.0, 50.0),
                    helpers.point(2, 60.0, 50.0),
                    helpers.point(3, 50.0, 60.0),
                ],
                entities=[{"id": 4, "type": "arc", "c": 1, "a": 2, "b": 3, "construction": False}],
                seq=5,
            )
        )
        group = result.group
        assert group is not None
        self.assertIn('<path d="M 60 50 A 10 10 0 0 1 50 60"/>', group)
        self.assertNotIn("<circle", group)

    def test_large_arc_flag(self) -> None:
        result = _overlay(
            helpers.payload(
                points=[
                    helpers.point(1, 50.0, 50.0),
                    helpers.point(2, 60.0, 50.0),
                    helpers.point(3, 50.0, 40.0),
                ],
                entities=[{"id": 4, "type": "arc", "c": 1, "a": 2, "b": 3, "construction": False}],
                seq=5,
            )
        )
        group = result.group
        assert group is not None
        self.assertIn('<path d="M 60 50 A 10 10 0 1 1 50 40"/>', group)

    def test_full_arc_same_point_id_renders_circle(self) -> None:
        result = _overlay(
            helpers.payload(
                points=[helpers.point(1, 50.0, 50.0), helpers.point(2, 60.0, 50.0)],
                entities=[],
                seq=3,
            )
        )
        self.assertIsNone(result.group)
        # 同一位置(不同点 id)的整圆弧: a==b 的坐标, sweepOf 判定为 TAU.
        scan = helpers.make_scene(
            helpers.payload(
                points=[
                    helpers.point(1, 50.0, 50.0),
                    helpers.point(2, 60.0, 50.0),
                    helpers.point(3, 60.0, 50.0),
                ],
                entities=[{"id": 4, "type": "arc", "c": 1, "a": 2, "b": 3, "construction": False}],
                seq=5,
            )
        )
        rendered = overlay.render_overlay(scan, 200.0, 100.0)
        self.assertIn('<circle cx="50" cy="50" r="10"/>', rendered.group or "")
        # 同一个点 id 作起点与终点(圆弧工具"再点起点即整圆")同样输出 <circle>.
        scan_same = helpers.make_scene(
            helpers.payload(
                points=[helpers.point(1, 50.0, 50.0), helpers.point(2, 60.0, 50.0)],
                entities=[{"id": 3, "type": "arc", "c": 1, "a": 2, "b": 2, "construction": False}],
                seq=4,
            )
        )
        same = overlay.render_overlay(scan_same, 200.0, 100.0)
        self.assertIn("<circle", same.group or "")
        self.assertNotIn("<path", same.group or "")

    def test_bug1_skips_arc_whose_formatted_endpoints_coincide(self) -> None:
        # 半径 100、终角 1e-6 rad: 3 位小数格式化后终点仍是 (100, 0), 与起点重合.
        scan = helpers.make_scene(
            helpers.payload(
                points=[
                    helpers.point(1, 0.0, 0.0),
                    helpers.point(2, 100.0, 0.0),
                    helpers.point(3, 1000.0, 0.001),
                ],
                entities=[{"id": 4, "type": "arc", "c": 1, "a": 2, "b": 3, "construction": False}],
                seq=5,
            )
        )
        rendered = overlay.render_overlay(scan, 200.0, 100.0)
        self.assertIsNone(rendered.group)
        self.assertTrue(any("BUG-1" in message for message in rendered.warnings))

    def test_point_solid_and_construction_style(self) -> None:
        result = _overlay(
            helpers.payload(
                points=[helpers.point(1, 20.0, 30.0), helpers.point(2, 40.0, 50.0)],
                entities=[
                    {"id": 3, "type": "point", "p": 1, "construction": False},
                    {"id": 4, "type": "point", "p": 2, "construction": True},
                ],
                seq=5,
            )
        )
        group = result.group
        assert group is not None
        self.assertIn(
            '<circle cx="20" cy="30" r="1.6" fill="#c62828" stroke="none"/>', group
        )
        self.assertIn('r="1.6" fill="none" stroke-dasharray="4 4"', group)


class StructureTest(unittest.TestCase):
    def test_single_group_children_follow_entity_order(self) -> None:
        points, entities = helpers.full_geometry_entities()
        result = _overlay(helpers.payload(seq=200, points=points, entities=entities))
        group = result.group
        assert group is not None
        self.assertEqual(group.count("<g "), 1)
        root = ET.fromstring(group)
        self.assertEqual(root.tag, "g")
        self.assertEqual(root.get("id"), "mapdoc-overlay")
        self.assertEqual(root.get("data-format"), "mapdoc-overlay")
        self.assertEqual(root.get("data-version"), "1")
        self.assertEqual(
            [child.tag for child in root],
            ["line", "line", "circle", "path", "circle", "circle"],
        )

    def test_whitelist_and_forbidden_markup(self) -> None:
        points, entities = helpers.full_geometry_entities()
        group = _overlay(helpers.payload(seq=200, points=points, entities=entities)).group
        assert group is not None
        root = ET.fromstring(group)
        tags = {element.tag for element in root.iter()}
        self.assertLessEqual(tags, {"g", "line", "circle", "path"})
        for forbidden in ("<script", "<foreignObject", "<image", "<use", "href=", "url(", " on"):
            self.assertNotIn(forbidden, group)

    def test_empty_scene_has_no_group_and_no_defs(self) -> None:
        result = _overlay()
        self.assertIsNone(result.group)
        self.assertIsNone(result.defs_style)
        self.assertEqual(result.counts, {"points": 0, "entities": 0, "constraints": 0, "texts": 0})
        self.assertEqual(result.out_of_canvas, ())
        self.assertEqual(result.missing_glyphs, ())

    def test_out_of_canvas_reported_by_id(self) -> None:
        result = _overlay(
            helpers.payload(
                points=[
                    helpers.point(1, 150.0, 50.0),
                    helpers.point(2, 250.0, 50.0),
                    helpers.point(3, 10.0, 10.0),
                    helpers.point(4, 20.0, 20.0),
                ],
                entities=[
                    {"id": 5, "type": "line", "a": 1, "b": 2, "construction": False},
                    {"id": 6, "type": "line", "a": 3, "b": 4, "construction": False},
                ],
                seq=7,
            ),
            )
        self.assertEqual(result.out_of_canvas, (5,))
        self.assertTrue(any("5" in message for message in result.warnings))
        self.assertIn("<line", result.group or "")


if __name__ == "__main__":
    unittest.main()
