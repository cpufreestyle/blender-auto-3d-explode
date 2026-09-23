#!/usr/bin/env python3
"""
blender_image_to_3d.py 的纯逻辑单测（无需 Blender）。

通过向 sys.modules 注入 bpy/mathutils 的 stub，使模块可在 Blender 外导入，
只验证与几何/深度数学相关的确定性行为：
- sample_grid 的采样式（网格第 0 行 = 图像底行，高度场不再与贴图上下翻转）
- estimate_depth 的多线索深度先验（范围、中心/垂直先验、边缘保持、透明背景压平）
- tile_faces 的后表面与侧墙绕序（外法线朝外，导出后背面也是实体）

运行:
  python3 -m unittest discover -s tests -p 'img2depth_test.py'
  python3 tests/img2depth_test.py
"""
import os
import sys
import types
import unittest
import unittest.mock

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

for _name in ("bpy", "mathutils"):
    _mod = types.ModuleType(_name)
    sys.modules[_name] = _mod

import blender_image_to_3d as m  # noqa: E402

try:
    import numpy as np
except ImportError:
    np = None

requires_numpy = unittest.skipUnless(np is not None, "numpy 不可用（Blender 未捆绑）")


class _FakeImage:
    """最小 Image 替身：Blender 的 img.pixels 是自下而上的 RGBA 扁平序列。"""

    def __init__(self, size, pixels, channels=4):
        self.size = size
        self.pixels = pixels
        self.channels = channels


def _luma(r, g, b):
    return 0.299 * r + 0.587 * g + 0.114 * b


def _face_normal(coords, face):
    a = coords[face[0]]
    b = coords[face[1]]
    c = coords[face[2]]
    u = [b[i] - a[i] for i in range(3)]
    v = [c[i] - a[i] for i in range(3)]
    return (
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0],
    )


class ParseArgsTest(unittest.TestCase):
    """parse_args：只解析 `--` 之后的参数，thickness 是新参数。"""

    def _parse(self, argv):
        with unittest.mock.patch.object(sys, "argv", ["blender", "--background", "--python", "x.py", "--", *argv]):
            return m.parse_args()

    def test_parses_all_known_options(self):
        opts = self._parse([
            "--image", "a.png", "--output", "b.glb", "--manifest", "c.json",
            "--resolution", "64", "--depth", "0.5", "--mode", "depth",
            "--tiles", "2", "--thickness", "0.1", "--texture",
        ])
        self.assertEqual(opts["image"], "a.png")
        self.assertEqual(opts["output"], "b.glb")
        self.assertEqual(opts["manifest"], "c.json")
        self.assertEqual(opts["resolution"], 64)
        self.assertEqual(opts["depth"], 0.5)
        self.assertEqual(opts["mode"], "depth")
        self.assertEqual(opts["tiles"], 2)
        self.assertEqual(opts["thickness"], 0.1)
        self.assertTrue(opts["texture"])

    def test_ignores_blender_flags_before_double_dash(self):
        # Blender 自身参数（--background/--python）必须被 `--` 挡在外面
        opts = self._parse(["--image", "a.png"])
        self.assertNotIn("background", opts)
        self.assertNotIn("python", opts)


class SampleGridTest(unittest.TestCase):
    """sample_grid：网格第 y 行取图像第 y 行（Blender 像素自下而上）。"""

    def setUp(self):
        # 2x2 图：底行红、顶行蓝（pixels 扁平序 = 底行两像素 + 顶行两像素）
        self.img = _FakeImage((2, 2), [
            1, 0, 0, 1, 1, 0, 0, 1,  # 底行：红
            0, 0, 1, 1, 0, 0, 1, 1,  # 顶行：蓝
        ])

    def test_row_zero_maps_to_image_bottom(self):
        # 修复点：此前 py = (resY-1-y)，网格底行取到图像顶行，高度场与贴图上下翻转
        grid = m.sample_grid(self.img, 2, 2, 0)
        self.assertAlmostEqual(grid[0][0], _luma(1, 0, 0))
        self.assertAlmostEqual(grid[0][1], _luma(1, 0, 0))
        self.assertAlmostEqual(grid[1][0], _luma(0, 0, 1))
        self.assertAlmostEqual(grid[1][1], _luma(0, 0, 1))

    def test_alpha_channel_sampling(self):
        grid = m.sample_grid(self.img, 2, 2, 3)
        self.assertEqual(grid, [[1.0, 1.0], [1.0, 1.0]])

    def test_voxel_quantization_style_rounding(self):
        # 与 main() 中 voxel 量化一致的取整逻辑（8 级）
        v = 0.37
        self.assertEqual(round(v * 7) / 7, 3 / 7)


@requires_numpy
class EstimateDepthTest(unittest.TestCase):
    """estimate_depth：多线索深度先验的确定性行为。"""

    def _grid(self, h, w, value):
        return np.full((h, w), value, dtype=np.float32)

    def test_range_and_shape(self):
        rng = np.random.default_rng(7)
        luma = rng.random((32, 48), dtype=np.float32)
        depth = m.estimate_depth(luma)
        self.assertEqual(depth.shape, luma.shape)
        self.assertTrue(np.all(depth >= 0.0))
        self.assertTrue(np.all(depth <= 1.0))

    def test_centered_blob_is_nearer_than_corners(self):
        # 注意网格方向：第 0 行 = 图像底行（相机近端），末行 = 图像顶行（远端）
        h = w = 64
        yy, xx = np.mgrid[0:h, 0:w]
        luma = self._grid(h, w, 0.2)
        blob = ((yy - 32) ** 2 + (xx - 32) ** 2) < 12 ** 2
        luma[blob] = 0.95  # 居中亮主体（大气透视说它远，中心/细节先验说它近）
        depth = m.estimate_depth(luma)
        # 中心主体先验 + 局部细节先验压过雾霾线索：中心必须是全场最近
        self.assertGreater(float(depth[32, 32]), float(depth[61, 61]))  # 顶右角
        self.assertGreater(float(depth[32, 32]), float(depth[61, 2]))  # 顶左角
        self.assertGreater(float(depth[32, 32]), float(depth[2, 61]))  # 底右角
        self.assertGreater(float(depth[32, 32]), float(depth[2, 2]))  # 底左角
        # 垂直先验：底行比顶行近
        self.assertGreater(float(depth[2, 32]), float(depth[61, 32]))

    def test_vertical_prior_bottom_rows_nearer_than_top_rows(self):
        h = w = 32
        luma = self._grid(h, w, 0.5)  # 全图同亮度，只剩垂直先验
        depth = m.estimate_depth(luma)
        # 第 0 行（图像底）近、末行（图像顶）远
        self.assertGreater(float(depth[0, 16]), float(depth[31, 16]))
        col = depth[:, 16]
        self.assertGreater(float(col[0:8].mean()), float(col[24:32].mean()))

    def test_transparent_background_is_flattened(self):
        h = w = 32
        luma = self._grid(h, w, 0.6)
        alpha = np.ones((h, w), dtype=np.float32)
        alpha[:, w // 2:] = 0.0  # 右半透明背景
        depth = m.estimate_depth(luma, alpha)
        self.assertTrue(np.all(depth[:, w // 2:] == 0.0))
        # 左半仍应有起伏（归一化后最小值恰为 0，故用均值而非逐格 > 0）
        self.assertGreater(float(depth[:, : w // 2].mean()), 0.1)

    def test_edge_aware_smooth_blocks_at_image_edges(self):
        h = w = 32
        field = np.zeros((h, w), dtype=np.float32)
        field[:, w // 2:] = 0.8
        # guide 在同一条列线上有强边缘：阶跃必须保留
        guide = np.zeros((h, w), dtype=np.float32)
        guide[:, w // 2:] = 0.9
        kept = m.edge_aware_smooth(field, guide)
        # 右半为 0.8、左半为 0，边界两侧必须仍保有阶跃
        kept_diff = float(kept[h // 2, w // 2 + 1] - kept[h // 2, w // 2 - 1])
        self.assertGreater(kept_diff, 0.5)
        # 对照：guide 恒定（无边缘），同一边界被明显抹平
        plain = m.edge_aware_smooth(field, np.full((h, w), 0.5, dtype=np.float32))
        plain_diff = float(plain[h // 2, w // 2 + 1] - plain[h // 2, w // 2 - 1])
        self.assertGreater(plain_diff, 0.0)
        self.assertLess(plain_diff, kept_diff * 0.6)

    def test_deterministic(self):
        rng = np.random.default_rng(11)
        luma = rng.random((24, 24), dtype=np.float32)
        self.assertTrue(np.array_equal(m.estimate_depth(luma), m.estimate_depth(luma)))


class TileFacesTest(unittest.TestCase):
    """tile_faces：后表面与四条侧墙的绕序决定外法线方向（GLB 背面也必须是实体）。"""

    def _coords(self, n=3):
        front = {(x, y): y * n + x for y in range(n) for x in range(n)}
        back = {(x, y): n * n + y * n + x for y in range(n) for x in range(n)}
        coords = {}
        for (x, y), idx in front.items():
            coords[idx] = (float(x), float(y), 1.0)  # 前表面 z=1
        for (x, y), idx in back.items():
            coords[idx] = (float(x), float(y), 0.0)  # 后表面 z=0（整体后移）
        return front, back, coords

    def test_single_surface_faces_when_back_is_none(self):
        # 3x3 顶点（闭区间 0..2）-> 2x2 quad，与历史单面行为一致，且不加任何侧墙
        front, _, coords = self._coords()
        faces = m.tile_faces(front, None, 0, 2, 0, 2, False, False, False, False)
        self.assertEqual(len(faces), 4)
        for f in faces:
            nx, ny, nz = _face_normal(coords, f)
            self.assertGreater(nz, 0)  # 朝上

    def test_solid_faces_normals_point_outward(self):
        front, back, coords = self._coords()
        faces = m.tile_faces(front, back, 0, 2, 0, 2, True, True, True, True)
        # 前 4 + 后 4 + 侧墙（底 2 + 顶 2 + 左 2 + 右 2）= 16
        self.assertEqual(len(faces), 16)
        for f in faces:
            nx, ny, nz = _face_normal(coords, f)
            xs = {coords[i][0] for i in f}
            ys = {coords[i][1] for i in f}
            zs = {coords[i][2] for i in f}
            if len(zs) == 1:
                # 前后表面
                if zs == {1.0}:
                    self.assertGreater(nz, 0)
                else:
                    self.assertLess(nz, 0)
                continue
            if ys == {0.0}:
                self.assertLess(ny, 0)  # 底边法线 -y
            elif ys == {2.0}:
                self.assertGreater(ny, 0)  # 顶边法线 +y
            elif xs == {0.0}:
                self.assertLess(nx, 0)  # 左边法线 -x
            elif xs == {2.0}:
                self.assertGreater(nx, 0)  # 右边法线 +x
            else:
                self.fail(f"无法分类的侧墙面: {f}")

    def test_interior_seam_has_no_walls(self):
        # 内部接缝的块（非首尾行/列）不加侧墙：接缝处两块表面相邻，不留沟壕
        front, back, coords = self._coords()
        faces = m.tile_faces(front, back, 0, 2, 0, 2, False, False, False, False)
        self.assertEqual(len(faces), 8)  # 仅前 4 + 后 4
        for f in faces:
            zs = {coords[i][2] for i in f}
            self.assertEqual(len(zs), 1)  # 没有跨厚度的墙面


if __name__ == "__main__":
    unittest.main()
