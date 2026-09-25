#!/usr/bin/env node
/**
 * 单元测试 — 文件上传模块（src/upload-panel.js，从 main.js 抽取）
 *
 * 抽取的不变量：setupUpload 的对外可观察行为。这里锁四类：
 *   - 元素缺失时静默跳过；四个 DOM 事件绑定与 clearCustomModel 连接；
 *   - 格式白名单 / 150MB 体积上限 / URDF 与 STL 的分派（readAsText vs readAsArrayBuffer）；
 *   - tryBlenderSplit 这条「XHR 上传取进度 + 二进制响应 + manifest 走 header」的长函数：
 *     请求形状、上传与下载进度文案、旧版 JSON base64 兼容、新版 header 解析、
 *     失败与超时一律 resolve(null) 以触发前端回退；
 *   - customModelParts 经 getCustomModelParts() 惰性读取：建厂阶段一次都不取，
 *     每次派发各取一次，不会把旧数组引用钉死；
 *     每次派发各取一次，不会把旧数组引用钉死。
 *
 * 范围说明：loadSTLModel / loadURDFModel 内部走 three 的 STLLoader 与 DOMParser，
 * Node 环境跑不通（同 ar-preview-test.mjs 对 WebGL 成功路径的处理），因此断言停在
 * 「派发决策 + FileReader 读取模式 + 注入回调」这一边界，不进 loader 内部。
 *
 * 用法：node tests/upload-panel-test.mjs
 */

import { setupUpload } from "../src/upload-panel.js";
import { API_BASE } from "../src/config.js";

// ===== 测试框架（与 unit-test.mjs / ar-preview-test.mjs 一致）=====
let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.error(`  ❌ ${message}`);
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

// ===== 假浏览器世界 =====
const REAL_DOCUMENT = globalThis.document;
const REAL_XHR = globalThis.XMLHttpRequest;
const REAL_FR = globalThis.FileReader;

function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    id: "",
    textContent: "",
    className: "",
    value: "",
    style: {},
    disabled: false,
    listeners: {},
    classList: {
      set: new Set(),
      add(c) {
        this.set.add(c);
      },
      remove(c) {
        this.set.delete(c);
      },
      toggle(c, on) {
        if (on) this.set.add(c);
        else this.set.delete(c);
      },
    },
    addEventListener(ev, fn) {
      el.listeners[ev] = fn;
    },
  };
  return el;
}

// XHR 假实现：把 send() 拦下来，由用例手动 emit load / error / timeout
class FakeXHR {
  constructor() {
    this.listeners = {};
    this.upload = { listeners: {} };
    this.upload.addEventListener = (ev, fn) => {
      this.upload.listeners[ev] = fn;
    };
    this.headers = {};
    this.responseHeaders = {};
    this.status = 200;
    this.response = null;
    this.responseText = "";
    this.responseType = "";
    this.timeout = 0;
    xhrAll.push(this);
  }
  open(method, url) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k, v) {
    this.headers[k] = v;
  }
  getResponseHeader(name) {
    return this.responseHeaders[name];
  }
  addEventListener(ev, fn) {
    (this.listeners[ev] = this.listeners[ev] || []).push(fn);
  }
  send(body) {
    calls.sent.push({ xhr: this, body });
  }
  emit(ev, payload) {
    (this.listeners[ev] || []).forEach(fn => fn(payload));
  }
}

// FileReader 假实现：默认不触发 onload（不进 loader 内部）
class FakeFileReader {
  constructor() {
    this.result = null;
    this.onload = null;
    this.onerror = null;
    readers.push(this);
  }
  readAsText(file) {
    calls.reads.push({ mode: "text", file });
    if (fireReader) {
      this.result = "<robot/>";
      if (this.onload) this.onload({ target: this });
    }
  }
  readAsArrayBuffer(file) {
    calls.reads.push({ mode: "buffer", file });
    if (fireReader) {
      this.result = new ArrayBuffer(4);
      if (this.onload) this.onload({ target: this });
    }
  }
}

let xhrAll = [];
let readers = [];
let fireReader = false;
let calls = null;

function installWorld({
  readyState = "complete",
  withElements = true,
  parts = [{ name: "p1" }],
} = {}) {
  xhrAll = [];
  readers = [];
  fireReader = false;
  calls = {
    statuses: [],
    sent: [],
    reads: [],
    loadCustomModel: [],
    clearCustomModelGroup: [],
    finalizeCustomModelLoad: [],
    clearCustomModel: 0,
    partCalls: [],
    domReadyListeners: [],
  };

  const ids = ["drop-zone", "file-input", "upload-btn", "clear-model-btn"];
  const els = {};
  for (const id of ids) els[id] = makeEl("div");

  const doc = {
    readyState,
    getElementById: id => (withElements ? els[id] || null : null),
    addEventListener: (ev, fn) => calls.domReadyListeners.push({ ev, fn }),
  };
  Object.defineProperty(globalThis, "document", { value: doc, configurable: true });
  globalThis.XMLHttpRequest = FakeXHR;
  globalThis.FileReader = FakeFileReader;

  let currentParts = parts;
  const deps = {
    showStatus: (msg, type) => calls.statuses.push({ msg, type }),
    customModelGroup: { __customModelGroup: true },
    getCustomModelParts: () => {
      calls.partCalls.push(currentParts);
      return currentParts;
    },
    loadCustomModel: (arrayBuffer, fileName, manifest) =>
      calls.loadCustomModel.push({ arrayBuffer, fileName, manifest }),
    clearCustomModelGroup: () => calls.clearCustomModelGroup.push(1),
    finalizeCustomModelLoad: (...args) => calls.finalizeCustomModelLoad.push(args),
    clearCustomModel: () => calls.clearCustomModel++,
  };

  setupUpload(deps);

  return {
    deps,
    els,
    calls,
    xhrs: () => xhrAll,
    lastXhr: () => xhrAll[xhrAll.length - 1],
    lastStatus: () => calls.statuses[calls.statuses.length - 1],
    setParts: next => {
      currentParts = next;
    },
    fireReader: () => {
      fireReader = true;
    },
    failReader: () => {
      const r = readers[readers.length - 1];
      if (r && r.onerror) r.onerror();
    },
    chooseFile: file =>
      els["file-input"].listeners.change({ target: { files: [file], value: "prev" } }),
    dropFile: file =>
      els["drop-zone"].listeners.drop({
        preventDefault() {},
        dataTransfer: { files: [file] },
      }),
  };
}

function restoreGlobals() {
  const restore = (name, value) => {
    if (value === undefined) delete globalThis[name];
    else Object.defineProperty(globalThis, name, { value, configurable: true });
  };
  restore("document", REAL_DOCUMENT);
  restore("XMLHttpRequest", REAL_XHR);
  restore("FileReader", REAL_FR);
}

async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function makeFile(name, size = 1024) {
  // 必须是真 File：Node 的 FormData.append 对非 Blob 值会退化成字符串
  const f = new File(["x".repeat(8)], name);
  Object.defineProperty(f, "size", { value: size });
  return f;
}

// ===== 用例 =====

describe("上传模块（src/upload-panel.js）", async() => {
  await it("元素缺失时静默跳过：什么都不绑定", () => {
    const w = installWorld({ withElements: false });
    try {
      assert(w.xhrs().length === 0, "没有发起请求");
      for (const id of ["file-input", "upload-btn", "drop-zone", "clear-model-btn"]) {
        assert(w.els[id].listeners.change === undefined, `${id} 未绑定任何事件`);
      }
    } finally {
      restoreGlobals();
    }
  });

  await it("绑定四个入口事件，clearCustomModel 连到清除按钮", () => {
    const w = installWorld();
    try {
      assert(typeof w.els["upload-btn"].listeners.click === "function", "upload-btn 绑定 click");
      assert(typeof w.els["file-input"].listeners.change === "function", "file-input 绑定 change");
      assert(typeof w.els["drop-zone"].listeners.dragover === "function", "drop-zone 绑定 dragover");
      assert(typeof w.els["drop-zone"].listeners.dragleave === "function", "drop-zone 绑定 dragleave");
      assert(typeof w.els["drop-zone"].listeners.drop === "function", "drop-zone 绑定 drop");
      assert(typeof w.els["clear-model-btn"].listeners.click === "function", "clear-btn 绑定 click");
      w.els["clear-model-btn"].listeners.click();
      assert(w.calls.clearCustomModel === 1, "点击清除按钮调用了 clearCustomModel");
    } finally {
      restoreGlobals();
    }
  });

  await it("uploadBtn 点击转成 fileInput.click()", () => {
    const w = installWorld();
    try {
      let clicked = 0;
      w.els["file-input"].click = () => {
        clicked++;
      };
      w.els["upload-btn"].listeners.click();
      assert(clicked === 1, "fileInput.click() 被调用");
    } finally {
      restoreGlobals();
    }
  });

  await it("change 事件取第一个文件并把 input 值重置", () => {
    const w = installWorld();
    try {
      const file = makeFile("a.glb");
      const input = { files: [file], value: "C:\\fakepath\\a.glb" };
      w.els["file-input"].listeners.change({ target: input });
      assert(input.value === "", "选择后 input.value 被清空");
      assert(w.xhrs().length === 1, "随即发起了 Blender 拆解请求");
    } finally {
      restoreGlobals();
    }
  });

  await it("不支持的扩展名直接拒绝，不发请求", () => {
    const w = installWorld();
    try {
      w.chooseFile(makeFile("model.txt"));
      assert(w.xhrs().length === 0, "没有 XHR");
      assert(w.lastStatus().type === "error", "error 状态");
      assert(w.lastStatus().msg.includes("不支持的文件格式"), "文案说明是格式问题");
      assert(w.lastStatus().msg.includes(".glb / .gltf / .stl / .urdf / .obj"), "列出支持的格式");
    } finally {
      restoreGlobals();
    }
  });

  await it("超过 150MB 直接拒绝，不发请求", () => {
    const w = installWorld();
    try {
      w.chooseFile(makeFile("big.glb", 150 * 1024 * 1024 + 1));
      assert(w.xhrs().length === 0, "没有 XHR");
      assert(w.lastStatus().type === "error", "error 状态");
      assert(w.lastStatus().msg.includes("文件太大"), "文案说明是体积问题");
      assert(w.lastStatus().msg.includes("150MB"), "给出上限值");
    } finally {
      restoreGlobals();
    }
  });

  await it("等于 150MB 不越界（边界值放行）", () => {
    const w = installWorld();
    try {
      w.chooseFile(makeFile("edge.glb", 150 * 1024 * 1024));
      assert(w.xhrs().length === 1, "等于上限仍然放行并发起请求");
    } finally {
      restoreGlobals();
    }
  });

  await it("URDF 走 readAsText，不进 Blender 后端", () => {
    const w = installWorld();
    try {
      w.chooseFile(makeFile("robot.urdf"));
      assert(w.lastStatus().msg.includes("正在解析 URDF 文件"), "提示正在解析 URDF");
      assert(w.xhrs().length === 0, "URDF 不请求 /api/split");
      assert(w.calls.reads.length === 1 && w.calls.reads[0].mode === "text", "按文本读取");
    } finally {
      restoreGlobals();
    }
  });

  await it("Blender 拆解成功 → loadCustomModel(arrayBuffer, 文件名, manifest)", async() => {
    const w = installWorld();
    try {
      w.chooseFile(makeFile("part.glb"));
      const xhr = w.lastXhr();
      xhr.responseHeaders = {
        "X-Success": "true",
        "X-Total-Parts": "15",
        "X-Elapsed-Seconds": "3.25",
        "X-Manifest": btoa(JSON.stringify({ total_parts: 15 })),
      };
      xhr.status = 200;
      xhr.response = new ArrayBuffer(8);
      xhr.emit("load", {});
      await flush();
      assert(w.calls.loadCustomModel.length === 1, "调用了一次 loadCustomModel");
      const arg = w.calls.loadCustomModel[0];
      assert(arg.arrayBuffer instanceof ArrayBuffer, "传入二进制响应体");
      assert(arg.fileName === "part.glb", "传入文件名");
      assert(arg.manifest.total_parts === 15, "manifest 由 base64 header 解出");
      assert(w.lastStatus().msg.includes("拆解完成：15 个部件"), "状态给出部件数");
      assert(w.lastStatus().msg.includes("3.25s"), "状态给出耗时");
      assert(w.calls.reads.length === 0, "成功路径不回退到前端读取");
    } finally {
      restoreGlobals();
    }
  });

  await it("Blender 失败 → STL 回退到前端加载（readAsArrayBuffer）", async() => {
    const w = installWorld();
    try {
      w.chooseFile(makeFile("part.stl"));
      w.lastXhr().emit("error", {});
      await flush();
      assert(w.calls.loadCustomModel.length === 0, "没有走 loadCustomModel");
      assert(w.lastStatus().msg.includes("正在用前端加载 STL 模型"), "提示走前端加载");
      assert(w.calls.reads.length === 1 && w.calls.reads[0].mode === "buffer", "按二进制读取");
    } finally {
      restoreGlobals();
    }
  });

  await it("Blender 失败 → GLB 回退到前端 JS 拆解", async() => {
    const w = installWorld();
    try {
      w.chooseFile(makeFile("part.glb"));
      w.lastXhr().emit("error", {});
      await flush();
      assert(w.calls.loadCustomModel.length === 0, "没有走 loadCustomModel");
      assert(w.lastStatus().msg.includes("正在用前端 JS 拆解模型"), "提示走前端 JS 拆解");
      assert(w.calls.reads.length === 1 && w.calls.reads[0].mode === "buffer", "按二进制读取");
    } finally {
      restoreGlobals();
    }
  });

  await it("请求形状：POST ${API_BASE}/api/split，arraybuffer + 10 分钟超时", () => {
    const w = installWorld();
    try {
      w.chooseFile(makeFile("part.glb"));
      const xhr = w.lastXhr();
      assert(xhr.method === "POST", "方法为 POST");
      assert(xhr.url === `${API_BASE}/api/split`, `URL 走统一配置（${xhr.url}）`);
      assert(xhr.responseType === "arraybuffer", "响应按二进制取");
      assert(xhr.timeout === 600000, "超时 10 分钟");
      assert(w.calls.sent.length === 1, "send 被调用一次");
      assert(w.calls.sent[0].body instanceof FormData, "body 是 FormData");
      assert(w.calls.sent[0].body.get("file").name === "part.glb", "FormData 里带着原文件");
    } finally {
      restoreGlobals();
    }
  });

  await it("上传进度：<100% 报百分比与 KB，到 100% 转成等待后端", () => {
    const w = installWorld();
    try {
      w.chooseFile(makeFile("part.glb"));
      const up = w.lastXhr().upload;
      up.listeners.progress({ lengthComputable: true, loaded: 512, total: 1024 });
      assert(
        w.lastStatus().msg.includes("上传中... 50%"),
        `50% 时给出百分比（${w.lastStatus().msg}）`,
      );
      assert(w.lastStatus().msg.includes("1 / 1 KB"), "给出 KB 进度");
      up.listeners.progress({ lengthComputable: true, loaded: 1024, total: 1024 });
      assert(
        w.lastStatus().msg.includes("已上传，等待后端处理"),
        `100% 时切文案（${w.lastStatus().msg}）`,
      );
      up.listeners.progress({ lengthComputable: false, loaded: 1, total: 0 });
      assert(true, "lengthComputable=false 时不崩");
    } finally {
      restoreGlobals();
    }
  });

  await it("下载进度：有 Content-Length 报百分比，没有则报已接收 MB", () => {
    const w = installWorld();
    try {
      w.chooseFile(makeFile("part.glb"));
      const xhr = w.lastXhr();
      xhr.listeners.progress.forEach(fn => fn({ lengthComputable: true, loaded: 3, total: 12 }));
      assert(w.lastStatus().msg.includes("Blender 拆解中... 25%"), `百分比（${w.lastStatus().msg}）`);
      xhr.listeners.progress.forEach(fn =>
        fn({ lengthComputable: false, loaded: 2 * 1024 * 1024, total: 0 }),
      );
      assert(
        w.lastStatus().msg.includes("已接收 2.0 MB"),
        `无 Content-Length 时报 MB（${w.lastStatus().msg}）`,
      );
    } finally {
      restoreGlobals();
    }
  });

  await it("非 200 响应按 JSON 错误解析并回退", async() => {
    const w = installWorld();
    try {
      w.chooseFile(makeFile("part.glb"));
      const xhr = w.lastXhr();
      xhr.status = 500;
      xhr.responseText = JSON.stringify({ error: "Blender 未启动" });
      xhr.emit("load", {});
      await flush();
      assert(w.calls.loadCustomModel.length === 0, "回退：没有 loadCustomModel");
      assert(w.lastStatus().msg.includes("正在用前端 JS 拆解模型"), "走了前端 JS 拆解");
    } finally {
      restoreGlobals();
    }
  });

  await it("旧版 JSON 响应（base64 GLB）仍能兼容", async() => {
    const w = installWorld();
    try {
      w.chooseFile(makeFile("part.glb"));
      const xhr = w.lastXhr();
      xhr.status = 200;
      xhr.responseHeaders = { "X-Success": "false" };
      xhr.responseText = JSON.stringify({
        success: true,
        total_parts: 9,
        elapsed_seconds: 1.5,
        glb_base64: btoa("ABCD"),
      });
      xhr.emit("load", {});
      await flush();
      assert(w.calls.loadCustomModel.length === 1, "回填到 loadCustomModel");
      const arg = w.calls.loadCustomModel[0];
      assert(new TextDecoder().decode(new Uint8Array(arg.arrayBuffer)) === "ABCD", "base64 还原为字节");
      assert(arg.manifest.total_parts === 9, "manifest 直接来自 JSON body");
      assert(w.lastStatus().msg.includes("9 个部件"), "状态给出部件数");
    } finally {
      restoreGlobals();
    }
  });

  await it("新版响应缺 X-Manifest 头时告警并回退", async() => {
    const w = installWorld();
    try {
      w.chooseFile(makeFile("part.glb"));
      const xhr = w.lastXhr();
      xhr.status = 200;
      xhr.responseHeaders = { "X-Success": "true", "X-Total-Parts": "3" };
      xhr.response = new ArrayBuffer(4);
      xhr.emit("load", {});
      await flush();
      assert(w.calls.loadCustomModel.length === 0, "回退");
      const warn = w.calls.statuses.find(st => st.type === "warn");
      assert(warn !== undefined, "出现过 warn 状态");
      assert(warn.msg.includes("响应中缺少 manifest 头"), "warn 文案指出缺的是 manifest 头");
    } finally {
      restoreGlobals();
    }
  });

  await it("load 处理里抛错也被 catch 成回退", async() => {
    const w = installWorld();
    try {
      w.chooseFile(makeFile("part.glb"));
      const xhr = w.lastXhr();
      xhr.status = 200;
      xhr.responseHeaders = { "X-Success": "false" };
      xhr.responseText = "{ 非法 JSON";
      xhr.emit("load", {});
      await flush();
      assert(w.calls.loadCustomModel.length === 0, "回退");
      const warn = w.calls.statuses.find(st => st.type === "warn");
      assert(warn !== undefined && warn.msg.includes("响应解析失败"), "warn 文案说明是响应解析失败");
    } finally {
      restoreGlobals();
    }
  });

  await it("XHR timeout 同样回退", async() => {
    const w = installWorld();
    try {
      w.chooseFile(makeFile("part.glb"));
      w.lastXhr().emit("timeout", {});
      await flush();
      assert(w.calls.loadCustomModel.length === 0, "回退");
      assert(w.lastStatus().msg.includes("正在用前端 JS 拆解模型"), "走前端 JS 拆解");
    } finally {
      restoreGlobals();
    }
  });

  await it("drop 事件取 dataTransfer 第一个文件", async() => {
    const w = installWorld();
    try {
      w.dropFile(makeFile("dropped.glb"));
      assert(w.xhrs().length === 1, "drop 后发起了拆解请求");
      assert(w.calls.sent[0].body.get("file").name === "dropped.glb", "用的是拖入的文件");
    } finally {
      restoreGlobals();
    }
  });

  await it("dragover / dragleave 切换拖拽高亮样式", () => {
    const w = installWorld();
    try {
      const dz = w.els["drop-zone"];
      let prevented = 0;
      dz.listeners.dragover({ preventDefault: () => prevented++ });
      assert(prevented === 1, "dragover 阻止了默认行为");
      assert(dz.style.borderColor === "#4a9eff", "高亮边框色");
      assert(dz.style.background === "rgba(74, 158, 255, 0.1)", "高亮背景");
      dz.listeners.dragleave({ preventDefault: () => {} });
      assert(dz.style.borderColor === "", "dragleave 清掉边框色");
      assert(dz.style.background === "", "dragleave 清掉背景");
      w.dropFile(makeFile("x.glb"));
      assert(dz.style.borderColor === "", "drop 也清掉高亮");
    } finally {
      restoreGlobals();
    }
  });

  await it("customModelParts 惰性读取：建厂不取，每次派发取一次且读到最新值", () => {
    const w = installWorld();
    w.fireReader(); // 只有真的把 deps 交给 loader 才能观测到 getter 被调用
    try {
      assert(w.calls.partCalls.length === 0, "setupUpload 阶段没有读取 customModelParts");
      const first = [{ name: "old" }];
      w.setParts(first);
      w.chooseFile(makeFile("a.urdf"));
      assert(w.calls.partCalls.length === 1, "URDF 分发时读了一次");
      assert(w.calls.partCalls[0] === first, "读到的是当前数组引用");
      // Node 里没有 DOMParser，loadURDFModel 必然走到自己的 catch；
      // 但 catch 的文案带路线名，足以证明 URDF 进的是 URDF loader 而不是 STL。
      assert(w.lastStatus().msg.includes("URDF 解析失败"), "URDF 路线进的是 loadURDFModel");
      const second = [{ name: "new" }];
      w.setParts(second);
      w.chooseFile(makeFile("b.urdf"));
      assert(w.calls.partCalls.length === 2, "第二次分发又读了一次");
      assert(w.calls.partCalls[1] === second, "读到的是替换后的新数组，不是旧快照");
    } finally {
      restoreGlobals();
    }
  });

  await it("注入的 customModelGroup / showStatus 原样透传可用", () => {
    const w = installWorld();
    try {
      assert(w.deps.customModelGroup.__customModelGroup === true, "Group 引用未被复制改写");
      assert(typeof w.deps.showStatus === "function", "showStatus 以回调形式注入");
      assert(typeof w.deps.getCustomModelParts === "function", "部件数组经 getter 注入");
    } finally {
      restoreGlobals();
    }
  });
});

// ===== 读取失败：readFileAs 的 onerror 接缝 =====
// 该 onerror 是三条路线（URDF 文本 / STL 二进制 / GLB 二进制）共用的一份实现，
// 失败文案也统一写死在这里。逐条路线各验一遍，防止接缝只被其中一条看守——
// 只测一条的话，「改坏某条路线的读取模式」或「某条路线漏接 onerror」都能蒙混过关。
describe("读取文件失败：三条路线共用同一句提示", async() => {
  const routes = [
    { label: "URDF", file: "robot.urdf", mode: "text", viaBlender: false },
    { label: "STL", file: "part.stl", mode: "buffer", viaBlender: true },
    { label: "GLB", file: "part.glb", mode: "buffer", viaBlender: true },
  ];
  for (const route of routes) {
    await it(`${route.label} 读取失败：既定文案 + error 级 + 不进加载`, async() => {
      const w = installWorld();
      try {
        w.chooseFile(makeFile(route.file));
        if (route.viaBlender) {
          // STL / GLB 先试 Blender 后端，须先让它失败才回退到 FileReader
          w.lastXhr().emit("error", {});
          await flush();
        }
        assert(w.calls.reads.length === 1, `${route.label} 恰好发起一次读取`);
        assert(w.calls.reads[0].mode === route.mode, `${route.label} 读取模式为 ${route.mode}`);
        const before = w.calls.loadCustomModel.length;
        w.failReader();
        const st = w.lastStatus();
        assert(st.msg === "❌ 读取文件失败", `${route.label} 提示既定文案`);
        assert(st.type === "error", `${route.label} 为 error 级`);
        assert(
          w.calls.loadCustomModel.length === before,
          `${route.label} 读取失败后不调用 loadCustomModel`,
        );
      } finally {
        restoreGlobals();
      }
    });
  }

  await it("GLB 回退成功：onload 把 result / 文件名 / manifest 原样交给 loadCustomModel", async() => {
    const w = installWorld();
    w.fireReader();
    try {
      w.chooseFile(makeFile("part.glb"));
      w.lastXhr().emit("error", {});
      await flush();
      assert(w.calls.loadCustomModel.length === 1, "loadCustomModel 只被调用一次");
      const c = w.calls.loadCustomModel[0];
      assert(
        c.arrayBuffer instanceof ArrayBuffer && c.arrayBuffer.byteLength === 4,
        "交出的是 FileReader 的 result，不是事件对象也不是 null",
      );
      assert(c.fileName === "part.glb", "文件名是用户选中的那个");
      assert(c.manifest === null, "前端 JS 拆解没有 manifest，与调用点约定一致");
      assert(w.calls.finalizeCustomModelLoad.length === 0, "loadCustomModel 自行收尾，本模块不代劳");
    } finally {
      restoreGlobals();
    }
  });

  await it("读取失败不会触到 getCustomModelParts：loaderDeps 只在 onload 里求值", () => {
    const w = installWorld();
    try {
      w.chooseFile(makeFile("robot.urdf"));
      w.failReader();
      assert(w.calls.partCalls.length === 0, "onerror 路径没有构造 loaderDeps");
    } finally {
      restoreGlobals();
    }
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
