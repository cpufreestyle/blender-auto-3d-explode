#!/usr/bin/env node
/**
 * 单元测试 — 增强灯光系统（src/lighting.js，从 main.js 抽取）
 *
 * 抽取的不变量：
 *   - 五盏灯：环境光 AmbientLight / 主光 DirectionalLight / 补光
 *     DirectionalLight / 轮廓光 SpotLight / 底部反射光 DirectionalLight，
 *     全部 add 进 scene，且 scene 直系子对象恰好这 5 个；
 *   - 色值：环境/主/轮廓为 0xffffff，补光 0x99bbff，底部反射光 0x334466；
 *   - 强度按 lowPowerMode 分档（环境光两档同为 0.45）：
 *     主光 1.5/1.2、补光 0.6/0.4、轮廓 1.8/1.0、底部 0.3/0.15；
 *   - 主光是唯一投影光源：castShadow=true，阴影贴图桌面 1024、低功耗 512，
 *     bias=-0.0001、near=0.5、far=30；
 *   - 轮廓光刻意不投影（castShadow=false）：移动端/一体机 GPU 为填充率瓶颈，
 *     仅保留主光投阴影；其 angle=PI/5、penumbra=0.5、decay=2、distance=35；
 *   - position 布置：主光 (6,10,7)、补光 (-6,4,-5)、轮廓 (0,8,-7)、底部 (0,-5,0)。
 *
 * 用法：node tests/lighting-test.mjs
 */

import { Scene } from "three";
import { createLighting } from "../src/lighting.js";

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

function build(lowPowerMode) {
  const scene = new Scene();
  const lights = createLighting({ scene, lowPowerMode });
  return { scene, lights };
}

describe("五盏灯的构成与挂载", async() => {
  await it("类型与名称：环境/主/补/轮廓/底部", async() => {
    const { lights } = build(false);
    assert(lights.ambientLight.isAmbientLight === true, "ambientLight 是 AmbientLight");
    assert(lights.mainLight.isDirectionalLight === true, "mainLight 是 DirectionalLight");
    assert(lights.fillLight.isDirectionalLight === true, "fillLight 是 DirectionalLight");
    assert(lights.rimLight.isSpotLight === true, "rimLight 是 SpotLight");
    assert(lights.bottomLight.isDirectionalLight === true, "bottomLight 是 DirectionalLight");
  });

  await it("五盏灯全部 add 进 scene，且直系子对象恰好 5 个", async() => {
    const { scene, lights } = build(false);
    const all = [
      lights.ambientLight,
      lights.mainLight,
      lights.fillLight,
      lights.rimLight,
      lights.bottomLight,
    ];
    assert(
      all.every(l => scene.children.includes(l)),
      "每盏灯的父对象都是注入的 scene",
    );
    assert(scene.children.length === 5, `scene 直系 5 个子对象（实际 ${scene.children.length}）`);
    assert(
      scene.children[0] === lights.ambientLight && scene.children[4] === lights.bottomLight,
      "入场景顺序为环境光在前、底部反射光在末",
    );
  });

  await it("色值：环境/主/轮廓 0xffffff、补光 0x99bbff、底部 0x334466", async() => {
    const { lights } = build(false);
    const hex = l => l.color.getHexString();
    assert(hex(lights.ambientLight) === "ffffff", "环境光 0xffffff");
    assert(hex(lights.mainLight) === "ffffff", "主光 0xffffff");
    assert(hex(lights.fillLight) === "99bbff", `补光 0x99bbff（实际 ${hex(lights.fillLight)}）`);
    assert(hex(lights.rimLight) === "ffffff", "轮廓光 0xffffff");
    assert(hex(lights.bottomLight) === "334466", `底部反射光 0x334466（实际 ${hex(lights.bottomLight)}）`);
  });
});

describe("强度的 lowPowerMode 分档", async() => {
  await it("桌面档与低功耗档取值", async() => {
    const d = build(false).lights;
    const l = build(true).lights;
    // 名称 → [桌面档实例, 低功耗档实例, 桌面期望强度, 低功耗期望强度]
    const table = [
      ["环境光", d.ambientLight, l.ambientLight, 0.45, 0.45],
      ["主光", d.mainLight, l.mainLight, 1.5, 1.2],
      ["补光", d.fillLight, l.fillLight, 0.6, 0.4],
      ["轮廓光", d.rimLight, l.rimLight, 1.8, 1.0],
      ["底部反射光", d.bottomLight, l.bottomLight, 0.3, 0.15],
    ];
    for (const [name, dl, ll, dv, lv] of table) {
      assert(
        dl.intensity === dv && ll.intensity === lv,
        `${name} 强度 ${dv}/${lv}（实际 ${dl.intensity}/${ll.intensity}）`,
      );
    }
  });
});

describe("主光是唯一投影光源", async() => {
  await it("castShadow：主光 true，其余四盏 false", async() => {
    const { lights } = build(false);
    assert(lights.mainLight.castShadow === true, "主光投射阴影");
    assert(
      [lights.ambientLight, lights.fillLight, lights.rimLight, lights.bottomLight]
        .every(l => l.castShadow === false),
      "其余四盏灯均不投射阴影",
    );
  });

  await it("阴影贴图与相机参数：桌面 1024 / 低功耗 512", async() => {
    const d = build(false).lights;
    const l = build(true).lights;
    const m = d.mainLight.shadow.mapSize;
    assert(m.width === 1024 && m.height === 1024, `桌面阴影贴图 1024x1024（实际 ${m.width}x${m.height}）`);
    assert(l.mainLight.shadow.mapSize.width === 512, "低功耗阴影贴图 512");
    assert(l.mainLight.shadow.mapSize.height === 512, "低功耗阴影贴图纵向同为 512");
    assert(d.mainLight.shadow.bias === -0.0001, `bias=-0.0001（实际 ${d.mainLight.shadow.bias}）`);
    assert(d.mainLight.shadow.camera.near === 0.5, "shadow camera near=0.5");
    assert(d.mainLight.shadow.camera.far === 30, "shadow camera far=30");
    assert(l.mainLight.shadow.bias === -0.0001, "bias 与低功耗档无关，两档一致");
  });
});

describe("轮廓光参数与各灯 position", async() => {
  await it("轮廓光：angle=PI/5、penumbra=0.5、decay=2、distance=35", async() => {
    const { lights } = build(false);
    assert(Math.abs(lights.rimLight.angle - Math.PI / 5) < 1e-9, `angle=PI/5（实际 ${lights.rimLight.angle}）`);
    assert(lights.rimLight.penumbra === 0.5, "penumbra=0.5");
    assert(lights.rimLight.decay === 2, "decay=2");
    assert(lights.rimLight.distance === 35, "distance=35");
  });

  await it("position 布置", async() => {
    const { lights } = build(false);
    const at = (l, x, y, z) => l.position.x === x && l.position.y === y && l.position.z === z;
    assert(at(lights.mainLight, 6, 10, 7), "主光 (6,10,7)");
    assert(at(lights.fillLight, -6, 4, -5), "补光 (-6,4,-5)");
    assert(at(lights.rimLight, 0, 8, -7), "轮廓光 (0,8,-7)");
    assert(at(lights.bottomLight, 0, -5, 0), "底部反射光 (0,-5,0)");
  });

  await it("返回值与 scene 里是同一批实例", async() => {
    const { scene, lights } = build(true);
    assert(
      scene.children.every(c => Object.values(lights).includes(c)),
      "scene 的 5 个子对象全部来自返回值，未另造实例",
    );
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
