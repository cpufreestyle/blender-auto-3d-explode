#!/usr/bin/env node
/**
 * 单元测试 — 自定义模型加载主链路（src/custom-model-loader.js，从 main.js 抽取）
 *
 * 抽取的不变量：
 *   - computeGroupCount：2~6 段夹取的边界（0/1 部件、3/6 的档位、超量封顶）；
 *   - computeStepIndex：1 起算、除组分步、末组夹取；
 *   - bakeAndCenterParts：世界矩阵烘进几何体后世界包围盒不变（先决条件）；
 *     transform 三件套复位、matrixAutoUpdate、matrix.identity、投影/受影标志；
 *     两轮 yieldToMain（每部件每轮一次）；按整体包围盒居中；
 *   - reorderPartsByManifest：贪心就近匹配、同距时取索引小者、未匹配部件按
 *     原序追加、清单比部件多时优雅跳过、就地重排不换数组、yield 节奏；
 *   - loadCustomModel：重入守卫；拆分分支选择（Q3 前端切割 / 其余自动拆分）
 *     与对应状态栏文案；烘焙仅跳过「Q3 且无清单」；先清旧模型再解析；
 *     原始场景 dispose；部件构建（explodePos/homePos/homeRot/stepIndex）与
 *     customModelGroup 换子（旧的子对象先摘干净）；排序（距离降序 / 清单序）；
 *     三条命名分支；finalizeCustomModelLoad 的 { adjustExplode: true } 约定；
 *     成功文案含部件数；失败回滚两个分支（有/无上一个可用模型）与 finally
 *     复位；空拆分结果抛错并走回滚。
 *
 * 距离期望不重复实现数学：explodePos 直使用真实 calculateExplodePos
 * （src/explode-geometry.js），锁定的是本模块的接线而非其内部公式。
 *
 * 用法：node tests/custom-model-loader-test.mjs
 */

import {
  createCustomModelLoader,
  computeGroupCount,
  computeStepIndex,
  bakeAndCenterParts,
  reorderPartsByManifest,
} from "../src/custom-model-loader.js";
import { calculateExplodePos } from "../src/explode-geometry.js";
import { Box3, BoxGeometry, Euler, Group, Mesh, MeshBasicMaterial, Vector3 } from "three";

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

// ===== 假件 =====
const DEFAULT_GROUPS = [{ name: "默认一" }, { name: "默认二" }];

function makeYield() {
  const fn = () => {
    fn.count++;
    return Promise.resolve();
  };
  fn.count = 0;
  return fn;
}

function makeStore(overrides) {
  const state = {
    isLoadingCustomModel: false,
    hasCustomModel: false,
    customModelParts: [],
    stepGroups: DEFAULT_GROUPS,
    totalSteps: 2,
    currentStep: 0,
    displayedStep: 0,
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

function makeLoader(scene, opts = {}) {
  const calls = { parse: 0 };
  class FakeGLTFLoader {
    parse(arrayBuffer, path, onLoad, onError) {
      calls.parse++;
      calls.arrayBuffer = arrayBuffer;
      if (opts.failWith) onError({ message: opts.failWith });
      else onLoad({ scene });
    }
  }
  return { LoaderClass: FakeGLTFLoader, calls };
}

function makePartMesh(name, x, y, z, size = 2) {
  const mesh = new Mesh(new BoxGeometry(size, size, size), new MeshBasicMaterial());
  mesh.name = name;
  mesh.position.set(x, y, z);
  return mesh;
}

function makePreviousPart(name, x, y, z) {
  return {
    mesh: makePartMesh(`prev-${name}`, x, y, z, 1),
    homePos: new Vector3(x, y, z),
    explodePos: new Vector3(x + 1, y, z),
    homeRot: new Euler(0.1, 0.2, 0.3),
    explodeRot: new Euler(0.4, 0.5, 0.6),
    name,
    partCenter: new Vector3(x, y, z),
    stepIndex: 2,
  };
}

function makeModelScene() {
  const group = new Group();
  group.add(makePartMesh("root", 0, 0, 0, 1));
  return group;
}

const REAL_ERROR = console.error;
function silenceConsoleError() {
  console.error = () => {};
}
function restoreConsoleError() {
  console.error = REAL_ERROR;
}

function setup(opts = {}) {
  const store = makeStore(opts.state);
  const yieldFn = makeYield();
  const calls = {
    showStatus: [],
    setModelLoading: [],
    updateStepUI: 0,
    fitCameraToModel: [],
    finalizeCustomModelLoad: [],
    clearCustomModelGroup: 0,
    disposeNodeTree: [],
    autoSplit: 0,
    quest3Regions: 0,
    generatePartName: 0,
    generatePartNameArgs: [],
    loadGLTFLoader: 0,
  };
  const model = makeModelScene();
  const loader = makeLoader(model, { failWith: opts.failWith });
  const customModelGroup = new Group();
  const questGroup = new Group();
  questGroup.visible = true;
  for (const child of opts.staleChildren || []) customModelGroup.add(child);

  const splitParts =
    opts.splitParts ||
    [
      { mesh: makePartMesh("Lens", 4, 0, 0, 0.4), name: "Lens" },
      { mesh: makePartMesh("Housing", 1, 0.5, 0, 0.4), name: "Housing" },
      { mesh: makePartMesh("Board", -1, 0, 0, 0.4), name: "Board" },
    ];

  const instance = createCustomModelLoader({
    getState: store.getState,
    setState: store.setState,
    customModelGroup,
    questGroup,
    loadGLTFLoader: async() => {
      calls.loadGLTFLoader++;
      return loader.LoaderClass;
    },
    isQuest3Model: opts.isQuest3Model || (() => false),
    splitModelToQuest3Regions: () => {
      calls.quest3Regions++;
      return splitParts;
    },
    autoSplitModel: () => {
      calls.autoSplit++;
      return splitParts;
    },
    disposeNodeTree: node => calls.disposeNodeTree.push(node),
    yieldToMain: yieldFn,
    calculateExplodePos: calculateExplodePos,
    generatePartName: (i, center, box) => {
      calls.generatePartName++;
      calls.generatePartNameArgs.push({ i, center, box });
      return `位置名${i}`;
    },
    finalizeCustomModelLoad: (fileName, o) =>
      calls.finalizeCustomModelLoad.push({ fileName, opts: o }),
    fitCameraToModel: (group, smooth) => calls.fitCameraToModel.push({ group, smooth }),
    showStatus: (message, type) => calls.showStatus.push({ message, type }),
    setModelLoading: (loading, text) => calls.setModelLoading.push({ loading, text }),
    updateStepUI: () => {
      calls.updateStepUI++;
    },
    clearCustomModelGroup: () => {
      calls.clearCustomModelGroup++;
      // 与真实 modelDisposal.clearCustomModelGroup 的约定一致：经 setState 回落空数组
      store.setState({ customModelParts: [] });
    },
    defaultStepGroups: DEFAULT_GROUPS,
    isLowPowerMode: opts.isLowPowerMode || (() => false),
  });

  return { store, calls, yieldFn, customModelGroup, questGroup, loader, l: instance.loadCustomModel };
}

// ===== 纯数学：computeGroupCount =====
describe("computeGroupCount 步骤组数量边界", async() => {
  await it("0 / 1 个部件也至少 2 组", async() => {
    assert(computeGroupCount(0) === 2, "0 部件 → 2 组");
    assert(computeGroupCount(1) === 2, "1 部件 → 2 组");
  });
  await it("每 3 个部件一组的档位", async() => {
    assert(computeGroupCount(3) === 2, "3 部件 → 2 组");
    assert(computeGroupCount(6) === 2, "6 部件 → 2 组");
    assert(computeGroupCount(7) === 3, "7 部件 → 3 组");
    assert(computeGroupCount(15) === 5, "15 部件 → 5 组");
  });
  await it("封顶 6 组", async() => {
    assert(computeGroupCount(18) === 6, "18 部件 → 6 组");
    assert(computeGroupCount(200) === 6, "200 部件仍为 6 组");
  });
});

// ===== 纯数学：computeStepIndex =====
describe("computeStepIndex 步骤号夹取", async() => {
  await it("1 起算、按组跨步", async() => {
    assert(computeStepIndex(0, 2, 2) === 1, "首部件 → 第 1 步");
    assert(computeStepIndex(1, 2, 2) === 1, "组内第二个 → 第 1 步");
    assert(computeStepIndex(2, 2, 2) === 2, "跨组 → 第 2 步");
  });
  await it("超出末组时夹到最后一组", async() => {
    assert(computeStepIndex(3, 2, 2) === 2, "索引越界 → 夹到末组");
    assert(computeStepIndex(7, 1, 6) === 6, "单人一组越界 → 夹到 6");
  });
});

// ===== bakeAndCenterParts =====
describe("bakeAndCenterParts 烘焙与居中", async() => {
  await it("烘焙后世界包围盒不变、transform 复位", async() => {
    const a = makePartMesh("a", 5, 0, 0, 1);
    const b = makePartMesh("b", -5, 0, 0, 1);
    const splitParts = [{ mesh: a }, { mesh: b }];
    const boxBefore = new Box3().setFromObject(a).clone();
    const yieldFn = makeYield();

    await bakeAndCenterParts(splitParts, {
      yieldToMain: yieldFn,
      castShadow: true,
      receiveShadow: true,
    });

    const boxAfter = new Box3().setFromObject(a);
    assert(boxAfter.min.distanceTo(boxBefore.min) < 1e-6, "世界包围盒 min 不变");
    assert(boxAfter.max.distanceTo(boxBefore.max) < 1e-6, "世界包围盒 max 不变");
    assert(a.position.length() === 0, "position 复位到原点");
    assert(a.rotation.x === 0 && a.rotation.y === 0 && a.rotation.z === 0, "rotation 复位");
    assert(a.scale.x === 1 && a.scale.y === 1 && a.scale.z === 1, "scale 复位");
    assert(a.matrixAutoUpdate === true, "matrixAutoUpdate 置 true");
    assert(a.castShadow === true && a.receiveShadow === true, "投影/受影按注入值");
  });

  await it("按整体包围盒把几何体居中", async() => {
    const a = makePartMesh("a", 2, 0, 0, 2);
    const b = makePartMesh("b", 6, 0, 0, 2);
    await bakeAndCenterParts([{ mesh: a }, { mesh: b }], {
      yieldToMain: makeYield(),
      castShadow: false,
      receiveShadow: false,
    });
    // 世界包围盒 x∈[1,7]，中心 x=4 → 平移 -4：a→[-3,-1]，b→[1,3]
    const boxA = new Box3().setFromObject(a);
    const boxB = new Box3().setFromObject(b);
    assert(Math.abs(boxA.min.x - -3) < 1e-6 && Math.abs(boxA.max.x - -1) < 1e-6, "a 平移后 [-3,-1]");
    assert(Math.abs(boxB.min.x - 1) < 1e-6 && Math.abs(boxB.max.x - 3) < 1e-6, "b 平移后 [1,3]");
    assert(a.castShadow === false && a.receiveShadow === false, "低性能模式不投影");
  });

  await it("yield 节奏：每部件每轮一次", async() => {
    const yieldFn = makeYield();
    const splitParts = [
      { mesh: makePartMesh("a", 1, 0, 0, 1) },
      { mesh: makePartMesh("b", 2, 0, 0, 1) },
      { mesh: makePartMesh("c", 3, 0, 0, 1) },
    ];
    await bakeAndCenterParts(splitParts, {
      yieldToMain: yieldFn,
      castShadow: false,
      receiveShadow: false,
    });
    assert(yieldFn.count === 9, `3 部件 3 轮共 9 次 yield，实际 ${yieldFn.count}`);
  });
});

// ===== reorderPartsByManifest =====
describe("reorderPartsByManifest 清单贪心重排", async() => {
  function part(name, x, y, z) {
    return { name, partCenter: new Vector3(x, y, z) };
  }

  await it("按清单中心就近匹配重排", async() => {
    const parts = [part("nearA", 1, 0, 0), part("nearB", 0, 1, 0), part("far", 10, 0, 0)];
    const manifest = [{ center: [0, 1, 0] }, { center: [1, 0, 0] }];
    await reorderPartsByManifest(parts, manifest, { yieldToMain: makeYield() });
    assert(parts.map(p => p.name).join(",") === "nearB,nearA,far", "匹配项按清单序，未匹配按原序");
  });

  await it("同距时取索引小者", async() => {
    const parts = [part("first", 1, 0, 0), part("second", -1, 0, 0)];
    const manifest = [{ center: [0, 0, 0] }, { center: [0, 0, 0] }];
    await reorderPartsByManifest(parts, manifest);
    assert(parts.map(p => p.name).join(",") === "first,second", "等距先取索引小者");
  });

  await it("就地重排：不换数组引用", async() => {
    const parts = [part("a", 1, 0, 0), part("b", 0, 1, 0)];
    const ref = parts;
    await reorderPartsByManifest(parts, [{ center: [0, 1, 0] }]);
    assert(parts === ref, "数组引用不变");
    assert(parts.length === 2, "长度不变");
  });

  await it("清单比部件多时优雅跳过", async() => {
    const parts = [part("only", 1, 0, 0)];
    const manifest = [{ center: [1, 0, 0] }, { center: [5, 5, 5] }, { center: [9, 9, 9] }];
    await reorderPartsByManifest(parts, manifest);
    assert(parts.length === 1 && parts[0].name === "only", "多出的清单项被跳过");
  });

  await it("空清单保持原序", async() => {
    const parts = [part("a", 1, 0, 0), part("b", 2, 0, 0)];
    await reorderPartsByManifest(parts, []);
    assert(parts.map(p => p.name).join(",") === "a,b", "原序保留");
  });

  await it("yield 节奏：每清单项一次 + 兜底环一次", async() => {
    const yieldFn = makeYield();
    const parts = [part("a", 1, 0, 0), part("b", 2, 0, 0), part("c", 3, 0, 0), part("d", 4, 0, 0)];
    await reorderPartsByManifest(parts, [{ center: [1, 0, 0] }, { center: [2, 0, 0] }], {
      yieldToMain: yieldFn,
    });
    assert(yieldFn.count === 3, `2 清单项 + 兜底环 1 次 = 3，实际 ${yieldFn.count}`);
  });
});

// ===== loadCustomModel：非 Quest 3 主路径 =====
describe("loadCustomModel 主路径（非 Quest 3，无清单）", async() => {
  await it("完整走查：清旧 → 解析 → 拆分 → 烘焙居中 → 建部件 → 排序命名 → 收尾", async() => {
    const w = setup();
    const stale = makePartMesh("stale", 9, 9, 9, 1);
    w.customModelGroup.add(stale);

    await w.l(new ArrayBuffer(8), "robot.glb");

    // 状态栏文案序列
    const msgs = w.calls.showStatus.map(s => s.message);
    assert(msgs[0] === "📦 正在解析模型（前端 JS）...", "首条：解析方式文案");
    assert(msgs[1] === "🔍 正在分析模型结构并自动拆分...", "第二条：自动拆分文案");
    assert(msgs.some(m => m.includes("成功加载：robot.glb") && m.includes("自动拆分为 3 个部件")), "成功文案含文件名与部件数");
    assert(msgs.some(m => m.includes("正在加载模型")) === false, "未被重入守卫拦截");

    // 加载态序列
    const loading = w.calls.setModelLoading;
    assert(loading.length === 3, "三次加载态切换");
    assert(loading[0].loading === true && loading[0].text === "📦 正在解析模型...", "起：解析中");
    assert(loading[1].loading === true && loading[1].text === "🔧 正在准备部件...", "中：准备部件");
    assert(loading[2].loading === false && loading[2].text === undefined, "止：关闭");

    // 先清旧模型再解析
    assert(w.calls.clearCustomModelGroup === 1, "清旧模型一次");
    assert(w.loader.calls.parse === 1, "GLTFLoader.parse 一次");
    assert(w.loader.calls.arrayBuffer.byteLength === 8, "parse 收到原始 arrayBuffer");

    // 旧子对象摘干净，只留新部件
    assert(w.customModelGroup.children.length === 3, "旧子对象已摘除");
    assert(w.customModelGroup.children.includes(stale) === false, "陈旧子对象不在组内");

    // 原始场景释放
    assert(w.calls.disposeNodeTree.length === 1, "原始 GLTF 场景 dispose 一次");

    // 默认模型隐藏
    assert(w.questGroup.visible === false, "Quest 3 默认模型隐藏");

    // 部件数据
    const parts = w.store.state.customModelParts;
    assert(parts.length === 3, "3 个部件");
    assert(parts.every(p => p.homePos.length() === 0), "homePos 均为原点");
    assert(parts.every(p => p.explodePos.length() > 0), "explodePos 由真实 calculateExplodePos 算出");
    assert(parts.every(p => p.homeRot instanceof Euler && p.explodeRot instanceof Euler), "旋转初值为 Euler");
    assert(parts.every(p => p.name && p.name.length > 0), "名称已分配");
    assert(parts.every(p => p.mesh.name === p.name && p.mesh.userData.name === p.name), "mesh 名与 userData 同步");
    assert(parts.every(p => w.customModelGroup.children.includes(p.mesh)), "mesh 已加入组");

    // 按距离中心降序：Lens(远) → Board → Housing(近)
    assert(parts.map(p => p.name).join(",") === "Lens,Board,Housing", "距离降序排列");
    assert(
      parts[0].partCenter.length() > parts[1].partCenter.length() &&
        parts[1].partCenter.length() > parts[2].partCenter.length(),
      "partCenter 长度递减",
    );

    // 步骤索引：3 部件 → 2 组、每组 2 → [1, 1, 2]
    assert(parts.map(p => p.stepIndex).join(",") === "1,1,2", "stepIndex 分配");

    // 收尾与状态
    assert(w.calls.finalizeCustomModelLoad.length === 1, "finalizeCustomModelLoad 一次");
    assert(w.calls.finalizeCustomModelLoad[0].fileName === "robot.glb", "收尾收到文件名");
    assert(w.calls.finalizeCustomModelLoad[0].opts.adjustExplode === true, "收尾约定 adjustExplode: true");
    // 成功路径：加载器自身只写加载中标志（customModelParts 的空数组回落来自
    // 注入的 clearCustomModelGroup）；hasCustomModel / 步骤三态由（此处注入的）
    // finalizeCustomModelLoad 收尾负责，加载器不越权代写
    const patchKeys = new Set(w.store.patches.flatMap(p => Object.keys(p)));
    assert(patchKeys.has("isLoadingCustomModel"), "成功路径写了 isLoadingCustomModel");
    for (const k of ["hasCustomModel", "stepGroups", "totalSteps", "currentStep", "displayedStep"]) {
      assert(!patchKeys.has(k), `成功路径不代写 ${k}`);
    }
    assert(w.store.state.isLoadingCustomModel === false, "finally 复位加载中标志");
    assert(w.yieldFn.count > 0, "确实让出过主线程");
  });

  await it("GLB 原始名以「部件」开头时回退位置命名", async() => {
    const splitParts = [
      { mesh: makePartMesh("X", 2, 0, 0, 0.4), name: "部件0" },
      { mesh: makePartMesh("Y", 0, 2, 0, 0.4), name: "Frame" },
      { mesh: makePartMesh("Z", -2, 0, 0, 0.4), name: "部件2" },
    ];
    const w = setup({ splitParts });
    await w.l(new ArrayBuffer(8), "robot.glb");
    const parts = w.store.state.customModelParts;
    assert(w.calls.generatePartName === 2, "两个「部件」开头名称回退位置命名");
    assert(parts.filter(p => p.name.startsWith("位置名")).length === 2, "回退名称已写入");
    assert(parts.some(p => p.name === "Frame"), "正常原名保留");
    assert(
      w.calls.generatePartNameArgs.every(a => a.center instanceof Vector3 && a.box instanceof Box3),
      "generatePartName 收到部件中心与居中包围盒",
    );
  });
});

// ===== loadCustomModel：Quest 3 前端拆解路径 =====
describe("loadCustomModel Quest 3 + 前端拆解路径", async() => {
  await it("走 15 区域切割且跳过烘焙居中", async() => {
    const splitParts = [
      { mesh: makePartMesh("前面板", 2, 0, 0, 0.4), name: "前面板" },
      { mesh: makePartMesh("部件7", 0, 2, 0, 0.4), name: "部件7" },
      { mesh: makePartMesh("头带", -2, 0, 0, 0.4), name: "头带" },
    ];
    const w = setup({ isQuest3Model: () => true, splitParts });
    const posSnapshot = splitParts[0].mesh.position.clone();
    const posAttr = splitParts[0].mesh.geometry.attributes.position.array.slice();

    await w.l(new ArrayBuffer(8), "quest3.glb");

    const msgs = w.calls.showStatus.map(s => s.message);
    assert(msgs[0] === "📦 正在解析模型（前端 JS）...", "无清单 → 前端 JS 文案");
    assert(msgs[1] === "🔍 Quest 3 模型：前端按 15 部位区域切割...", "15 区域切割文案");
    assert(w.calls.quest3Regions === 1, "走 splitModelToQuest3Regions");
    assert(w.calls.autoSplit === 0, "不走 autoSplitModel");

    // 未烘焙：几何体 position 属性未被 applyMatrix4 改写
    assert(
      Array.from(splitParts[0].mesh.geometry.attributes.position.array).every(
        (v, i) => v === posAttr[i],
      ),
      "几何体未被烘焙改写",
    );
    assert(splitParts[0].mesh.position.equals(posSnapshot), "transform 未被复位");

    // 命名走「splitModelToQuest3Regions 已分配名称」分支：原名原样保留
    const names = w.store.state.customModelParts.map(p => p.name).sort();
    assert(names.join(",") === "前面板,头带,部件7", "区域名原样保留（含「部件」前缀）");
    assert(w.calls.generatePartName === 0, "不回退位置命名");
  });
});

// ===== loadCustomModel：Quest 3 + Blender 清单路径 =====
describe("loadCustomModel Quest 3 + Blender 清单路径", async() => {
  await it("按清单中心重排并采用清单名", async() => {
    // 四个部件关于原点对称 → 整体包围盒中心即原点，烘焙居中不产生位移
    const meshes = {
      p1: makePartMesh("p1", 3, 0, 0, 0.4),
      p2: makePartMesh("p2", 0, 3, 0, 0.4),
      p3: makePartMesh("p3", -3, 0, 0, 0.4),
      p4: makePartMesh("p4", 0, -3, 0, 0.4),
    };
    const splitParts = [
      { mesh: meshes.p1, name: "p1" },
      { mesh: meshes.p2, name: "p2" },
      { mesh: meshes.p3, name: "p3" },
      { mesh: meshes.p4, name: "p4" },
    ];
    const manifest = {
      parts: [
        { display_name: "左壳", center: [-3, 0, 0] },
        { display_name: "右壳", center: [3, 0, 0] },
        { display_name: "底壳", center: [0, -3, 0] },
        { display_name: "顶壳", center: [0, 3, 0] },
      ],
    };
    const w = setup({ isQuest3Model: () => true, splitParts });

    await w.l(new ArrayBuffer(8), "quest3.glb", manifest);

    const msgs = w.calls.showStatus.map(s => s.message);
    assert(msgs[0] === "📦 正在解析模型（Blender CLI）...", "清单 → Blender CLI 文案");
    assert(w.calls.autoSplit === 1, "Q3+清单仍走 autoSplitModel");
    assert(w.calls.quest3Regions === 0, "不走 15 区域切割");

    const parts = w.store.state.customModelParts;
    assert(parts.map(p => p.name).join(",") === "左壳,右壳,底壳,顶壳", "按清单中心重排后采用清单名");
    assert(parts.every(p => p.mesh.name === p.name), "mesh 名同步");
    assert(w.calls.generatePartName === 0, "不生成位置名");

    // 4 部件 → 2 组，每组 2 → [1,1,2,2]
    assert(parts.map(p => p.stepIndex).join(",") === "1,1,2,2", "清单路径 stepIndex");
    // 烘焙路径：投影标志已写入
    assert(parts.every(p => p.mesh.castShadow === true), "已烘焙路径写入 castShadow");
  });
});

// ===== loadCustomModel：重入守卫 =====
describe("loadCustomModel 重入守卫", async() => {
  await it("加载中再次调用被拦截", async() => {
    const w = setup();
    const buffer = new ArrayBuffer(8);
    const first = w.l(buffer, "a.glb"); // 不 await：停在第一个 await 处
    await w.l(buffer, "b.glb");
    await first;

    assert(w.loader.calls.parse === 1, "第二次调用没有触发解析");
    const guard = w.calls.showStatus.find(s => s.message === "⏳ 正在加载模型，请稍候...");
    assert(guard && guard.type === "info", "拦截提示已展示");
    assert(w.calls.finalizeCustomModelLoad.length === 1, "只收尾一次");
    assert(w.store.state.isLoadingCustomModel === false, "两次都结束后复位");
  });
});

// ===== loadCustomModel：失败回滚 =====
describe("loadCustomModel 失败回滚", async() => {
  await it("解析失败且有上一个模型：恢复快照", async() => {
    silenceConsoleError();
    const prev = [makePreviousPart("旧件", 1, 0, 0)];
    const w = setup({
      state: {
        hasCustomModel: true,
        customModelParts: prev,
        stepGroups: [{ name: "旧步骤" }],
        totalSteps: 5,
        currentStep: 3,
        displayedStep: 2,
      },
      failWith: "坏的 GLB",
    });

    await w.l(new ArrayBuffer(8), "bad.glb");
    restoreConsoleError();

    const err = w.calls.showStatus.find(s => s.type === "error");
    assert(err && err.message === "❌ 加载失败：解析失败：坏的 GLB", "错误提示含底层原因");
    assert(w.calls.clearCustomModelGroup === 2, "try/catch 各清一次");

    const parts = w.store.state.customModelParts;
    assert(parts.length === 1, "部件快照恢复：数量");
    assert(parts.length === 1 && parts[0].mesh === prev[0].mesh, "部件快照恢复（mesh 同引用）");
    assert(parts.length === 1 && parts[0].homePos.equals(new Vector3(1, 0, 0)), "homePos 快照值恢复");
    assert(parts.length === 1 && parts[0].name === "旧件", "名称恢复");
    assert(w.store.state.hasCustomModel === true, "hasCustomModel 恢复");
    assert(w.store.state.stepGroups[0].name === "旧步骤", "stepGroups 恢复");
    assert(
      w.store.state.totalSteps === 5 &&
        w.store.state.currentStep === 3 &&
        w.store.state.displayedStep === 2,
      "步骤三态恢复",
    );
    assert(w.customModelGroup.visible === true && w.questGroup.visible === false, "可见性恢复到自定义模型");
    assert(w.calls.updateStepUI === 1, "刷新步骤 UI");
    assert(w.calls.fitCameraToModel.length === 1, "相机重新适配");
    assert(w.calls.fitCameraToModel[0].group === w.customModelGroup, "适配到自定义模型");
    assert(w.calls.fitCameraToModel[0].smooth === false, "非平滑适配");
    assert(w.store.state.isLoadingCustomModel === false, "finally 复位");
    assert(w.calls.setModelLoading[w.calls.setModelLoading.length - 1].loading === false, "加载态关闭");
  });

  await it("解析失败且无上一个模型：回默认 Quest 3", async() => {
    silenceConsoleError();
    const w = setup({ failWith: "坏的 GLB" });
    w.questGroup.visible = false;

    await w.l(new ArrayBuffer(8), "bad.glb");
    restoreConsoleError();

    assert(w.questGroup.visible === true, "默认模型恢复可见");
    assert(w.store.state.hasCustomModel === false, "hasCustomModel 置假");
    assert(w.store.state.stepGroups === DEFAULT_GROUPS, "stepGroups 回默认（同引用）");
    assert(w.store.state.totalSteps === DEFAULT_GROUPS.length, "totalSteps 回默认长度");
    assert(w.store.state.currentStep === 0 && w.store.state.displayedStep === 0, "步骤序号归零");
    assert(w.calls.updateStepUI === 1, "刷新步骤 UI");
    assert(w.calls.fitCameraToModel[0].group === w.questGroup, "适配到默认模型");
    assert(w.store.state.isLoadingCustomModel === false, "finally 复位");
  });

  await it("空拆分结果：抛错并走回滚", async() => {
    silenceConsoleError();
    const w = setup({ splitParts: [] });
    w.questGroup.visible = false;

    await w.l(new ArrayBuffer(8), "empty.glb");
    restoreConsoleError();

    const err = w.calls.showStatus.find(s => s.type === "error");
    assert(err && err.message === "❌ 加载失败：模型中未找到可渲染的网格", "空拆分错误文案");
    assert(w.calls.autoSplit === 1, "确实走了一次拆分");
    assert(w.questGroup.visible === true, "回滚到默认模型");
    assert(w.store.state.isLoadingCustomModel === false, "finally 复位");
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
