#!/usr/bin/env node
/**
 * 单元测试 — STL / URDF 前端加载器（src/model-loaders.js）
 *
 * 覆盖两个导出：
 *   - loadSTLModel  走真实的 three/examples/jsm/loaders/STLLoader.js，
 *                   喂真实二进制 STL，因此能在 node 里一路跑到收尾；
 *   - loadURDFModel 唯一的浏览器依赖是 DOMParser，本文件自带一个极简 XML
 *                   DOM 替身（只实现该函数真正用到的那几个方法），其余全是
 *                   真实 three 几何与矩阵。
 *
 * 断言的层次从「能不能跑通」到「几何对不对」。URDF 的世界变换是
 * link 世界 × visual origin 两级复合，因此用例里放了带 joint origin 的夹具，
 * 用最终 mesh 的包围盒中心反算变换是否真的复合过——只断言「有几个部件」
 * 抓不住 origin 被丢掉或写错轴。
 *
 * 用法：node tests/model-loaders-test.mjs
 */

import { Box3, Euler, Group, Matrix4, Quaternion, Vector3 } from "three";

import { loadSTLModel, loadURDFModel } from "../src/model-loaders.js";

// Quest 3 内置 15 部位名（quest3_config.json 不可用时 src/quest3-parts.js 的回落值）。
// node 里 fetch 不到配置文件，走的正是这条回落路径，因此可以直接用内置名单核对。
const QUEST3_NAMES = [
  "主机身", "前面板", "面罩海绵", "左透镜模组", "右透镜模组", "左透镜", "右透镜",
  "主板", "左摄像头", "右摄像头", "中置摄像头", "下置追踪摄像头", "左头带臂",
  "右头带臂", "头带",
];

// ===== 测试框架（与仓库其它 .mjs 测试一致）=====
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
  assert(actual === expected, `${message}（期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}）`);
}

const describeQueue = [];
function describe(name, fn) {
  describeQueue.push({ name, fn });
}

// ===== 极简 XML DOM 替身 =====
// 只实现 loadURDFModel 真正调用的方法：getAttribute / querySelector /
// querySelectorAll（后代语义，与浏览器一致）/ tag / children。
// 解析失败时不抛，而是像浏览器那样返回一个 querySelector("parsererror")
// 非空的文档，这样「XML 解析错误」那条分支也能被测到。
const REAL_DOMParser = globalThis.DOMParser;

function parseXMLNodes(text) {
  let i = 0;
  const n = text.length;
  const isWs = c => c === " " || c === "\t" || c === "\n" || c === "\r";

  function skipIgnorable() {
    for (;;) {
      if (text.startsWith("<!--", i)) {
        const e = text.indexOf("-->", i + 4);
        if (e < 0) throw new Error("注释未闭合");
        i = e + 3;
      } else if (text.startsWith("<?", i)) {
        const e = text.indexOf("?>", i + 2);
        if (e < 0) throw new Error("处理指令未闭合");
        i = e + 2;
      } else if (text.startsWith("<!", i)) {
        const e = text.indexOf(">", i + 2);
        if (e < 0) throw new Error("DOCTYPE 未闭合");
        i = e + 1;
      } else if (i < n && isWs(text[i])) i++;
      else return;
    }
  }

  function parseNode() {
    skipIgnorable();
    if (i >= n || text[i] !== "<") throw new Error("期望元素开始标签");
    i++;
    let name = "";
    while (i < n && !isWs(text[i]) && text[i] !== ">" && text[i] !== "/") {
      name += text[i];
      i++;
    }
    if (!name) throw new Error("标签名为空");
    const node = { tag: name, attrs: {}, children: [], text: "" };
    for (;;) {
      while (i < n && isWs(text[i])) i++;
      if (i >= n) throw new Error(`<${name}> 未闭合`);
      if (text[i] === "/") {
        if (text[i + 1] !== ">") throw new Error("自闭合标签缺少 >");
        i += 2;
        return node;
      }
      if (text[i] === ">") {
        i++;
        break;
      }
      let an = "";
      while (i < n && !isWs(text[i]) && text[i] !== "=" && text[i] !== ">" && text[i] !== "/") {
        an += text[i];
        i++;
      }
      if (!an) throw new Error("属性名为空");
      while (i < n && isWs(text[i])) i++;
      if (text[i] !== "=") throw new Error(`属性 ${an} 缺少 =`);
      i++;
      while (i < n && isWs(text[i])) i++;
      const q = text[i];
      if (q !== "\"" && q !== "'") throw new Error(`属性 ${an} 的值未加引号`);
      i++;
      let v = "";
      while (i < n && text[i] !== q) {
        v += text[i];
        i++;
      }
      if (i >= n) throw new Error(`属性 ${an} 的值未闭合`);
      i++;
      node.attrs[an] = v;
    }
    for (;;) {
      if (i >= n) throw new Error(`</${name}> 未闭合`);
      if (text.startsWith(`</${name}`, i)) {
        const e = text.indexOf(">", i);
        if (e < 0) throw new Error("闭合标签未结束");
        i = e + 1;
        return node;
      }
      if (text[i] === "<") node.children.push(parseNode());
      else {
        let t = "";
        while (i < n && text[i] !== "<") {
          t += text[i];
          i++;
        }
        node.text += t;
      }
    }
  }

  skipIgnorable();
  const root = parseNode();
  skipIgnorable();
  if (i < n) throw new Error("根元素之后还有内容");
  return root;
}

function wrapNode(node) {
  const self = {
    tag: node.tag,
    attrs: node.attrs,
    text: node.text.trim(),
    children: [],
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(node.attrs, k) ? node.attrs[k] : null;
    },
  };
  const descendants = list => list.flatMap(c => [c, ...descendants(c.children)]);
  self.children = node.children.map(wrapNode);
  self.querySelector = tag => descendants(self.children).find(c => c.tag === tag) || null;
  self.querySelectorAll = tag => descendants(self.children).filter(c => c.tag === tag);
  return self;
}

class FakeDOMParser {
  parseFromString(text) {
    let root;
    try {
      root = wrapNode(parseXMLNodes(text));
    } catch {
      // 与浏览器一致：解析失败不抛，给出带 parsererror 的文档
      return {
        querySelector: tag => (tag === "parsererror" ? { tag: "parsererror" } : null),
        querySelectorAll: () => [],
      };
    }
    return {
      querySelector: tag => (tag === "parsererror" ? null : root.querySelector(tag)),
      querySelectorAll: tag => root.querySelectorAll(tag),
    };
  }
}

function withDOMParser(fn) {
  globalThis.DOMParser = FakeDOMParser;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (REAL_DOMParser === undefined) delete globalThis.DOMParser;
      else globalThis.DOMParser = REAL_DOMParser;
    });
}

// ===== 二进制 STL 构造 =====
function makeBinarySTL(tris) {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  tris.forEach((t, k) => {
    const o = 84 + k * 50;
    dv.setFloat32(o + 0, t.n[0], true);
    dv.setFloat32(o + 4, t.n[1], true);
    dv.setFloat32(o + 8, t.n[2], true);
    for (let v = 0; v < 3; v++) {
      dv.setFloat32(o + 12 + v * 12 + 0, t.v[v][0], true);
      dv.setFloat32(o + 12 + v * 12 + 4, t.v[v][1], true);
      dv.setFloat32(o + 12 + v * 12 + 8, t.v[v][2], true);
    }
  });
  return buf;
}

const UNIT_TRI = { n: [0, 0, 1], v: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] };

// ===== URDF 夹具 =====
// 两个 link，第二个通过 joint origin 挂在第一个下面，用于验证变换复合。
const TWO_LINK = "<?xml version=\"1.0\"?><robot name=\"r\">" +
  "<link name=\"base\"><visual><origin xyz=\"0 0 0\" rpy=\"0 0 0\"/>" +
  "<geometry><box size=\"0.2 0.2 0.2\"/></geometry></visual></link>" +
  "<link name=\"arm\"><visual><origin xyz=\"1 0 0\" rpy=\"0 0 0\"/>" +
  "<geometry><box size=\"0.1 0.1 0.1\"/></geometry></visual></link>" +
  "<joint name=\"j1\" type=\"revolute\"><parent link=\"base\"/><child link=\"arm\"/>" +
  "<origin xyz=\"0.5 0 0\" rpy=\"0 0 0\"/></joint>" +
  "</robot>";

// 每个 link 一种几何体，覆盖 box / cylinder / sphere / 缺 geometry 四个分支
const MIXED_GEOM = "<?xml version=\"1.0\"?><robot name=\"m\">" +
  "<link name=\"b\"><visual><geometry><box size=\"0.3 0.1 0.1\"/></geometry></visual></link>" +
  "<link name=\"c\"><visual><geometry><cylinder radius=\"0.05\" length=\"0.4\"/></geometry></visual></link>" +
  "<link name=\"s\"><visual><geometry><sphere radius=\"0.07\"/></geometry></visual></link>" +
  "<link name=\"none\"><visual></visual></link>" +
  "</robot>";

// 16 个 link 铺开到不同位置，用于触发 Quest 3 合并分支（>15 才合）。
// meshLink 非空时给那个 link 换成 <mesh filename>：mesh 没有可用几何体会
// 回落成 0.08 盒子，与原来的盒子逐尺寸相同，因此两条既有用例的结果不受影响。
function quest3URDF(meshLink = null, meshFile = "meshes/frame.stl") {
  const spots = [
    [0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
    [0.7, 0.7, 0], [-0.7, 0.7, 0], [0.7, -0.7, 0], [-0.7, -0.7, 0],
    [0, 0.7, 0.7], [0, -0.7, 0.7], [0, 0.7, -0.7], [0, -0.7, -0.7], [0.5, 0, 0.5],
  ];
  let s = "<?xml version=\"1.0\"?><robot name=\"q3\">";
  spots.forEach((p, k) => {
    const geom = `l${k}` === meshLink ?
      `<geometry><mesh filename="${meshFile}"/></geometry>` :
      "<geometry><box size=\"0.08 0.08 0.08\"/></geometry>";
    s += `<link name="l${k}"><visual><origin xyz="${p[0]} ${p[1]} ${p[2]}"/>` + geom +
      "</visual></link>";
  });
  return s + "</robot>";
}

// 三级 link 链，joint origin 与 visual origin 全部带非零平移和非零 rpy。
// 这一点是刻意的：rpy 全 0 时三个 origin 都退化成平移矩阵、彼此可交换，
// 「欧拉角顺序」和「两级复合的乘序」这两类回归就全都测不出来。
const ROT_ROOT = { size: [0.4, 0.2, 0.1], xyz: [0.11, -0.07, 0.05], rpy: [0.3, 0.5, 0.7] };
const ROT_MID = { size: [0.3, 0.15, 0.25], xyz: [-0.06, 0.13, -0.09], rpy: [0.2, -0.4, 0.9] };
const ROT_TIP = { size: [0.2, 0.3, 0.12], xyz: [0.08, 0.04, -0.12], rpy: [-0.6, 0.25, 0.8] };
const ROT_J1 = { xyz: [0.6, -0.3, 0.25], rpy: [0.7, 0.1, -0.5] };
const ROT_J2 = { xyz: [-0.25, 0.45, -0.35], rpy: [-0.3, 0.65, 0.15] };

function rotChainURDF() {
  const vis = l => "<visual><origin xyz=\"" + l.xyz.join(" ") + "\" rpy=\"" + l.rpy.join(" ") +
    "\"/><geometry><box size=\"" + l.size.join(" ") + "\"/></geometry></visual>";
  const jt = (n, c, p, o) => "<joint name=\"" + n + "\" type=\"fixed\"><parent link=\"" + p +
    "\"/><child link=\"" + c + "\"/><origin xyz=\"" + o.xyz.join(" ") + "\" rpy=\"" +
    o.rpy.join(" ") + "\"/></joint>";
  return "<?xml version=\"1.0\"?><robot name=\"rot\">" +
    "<link name=\"root\">" + vis(ROT_ROOT) + "</link>" +
    "<link name=\"mid\">" + vis(ROT_MID) + "</link>" +
    "<link name=\"tip\">" + vis(ROT_TIP) + "</link>" +
    jt("j1", "mid", "root", ROT_J1) + jt("j2", "tip", "mid", ROT_J2) +
    "</robot>";
}

// 一个 origin 元素都不写的 link，和一个把 visual origin 写死的 link 放一起。
// 刻意让前者只有一个：若两个 link 都没有 visual origin，缺省值被改成非零时
// 两个 link 一起平移，收尾的整体居中会把这一模一样的位移吃掉，什么都测不到。
// 混搭之后，任一侧缺省值（joint origin / visual origin）非零都会改变两者的
// 相对位置，从而被抓到。
const NO_ORIGIN = "<?xml version=\"1.0\"?><robot name=\"n\">" +
  "<link name=\"a\"><visual><geometry><box size=\"0.2 0.2 0.2\"/></geometry></visual></link>" +
  "<link name=\"b\"><visual><origin xyz=\"0.3 0 0\"/>" +
  "<geometry><box size=\"0.1 0.3 0.1\"/></geometry></visual></link>" +
  "<joint name=\"j\"><parent link=\"a\"/><child link=\"b\"/></joint>" +
  "</robot>";

// 可选属性全部省掉：box 无 size、cylinder 分别只给 radius 和只给 length、
// sphere 无 radius、link 无 name、mesh 无 filename。各自钉住自己的缺省值。
const DEFAULTS = "<?xml version=\"1.0\"?><robot name=\"d\">" +
  "<link><visual><geometry><box/></geometry></visual></link>" +
  "<link name=\"cyl_r\"><visual><geometry><cylinder radius=\"0.1\"/></geometry></visual></link>" +
  "<link name=\"cyl_l\"><visual><geometry><cylinder length=\"0.2\"/></geometry></visual></link>" +
  "<link name=\"sph\"><visual><geometry><sphere/></geometry></visual></link>" +
  "<link name=\"nomesh\"><visual><geometry><mesh/></geometry></visual></link>" +
  "</robot>";

// ===== 假 deps =====
function makeDeps(parts) {
  const seen = { statuses: [], clearGroup: 0, finalize: [], getParts: 0 };
  const group = new Group();
  const arr = parts || [];
  const deps = {
    showStatus: (msg, type) => seen.statuses.push({ msg, type }),
    clearCustomModelGroup: () => {
      seen.clearGroup++;
      group.clear();
      arr.length = 0;
    },
    finalizeCustomModelLoad: (...a) => seen.finalize.push(a),
    customModelGroup: group,
    customModelParts: arr,
  };
  return { deps, seen, group, arr };
}

function lastStatus(seen) {
  return seen.statuses[seen.statuses.length - 1] || { msg: "", type: "" };
}
// 期望变换不借用 src 里的 makeTransform，直接用 three 的 Euler/Quaternion/
// Matrix4 自己拼：乘序（link 世界 × visual origin）在这里显式写死，欧拉角序
// 显式写成 URDF 规定的 "ZYX"。src 里任何一处乘序颠倒或角序改动都会让期望值错开。
function tfOf(xyz, rpy) {
  const q = new Quaternion().setFromEuler(new Euler(rpy[0], rpy[1], rpy[2], "ZYX"));
  return new Matrix4().compose(
    new Vector3(xyz[0], xyz[1], xyz[2]), q, new Vector3(1, 1, 1),
  );
}

// 仿射变换下，盒子的包围盒就是它 8 个角点变换后的包围盒
function boxOfBox(m, size) {
  const box = new Box3();
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        box.expandByPoint(
          new Vector3((sx * size[0]) / 2, (sy * size[1]) / 2, (sz * size[2]) / 2).applyMatrix4(m),
        );
      }
    }
  }
  return box;
}

function boxOf(min, max) {
  return new Box3(
    new Vector3(min[0], min[1], min[2]), new Vector3(max[0], max[1], max[2]),
  );
}

// 平移一份盒子：Box3.translate 只收 Vector3，这里显式写开，免得版本差异踩坑
function shiftedBox(box, dx, dy, dz) {
  return new Box3(
    new Vector3(box.min.x + dx, box.min.y + dy, box.min.z + dz),
    new Vector3(box.max.x + dx, box.max.y + dy, box.max.z + dz),
  );
}

function assertBoxEqual(actual, expected, label, tol = 1e-5) {
  assertCloseTo(actual.min.x, expected.min.x, `${label} min.x`, tol);
  assertCloseTo(actual.min.y, expected.min.y, `${label} min.y`, tol);
  assertCloseTo(actual.min.z, expected.min.z, `${label} min.z`, tol);
  assertCloseTo(actual.max.x, expected.max.x, `${label} max.x`, tol);
  assertCloseTo(actual.max.y, expected.max.y, `${label} max.y`, tol);
  assertCloseTo(actual.max.z, expected.max.z, `${label} max.z`, tol);
}


function centerOf(mesh) {
  return new Box3().setFromObject(mesh).getCenter(new Vector3());
}

// ===== loadURDFModel =====

describe("loadURDFModel — 双 link 完整链路", async() => {
  await withDOMParser(async() => {
    const parts = [{ sentinel: true }];
    const { deps, seen, group } = makeDeps(parts);
    await loadURDFModel(TWO_LINK, "arm.urdf", deps);

    assertEqual(parts.length, 2, "两个 link 各出一个部件");
    assert(parts[0].name === "arm" && parts[1].name === "base", "按离中心距离降序，远的在前");
    assertEqual(seen.clearGroup, 1, "clearCustomModelGroup 调了一次");
    assert(groupsClearedBeforePush(parts), "先清空旧部件再装配新的");
    assert(lastStatus(seen).msg.includes("✅ URDF 解析完成：2 个 link（部件）"), "成功文案带部件数");
    assertEqual(lastStatus(seen).type, "success", "成功文案为 success 级");
    assertEqual(seen.finalize.length, 1, "finalizeCustomModelLoad 调了一次");
    assertEqual(seen.finalize[0][0], "arm.urdf", "收尾拿到的是文件名");
    assertEqual(seen.finalize[0][1].modelType, "URDF", "收尾标注 URDF");
    assertEqual(seen.finalize[0][1].adjustExplode, true, "URDF 走可拆解爆炸参数");
    assertEqual(group.children.length, 2, "两个 mesh 都挂进了 customModelGroup");
    assert(seen.statuses.some(s => s.msg.includes("正在解析 URDF 结构")), "进入 loader 即有解析中提示");

    const p = parts[0];
    assertEqual(p.mesh.userData.isURDF, true, "userData 标记 isURDF");
    assertEqual(p.mesh.userData.name, "arm", "userData.name 与部件名同步");
    // 命名步骤只改 name，meshFile 跟着搬过来：这个 URDF 没有外部引用，故为空串
    assertEqual(p.mesh.userData.meshFile, "", "meshFile 字段在命名后仍在");
    assertEqual(p.mesh.position.length(), 0, "mesh 变换已烘进几何体，position 归零");
    assertEqual(p.mesh.rotation.x + p.mesh.rotation.y + p.mesh.rotation.z, 0, "rotation 归零");
    assertEqual(p.mesh.scale.x + p.mesh.scale.y + p.mesh.scale.z, 3, "scale 为 1");
    assertEqual(p.mesh.castShadow, true, "mesh 打开投影");
    assertEqual(p.mesh.receiveShadow, true, "mesh 接收投影");
    assertEqual(p.homePos.length(), 0, "homePos 为原点");
    assert(p.explodePos instanceof Vector3 && p.explodePos.length() > 0, "explodePos 是非零向量");
    assertEqual(p.homeRot.x + p.homeRot.y + p.homeRot.z, 0, "homeRot 归零");
    assertEqual(p.explodeRot.x + p.explodeRot.y + p.explodeRot.z, 0, "explodeRot 归零");
    assert(p.partCenter instanceof Vector3, "partCenter 是 Vector3");
    assertEqual(p.stepIndex, 1, "stepIndex 至少为 1");
    assertEqual(parts[1].stepIndex, 2, "2 个部件分 2 组，第二个落在第 2 步");
    assertCloseTo(p.partCenter.distanceTo(centerOf(p.mesh)), 0, "partCenter 等于部件包围盒中心");
  });
});

function groupsClearedBeforePush(parts) {
  // 传入的数组里有哨兵元素，若 loader 是先清空再装配，哨兵必然已被移除
  return !parts.some(p => p.sentinel === true);
}

describe("loadURDFModel — joint origin 与 visual origin 两级复合", async() => {
  await withDOMParser(async() => {
    const { deps, seen } = makeDeps([]);
    await loadURDFModel(TWO_LINK, "arm.urdf", deps);
    const arm = seen.statuses ? findPart(deps) : null;
    const base = arm && partsByName(deps, "base");
    const a = arm && partsByName(deps, "arm");
    assert(base !== null && a !== null, "两个部件都还在");
    if (!base || !a) return;

    // base 的世界中心 = visual origin (0,0,0)；arm 的世界中心 =
    // visual origin (1,0,0) 复合 joint origin (0.5,0,0) = (1.5,0,0)。
    // 二者相距 1.5；若 joint origin 被丢掉则只有 1.0，这条专抓那种回归。
    const cb = centerOf(base.mesh);
    const ca = centerOf(a.mesh);
    assertCloseTo(cb.distanceTo(ca), 1.5, "两级 origin 复合后两部件中心相距 1.5");
    assertCloseTo(ca.y, cb.y, "rpy 为 0 时两个中心同高");
    assertCloseTo(ca.z, cb.z, "rpy 为 0 时两个中心同纵深");
    // 尺寸没有被缩放：base 0.2、arm 0.1
    const sb = new Box3().setFromObject(base.mesh).getSize(new Vector3());
    const sa = new Box3().setFromObject(a.mesh).getSize(new Vector3());
    assertCloseTo(sb.x, 0.2, "base 盒子尺寸保持 0.2（未被缩放）");
    assertCloseTo(sa.x, 0.1, "arm 盒子尺寸保持 0.1（未被缩放）");

    // 整体包围盒居中：min 与 max 关于原点对称
    const whole = new Box3();
    for (const p of [base, a]) whole.union(new Box3().setFromObject(p.mesh));
    assertCloseTo(whole.min.x + whole.max.x, 0, "整体包围盒 X 居中");
    assertCloseTo(whole.min.y + whole.max.y, 0, "整体包围盒 Y 居中");
    assertCloseTo(whole.min.z + whole.max.z, 0, "整体包围盒 Z 居中");
  });
});

function partsByName(deps, name) {
  return deps.customModelParts.find(p => p.name === name) || null;
}
function findPart(deps) {
  return deps.customModelParts[0] || null;
}
function assertCloseTo(actual, expected, message, tol = 1e-6) {
  assert(Math.abs(actual - expected) <= tol, `${message}（期望 ${expected}±${tol}，实得 ${actual}）`);
}

describe("loadURDFModel — 四种几何体分支各走各的构造", async() => {
  await withDOMParser(async() => {
    const { deps } = makeDeps([]);
    await loadURDFModel(MIXED_GEOM, "mix.urdf", deps);
    const names = deps.customModelParts.map(p => p.name);
    assert(
      names.includes("b") && names.includes("c") && names.includes("s") && names.includes("none"),
      "四个 link 都出部件",
    );
    const b = partsByName(deps, "b");
    const c = partsByName(deps, "c");
    const s = partsByName(deps, "s");
    const none = partsByName(deps, "none");
    if (!b || !c || !s || !none) return;

    assertEqual(b.mesh.geometry.type, "BoxGeometry", "box 元素走 BoxGeometry");
    assertEqual(c.mesh.geometry.type, "CylinderGeometry", "cylinder 元素走 CylinderGeometry");
    assertEqual(s.mesh.geometry.type, "SphereGeometry", "sphere 元素走 SphereGeometry");
    assertEqual(none.mesh.geometry.type, "BoxGeometry", "没有 geometry 时回落成小盒子");

    // URDF 圆柱沿 Z 轴：rotateX(PI/2) 之后长度落在 Z 上，直径落在 X/Y 上
    const cs = new Box3().setFromObject(c.mesh).getSize(new Vector3());
    assertCloseTo(cs.z, 0.4, "圆柱长度落在 Z 轴");
    assertCloseTo(cs.x, 0.1, "圆柱直径落在 X 轴");
    assertCloseTo(cs.y, 0.1, "圆柱直径落在 Y 轴");

    // 球：包围球半径就是 radius
    s.mesh.geometry.computeBoundingSphere();
    assertCloseTo(s.mesh.geometry.boundingSphere.radius, 0.07, "球半径保持 0.07");

    // 缺 geometry 的 link 用 0.08 的小盒
    const ns = new Box3().setFromObject(none.mesh).getSize(new Vector3());
    assertCloseTo(ns.x, 0.08, "回落盒子边长为 0.08");
  });
});

describe("loadURDFModel — 失败分支不产生半成品", async() => {
  await withDOMParser(async() => {
    // 1) 一个 link 都没有
    const parts = [];
    const d1 = makeDeps(parts);
    await loadURDFModel("<?xml version=\"1.0\"?><robot name=\"empty\"></robot>", "e.urdf", d1.deps);
    assertEqual(parts.length, 0, "没有 link 时不产出部件");
    assert(lastStatus(d1.seen).msg === "❌ URDF 解析失败: URDF 中未找到任何 link", "既定文案");
    assertEqual(lastStatus(d1.seen).type, "error", "失败为 error 级");
    assertEqual(d1.seen.finalize.length, 0, "失败时不走收尾");
    assertEqual(d1.seen.clearGroup, 0, "没有 link 时连旧模型都不清");

    // 2) XML 语法坏
    const d2 = makeDeps([]);
    await loadURDFModel("<robot><link name='a'>", "bad.urdf", d2.deps);
    assert(lastStatus(d2.seen).msg === "❌ URDF 解析失败: URDF XML 解析错误", "语法错误既定文案");
    assertEqual(d2.seen.clearGroup, 0, "语法错误时同样不清旧模型");
  });
});

describe("loadURDFModel — mesh 引用的提示", async() => {
  await withDOMParser(async() => {
    const withMesh = "<?xml version=\"1.0\"?><robot name=\"r\">" +
      "<link name=\"l0\"><visual><geometry><mesh filename=\"meshes/arm.dae\"/></geometry></visual></link>" +
      "</robot>";
    const { deps, seen } = makeDeps([]);
    await loadURDFModel(withMesh, "ref.urdf", deps);
    const p = partsByName(deps, "l0");
    assert(p !== null, "mesh 引用的 link 也出部件");
    if (!p) return;
    // 装配阶段把外部文件名写进 mesh.userData.meshFile，命名步骤只改 name，
    // 文件名一路活到收尾，于是这条提示真的会出现
    assertEqual(p.mesh.userData.meshFile, "meshes/arm.dae", "外部 mesh 文件名存活到收尾");
    assert(
      lastStatus(seen).msg.includes(
        "⚠️ 注意: URDF 引用的 mesh 文件 (meshes/arm.dae) 需单独上传\n当前使用占位几何体",
      ),
      "引用外部 mesh 时给出「需单独上传」提示",
    );
    assert(lastStatus(seen).msg.includes("✅ URDF 解析完成"), "正常成功文案仍在");

    // <mesh/> 一个属性都不给：meshFile 取空串。即便 userData 能存活到收尾，
    // 空串也不该触发「需单独上传」提示——这条在既有问题修复前后都应成立。
    const d2 = makeDeps([]);
    await loadURDFModel(
      "<?xml version=\"1.0\"?><robot name=\"r\">" +
        "<link name=\"nl\"><visual><geometry><mesh/></geometry></visual></link>" +
        "</robot>",
      "nofile.urdf",
      d2.deps,
    );
    assert(!lastStatus(d2.seen).msg.includes("需单独上传"), "没有 filename 时不触发 mesh 提示");
    assert(lastStatus(d2.seen).msg.includes("✅ URDF 解析完成"), "没有 filename 时同样成功");
  });
});

describe("loadURDFModel — Quest 3 按 15 部位聚类合并", async() => {
  await withDOMParser(async() => {
    // 非 Quest 3 文件名：16 个 link 原样保留
    const d1 = makeDeps([]);
    await loadURDFModel(quest3URDF(), "plain.urdf", d1.deps);
    assertEqual(d1.deps.customModelParts.length, 16, "非 Quest 3 不合并，16 个都在");
    assert(
      d1.deps.customModelParts.every(p => /^l\d+$/.test(p.name)),
      "非 Quest 3 用原始 link 名",
    );

    // Quest 3 文件名：超过 15 个才合并
    const d2 = makeDeps([]);
    await loadURDFModel(quest3URDF(), "quest3-head.urdf", d2.deps);
    const after = d2.deps.customModelParts;
    assert(after.length <= 15 && after.length > 0, `合并后不超过 15 个（实得 ${after.length}）`);
    assert(
      after.every(p => QUEST3_NAMES.includes(p.name)),
      "合并后每个部件都用 Quest 3 原始部位名",
    );
    assertEqual(new Set(after.map(p => p.name)).size, after.length, "部位名不重复");
    assert(
      d2.seen.statuses.some(s => s.msg.includes("按 15 部位聚类合并")),
      "有聚类合并的进行中文案",
    );
    assert(lastStatus(d2.seen).msg.includes(`✅ URDF 解析完成：${after.length} 个 link（部件）`),
      "成功文案报告的是合并后的部件数");
  });
});

describe("loadURDFModel — Quest 3 合并后外部 mesh 引用不丢", async() => {
  await withDOMParser(async() => {
    const { deps, seen } = makeDeps([]);
    await loadURDFModel(quest3URDF("l3"), "quest3-head.urdf", deps);
    const parts = deps.customModelParts;
    assert(parts.length > 0 && parts.length <= 15, `合并后不超过 15 个部件（实得 ${parts.length}）`);

    // 带着 <mesh filename> 的 link 会被并进某个聚类；合并会重建 mesh 与
    // userData，文件名必须一起搬过去，否则收尾的提示在合并场景下又哑了
    assert(
      parts.some(p => p.mesh.userData.meshFile === "meshes/frame.stl"),
      "合并后的部件里仍有人带着外部 mesh 文件名",
    );
    assert(
      lastStatus(seen).msg.includes(
        "⚠️ 注意: URDF 引用的 mesh 文件 (meshes/frame.stl) 需单独上传",
      ),
      "合并之后仍给出「需单独上传」提示",
    );
  });
});

describe("loadURDFModel — 恰好 15 个 link 不触发合并", async() => {
  await withDOMParser(async() => {
    let s = "<?xml version=\"1.0\"?><robot name=\"q\">";
    for (let k = 0; k < 15; k++) {
      s += `<link name="k${k}"><visual><geometry><box size="0.05 0.05 0.05"/></geometry></visual></link>`;
    }
    s += "</robot>";
    const { deps, seen } = makeDeps([]);
    await loadURDFModel(s, "quest3-exact.urdf", deps);
    assertEqual(deps.customModelParts.length, 15, "恰好 15 个部件");
    // 合并与命名是两个独立分支：合并要 >15，命名只要文件名像 Quest 3。
    // 这里验的是「15 个不合并，但命名仍然走 Quest 3 部位表」。
    assert(!seen.statuses.some(s => s.msg.includes("聚类合并")), "没有走聚类合并");
    assert(
      deps.customModelParts.every(p => QUEST3_NAMES.includes(p.name)),
      "不合并但命名仍走 Quest 3 部位表",
    );
    assert(
      deps.customModelParts.every(p => p.mesh.userData.isURDF === true),
      "Quest 3 命名替换 userData 后仍标记 isURDF",
    );
  });
});

describe("loadURDFModel — 三级 link 链：旋转参与且乘序正确", async() => {
  await withDOMParser(async() => {
    const { deps } = makeDeps([]);
    await loadURDFModel(rotChainURDF(), "chain.urdf", deps);
    const parts = deps.customModelParts;
    assertEqual(parts.length, 3, "三个 link 各出一个部件");

    // 期望世界变换：root 没有 joint，世界矩阵是单位阵；mid = root × joint j1；
    // tip = mid × joint j2；每个部件的盒子再各自乘上自己的 visual origin。
    const wMid = new Matrix4().multiplyMatrices(new Matrix4(), tfOf(ROT_J1.xyz, ROT_J1.rpy));
    const wTip = new Matrix4().multiplyMatrices(wMid, tfOf(ROT_J2.xyz, ROT_J2.rpy));
    const expected = {
      root: boxOfBox(
        new Matrix4().multiplyMatrices(new Matrix4(), tfOf(ROT_ROOT.xyz, ROT_ROOT.rpy)),
        ROT_ROOT.size,
      ),
      mid: boxOfBox(
        new Matrix4().multiplyMatrices(wMid, tfOf(ROT_MID.xyz, ROT_MID.rpy)),
        ROT_MID.size,
      ),
      tip: boxOfBox(
        new Matrix4().multiplyMatrices(wTip, tfOf(ROT_TIP.xyz, ROT_TIP.rpy)),
        ROT_TIP.size,
      ),
    };

    // loader 收尾把整体中心平到原点，期望值跟着平移同样的量
    const whole = new Box3();
    for (const b of Object.values(expected)) whole.union(b);
    const shift = whole.getCenter(new Vector3());

    for (const [name, box] of Object.entries(expected)) {
      const part = partsByName(deps, name);
      assert(part !== null, `部件 ${name} 存在`);
      if (!part) continue;
      const moved = shiftedBox(box, -shift.x, -shift.y, -shift.z);
      assertBoxEqual(new Box3().setFromObject(part.mesh), moved, `${name} 烘焙后的世界包围盒`);
    }

    // 兜底：确认这条夹具真的把旋转放进去了。哪天有人把 rpy 改回 0，这里先炸。
    const rootSize = new Box3().setFromObject(partsByName(deps, "root").mesh).getSize(new Vector3());
    assert(
      Math.abs(rootSize.x - ROT_ROOT.size[0]) > 1e-3 &&
        Math.abs(rootSize.y - ROT_ROOT.size[1]) > 1e-3,
      "root 的包围盒尺寸因 rpy 旋转而改变（夹具没有退化成纯平移）",
    );
  });
});

describe("loadURDFModel — 没有 origin 元素时缺省为 0", async() => {
  await withDOMParser(async() => {
    const { deps } = makeDeps([]);
    await loadURDFModel(NO_ORIGIN, "no-origin.urdf", deps);
    assertEqual(deps.customModelParts.length, 2, "两个 link 各出一个部件");
    const a = partsByName(deps, "a");
    const b = partsByName(deps, "b");
    assert(a !== null && b !== null, "两个部件都在");
    if (!a || !b) return;

    // a 没有任何 origin：世界变换与 visual origin 都是单位阵，a 的盒子就停在
    // 原始位置；b 只带一个 (0.3, 0, 0) 的 visual origin，joint origin 缺省为 0。
    // 两者相距 0.3，任一缺省值被改成非零都会把这个距离撑开。
    assertBoxEqual(
      new Box3().setFromObject(a.mesh),
      boxOf([-0.225, -0.1, -0.1], [-0.025, 0.1, 0.1]),
      "a 的包围盒（整体居中后）",
    );
    assertBoxEqual(
      new Box3().setFromObject(b.mesh),
      boxOf([0.125, -0.15, -0.05], [0.225, 0.15, 0.05]),
      "b 的包围盒（整体居中后）",
    );
    assertCloseTo(centerOf(a.mesh).distanceTo(centerOf(b.mesh)), 0.3, "两个部件中心仍相距 0.3");
  });
});

describe("loadURDFModel — 尺寸 / 名字 / filename 的缺省值各就各位", async() => {
  await withDOMParser(async() => {
    const { deps } = makeDeps([]);
    await loadURDFModel(DEFAULTS, "defaults.urdf", deps);
    assertEqual(deps.customModelParts.length, 5, "五个 link 各出一个部件");

    // 省略 name 的 link 用 link_序号 兜底
    const noName = partsByName(deps, "link_0");
    assert(noName !== null, "没有 name 的 link 兜底成 link_0");
    if (noName) {
      assertEqual(noName.name, "link_0", "部件名也是 link_0");
      assertEqual(noName.mesh.name, "link_0", "mesh.name 同步为 link_0");
      assertBoxEqual(
        new Box3().setFromObject(noName.mesh),
        boxOf([-0.05, -0.05, -0.05], [0.05, 0.05, 0.05]),
        "box 无 size 时缺省 0.1 立方",
      );
    }

    // 只给 radius：长度走缺省
    const cylR = partsByName(deps, "cyl_r");
    assert(cylR !== null, "cyl_r 存在");
    if (cylR) {
      const s = new Box3().setFromObject(cylR.mesh).getSize(new Vector3());
      assertCloseTo(s.x, 0.2, "radius 0.1 决定直径 0.2");
      assertCloseTo(s.y, 0.2, "直径同样落在 Y 轴");
      assertCloseTo(s.z, 0.1, "只给 radius 时 length 缺省 0.1");
    }

    // 只给 length：半径走缺省
    const cylL = partsByName(deps, "cyl_l");
    assert(cylL !== null, "cyl_l 存在");
    if (cylL) {
      const s = new Box3().setFromObject(cylL.mesh).getSize(new Vector3());
      assertCloseTo(s.x, 0.1, "只给 length 时 radius 缺省 0.05（直径 0.1）");
      assertCloseTo(s.y, 0.1, "直径同样落在 Y 轴");
      assertCloseTo(s.z, 0.2, "length 0.2 落在 Z 轴");
    }

    // 没有 radius 的球
    const sph = partsByName(deps, "sph");
    assert(sph !== null, "sph 存在");
    if (sph) {
      assertEqual(sph.mesh.geometry.type, "SphereGeometry", "sphere 走 SphereGeometry");
      sph.mesh.geometry.computeBoundingSphere();
      assertCloseTo(sph.mesh.geometry.boundingSphere.radius, 0.05, "球半径缺省 0.05");
    }

    // 没有 filename 的 mesh 引用：回落成小盒子，且同样待在原点
    const noMesh = partsByName(deps, "nomesh");
    assert(noMesh !== null, "nomesh 存在");
    if (noMesh) {
      assertEqual(noMesh.mesh.geometry.type, "BoxGeometry", "无 filename 的 mesh 也回落成盒子");
      assertCloseTo(noMesh.partCenter.length(), 0, "它与其他部件一样待在原点");
    }

    // 5 个部件：组数 = clamp(ceil(5/3), 2, 6) = 2，于是每组 3 个、共 2 组
    assertEqual(
      JSON.stringify(deps.customModelParts.map(p => p.stepIndex).sort((x, y) => x - y)),
      JSON.stringify([1, 1, 1, 2, 2]),
      "5 个部件的 stepIndex 按 2 组 3+2 分配",
    );
  });
});

// ===== loadSTLModel =====

describe("loadSTLModel — 真实 STLLoader 完整链路", async() => {
  const buf = makeBinarySTL([UNIT_TRI]);
  const parts = [];
  const { deps, seen, group } = makeDeps(parts);
  await loadSTLModel(buf, "part.stl", deps);

  assertEqual(parts.length, 1, "STL 是单部件");
  assertEqual(parts[0].name, "part.stl", "非 Quest 3 用文件名作部件名");
  assertEqual(parts[0].mesh.geometry.attributes.position.count, 3, "一个三角形 = 3 个顶点");
  assertEqual(group.children.length, 1, "mesh 挂进了 customModelGroup");
  assertEqual(seen.clearGroup, 1, "clearCustomModelGroup 调了一次");
  assertEqual(seen.finalize.length, 1, "finalizeCustomModelLoad 调了一次");
  assertEqual(seen.finalize[0][0], "part.stl", "收尾拿到文件名");
  assertEqual(seen.finalize[0][1].modelType, "STL", "收尾标注 STL");
  assertEqual(seen.finalize[0][1].adjustExplode, false, "STL 不可拆解，adjustExplode 为 false");
  assert(lastStatus(seen).msg.includes("✅ STL 模型加载完成（单部件）"), "成功文案");
  assertEqual(lastStatus(seen).type, "success", "成功为 success 级");
  assertEqual(parts[0].mesh.userData.meshFile, undefined, "STL 没有外部 mesh 引用字段");

  // 归一化：最大边被放大到 2.0，再整体居中
  const size = new Box3().setFromObject(parts[0].mesh).getSize(new Vector3());
  assertCloseTo(Math.max(size.x, size.y, size.z), 2.0, "最大边归一化到 2.0");
  const box = new Box3().setFromObject(parts[0].mesh);
  assertCloseTo(box.min.x + box.max.x, 0, "X 已居中");
  assertCloseTo(box.min.y + box.max.y, 0, "Y 已居中");
});

describe("loadSTLModel — 部件数据结构与 URDF 一致", async() => {
  const { deps } = makeDeps([]);
  await loadSTLModel(makeBinarySTL([UNIT_TRI]), "s.stl", deps);
  const p = deps.customModelParts[0];
  assertEqual(p.homePos.length(), 0, "homePos 为原点");
  assert(p.explodePos instanceof Vector3 && p.explodePos.length() > 0, "explodePos 是非零向量");
  assertEqual(p.homeRot.x + p.homeRot.y + p.homeRot.z, 0, "homeRot 归零");
  assertEqual(p.explodeRot.x + p.explodeRot.y + p.explodeRot.z, 0, "explodeRot 归零");
  assert(p.partCenter instanceof Vector3, "partCenter 是 Vector3");
  assertEqual(p.stepIndex, 1, "stepIndex 至少为 1");
  assertEqual(p.mesh.matrixAutoUpdate, true, "matrixAutoUpdate 打开");
  assert(p.mesh.userData.name === "s.stl", "userData.name 同步为部件名");
});

describe("loadSTLModel — 两个分离三角形仍归一化为一个部件", async() => {
  const far = {
    n: [0, 0, 1],
    v: [[10, 0, 0], [11, 0, 0], [10, 1, 0]],
  };
  const { deps } = makeDeps([]);
  await loadSTLModel(makeBinarySTL([UNIT_TRI, far]), "two.stl", deps);
  assertEqual(deps.customModelParts.length, 1, "仍是单部件");
  assertEqual(deps.customModelParts[0].mesh.geometry.attributes.position.count, 6, "两个三角形 6 个顶点");
  const box = new Box3().setFromObject(deps.customModelParts[0].mesh);
  assertCloseTo(box.min.x + box.max.x, 0, "X 居中");
  assertCloseTo(box.min.y + box.max.y, 0, "Y 居中");
});

describe("loadSTLModel — Quest 3 文件名改用部位名", async() => {
  const { deps } = makeDeps([]);
  await loadSTLModel(makeBinarySTL([UNIT_TRI]), "quest3-body.stl", deps);
  assert(QUEST3_NAMES.includes(deps.customModelParts[0].name), "名字取自 Quest 3 部位表");
  assert(deps.customModelParts[0].name !== "quest3-body.stl", "不再用文件名");
});

describe("loadSTLModel — 坏输入走 catch 且不产出部件", async() => {
  const parts = [];
  const d1 = makeDeps(parts);
  await loadSTLModel(makeBinarySTL([]), "empty.stl", d1.deps);
  // 0 个三角形时 STLLoader 给出空几何体：maxDim 为 0 故 scale 取 1.0，
  // 不抛错，照常产出 1 个空部件并走完收尾。这条钉住「不崩」这个既有行为。
  assertEqual(parts.length, 1, "0 个三角形仍产出 1 个部件（空几何体）");
  assertEqual(parts[0].mesh.geometry.attributes.position.count, 0, "该部件没有顶点");
  assert(lastStatus(d1.seen).msg.includes("✅ STL 模型加载完成"), "空几何体也走成功文案");
  assertEqual(d1.seen.finalize.length, 1, "空几何体也走收尾");
  assertEqual(parts[0].mesh.userData.name, "empty.stl", "空部件也拿到文件名");

  const d2 = makeDeps([]);
  await loadSTLModel(new ArrayBuffer(12), "junk.stl", d2.deps);
  assertEqual(d2.deps.customModelParts.length, 0, "垃圾数据不产出部件");
  assert(lastStatus(d2.seen).msg.startsWith("❌ STL 加载失败"), "垃圾数据同样既定文案");
});

// ===== 变异测试记录（src/model-loaders.js）=====
// 58 个变异：49 杀 9 存活。存活的逐个查过，判定全部等价：
//   - jointMap 写入去掉 child 守卫：没有 <child> 时写进去的键是 "undefined"，
//     没有任何 link 会叫这个名字，读不到的键改了也观测不到；
//   - joint 类型缺省 fixed 改 revolute：jointMap 里的 type 全模块无人读取；
//   - userData（装配阶段）丢掉 isURDF / 丢掉 name：命名步骤两个分支都会重建
//     userData，装配阶段写进去的同名字段观测不到；
//   - mesh.name 改用固定串：命名步骤两个分支都会再把 mesh.name 设回部件名
//     （mergePartsToQuest3 也只读 splitParts[].mesh，不读 mesh.name）；
//   - isOriginal 改 false：splitParts[].isOriginal 没有任何下游读者；
//   - partCenter 不再 clone：Box3.getCenter(new Vector3()) 本来返回新对象，
//     不存在别名，克隆与否观测不到；
//   - stepIndex 初值 1 改 0：命名步骤会为每个部件重新算 stepIndex；
//   - STL 部件名改用固定串：命名步骤随后又把 mesh.name 设成文件名/部位名。
// 曾经有一个盲区——外部 mesh 文件名缺省 "" 改 "unknown" 杀不掉——根因是命名
// 步骤整块替换 userData、meshFile 活不到收尾。该问题已随 src 修复关闭，现在
// 这条变异会被「mesh 引用的提示」那个 describe 杀掉。

// ===== 运行 =====
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
