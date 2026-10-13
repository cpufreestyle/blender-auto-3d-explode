#!/usr/bin/env node
/**
 * 单元测试 — manifest 离线重放（src/manifest-replay.js）
 *
 * 钉住的契约：
 *   - clampProgress：NaN / Infinity / 超范围一律钳到 [0,1]
 *   - replayPlan：坏 manifest 与坏部件逐项跳过并记账，不抛错；
 *     from/to 分别取自 centroid / explodePos，size 缺失回落单位盒
 *   - replayPartTransforms：progress 0/1 正好落在两端，0.5 是中点；
 *     线性而非缓动（同一 progress 必须对应同一位置，否则滑块无法复现）
 *   - createReplayScene：代理网格数量/命名/初始位置、setProgress 生效、
 *     dispose 释放全部资源；色相按 index 均分、相邻不撞色
 *
 * 用法：node tests/manifest-replay-test.mjs
 */

import {
  clampProgress,
  replayPlan,
  replayPartTransforms,
  createReplayScene,
} from "../src/manifest-replay.js";
import { Box3, BoxGeometry, MeshStandardMaterial, Vector3 } from "three";

// ===== 测试框架（与仓库既有 .mjs 测试一致）=====
let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    console.log("  OK " + message);
    passed++;
  } else {
    console.error("  FAIL " + message);
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

// ===== 夹具 =====
function part(i, centroid, explodePos, size) {
  size = size || [1, 1, 1];
  return {
    index: i,
    name: "部件" + (i + 1),
    isOriginal: false,
    triangles: 12,
    volume: 1,
    surfaceArea: 6,
    bounds: { min: [0, 0, 0], max: size },
    size: size,
    centroid: centroid,
    explodePos: explodePos,
  };
}

function makeManifest(parts, extra) {
  return Object.assign(
    {
      version: 1,
      model: "demo",
      totalParts: parts.length,
      bounds: { min: [-2, -1, -1], max: [2, 1, 1] },
      parts: parts,
      summary: { skipped: 0, reasons: [] },
    },
    extra,
  );
}

// ===== 用例 =====

describe("clampProgress", async() => {
  await it("范围内原样返回", () => {
    assert(clampProgress(0) === 0, "0 -> 0");
    assert(clampProgress(0.37) === 0.37, "0.37 -> 0.37");
    assert(clampProgress(1) === 1, "1 -> 1");
  });
  await it("超范围钳到边界", () => {
    assert(clampProgress(-5) === 0, "-5 -> 0");
    assert(clampProgress(42) === 1, "42 -> 1");
  });
  await it("非有限值按 0 处理", () => {
    assert(clampProgress(NaN) === 0, "NaN -> 0");
    assert(clampProgress(Infinity) === 1, "Infinity -> 1");
    assert(clampProgress(-Infinity) === 0, "-Infinity -> 0");
    assert(clampProgress("abc") === 0, "非数字字符串 -> 0");
    assert(clampProgress(undefined) === 0, "undefined -> 0");
  });
});

describe("replayPlan — 结构与容错", async() => {
  await it("正常 manifest 转出计划", () => {
    const plan = replayPlan(makeManifest([part(0, [0, 0, 0], [1, 0, 0]), part(1, [2, 0, 0], [4, 0, 0])]));
    assert(plan.totalParts === 2, "两个部件");
    assert(plan.model === "demo", "model 名透传");
    assert(plan.parts[0].name === "部件1", "名字透传");
    assert(plan.parts[0].from.equals(new Vector3(0, 0, 0)), "from = centroid");
    assert(plan.parts[0].to.equals(new Vector3(1, 0, 0)), "to = explodePos");
    assert(plan.parts[1].to.equals(new Vector3(4, 0, 0)), "第二件的 to");
    assert(plan.skipped === 0, "无跳过");
    assert(plan.bounds.min.equals(new Vector3(-2, -1, -1)), "整体 bounds.min");
    assert(plan.bounds.max.equals(new Vector3(2, 1, 1)), "整体 bounds.max");
  });

  await it("manifest 不是对象 / 缺 parts 时返回空计划", () => {
    for (const bad of [null, undefined, 42, "str", {}, { parts: "x" }]) {
      const plan = replayPlan(bad);
      assert(plan.totalParts === 0, "输入 " + JSON.stringify(bad) + " -> 0 件");
      assert(plan.reasons.length > 0, "且带原因");
    }
  });

  await it("坏部件逐项跳过并记账，index 连续", () => {
    const m = makeManifest([
      part(0, [0, 0, 0], [1, 0, 0]),
      { index: 1, name: "坏件" },
      null,
      part(3, [5, 0, 0], [6, 0, 0]),
    ]);
    const plan = replayPlan(m);
    assert(plan.totalParts === 2, "只活 2 件（实测 " + plan.totalParts + "）");
    assert(plan.skipped === 2, "跳过 2 件（实测 " + plan.skipped + "）");
    assert(plan.parts[0].index === 0 && plan.parts[1].index === 1, "index 连续");
    assert(plan.parts[1].name === "部件4", "名字按输入序号回落");
    assert(plan.reasons.some((r) => r.includes("index 1")), "原因带输入序号");
  });

  await it("centroid / explodePos 缺一项即判坏", () => {
    const plan = replayPlan(makeManifest([
      { index: 0, name: "只有质心", centroid: [0, 0, 0] },
      { index: 1, name: "只有爆炸位", explodePos: [1, 0, 0] },
      part(2, [0, 0, 0], [1, 0, 0]),
    ]));
    assert(plan.totalParts === 1, "只活 1 件（实测 " + plan.totalParts + "）");
    assert(plan.skipped === 2, "跳过 2 件");
  });

  await it("size 缺失回落单位盒，数组缺项按 0", () => {
    const plan = replayPlan(makeManifest([
      { index: 0, name: "无 size", centroid: [0, 0, 0], explodePos: [1, 0, 0] },
      part(1, [0, 0, 0], [1, 0, 0], [2, 3]),
    ]));
    assert(plan.parts[0].size.equals(new Vector3(1, 1, 1)), "无 size -> 单位盒");
    // 缺的维度补 1 而不是补 0：补 0 会产出零厚度的退化盒，
    // 在重放里变成一个看不见的平面。
    assert(plan.parts[1].size.equals(new Vector3(2, 3, 1)), "短数组缺项补 1");
  });

  await it("bounds 顺序异常时记账但不抛错", () => {
    const plan = replayPlan(makeManifest([part(0, [0, 0, 0], [1, 0, 0])], {
      bounds: { min: [5, 5, 5], max: [-5, -5, -5] },
    }));
    assert(plan.totalParts === 1, "部件仍可用");
    assert(plan.reasons.some((r) => r.includes("顺序异常")), "记下异常");
  });
});


describe("replayPlan — 版本协商", async() => {
  await it("version 高于支持版本时拒绝，且 reasons 带可操作提示", () => {
    const m = makeManifest([part(0, [0, 0, 0], [1, 0, 0])]);
    m.version = 99;
    const plan = replayPlan(m);
    assert(plan.totalParts === 0, "不产出任何部件");
    assert(plan.parts.length === 0, "parts 为空");
    assert(plan.versionStatus === "unsupported", "versionStatus = unsupported");
    assert(plan.reasons.length === 1, "只有一条原因");
    assert(plan.reasons[0].includes("v99"), "原因点名文件版本（实测 " + plan.reasons[0] + "）");
    assert(plan.reasons[0].includes("升级"), "且给出行动建议");
  });

  await it("version 合法时照常解析，并回带 versionStatus", () => {
    const m = makeManifest([part(0, [0, 0, 0], [1, 0, 0])]);
    m.version = 1;
    const plan = replayPlan(m);
    assert(plan.totalParts === 1, "正常解析");
    assert(plan.versionStatus === "compatible", "versionStatus = compatible");
    assert(plan.reasons.length === 0, "无原因");
  });

  await it("无 version 字段按 v1 兼容读取，versionStatus = missing", () => {
    // 注意：makeManifest 自带 version: 1，所以这里必须显式删掉它，
    // 否则测的还是 compatible 分支——第一版就踩了这个坑。
    const m = makeManifest([part(0, [0, 0, 0], [1, 0, 0])]);
    delete m.version;
    const plan = replayPlan(m);
    assert(plan.totalParts === 1, "老文件仍可重放");
    assert(plan.versionStatus === "missing", "versionStatus = missing（实测 " + plan.versionStatus + "）");
    assert(plan.reasons.length === 0, "missing 不产生 reasons（它不是错误）");
  });

  await it("version 类型非法（字符串 / 浮点 / 0）一律拒绝", () => {
    for (const bad of ["1", 1.5, 0, -1, true]) {
      const m = makeManifest([part(0, [0, 0, 0], [1, 0, 0])]);
      m.version = bad;
      const plan = replayPlan(m);
      assert(plan.totalParts === 0, "version=" + JSON.stringify(bad) + " -> 0 件");
      assert(plan.versionStatus === "unsupported", "且 unsupported");
    }
  });

  await it("拒绝时 bounds 仍是合法对象（调用方可能直接读它）", () => {
    const m = makeManifest([part(0, [0, 0, 0], [1, 0, 0])]);
    m.version = 42;
    const plan = replayPlan(m);
    assert(!!plan.bounds && !!plan.bounds.min && !!plan.bounds.max, "bounds 结构完整");
    assert(typeof plan.bounds.min.x === "number", "min.x 是数字");
  });
});


describe("replayPartTransforms — 线性插值", async() => {
  const plan = replayPlan(makeManifest([
    part(0, [0, 0, 0], [10, 0, 0]),
    part(1, [0, 5, 0], [0, 5, 8]),
  ]));

  await it("progress 0 = 装配位，1 = 爆炸位", () => {
    const p0 = replayPartTransforms(plan, 0);
    const p1 = replayPartTransforms(plan, 1);
    assert(p0.length === 2, "与部件等长");
    assert(p0[0].equals(new Vector3(0, 0, 0)), "0% 在装配位");
    assert(p0[1].equals(new Vector3(0, 5, 0)), "第二件同样");
    assert(p1[0].equals(new Vector3(10, 0, 0)), "100% 在爆炸位");
    assert(p1[1].equals(new Vector3(0, 5, 8)), "第二件同样");
  });

  await it("0.5 是中点", () => {
    const ph = replayPartTransforms(plan, 0.5);
    assert(ph[0].equals(new Vector3(5, 0, 0)), "x 方向中点");
    assert(ph[1].equals(new Vector3(0, 5, 4)), "z 方向中点");
  });

  await it("同一 progress 两次求值结果一致（可复现）", () => {
    const a = replayPartTransforms(plan, 0.3);
    const b = replayPartTransforms(plan, 0.3);
    assert(a[0].equals(b[0]) && a[1].equals(b[1]), "逐件相等");
  });

  await it("超范围 progress 被钳制", () => {
    const neg = replayPartTransforms(plan, -3);
    const over = replayPartTransforms(plan, 9);
    assert(neg[0].equals(new Vector3(0, 0, 0)), "负值当 0");
    assert(over[0].equals(new Vector3(10, 0, 0)), "超大当 1");
  });

  await it("空计划返回空数组", () => {
    assert(replayPartTransforms(null, 0.5).length === 0, "null -> []");
    assert(replayPartTransforms({}, 0.5).length === 0, "{} -> []");
  });
});

describe("createReplayScene — three 工厂", async() => {
  await it("代理网格数量、命名与初始位置", () => {
    const plan = replayPlan(makeManifest([
      part(0, [1, 0, 0], [5, 0, 0], [2, 2, 2]),
      part(1, [-1, 0, 0], [-5, 0, 0], [1, 3, 1]),
    ]));
    const scene = createReplayScene({ plan: plan, BoxGeometry: BoxGeometry });
    assert(scene.partMeshes.length === 2, "两个代理网格");
    assert(scene.group.children.length === 2, "都挂进 group");
    assert(scene.partMeshes[0].name === "部件1", "命名来自 manifest");
    assert(scene.partMeshes[1].name === "部件2", "第二件命名");
    assert(scene.partMeshes[0].position.equals(new Vector3(1, 0, 0)), "初始在装配位");
    assert(scene.partMeshes[1].position.equals(new Vector3(-1, 0, 0)), "第二件初始位置");
    assert(scene.partMeshes[0].userData.partIndex === 0, "userData 带索引");
    assert(scene.partMeshes[0].userData.partName === "部件1", "userData 带名字");
  });

  await it("setProgress 把网格搬到插值位置", () => {
    const plan = replayPlan(makeManifest([part(0, [0, 0, 0], [10, 0, 0])]));
    const scene = createReplayScene({ plan: plan, BoxGeometry: BoxGeometry });
    scene.setProgress(0.5);
    assert(scene.partMeshes[0].position.equals(new Vector3(5, 0, 0)), "0.5 到中点");
    scene.setProgress(1);
    assert(scene.partMeshes[0].position.equals(new Vector3(10, 0, 0)), "1 到爆炸位");
    scene.setProgress(0);
    assert(scene.partMeshes[0].position.equals(new Vector3(0, 0, 0)), "0 回装配位");
    scene.setProgress(7);
    assert(scene.partMeshes[0].position.equals(new Vector3(10, 0, 0)), "超范围钳到 1");
  });

  await it("色相按 index 均分，相邻不撞色", () => {
    const hues = [];
    const plan = replayPlan(makeManifest([
      part(0, [0, 0, 0], [1, 0, 0]),
      part(1, [0, 0, 0], [1, 0, 0]),
      part(2, [0, 0, 0], [1, 0, 0]),
      part(3, [0, 0, 0], [1, 0, 0]),
    ]));
    createReplayScene({
      plan: plan,
      BoxGeometry: BoxGeometry,
      materialFactory: (hue) => {
        hues.push(hue);
        return new MeshStandardMaterial();
      },
    });
    assert(hues.length === 4, "每件取一次色");
    const diffs = hues.slice(1).map((h, i) => Math.abs(h - hues[i]));
    assert(diffs.every((d) => d > 0.01), "相邻色相都有间隔");
    assert(Math.abs(hues[3] - 0.75) < 1e-9, "末件色相 0.75（实测 " + hues[3] + "）");
  });

  await it("单部件时色相取固定值（不除以 0）", () => {
    const hues = [];
    const plan = replayPlan(makeManifest([part(0, [0, 0, 0], [1, 0, 0])]));
    createReplayScene({
      plan: plan,
      BoxGeometry: BoxGeometry,
      materialFactory: (h) => {
        hues.push(h);
        return new MeshStandardMaterial();
      },
    });
    assert(hues[0] === 0.58, "单件色相固定 0.58（实测 " + hues[0] + "）");
  });

  await it("零尺寸部件不产出退化盒", () => {
    const plan = replayPlan(makeManifest([part(0, [0, 0, 0], [1, 0, 0], [0, 0, 0])]));
    const scene = createReplayScene({ plan: plan, BoxGeometry: BoxGeometry });
    const box = new Box3().setFromObject(scene.partMeshes[0]);
    assert(!box.isEmpty(), "包围盒非空");
    const size = box.getSize(new Vector3());
    assert(size.x > 0 && size.y > 0 && size.z > 0, "三轴都有正尺寸");
  });

  await it("dispose 释放全部几何与材质并清空 group", () => {
    const disposed = [];
    // 只把 BoxGeometry 换成假的来追踪释放；材质用真的 MeshStandardMaterial，
    // 否则 new Mesh(geo, mat) 会因材质缺 three 期望的接口直接抛错。
    // 只把 BoxGeometry 换成假的来追踪释放。必须补齐 three 的 Mesh 构造会读的
    // morphAttributes / attributes 字段——少一个就在 new Mesh 里抛
    // "Cannot convert undefined or null to object"，与模块本身无关。
    const FakeGeo = class {
      constructor(w, h, d) {
        this.parameters = { width: w, height: h, depth: d };
        this.morphAttributes = {};
        this.attributes = { position: { count: 24 } };
      }
      dispose() {
        disposed.push("geo");
      }
    };
    const origDispose = MeshStandardMaterial.prototype.dispose;
    MeshStandardMaterial.prototype.dispose = function() {
      disposed.push("mat");
      return origDispose.apply(this, arguments);
    };
    const plan = replayPlan(makeManifest([
      part(0, [0, 0, 0], [1, 0, 0]),
      part(1, [0, 0, 0], [1, 0, 0]),
    ]));
    const scene = createReplayScene({
      plan: plan,
      BoxGeometry: FakeGeo,
      materialFactory: () => new MeshStandardMaterial(),
    });
    assert(scene.partMeshes.length === 2, "前提：两件");
    scene.dispose();
    assert(disposed.filter((x) => x === "geo").length === 2, "两个几何都释放");
    assert(disposed.filter((x) => x === "mat").length === 2, "两个材质都释放");
    assert(scene.partMeshes.length === 0, "partMeshes 清空");
    assert(scene.group.children.length === 0, "group 清空");
    MeshStandardMaterial.prototype.dispose = origDispose;
  });

  await it("参数不合法时抛错（不静默建空场景）", () => {
    let threw = false;
    try {
      createReplayScene({ plan: null, BoxGeometry: BoxGeometry });
    } catch {
      threw = true;
    }
    assert(threw, "plan 缺失抛错");
    threw = false;
    try {
      createReplayScene({ plan: replayPlan(makeManifest([])) });
    } catch {
      threw = true;
    }
    assert(threw, "BoxGeometry 缺失抛错");
  });
});

// ===== runner =====
(async() => {
  for (const d of describeQueue) {
    console.log("\n📋 " + d.name);
    await d.fn();
  }
  console.log("\n" + "═".repeat(60));
  console.log("  结果: " + passed + " 通过, " + failed + " 失败");
  if (failed > 0) {
    console.error("  失败项:");
    for (const f of failures) console.error("    - " + f);
    process.exit(1);
  }
  console.log("  ✅ 全部测试通过！");
})();

