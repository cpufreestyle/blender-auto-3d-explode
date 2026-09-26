#!/usr/bin/env node
/**
 * 单元测试 — Quest 3 部位匹配（src/quest3-parts.js）
 *
 * 覆盖三个导出：
 *   - nearestTemplateIndex  归一化坐标→最近模板下标（本文件重点）
 *   - assignQuest3PartNames  部件中心→贪心配对的部位名称
 *
 * 不依赖浏览器与真实模型：nearestTemplateIndex 是纯数值函数；
 * assignQuest3PartNames 只需要携带 partCenter 的普通对象与一个能回
 * getSize 的伪包围盒，因此也可以在 node 里直接跑。
 *
 * 用法：node tests/quest3-parts-test.mjs
 */

import { Box3, BoxGeometry, Group, Mesh, MeshStandardMaterial, Vector3 } from "three";

import {
  assignQuest3PartNames,
  mergePartsToQuest3,
  nearestTemplateIndex,
  splitModelToQuest3Regions,
} from "../src/quest3-parts.js";

// ===== 测试框架（与仓库斢有 .mjs 测试一致）=====
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

function assertEqual(actual, expected, message) {
  const ok = actual === expected;
  if (ok) {
    console.log(`  OK ${message}: ${actual}`);
    passed++;
  } else {
    console.error(`  FAIL ${message}: 期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(actual)}`);
    failed++;
    failures.push(message);
  }
}

const describeQueue = [];
function describe(name, fn) {
  describeQueue.push({ name, fn });
}

// ===== 内置默认模板（quest3_config.json 不可用时的回落值）=====
// 与 src/quest3-parts.js 的内置表逐条对齐；quest3_config.json 加载失败时
// 模块就用这份（node 里没有同源页面，fetch 必然失败）。
const DEFAULT_TEMPLATES = [
  ["主机身", [0.0, -0.47, -0.06]],
  ["前面板", [0.0, -0.47, 0.75]],
  ["面罩海绵", [0.0, -0.47, -0.87]],
  ["左透镜模组", [-0.42, -0.43, -0.24]],
  ["右透镜模组", [0.42, -0.43, -0.24]],
  ["左透镜", [-0.42, -0.43, -0.56]],
  ["右透镜", [0.42, -0.43, -0.56]],
  ["主板", [0.0, -0.43, -0.13]],
  ["左摄像头", [-0.6, -0.31, 0.94]],
  ["右摄像头", [0.6, -0.31, 0.94]],
  ["中置摄像头", [0.0, -0.21, 0.94]],
  ["下置追踪摄像头", [0.0, -0.79, 0.82]],
  ["左头带臂", [-1.0, -0.47, -0.06]],
  ["右头带臂", [1.0, -0.47, -0.06]],
  ["头带", [0.0, 0.45, -0.59]],
];

console.log("=".repeat(60));
console.log("  🧪 单元测试 — Quest 3 部位匹配（src/quest3-parts.js）");
console.log("=".repeat(60));

describe("nearestTemplateIndex — 每个模板自身位置召回自身下标", async() => {
  for (let i = 0; i < DEFAULT_TEMPLATES.length; i++) {
    const [name, [x, y, z]] = DEFAULT_TEMPLATES[i];
    assertEqual(nearestTemplateIndex(x, y, z), i, `模板 ${i} ${name} 自身位置`);
  }
});

describe("nearestTemplateIndex — 距离并列时取表序靠前者", async() => {
  // 左透镜模组(3) 与左透镜(5) 只差 Z，中点与两者等距（0.16），
  // 而第三近的主板(7) 距 0.4993 ——真正的二选一。
  assertEqual(nearestTemplateIndex(-0.42, -0.43, -0.4), 3, "中点落在 3/5 之间，取表序靠前的 3");
  // 向后（Z 越越 0.56）偏一点就应转向 5
  assertEqual(nearestTemplateIndex(-0.42, -0.43, -0.5), 5, "向透镜侧偏移后取 5");
  assertEqual(nearestTemplateIndex(-0.42, -0.43, -0.3), 3, "向模组侧偏移后取 3");
});

describe("nearestTemplateIndex — Y 轴权重 0.7（高度差异打折）", async() => {
  // 这个点上：权重 0.7 时胜者是 8（左摄像头）；若Y 权重变成 1.0
  // （即去掉打折），胜者会翻转成 12（左头带臂）。因此这一条能
  // 锁死 dy*dy*0.7 里的 0.7。
  assertEqual(nearestTemplateIndex(-1.5, -1.2, 0.84), 8, "打折后胜者为左摄像头(8)");
  assertEqual(nearestTemplateIndex(1.5, -1.2, 0.84), 9, "左右镜像：右侧同样取右摄像头(9)");
  // 再钉两个「权重改了就会翻」的点：这两个点上，权重取 0.5 与把 X/Z 权重对调，
  // 胜者都会变成另一个模板。没有它们，0.7 -> 0.5 与 X/Z 对调这两类改动测不出来。
  assertEqual(nearestTemplateIndex(-1.5, -1.6, 0.85), 12, "该点上权重 0.7 得左头带臂(12)；改 0.5 会翻成 8");
  assertEqual(nearestTemplateIndex(-1.5, -1.6, -1.35), 5, "该点上 X/Z 权重 1.0 得左透镜(5)；把 X/Z 对调会翻成 12");
});

describe("nearestTemplateIndex — 极端坐标与纯净性", async() => {
  assertEqual(nearestTemplateIndex(-50, 0, 0), 12, "非法向左时落到左头带臂(12)");
  assertEqual(nearestTemplateIndex(50, 0, 0), 13, "非法向右时落到右头带臂(13)");
  assertEqual(nearestTemplateIndex(0, 50, 0), 14, "极端向上时落到头带(14)");
  assertEqual(nearestTemplateIndex(0, 0, 50), 10, "极端向前时落到中置摄像头(10)");
  assertEqual(nearestTemplateIndex(0, 0, -50), 2, "极端向后时落到面罩海绵(2)");
  assertEqual(nearestTemplateIndex(0, -50, 0), 11, "极端向下时落到下置追踪摄像头(11)");
  // 纯净性：同一输入多次调用结果一致，且不改变任何入参
  const a = nearestTemplateIndex(0.1, 0.2, 0.3);
  const b = nearestTemplateIndex(0.1, 0.2, 0.3);
  assertEqual(a, b, "重复调用结果稳定");
});

// ===== assignQuest3PartNames =====
// 伪包围盒：只需回一个 Vector3 形状的尺寸。
// 半幅（与源码里一样）=(1.25, 1.0875, 0.68)。
const HALF = new Vector3(1.25, 1.0875, 0.68);
const fakeBox = { getSize: () => new Vector3(HALF.x * 2, HALF.y * 2, HALF.z * 2) };
const partAt = (tplIdx) => ({
  partCenter: new Vector3(
    DEFAULT_TEMPLATES[tplIdx][1][0] * HALF.x,
    DEFAULT_TEMPLATES[tplIdx][1][1] * HALF.y,
    DEFAULT_TEMPLATES[tplIdx][1][2] * HALF.z,
  ),
});

describe("assignQuest3PartNames — 四件套命中四个不同模板", async() => {
  const parts = [partAt(0), partAt(4), partAt(7), partAt(14)];
  const names = assignQuest3PartNames(parts, fakeBox);
  assertEqual(names.length, 4, "返回与 parts 等长");
  assertEqual(names[0], "主机身", "部件 0 命中主机身");
  assertEqual(names[1], "右透镜模组", "部件 1 命中右透镜模组");
  assertEqual(names[2], "主板", "部件 2 命中主板");
  assertEqual(names[3], "头带", "部件 3 命中头带");
});

describe("assignQuest3PartNames — 空输入直接返回空数组", async() => {
  assertEqual(assignQuest3PartNames([], fakeBox).length, 0, "parts 为空时返回 []");
});

describe("assignQuest3PartNames — 同位置两件不会抢同一个名字", async() => {
  // 贪心匹配是 1:1：两件落在同一位置，后手只能取次近的模板。
  const parts = [partAt(3), partAt(3)];
  const names = assignQuest3PartNames(parts, fakeBox);
  assertEqual(names[0], "左透镜模组", "先手得到最近的左透镜模组");
  assert(names[1] !== names[0], "后手得到另一个名字");
  assert(
    DEFAULT_TEMPLATES.some(([n]) => n === names[1]),
    "后手名字仍是模板里的合法部位名",
  );
});

describe("assignQuest3PartNames — 超过 15 件时多余的落逐个命名", async() => {
  const parts = [];
  for (let i = 0; i < DEFAULT_TEMPLATES.length; i++) parts.push(partAt(i));
  parts.push(partAt(0)); // 第 16 件，再次落在主机身位置
  parts.push(partAt(1)); // 第 17 件
  const names = assignQuest3PartNames(parts, fakeBox);
  assertEqual(names.length, 17, "返回与 parts 等长");
  const used = new Set(names.slice(0, 15));
  assertEqual(used.size, 15, "前 15 件各得一个不同模板名（贪心 1:1 生效）");
  assertEqual(names[15], "附加部件1", "第 16 件落附加部件1");
  assertEqual(names[16], "附加部件2", "第 17 件落附加部件2");
});

// ===== 集成：nearestTemplateIndex 的两个真实调用点 =====
// mergePartsToQuest3 与 splitModelToQuest3Regions 在抽取前各自内联了一份
// 逐字相同的循环；这里用真实 three.js 几何体跑通两条路径，确保改动共享
// 助手不会悄悄改变聚类归属。

const CANON_HALF = new Vector3(1.25, 1.0875, 0.68);
const fakeCanonBox = { getSize: () => new Vector3(CANON_HALF.x * 2, CANON_HALF.y * 2, CANON_HALF.z * 2) };

/** 造一个小盒子，中心落在 (x, y, z)。 */
function boxMeshAt(x, y, z, size = 0.2) {
  const geo = new BoxGeometry(size, size, size);
  geo.translate(x, y, z);
  const mesh = new Mesh(geo, new MeshStandardMaterial());
  mesh.updateMatrixWorld(true);
  return mesh;
}

describe("mergePartsToQuest3 — 四件套落入四个不同模板", async() => {
  // 前三个摆在模板自身位置，第四个故意摆在 (0, -0.5, -0.5)：这个点上「Y 归一化
  // 分母错用成 halfExtents.x」会把归属从面罩海绵(2)改判成主板(7)，从而抓住
  // 调用点里写错分母的改动（模板自身位置对这类缩放不敏感）。
  const spots = [
    DEFAULT_TEMPLATES[0][1],
    DEFAULT_TEMPLATES[4][1],
    [0.0, -0.5, -0.5],
    DEFAULT_TEMPLATES[14][1],
  ];
  // 各点天然归属的模板下标＋升序即输出顺序（对象整数键按数值排序，非插入序）
  const idxs = [0, 2, 4, 14];
  const parts = spots.map(([x, y, z]) => ({
    mesh: boxMeshAt(x * CANON_HALF.x, y * CANON_HALF.y, z * CANON_HALF.z),
    isOriginal: true,
  }));
  const merged = mergePartsToQuest3(parts, fakeCanonBox);
  assertEqual(merged.length, 4, "四件各落一组，返回 4 项");
  assertEqual(
    merged.map(p => p.name).join(","),
    idxs.map(i => DEFAULT_TEMPLATES[i][0]).join(","),
    "名称按模板下标升序（对象整数键按数值排序，非插入序）",
  );
  // 单件组直接透传原部件（不重建几何）
  for (let i = 0; i < merged.length; i++) {
    // spots 的顺序是 [T0, T4, 自定点(->T2), T14]，而 merged 按下标升序排，对应的输入件下标就是 [0, 2, 1, 3]。
    assert(merged[i].mesh === parts[[0, 2, 1, 3][i]].mesh, `第 ${i} 项透传原 mesh（未重建）`);
  }
});

describe("mergePartsToQuest3 — 同模板多件合并为一个", async() => {
  const [x, y, z] = DEFAULT_TEMPLATES[7][1]; // 主板
  const parts = [
    { mesh: boxMeshAt(x * CANON_HALF.x, y * CANON_HALF.y, z * CANON_HALF.z), isOriginal: true },
    { mesh: boxMeshAt((x + 0.02) * CANON_HALF.x, y * CANON_HALF.y, z * CANON_HALF.z), isOriginal: true },
    {
      mesh: boxMeshAt(
        DEFAULT_TEMPLATES[14][1][0] * CANON_HALF.x,
        DEFAULT_TEMPLATES[14][1][1] * CANON_HALF.y,
        DEFAULT_TEMPLATES[14][1][2] * CANON_HALF.z,
      ),
      isOriginal: true,
    },
  ];
  const merged = mergePartsToQuest3(parts, fakeCanonBox);
  assertEqual(merged.length, 2, "两件合并到主板、一件落头带，共 2 项");
  const board = merged.find(p => p.name === "主板");
  assert(!!board, "存在名为主板的合并项");
  assertEqual(board.isOriginal, false, "合并项标记 isOriginal=false");
  assertEqual(board.mesh.name, "主板", "合并后的 mesh.name 也是主板");
  assertEqual(
    board.mesh.geometry.attributes.position.count,
    2 * 36,
    "合并几何体顶点数等于两个盒子之和（BoxGeometry 索引合并后转非索引，每盒 12 三角面 = 36 顶点）",
  );
  const strap = merged.find(p => p.name === "头带");
  assert(strap && strap.mesh === parts[2].mesh, "单件组仍然透传原部件");
});

describe("mergePartsToQuest3 — 空输入原样返回", async() => {
  const empty = [];
  const out = mergePartsToQuest3(empty, fakeCanonBox);
  assert(out === empty, "空数组返回同一引用（不重建）");
  assertEqual(out.length, 0, "返回长度为 0");
});

// 完整复刻 splitModelToQuest3Regions 的「按面分配 + 面重分配」两步，
// 用来精确核对输出（不只是核对总量）。这一层是必要的：面重分配会把面从被占用
// 模板「借」给天然空白的模板，所以「落在某模板的面，其天然归属要么是自己、
// 要么目标天然空白」这种弱不变量不足以发现调用点把参数顺序写错之类的改动。
function referenceSplitFaceCounts(group, meshes) {
  const box = new Box3().setFromObject(group);
  const half = box.getSize(new Vector3()).multiplyScalar(0.5);
  const buckets = DEFAULT_TEMPLATES.map(() => []);
  const v = new Vector3();
  const tmp = new Vector3();
  for (const mesh of meshes) {
    // 源代码先把 mesh.matrixWorld 烘进几何体，参考实现必须照做
    const pos = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld).toNonIndexed().attributes.position;
    for (let f = 0; f < pos.count / 3; f++) {
      v.set(0, 0, 0);
      for (let k = 0; k < 3; k++) {
        tmp.fromBufferAttribute(pos, f * 3 + k);
        v.add(tmp);
      }
      v.divideScalar(3);
      const nx = v.x / half.x;
      const ny = v.y / half.y;
      const nz = v.z / half.z;
      buckets[nearestTemplateIndex(nx, ny, nz)].push({ nx, ny, nz });
    }
  }
  // 面重分配：天然空白的模板，从最近的已占用模板借走「最近 15%（至少 5 个、最多 50%）」的面
  for (let t = 0; t < DEFAULT_TEMPLATES.length; t++) {
    if (buckets[t].length > 0) continue;
    const ep = DEFAULT_TEMPLATES[t][1];
    let bestSourceT = -1;
    let bestSourceDist = Infinity;
    for (let s = 0; s < DEFAULT_TEMPLATES.length; s++) {
      if (s === t || buckets[s].length === 0) continue;
      const sp = DEFAULT_TEMPLATES[s][1];
      const d = Math.sqrt((ep[0] - sp[0]) ** 2 + (ep[1] - sp[1]) ** 2 * 0.7 + (ep[2] - sp[2]) ** 2);
      if (d < bestSourceDist) {
        bestSourceDist = d;
        bestSourceT = s;
      }
    }
    if (bestSourceT === -1) continue;
    const src = buckets[bestSourceT];
    src.sort(
      (a, b) =>
        Math.sqrt((a.nx - ep[0]) ** 2 + (a.ny - ep[1]) ** 2 * 0.7 + (a.nz - ep[2]) ** 2) -
        Math.sqrt((b.nx - ep[0]) ** 2 + (b.ny - ep[1]) ** 2 * 0.7 + (b.nz - ep[2]) ** 2),
    );
    const stealCount = Math.max(
      5,
      Math.min(Math.floor(src.length * 0.15), Math.floor(src.length * 0.5)),
    );
    buckets[t] = src.splice(0, stealCount);
  }
  return buckets;
}

/** 把一组「归一化空间」里的点摆成具有标准半幅的 Group，返回组与其中的 mesh。 */
function buildNormalizedGroup(spots, size = 0.12) {
  const meshes = spots.map(([x, y, z]) => boxMeshAt(x, y, z, size));
  const group = new Group();
  meshes.forEach(m => group.add(m));
  group.updateMatrixWorld(true);
  const raw = new Box3().setFromObject(group);
  const rawHalf = raw.getSize(new Vector3()).multiplyScalar(0.5);
  const kx = CANON_HALF.x / Math.max(rawHalf.x, 1e-6);
  const ky = CANON_HALF.y / Math.max(rawHalf.y, 1e-6);
  const kz = CANON_HALF.z / Math.max(rawHalf.z, 1e-6);
  const c = raw.getCenter(new Vector3());
  group.scale.set(kx, ky, kz);
  group.position.set(-c.x * kx, -c.y * ky, -c.z * kz);
  group.updateMatrixWorld(true);
  return { group, meshes };
}

describe("splitModelToQuest3Regions — 与参考实现逐模板逐面数完全一致", async() => {
  // 夹具故意覆盖几类难分辨的位置：X/Z 对调会改判的点、Y 归一化分母错用 X 半幅
  // 会改判的点、贴边的点，以及天然模板互不相同的多点组合。
  const fixtures = [
    [[0, -0.47, -0.06], [0.42, -0.43, -0.24], [0, 0.45, -0.59]],
    [[-0.6, -0.4, 0.2]],
    [[0, -0.5, -0.5], [0.5, 0.2, -1.0], [0.3, -0.5, 0.9]],
    [[0, -0.47, -0.06], [0.42, -0.43, -0.24], [0, 0.45, -0.59], [-0.6, -0.4, 0.2]],
    [
      [0, -0.47, -0.06],
      [0.42, -0.43, -0.24],
      [0, 0.45, -0.59],
      [-0.6, -0.4, 0.2],
      [0, -0.5, -0.5],
      [0.3, -0.5, 0.9],
      [0.6, -1.0, 0.4],
    ],
    [[-1, -0.47, -0.06], [1, -0.47, -0.06]],
    [[0.0, -0.47, -0.06], [0.0, -0.47, 0.75], [0.0, -0.47, -0.87]],
  ];
  for (let i = 0; i < fixtures.length; i++) {
    const { group, meshes } = buildNormalizedGroup(fixtures[i]);
    const regions = splitModelToQuest3Regions(group);
    const expected = referenceSplitFaceCounts(group, meshes)
      .map((faces, t) => ({ name: DEFAULT_TEMPLATES[t][0], faces: faces.length }))
      .filter(x => x.faces > 0);
    const actual = regions.map(r => ({
      name: r.name,
      faces: r.mesh.geometry.attributes.position.count / 3,
    }));
    assertEqual(
      JSON.stringify(actual),
      JSON.stringify(expected),
      `夹具 ${i}（${fixtures[i].length} 个盒）的区域名与面数逐一相同`,
    );
  }
});



// ===== 顺序执行所有 describe =====
for (const { name, fn } of describeQueue) {
  console.log(`\n📋 ${name}`);
  await fn();
}

console.log("\n" + "=".repeat(60));
console.log(`  结果: ${passed} 通过, ${failed} 失败`);
if (failed === 0) {
  console.log("  ✅ 全部测试通过！");
} else {
  console.log("  ❌ 有测试失败！");
  console.log("\n  失败项:");
  failures.forEach(f => console.log(`    • ${f}`));
}
console.log("=".repeat(60));

process.exit(failed > 0 ? 1 : 0);
