#!/usr/bin/env node
/**
 * 单元测试 — 乐高外观材质系统（src/lego-materials.js 的三个函数与两张表）
 *
 * getLegoMaterialForMesh 已是 tests/model-style-test.mjs 的断言基准（间接覆
 * 盖），但它内部走两条路：_nativeMaterial 命中表走原生→乐高映射（Quest 3 模
 * 型）， miss 时走 brightenToLego + makeLegoMaterial 推导（自定义模型）。后两
 * 个函数和 makeLegoGlass 此前没有任何测试盯着，而它们定的正是乐高外观的视觉
 * 常数与推色规则——改错一个数字，症状是「积木看起来像塑料玩具而不是积木」，
 * 没有任何报错。本测试直接钉住：
 *   - makeLegoMaterial：粗糙度 0.38、金属度 0、自发光 = 颜色 × 0.05；
 *   - makeLegoGlass：透光 0.9 / 厚 0.4 / 不透明度 0.7 / 粗糙 0.05；
 *   - brightenToLego：近黑一支（线性亮度 < 0.08）回落 0x2b2b2b，且回落色
 *     自身在线下、是不动点；常规一支保色相、饱和度抬到约 0.6、亮度钉 0.5，
 *     纯色相与灰阶是不动点，有色相的颜色受 8 位量化影响会差一个 LSB——两段
 *     都按现状钉死（three 的 getHSL 默认在 linear-sRGB 下度量，阈值与肉眼
 *     感知的 sRGB 亮度不是一回事，夹具的期望值按线性亮度取）；
 *   - nativeToLego ↔ materials / legoMaterials 的接线：9 对 9 严格一一对
 *     应、实例同一（main.js 的 applyModelStyle 靠实例身份换材质）。
 *
 * 用法：node tests/lego-materials-test.mjs
 */

import { Color, Material, MeshPhysicalMaterial, MeshStandardMaterial } from "three";

import {
  brightenToLego,
  legoMaterials,
  makeLegoGlass,
  makeLegoMaterial,
  materials,
  nativeToLego,
} from "../src/lego-materials.js";

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

const hslOf = hex => {
  const hsl = {};
  new Color(hex).getHSL(hsl);
  return hsl;
};

// ===== 用例 =====
describe("makeLegoMaterial — 积木塑料的外观常数", async() => {
  await it("类型与基础参数", () => {
    const m = makeLegoMaterial(0xff0000);
    assert(m instanceof MeshStandardMaterial, "是 MeshStandardMaterial");
    assert(m.roughness === 0.38, `粗糙度 0.38（实得 ${m.roughness}）`);
    assert(m.metalness === 0.0, `金属度 0（实得 ${m.metalness}）`);
    assert(m.color.getHex() === 0xff0000, "颜色原样来自入参");
  });
  await it("自发光是颜色 × 0.05", () => {
    const m = makeLegoMaterial(0xff0000);
    const expect = new Color(0xff0000).multiplyScalar(0.05).getHex();
    assert(m.emissive.getHex() === expect,
      `自发光等于颜色 × 0.05（${expect.toString(16)}，实得 ${m.emissive.getHex().toString(16)}）`);
  });
  await it("不同颜色得到不同自发光", () => {
    const a = makeLegoMaterial(0xff0000);
    const b = makeLegoMaterial(0x00ff00);
    assert(a.emissive.getHex() !== b.emissive.getHex(), "自发光随入参变化（不是把第一个颜色缓存下来）");
    assert(a !== b, "每次调用返回新材质实例");
  });
});

describe("makeLegoGlass — 透镜玻璃的外观常数", async() => {
  await it("透光与不透明度", () => {
    const g = makeLegoGlass();
    assert(g instanceof MeshPhysicalMaterial, "是 MeshPhysicalMaterial");
    assert(g.transmission === 0.9, `透光 0.9（实得 ${g.transmission}）`);
    assert(g.thickness === 0.4, `厚度 0.4（实得 ${g.thickness}）`);
    assert(g.transparent === true && g.opacity === 0.7, `transparent 且不透明度 0.7（实得 ${g.opacity}）`);
    assert(g.roughness === 0.05 && g.metalness === 0.0, "粗糙 0.05、金属度 0");
    assert(g.color.getHex() === 0x6fd0ff, `基调色 0x6fd0ff（实得 ${g.color.getHex().toString(16)}）`);
  });
});

describe("brightenToLego — 近黑一支", async() => {
  await it("纯黑与近黑回落暗塑料", () => {
    assert(brightenToLego(0x000000) === 0x2b2b2b,
      `0x000000 → 0x2b2b2b（实得 ${brightenToLego(0x000000).toString(16)}）`);
    assert(brightenToLego(0x111111) === 0x2b2b2b,
      `0x111111 → 0x2b2b2b（实得 ${brightenToLego(0x111111).toString(16)}）`);
  });
  await it("回落色自身就是不动点", () => {
    assert(brightenToLego(0x2b2b2b) === 0x2b2b2b,
      `0x2b2b2b → 0x2b2b2b（实得 ${brightenToLego(0x2b2b2b).toString(16)}）`);
    assert(brightenToLego(brightenToLego(0x000000)) === 0x2b2b2b,
      "连推两次也还是 0x2b2b2b（回落色的线性亮度本身就在线下）");
  });
  await it("0.08 分界按线性亮度走（#4a4a4a 线下、#505050 线上）", () => {
    // three 的 getHSL 默认在 linear-sRGB 下度量：#4a4a4a 线性亮度 0.0685
    // 在 0.08 线下，#505050 是 0.0802 在线上——这两个灰阶正好卡住分界两侧
    assert(brightenToLego(0x4a4a4a) === 0x2b2b2b,
      `0x4a4a4a 走近黑支（实得 ${brightenToLego(0x4a4a4a).toString(16)}）`);
    assert(brightenToLego(0x505050) === 0xe77c7c,
      `0x505050 走常规支（实得 ${brightenToLego(0x505050).toString(16)}）`);
  });
});

describe("brightenToLego — 常规一支：保色相、抬饱和、钉亮度", async() => {
  await it("纯色相是不动点", () => {
    for (const [hex, name] of [[0xff0000, "红"], [0x00ff00, "绿"], [0x0000ff, "蓝"]]) {
      const out = brightenToLego(hex);
      assert(out === hex, `${name} ${hex.toString(16)} 原样返回（实得 ${out.toString(16)}）`);
    }
  });
  await it("饱和度抬到约 0.6、亮度钉 0.5、色相保持", () => {
    for (const hex of [0xc0c0c0, 0x808080, 0x3498db, 0x88aabb]) {
      const out = brightenToLego(hex);
      const inHsl = hslOf(hex);
      const outHsl = hslOf(out);
      assert(Math.abs(outHsl.l - 0.5) < 0.01,
        `${hex.toString(16)} → 亮度 0.5（实得 ${outHsl.l.toFixed(4)}）`);
      assert(outHsl.s >= 0.6 - 0.02,
        `${hex.toString(16)} → 饱和度不小于 0.6（实得 ${outHsl.s.toFixed(4)}）`);
      assert(Math.abs(outHsl.h - inHsl.h) < 0.02,
        `${hex.toString(16)} → 色相保持（实得 ${outHsl.h.toFixed(4)} vs ${inHsl.h.toFixed(4)}）`);
    }
  });
  await it("确切值：灰阶、低饱和与 test-蓝", () => {
    assert(brightenToLego(0x808080) === 0xe77c7c,
      `0x808080 → e77c7c（实得 ${brightenToLego(0x808080).toString(16)}）`);
    assert(brightenToLego(0xc0c0c0) === 0xe77c7c,
      `0xc0c0c0 → e77c7c（实得 ${brightenToLego(0xc0c0c0).toString(16)}）`);
    assert(brightenToLego(0x88aabb) === 0x7cc7e7,
      `0x88aabb → 7cc7e7（实得 ${brightenToLego(0x88aabb).toString(16)}）`);
    assert(brightenToLego(0x3498db) === 0x3daefa,
      `0x3498db → 3daefa（实得 ${brightenToLego(0x3498db).toString(16)}）`);
  });
  await it("灰阶是不动点，有色相的颜色差一个量化步", () => {
    // 8 位量化会把 0.9075 的饱和度漂成 0.9117，再推一次 s 就被这个新值顶住，
    // 输出因此差一个 LSB——这是量化噪声而非规则不稳，按现状钉死
    assert(brightenToLego(brightenToLego(0x808080)) === 0xe77c7c, "灰阶推两次不变");
    assert(brightenToLego(brightenToLego(0x3498db)) === 0x3baefa,
      `0x3498db 推两次得 3baefa（实得 ${brightenToLego(brightenToLego(0x3498db)).toString(16)}）`);
  });
});

describe("nativeToLego ↔ materials / legoMaterials 接线", async() => {
  await it("三张表都是 9 项", () => {
    assert(Object.keys(materials).length === 9, `原生材质 9 项（实得 ${Object.keys(materials).length}）`);
    assert(Object.keys(legoMaterials).length === 9, `乐高材质 9 项（实得 ${Object.keys(legoMaterials).length}）`);
    assert(nativeToLego.size === 9, `映射 9 项（实得 ${nativeToLego.size}）`);
  });
  await it("键恰为全部原生材质、值恰为全部乐高材质", () => {
    const keySet = new Set(nativeToLego.keys());
    const nativeSet = new Set(Object.values(materials));
    assert(keySet.size === nativeSet.size && [...keySet].every(k => nativeSet.has(k)),
      "映射的键与 materials 的值逐一对上（没有漏配）");
    const valSet = new Set(nativeToLego.values());
    const legoSet = new Set(Object.values(legoMaterials));
    assert(valSet.size === legoSet.size && [...valSet].every(v => legoSet.has(v)),
      "映射的值与 legoMaterials 的值逐一对上（没有多余项）");
  });
  await it("严格一一对应（两个原生不共用同一乐高）", () => {
    assert(new Set(nativeToLego.values()).size === nativeToLego.size, "值无重复");
    assert(new Set(nativeToLego.keys()).size === nativeToLego.size, "键无重复");
  });
  await it("实例同一：切样式靠的是引用", () => {
    assert(nativeToLego.get(materials.lensGlass) === legoMaterials.lensGlass,
      "透镜玻璃映射到同一个 legoMaterials.lensGlass 实例");
    assert(nativeToLego.get(materials.body) === legoMaterials.body, "主机身同理");
  });
  await it("表里装的全是 three 材质", () => {
    const all = [...Object.values(materials), ...Object.values(legoMaterials)];
    assert(all.every(m => m instanceof Material), "18 项全部 instanceof Material");
  });
});

// ===== 变异测试记录（/tmp/mutate_legomats.py，共 14 个变异：13 杀 1 存活）=====
// 13 杀：makeLegoMaterial 粗糙度 0.38→0.5 / 自发光系数 0.05→0.1 /
//   makeLegoMaterial 金属度 0→0.2 / 玻璃基调色改值 / 玻璃透光 0.9→1.0 /
//   玻璃厚度 0.4→0.5 / 玻璃不透明度 0.7→0.9 / 玻璃粗糙度 0.05→0.1 /
//   近黑回落色改值 / 近黑阈值 0.08→0.05 / 饱和下限 0.6→0.3 /
//   推色亮度 0.5→0.6 / 映射表删掉 pcb 一行。
// 1 存活，按设计：调色板 pcb 颜色改值。main.js 的 applyModelStyle 按实例身份
//   换材质（nativeToLego 的接线才是契约，已钉死），单项目色的十六进制值是
//   调色数据而非行为——调色师 tweak 一个颜色不该被迫改测试。makeLegoGlass
//   的基调色之所以钉了，是因为它是纯工厂函数的全部输出（没有调用方能覆盖
//   它），而 legoMaterials.pcb 只是数据表的一项。
// ===== 运行 =====
(async() => {
  try {
    for (const { name, fn } of describeQueue) {
      console.log(`\n── ${name}`);
      await fn();
    }
  } catch (err) {
    console.error("运行异常:", err);
    process.exit(1);
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
