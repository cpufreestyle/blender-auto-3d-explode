// 部件清单交互：点击高亮 + 相机聚焦 + 单独显示（isolate）
//
// 背景：.parts-grid 里的部件行此前只是展示——index.html 的静态清单与
// src/custom-model-panel.js 动态生成的清单都一样，点了没有任何反应；而
// explode-controller 里的 highlightPart / focusPart 早就能用，缺的只是接线。
// 对一个拆解教学工具来说，「看一眼清单找不到东西」是最难受的实用性缺口。
//
// 做法：
//   - 在容器上做事件委托。custom-model-panel 会整块替换 partsGrid.innerHTML，
//     只有委托才能同时覆盖默认清单、自定义清单和清除后的恢复清单；
//   - 眼睛按钮由本模块补齐（refresh），不写死在任一模板里，三处清单因此不会漂移；
//   - MutationObserver 监听清单替换，替换即重置选区（换模型后旧选区无意义）。
//
// 交互语义：
//   - 点行（非眼睛）：选中该部件 → 高亮 + 相机聚焦；再点一次取消选中；
//   - 点眼睛：单独显示该部件（其余 mesh.visible=false）；再点恢复全部；
//   - Escape：取消选中并恢复全部可见。
//
// 依赖注入：getParts 惰性读当前部件（默认 parts + 自定义 customModelParts），
// focusPart / highlightPart 来自 explode-controller。容器或元素缺失时静默跳过，
// 不抛错——与仓库其它面板模块一致。

const EYE_TITLE = "单独显示该部件（其余部件暂时隐藏）";
const EYE_TITLE_ON = "恢复显示全部部件";

export function createPartInteractions({
  getParts,
  focusPart,
  highlightPart,
  root,
  createElement,
  showAllBtn,
}) {
  const host = root || (typeof document !== "undefined" ? document : null);
  let selectedName = null;
  let isolatedName = null;

  const allParts = () => {
    const list = typeof getParts === "function" ? getParts() : [];
    return Array.isArray(list) ? list : [];
  };

  const findGrid = () => (host && host.querySelector ? host.querySelector(".parts-grid") : null);

  const rows = grid => (grid && grid.querySelectorAll ? Array.from(grid.querySelectorAll(".part-item")) : []);

  const rowName = row => {
    if (row.dataset && row.dataset.part) return row.dataset.part;
    if (typeof row.getAttribute === "function") return row.getAttribute("data-part");
    return null;
  };

  const rowBy = name => rows(findGrid()).find(r => rowName(r) === name) || null;

  const make = tag => {
    if (typeof createElement === "function") return createElement(tag);
    const doc = (host && host.ownerDocument) || (typeof document !== "undefined" ? document : null);
    return doc && doc.createElement ? doc.createElement(tag) : null;
  };

  const makeEye = () => {
    const btn = make("button");
    if (!btn) return null;
    btn.type = "button";
    btn.className = "part-eye";
    btn.title = EYE_TITLE;
    btn.textContent = "👁";
    return btn;
  };

  // 为缺失眼睛按钮的行补上（幂等）：换模型后新行也能立刻有眼睛
  const ensureEyes = grid => {
    for (const row of rows(grid)) {
      if (!row.querySelector || !row.querySelector(".part-eye")) {
        const eye = makeEye();
        if (eye && row.appendChild) row.appendChild(eye);
      }
    }
  };

  // 「全部显示」按钮：isolate 期间才出现，给不看提示的用户一条可见退路
  const syncShowAll = () => {
    if (!showAllBtn) return;
    if (showAllBtn.classList) showAllBtn.classList.toggle("hidden", !isolatedName);
    if (showAllBtn.setAttribute) showAllBtn.setAttribute("aria-pressed", isolatedName ? "true" : "false");
  };

  // 眼睛按钮的文案/提示只在真的变了时才写。无条件重写文本节点在 Blink 里是一次
  // childList 变异（移除旧文本节点 + 插入新节点），而 observer 正听着 grid 的
  // subtree childList：refresh 每写一次就再触发一次 observer，两边互相喂养，
  // 渲染进程会被拖死（点击「单独显示」即触发）。因此这里写前先比一次。
  const paintEye = (eye, on) => {
    if (!eye) return;
    if (eye.textContent !== "👁") eye.textContent = "👁";
    const title = on ? EYE_TITLE_ON : EYE_TITLE;
    if (eye.title !== title) eye.title = title;
    if (typeof eye.setAttribute === "function") eye.setAttribute("aria-pressed", on ? "true" : "false");
  };

  const clearRowMarks = () => {
    for (const row of rows(findGrid())) {
      if (row.classList) {
        row.classList.remove("active");
        row.classList.remove("isolated");
      }
      paintEye(row.querySelector ? row.querySelector(".part-eye") : null, false);
    }
  };

  const markActive = name => {
    for (const row of rows(findGrid())) {
      if (!row.classList) continue;
      if (rowName(row) === name) row.classList.add("active");
      else row.classList.remove("active");
    }
  };

  const markIsolated = name => {
    for (const row of rows(findGrid())) {
      const on = rowName(row) === name;
      if (row.classList && on) row.classList.add("isolated");
      else if (row.classList) row.classList.remove("isolated");
      paintEye(row.querySelector ? row.querySelector(".part-eye") : null, on);
    }
  };

  function restoreVisibility() {
    isolatedName = null;
    for (const part of allParts()) {
      if (part && part.mesh) part.mesh.visible = true;
    }
    clearRowMarks();
    syncShowAll();
    if (selectedName) markActive(selectedName);
  }

  function clearSelection() {
    selectedName = null;
    if (typeof highlightPart === "function") highlightPart(null);
    markActive(null);
  }

  function selectPart(name, { focus = true } = {}) {
    if (!name) return false;
    if (selectedName === name) {
      clearSelection();
      return false;
    }
    // 换了目标就退出单独显示：否则用户点 A、眼里只有 B，反而更困惑
    if (isolatedName) restoreVisibility();
    selectedName = name;
    if (typeof highlightPart === "function") highlightPart(name);
    if (focus && typeof focusPart === "function") focusPart(name);
    markActive(name);
    return true;
  }

  function toggleIsolate(name) {
    if (!name) return false;
    if (isolatedName === name) {
      restoreVisibility();
      return false;
    }
    isolatedName = name;
    selectedName = name;
    if (typeof highlightPart === "function") highlightPart(name);
    for (const part of allParts()) {
      if (part && part.mesh) part.mesh.visible = part.name === name;
    }
    markActive(name);
    markIsolated(name);
    syncShowAll();
    return true;
  }

  // 切换步骤时调用：单独显示是「盯住一个部件」的状态，往前拆解时半隐的模型只会添乱
  function exitIsolate() {
    if (!isolatedName) return false;
    restoreVisibility();
    return true;
  }

  // 上一次清单的行签名（按顺序拼每个 data-part）。observer 回调靠它区分
  // 「清单被换掉了」和「行里有什么东西变过」——后者包含 refresh 自己造成的
  // DOM 写入，无条件跟着重置就会形成自激循环。
  let rowSignature = null;
  const rowSignatureOf = grid => rows(grid).map(rowName).join("\n");

  // 清单被整块替换（切换/清除模型）后调用：重置选区并给新行补眼睛
  function refresh() {
    const grid = findGrid();
    if (!grid) return;
    ensureEyes(grid);
    selectedName = null;
    isolatedName = null;
    if (typeof highlightPart === "function") highlightPart(null);
    clearRowMarks();
    syncShowAll();
    rowSignature = rowSignatureOf(grid);
  }

  const walkUp = (node, cls) => {
    let n = node;
    while (n) {
      if (n.classList && typeof n.classList.contains === "function" && n.classList.contains(cls)) return n;
      n = n.parentElement || n.parentNode || null;
    }
    return null;
  };

  const onClick = ev => {
    const eye = walkUp(ev && ev.target, "part-eye");
    const row = eye ? walkUp(eye.parentElement, "part-item") : walkUp(ev && ev.target, "part-item");
    if (!row) return;
    const name = rowName(row);
    if (!name) return;
    if (eye) toggleIsolate(name);
    else selectPart(name);
  };

  const onKeydown = ev => {
    const key = ev && ev.key;
    if (key !== "Escape" && key !== "Esc") return;
    if (!selectedName && !isolatedName) return;
    if (isolatedName) restoreVisibility();
    clearSelection();
  };

  const onShowAllClick = () => {
    restoreVisibility();
    clearSelection();
  };
  if (showAllBtn && typeof showAllBtn.addEventListener === "function") {
    showAllBtn.addEventListener("click", onShowAllClick);
  }

  if (host && typeof host.addEventListener === "function") {
    host.addEventListener("click", onClick);
    host.addEventListener("keydown", onKeydown);
  }

  // 首屏也要补眼睛：index.html 的静态清单不会触发 MutationObserver，
  // 不主动 refresh 一次的话，默认模型下 isolate 根本点不到
  refresh();

  // 清单整块替换时自动 reset（浏览器环境；测试的假 DOM 没有 observe 能力，失败即跳过）
  let observer = null;
  const win = host && host.ownerDocument ? host.ownerDocument.defaultView : null;
  const ObserverCtor = (win && win.MutationObserver) || (typeof MutationObserver !== "undefined" ? MutationObserver : null);
  const grid = ObserverCtor ? findGrid() : null;
  if (ObserverCtor && grid) {
    try {
      observer = new ObserverCtor(() => {
        const current = findGrid();
        if (!current) return;
        // 行集合没变就什么都不做：类名 / 文本 / 属性的变动不该重置选区，
        // 而 refresh 自己也会写 DOM，跟着通知就会无限循环
        if (rowSignatureOf(current) === rowSignature) return;
        refresh();
      });
      observer.observe(grid, { childList: true, subtree: true });
    } catch {
      observer = null;
    }
  }

  return {
    selectPart,
    toggleIsolate,
    clearSelection,
    restoreVisibility,
    exitIsolate,
    refresh,
    getSelected: () => selectedName,
    getIsolated: () => isolatedName,
    destroy() {
      if (host && typeof host.removeEventListener === "function") {
        host.removeEventListener("click", onClick);
        host.removeEventListener("keydown", onKeydown);
      }
      if (showAllBtn && typeof showAllBtn.removeEventListener === "function") {
        showAllBtn.removeEventListener("click", onShowAllClick);
      }
      if (observer) observer.disconnect();
    },
  };
}
