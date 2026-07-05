#!/usr/bin/env python3
"""
Blender HTTP API 服务器

提供 RESTful API 通过 HTTP 远程控制 Blender

功能：
- 创建/修改/删除物体
- 设置材质
- 控制相机和灯光
- 渲染输出
- 获取场景信息

使用方法：
blender --background --python blender_api_server.py -- --port 8000

然后通过 HTTP 请求控制：
curl http://localhost:8000/api/objects
curl -X POST http://localhost:8000/api/create -H "Content-Type: application/json" -d '{"type":"cube","name":"MyCube","location":[0,0,0]}'
"""

import bpy
import json
import argparse
from http.server import HTTPServer, BaseHTTPRequestHandler
from typing import Dict, Any
import traceback


class BlenderAPIHandler(BaseHTTPRequestHandler):
    """Blender HTTP API 请求处理器"""

    controller = None  # 将在服务器启动时设置

    def log_message(self, format, *args):
        """自定义日志格式"""
        print(f"[{self.log_date_time_string()}] {format % args}")

    def _set_headers(self, status=200):
        """设置响应头"""
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_OPTIONS(self):
        """处理 CORS 预检请求"""
        self._set_headers(200)

    def do_GET(self):
        """处理 GET 请求"""
        try:
            if self.path == '/':
                self._send_response({
                    "message": "Blender HTTP API Server",
                    "version": "1.0",
                    "endpoints": {
                        "GET /": "API 信息",
                        "GET /api/objects": "获取所有物体列表",
                        "GET /api/objects/<name>": "获取指定物体信息",
                        "GET /api/scene": "获取场景信息",
                        "POST /api/create": "创建物体",
                        "POST /api/material": "应用材质",
                        "POST /api/animation": "添加动画",
                        "DELETE /api/objects/<name>": "删除物体",
                        "GET /api/render": "渲染场景"
                    }
                })

            elif self.path == '/api/objects':
                objects = []
                for obj in bpy.data.objects:
                    objects.append({
                        "name": obj.name,
                        "type": obj.type,
                        "location": list(obj.location),
                        "rotation": list(obj.rotation_euler),
                        "scale": list(obj.scale),
                        "visible": obj.visible_get()
                    })
                self._send_response({"objects": objects, "count": len(objects)})

            elif self.path.startswith('/api/objects/'):
                obj_name = self.path.split('/')[-1]
                obj = bpy.data.objects.get(obj_name)
                if obj:
                    self._send_response({
                        "name": obj.name,
                        "type": obj.type,
                        "location": list(obj.location),
                        "rotation": list(obj.rotation_euler),
                        "scale": list(obj.scale),
                        "visible": obj.visible_get()
                    })
                else:
                    self._send_response({"error": f"Object '{obj_name}' not found"}, 404)

            elif self.path == '/api/scene':
                scene = bpy.context.scene
                self._send_response({
                    "name": scene.name,
                    "frame_current": scene.frame_current,
                    "frame_start": scene.frame_start,
                    "frame_end": scene.frame_end,
                    "objects_count": len(bpy.data.objects),
                    "materials_count": len(bpy.data.materials)
                })

            else:
                self._send_response({"error": "Endpoint not found"}, 404)

        except Exception as e:
            self._send_response({
                "error": str(e),
                "traceback": traceback.format_exc()
            }, 500)

    def do_POST(self):
        """处理 POST 请求"""
        try:
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length)
            data = json.loads(post_data.decode('utf-8'))

            if self.path == '/api/create':
                # 创建物体
                obj_type = data.get('type', 'cube')
                obj_name = data.get('name', f'Object_{len(bpy.data.objects)}')

                controller = self.controller

                if obj_type == 'cube':
                    obj = controller.create_cube(
                        name=obj_name,
                        size=data.get('size', 2.0),
                        location=tuple(data.get('location', [0, 0, 0])),
                        rotation=tuple(data.get('rotation', [0, 0, 0]))
                    )
                elif obj_type == 'sphere':
                    obj = controller.create_sphere(
                        name=obj_name,
                        radius=data.get('radius', 1.0),
                        location=tuple(data.get('location', [0, 0, 0])),
                        segments=data.get('segments', 32)
                    )
                elif obj_type == 'cylinder':
                    obj = controller.create_cylinder(
                        name=obj_name,
                        radius=data.get('radius', 1.0),
                        depth=data.get('depth', 2.0),
                        location=tuple(data.get('location', [0, 0, 0]))
                    )
                elif obj_type == 'plane':
                    obj = controller.create_plane(
                        name=obj_name,
                        size=data.get('size', 2.0),
                        location=tuple(data.get('location', [0, 0, 0])),
                        rotation=tuple(data.get('rotation', [0, 0, 0]))
                    )
                else:
                    self._send_response({"error": f"Unknown object type: {obj_type}"}, 400)
                    return

                self._send_response({
                    "message": f"Created {obj_type} '{obj_name}'",
                    "object": {
                        "name": obj.name,
                        "type": obj.type,
                        "location": list(obj.location)
                    }
                })

            elif self.path == '/api/material':
                # 应用材质
                obj_name = data.get('name')
                controller = self.controller
                controller.apply_material(
                    obj_name,
                    color=tuple(data.get('color', [0.8, 0.2, 0.2, 1.0])),
                    metallic=data.get('metallic', 0.0),
                    roughness=data.get('roughness', 0.5)
                )
                self._send_response({"message": f"Material applied to '{obj_name}'"})

            elif self.path == '/api/animation':
                # 添加动画
                obj_name = data.get('object')
                prop = data.get('property')
                start = tuple(data.get('start_value'))
                end = tuple(data.get('end_value'))
                start_frame = data.get('start_frame', 1)
                end_frame = data.get('end_frame', 100)

                controller = self.controller
                controller.add_animation(obj_name, prop, start, end, start_frame, end_frame)
                self._send_response({"message": f"Animation added to '{obj_name}.{prop}'"})

            elif self.path == '/api/clear':
                # 清空场景
                controller = self.controller
                controller.clear_scene()
                self._send_response({"message": "Scene cleared"})

            else:
                self._send_response({"error": "Endpoint not found"}, 404)

        except Exception as e:
            self._send_response({
                "error": str(e),
                "traceback": traceback.format_exc()
            }, 500)

    def _send_response(self, data: Dict[str, Any], status=200):
        """发送 JSON 响应"""
        self._set_headers(status)
        self.wfile.write(json.dumps(data, indent=2).encode('utf-8'))


class BlenderAPIServer:
    """Blender HTTP API 服务器"""

    def __init__(self, port: int = 8000):
        self.port = port
        self.server = None
        self.controller = None

    def start(self):
        """启动服务器"""
        # 初始化控制器
        self.controller = BlenderController()

        # 设置控制器到处理器
        BlenderAPIHandler.controller = self.controller

        # 启动 HTTP 服务器
        self.server = HTTPServer(('localhost', self.port), BlenderAPIHandler)
        print(f"\n🚀 Blender HTTP API 服务器启动")
        print(f"📍 地址: http://localhost:{self.port}")
        print(f"📚 API 文档: http://localhost:{self.port}/\n")
        print("等待请求...\n")

        try:
            self.server.serve_forever()
        except KeyboardInterrupt:
            print("\n\n⚠️  服务器停止")
            self.stop()

    def stop(self):
        """停止服务器"""
        if self.server:
            self.server.shutdown()
            print("✅ 服务器已停止")


def main():
    """主函数"""
    parser = argparse.ArgumentParser(description='Blender HTTP API 服务器')
    parser.add_argument('--port', type=int, default=8000, help='服务器端口（默认: 8000）')
    args = parser.parse_args()

    server = BlenderAPIServer(port=args.port)
    server.start()


if __name__ == "__main__":
    main()
