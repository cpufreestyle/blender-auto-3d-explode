// 步骤 / 爆炸动画控制器（从 main.js 抽取，行为不变）。
//
// 原 main.js 的两块：
//   - 「分步骤拆解」里的 updateToolsList 与「步骤控制 UI」整段：highlightPart /
//     updateStepUI / exitMouseControl / goToStep / finishAnimation / toggleExplode /
//     setExplodeLoopUI / stopExplodeLoop / focusCurrentPart，加时间轴、爆炸循环、
//     深度滑块、画布鼠标控制与前后步按钮的全部事件绑定；
//   - 「部件动画插值」的 updateExplodedView（脏标记 + 分步/整体/鼠标三种炸开因子）。
//
// 状态归属是本模块唯一需要设计的地方，分成三类：
//   - 只在本模块存活的动画中间量（animationStart / mouseFactor / isAnimating /
//     isPlaying / playInterval / explodeAnim* / explodeAllMode / loopHoldMs /
//     explodeLoopTimer / highlightedPart / needsExplodeUpdate）收进闭包；
//   - main.js 多处会重赋值的共享状态（stepGroups / totalSteps / currentStep /
//     displayedStep / animatingStep / isExploded / explodeLoop / hasCustomModel /
//     customModelParts）经 s.* 惰性读、经 setState 立即回写。这些标识符在原文件里
//     被加载自定义模型、装配分析、清除模型等十余处写入，抽进闭包会把两边写岔，
//     因此保留在主模块、用响应式视图桥接；
//   - three.js 引用与 DOM 元素按值注入。
//
// setStepUIHook 承接 main.js 原来对 updateStepUI 的猴子补丁（在末尾追加
// 步骤描述淡入动画），连挂载时机都保持一致。

import { Color, MathUtils, Vector3 } from "three";
import { easeOutCubic, smoothStep } from "./utils.js";
// 步骤深链：把「学到第几步」镜像进地址栏，复制链接即可分发同一节课的进度。
// 借鉴 47ng/nuqs（MIT，10.8k★）「URL 即状态」：真相仍在 currentStep/displayedStep，
// 深链只是投影；写回走 replaceState，逐步点下来不会把浏览器历史灌爆。
import { applyStepFromLocation, syncStepToUrl } from "./step-link.js";

// 与 main.js 约定的共享状态键集合：s.* 读取走 getState()，写入走 setState({ key: value })
const SHARED_STATE_KEYS = [
  "stepGroups",
  "totalSteps",
  "currentStep",
  "displayedStep",
  "animatingStep",
  "isExploded",
  "explodeLoop",
  "hasCustomModel",
  "customModelParts",
];

/**
 * 创建步骤 / 爆炸动画控制器。
 *
 * @param {object} deps
 * @param {object} deps.camera / deps.controls / deps.renderer / deps.parts / deps.axisMat
 *   主模块的 const 稳定引用（parts 是 const 数组、只 push 不整体替换）
 * @param {object} deps.ui - 步骤与爆炸相关的 DOM 元素集合
 * @param {() => object} deps.getState - 读共享状态，键见 SHARED_STATE_KEYS
 * @param {(patch: object) => void} deps.setState - 写共享状态，只接收含变动键的 patch
 */
export function createExplodeController({
  camera,
  controls,
  renderer,
  parts,
  axisMat,
  ui,
  getState,
  setState,
  // 地址栏写回目标：生产传 window.location / window.history，测试环境（Node）下
  // window 不存在，两个默认值都是 null，所有写回自动退化成空操作。
  location = typeof window !== "undefined" ? window.location : null,
  history = typeof window !== "undefined" ? window.history : null,
}) {
  // 共享状态响应式视图：读时现取、写时立即回写，等价于直接操作 main.js 的那些 let
  const s = {};
  for (const key of SHARED_STATE_KEYS) {
    Object.defineProperty(s, key, {
      get: () => getState()[key],
      set: value => setState({ [key]: value }),
      enumerable: true,
    });
  }

  const {
    explodeBtn,
    timelineSlider,
    toolsListEl,
    prevBtn,
    nextBtn,
    resetBtn,
    stepNumberEl,
    stepNameEl,
    stepDescEl,
    progressFillEl,
    depthSlider,
    depthValueEl,
    timelineStepEl,
    timelinePlayBtn,
    timelineResetBtn,
    timelineSpeedSelect,
    explodeLoopBtn,
    explodeLoopSpeed,
  } = ui;

  // 地址栏同步：值没变就不写（updateStepUI 会被动画每帧调用，白写会写穿 history）
  function syncStepUrl(step) {
    syncStepToUrl({ location, history, step });
  }

  console.log("Step UI elements:", {
    prevBtn: !!prevBtn,
    nextBtn: !!nextBtn,
    resetBtn: !!resetBtn,
    stepNumberEl: !!stepNumberEl,
    stepNameEl: !!stepNameEl,
    stepDescEl: !!stepDescEl,
    progressFillEl: !!progressFillEl,
    autoRotateCheck: !!ui.autoRotateCheck,
  });

  // 工具清单更新
  function updateToolsList(step) {
    if (!toolsListEl) return;

    const tools = step.tools || [];

    if (tools.length === 0) {
      toolsListEl.innerHTML = "<div class=\"tools-none\">✅ 本步骤无需工具</div>";
    } else {
      toolsListEl.innerHTML = tools.map(tool => `<div class="tool-item">${tool}</div>`).join("");
    }
  }

  // ===== 步骤控制 UI =====
  // currentStep / displayedStep / animatingStep 声明见文件上方「模块共享状态与引用」
  let animationStart = 0; // 动画开始时间
  let animationFrom = 0; // 动画起始步骤
  let mouseFactor = 0; // 鼠标控制炸开因子 (0-1)
  let mouseControlEnabled = false; // 是否启用鼠标控制
  const stepDuration = 600; // 每步动画时长（毫秒）
  let isAnimating = false;
  let timelineDragging = false; // 用户是否正在拖动时间轴（拖动中禁止程序回写滑块值）
  let depthActive = false; // 爆炸深度滑块是否接管了观看姿态（此时忽略分步位置）
  let depthDragging = false; // 用户是否正在拖动深度滑块（拖动中禁止程序回写）
  let depthFactor = 0; // 滑块设定的观看因子 (0-1)

  // ===== 一键爆炸/合体的平滑动画（所有部件同时炸开/合体）=====
  let explodeAnimActive = false; // 是否正在播放爆炸/合体动画
  let explodeAnimFrom = 0; // 起始全局炸开因子 (0=合体, 1=完全炸开)
  let explodeAnimTo = 0; // 目标全局炸开因子
  let explodeAnimStart = 0; // 动画开始时间戳
  let explodeAnimFactor = 0; // 当前全局炸开因子
  let explodeAllMode = false; // true 时所有部件按同一因子同时炸开（忽略分步）
  let explodeAnimDuration = 1100; // 爆炸动画时长（毫秒，受循环速度档控制）
  let loopHoldMs = 900; // 循环播放时炸开/合体之间的停留时间（毫秒）
  let explodeLoopTimer = null; // 循环反向定时器，便于手动接管时取消
  let needsExplodeUpdate = true; // 部件位置脏标记：为 false 时 updateExplodedView 跳过重算
  // explodeLoop / isExploded 是共享状态（s.* 桥接）；explodeBtn 由 ui 注入；
  // autoExplodeTimer 属于 main.js 的「少点击」自动爆炸逻辑，不随本模块搬迁

  // easeOutCubic 已从 src/utils.js 导入

  // 部件高亮相关
  const highlightEmissive = new Color(0x4a9eff);
  const highlightScale = 1.08;
  let highlightedPart = null; // 当前高亮的部件

  function highlightPart(partName) {
    // 清除之前的高亮
    if (highlightedPart) {
      if (highlightedPart.mesh.material && highlightedPart.mesh.material.emissive) {
        highlightedPart.mesh.material.emissive.setHex(0x000000);
      }
      highlightedPart.mesh.scale.setScalar(1);
    }

    // 设置新高亮
    if (partName) {
      // 先在默认部件中查找
      let part = parts.find(p => p.name === partName);
      // 如果没找到且正在使用自定义模型，在自定义部件中查找
      if (!part && s.hasCustomModel) {
        part = s.customModelParts.find(p => p.name === partName);
      }
      if (part) {
        highlightedPart = part;
        if (part.mesh.material && part.mesh.material.emissive) {
          part.mesh.material.emissive.copy(highlightEmissive);
        }
        part.mesh.scale.setScalar(highlightScale);
      }
    } else {
      highlightedPart = null;
    }
  }


  // main.js 原来在模块尾部对 updateStepUI 打猴子补丁；这里改成显式钩子，
  // 连「首次刷新不触发」的时机也保持一致（钩子由 main.js 在首屏刷新之后挂上）。
  let stepUIHook = null;
  function updateStepUI() {
    // 在鼠标控制模式下，显示当前的鼠标控制步骤
    const displayStep = mouseControlEnabled ? Math.round(mouseFactor * s.totalSteps) : s.displayedStep;
    stepNumberEl.textContent = `步骤 ${displayStep} / ${s.totalSteps}`;
    stepNameEl.textContent = s.stepGroups[Math.min(displayStep, s.totalSteps - 1)].name;

    // 更新步骤说明
    const stepIndex = Math.min(displayStep, s.totalSteps - 1);
    const step = s.stepGroups[stepIndex];
    if (step && stepDescEl) {
      stepDescEl.innerHTML = step.description || "";
    }

    // 更新工具清单
    updateToolsList(step);

    // 更新部件高亮
    if (step && step.parts.length > 0) {
      highlightPart(step.parts[0]);
    } else {
      highlightPart(null);
    }

    progressFillEl.style.width = `${(displayStep / s.totalSteps) * 100}%`;

    // 动画过程中禁用按钮，防止连续点击导致步骤混乱
    prevBtn.disabled = isAnimating || (mouseControlEnabled ? false : s.displayedStep <= 0);
    nextBtn.disabled = isAnimating || (mouseControlEnabled ? false : s.displayedStep >= s.totalSteps);
    resetBtn.disabled = isAnimating || mouseControlEnabled;

    // 更新时间轴
    if (timelineSlider) {
      // 用户正在拖动时不要回写，否则会把拖动的目标值冲掉（表现为「拖时间轴没反应」）
      // 赋字符串：真实 DOM 会自动 normalize，测试假 DOM 不会，类型不一致会埋坑
      if (!timelineDragging) timelineSlider.value = String(displayStep);
      timelineStepEl.textContent = displayStep;
    }

    // 深度读数跟着教学进度走：炸开程度由当前步骤的进度决定，
    // 避免出现时间轴说第 6 步、深度滑块还停在 20% 的自相矛盾。
    // 滑块正被拖动、或滑块正在接管观看姿态时都不回写。
    if (depthSlider && !depthActive && !depthDragging) {
      const pct = Math.round((s.currentStep / s.totalSteps) * 100);
      depthSlider.value = String(pct);
      depthValueEl.textContent = pct + "%";
    }

    if (stepUIHook) stepUIHook();
  }

  // 退出鼠标控制模式，将当前 mouseFactor 同步到 currentStep/displayedStep
  function exitMouseControl() {
    mouseControlEnabled = false;
    depthActive = false; // 鼠标控制退出后交回分步进度
    needsExplodeUpdate = true; // 标记需要重新计算
    s.isExploded = false;
    explodeBtn?.classList.remove("exploded");
    if (explodeBtn) explodeBtn.textContent = "💥 爆炸";
    // 把 mouseFactor 对应的步骤同步到 displayedStep，保证动画从当前位置开始
    s.displayedStep = Math.round(mouseFactor * s.totalSteps);
    s.currentStep = mouseFactor * s.totalSteps;
  }

  function goToStep(newStep) {
    newStep = MathUtils.clamp(newStep, 0, s.totalSteps);
    if (newStep === s.displayedStep || isAnimating) return;

    depthActive = false; // 分步控制接管，深度滑块退出
    stopExplodeLoop(); // 手动分步控制接管，停止循环播放
    syncStepUrl(newStep); // 深链跟着步骤走，点开链接即落在同一步
    needsExplodeUpdate = true; // 标记需要重新计算部件位置
    animationFrom = s.currentStep;
    s.animatingStep = newStep;
    animationStart = performance.now();
    isAnimating = true;
    updateStepUI();
  }

  function finishAnimation() {
    isAnimating = false;
    s.currentStep = s.animatingStep;
    s.displayedStep = s.animatingStep;
    syncStepUrl(s.displayedStep); // 动画落定后再同步一次，避免中途值覆盖最终值
    updateStepUI();
  }

  // 时间轴控制
  let isPlaying = false;
  let playInterval = null;

  if (timelineSlider) {
    timelineSlider.addEventListener("input", e => {
      if (mouseControlEnabled) exitMouseControl();
      const step = parseInt(e.target.value);
      goToStep(step);
    });
  }

  // 拖动期间锁定滑块值，松手时才让 updateStepUI 重新接管显示
  if (timelineSlider) {
    timelineSlider.addEventListener("pointerdown", () => { timelineDragging = true; });
    timelineSlider.addEventListener("pointerup", () => { timelineDragging = false; });
    timelineSlider.addEventListener("pointercancel", () => { timelineDragging = false; });
    timelineSlider.addEventListener("blur", () => { timelineDragging = false; });
  }

  // 深度滑块同理：拖动中不被 updateStepUI 回写覆盖
  if (depthSlider) {
    depthSlider.addEventListener("pointerdown", () => { depthDragging = true; });
    const endDepthDrag = () => { depthDragging = false; };
    depthSlider.addEventListener("pointerup", endDepthDrag);
    depthSlider.addEventListener("pointercancel", endDepthDrag);
    depthSlider.addEventListener("blur", endDepthDrag);
  }

  if (timelinePlayBtn) {
    timelinePlayBtn.addEventListener("click", () => {
      if (mouseControlEnabled) exitMouseControl();
      if (isPlaying) {
        // 暂停
        clearInterval(playInterval);
        isPlaying = false;
        timelinePlayBtn.textContent = "▶️ 播放";
      } else {
        // 播放
        isPlaying = true;
        timelinePlayBtn.textContent = "⏸️ 暂停";

        const speed = parseFloat(timelineSpeedSelect?.value || 1);
        const interval = 700 / speed; // 每步时间

        playInterval = setInterval(() => {
          if (s.displayedStep >= s.totalSteps) {
            clearInterval(playInterval);
            isPlaying = false;
            timelinePlayBtn.textContent = "▶️ 播放";
            return;
          }
          goToStep(s.displayedStep + 1);
        }, interval);
      }
    });
  }

  if (timelineResetBtn) {
    timelineResetBtn.addEventListener("click", () => {
      if (mouseControlEnabled) exitMouseControl();
      if (isPlaying) {
        clearInterval(playInterval);
        isPlaying = false;
        timelinePlayBtn.textContent = "▶️ 播放";
      }
      goToStep(0);
    });
  }

  // 点击步骤按钮时，自动退出鼠标控制模式，让步骤动画接管
  prevBtn.addEventListener("click", () => {
    if (mouseControlEnabled) exitMouseControl();
    goToStep(s.displayedStep - 1);
  });
  nextBtn.addEventListener("click", () => {
    if (mouseControlEnabled) exitMouseControl();
    goToStep(s.displayedStep + 1);
  });
  resetBtn.addEventListener("click", () => {
    if (mouseControlEnabled) exitMouseControl();
    goToStep(0);
  });

  function toggleExplode() {
    s.isExploded = !s.isExploded;
    // 退出其它控制模式，由本次爆炸动画接管
    mouseControlEnabled = false;
    depthActive = false; // 一键爆炸接管，深度滑块退出
    explodeAllMode = true;
    isAnimating = false;
    clearInterval(playInterval);
    if (timelinePlayBtn) timelinePlayBtn.textContent = "▶️ 播放";
    isPlaying = false;

    if (s.isExploded) {
      // 进入爆炸模式：所有部件平滑炸开到完全展开
      explodeBtn.classList.add("exploded");
      explodeBtn.textContent = "🔄 合体";
      explodeAnimFrom = explodeAnimFactor; // 从当前状态开始
      explodeAnimTo = 1;
    } else {
      // 退出爆炸模式：所有部件平滑合体
      explodeBtn.classList.remove("exploded");
      explodeBtn.textContent = "💥 爆炸";
      explodeAnimFrom = explodeAnimFactor;
      explodeAnimTo = 0;
    }
    explodeAnimStart = performance.now();
    explodeAnimActive = true;
    needsExplodeUpdate = true;
    updateStepUI();
  }

  explodeBtn.addEventListener("click", toggleExplode);



  // 更新循环按钮的视觉状态
  function setExplodeLoopUI() {
    if (!explodeLoopBtn) return;
    explodeLoopBtn.classList.toggle("active", s.explodeLoop);
    explodeLoopBtn.textContent = s.explodeLoop ? "🔁 循环中" : "🔁 循环";
  }

  // 停止循环播放，并切回分步/滑块控制
  function stopExplodeLoop() {
    s.explodeLoop = false;
    if (explodeLoopTimer) {
      clearTimeout(explodeLoopTimer);
      explodeLoopTimer = null;
    }
    explodeAnimActive = false; // 中止进行中的循环动画
    explodeAllMode = false;
    setExplodeLoopUI();
  }

  if (explodeLoopBtn) {
    explodeLoopBtn.addEventListener("click", () => {
      s.explodeLoop = !s.explodeLoop;
      if (s.explodeLoop && !s.isExploded) {
        // 开启循环且当前为合体状态，立即开始炸开并循环
        setExplodeLoopUI();
        toggleExplode();
      } else if (s.explodeLoop) {
        // 已是炸开状态，继续循环（先合体再往复）
        setExplodeLoopUI();
      } else {
        // 关闭循环：停在当前状态
        stopExplodeLoop();
      }
    });
  }

  // 循环速度档：影响动画时长与炸开/合体之间的停留时间
  if (explodeLoopSpeed) {
    explodeLoopSpeed.addEventListener("change", e => {
      const v = parseFloat(e.target.value) || 1;
      explodeAnimDuration = Math.round(1100 / v);
      loopHoldMs = Math.round(900 / v);
    });
  }

  // 爆炸深度滑块
  if (depthSlider && depthValueEl) {
    depthSlider.addEventListener("input", e => {
      const depth = parseInt(e.target.value);
      depthValueEl.textContent = `${depth}%`;

      // 退出鼠标/整体炸开控制模式，让滑块接管
      if (mouseControlEnabled) exitMouseControl();
      stopExplodeLoop(); // 深度滑块接管，停止循环播放

      // 计算炸开因子 (0-1)
      const factor = depth / 100;

      // 如果不在动画中，直接应用。注意：这里只改「观看姿态」，
      // 不写 currentStep/displayedStep —— 那两个字段属于教学步骤（学到第几步），
      // 深度滑块回答的是「现在拆得多开」，两者混用会让调深度把课程进度一起改掉，
      // 时间轴读数也会跟着跳到意料之外的位置。
      if (!isAnimating) {
        needsExplodeUpdate = true; // 标记需要重新计算
        depthFactor = factor; // 滑块接管时的观看因子
        depthActive = true; // 滑块接管，直到分步/一键爆炸把姿态抢回去
        explodeAnimFactor = factor; // 同步整体炸开因子，供后续动画续接
      }

      // 更新爆炸状态
      if (depth > 0 && !s.isExploded) {
        s.isExploded = true;
        explodeBtn.classList.add("exploded");
        explodeBtn.textContent = "🔄 合体";
      } else if (depth === 0 && s.isExploded) {
        s.isExploded = false;
        explodeBtn.classList.remove("exploded");
        explodeBtn.textContent = "💥 爆炸";
      }
    });
  }

  // 聚焦指定名称的部件：找不到返回 false，其余与下方相机动画一致
  function focusPart(partName) {
    let part = parts.find(p => p.name === partName);
    if (!part && s.hasCustomModel) {
      part = s.customModelParts.find(p => p.name === partName);
    }
    if (!part) return false;

    // 平滑移动相机到部件位置
    const targetPos = part.mesh.position.clone();
    const cameraOffset = new Vector3(2, 1.5, 2);
    const newCameraPos = targetPos.clone().add(cameraOffset);

    // 简单的动画
    const startPos = camera.position.clone();
    const startTarget = controls.target.clone();
    const duration = 800;
    const startTime = performance.now();

    function animateCamera(now) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);

      camera.position.lerpVectors(startPos, newCameraPos, eased);
      controls.target.lerpVectors(startTarget, targetPos, eased);

      if (progress < 1) {
        requestAnimationFrame(animateCamera);
      }
    }

    requestAnimationFrame(animateCamera);
    return true;
  }

  // 聚焦当前步骤的第一个部件（部件清单点击走 focusPart，二者共用同一段动画）
  function focusCurrentPart() {
    const step = s.stepGroups[Math.min(s.displayedStep, s.totalSteps - 1)];
    if (!step || step.parts.length === 0) return;
    focusPart(step.parts[0]);
  }

  // 鼠标移动控制炸开范围
  renderer?.domElement?.addEventListener("mousemove", e => {
    if (!mouseControlEnabled) return;

    stopExplodeLoop(); // 鼠标接管，停止循环播放

    // 计算鼠标在屏幕上的相对位置（0-1）
    const el = renderer && renderer.domElement;
    if (!el) return; // 渲染器/画布尚未就绪（预览或 WebGL 不可用时）时安全跳过
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const y = (e.clientY - rect.top) / rect.height;

    // 使用鼠标Y轴位置控制炸开范围：鼠标越往下，炸开越大
    mouseFactor = Math.max(0.1, y * 1.2); // 最小保持 0.1 的炸开
    explodeAnimFactor = mouseFactor; // 同步整体炸开因子，供后续动画续接

    // 更新当前步骤显示
    s.currentStep = mouseFactor * s.totalSteps;
    s.displayedStep = Math.round(s.currentStep);
    updateStepUI();
  });

  // 鼠标离开画布时，保持当前炸开程度（无需额外处理）

  // 双击恢复按钮控制
  explodeBtn.addEventListener("dblclick", () => {
    if (s.isExploded) {
      mouseControlEnabled = false;
      explodeBtn.textContent = "🔄 合体";
      console.log("已切换回按钮控制模式");
    }
  });

  // ===== 部件动画插值 =====
  // smoothStep 已从 src/utils.js 导入

  // 优化：脏标记，避免每帧都重新计算部件位置（needsExplodeUpdate 声明见上方「爆炸/拆解状态」区）

  function updateExplodedView(now) {
    if (isAnimating) {
      const elapsed = now - animationStart;
      let progress = elapsed / stepDuration;

      if (progress >= 1) {
        progress = 1;
        finishAnimation();
      }

      const eased = easeOutCubic(progress);
      s.currentStep = animationFrom + (s.animatingStep - animationFrom) * eased;
      needsExplodeUpdate = true; // 动画中每帧都需要更新
    } else if (explodeAnimActive) {
      // 一键爆炸/合体的整体平滑动画
      const elapsed = now - explodeAnimStart;
      let progress = elapsed / explodeAnimDuration;
      if (progress >= 1) {
        progress = 1;
        explodeAnimActive = false;
        explodeAnimFactor = explodeAnimTo; // 锁定到目标状态
        // 循环播放：停留片刻后自动反向（合体↔炸开）
        if (s.explodeLoop) {
          explodeLoopTimer = setTimeout(() => {
            explodeLoopTimer = null;
            if (s.explodeLoop) toggleExplode();
          }, loopHoldMs);
        }
      } else {
        const eased = easeOutCubic(progress);
        explodeAnimFactor = explodeAnimFrom + (explodeAnimTo - explodeAnimFrom) * eased;
      }
      needsExplodeUpdate = true; // 动画中每帧都需要更新
    }

    // 优化：如果状态未变化，跳过部件位置计算
    if (!needsExplodeUpdate) return;

    // 整体炸开模式下，所有部件使用同一因子；否则按分步/鼠标因子
    const globalFactor = explodeAllMode ?
      explodeAnimFactor :
      mouseControlEnabled ?
        mouseFactor :
        depthActive ?
          depthFactor :
          s.currentStep / s.totalSteps;
    axisMat.opacity = globalFactor * 0.5;

    // 统一的部件更新函数（避免重复代码）
    const updatePart = part => {
      // 观看因子：整体炸开 > 鼠标控制 > 深度滑块 > 分步进度。
      // 深度滑块只改「整体观看姿态」，部件仍按各自的 stepIndex 渐进展开，
      // 所以下面依旧走 smoothStep，只是把进度换成滑块给出的连续值。
      const depthProgress = depthActive ? depthFactor * s.totalSteps : s.currentStep;
      const partFactor = explodeAllMode ?
        explodeAnimFactor :
        smoothStep(
          part.stepIndex - 1,
          part.stepIndex,
          mouseControlEnabled ? mouseFactor * s.totalSteps : depthProgress,
        );

      part.mesh.position.lerpVectors(part.homePos, part.explodePos, partFactor);
      part.mesh.rotation.x = MathUtils.lerp(part.homeRot.x, part.explodeRot.x, partFactor);
      part.mesh.rotation.y = MathUtils.lerp(part.homeRot.y, part.explodeRot.y, partFactor);
      part.mesh.rotation.z = MathUtils.lerp(part.homeRot.z, part.explodeRot.z, partFactor);
    };

    // Quest 3 默认部件
    parts.forEach(updatePart);

    // 自定义模型部件（渐进式拆解，每个部件有自己的 stepIndex）
    if (s.hasCustomModel && s.customModelParts.length > 0) {
      s.customModelParts.forEach(updatePart);
    }

    // 非动画、非鼠标、非整体炸开动画时，标记为已更新（冻结当前状态）
    if (!isAnimating && !mouseControlEnabled && !explodeAnimActive) {
      needsExplodeUpdate = false;
    }
  }
  // 首屏应用深链：#step=N 比当前步大/小时由 goToStep 动画落位，重复或非法值不动
  function applyDeepLink() {
    return applyStepFromLocation({
      location,
      goToStep,
      totalSteps: s.totalSteps,
      currentStep: s.displayedStep,
    });
  }

  // 地址栏被直接改写（用户粘贴链接、点历史记录）时跟着走
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("hashchange", () => applyDeepLink());
  }

  return {
    updateStepUI,
    goToStep,
    applyDeepLink,
    toggleExplode,
    focusCurrentPart,
    focusPart,
    highlightPart,
    updateExplodedView,
    setStepUIHook: hook => {
      stepUIHook = hook;
    },
  };
}
