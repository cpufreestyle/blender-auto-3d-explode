#!/usr/bin/env node
/**
 * 单元测试 — 连通分量 Worker 化三层（three-mesh-bvh 分层范式）
 *
 * 覆盖：
 *   - connected-components-core：分量归并正确性（两个焊接方块 → 2 分量）、
 *     小分量过滤、非索引几何、空输入；
 *   - splitByConnectedComponentsAsync：Worker 替身优先路径、Worker 抛错回退
 *     同步、无 Worker 时直接同步（Node 环境 Worker 未定义 → createConnectedComponentsWorker
 *     返回 null）；
 *   - connected-components-client：running 重入拒绝、dispose 后终止、Node 环境
 *     构造失败返回 null（同步回退可用）。
 */

import { BoxGeometry, BufferGeometry, Float32BufferAttribute, Group, Mesh } from "three";

import {
  computeConnectedComponents,
  SMALL_FACE_LIMIT,
} from "../src/connected-components-core.js";
import { createConnectedComponentsWorker } from "../src/connected-components-client.js";
import {
  autoSplitModelAsync,
  splitByConnectedComponentsAsync,
} from "../src/geometry-split.js";

// ===== 测试框架 =====
let passed = 0;
let failed = 0;
const failures = [];
function assert(condition, message) {
  if (condition) { console.log("  ✅ " + message); passed++; }
  else { console.error("  ❌ FAIL " + message); failed++; failures.push(message); }
}
const describeQueue = [];
function describe(name, fn) { describeQueue.push({ name, fn }); }
function it(_name, fn) { return fn(); }

// ===== 夹具：两个互不相连的焊接方块（与 geometry-split-test 的 twoWeldedBoxesGeometry 同构）=====
function weldedBox(positions, offset) {
  // 8 顶点焊接方块：12 个三角形共享角点 → 单连通分量
  const x = offset.x, y = offset.y, z = offset.z;
  const v = [
    [x - 0.5, y - 0.5, z - 0.5], [x + 0.5, y - 0.5, z - 0.5], [x + 0.5, y + 0.5, z - 0.5], [x - 0.5, y + 0.5, z - 0.5],
    [x - 0.5, y - 0.5, z + 0.5], [x + 0.5, y - 0.5, z + 0.5], [x + 0.5, y + 0.5, z + 0.5], [x - 0.5, y + 0.5, z + 0.5],
  ];
  const faces = [
    [0,1,2],[0,2,3],[4,6,5],[4,7,6],[0,4,5],[0,5,1],[3,2,6],[3,6,7],[1,5,6],[1,6,2],[0,3,7],[0,7,4],
  ];
  for (const [a,b,c] of faces) {
    positions.push(...v[a], ...v[b], ...v[c]);
  }
}

// 实用夹具：indexed 焊接两块
function indexedTwoBoxes() {
  const verts = [];
  weldedBoxVertexList(verts, -3);
  weldedBoxVertexList(verts, 3);
  const indices = [];
  boxIndices(indices, 0);
  boxIndices(indices, 8);
  return {
    position: new Float32Array(verts.flat()),
    index: new Uint32Array(indices),
  };
}
function weldedBoxVertexList(out, offsetX) {
  const x = offsetX, y = 0, z = 0;
  out.push(
    [x - 0.5, y - 0.5, z - 0.5], [x + 0.5, y - 0.5, z - 0.5], [x + 0.5, y + 0.5, z - 0.5], [x - 0.5, y + 0.5, z - 0.5],
    [x - 0.5, y - 0.5, z + 0.5], [x + 0.5, y - 0.5, z + 0.5], [x + 0.5, y + 0.5, z + 0.5], [x - 0.5, y + 0.5, z + 0.5],
  );
}
function boxIndices(out, base) {
  const faces = [
    [0,1,2],[0,2,3],[4,6,5],[4,7,6],[0,4,5],[0,5,1],[3,2,6],[3,6,7],[1,5,6],[1,6,2],[0,3,7],[0,7,4],
  ];
  for (const [a,b,c] of faces) out.push(base + a, base + b, base + c);
}

function makeTwoBoxGeometry() {
  const { position, index } = indexedTwoBoxes();
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(position, 3));
  g.setIndex(new Float32BufferAttribute(index, 1));
  return g;
}

// ===== 核心纯函数 =====
describe("computeConnectedComponents 核心算法", async() => {
  it("两个 indexed 焊接方块 → 恰好 2 个分量", () => {
    const { position, index } = indexedTwoBoxes();
    const result = computeConnectedComponents(position, index);
    assert(result.components.length === 2, `两个方块得 2 个分量（实得 ${result.components.length}）`);
    assert(result.components[0].faceCount === 12, "每个分量 12 面");
    assert(result.components[1].faceCount === 12, "第二个分量 12 面");
    assert(result.misc.length === 0, "无杂项");
  });

  it("单个焊接方块 → 1 个分量", () => {
    const verts = [];
    weldedBoxVertexList(verts, 0);
    const indices = [];
    boxIndices(indices, 0);
    const result = computeConnectedComponents(new Float32Array(verts.flat()), new Uint32Array(indices));
    assert(result.components.length === 1, "单方块 1 分量");
    assert(result.components[0].faceCount === 12, "12 面");
  });

  it("小分量并入 misc（面数 < SMALL_FACE_LIMIT）", () => {
    // 1 个大焊接方块（12 面）+ 1 个孤立三角形（3 面）
    const verts = [];
    weldedBoxVertexList(verts, 0);
    verts.push([9,9,9], [10,9,9], [9,10,9]); // 孤立三角形
    const indices = [];
    boxIndices(indices, 0);
    indices.push(8, 9, 10);
    const result = computeConnectedComponents(new Float32Array(verts.flat()), new Uint32Array(indices));
    assert(result.components.length === 1, "只有大方块成分量");
    assert(result.misc.length === 1, "孤立三角形并入 misc");
    assert(result.misc[0] === 12, "misc 记录的是面索引 12（第 13 个三角形）");
  });

  it("非索引几何：一个方块所有面共享角点也拆不开", () => {
    // 非索引时顶点不共享 → 但本仓库语义是「连续 3 顶点为一个面、面内 union」，
    // 单个非索引方块每个三角形的 3 顶点互相 union，但三角形之间不连通。
    const verts = [];
    weldedBox(verts, 0);
    const result = computeConnectedComponents(new Float32Array(verts), null);
    assert(result.components.length === 0, "12 个三角形互相不连通（顶点不共享）");
    assert(result.misc.length === 12, "全部并入 misc");
  });

  it("空输入返回空", () => {
    const r1 = computeConnectedComponents(new Float32Array(0), null);
    assert(r1.components.length === 0 && r1.misc.length === 0, "空 position → 空");
  });

  it("SMALL_FACE_LIMIT 导出且为 12", () => {
    assert(SMALL_FACE_LIMIT === 12, "阈值 12");
  });
});

// ===== 异步拆分 =====
describe("splitByConnectedComponentsAsync", async() => {
  it("Worker 替身结果与同步一致（两方块 → 2 几何体）", async() => {
    const geo = makeTwoBoxGeometry();
    const workerStub = {
      generate: async input => {
        assert(input.position instanceof Float32Array, "Worker 收到 Float32Array");
        return computeConnectedComponents(input.position, input.index);
      },
    };
    const results = await splitByConnectedComponentsAsync(geo, { worker: workerStub });
    assert(results.length === 2, `两分量 → 2 个几何体（实得 ${results.length}）`);
    assert(results.every(g => g instanceof BufferGeometry), "返回 BufferGeometry");
    for (const g of results) {
      assert(g.attributes.position.count === 36, "每几何体 12 面 × 3 顶点 = 36 顶点");
    }
  });

  it("Worker 抛错 → 回退同步路径结果一致", async() => {
    const geo = makeTwoBoxGeometry();
    const badWorker = { generate: async() => { throw new Error("worker boom"); } };
    const results = await splitByConnectedComponentsAsync(geo, { worker: badWorker });
    assert(results.length === 2, "回退同步仍得 2 几何体");
  });

  it("worker: null → 直接同步（Node 无 Worker 环境）", async() => {
    const geo = makeTwoBoxGeometry();
    const results = await splitByConnectedComponentsAsync(geo, { worker: null });
    assert(results.length === 2, "同步路径得 2 几何体");
  });

  it("空几何体 → 空数组", async() => {
    const geo = new BufferGeometry();
    geo.setAttribute("position", new Float32BufferAttribute(new Float32Array(0), 3));
    const results = await splitByConnectedComponentsAsync(geo, { worker: null });
    assert(results.length === 0, "空几何体 → []");
  });
});

// ===== autoSplitModelAsync 编排 =====
describe("autoSplitModelAsync", async() => {
  it("多 mesh 直通（异步也一致）", async() => {
    const model = new Group();
    const m1 = new Mesh(new BoxGeometry(1,1,1));
    m1.name = "A";
    const m2 = new Mesh(new BoxGeometry(1,1,1));
    m2.name = "B";
    model.add(m1, m2);
    const parts = await autoSplitModelAsync(model);
    assert(parts.length === 2, "2 mesh 直通 2 部件");
    assert(parts[0].isOriginal === true && parts[1].isOriginal === true, "isOriginal 真");
  });

  it("单 mesh 两分量 → 2 部件（worker 替身）", async() => {
    const geo = makeTwoBoxGeometry();
    const mesh = new Mesh(geo);
    mesh.updateMatrixWorld(true);
    const model = new Group();
    model.add(mesh);
    const workerStub = {
      generate: async({ position, index }) => computeConnectedComponents(position, index),
    };
    const parts = await autoSplitModelAsync(model, { worker: workerStub });
    assert(parts.length === 2, "两分量拆成 2 部件");
    assert(parts.every(p => p.isOriginal === false), "isOriginal 假");
  });

  it("单 mesh 单分量不拆 → 保留原 mesh", async() => {
    // BoxGeometry 带 6 个材质组会走材质组拆分；用无 groups 的焊接单方块
    const verts = [];
    weldedBoxVertexList(verts, 0);
    const indices = [];
    boxIndices(indices, 0);
    const geo = new BufferGeometry();
    geo.setAttribute("position", new Float32BufferAttribute(new Float32Array(verts.flat()), 3));
    geo.setIndex(new Float32BufferAttribute(new Uint32Array(indices), 1));
    const mesh = new Mesh(geo);
    mesh.name = "Solo";
    const model = new Group();
    model.add(mesh);
    // BoxGeometry 是 indexed 焊接几何（单分量）
    const parts = await autoSplitModelAsync(model, { worker: null });
    assert(parts.length === 1, "1 部件");
    assert(parts[0].mesh === mesh, "保留原 mesh");
    assert(parts[0].isOriginal === true, "isOriginal 真");
  });
});

// ===== Worker 客户端守卫 =====
describe("createConnectedComponentsWorker 客户端守卫", async() => {
  it("Node 环境（无 Worker）构造返回 null → 调用方可走同步回退", () => {
    const client = createConnectedComponentsWorker();
    assert(client === null, "Node 无 Worker 时返回 null 而非抛错");
  });

  it("注入 fake Worker 构造器：running 守卫 + dispose", async() => {
    const fakeWorker = {
      onmessage: null,
      onerror: null,
      postMessage(data, transfer) {
        assert(Array.isArray(transfer), "transfer 列表为数组");
        setTimeout(() => {
          this.onmessage({ data: { result: { components: [], misc: new Uint32Array(0) } } });
        }, 0);
      },
      terminate() { this.terminated = true; },
    };
    const savedWorker = globalThis.Worker;
    globalThis.Worker = class {
      constructor() { return fakeWorker; }
    };
    try {
      const client = createConnectedComponentsWorker();
      assert(client !== null, "有 Worker 时返回客户端");
      assert(client.running === false, "初始不 running");

      const p1 = client.generate({
        position: new Float32Array([0,0,0, 1,0,0, 0,1,0]),
        index: null,
      });
      assert(client.running === true, "任务进行中 running=true");

      const p2 = client.generate({
        position: new Float32Array([0,0,0, 1,0,0, 0,1,0]),
        index: null,
      });
      let rejected = null;
      await p2.catch(e => { rejected = e; });
      assert(rejected?.message.includes("Already running"), "重入被拒绝且报 Already running");

      const result = await p1;
      assert(result.components.length === 0, "任务完成返回结果");
      assert(client.running === false, "完成后 running 复位");

      client.dispose();
      assert(fakeWorker.terminated === true, "dispose 真正 terminate Worker");
    } finally {
      globalThis.Worker = savedWorker;
    }
  });
});

// ===== 运行 =====
(async() => {
  for (const item of describeQueue) {
    console.log("\n──── " + item.name);
    await item.fn();
  }
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log(`  结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) {
    console.log("  失败用例:");
    for (const f of failures) console.log("    - " + f);
    process.exit(1);
  }
  console.log("  ✅ 全部测试通过！");
})();

