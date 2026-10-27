"""studio HTTP 服务的端到端单测(真实监听 127.0.0.1 的临时端口).

覆盖: 配置校验、/api/health、/api/doc、/api/scene GET/PUT(含 409/400/503)、
/api/compose、/base.svg /final.svg /overlay.svg、静态白名单与 .. 拒绝、2 MB 上限、
Cache-Control: no-store、底图缺失时的降级行为.
"""

from __future__ import annotations

import http.client
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

import studio
from mapdoc import contract, fsutil
from mapdoc import scene as scene_mod

from . import helpers

CONFIG_TOML = """\
[studio]
port = 0
open_browser = false
web_dist = "web_dist"
base_dir = ".build"

[figures]
volga = "figures/Volga/map.svg"
"""


def _write_temp_config(root: Path) -> studio.StudioConfig:
    """在临时目录里写一份测试 TOML 并读回配置; 只要求图文件存在, 不要求底图."""
    (root / "figures").mkdir()
    (root / "figures" / "map.svg").write_bytes(helpers.BASE_SVG)
    path = root / "studio.toml"
    path.write_text(CONFIG_TOML, encoding="utf-8")
    return studio.load_config(path)


class _StudioCase(unittest.TestCase):
    install_base = True

    def setUp(self) -> None:
        self._directory = tempfile.TemporaryDirectory()
        self.root = Path(self._directory.name)
        figure_dir = self.root / "figures" / "Volga"
        figure_dir.mkdir(parents=True)
        self.svg_path = figure_dir / "map.svg"
        self.svg_path.write_bytes(helpers.BASE_SVG)
        base_dir = figure_dir / ".build"
        base_dir.mkdir()
        if self.install_base:
            (base_dir / "map.base.svg").write_bytes(helpers.BASE_SVG)
        web_dist = self.root / "web_dist"
        (web_dist / "assets").mkdir(parents=True)
        (web_dist / "index.html").write_text(
            "<!doctype html><html><body>studio</body></html>", encoding="utf-8"
        )
        (web_dist / "assets" / "app.js").write_text(
            "console.log('ok');\n", encoding="utf-8"
        )
        self.config_path = self.root / "studio.toml"
        self.config_path.write_text(CONFIG_TOML, encoding="utf-8")
        self.config = studio.load_config(self.config_path)
        self.figure = self.config.figures["volga"]
        self.server = studio.make_server(self.config)
        self.server.quiet = True
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(
            target=self.server.serve_forever,
            kwargs={"poll_interval": 0.05},
            daemon=True,
        )
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self._directory.cleanup()

    # -- 请求辅助 ---------------------------------------------------------

    def request(
        self,
        method: str,
        path: str,
        body: object | None = None,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, dict[str, str], bytes]:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        payload = None
        request_headers = dict(headers or {})
        if body is not None:
            payload = json.dumps(body).encode("utf-8")
            request_headers.setdefault("Content-Type", "application/json")
        connection.request(method, path, body=payload, headers=request_headers)
        response = connection.getresponse()
        data = response.read()
        status = response.status
        response_headers = {name: value for name, value in response.getheaders()}
        connection.close()
        return status, response_headers, data

    def json_request(
        self, method: str, path: str, body: object | None = None
    ) -> tuple[int, dict[str, object]]:
        status, _headers, data = self.request(method, path, body)
        return status, json.loads(data.decode("utf-8"))

    def scene_payload(self, *, figure: str = "volga") -> dict[str, object]:
        """以 GET /api/scene 的规范化结果为基础构造 PUT 语义体."""
        status, _headers, data = self.request("GET", f"/api/scene?figure={figure}")
        self.assertEqual(status, 200)
        document = json.loads(data.decode("utf-8"))
        return {
            "base": document["base"],
            "ack_base_change": False,
            "style": document["style"],
            "seq": document["seq"],
            "points": document["points"],
            "entities": document["entities"],
            "constraints": document["constraints"],
        }

    def payload_with_line(self) -> dict[str, object]:
        body = self.scene_payload()
        body["points"] = [helpers.point(1, 10.0, 10.0), helpers.point(2, 60.0, 40.0)]
        body["entities"] = [
            {"id": 3, "type": "line", "a": 1, "b": 2, "construction": False}
        ]
        body["seq"] = 4
        return body


class StudioApiTest(_StudioCase):
    def test_health(self) -> None:
        status, headers, data = self.request("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Cache-Control"], "no-store")
        payload = json.loads(data)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["figures"], ["volga"])
        self.assertIn("python", payload)
        self.assertIn("cwd", payload)

    def test_doc_initially_needs_compose(self) -> None:
        status, payload = self.json_request("GET", "/api/doc?figure=volga")
        self.assertEqual(status, 200)
        self.assertEqual(payload["figure"]["key"], "volga")
        self.assertTrue(payload["figure"]["path"].endswith("figures/Volga/map.svg"))
        self.assertEqual(
            payload["canvas"], {"width_pt": 200.0, "height_pt": 100.0}
        )
        self.assertEqual(payload["base"]["sha256"], contract.sha256(helpers.BASE_SVG))
        self.assertEqual(payload["base"]["sha256"], self.scene_payload()["base"]["sha256"])
        # prepare 之后 final 已有初始字节(与 base 同源)但还没有 marker.
        self.assertEqual(payload["final"]["sha256"], contract.sha256(helpers.BASE_SVG))
        self.assertIsNone(payload["final"]["marker"])
        self.assertEqual(payload["needs"], {"render": False, "compose": True, "ack": False})
        self.assertIn("style_defaults", payload)
        self.assertEqual(payload["warnings"], [])
        self.assertEqual(payload["scene"]["sha256"], scene_mod.digest(
            scene_mod.empty_scene(payload["figure"]["path"], helpers.base_info())
        ))

    def test_scene_always_returns_canonical_empty_scene(self) -> None:
        status, headers, data = self.request("GET", "/api/scene?figure=volga")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertTrue(headers["Content-Type"].startswith("application/json"))
        self.assertFalse(data.endswith(b"\n"))
        document = json.loads(data)
        self.assertEqual(list(document), sorted(document))
        self.assertEqual(document["format"], "mapdoc-scene")
        self.assertEqual(document["version"], 1)
        self.assertEqual(document["seq"], 1)
        self.assertEqual(document["points"], [])
        self.assertEqual(document["base"]["sha256"], contract.sha256(helpers.BASE_SVG))

    def test_put_writes_scene_composes_and_serves_final(self) -> None:
        status, payload = self.json_request(
            "PUT", "/api/scene?figure=volga", self.payload_with_line()
        )
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["saved"])
        self.assertTrue(payload["composed"])
        self.assertEqual(len(payload["scene_sha"]), 64)
        self.assertEqual(payload["marker"]["scene"], payload["scene_sha"])
        self.assertEqual(payload["report"]["counts"]["entities"], 1)

        # scene 落盘字节 = 规范化字节.
        scene_bytes = self.figure.scene_path.read_bytes()
        self.assertEqual(contract.sha256(scene_bytes), payload["scene_sha"])

        # final 满足 I1, 且包含叠加层与 marker.
        final = self.figure.final_path.read_bytes()
        position = contract.insert_position(helpers.BASE_SVG)
        self.assertTrue(final.startswith(helpers.BASE_SVG[:position]))
        self.assertTrue(final.endswith(helpers.BASE_SVG[position:]))
        self.assertIn(b'<g id="mapdoc-overlay"', final)
        self.assertEqual(contract.marker_scene_sha(contract.parse_marker(final)), payload["scene_sha"])

        # /api/doc 现在认为已合成; /final.svg 与 /overlay.svg 可访问.
        _status, doc = self.json_request("GET", "/api/doc?figure=volga")
        self.assertEqual(doc["needs"], {"render": False, "compose": False, "ack": False})
        self.assertEqual(doc["final"]["sha256"], contract.sha256(final))
        status, headers, final_bytes = self.request("GET", "/final.svg?figure=volga")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "image/svg+xml")
        self.assertEqual(final_bytes, final)
        status, headers, overlay_bytes = self.request("GET", "/overlay.svg?figure=volga")
        self.assertEqual(status, 200)
        self.assertIn(b'<g id="mapdoc-overlay"', overlay_bytes)
        self.assertIn(b"mapdoc-final:", overlay_bytes)

    def test_put_text_rejected_and_scene_unchanged(self) -> None:
        body = self.scene_payload()
        body["points"] = [helpers.point(1, 10.0, 10.0)]
        body["entities"] = [{"id": 2, "type": "text", "p": 1, "text": "x"}]
        body["seq"] = 3
        status, payload = self.json_request("PUT", "/api/scene?figure=volga", body)
        self.assertEqual(status, 400)
        self.assertEqual(payload["code"], "invalid_scene")
        self.assertIn("P3", payload["message"])
        self.assertFalse(self.figure.scene_path.exists())

    def test_put_unknown_field_rejected(self) -> None:
        body = self.payload_with_line()
        body["extra"] = True
        status, payload = self.json_request("PUT", "/api/scene?figure=volga", body)
        self.assertEqual(status, 400)
        self.assertEqual(payload["code"], "invalid_scene")

    def test_put_base_changed_requires_ack(self) -> None:
        body = self.payload_with_line()
        body["base"] = {"sha256": "f" * 64, "width_pt": 200.0, "height_pt": 100.0}
        status, payload = self.json_request("PUT", "/api/scene?figure=volga", body)
        self.assertEqual(status, 409)
        self.assertEqual(payload["code"], "base_changed")
        self.assertEqual(payload["base"]["sha256"], contract.sha256(helpers.BASE_SVG))
        self.assertFalse(self.figure.scene_path.exists())

        body["ack_base_change"] = True
        status, payload = self.json_request("PUT", "/api/scene?figure=volga", body)
        self.assertEqual(status, 200)
        self.assertTrue(payload["composed"])
        saved = json.loads(self.figure.scene_path.read_bytes())
        # 通过后以当前底图 sha 写盘, 而不是保留客户端声明.
        self.assertEqual(saved["base"]["sha256"], contract.sha256(helpers.BASE_SVG))

    def test_put_canvas_changed_rejected(self) -> None:
        body = self.payload_with_line()
        body["base"] = {
            "sha256": contract.sha256(helpers.BASE_SVG),
            "width_pt": 300.0,
            "height_pt": 100.0,
        }
        status, payload = self.json_request("PUT", "/api/scene?figure=volga", body)
        self.assertEqual(status, 409)
        self.assertEqual(payload["code"], "canvas_changed")
        self.assertFalse(self.figure.scene_path.exists())

    def test_put_while_locked_reports_rendering_then_compose(self) -> None:
        body = self.payload_with_line()
        with fsutil.try_flock(self.figure.lock_path) as acquired:
            self.assertTrue(acquired)
            status, payload = self.json_request("PUT", "/api/scene?figure=volga", body)
            self.assertEqual(status, 200)
            self.assertTrue(payload["saved"])
            self.assertFalse(payload["composed"])
            self.assertEqual(payload["code"], "rendering")
            # 拿不到锁时 final 保持旧版本(不能被写半成品).
            self.assertEqual(self.figure.final_path.read_bytes(), helpers.BASE_SVG)
            self.assertIsNone(contract.parse_marker(self.figure.final_path.read_bytes()))
            # 强制合成在锁被占用时返回 409 rendering.
            status, payload = self.json_request("POST", "/api/compose?figure=volga")
            self.assertEqual(status, 409)
            self.assertEqual(payload["code"], "rendering")
        # 锁释放后可补合成.
        status, payload = self.json_request("POST", "/api/compose?figure=volga")
        self.assertEqual(status, 200)
        self.assertTrue(payload["composed"])
        self.assertTrue(self.figure.final_path.is_file())

    def test_compose_without_scene_file_is_empty_compose(self) -> None:
        status, payload = self.json_request("POST", "/api/compose?figure=volga")
        self.assertEqual(status, 200)
        self.assertTrue(payload["composed"])
        final = self.figure.final_path.read_bytes()
        position = contract.insert_position(helpers.BASE_SVG)
        inserted = final[len(helpers.BASE_SVG[:position]) : len(final) - len(helpers.BASE_SVG[position:])]
        self.assertNotIn(b"<g", inserted)
        self.assertIsNotNone(contract.MARKER_PATTERN.fullmatch(inserted))

    def test_payload_too_large(self) -> None:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        connection.putrequest("PUT", "/api/scene?figure=volga")
        connection.putheader("Content-Length", str(studio.MAX_BODY_BYTES + 1))
        connection.endheaders()
        response = connection.getresponse()
        self.assertEqual(response.status, 413)
        payload = json.loads(response.read().decode("utf-8"))
        self.assertEqual(payload["code"], "payload_too_large")
        connection.close()

    def test_unknown_figure_and_unknown_endpoint(self) -> None:
        status, payload = self.json_request("GET", "/api/doc?figure=nope")
        self.assertEqual(status, 400)
        self.assertEqual(payload["code"], "unknown_figure")
        status, _headers, _data = self.request("GET", "/api/nope")
        self.assertEqual(status, 404)
        status, _headers, _data = self.request("PUT", "/api/doc?figure=volga", {})
        self.assertEqual(status, 404)

    def test_static_whitelist_and_traversal(self) -> None:
        status, headers, data = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"studio", data)
        self.assertTrue(headers["Content-Type"].startswith("text/html"))
        self.assertEqual(headers["Cache-Control"], "no-store")

        status, headers, data = self.request("GET", "/assets/app.js")
        self.assertEqual(status, 200)
        self.assertTrue(headers["Content-Type"].startswith("text/javascript"))
        self.assertIn(b"console.log", data)

        for path in (
            "/assets/../studio.toml",
            "/assets/%2e%2e/studio.toml",
            "/../studio.toml",
            "/tools/studio.py",
            "/assets/",
            "/assets/missing.js",
        ):
            status, _headers, _data = self.request("GET", path)
            self.assertEqual(status, 404, path)

    def test_base_and_final_endpoints(self) -> None:
        status, headers, data = self.request("GET", "/base.svg?figure=volga")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "image/svg+xml")
        self.assertEqual(data, helpers.BASE_SVG)
        # 还没合成时 final 仍是 prepare 复制的初始字节(没有 marker).
        status, headers, final_bytes = self.request("GET", "/final.svg?figure=volga")
        self.assertEqual(status, 200)
        self.assertEqual(final_bytes, helpers.BASE_SVG)


class StudioNoBaseTest(_StudioCase):
    install_base = False

    def test_degraded_state_without_base(self) -> None:
        status, payload = self.json_request("GET", "/api/doc?figure=volga")
        self.assertEqual(status, 200)
        self.assertTrue(payload["needs"]["render"])
        self.assertEqual(payload["canvas"], {"width_pt": 0.0, "height_pt": 0.0})
        self.assertTrue(any("底图" in message for message in payload["warnings"]))

        # GET /api/scene 总是 200: 空场景 + 占位 base 声明.
        status, _headers, data = self.request("GET", "/api/scene?figure=volga")
        self.assertEqual(status, 200)
        document = json.loads(data)
        self.assertEqual(document["base"]["sha256"], "")

        body = self.scene_payload()
        # 底图缺失时 GET /api/scene 用占位 base(sha 空/尺寸 0); PUT 语义体按正常形状构造,
        # 这样能验证服务器是"因底图不可用"返回 503, 而不是把它当成非法 schema.
        body["base"] = {"sha256": "a" * 64, "width_pt": 200.0, "height_pt": 100.0}
        body["points"] = [helpers.point(1, 10.0, 10.0)]
        body["seq"] = 2
        status, payload = self.json_request(
            "PUT", "/api/scene?figure=volga", body
        )
        self.assertEqual(status, 503)
        self.assertEqual(payload["code"], "render_required")
        self.assertFalse(self.figure.scene_path.exists())

        status, _headers, _data = self.request("GET", "/overlay.svg?figure=volga")
        self.assertEqual(status, 503)


class ConfigTest(unittest.TestCase):
    def test_unknown_keys_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "figures").mkdir()
            (root / "figures" / "map.svg").write_bytes(helpers.BASE_SVG)
            path = root / "studio.toml"
            path.write_text(
                CONFIG_TOML.replace("port = 0", "port = 0\nmystery = 1"),
                encoding="utf-8",
            )
            with self.assertRaises(studio.StudioConfigError) as raised:
                studio.load_config(path)
            self.assertIn("mystery", str(raised.exception))

    def test_missing_config_reports_example(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(studio.StudioConfigError):
                studio.load_config(Path(directory) / "absent.toml")

    def test_paths_are_derived_from_figure_svg(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "figures").mkdir()
            (root / "figures" / "map.svg").write_bytes(helpers.BASE_SVG)
            path = root / "studio.toml"
            path.write_text(CONFIG_TOML, encoding="utf-8")
            config = studio.load_config(path)
            figure = config.figures["volga"]
            self.assertEqual(
                figure.final_path, (root / "figures" / "Volga" / "map.svg").resolve()
            )
            self.assertEqual(
                figure.scene_path,
                (root / "figures" / "Volga" / "map.scene.json").resolve(),
            )
            self.assertEqual(
                figure.base_path,
                (root / "figures" / "Volga" / ".build" / "map.base.svg").resolve(),
            )
            self.assertEqual(
                figure.lock_path,
                (root / "figures" / "Volga" / ".build" / "map.lock").resolve(),
            )
            # 临时目录在仓库外, figure_name 回落为绝对路径(仅用于显示, 不参与 IO).
            self.assertTrue(figure.figure_name.endswith("figures/Volga/map.svg"))
            self.assertNotIn("..", figure.figure_name)

    def test_env_overrides_port_and_open_browser(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = _write_temp_config(Path(directory))
            with mock.patch.dict(
                os.environ,
                {studio.ENV_STUDIO_PORT: "8899", studio.ENV_OPEN_BROWSER: "1"},
            ):
                overridden = studio.apply_env_overrides(config)
            self.assertEqual(overridden.port, 8899)
            self.assertTrue(overridden.open_browser)
            # 覆盖只动这两个字段, 图的派生路径原样保留.
            self.assertEqual(overridden.figures, config.figures)

    def test_env_overrides_absent_keeps_toml_values(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = _write_temp_config(Path(directory))
            with mock.patch.dict(os.environ, {}):
                os.environ.pop(studio.ENV_STUDIO_PORT, None)
                os.environ.pop(studio.ENV_OPEN_BROWSER, None)
                overridden = studio.apply_env_overrides(config)
            self.assertEqual(overridden.port, config.port)
            self.assertEqual(overridden.open_browser, config.open_browser)

    def test_invalid_env_port_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = _write_temp_config(Path(directory))
            with mock.patch.dict(os.environ, {studio.ENV_STUDIO_PORT: "not-a-port"}):
                with self.assertRaises(studio.StudioConfigError) as raised:
                    studio.apply_env_overrides(config)
            self.assertIn(studio.ENV_STUDIO_PORT, str(raised.exception))

    def test_invalid_env_open_browser_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = _write_temp_config(Path(directory))
            with mock.patch.dict(os.environ, {studio.ENV_OPEN_BROWSER: "maybe"}):
                with self.assertRaises(studio.StudioConfigError) as raised:
                    studio.apply_env_overrides(config)
            self.assertIn(studio.ENV_OPEN_BROWSER, str(raised.exception))


if __name__ == "__main__":
    unittest.main()
