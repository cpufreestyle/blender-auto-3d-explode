#!/usr/bin/env node
/**
 * 单元测试 — 相机自动适配（src/camera-fit.js，从 main.js 抽取）
 *
 * 抽取的不变量：
 *   - 目标点：整体包围盒中心 + (0, size.y*0.3, 0)（视线略高于几何中心）；
 *   - 距离：maxDim / sin(fov/2) * 1.5，再夹在 0.8~20；
 *   - 方向保持：新相机位姿 = 目标点 + 方向 * 距离；注意原实现的顺序细节——
 *     controls.target 先 copy 成新目标点，方向才计算，即方向取的是
 *     camera.position - 新目标点（逐字搬迁保留该行为，测试按此钉住）；
 *   - smooth=false：直接落位，不排 requestAnimationFrame；
 *   - smooth=true（缺省即真）：先同步执行一帧再经 requestAnimationFrame 逐帧
 *     三次缓动（每帧步长 0.03），progress>=1 时精确落位且不再排帧；
 *   - 空模型组（包围盒 size 0）不抛错，距离走 0.8 下限；
 *   - 末尾打一条「📐 相机适配」日志（center/size/maxDim/cameraDistance）。
 *
 * 用法：node tests/camera-fit-test.mjs
 */

import { BoxGeometry, Group, Mesh, Vector3 } from "three";
import { createCameraFitter } from "../src/camera-fit.js";

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

// ===== 桩：requestAnimationFrame 只记录不自动跑（手动步进）=====
const REAL_RAF = globalThis.requestAnimationFrame;
let frames = [];
globalThis.requestAnimationFrame = fn => {
  frames.push(fn);
  return frames.length;
};

// ===== 桩：console.log 计数 =====
const REAL_LOG = console.log;
let logCount = 0;
console.log = () => {
  logCount++;
};

function makeEnv({ fov = 60, camPos = [0, 0, 5], modelSize = [2, 2, 2], empty = false } = {}) {
  const camera = { fov, position: new Vector3(...camPos) };
  const controls = { target: new Vector3(0, 0, 0) };
  const { fitCameraToModel } = createCameraFitter({ camera, controls });
  const group = new Group();
  if (!empty) group.add(new Mesh(new BoxGeometry(...modelSize)));
  frames = [];
  logCount = 0;
  return { camera, controls, group, fitCameraToModel };
}

// 按模块真实语义复算期望：target 先落位，方向取 camera.position - 新 target
function expectedFit(camPos, size, fovDeg) {
  const target = new Vector3(0, 0 + size[1] * 0.3, 0);
  const maxDim = Math.max(...size);
  const fov = fovDeg * (Math.PI / 180);
  let d = Math.abs(maxDim / Math.sin(fov / 2)) * 1.5;
  d = Math.max(0.8, Math.min(d, 20));
  const dir = new Vector3(...camPos).sub(target).normalize();
  const newPos = target.clone().add(dir.multiplyScalar(d));
  return { target, distance: d, newPos };
}

const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const arrApprox = (v, arr, eps = 1e-6) => v.toArray().every((x, i) => approx(x, arr[i], eps));

// 手动把 rAF 队列排空（带上限防失控）
function drainFrames(maxSteps = 200) {
  let steps = 0;
  while (frames.length > 0 && steps < maxSteps) {
    const fn = frames.shift();
    fn();
    steps++;
  }
  return steps;
}

describe("camera-fit：目标点与距离", async() => {
  it("目标点为包围盒中心上移 size.y*0.3", async() => {
    const { controls, group, fitCameraToModel } = makeEnv();
    fitCameraToModel(group, false);
    assert(arrApprox(controls.target, [0, 0.6, 0]), `target = (0, 0.6, 0)（实际 ${controls.target.toArray()}）`);
  });

  it("距离 = maxDim/sin(fov/2)*1.5（fov 60、边长 2 → 6）", async() => {
    const { camera, controls, group, fitCameraToModel } = makeEnv();
    fitCameraToModel(group, false);
    const d = camera.position.distanceTo(controls.target);
    assert(approx(d, 6, 1e-6), `相机到目标距离 6（实际 ${d.toFixed(6)}）`);
  });

  it("maxDim 取三轴最大（非正方体按 y 轴算）", async() => {
    const { camera, controls, group, fitCameraToModel } = makeEnv({ modelSize: [1, 4, 1] });
    fitCameraToModel(group, false);
    const exp = expectedFit([0, 0, 5], [1, 4, 1], 60);
    const d = camera.position.distanceTo(controls.target);
    assert(approx(d, exp.distance, 1e-6), `距离取 y 轴 4 → ${exp.distance}（实际 ${d.toFixed(6)}）`);
    assert(arrApprox(controls.target, exp.target.toArray()), `target.y 抬高 size.y*0.3 = 1.2（实际 ${controls.target.y}）`);
  });

  it("距离下限 0.8（极小模型）", async() => {
    const { camera, controls, group, fitCameraToModel } = makeEnv({ modelSize: [0.1, 0.1, 0.1] });
    fitCameraToModel(group, false);
    const d = camera.position.distanceTo(controls.target);
    assert(approx(d, 0.8, 1e-6), `距离夹到 0.8（实际 ${d.toFixed(6)}）`);
  });

  it("距离上限 20（超大模型）", async() => {
    const { camera, controls, group, fitCameraToModel } = makeEnv({ modelSize: [20, 20, 20] });
    fitCameraToModel(group, false);
    const d = camera.position.distanceTo(controls.target);
    assert(approx(d, 20, 1e-6), `距离夹到 20（实际 ${d.toFixed(6)}）`);
  });

  it("空模型组不抛错且距离走下限", async() => {
    const { camera, controls, group, fitCameraToModel } = makeEnv({ empty: true });
    let threw = null;
    try {
      fitCameraToModel(group, false);
    } catch (e) {
      threw = e;
    }
    assert(threw === null, `未抛错${threw ? `（${threw.message}）` : ""}`);
    const d = camera.position.distanceTo(controls.target);
    assert(approx(d, 0.8, 1e-6), `空组距离 0.8（实际 ${d.toFixed(6)}）`);
  });

  it("偏心包围盒：中心取几何中心而非原点", async() => {
    const { controls, group, fitCameraToModel } = makeEnv({ modelSize: [1, 1, 1] });
    const mesh = group.children[0];
    mesh.position.set(3, 0, 0);
    fitCameraToModel(group, false);
    assert(arrApprox(controls.target, [3, 0.3, 0]), `target = (3, 0.3, 0)（实际 ${controls.target.toArray()}）`);
  });
});

describe("camera-fit：方向保持与非平滑落位", async() => {
  it("方向取「相机相对新目标点」的方向并保持", async() => {
    const { camera, controls, group, fitCameraToModel } = makeEnv({ camPos: [5, 0, 5] });
    fitCameraToModel(group, false);
    const exp = expectedFit([5, 0, 5], [2, 2, 2], 60);
    const dir = camera.position.clone().sub(controls.target).normalize();
    const expDir = new Vector3(5, 0, 5).sub(exp.target).normalize();
    assert(arrApprox(dir, expDir.toArray()), `方向 = (相机 - 新target) 归一化（实际 ${dir.toArray()}）`);
    assert(arrApprox(camera.position, exp.newPos.toArray()), `落位 = target + dir*6（实际 ${camera.position.toArray()}）`);
  });

  it("smooth=false 直接落位且不排帧", async() => {
    const { camera, controls, group, fitCameraToModel } = makeEnv();
    fitCameraToModel(group, false);
    const exp = expectedFit([0, 0, 5], [2, 2, 2], 60);
    assert(arrApprox(controls.target, exp.target.toArray()), `target 落位（实际 ${controls.target.toArray()}）`);
    assert(arrApprox(camera.position, exp.newPos.toArray()), `camera.position 直接落位（实际 ${camera.position.toArray()}）`);
    assert(frames.length === 0, "未排 requestAnimationFrame");
  });

  it("smooth 缺省为 true（排帧过渡）", async() => {
    const { group, fitCameraToModel } = makeEnv();
    fitCameraToModel(group);
    assert(frames.length === 1, "缺省 smooth 时排了一帧");
  });
});

describe("camera-fit：平滑过渡", async() => {
  it("首帧同步执行（progress 0.03）并排下一帧", async() => {
    const { camera, group, fitCameraToModel } = makeEnv();
    const exp = expectedFit([0, 0, 5], [2, 2, 2], 60);
    const startPos = camera.position.clone();
    fitCameraToModel(group, true);
    const ease1 = 1 - Math.pow(0.97, 3);
    assert(
      approx(camera.position.y, startPos.y + (exp.newPos.y - startPos.y) * ease1, 1e-6),
      `首帧 y 按缓动 0.0873 插值（实际 ${camera.position.y.toFixed(6)}）`,
    );
    assert(
      approx(camera.position.z, startPos.z + (exp.newPos.z - startPos.z) * ease1, 1e-6),
      `首帧 z 按缓动 0.0873 插值（实际 ${camera.position.z.toFixed(6)}）`,
    );
    assert(frames.length === 1, "首帧后续排一帧 rAF");
  });

  it("逐帧推进、progress>=1 时精确落位且不再排帧", async() => {
    const { camera, controls, group, fitCameraToModel } = makeEnv();
    const exp = expectedFit([0, 0, 5], [2, 2, 2], 60);
    fitCameraToModel(group, true);
    const steps = drainFrames();
    assert(steps < 100, `过渡在有限帧内结束（共 ${steps + 1} 帧）`);
    // 收紧到 1e-9：progress 0.99 帧的缓动残差约 1e-6，容差 1e-6 会漏杀
    // 「progress>=1 不精确落位」这类变异（残差被 lerp 摊到各分量后恰好 < 1e-6）
    assert(arrApprox(camera.position, exp.newPos.toArray(), 1e-9), `终态相机精确落位（实际 ${camera.position.toArray()}）`);
    assert(arrApprox(controls.target, exp.target.toArray(), 1e-6), "target 终态精确落位");
    assert(frames.length === 0, "终态后不再排帧");
  });

  it("缓动前快后慢（相邻帧位移递减）", async() => {
    const { camera, group, fitCameraToModel } = makeEnv();
    const exp = expectedFit([0, 0, 5], [2, 2, 2], 60);
    const startY = camera.position.y;
    fitCameraToModel(group, true);
    const y1 = camera.position.y;
    frames.shift()();
    const y2 = camera.position.y;
    frames.shift()();
    const y3 = camera.position.y;
    const d1 = Math.abs(y1 - startY);
    const d2 = Math.abs(y2 - y1);
    const d3 = Math.abs(y3 - y2);
    assert(d2 < d1 && d3 < d2, `相邻帧位移递减（${d1.toFixed(5)} > ${d2.toFixed(5)} > ${d3.toFixed(5)}）`);
    assert(d1 > Math.abs(exp.newPos.y - startY) * 0.03, "首帧缓动快于线性步长");
  });

  it("过渡起点取调用时刻的相机位姿与目标", async() => {
    const { camera, controls, group, fitCameraToModel } = makeEnv({ camPos: [0, 3, 8] });
    const exp = expectedFit([0, 3, 8], [2, 2, 2], 60);
    const startPos = camera.position.clone();
    const ease1 = 1 - Math.pow(0.97, 3);
    fitCameraToModel(group, true);
    assert(approx(camera.position.y, startPos.y + (exp.newPos.y - startPos.y) * ease1, 1e-6), "起点取调用时刻 (0,3,8)");
    // controls.target 在动画开始前已 copy 成新目标点（原实现顺序），故动画期
    // 间恒等于新目标点，lerp 的起止同为它 —— 该行为按原样钉住
    assert(arrApprox(controls.target, exp.target.toArray(), 1e-6), "target 开播前即落到新目标点且动画期不变");
  });
});

describe("camera-fit：日志", async() => {
  it("打一条相机适配日志", async() => {
    const { group, fitCameraToModel } = makeEnv();
    fitCameraToModel(group, false);
    assert(logCount === 1, `console.log 调用 1 次（实际 ${logCount}）`);
  });
});

// ===== 收尾：还原全局桩 =====
describe("camera-fit：全局还原", async() => {
  it("requestAnimationFrame 与 console.log 已还原", async() => {
    globalThis.requestAnimationFrame = REAL_RAF;
    console.log = REAL_LOG;
    assert(globalThis.requestAnimationFrame === REAL_RAF, "rAF 已还原");
    assert(console.log === REAL_LOG, "console.log 已还原");
  });
});

// ===== 顺序执行（与仓库既有测试一致）=====
(async() => {
  for (const item of describeQueue) {
    console.log(`\n── ${item.name}`);
    await item.fn();
  }
  globalThis.requestAnimationFrame = REAL_RAF;
  console.log = REAL_LOG;
  console.log("\n════════════════════════════════════════════════════════════════");
  console.log(`  结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) {
    console.error("❌ 存在失败用例:");
    failures.forEach(f => console.error(`   - ${f}`));
    process.exit(1);
  }
  console.log("  ✅ 全部测试通过！");
})();
