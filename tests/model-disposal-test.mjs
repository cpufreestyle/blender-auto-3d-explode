#!/usr/bin/env node
/**
 * 单元测试 — 模型拆卸与 GPU 资源释放（src/model-disposal.js，从 main.js 抽取）
 *
 * 抽取的不变量：
 *   - disposeNodeTree：falsy 安全返回；traverse 覆盖嵌套节点；geometry 与
 *     material 均 dispose；material 数组逐项 dispose；贴图先于材质 dispose
 *     （material.dispose() 不释放贴图 GPU 资源）；无贴图材质只 dispose 自身；
 *   - clearCustomModelGroup：while 摘清全部子对象并逐一走 release 遍历；
 *     userData 清空；scale/position 复位；customModelParts 与
 *     assemblySequenceOrder 两个共享状态经 setState 回落且 patch 只含约定键；
 *     空组同样复位与回写、不抛错；
 *   - yieldToMain（随本次重构迁至 src/utils.js）：返回 Promise 且resolve 无值。
 *
 * 用法：node tests/model-disposal-test.mjs
 */

import { createModelDisposal, disposeNodeTree } from "../src/model-disposal.js";
import { yieldToMain } from "../src/utils.js";

// ===== 测试框架（与 unit-test.mjs / ar-preview-test.mjs 一致）=====
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

// ===== 假 three.js 世界 =====
// 只实现被测代码路径上用到的表面：dispose / isTexture / traverse / children /
// userData / scale.set / position.set / remove。
function makeTexture(log, name) {
  return { isTexture: true, dispose() { log.push(`tex:${name}`); } };
}

function makeMaterial(log, name, textures = {}) {
  return {
    name,
    ...textures,
    dispose() { log.push(`mat:${name}`); },
  };
}

function makeGeometry(log, name) {
  return { name, dispose() { log.push(`geo:${name}`); } };
}

function makeNode(name, opts = {}) {
  const children = opts.children || [];
  const node = {
    name,
    geometry: opts.geometry,
    material: opts.material,
    children,
    userData: opts.userData || {},
    scale: { set: (...a) => { node._scale = a; } },
    position: { set: (...a) => { node._pos = a; } },
    traverse(cb) {
      cb(node);
      for (const c of children) c.traverse(cb);
    },
  };
  return node;
}

function makeGroup() {
  const g = {
    children: [],
    scale: { set: (...a) => { g._scale = a; } },
    position: { set: (...a) => { g._pos = a; } },
    remove(child) {
      const i = g.children.indexOf(child);
      if (i >= 0) g.children.splice(i, 1);
    },
  };
  return g;
}

function makeStore(overrides) {
  const state = {
    customModelParts: [{ name: "old" }],
    assemblySequenceOrder: ["a", "b"],
    ...(overrides || {}),
  };
  const patches = [];
  return {
    state,
    patches,
    getState: () => state,
    setState(patch) {
      patches.push({ ...patch });
      Object.assign(state, patch);
    },
  };
}

function setup(overrides) {
  const group = makeGroup();
  const store = makeStore(overrides && overrides.state);
  const disposal = createModelDisposal({
    customModelGroup: group,
    getState: store.getState,
    setState: store.setState,
  });
  return { group, store, disposal };
}

// ===== 用例 =====
describe("disposeNodeTree", async() => {
  await it("falsy 节点安全返回", () => {
    let threw = false;
    try {
      disposeNodeTree(null);
      disposeNodeTree(undefined);
    } catch {
      threw = true;
    }
    assert(threw === false, "null / undefined 不抛错");
  });

  await it("单 mesh：geometry 与 material 都 dispose", () => {
    const log = [];
    const mesh = makeNode("mesh", {
      geometry: makeGeometry(log, "g1"),
      material: makeMaterial(log, "m1"),
    });
    disposeNodeTree(mesh);
    assert(log.includes("geo:g1") && log.includes("mat:m1"), "几何体与材质均已释放");
    assert(log.length === 2, "无多余释放");
  });

  await it("material 数组：逐项 dispose", () => {
    const log = [];
    const mesh = makeNode("mesh", {
      material: [
        makeMaterial(log, "m1"),
        makeMaterial(log, "m2"),
        makeMaterial(log, "m3"),
      ],
    });
    disposeNodeTree(mesh);
    assert(log.filter(l => l.startsWith("mat:")).length === 3, "三个材质全部释放");
  });

  await it("贴图先于材质 dispose（材质自身属性里的 isTexture）", () => {
    const log = [];
    const mat = makeMaterial(log, "m1", {
      map: makeTexture(log, "map"),
      normalMap: makeTexture(log, "normal"),
      roughness: 0.5, // 非贴图属性应被跳过
    });
    const mesh = makeNode("mesh", { material: mat });
    disposeNodeTree(mesh);
    assert(log.includes("tex:map") && log.includes("tex:normal"), "两张贴图均释放");
    assert(log.indexOf("tex:map") < log.indexOf("mat:m1"), "贴图释放早于材质");
    assert(log.indexOf("tex:normal") < log.indexOf("mat:m1"), "normal 贴图也早于材质");
    assert(!log.some(l => l.startsWith("tex:roughness")), "非贴图属性不触发释放");
  });

  await it("嵌套 Group/Mesh：traverse 覆盖全部层级", () => {
    const log = [];
    const leaf = makeNode("leaf", {
      geometry: makeGeometry(log, "g-leaf"),
      material: makeMaterial(log, "m-leaf"),
    });
    const mid = makeNode("mid", { children: [leaf] });
    const root = makeNode("root", {
      geometry: makeGeometry(log, "g-root"),
      material: [makeMaterial(log, "m-root-1"), makeMaterial(log, "m-root-2")],
      children: [mid],
    });
    disposeNodeTree(root);
    for (const key of ["geo:g-root", "mat:m-root-1", "mat:m-root-2", "geo:g-leaf", "mat:m-leaf"]) {
      assert(log.includes(key), `释放了 ${key}`);
    }
  });

  await it("无 geometry / material 的节点：不抛错", () => {
    const log = [];
    const empty = makeNode("empty");
    disposeNodeTree(empty);
    assert(log.length === 0, "无可释放资源，静默通过");
  });
});

describe("clearCustomModelGroup", async() => {
  await it("摘清全部子对象（含嵌套），逐个释放并清空 userData", () => {
    const log = [];
    const leaf = makeNode("leaf", {
      geometry: makeGeometry(log, "g-leaf"),
      material: makeMaterial(log, "m-leaf"),
    });
    const childA = makeNode("a", {
      geometry: makeGeometry(log, "g-a"),
      material: makeMaterial(log, "m-a", { map: makeTexture(log, "t-a") }),
      userData: { manifest: { parts: 3 } },
    });
    const childB = makeNode("b", { children: [leaf], userData: { loading: true } });
    const { group, disposal } = setup();
    group.children.push(childA, childB);
    disposal.clearCustomModelGroup();
    assert(group.children.length === 0, "组内子对象被摘清");
    assert(log.includes("tex:t-a"), "子对象材质贴图已释放");
    assert(log.includes("geo:g-leaf"), "嵌套子节点的几何体已释放");
    assert(Object.keys(childA.userData).length === 0, "childA userData 清空");
    assert(Object.keys(childB.userData).length === 0, "childB userData 清空");
    assert(JSON.stringify(group._scale) === JSON.stringify([1, 1, 1]), "scale 复位 1");
    assert(JSON.stringify(group._pos) === JSON.stringify([0, 0, 0]), "position 复位 0");
  });

  await it("共享状态回落：customModelParts 清空、assemblySequenceOrder 置 null", () => {
    const { store, disposal } = setup();
    disposal.clearCustomModelGroup();
    assert(store.state.customModelParts.length === 0, "customModelParts 清空");
    assert(store.state.assemblySequenceOrder === null, "assemblySequenceOrder 置 null");
    const keys = store.patches.flatMap(p => Object.keys(p));
    assert(keys.length === 2, "两个 patch");
    assert(keys.includes("customModelParts") && keys.includes("assemblySequenceOrder"), "键在约定集合内");
  });

  await it("空组：同样复位变换与回写状态，不抛错", () => {
    const { group, store, disposal } = setup({ state: { customModelParts: [], assemblySequenceOrder: null } });
    let threw = false;
    try { disposal.clearCustomModelGroup(); } catch { threw = true; }
    assert(threw === false, "空组不抛错");
    assert(JSON.stringify(group._scale) === JSON.stringify([1, 1, 1]), "scale 仍复位");
    assert(store.patches.length === 2, "仍写两个 patch（幂等重置）");
  });

  await it("惰性读：外部换掉 customModelParts 引用后不影响本函数语义", () => {
    const { store, disposal } = setup();
    store.state.customModelParts = [{ name: "new" }];
    disposal.clearCustomModelGroup();
    assert(store.state.customModelParts.length === 0, "清空的是当前引用指向的数组");
  });
});

describe("yieldToMain（迁至 utils.js）", async() => {
  await it("返回 Promise 且 resolve 无值", async() => {
    const p = yieldToMain();
    assert(p instanceof Promise, "返回 Promise");
    const v = await p;
    assert(v === undefined, "resolve 不携带值");
  });
});

// ===== 运行 =====
(async() => {
  for (const { name, fn } of describeQueue) {
    console.log(`\n── ${name}`);
    await fn();
  }
  console.log("\n════════════════════════════════════════════════════════════════");
  console.log(`  结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) {
    console.log("  失败的用例:");
    for (const f of failures) console.log("    - " + f);
    process.exit(1);
  }
  console.log("  ✅ 全部测试通过！");
})();
