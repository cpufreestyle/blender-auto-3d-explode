#!/usr/bin/env python3
"""
Blender GLB 自动拆解脚本 (兼容 Blender 4.x / 5.x)

用法:
  blender --background --python blender_split_glb.py -- --input input.glb --output output.glb --manifest manifest.json
"""

import bpy
import bmesh
import json
import sys
import os
import traceback
from mathutils import Vector

# 确保输出立即刷新（Blender 后台模式有时会缓冲）
def log(msg):
    print(msg, flush=True)
    sys.stdout.flush()


def get_blender_version():
    """获取 Blender 主版本号"""
    try:
        return bpy.app.version[0]  # e.g. 4 or 5
    except:
        return 4


def import_model(filepath):
    """导入 3D 模型文件 — 支持 GLB/GLTF/STL，兼容多版本"""
    ext = os.path.splitext(filepath)[1].lower()
    log(f"  导入文件: {filepath} (格式: {ext})")

    if ext in ('.glb', '.gltf'):
        # ── glTF 导入 ──
        # 方法 1: Blender 4.1+ / 5.x 新 API
        try:
            if hasattr(bpy.ops.wm, 'gltf_import'):
                log("  使用 bpy.ops.wm.gltf_import")
                bpy.ops.wm.gltf_import(filepath=filepath)
                return
        except Exception as e:
            log(f"  wm.gltf_import 失败: {e}")

        # 方法 2: Blender 4.0 及以下旧 API
        try:
            if hasattr(bpy.ops.import_scene, 'gltf'):
                log("  使用 bpy.ops.import_scene.gltf")
                try:
                    bpy.ops.import_scene.gltf(filepath=filepath, import_shading='NORMAL')
                except TypeError:
                    bpy.ops.import_scene.gltf(filepath=filepath)
                return
        except Exception as e:
            log(f"  import_scene.gltf 失败: {e}")

        raise RuntimeError(f"无法导入 {filepath}，当前 Blender 版本不支持 glTF 导入")

    elif ext == '.stl':
        # ── STL 导入 ──
        # 方法 1: Blender 4.1+ / 5.x 新 API
        try:
            if hasattr(bpy.ops.wm, 'stl_import'):
                log("  使用 bpy.ops.wm.stl_import")
                bpy.ops.wm.stl_import(filepath=filepath)
                return
        except Exception as e:
            log(f"  wm.stl_import 失败: {e}")

        # 方法 2: Blender 3.x / 4.0 旧 API
        try:
            if hasattr(bpy.ops.import_mesh, 'stl'):
                log("  使用 bpy.ops.import_mesh.stl")
                bpy.ops.import_mesh.stl(filepath=filepath)
                return
        except Exception as e:
            log(f"  import_mesh.stl 失败: {e}")

        # 方法 3: 尝试 wm.append
        try:
            if hasattr(bpy.ops.import_scene, 'stl'):
                log("  使用 bpy.ops.import_scene.stl")
                bpy.ops.import_scene.stl(filepath=filepath)
                return
        except Exception as e:
            log(f"  import_scene.stl 失败: {e}")

        raise RuntimeError(f"无法导入 {filepath}，当前 Blender 版本不支持 STL 导入")

    else:
        raise ValueError(f"不支持的文件格式: {ext}（支持 .glb / .gltf / .stl）")


def export_glb(filepath):
    """导出 GLB — 兼容多版本"""
    log(f"  导出文件: {filepath}")

    # 方法 1: Blender 4.1+ / 5.x 新 API
    try:
        if hasattr(bpy.ops.wm, 'gltf_export'):
            log("  使用 bpy.ops.wm.gltf_export")
            bpy.ops.wm.gltf_export(filepath=filepath, export_format='GLB')
            return
    except Exception as e:
        log(f"  wm.gltf_export 失败: {e}")

    # 方法 2: Blender 4.0 及以下旧 API
    try:
        if hasattr(bpy.ops.export_scene, 'gltf'):
            log("  使用 bpy.ops.export_scene.gltf")
            try:
                bpy.ops.export_scene.gltf(
                    filepath=filepath,
                    export_format='GLB',
                    export_apply=True,
                    use_selection=False,
                )
            except TypeError:
                bpy.ops.export_scene.gltf(filepath=filepath, export_format='GLB')
            return
    except Exception as e:
        log(f"  export_scene.gltf 失败: {e}")

    raise RuntimeError(f"无法导出到 {filepath}，当前 Blender 版本不支持 glTF 导出")


def clear_scene():
    """清空场景"""
    log("  清空场景...")
    # 删除所有物体
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)

    # 清理孤立数据
    for block in list(bpy.data.meshes):
        if block.users == 0:
            bpy.data.meshes.remove(block)
    for block in list(bpy.data.materials):
        if block.users == 0:
            bpy.data.materials.remove(block)
    for block in list(bpy.data.images):
        if block.users == 0:
            bpy.data.images.remove(block)
    for block in list(bpy.data.cameras):
        if block.users == 0:
            bpy.data.cameras.remove(block)
    for block in list(bpy.data.lights):
        if block.users == 0:
            bpy.data.lights.remove(block)
    log("  场景已清空")


def apply_all_transforms():
    """对所有物体应用变换"""
    meshes = get_mesh_objects()
    if not meshes:
        return
    bpy.ops.object.select_all(action='DESELECT')
    for obj in meshes:
        obj.select_set(True)
    if meshes:
        bpy.context.view_layer.objects.active = meshes[0]
    try:
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        log("  变换已应用")
    except Exception as e:
        log(f"  变换应用失败: {e}")


def get_mesh_objects():
    """获取场景中所有网格物体"""
    return [obj for obj in bpy.data.objects if obj.type == 'MESH']


def separate_by_loose_parts():
    """按断开的几何体分离"""
    meshes = list(get_mesh_objects())
    new_count = 0
    for obj in meshes:
        if obj.name not in bpy.data.objects:
            continue
        bpy.ops.object.select_all(action='DESELECT')
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        before = len(get_mesh_objects())
        try:
            bpy.ops.mesh.separate(type='LOOSE')
        except Exception as e:
            log(f"  LOOSE 分离失败 ({obj.name}): {e}")
        after = len(get_mesh_objects())
        new_count += (after - before)
    log(f"  Loose parts 分离: 新增 {new_count} 个部件")
    return new_count


def separate_by_material():
    """按材质分离"""
    meshes = list(get_mesh_objects())
    new_count = 0
    for obj in meshes:
        if obj.name not in bpy.data.objects:
            continue
        if not obj.data.materials or len(obj.data.materials) <= 1:
            continue
        bpy.ops.object.select_all(action='DESELECT')
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        before = len(get_mesh_objects())
        try:
            bpy.ops.mesh.separate(type='MATERIAL')
        except Exception as e:
            log(f"  MATERIAL 分离失败 ({obj.name}): {e}")
        after = len(get_mesh_objects())
        new_count += (after - before)
    log(f"  Material 分离: 新增 {new_count} 个部件")
    return new_count


def separate_by_edges():
    """按边界边分离"""
    meshes = list(get_mesh_objects())
    new_count = 0
    for obj in list(meshes):
        if obj.name not in bpy.data.objects:
            continue
        bpy.ops.object.select_all(action='DESELECT')
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        try:
            bpy.ops.object.mode_set(mode='EDIT')
            bm = bmesh.from_edit_mesh(obj.data)
            for edge in bm.edges:
                edge.select = len(edge.link_faces) == 1
            bmesh.update_edit_mesh(obj.data)
            bpy.ops.object.mode_set(mode='OBJECT')
        except Exception as e:
            log(f"  进入编辑模式失败 ({obj.name}): {e}")
            continue

        before = len(get_mesh_objects())
        try:
            bpy.ops.mesh.separate(type='SELECTED')
        except Exception as e:
            log(f"  EDGE 分离失败 ({obj.name}): {e}")
        after = len(get_mesh_objects())
        new_count += (after - before)
    log(f"  Edge 分离: 新增 {new_count} 个部件")
    return new_count


def cleanup_small_parts(min_faces=50):
    """删除面数过少的部件"""
    removed = 0
    for obj in list(get_mesh_objects()):
        if len(obj.data.polygons) < min_faces:
            bpy.data.objects.remove(obj, do_unlink=True)
            removed += 1
    if removed > 0:
        log(f"  清理微小部件: 移除 {removed} 个 (< {min_faces} 面)")
    return removed


def merge_small_parts(min_faces=50):
    """合并面数过少的部件到最近的大部件"""
    meshes = get_mesh_objects()
    small = [o for o in meshes if len(o.data.polygons) < min_faces]
    large = [o for o in meshes if len(o.data.polygons) >= min_faces]
    if not small or not large:
        return 0

    merged = 0
    for s_obj in small:
        # 找最近的大部件
        s_center = s_obj.matrix_world.translation
        best_dist = float('inf')
        best_obj = None
        for l_obj in large:
            l_center = l_obj.matrix_world.translation
            dist = (s_center - l_center).length
            if dist < best_dist:
                best_dist = dist
                best_obj = l_obj
        if best_obj:
            # 合并小部件到大部件
            bpy.ops.object.select_all(action='DESELECT')
            s_obj.select_set(True)
            best_obj.select_set(True)
            bpy.context.view_layer.objects.active = best_obj
            try:
                bpy.ops.object.join()
                merged += 1
            except Exception as e:
                log(f"  合并失败 ({s_obj.name} -> {best_obj.name}): {e}")
    if merged > 0:
        log(f"  合并微小部件: {merged} 个已合并到大部件")
    return merged


# Quest 3 原始 15 部位名称及归一化位置模板
# 从共享配置文件 quest3_config.json 加载，确保 Python 和 JS 使用相同坐标
# 坐标系: X=左右 Y=上下 Z=前后, 归一化到 [-1, 1]
# 模型包围盒: X[-1.25,1.25] Y[-0.575,1.6] Z[-0.64,0.72]
# 中心=(0, 0.5125, 0.04) 半幅=(1.25, 1.0875, 0.68)

def _load_quest3_config():
    """从 quest3_config.json 加载共享配置，回退到内置默认值"""
    # 尝试从脚本同目录加载配置文件
    config_paths = [
        os.path.join(os.path.dirname(os.path.abspath(__file__)), 'quest3_config.json'),
        os.path.join(os.getcwd(), 'quest3_config.json'),
    ]
    for cfg_path in config_paths:
        try:
            with open(cfg_path, 'r', encoding='utf-8') as f:
                cfg = json.load(f)
            templates = cfg.get('parts', [])
            if templates:
                log(f"  加载 Quest 3 配置: {cfg_path} ({len(templates)} 个部位)")
                return templates
        except Exception as e:
            log(f"  配置文件加载失败 ({cfg_path}): {e}")

    # 回退到内置默认值（与 quest3_config.json 同步）
    log("  使用内置 Quest 3 配置（回退）")
    return [
        {'name': '主机身',           'pos': [ 0.00, -0.47, -0.06]},
        {'name': '前面板',           'pos': [ 0.00, -0.47,  0.75]},
        {'name': '面罩海绵',         'pos': [ 0.00, -0.47, -0.87]},
        {'name': '左透镜模组',       'pos': [-0.42, -0.43, -0.24]},
        {'name': '右透镜模组',       'pos': [ 0.42, -0.43, -0.24]},
        {'name': '左透镜',           'pos': [-0.42, -0.43, -0.56]},
        {'name': '右透镜',           'pos': [ 0.42, -0.43, -0.56]},
        {'name': '主板',             'pos': [ 0.00, -0.43, -0.13]},
        {'name': '左摄像头',         'pos': [-0.60, -0.31,  0.94]},
        {'name': '右摄像头',         'pos': [ 0.60, -0.31,  0.94]},
        {'name': '中置摄像头',       'pos': [ 0.00, -0.21,  0.94]},
        {'name': '下置追踪摄像头',   'pos': [ 0.00, -0.79,  0.82]},
        {'name': '左头带臂',         'pos': [-1.00, -0.47, -0.06]},
        {'name': '右头带臂',         'pos': [ 1.00, -0.47, -0.06]},
        {'name': '头带',             'pos': [ 0.00,  0.45, -0.59]},
    ]

QUEST3_PART_TEMPLATES = _load_quest3_config()


def assign_quest3_names(parts_info, model_center, model_size):
    """根据部件空间位置，将检测到的部件匹配到 Quest 3 原始 15 部位名称
    使用贪心最近邻匹配算法"""
    if not parts_info:
        return []

    half_x = max(model_size[0] / 2, 0.001)
    half_y = max(model_size[1] / 2, 0.001)
    half_z = max(model_size[2] / 2, 0.001)

    # 将每个部件的中心位置归一化到 [-1, 1]
    normalized = []
    for p in parts_info:
        pc = p['center']
        nx = (pc[0] - model_center[0]) / half_x
        ny = (pc[1] - model_center[1]) / half_y
        nz = (pc[2] - model_center[2]) / half_z
        normalized.append((nx, ny, nz))

    # 计算所有 部件-模板 对的加权距离
    pairs = []
    for t, tpl in enumerate(QUEST3_PART_TEMPLATES):
        for p_idx in range(len(parts_info)):
            nx, ny, nz = normalized[p_idx]
            dx = nx - tpl['pos'][0]
            dy = ny - tpl['pos'][1]
            dz = nz - tpl['pos'][2]
            # 加权距离：X、Z 权重 1.0，Y 权重 0.7
            dist = (dx * dx + dy * dy * 0.7 + dz * dz) ** 0.5
            pairs.append((dist, t, p_idx))

    # 按距离升序排列，贪心匹配
    pairs.sort()
    used_parts = set()
    used_templates = set()
    assignments = [None] * len(parts_info)

    for dist, t, p_idx in pairs:
        if p_idx in used_parts or t in used_templates:
            continue
        used_parts.add(p_idx)
        used_templates.add(t)
        assignments[p_idx] = QUEST3_PART_TEMPLATES[t]['name']

    # 未匹配到 Quest 3 模板的部件使用通用名称
    extra = 1
    for i in range(len(assignments)):
        if assignments[i] is None:
            assignments[i] = f"附加部件{extra}"
            extra += 1

    return assignments


def is_quest3_model(filepath):
    """检查文件名是否包含 Quest 3（不区分大小写）"""
    basename = os.path.basename(filepath).lower()
    return 'quest 3' in basename or 'quest3' in basename


def merge_to_quest3_parts(model_center, model_size):
    """将所有 mesh 按 Quest 3 原始 15 部位模板聚类合并
    把距离同一模板最近的部件 join 在一起，最终得到 <=15 个部件"""
    meshes = get_mesh_objects()
    if len(meshes) <= 1:
        return

    half_x = max(model_size[0] / 2, 0.001)
    half_y = max(model_size[1] / 2, 0.001)
    half_z = max(model_size[2] / 2, 0.001)

    # 为每个 mesh 找最近的 Quest 3 模板
    groups = {}  # template_idx -> [mesh_objects]
    for obj in meshes:
        # 计算部件中心
        verts = [obj.matrix_world @ v.co for v in obj.data.vertices]
        if not verts:
            continue
        cx = sum(v.x for v in verts) / len(verts)
        cy = sum(v.y for v in verts) / len(verts)
        cz = sum(v.z for v in verts) / len(verts)

        # 归一化到 [-1, 1]
        nx = (cx - model_center[0]) / half_x
        ny = (cy - model_center[1]) / half_y
        nz = (cz - model_center[2]) / half_z

        # 找最近的 Quest 3 模板
        best_t = 0
        best_dist = float('inf')
        for t, tpl in enumerate(QUEST3_PART_TEMPLATES):
            dx = nx - tpl['pos'][0]
            dy = ny - tpl['pos'][1]
            dz = nz - tpl['pos'][2]
            dist = (dx * dx + dy * dy * 0.7 + dz * dz) ** 0.5
            if dist < best_dist:
                best_dist = dist
                best_t = t

        if best_t not in groups:
            groups[best_t] = []
        groups[best_t].append(obj)

    log(f"  Quest 3 聚类: {len(meshes)} 个部件 -> {len(groups)} 组")

    # 对每组进行 join
    for t, objs in groups.items():
        if len(objs) <= 1:
            if len(objs) == 1:
                objs[0].name = QUEST3_PART_TEMPLATES[t]['name']
            continue

        bpy.ops.object.select_all(action='DESELECT')
        for obj in objs:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        try:
            bpy.ops.object.join()
            objs[0].name = QUEST3_PART_TEMPLATES[t]['name']
            log(f"    合并组 {t+1}: {len(objs)} 个 -> {QUEST3_PART_TEMPLATES[t]['name']}")
        except Exception as e:
            log(f"    合并失败 (组 {t+1}): {e}")


def _fill_missing_quest3_parts(model_center, half_x, half_y, half_z):
    """保底补充：如果不足 15 个部位，为缺失的模板生成占位网格。

    改进：不再从已有部件中撕面（会导致几何破损和空洞），
    而是在模板位置创建一个小的半透明占位立方体，标注"该区域未检测到独立部件"。
    这样保持已有几何体的完整性，同时满足 15 部位的数量要求。
    """
    # 找出哪些模板还没有对应的 mesh
    existing_names = {obj.name for obj in get_mesh_objects()}
    missing_templates = []
    for t, tpl in enumerate(QUEST3_PART_TEMPLATES):
        if tpl['name'] not in existing_names:
            missing_templates.append(t)

    if not missing_templates:
        return

    log(f"  保底补充: 缺失 {len(missing_templates)} 个部位，生成占位网格: {[QUEST3_PART_TEMPLATES[t]['name'] for t in missing_templates]}")

    # 为每个缺失模板创建占位立方体
    for t in missing_templates:
        tpl = QUEST3_PART_TEMPLATES[t]
        name = tpl['name']
        nx, ny, nz = tpl['pos']

        # 将归一化坐标转换回世界坐标
        world_x = nx * half_x + model_center[0]
        world_y = ny * half_y + model_center[1]
        world_z = nz * half_z + model_center[2]

        # 创建一个小立方体作为占位
        placeholder_size = min(half_x, half_y, half_z) * 0.08
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=placeholder_size)
        bmesh.ops.translate(bm, vec=(world_x, world_y, world_z), verts=bm.verts)
        bm.normal_update()

        # 创建网格
        placeholder_mesh = bpy.data.meshes.new(name)
        bm.to_mesh(placeholder_mesh)
        bm.free()

        # 创建半透明材质（标注为占位）
        mat_name = f"{name}_placeholder"
        mat = bpy.data.materials.get(mat_name)
        if mat is None:
            mat = bpy.data.materials.new(name=mat_name)
            mat.use_nodes = True
            bsdf = mat.node_tree.nodes.get('Principled BSDF')
            if bsdf:
                bsdf.inputs['Base Color'].default_value = (0.5, 0.7, 1.0, 1.0)
                bsdf.inputs['Alpha'].default_value = 0.3
                # 标记为透明星号
                if 'Transmission' in bsdf.inputs:
                    bsdf.inputs['Transmission'].default_value = 0.8
            mat.blend_method = 'BLEND'

        placeholder_mesh.materials.append(mat)

        # 创建物体
        placeholder_obj = bpy.data.objects.new(name, placeholder_mesh)
        bpy.context.collection.objects.link(placeholder_obj)

        log(f"    {name}: 生成占位网格 @ ({world_x:.3f}, {world_y:.3f}, {world_z:.3f})")


def _normalize_coord(cx, cy, cz, model_center, half_x, half_y, half_z):
    """将世界坐标归一化到 [-1, 1]"""
    nx = (cx - model_center[0]) / half_x
    ny = (cy - model_center[1]) / half_y
    nz = (cz - model_center[2]) / half_z
    return nx, ny, nz


def _weighted_dist(nx, ny, nz, tpl_pos):
    """计算加权距离（Y 权重 0.7）"""
    dx = nx - tpl_pos[0]
    dy = ny - tpl_pos[1]
    dz = nz - tpl_pos[2]
    return (dx * dx + dy * dy * 0.7 + dz * dz) ** 0.5


def _find_nearest_template(nx, ny, nz):
    """找到归一化坐标最近的 Quest 3 模板索引"""
    best_t = 0
    best_dist = float('inf')
    for t, tpl in enumerate(QUEST3_PART_TEMPLATES):
        dist = _weighted_dist(nx, ny, nz, tpl['pos'])
        if dist < best_dist:
            best_dist = dist
            best_t = t
    return best_t, best_dist


def _cleanup_mesh(bm):
    """Mesh cleanup: weld close vertices, fill holes"""
    try:
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0001)
    except Exception:
        pass
    try:
        bmesh.ops.holes_fill(bm, edges=bm.edges, sides=64)
    except Exception:
        pass
    try:
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    except Exception:
        pass


def _create_part_from_faces(bm_orig, face_indices, name, material_slots, has_uv, uv_orig):
    """从原始 bmesh 中提取指定面，创建新网格物体"""
    bm_new = bmesh.new()
    uv_new = bm_new.loops.layers.uv.new() if has_uv else None
    vert_map = {}
    for fi in face_indices:
        if fi >= len(bm_orig.faces):
            continue
        orig_face = bm_orig.faces[fi]
        new_verts = []
        for v in orig_face.verts:
            if v.index not in vert_map:
                new_v = bm_new.verts.new(v.co)
                vert_map[v.index] = new_v
            new_verts.append(vert_map[v.index])
        try:
            new_face = bm_new.faces.new(new_verts)
            if has_uv and uv_orig and uv_new:
                for i, loop in enumerate(new_face.loops):
                    if i < len(orig_face.loops):
                        loop[uv_new].uv = orig_face.loops[i][uv_orig].uv
        except Exception:
            pass
    _cleanup_mesh(bm_new)
    bm_new.normal_update()
    new_mesh = bpy.data.meshes.new(name)
    bm_new.to_mesh(new_mesh)
    bm_new.free()
    for mat in material_slots:
        if mat:
            new_mesh.materials.append(mat)
    new_obj = bpy.data.objects.new(name, new_mesh)
    bpy.context.collection.objects.link(new_obj)
    return new_obj


def split_quest3_hybrid(model_center, model_size):
    """混合策略拆分 Quest 3 模型，保证 15 个部位。

    流程：
      1. 自然分离（材质 + 断开几何体）→ 获取真实部件边界
      2. 每个自然部件 → 分配到最近的 Quest 3 模板 → 同模板合并
      3. 对缺失的模板，从最近的已有部件中借取面来补充
      4. 网格清理
    """
    meshes = get_mesh_objects()
    if not meshes:
        return

    half_x = max(model_size[0] / 2, 0.001)
    half_y = max(model_size[1] / 2, 0.001)
    half_z = max(model_size[2] / 2, 0.001)

    # ── Step 1: 自然分离 ──
    log("  Step 1: 自然分离（材质 + 断开几何体）...")
    separate_by_material()
    separate_by_loose_parts()
    cleanup_small_parts(min_faces=10)
    natural_parts = get_mesh_objects()
    log(f"  自然分离结果: {len(natural_parts)} 个部件")

    if len(natural_parts) == 0:
        return

    # ── Step 2: 将每个自然部件分配到最近的 Quest 3 模板并合并 ──
    log("  Step 2: 分配自然部件到 Quest 3 模板...")
    groups = {}  # template_idx -> [mesh_objects]
    for obj in natural_parts:
        verts = [obj.matrix_world @ v.co for v in obj.data.vertices]
        if not verts:
            continue
        cx = sum(v.x for v in verts) / len(verts)
        cy = sum(v.y for v in verts) / len(verts)
        cz = sum(v.z for v in verts) / len(verts)
        nx, ny, nz = _normalize_coord(cx, cy, cz, model_center, half_x, half_y, half_z)
        best_t, best_dist = _find_nearest_template(nx, ny, nz)
        if best_t not in groups:
            groups[best_t] = []
        groups[best_t].append(obj)
        log(f"    {obj.name} -> {QUEST3_PART_TEMPLATES[best_t]['name']} (dist={best_dist:.3f})")

    log("  Step 3: 合并同模板部件...")
    for t, objs in groups.items():
        if len(objs) <= 1:
            if len(objs) == 1:
                objs[0].name = QUEST3_PART_TEMPLATES[t]['name']
            continue
        bpy.ops.object.select_all(action='DESELECT')
        for obj in objs:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        try:
            bpy.ops.object.join()
            objs[0].name = QUEST3_PART_TEMPLATES[t]['name']
            log(f"    合并 {len(objs)} 个 -> {QUEST3_PART_TEMPLATES[t]['name']}")
        except Exception as e:
            log(f"    合并失败 ({QUEST3_PART_TEMPLATES[t]['name']}): {e}")

    filled_count = len(get_mesh_objects())
    log(f"  合并后: {filled_count} 个部件")

    # ── Step 3: 补充缺失部位 ──
    # 对缺失的模板，从最近的已有部件中借取面
    if filled_count < 15:
        log(f"  Step 3: 补充缺失部位（当前 {filled_count}, 需要补 {15 - filled_count}）...")
        _fill_missing_quest3_parts(model_center, half_x, half_y, half_z)

    # ── Step 4: 网格清理 ──
    log("  Step 4: 网格清理...")
    for obj in get_mesh_objects():
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        _cleanup_mesh(bm)
        bm.normal_update()
        bm.to_mesh(obj.data)
        bm.free()
        obj.data.update()

    result_count = len(get_mesh_objects())
    log(f"  混合拆分完成: {result_count} 个部件")

    # ── 最终保底：如果仍不足 15 个，再补一次 ──
    if result_count < 15:
        log(f"  仍不足 15 个，再补一次...")
        _fill_missing_quest3_parts(model_center, half_x, half_y, half_z)
        result_count = len(get_mesh_objects())
        log(f"  补充后: {result_count} 个部件")


def compute_manifest(is_quest3=False):
    """计算每个部件的元数据"""
    meshes = get_mesh_objects()
    manifest = {"parts": []}

    # 计算整体包围盒中心
    all_coords = []
    for obj in meshes:
        for v in obj.data.vertices:
            all_coords.append(obj.matrix_world @ v.co)

    if not all_coords:
        return manifest

    min_x = min(c.x for c in all_coords)
    max_x = max(c.x for c in all_coords)
    min_y = min(c.y for c in all_coords)
    max_y = max(c.y for c in all_coords)
    min_z = min(c.z for c in all_coords)
    max_z = max(c.z for c in all_coords)
    center = Vector((
        (min_x + max_x) / 2,
        (min_y + max_y) / 2,
        (min_z + max_z) / 2,
    ))

    model_size = [max_x - min_x, max_y - min_y, max_z - min_z]

    parts_info = []
    for obj in meshes:
        obj_coords = [obj.matrix_world @ v.co for v in obj.data.vertices]
        if not obj_coords:
            continue
        o_min_x = min(c.x for c in obj_coords)
        o_max_x = max(c.x for c in obj_coords)
        o_min_y = min(c.y for c in obj_coords)
        o_max_y = max(c.y for c in obj_coords)
        o_min_z = min(c.z for c in obj_coords)
        o_max_z = max(c.z for c in obj_coords)
        part_center = Vector((
            (o_min_x + o_max_x) / 2,
            (o_min_y + o_max_y) / 2,
            (o_min_z + o_max_z) / 2,
        ))
        dist = (part_center - center).length

        rel = part_center - center
        abs_x, abs_y, abs_z = abs(rel.x), abs(rel.y), abs(rel.z)
        max_abs = max(abs_x, abs_y, abs_z)
        if max_abs < 0.01:
            direction = "中心"
        elif abs_x == max_abs:
            direction = "右侧" if rel.x > 0 else "左侧"
        elif abs_y == max_abs:
            direction = "顶部" if rel.y > 0 else "底部"
        else:
            direction = "前方" if rel.z > 0 else "后方"

        parts_info.append({
            "name": obj.name,
            "direction": direction,
            "center": [round(part_center.x, 6), round(part_center.y, 6), round(part_center.z, 6)],
            "bbox_min": [o_min_x, o_min_y, o_min_z],
            "bbox_max": [o_max_x, o_max_y, o_max_z],
            "size": [o_max_x - o_min_x, o_max_y - o_min_y, o_max_z - o_min_z],
            "distance_from_center": round(dist, 6),
            "face_count": len(obj.data.polygons),
            "vertex_count": len(obj.data.vertices),
        })

    # 按距离中心降序排列（外层先拆）
    parts_info.sort(key=lambda p: p["distance_from_center"], reverse=True)

    # 命名：Quest 3 模型使用 Quest 3 名称；其他模型使用通用编号+方向
    if is_quest3:
        model_center_list = [center.x, center.y, center.z]
        quest3_names = assign_quest3_names(parts_info, model_center_list, model_size)
        for i, p in enumerate(parts_info):
            p["name"] = f"Part_{i+1:03d}"
            p["display_name"] = quest3_names[i]
            log(f"  部件 {i+1}: {quest3_names[i]} (中心: {p['center']}, 距离: {p['distance_from_center']})")
    else:
        for i, p in enumerate(parts_info):
            p["name"] = f"Part_{i+1:03d}"
            p["display_name"] = f"部件{i+1}·{p['direction']}"
            log(f"  部件 {i+1}: {p['display_name']} (中心: {p['center']}, 距离: {p['distance_from_center']})")

    manifest["parts"] = parts_info
    manifest["total_parts"] = len(parts_info)
    manifest["model_center"] = [round(center.x, 6), round(center.y, 6), round(center.z, 6)]
    manifest["model_size"] = model_size

    return manifest


def parse_args():
    """解析命令行参数 — 兼容 Blender -- 分隔符"""
    # Blender 把 -- 之后的参数传给脚本
    if '--' in sys.argv:
        script_args = sys.argv[sys.argv.index('--') + 1:]
    else:
        # 没有 -- 的情况下，尝试从 -P/--python 之后解析
        script_args = sys.argv[1:]

    input_path = None
    output_path = None
    manifest_path = None
    original_filename = None

    i = 0
    while i < len(script_args):
        arg = script_args[i]
        if arg == '--input' and i + 1 < len(script_args):
            input_path = script_args[i + 1]
            i += 2
        elif arg == '--output' and i + 1 < len(script_args):
            output_path = script_args[i + 1]
            i += 2
        elif arg == '--manifest' and i + 1 < len(script_args):
            manifest_path = script_args[i + 1]
            i += 2
        elif arg == '--original-filename' and i + 1 < len(script_args):
            original_filename = script_args[i + 1]
            i += 2
        else:
            i += 1

    if not input_path:
        raise ValueError(f"缺少 --input 参数。sys.argv={sys.argv}")
    if not output_path:
        raise ValueError(f"缺少 --output 参数")
    if not manifest_path:
        raise ValueError(f"缺少 --manifest 参数")

    return input_path, output_path, manifest_path, original_filename


def main():
    log("=" * 60)
    log("🔧 Blender GLB 自动拆解")
    log(f"   Blender 版本: {bpy.app.version_string}")
    log(f"   Python 版本: {sys.version.split()[0]}")
    log("=" * 60)

    try:
        input_path, output_path, manifest_path, original_filename = parse_args()
        log(f"  输入: {input_path}")
        log(f"  输出: {output_path}")
        log(f"  清单: {manifest_path}")
        log(f"  原始文件名: {original_filename or '(未提供)'}")

        # 检查输入文件是否存在
        if not os.path.exists(input_path):
            raise FileNotFoundError(f"输入文件不存在: {input_path}")
        log(f"  输入文件大小: {os.path.getsize(input_path)} bytes")

        # 1. 清空场景
        log("\n1️⃣ 清空场景...")
        clear_scene()

        # 2. 导入模型
        log("\n2️⃣ 导入模型...")
        import_model(input_path)
        initial_count = len(get_mesh_objects())
        log(f"  初始 mesh 数量: {initial_count}")

        if initial_count == 0:
            raise RuntimeError("导入后没有找到任何网格物体")

        # 3. 应用变换
        log("\n3️⃣ 应用变换...")
        apply_all_transforms()

        # 4. 尝试分离策略
        log("\n4️⃣ 开始拆解...")

        # 策略 1: 先按材质分离（对大模型更高效）
        log("  策略 1: Separate by Material")
        separate_by_material()
        count = len(get_mesh_objects())
        log(f"  当前部件数: {count}")

        # 策略 2: 如果材质分离后部件少，再尝试 Loose Parts
        if count < 5:
            log("  策略 2: Separate by Loose Parts")
            separate_by_loose_parts()
            count = len(get_mesh_objects())
            log(f"  当前部件数: {count}")

        # 策略 3: 如果部件仍太少，按边界边分离
        if count < 3:
            log("  策略 3: Separate by Edges")
            separate_by_edges()
            count = len(get_mesh_objects())
            log(f"  当前部件数: {count}")

        # 5. 合并微小部件到大部件，再清理过小的
        log("\n5️⃣ 合并/清理微小部件...")
        merge_small_parts(min_faces=50)
        cleanup_small_parts(min_faces=50)
        final_count = len(get_mesh_objects())
        log(f"  最终部件数: {final_count}")

        if final_count == 0:
            raise RuntimeError("拆解后没有任何部件！")

        # 6. Quest 3 模型：按 15 部位聚类合并
        # 优先使用原始文件名检测 Quest 3，回退到输入文件路径
        detect_name = original_filename or input_path
        is_q3 = is_quest3_model(detect_name)
        if is_q3:
            log("\n6️⃣ Quest 3 model detected, hybrid splitting to 15 regions...")
            # Compute model center and size
            all_coords = []
            for obj in get_mesh_objects():
                for v in obj.data.vertices:
                    all_coords.append(obj.matrix_world @ v.co)
            if all_coords:
                mc = [
                    (min(c.x for c in all_coords) + max(c.x for c in all_coords)) / 2,
                    (min(c.y for c in all_coords) + max(c.y for c in all_coords)) / 2,
                    (min(c.z for c in all_coords) + max(c.z for c in all_coords)) / 2,
                ]
                ms = [
                    max(c.x for c in all_coords) - min(c.x for c in all_coords),
                    max(c.y for c in all_coords) - min(c.y for c in all_coords),
                    max(c.z for c in all_coords) - min(c.z for c in all_coords),
                ]
                split_quest3_hybrid(mc, ms)
                final_count = len(get_mesh_objects())
                log(f"  After hybrid split: {final_count} parts")
        else:
            log("\n6️⃣ 重命名部件...")
            meshes = get_mesh_objects()
            for i, obj in enumerate(meshes):
                obj.name = f"Part_{i+1:03d}"
            log(f"  已重命名 {len(meshes)} 个部件")

        # 7. 计算清单
        log("\n7️⃣ 计算部件元数据...")
        manifest = compute_manifest(is_quest3=is_q3)
        log(f"  总部件数: {manifest['total_parts']}")

        # 8. 导出 GLB
        log(f"\n8️⃣ 导出 GLB: {output_path}")
        export_glb(output_path)

        # 验证输出
        if os.path.exists(output_path):
            log(f"  GLB 导出成功: {os.path.getsize(output_path)} bytes")
        else:
            raise RuntimeError(f"GLB 导出后文件不存在: {output_path}")

        # 9. 导出清单
        log(f"\n9️⃣ 导出清单: {manifest_path}")
        with open(manifest_path, 'w', encoding='utf-8') as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)
        log(f"  清单导出成功")

        log("\n" + "=" * 60)
        log(f"✅ 拆解完成！{manifest['total_parts']} 个部件")
        log(f"   输出: {output_path}")
        log(f"   清单: {manifest_path}")
        log("=" * 60)

    except Exception as e:
        log(f"\n❌ 错误: {e}")
        log(f"\n详细堆栈:\n{traceback.format_exc()}")
        sys.exit(1)


if __name__ == '__main__':
    main()
