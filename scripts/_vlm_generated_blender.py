import bpy
import math

def create_material(name, color):
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    nodes.clear()
    bsdf = nodes.new(type='ShaderNodeBsdfPrincipled')
    output = nodes.new(type='ShaderNodeOutputMaterial')
    bsdf.inputs[0].default_value = color
    mat.node_tree.links.new(bsdf.outputs[0], output.inputs[0])
    return mat

# Materials
mat_plate = create_material("GLM_VLM_Mat_Plate", (0.08, 0.08, 0.08, 1))
mat_bun = create_material("GLM_VLM_Mat_Bun", (0.82, 0.62, 0.32, 1))
mat_patty = create_material("GLM_VLM_Mat_Patty", (0.35, 0.18, 0.08, 1))
mat_lettuce = create_material("GLM_VLM_Mat_Lettuce", (0.2, 0.58, 0.2, 1))
mat_tomato = create_material("GLM_VLM_Mat_Tomato", (0.78, 0.18, 0.18, 1))
mat_cheese = create_material("GLM_VLM_Mat_Cheese", (0.92, 0.75, 0.12, 1))
mat_sesame = create_material("GLM_VLM_Mat_Sesame", (0.92, 0.9, 0.82, 1))
mat_garnish = create_material("GLM_VLM_Mat_Garnish", (0.35, 0.72, 0.35, 1))

# Plate
bpy.ops.mesh.primitive_cylinder_add(radius=1.8, depth=0.08, location=(0, 0, 0))
plate = bpy.context.active_object
plate.name = "GLM_VLM_Plate"
plate.data.materials.append(mat_plate)

# Bun Bottom
bpy.ops.mesh.primitive_cylinder_add(radius=0.85, depth=0.25, location=(0, 0, 0.2))
bun_bottom = bpy.context.active_object
bun_bottom.name = "GLM_VLM_Bun_Bottom"
bun_bottom.data.materials.append(mat_bun)

# Patty
bpy.ops.mesh.primitive_cylinder_add(radius=0.82, depth=0.18, location=(0, 0, 0.42))
patty = bpy.context.active_object
patty.name = "GLM_VLM_Patty"
patty.data.materials.append(mat_patty)

# Cheese
bpy.ops.mesh.primitive_cylinder_add(radius=0.8, depth=0.08, location=(0, 0, 0.6))
cheese = bpy.context.active_object
cheese.name = "GLM_VLM_Cheese"
cheese.rotation_euler = (0.2, 0.4, 0.1)
cheese.data.materials.append(mat_cheese)

# Lettuce
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.9, location=(0, 0, 0.68))
lettuce = bpy.context.active_object
lettuce.name = "GLM_VLM_Lettuce"
lettuce.scale = (1.05, 1.05, 0.2)
lettuce.data.materials.append(mat_lettuce)

# Tomato
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.7, location=(0, 0, 0.78))
tomato = bpy.context.active_object
tomato.name = "GLM_VLM_Tomato"
tomato.scale = (1.0, 1.0, 0.15)
tomato.data.materials.append(mat_tomato)

# Bun Top
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.8, location=(0, 0, 0.95))
bun_top = bpy.context.active_object
bun_top.name = "GLM_VLM_Bun_Top"
bun_top.scale = (1.08, 1.08, 0.55)
bun_top.data.materials.append(mat_bun)

# Sesame seeds
for i in range(20):
    angle = (i / 20) * 2 * math.pi
    r = 0.4 + (i % 4) * 0.1
    x = r * math.cos(angle) * 0.9
    y = r * math.sin(angle) * 0.95
    z = 1.2 + (i % 3) * 0.05
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.04, location=(x, y, z))
    seed = bpy.context.active_object
    seed.name = f"GLM_VLM_Sesame_{i}"
    seed.scale = (0.8, 1.2, 0.8)
    if len(seed.data.materials) > 0:
        seed.data.materials[0] = mat_sesame
    else:
        seed.data.materials.append(mat_sesame)

# Garnish
bpy.ops.mesh.primitive_cone_add(radius1=0.08, radius2=0.01, depth=0.3, location=(0, 0.1, 1.35))
garnish = bpy.context.active_object
garnish.name = "GLM_VLM_Garnish"
garnish.rotation_euler = (-0.6, 0, 0.2)
garnish.data.materials.append(mat_garnish)