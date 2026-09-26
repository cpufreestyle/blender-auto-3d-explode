#!/usr/bin/env node
/**
 * 单元测试 — Quest 3 默认模型构建（src/quest3-model.js，从 main.js 抽取）
 *
 * 抽取的不变量：
 *   - 十个默认部件共 15 条 part 记录（主机身/前面板/面罩/左右透镜模组/左右透镜/
 *     主板/三颗前置摄像头/下置摄像头/左右头带臂/头带），顺序与名称原样；
 *   - 每个 mesh：position/rotation 摆到合体位姿、castShadow/receiveShadow 取
 *     !lowPowerMode、userData 替换为 { name }、parent 挂进 questGroup、parts 追加
 *     「合体/爆炸位姿（Vector3）+ 旋转（Euler）+ 名称」五字段；
 *   - addCamLens：四颗摄像头各挂 1 颗传感器小圆点（z 偏移 0.045、材质取
 *     materials.sensor、几何共享 lensDotGeo），小圆点作为摄像头的子对象，
 *     不直挂 questGroup、不产生 part 记录；
 *   - 右透镜模组 / 右透镜 / 右置摄像头等用 clone() 几何，与左侧不是同一实例；
 *   - 头带为 TubeGeometry（半径 0.14、32 段）。
 *
 * 用法：node tests/quest3-model-test.mjs
 */

import { BoxGeometry, CylinderGeometry, Euler, Group, Mesh, MeshBasicMaterial, TubeGeometry, Vector3 } from "three";
import { createQuest3Model } from "../src/quest3-model.js";
import { materials } from "../src/lego-materials.js";

// ===== 测试框架（与仓库既有 .mjs 测试一致）=====
let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    console.log(`  OK ${message}`);
    passed++;
  } else {
    console.error(`  FAIL ${message}`);
    failed++;
    failures.push(message);
  }
}

const describeQueue = [];
function describe(name, fn) {
  describeQueue.push({ name, fn });
}
function it(_name, fn) {
  return fn();
}

const PART_NAMES = [
  "主机身",
  "前面板",
  "面罩海绵",
  "左透镜模组",
  "右透镜模组",
  "左透镜",
  "右透镜",
  "主板/显示屏",
  "左摄像头",
  "右摄像头",
  "中置摄像头",
  "下置追踪摄像头",
  "左头带臂",
  "右头带臂",
  "头带",
];
const CAM_PART_INDICES = [8, 9, 10, 11];

function build(lowPowerMode = false) {
  const questGroup = new Group();
  const parts = [];
  const { createPart } = createQuest3Model({ questGroup, parts, lowPowerMode });
  return { questGroup, parts, createPart };
}

describe("quest3 模型：部件清单与挂载", async() => {
  it("15 条 part 记录且名称顺序正确", async() => {
    const { parts } = build();
    assert(parts.length === 15, `共 15 个部件（实际 ${parts.length}）`);
    assert(
      JSON.stringify(parts.map(p => p.name)) === JSON.stringify(PART_NAMES),
      "部件名称与顺序符合 Quest 3 拆解教学方案",
    );
  });

  it("每个 mesh 直挂 questGroup 且 parent 正确", async() => {
    const { questGroup, parts } = build();
    assert(questGroup.children.length === 15, `questGroup 直系 15 个子对象（实际 ${questGroup.children.length}）`);
    assert(parts.every(p => p.mesh.parent === questGroup), "每个部件的 mesh.parent 均为 questGroup");
  });

  it("part 记录五字段齐备且类型正确", async() => {
    const { parts } = build();
    const p = parts[0];
    assert(p.homePos instanceof Vector3 && p.explodePos instanceof Vector3, "homePos / explodePos 为 Vector3");
    assert(p.homeRot instanceof Euler && p.explodeRot instanceof Euler, "homeRot / explodeRot 为 Euler");
    assert(p.name === "主机身", "name 透传");
    assert(Object.keys(p).length === 6, "part 记录仅六字段（mesh/两个位姿/两个旋转/名称）");
  });

  it("mesh 位姿与 userData 落位", async() => {
    const { parts } = build();
    const leftBarrel = parts[3];
    assert(leftBarrel.mesh.position.toArray().join(",") === "-0.52,0.05,-0.12", "mesh.position 取合体位姿");
    assert(
      leftBarrel.homePos.toArray().join(",") === "-0.52,0.05,-0.12" &&
        leftBarrel.explodePos.toArray().join(",") === "-0.52,0.05,-0.7",
      "合体/爆炸位姿分别记录",
    );
    assert(
      leftBarrel.mesh.rotation.x === 0 && leftBarrel.mesh.rotation.y === 0 && leftBarrel.mesh.rotation.z === 0,
      "rotation 默认归零",
    );
    assert(
      JSON.stringify(leftBarrel.mesh.userData) === JSON.stringify({ name: "左透镜模组" }),
      "userData 整体替换为 { name }",
    );
  });
});

const POSE_TABLE = [
  // [name, homePos, explodePos]
  ["主机身", [0, 0, 0], [0, 0, 0]],
  ["前面板", [0, 0, 0.55], [0, 0, 1.45]],
  ["面罩海绵", [0, 0, -0.55], [0, 0, -1.35]],
  ["左透镜模组", [-0.52, 0.05, -0.12], [-0.52, 0.05, -0.7]],
  ["右透镜模组", [0.52, 0.05, -0.12], [0.52, 0.05, -0.7]],
  ["左透镜", [-0.52, 0.05, -0.34], [-0.52, 0.05, -1.1]],
  ["右透镜", [0.52, 0.05, -0.34], [0.52, 0.05, -1.1]],
  ["主板/显示屏", [0, 0.05, -0.05], [0, 0.05, -0.95]],
  ["左摄像头", [-0.75, 0.18, 0.68], [-0.95, 0.35, 1.8]],
  ["右摄像头", [0.75, 0.18, 0.68], [0.95, 0.35, 1.8]],
  ["中置摄像头", [0, 0.28, 0.68], [0, 0.55, 1.9]],
  ["下置追踪摄像头", [0, -0.35, 0.6], [0, -0.75, 1.7]],
  ["左头带臂", [-1.25, 0, 0], [-2.1, 0, 0]],
  ["右头带臂", [1.25, 0, 0], [2.1, 0, 0]],
  ["头带", [0, 0, 0], [0, 0.9, -0.8]],
];

describe("quest3 模型：逐部件位姿表", async() => {
  it("15 个部件的合体/爆炸位姿逐一符合原表", async() => {
    const { parts } = build();
    let mismatch = null;
    parts.forEach((p, i) => {
      const [name, home, explode] = POSE_TABLE[i];
      if (p.name !== name) mismatch = `#${i} 名称 ${p.name} != ${name}`;
      const homeStr = home.join(",");
      const explodeStr = explode.join(",");
      const got = p.homePos.toArray().join(",");
      const gotE = p.explodePos.toArray().join(",");
      if (got !== homeStr) mismatch = `${name} homePos ${got} != ${homeStr}`;
      if (gotE !== explodeStr) mismatch = `${name} explodePos ${gotE} != ${explodeStr}`;
      const pos = p.mesh.position.toArray().join(",");
      if (pos !== homeStr) mismatch = `${name} mesh.position ${pos} != ${homeStr}`;
    });
    assert(mismatch === null, mismatch || "全部 15 个部件的名称、合体/爆炸位姿与 mesh.position 符合原表");
  });
});

describe("quest3 模型：性能模式与几何细节", async() => {
  it("正常模式：投影开关为真", async() => {
    const { parts } = build(false);
    assert(parts.every(p => p.mesh.castShadow && p.mesh.receiveShadow), "castShadow / receiveShadow 均为 true");
  });

  it("低性能模式：投影开关为假", async() => {
    const { parts } = build(true);
    assert(parts.every(p => !p.mesh.castShadow && !p.mesh.receiveShadow), "castShadow / receiveShadow 均为 false");
  });

  it("右透镜模组为 clone 几何（与左侧不同实例）", async() => {
    const { parts } = build();
    assert(parts[4].mesh.geometry !== parts[3].mesh.geometry, "左右透镜模组几何不是同一实例");
    assert(parts[4].mesh.geometry instanceof CylinderGeometry, "透镜模组几何为 CylinderGeometry");
  });

  it("头带为 TubeGeometry 且参数原样", async() => {
    const { parts } = build();
    const strap = parts[14];
    assert(strap.mesh.geometry instanceof TubeGeometry, "头带几何为 TubeGeometry");
    assert(strap.mesh.geometry.parameters.radius === 0.14, "头带半径 0.14");
    assert(strap.mesh.geometry.parameters.tubularSegments === 32, "头带 32 段");
  });
});

describe("quest3 模型：摄像头镜头小圆点", async() => {
  it("四颗摄像头各挂 1 颗传感器小圆点", async() => {
    const { questGroup, parts } = build();
    for (const i of CAM_PART_INDICES) {
      const mesh = parts[i].mesh;
      assert(mesh.children.length === 1, `${mesh.userData.name} 有 1 个子对象`);
      const dot = mesh.children[0];
      assert(dot.position.z === 0.045, `${mesh.userData.name} 小圆点 z 偏移 0.045`);
      assert(dot.material === materials.sensor, `${mesh.userData.name} 小圆点材质为 materials.sensor`);
    }
    const firstDot = parts[CAM_PART_INDICES[0]].mesh.children[0];
    assert(
      CAM_PART_INDICES.every(i => parts[i].mesh.children[0].geometry === firstDot.geometry),
      "小圆点几何共享同一 lensDotGeo 实例",
    );
    assert(questGroup.children.length === 15, "小圆点不直挂 questGroup");
    assert(
      CAM_PART_INDICES.every(i => parts[i].mesh.children[0].userData.name === undefined),
      "小圆点不产生 part 记录（非部件）",
    );
  });

  it("非摄像头部件没有镜头小圆点", async() => {
    const { parts } = build();
    const others = parts.filter((_, i) => !CAM_PART_INDICES.includes(i));
    assert(others.every(p => p.mesh.children.length === 0), "其余部件无子对象");
  });
});

describe("quest3 模型：createPart 旋转运法", async() => {
  it("homeRot/explodeRot 分别记录且 mesh.rotation 取合体旋转", async() => {
    const { questGroup, parts, createPart } = build();
    const mesh = new Mesh(new BoxGeometry(0.4, 0.4, 0.4), new MeshBasicMaterial());
    const returned = createPart({
      mesh,
      homePos: [1, 2, 3],
      explodePos: [4, 5, 6],
      homeRot: [0, Math.PI / 2, 0],
      explodeRot: [Math.PI, 0, 0],
      name: "测试件",
    });
    assert(returned === mesh, "createPart 返回传入的 mesh");
    const part = parts[parts.length - 1];
    assert(part.name === "测试件", "自定义部件追加进 parts");
    assert(mesh.parent === questGroup, "自定义部件挂进 questGroup");
    assert(part.homeRot.y === Math.PI / 2, "homeRot 记录合体旋转（y 轴 90°）");
    assert(part.explodeRot.x === Math.PI, "explodeRot 记录爆炸旋转（x 轴 180°）");
    assert(part.homeRot.x !== part.explodeRot.x, "两个旋转字段不记串");
    assert(mesh.rotation.y === Math.PI / 2, "mesh.rotation 摆到合体旋转");
    assert(mesh.position.toArray().join(",") === "1,2,3", "mesh.position 取合体位姿");
    assert(part.explodePos.toArray().join(",") === "4,5,6", "explodePos 独立记录");
  });

  it("旋转缺省时归零", async() => {
    const { parts, createPart } = build();
    const mesh = new Mesh(new BoxGeometry(0.4, 0.4, 0.4), new MeshBasicMaterial());
    createPart({ mesh, homePos: [0, 0, 0], explodePos: [0, 0, 0], name: "零旋转件" });
    const part = parts[parts.length - 1];
    assert(
      part.homeRot.x === 0 && part.homeRot.y === 0 && part.homeRot.z === 0 &&
        part.explodeRot.x === 0 && part.explodeRot.y === 0 && part.explodeRot.z === 0,
      "homeRot/explodeRot 缺省 [0,0,0]",
    );
  });
});

// ===== 顺序执行（与仓库既有测试一致）=====
(async() => {
  for (const item of describeQueue) {
    console.log(`\n── ${item.name}`);
    await item.fn();
  }
  console.log("\n════════════════════════════════════════════════════════════════");
  console.log(`  结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) {
    console.error("❌ 存在失败用例:");
    failures.forEach(f => console.error(`   - ${f}`));
    process.exit(1);
  }
  console.log("  ✅ 全部测试通过！");
})();
