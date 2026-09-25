// 自定义模型面板的 UI 同步与清除复位（从 main.js 抽取，行为不变）。
//
// 搬迁 main.js 的两个函数：
//   - updateCustomModelUI：加载/拆分完成后把部件清单、计数、时间轴范围、
//     模型名同步到面板（customModelParts 经 getCustomModelParts() 惰性读取，
//     与 upload-panel / model-fit 同一约定）；
//   - clearCustomModel：清除自定义模型、恢复默认 Quest 3 的可见性、步骤
//     系统、面板状态与爆炸按钮，并重排默认部件的步骤索引。
//
// 依赖注入（与 explode-controller / model-disposal 同一约定）：
//   - hasCustomModel / currentModelName / stepGroups / totalSteps / currentStep /
//     displayedStep / animatingStep / isExploded 八个共享状态经 getState/setState
//     桥接读写，与 main.js 的 let 是同一份；
//   - questGroup / parts / timelineSlider / explodeBtn 按 const 稳定引用注入
//     （脚本置于 body 末尾，DOM 已就绪）；
//   - defaultStepGroups 直接注入；clearCustomModelGroup / updateStepUI /
//     fitCameraToModel / showStatus 均为注入回调。
//
// 两函数对缺失 DOM 元素一律静默跳过（原行为：逐个 if 守卫），单测以
// withElements=false 锁定该韧性。

/**
 * 创建自定义模型面板控制器。
 *
 * @param {object} deps
 * @param {() => object} deps.getState 读取共享状态
 * @param {() => Array<object>} deps.getCustomModelParts 惰性读当前自定义部件
 * @param {(patch: object) => void} deps.setState 写回共享状态（只含变动键）
 * @param {object} deps.questGroup main.js 的 const 稳定引用（Group）
 * @param {Array<object>} deps.parts Quest 3 默认部件（const 稳定引用）
 * @param {object} deps.timelineSlider 时间轴滑块 DOM（可为 null）
 * @param {object} deps.explodeBtn 爆炸按钮 DOM（可为 null）
 * @param {Array<object>} deps.defaultStepGroups 默认（Quest 3）步骤方案
 * @param {() => void} deps.clearCustomModelGroup 清理旧自定义模型
 * @param {() => void} deps.updateStepUI 步骤 UI 刷新（explodeCtl.updateStepUI）
 * @param {(group: object, smooth?: boolean) => void} deps.fitCameraToModel 相机适配
 * @param {(msg: string, type?: string) => void} deps.showStatus 轻提示
 * @returns {{ updateCustomModelUI: (partCount: number, fileName: string) => void, clearCustomModel: () => void }}
 */
export function createCustomModelPanel({
  getState,
  setState,
  getCustomModelParts,
  questGroup,
  parts,
  timelineSlider,
  explodeBtn,
  defaultStepGroups,
  clearCustomModelGroup,
  updateStepUI,
  fitCameraToModel,
  showStatus,
}) {
  /**
   * 把当前自定义模型同步到面板：部件计数、当前模型名、清除按钮、时间轴
   * 范围与部件清单（圆点颜色取材质色）。
   * @param {number} partCount 部件总数
   * @param {string} fileName 模型文件名（用于命名与展示）
   */
  function updateCustomModelUI(partCount, fileName) {
    const countEl = document.getElementById("part-count");
    if (countEl) countEl.textContent = partCount;

    // 记录模型名（去掉扩展名），供截图 / 教案导出命名
    if (fileName) setState({ currentModelName: String(fileName).replace(/\.[^.]+$/, "") });

    const uploadSection = document.querySelector(".panel");
    if (uploadSection) {
      const fileNameEl = document.getElementById("uploaded-file-name");
      if (fileNameEl) fileNameEl.textContent = `当前模型：${fileName}`;
    }

    const clearBtn = document.getElementById("clear-model-btn");
    if (clearBtn) clearBtn.style.display = "inline-block";

    // 更新时间轴总数
    const timelineTotalEl = document.getElementById("timeline-total");
    if (timelineTotalEl) timelineTotalEl.textContent = getState().totalSteps;

    // 更新时间轴滑块范围
    if (timelineSlider) {
      timelineSlider.max = getState().totalSteps;
    }

    // ========== 动态生成部件清单 ==========
    const customModelParts = getCustomModelParts();
    const partsGrid = document.querySelector(".parts-grid");
    if (partsGrid && customModelParts.length > 0) {
      partsGrid.innerHTML = "";
      customModelParts.forEach(part => {
        const item = document.createElement("div");
        item.className = "part-item";
        item.dataset.part = part.name;
        // 提取材质颜色作为圆点颜色
        let dotColor = "#888";
        if (part.mesh && part.mesh.material) {
          const mat = part.mesh.material;
          if (mat.color) dotColor = "#" + mat.color.getHexString();
        }
        item.innerHTML = `<span class="part-dot" style="background:${dotColor}"></span>${part.name}`;
        partsGrid.appendChild(item);
      });
    }
  }

  /**
   * 清除自定义模型并恢复默认 Quest 3：可见性、步骤系统、面板状态、爆炸
   * 按钮，以及默认部件的步骤索引重排。
   */
  function clearCustomModel() {
    clearCustomModelGroup();
    const stepGroups = defaultStepGroups;
    const totalSteps = stepGroups.length;
    setState({
      hasCustomModel: false,
      currentModelName: "Meta Quest 3",
      stepGroups,
      totalSteps,
      currentStep: 0,
      displayedStep: 0,
      animatingStep: 0,
      isExploded: false,
    });

    // 恢复默认模型可见性
    questGroup.visible = true;

    // 恢复 UI
    const countEl = document.getElementById("part-count");
    if (countEl) countEl.textContent = "15";

    // 恢复默认部件清单
    const partsGrid = document.querySelector(".parts-grid");
    if (partsGrid) {
      partsGrid.innerHTML = `
      <div class="part-item" data-part="前面板"><span class="part-dot" style="background:#f2f2f2"></span>前面板</div>
      <div class="part-item" data-part="主机身"><span class="part-dot" style="background:#222225"></span>主机身</div>
      <div class="part-item" data-part="左透镜模组"><span class="part-dot" style="background:#1e3a5f"></span>透镜 x2</div>
      <div class="part-item" data-part="左摄像头"><span class="part-dot" style="background:#0a0a0a"></span>摄像头 x4</div>
      <div class="part-item" data-part="左头带臂"><span class="part-dot" style="background:#3a3a3c"></span>头带臂 x2</div>
      <div class="part-item" data-part="面罩海绵"><span class="part-dot" style="background:#2c2c2e"></span>海绵</div>
      <div class="part-item" data-part="主板/显示屏"><span class="part-dot" style="background:#0d4a22"></span>主板</div>
      <div class="part-item" data-part="头带"><span class="part-dot" style="background:#3a3a3c"></span>头带</div>
    `;
    }

    const timelineTotalEl = document.getElementById("timeline-total");
    if (timelineTotalEl) timelineTotalEl.textContent = totalSteps;

    if (timelineSlider) {
      timelineSlider.max = totalSteps;
      timelineSlider.value = 0;
    }

    const clearBtn = document.getElementById("clear-model-btn");
    if (clearBtn) clearBtn.style.display = "none";

    const status = document.getElementById("upload-status");
    if (status) {
      status.classList.add("hidden");
      status.textContent = "";
    }

    const fileNameEl = document.getElementById("uploaded-file-name");
    if (fileNameEl) fileNameEl.textContent = "";

    // 重置爆炸状态
    if (explodeBtn) {
      explodeBtn.classList.remove("exploded");
      explodeBtn.textContent = "💥 爆炸视图";
    }

    // 重新分配 Quest 3 部件的步骤索引
    parts.forEach(part => {
      const meshName = part.mesh.userData.name;
      let stepIndex = totalSteps;
      stepGroups.forEach((group, idx) => {
        if (group.parts.includes(meshName)) {
          stepIndex = idx;
        }
      });
      part.stepIndex = stepIndex;
    });

    // 更新 UI
    updateStepUI();
    fitCameraToModel(questGroup, false);

    showStatus("已清除自定义模型，恢复默认", "info");
    console.log("✅ 已恢复默认 Quest 3 模型和步骤系统");
  }

  return { updateCustomModelUI, clearCustomModel };
}
