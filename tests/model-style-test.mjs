#!/usr/bin/env node
/**
 * 单元测试 — 模型样式切换（src/model-style.js，从 main.js 抽取）
 *
 * 抽取的不变量：
 *   - applyModelStyle 先经 setState 回落 currentModelStyle，再按目标样式
 *     对 questGroup 与 customModelGroup 深度遍历换材质；
 *   - mesh 首次被访问时把原生材质缓存进 userData._nativeMaterial，之后无论
 *     切到哪一版都不会覆盖该缓存（反复应用同一乐高样式不丢原生材质）；
 *   - 切回原生时还原的正是最初缓存的那个材质实例（同引用）；
 *   - 非 mesh 节点（Group / Light 等）跳过；
 *   - customModelGroup 缺省（undefined）时按 typeof 守卫跳过，仅处理
 *     questGroup；传入则两个组都处理；
 *   - 嵌套层级深的 mesh 同样被处理（traverse 而非只处理直接子级）。
 *
 * 用法：node tests/model-style-test.mjs
 */

import { Group, Light, Mesh, MeshStandardMaterial } from "three";
import { createModelStyleSwitcher } from "../src/model-style.js";
import { getLegoMaterialForMesh, materials } from "../src/lego-materials.js";

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

function makeMesh(name) {
  const mesh = new Mesh(undefined, new MeshStandardMaterial({ color: 0x123456 }));
  mesh.name = name;
  return mesh;
}

function makeSwitcher({ withCustom = true } = {}) {
  const patches = [];
  const state = { currentModelStyle: "native" };
  const questGroup = new Group();
  const customModelGroup = withCustom ? new Group() : undefined;
  const { applyModelStyle } = createModelStyleSwitcher({
    questGroup,
    customModelGroup,
    setState: patch => {
      patches.push(patch);
      if ("currentModelStyle" in patch) state.currentModelStyle = patch.currentModelStyle;
    },
  });
  return { patches, state, questGroup, customModelGroup, applyModelStyle };
}

describe("model-style：样式状态回落", async() => {
  it("applyModelStyle 先回落 currentModelStyle", async() => {
    const w = makeSwitcher();
    w.applyModelStyle("lego");
    assert(w.state.currentModelStyle === "lego", "setState 写回 lego");
    assert(w.patches.length === 1, "仅一次 setState");
    assert(Object.keys(w.patches[0]).length === 1, "patch 仅一个键");
    assert("currentModelStyle" in w.patches[0], "patch 键为 currentModelStyle");
    w.applyModelStyle("native");
    assert(w.state.currentModelStyle === "native", "再回落 native");
  });

  it("任意样式串都原样回落（不做白名单校验）", async() => {
    const w = makeSwitcher();
    w.applyModelStyle("whatever");
    assert(w.state.currentModelStyle === "whatever", "未知样式串原样记录");
  });
});

describe("model-style：材质切换与缓存", async() => {
  it("lego：mesh 材质换成乐高映射", async() => {
    const w = makeSwitcher();
    const mesh = makeMesh("机身");
    const native = mesh.material;
    w.questGroup.add(mesh);
    w.applyModelStyle("lego");
    assert(mesh.material === getLegoMaterialForMesh(mesh), "材质为乐高映射结果");
    assert(mesh.material !== native, "已非原生材质");
    assert(mesh.userData._nativeMaterial === native, "原生材质按实例缓存进 userData");
  });

  it("native：还原最初缓存的原生材质实例", async() => {
    const w = makeSwitcher();
    const mesh = makeMesh("机身");
    const native = mesh.material;
    w.questGroup.add(mesh);
    w.applyModelStyle("lego");
    w.applyModelStyle("native");
    assert(mesh.material === native, "还原的是最初那份材质（同引用）");
  });

  it("反复应用同一乐高样式不覆盖缓存", async() => {
    const w = makeSwitcher();
    const mesh = makeMesh("机身");
    const native = mesh.material;
    w.questGroup.add(mesh);
    w.applyModelStyle("lego");
    w.applyModelStyle("lego");
    assert(mesh.userData._nativeMaterial === native, "缓存仍是原生材质而非乐高材质");
    w.applyModelStyle("native");
    assert(mesh.material === native, "仍可正确还原");
  });

  it("嵌套 mesh 同样被处理（traverse 深度遍历）", async() => {
    const w = makeSwitcher();
    const outer = new Group();
    const inner = new Group();
    const deep = makeMesh("深层件");
    inner.add(deep);
    outer.add(inner);
    w.questGroup.add(outer);
    w.applyModelStyle("lego");
    assert(deep.material === getLegoMaterialForMesh(deep), "三层嵌套的 mesh 也被切样式");
  });

  it("非 mesh 节点跳过", async() => {
    const w = makeSwitcher();
    const light = new Light(0xffffff, 1);
    const holder = new Group();
    const mesh = makeMesh("机身");
    holder.add(light);
    w.questGroup.add(holder);
    w.questGroup.add(mesh);
    w.applyModelStyle("lego");
    assert(light.material === undefined, "Light 无 material 未被写入");
    assert(mesh.material === getLegoMaterialForMesh(mesh), "同组 mesh 正常切换");
  });
});

describe("model-style：两个模型组", async() => {
  it("customModelGroup 传入时两个组都处理", async() => {
    const w = makeSwitcher({ withCustom: true });
    const a = makeMesh("默认件");
    const b = makeMesh("自定义件");
    w.questGroup.add(a);
    w.customModelGroup.add(b);
    w.applyModelStyle("lego");
    assert(a.material === getLegoMaterialForMesh(a), "questGroup 内 mesh 已切换");
    assert(b.material === getLegoMaterialForMesh(b), "customModelGroup 内 mesh 已切换");
    w.applyModelStyle("native");
    assert(b.material !== getLegoMaterialForMesh(b), "customModelGroup 也参与还原");
    assert(b.userData._nativeMaterial === b.material, "自定义件的原生材质被缓存");
  });

  it("customModelGroup 缺省时按 typeof 守卫跳过", async() => {
    const w = makeSwitcher({ withCustom: false });
    const a = makeMesh("默认件");
    w.questGroup.add(a);
    let threw = null;
    try {
      w.applyModelStyle("lego");
    } catch (e) {
      threw = e;
    }
    assert(threw === null, "缺组不抛错");
    assert(a.material === getLegoMaterialForMesh(a), "仅 questGroup 被处理");
  });

  it("乐高映射来自共享 materials 表（导入同一实例）", async() => {
    assert(typeof materials === "object" && materials !== null, "materials 表可导入");
    const w = makeSwitcher();
    const mesh = new Mesh(undefined, materials.body);
    w.questGroup.add(mesh);
    w.applyModelStyle("lego");
    assert(mesh.material === getLegoMaterialForMesh(mesh), "切换目标与 helper 一致");
    assert(mesh.material.type === getLegoMaterialForMesh(mesh).type, "乐高映射材质类型一致（MeshStandardMaterial）");
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
