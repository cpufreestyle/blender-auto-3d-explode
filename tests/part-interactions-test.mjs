#!/usr/bin/env node
/**
 * 单元测试 — 部件清单交互（src/part-interactions.js）
 *
 * 钉住的不变量（此前 .parts-grid 只是展示，点了没有任何反应）：
 *   - 点行：highlightPart(name) + focusPart(name) + 该行加 .is-active；
 *   - 再点同一行：取消选中，highlightPart(null)，.is-active 撤掉；
 *   - 点眼睛：仅该部件 mesh.visible=true（其余 false）+ 该行 .is-isolated
 *     + 眼睛 title 变「恢复显示全部部件」+ aria-pressed=true；
 *   - isolate 中再点同一眼睛：全部恢复 visible、状态清空；
 *   - isolate 中点别的行：先恢复全部可见再选中新行（不会出现「点 A 眼里只有 B」）；
 *   - Escape：取消选中并恢复全部可见；无选区时按 Escape 不产生任何调用；
 *   - refresh()：给缺眼睛的幂等补按钮、重置选区与高亮（换模型后旧选区无意义）；
 *   - 部件名支持 dataset.part 与 getAttribute("data-part") 两种取法；
 *   - 点眼睛内部的子节点也能命中（parentElement 上溯）；
 *   - 容器/清单缺失、getParts 返回非数组时静默不抛；
 *   - observer 与 refresh 不会互相喂养：真机上 refresh 无条件重写眼睛按钮文本，
 *     而 observer 正听着 .parts-grid 的 subtree childList，两边互相唤醒会把渲染
 *     进程拖死（点「单独显示」即复现，所以必须由假 DOM 建模 childList 变异来守）。
 *
 * 用法：node tests/part-interactions-test.mjs
 */

import { createPartInteractions } from "../src/part-interactions.js";

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

// ===== DOM 变异计数与假 MutationObserver =====
// 为什么需要：挂起 observer 的模块一旦「写 DOM → 唤醒自己 → 再写」就会自激，
// 真机上表现为整个页面卡死。没有计数就没有任何断言能发现它。
// 计数口径照 Blink：appendChild / removeChild / 给元素写 textContent（移除旧文本
// 节点 + 插入新节点）都是 childList 变异；class / title / data-* 是属性，不算。
const domStats = { mutations: 0, notified: 0 };
const liveObservers = [];
const bumpMutations = () => { domStats.mutations++; };

class FakeMutationObserver {
  constructor(cb) { this.cb = cb; this.alive = true; }
  observe(target, opts) { this.target = target; this.opts = opts; liveObservers.push(this); }
  disconnect() { this.alive = false; const i = liveObservers.indexOf(this); if (i >= 0) liveObservers.splice(i, 1); }
  takeRecords() { return []; }
}
globalThis.MutationObserver = FakeMutationObserver;

// 把待投递的变异全部投递给 observer，返回投递轮数。上限是他律：自激时会一路撞到
// 上限，测试直接失败，而不是把进程挂住。
function drainObservers(maxRounds = 30) {
  let rounds = 0;
  while (rounds < maxRounds && domStats.mutations > domStats.notified) {
    domStats.notified = domStats.mutations;
    for (const ob of [...liveObservers]) if (ob.alive) ob.cb();
    rounds++;
  }
  return rounds;
}

// ===== 假 DOM（支持 .class 的后代查询，够本模块用）=====
function makeEl(tag = "div", attrs = {}) {
  const classes = new Set();
  const el = {
    tagName: String(tag).toUpperCase(),
    _textContent: "",
    // 照 Blink 语义：写 textContent = 移除旧文本节点 + 插入新节点（一次 childList 变异）
    get textContent() { return el._textContent; },
    set textContent(value) { el._textContent = String(value); bumpMutations(); },
    title: "",
    type: "",
    disabled: false,
    style: {},
    dataset: {},
    attrs: {},
    children: [],
    // className 与 classList 在真实 DOM 里是同一份状态，假 DOM 也必须同步，
    // 否则模块用 className = "part-eye" 建的按钮按 class 查不出来
    get className() {
      return [...classes].join(" ");
    },
    set className(value) {
      classes.clear();
      for (const c of String(value).split(/\s+/).filter(Boolean)) classes.add(c);
      el.classList.set = classes;
    },
    parentElement: null,
    classList: {
      set: classes,
      add(c) {
        this.set.add(c);
      },
      remove(c) {
        this.set.delete(c);
      },
      has(c) {
        return this.set.has(c);
      },
      contains(c) {
        return this.set.has(c);
      },
      toggle(c, on) {
        const shouldAdd = on === undefined ? !this.set.has(c) : !!on;
        if (shouldAdd) this.set.add(c);
        else this.set.delete(c);
        return shouldAdd;
      },
    },
    appendChild(child) {
      child.parentElement = el;
      el.children.push(child);
      bumpMutations();
      return child;
    },
    removeChild(child) {
      el.children = el.children.filter(c => c !== child);
      child.parentElement = null;
      bumpMutations();
      return child;
    },
    setAttribute(name, value) {
      el.attrs[name] = String(value);
      if (name === "class") {
        el.classList.set = new Set(String(value).split(/\s+/).filter(Boolean));
      }
      if (name === "data-part") el.dataset.part = String(value);
    },
    getAttribute(name) {
      if (name === "class") return [...el.classList.set].join(" ");
      return name in el.attrs ? el.attrs[name] : (name in el.dataset ? el.dataset[name] : null);
    },
    addEventListener(type, fn) {
      el.listeners = el.listeners || {};
      (el.listeners[type] = el.listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      if (!el.listeners || !el.listeners[type]) return;
      el.listeners[type] = el.listeners[type].filter(f => f !== fn);
    },
    dispatch(type, ev = {}) {
      // 真实事件会冒泡：从 target 沿 parentElement 上溯，逐层触发监听
      const event = { type, target: ev.target || el, key: ev.key, preventDefault() {} };
      let node = event.target;
      while (node) {
        const handlers = (node.listeners && node.listeners[type]) || [];
        for (const fn of handlers) fn(event);
        node = node.parentElement;
      }
    },
    matches(sel) {
      return sel.startsWith(".") ? el.classList.has(sel.slice(1)) : false;
    },
    querySelectorAll(sel) {
      const cls = sel.startsWith(".") ? sel.slice(1) : null;
      const out = [];
      const walk = node => {
        for (const child of node.children) {
          if (!cls || child.classList.has(cls)) out.push(child);
          walk(child);
        }
      };
      walk(el);
      return out;
    },
    querySelector(sel) {
      return el.querySelectorAll(sel)[0] || null;
    },
  };
  if (attrs.class) el.className = attrs.class;
  if (attrs["data-part"]) el.dataset.part = attrs["data-part"];
  if (attrs.dataset) Object.assign(el.dataset, attrs.dataset);
  return el;
}

/**
 * 搭一套「页面 → .parts-grid → 若干 .part-item」的假结构。
 * @param {string[]} names 部件名
 * @param {{withEyes?: boolean}} opts
 */
function setupGrid(names, opts = {}) {
  const host = makeEl("body");
  const overlay = makeEl("div", { class: "ui-overlay" });
  host.appendChild(overlay);
  const grid = makeEl("div", { class: "parts-grid" });
  overlay.appendChild(grid);
  for (const name of names) {
    const row = makeEl("div", { class: "part-item" });
    row.dataset.part = name;
    if (opts.withEyes !== false) {
      const eye = makeEl("button", { class: "part-eye" });
      row.appendChild(eye);
    }
    grid.appendChild(row);
  }
  return { host, overlay, grid, rows: grid.querySelectorAll(".part-item") };
}

const PARTS = ["前面板", "主机身", "左透镜模组"].map((name, i) => ({
  name,
  mesh: { visible: true, name: `mesh-${i}` },
}));

describe("部件清单交互", async() => {
  await it("点行：高亮 + 相机聚焦 + 行激活", async() => {
    const { host, rows } = setupGrid(["前面板", "主机身"]);
    const calls = [];
    const mod = createPartInteractions({
      getParts: () => PARTS,
      focusPart: name => calls.push(["focus", name]),
      highlightPart: name => calls.push(["highlight", name]),
      root: host,
    });
    rows[0].dispatch("click");
    assert(calls.some(c => c[0] === "highlight" && c[1] === "前面板"), "highlightPart('前面板') 被调用");
    assert(calls.some(c => c[0] === "focus" && c[1] === "前面板"), "focusPart('前面板') 被调用");
    assert(rows[0].classList.has("active"), "被点行加 .is-active");
    assert(!rows[1].classList.has("active"), "另一行不加 .is-active");
    assert(mod.getSelected() === "前面板", `getSelected() = ${mod.getSelected()}`);
    mod.destroy();
  });

  await it("再点同一行：取消选中", async() => {
    const { host, rows } = setupGrid(["前面板", "主机身"]);
    const hl = [];
    const mod = createPartInteractions({
      getParts: () => PARTS,
      focusPart: () => {},
      highlightPart: name => hl.push(name),
      root: host,
    });
    hl.length = 0; // 构造时的 refresh 会调一次 highlightPart(null)，不计入用户动作
    rows[0].dispatch("click");
    rows[0].dispatch("click");
    assert(hl.length === 2 && hl[1] === null, `第二次高亮传 null（实际 ${JSON.stringify(hl)}）`);
    assert(!rows[0].classList.has("active"), "取消后 .is-active 撤掉");
    assert(mod.getSelected() === null, "getSelected() 回到 null");
    mod.destroy();
  });

  await it("点眼睛：仅该部件可见，其余隐藏", async() => {
    const { host, rows } = setupGrid(PARTS.map(p => p.name));
    const mod = createPartInteractions({
      getParts: () => PARTS,
      focusPart: () => {},
      highlightPart: () => {},
      root: host,
    });
    const eye = rows[1].querySelector(".part-eye");
    eye.dispatch("click");
    assert(PARTS[1].mesh.visible === true, "目标部件保持可见");
    assert(PARTS[0].mesh.visible === false && PARTS[2].mesh.visible === false, "其余部件 mesh.visible=false");
    assert(rows[1].classList.has("isolated"), "该行加 .is-isolated");
    assert(eye.title === "恢复显示全部部件", `眼睛 title 变为恢复提示（实际 ${eye.title}）`);
    assert(eye.getAttribute("aria-pressed") === "true", "aria-pressed=true");
    assert(mod.getIsolated() === "主机身", `getIsolated() = ${mod.getIsolated()}`);
    mod.destroy();
  });

  await it("isolate 中再点同一眼睛：全部恢复", async() => {
    const { host, rows } = setupGrid(PARTS.map(p => p.name));
    const mod = createPartInteractions({
      getParts: () => PARTS,
      focusPart: () => {},
      highlightPart: () => {},
      root: host,
    });
    const eye = rows[1].querySelector(".part-eye");
    eye.dispatch("click");
    eye.dispatch("click");
    assert(PARTS.every(p => p.mesh.visible === true), "三个部件全部恢复可见");
    assert(!rows[1].classList.has("isolated"), ".is-isolated 撤掉");
    assert(eye.title === "单独显示该部件（其余部件暂时隐藏）", "title 回到单独显示提示");
    assert(eye.getAttribute("aria-pressed") === "false", "aria-pressed=false");
    assert(mod.getIsolated() === null, "getIsolated() 回到 null");
    mod.destroy();
  });

  await it("isolate 中点别的行：先恢复全部可见再选中", async() => {
    const { host, rows } = setupGrid(PARTS.map(p => p.name));
    const mod = createPartInteractions({
      getParts: () => PARTS,
      focusPart: () => {},
      highlightPart: () => {},
      root: host,
    });
    rows[0].querySelector(".part-eye").dispatch("click"); // isolate 前面板
    rows[2].dispatch("click"); // 点左透镜模组
    assert(PARTS.every(p => p.mesh.visible === true), "切换目标后全部恢复可见");
    assert(mod.getSelected() === "左透镜模组", "新目标被选中");
    assert(mod.getIsolated() === null, "isolate 状态已退出");
    mod.destroy();
  });

  await it("Escape：取消选中并恢复可见", async() => {
    const { host, rows } = setupGrid(PARTS.map(p => p.name));
    const hl = [];
    const mod = createPartInteractions({
      getParts: () => PARTS,
      focusPart: () => {},
      highlightPart: name => hl.push(name),
      root: host,
    });
    rows[1].querySelector(".part-eye").dispatch("click");
    host.dispatch("keydown", { key: "Escape" });
    assert(PARTS.every(p => p.mesh.visible === true), "Escape 后全部恢复可见");
    assert(mod.getSelected() === null, "选区清空");
    assert(hl[hl.length - 1] === null, "最后一次高亮传 null");
    mod.destroy();
  });

  await it("无选区时按 Escape 不触发任何高亮调用", async() => {
    const { host } = setupGrid(PARTS.map(p => p.name));
    const hl = [];
    const mod = createPartInteractions({
      getParts: () => PARTS,
      focusPart: () => {},
      highlightPart: name => hl.push(name),
      root: host,
    });
    hl.length = 0;
    host.dispatch("keydown", { key: "Escape" });
    assert(hl.length === 0, `highlightPart 0 次调用（实际 ${hl.length}）`);
    mod.destroy();
  });

  await it("refresh()：幂等补眼睛 + 重置选区", async() => {
    const { host, grid } = setupGrid(["前面板", "主机身"], { withEyes: false });
    const hl = [];
    const mod = createPartInteractions({
      getParts: () => PARTS,
      focusPart: () => {},
      highlightPart: name => hl.push(name),
      root: host,
      createElement: tag => makeEl(tag),
    });
    assert(grid.querySelectorAll(".part-eye").length === 2,
      "构造即 refresh：静态清单首屏就有眼睛（首屏不 refresh 的话默认模型下 isolate 点不到）");
    mod.refresh();
    assert(grid.querySelectorAll(".part-eye").length === 2, "再次 refresh 不重复添加");
    const rows = grid.querySelectorAll(".part-item");
    rows[0].dispatch("click");
    assert(mod.getSelected() === "前面板", "先选中一行");
    mod.refresh();
    assert(mod.getSelected() === null, "refresh 重置选区");
    assert(hl[hl.length - 1] === null, "refresh 末尾清掉高亮");
    mod.destroy();
  });

  await it("部件名经 getAttribute('data-part') 也能取到", async() => {
    const { host, grid } = setupGrid([], { withEyes: false });
    const row = makeEl("div");
    row.setAttribute("class", "part-item");
    row.setAttribute("data-part", "面罩海绵");
    row.appendChild(makeEl("button"));
    row.children[0].setAttribute("class", "part-eye");
    grid.appendChild(row);
    const focus = [];
    const mod = createPartInteractions({
      getParts: () => PARTS,
      focusPart: name => focus.push(name),
      highlightPart: () => {},
      root: host,
    });
    row.querySelector(".part-eye").dispatch("click");
    assert(mod.getSelected() === "面罩海绵", `经 data-part 属性选中（实际 ${mod.getSelected()}）`);
    assert(focus.length === 0 || focus[0] !== "面罩海绵", "点眼睛只 isolate，不额外聚焦");
    mod.destroy();
  });

  await it("点眼睛内部的子节点也能命中（parentElement 上溯）", async() => {
    const { host, rows } = setupGrid(["主机身"]);
    const eye = rows[0].querySelector(".part-eye");
    const span = makeEl("span");
    eye.appendChild(span);
    const mod = createPartInteractions({
      getParts: () => PARTS,
      focusPart: () => {},
      highlightPart: () => {},
      root: host,
    });
    span.dispatch("click");
    assert(PARTS[1].mesh.visible === true && PARTS[0].mesh.visible === false, "点 span 也触发 isolate");
    mod.destroy();
  });

  await it("点清单外的元素：什么都不做", async() => {
    const { host, overlay } = setupGrid(["主机身"]);
    const hl = [];
    const mod = createPartInteractions({
      getParts: () => PARTS,
      focusPart: () => {},
      highlightPart: name => hl.push(name),
      root: host,
    });
    const before = hl.length; // 构造时的 refresh 会调一次 highlightPart(null)，从那之后再计
    overlay.dispatch("click");
    assert(hl.length === before && mod.getSelected() === null, "点清单外元素：无新增高亮调用、无选中");
    mod.destroy();
  });

  await it("清单缺失 / getParts 返回非数组：静默不抛", async() => {
    const host = makeEl("body");
    const mod = createPartInteractions({
      getParts: () => null,
      focusPart: () => {},
      highlightPart: () => {},
      root: host,
    });
    let threw = null;
    try {
      mod.refresh();
      host.dispatch("keydown", { key: "Escape" });
      mod.selectPart("主机身");
      mod.toggleIsolate("主机身");
      mod.restoreVisibility();
    } catch (e) {
      threw = e;
    }
    assert(threw === null, `全程不抛错（实际 ${threw && threw.message}）`);
    mod.destroy();
  });

  await it("exitIsolate：换了步骤才退 isolate（未 isolate 时返回 false 且不碰高亮）", async() => {
    const { host, rows } = setupGrid(PARTS.map(p => p.name));
    const hl = [];
    const mod = createPartInteractions({
      getParts: () => PARTS,
      focusPart: () => {},
      highlightPart: name => hl.push(name),
      root: host,
    });
    assert(mod.exitIsolate() === false, "未 isolate 时返回 false");
    rows[1].querySelector(".part-eye").dispatch("click");
    assert(mod.exitIsolate() === true, "isolate 中返回 true");
    assert(PARTS.every(p => p.mesh.visible === true), "exitIsolate 后全部恢复可见");
    assert(mod.getSelected() === "主机身", "退出 isolate 后仍保持选中（焦点不丢）");
    assert(hl[hl.length - 1] === "主机身", "高亮仍在选中部件上，未被清掉");
    assert(mod.getIsolated() === null, "getIsolated() 回到 null");
    mod.destroy();
  });

  await it("「全部显示」按钮：isolate 时出现、点击后恢复并清空选区", async() => {
    const { host, rows } = setupGrid(PARTS.map(p => p.name));
    const showAll = makeEl("button", { class: "btn-mini parts-show-all hidden" });
    const mod = createPartInteractions({
      getParts: () => PARTS,
      focusPart: () => {},
      highlightPart: () => {},
      root: host,
      showAllBtn: showAll,
    });
    assert(showAll.classList.has("hidden"), "初始隐藏");
    rows[2].dispatch("click");
    assert(showAll.classList.has("hidden"), "只是选中（未 isolate）时不出现");
    rows[2].querySelector(".part-eye").dispatch("click");
    assert(!showAll.classList.has("hidden"), "isolate 后出现");
    assert(showAll.getAttribute("aria-pressed") === "true", "aria-pressed=true");
    showAll.dispatch("click");
    assert(PARTS.every(p => p.mesh.visible === true), "点击后全部恢复可见");
    assert(showAll.classList.has("hidden"), "又隐藏回去");
    assert(mod.getSelected() === null, "选区一并清空");
    assert(showAll.getAttribute("aria-pressed") === "false", "aria-pressed=false");
    mod.destroy();
  });

  await it("点眼睛不会让 observer 与 refresh 互相喂养（真机回归：曾把渲染进程拖死）", async() => {
    const { host, rows } = setupGrid(PARTS.map(p => p.name));
    const mod = createPartInteractions({
      getParts: () => PARTS,
      focusPart: () => {},
      highlightPart: () => {},
      root: host,
    });
    // 构造时的 refresh 会写 DOM，但那发生在 observer 挂上之前：先把计数对齐
    domStats.notified = domStats.mutations;
    rows[1].querySelector(".part-eye").dispatch("click");
    // 变异数要在投递之前取：drainObservers 会把 notified 对齐到 mutations，
    // 事后再算差值恒为 0，等于没测
    const churn = domStats.mutations - domStats.notified;
    const rounds = drainObservers();
    assert(rounds <= 2, `点眼睛后 observer 只被唤醒 ${rounds} 轮（无条件重写眼睛文本会自激到 30 轮上限，页面直接卡死）`);
    assert(churn === 0, `isolate 不制造任何 DOM 增删（实际 ${churn} 条 childList 变异：眼睛文案/类名/属性都只是改写，不是增删节点）`);
    assert(mod.getIsolated() === "主机身", "isolate 状态仍然生效");
    assert(PARTS[1].mesh.visible === true && PARTS[0].mesh.visible === false, "可见性仍然正确");
    mod.destroy();
  });

  await it("observer 只在行集合变化时重置选区：行内增删节点不清选择", async() => {
    const { host, rows } = setupGrid(PARTS.map(p => p.name));
    const mod = createPartInteractions({
      getParts: () => PARTS,
      focusPart: () => {},
      highlightPart: () => {},
      root: host,
    });
    rows[0].dispatch("click");
    assert(mod.getSelected() === "前面板", "先选中一行");
    domStats.notified = domStats.mutations;
    // custom-model-panel 给每行写 innerHTML、装配分析往行里塞徽标，都是行内写入，
    // 行集合（data-part 清单）并没有变。这种写入不该把用户的选择清掉。
    rows[0].appendChild(makeEl("span", { class: "part-badge" }));
    const rounds = drainObservers();
    assert(mod.getSelected() === "前面板", `行集合没变时保留选区（实际 ${mod.getSelected()}）`);
    assert(rows[0].classList.has("active"), "行的激活态也没被擦掉");
    assert(rounds <= 2, `这种写入最多唤醒 observer ${rounds} 轮`);
    mod.destroy();
  });

  await it("清单整块替换：observer 仍会重置选区并补眼睛，且轮数有界", async() => {
    const { host, grid } = setupGrid(["前面板", "主机身"], { withEyes: false });
    const mod = createPartInteractions({
      getParts: () => PARTS,
      focusPart: () => {},
      highlightPart: () => {},
      root: host,
      createElement: tag => makeEl(tag),
    });
    grid.querySelectorAll(".part-item")[0].dispatch("click");
    assert(mod.getSelected() === "前面板", "先选中一行");
    domStats.notified = domStats.mutations;
    // 换模型：custom-model-panel 的做法是 partsGrid.innerHTML = "" 后逐行 appendChild
    grid.children = [];
    bumpMutations();
    for (const name of ["目镜罩", "头带"]) {
      const row = makeEl("div", { class: "part-item" });
      row.dataset.part = name;
      grid.appendChild(row);
    }
    const rounds = drainObservers();
    assert(rounds <= 4, `替换清单后 observer 收敛于 ${rounds} 轮`);
    assert(mod.getSelected() === null, "旧选区被重置（换模型后旧选区无意义）");
    assert(grid.querySelectorAll(".part-item").length === 2, "新行已就位");
    assert(grid.querySelectorAll(".part-eye").length === 2, "新行被补上眼睛按钮");
    mod.destroy();
  });

  await it("没有 root 且无全局 document 时不抛错", async() => {
    const prev = globalThis.document;
    Object.defineProperty(globalThis, "document", { value: undefined, configurable: true });
    let threw = null;
    try {
      const mod = createPartInteractions({ getParts: () => [], focusPart: () => {}, highlightPart: () => {} });
      mod.refresh();
      mod.destroy();
    } catch (e) {
      threw = e;
    }
    Object.defineProperty(globalThis, "document", { value: prev, configurable: true });
    assert(threw === null, `document 缺失时构造与调用都不抛（实际 ${threw && threw.message}）`);
  });
});

for (const { name, fn } of describeQueue) {
  console.log(`\n[${name}]`);
  await fn();
}

console.log("\n════════════════════════════════════════════════════════════════");
console.log(`  结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) {
  console.log("  失败项：");
  for (const f of failures) console.log(`    - ${f}`);
}
console.log(failed === 0 ? "  ✅ 全部测试通过！" : "  ❌ 存在失败");
process.exit(failed === 0 ? 0 : 1);
