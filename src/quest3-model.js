// Quest 3 默认模型构建（从 main.js 抽取，行为不变）。
//
// 搬迁 main.js「Quest 3 简化模型构建」整段：
//   - createPart：把 mesh 摆到合体位姿、按性能模式置投影、记 userData.name、
//     挂进 questGroup 并向 parts 追加「合体/爆炸位姿 + 旋转 + 名称」部件记录；
//   - addCamLens：给摄像头挂一颗传感器小圆点（z 偏移进父子级）；
//   - 十个默认部件的几何构造与四十余项 createPart 调用（主机身/前面板/面罩/
//     左右透镜模组/左右透镜/主板/三颗前置摄像头/下置摄像头/左右头带臂/头带）。
//
// 返回 { createPart }：main.js 当前不使用返回值（部件记录经共享的 parts 数组
// 传出），导出仅供测试直接观测旋转运法（默认模型所有旋转均为 0，不导出的
// 话「homeRot/explodeRot 记串」与「mesh.rotation 未设置」两类回归测不出来）。
//
// 依赖注入：questGroup / parts / lowPowerMode 三个稳定引用直接传入（questGroup
// 是 const Group，parts 只 push 不重赋值，lowPowerMode 是 const，均无需桥接）；
// materials 直接依赖 lego-materials.js（与 main.js 共用同一份材质实例）。
import {
  BoxGeometry,
  CatmullRomCurve3,
  CircleGeometry,
  CylinderGeometry,
  Euler,
  Mesh,
  TubeGeometry,
  Vector3,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { materials } from "./lego-materials.js";

export function createQuest3Model({ questGroup, parts, lowPowerMode }) {
  function createPart({
    mesh,
    homePos,
    explodePos,
    homeRot = [0, 0, 0],
    explodeRot = [0, 0, 0],
    name,
  }) {
    mesh.position.set(...homePos);
    mesh.rotation.set(...homeRot);
    mesh.castShadow = !lowPowerMode;
    mesh.receiveShadow = !lowPowerMode;
    mesh.userData = { name };
    questGroup.add(mesh);
    parts.push({
      mesh,
      homePos: new Vector3(...homePos),
      explodePos: new Vector3(...explodePos),
      homeRot: new Euler(...homeRot),
      explodeRot: new Euler(...explodeRot),
      name: name,
    });
    return mesh;
  }

  // 1. 主机身（中部黑色主体）
  const bodyGeo = new RoundedBoxGeometry(2.2, 1.15, 1.0, 4, 0.12);
  const bodyMesh = new Mesh(bodyGeo, materials.body);
  createPart({
    mesh: bodyMesh,
    homePos: [0, 0, 0],
    explodePos: [0, 0, 0],
    name: "主机身",
  });

  // 2. 前面板（白色外壳）
  const frontGeo = new RoundedBoxGeometry(2.3, 1.25, 0.25, 4, 0.1);
  const frontMesh = new Mesh(frontGeo, materials.frontPlate);
  createPart({
    mesh: frontMesh,
    homePos: [0, 0, 0.55],
    explodePos: [0, 0, 1.45],
    name: "前面板",
  });

  // 3. 后面罩/泡沫垫
  const foamGeo = new RoundedBoxGeometry(2.0, 0.95, 0.18, 4, 0.08);
  const foamMesh = new Mesh(foamGeo, materials.foam);
  createPart({
    mesh: foamMesh,
    homePos: [0, 0, -0.55],
    explodePos: [0, 0, -1.35],
    name: "面罩海绵",
  });

  // 4. 左右透镜模组
  const barrelGeo = new CylinderGeometry(0.32, 0.32, 0.45, 32);
  barrelGeo.rotateX(Math.PI / 2);
  const leftBarrel = new Mesh(barrelGeo, materials.lensBarrel);
  createPart({
    mesh: leftBarrel,
    homePos: [-0.52, 0.05, -0.12],
    explodePos: [-0.52, 0.05, -0.7],
    name: "左透镜模组",
  });

  const rightBarrel = new Mesh(barrelGeo.clone(), materials.lensBarrel);
  createPart({
    mesh: rightBarrel,
    homePos: [0.52, 0.05, -0.12],
    explodePos: [0.52, 0.05, -0.7],
    name: "右透镜模组",
  });

  // 5. 透镜玻璃片
  const glassGeo = new CylinderGeometry(0.26, 0.26, 0.04, 32);
  glassGeo.rotateX(Math.PI / 2);
  const leftGlass = new Mesh(glassGeo, materials.lensGlass);
  createPart({
    mesh: leftGlass,
    homePos: [-0.52, 0.05, -0.34],
    explodePos: [-0.52, 0.05, -1.1],
    name: "左透镜",
  });

  const rightGlass = new Mesh(glassGeo.clone(), materials.lensGlass);
  createPart({
    mesh: rightGlass,
    homePos: [0.52, 0.05, -0.34],
    explodePos: [0.52, 0.05, -1.1],
    name: "右透镜",
  });

  // 6. 显示屏/主板
  const pcbGeo = new BoxGeometry(1.6, 0.7, 0.06);
  const pcbMesh = new Mesh(pcbGeo, materials.pcb);
  createPart({
    mesh: pcbMesh,
    homePos: [0, 0.05, -0.05],
    explodePos: [0, 0.05, -0.95],
    name: "主板/显示屏",
  });

  // 7. 前置摄像头（左右两颗 + 中间一颗）
  const camGeo = new CylinderGeometry(0.09, 0.09, 0.08, 24);
  camGeo.rotateX(Math.PI / 2);

  const leftCam = new Mesh(camGeo, materials.camera);
  createPart({
    mesh: leftCam,
    homePos: [-0.75, 0.18, 0.68],
    explodePos: [-0.95, 0.35, 1.8],
    name: "左摄像头",
  });

  const rightCam = new Mesh(camGeo.clone(), materials.camera);
  createPart({
    mesh: rightCam,
    homePos: [0.75, 0.18, 0.68],
    explodePos: [0.95, 0.35, 1.8],
    name: "右摄像头",
  });

  const centerCam = new Mesh(camGeo.clone(), materials.camera);
  createPart({
    mesh: centerCam,
    homePos: [0, 0.28, 0.68],
    explodePos: [0, 0.55, 1.9],
    name: "中置摄像头",
  });

  // 摄像头镜头小圆点
  const lensDotGeo = new CircleGeometry(0.055, 24);
  function addCamLens(parent, zOffset) {
    const dot = new Mesh(lensDotGeo, materials.sensor);
    dot.position.z = zOffset;
    parent.add(dot);
  }
  addCamLens(leftCam, 0.045);
  addCamLens(rightCam, 0.045);
  addCamLens(centerCam, 0.045);

  // 8. 下侧摄像头/传感器
  const bottomCam = new Mesh(camGeo.clone(), materials.camera);
  createPart({
    mesh: bottomCam,
    homePos: [0, -0.35, 0.6],
    explodePos: [0, -0.75, 1.7],
    name: "下置追踪摄像头",
  });
  addCamLens(bottomCam, 0.045);

  // 9. 头带臂（左右）
  const armGeo = new RoundedBoxGeometry(0.25, 0.7, 0.18, 2, 0.04);
  const leftArm = new Mesh(armGeo, materials.strapArm);
  createPart({
    mesh: leftArm,
    homePos: [-1.25, 0, 0],
    explodePos: [-2.1, 0, 0],
    name: "左头带臂",
  });

  const rightArm = new Mesh(armGeo.clone(), materials.strapArm);
  createPart({
    mesh: rightArm,
    homePos: [1.25, 0, 0],
    explodePos: [2.1, 0, 0],
    name: "右头带臂",
  });

  // 10. 头带（简化弧线）
  const strapCurve = new CatmullRomCurve3([
    new Vector3(-1.25, 0.25, -0.1),
    new Vector3(-0.8, 1.4, -0.5),
    new Vector3(0, 1.6, -0.6),
    new Vector3(0.8, 1.4, -0.5),
    new Vector3(1.25, 0.25, -0.1),
  ]);
  const strapGeo = new TubeGeometry(strapCurve, 32, 0.14, 12, false);
  const strapMesh = new Mesh(strapGeo, materials.strapArm);
  createPart({
    mesh: strapMesh,
    homePos: [0, 0, 0],
    explodePos: [0, 0.9, -0.8],
    name: "头带",
  });

  return { createPart };
}
