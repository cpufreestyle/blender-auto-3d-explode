/**
 * Quest 3 默认分步骤拆解教学方案
 * 从 main.js 中提取，依赖 quest3Specs 数据
 */

import { quest3Specs } from './quest3-data.js';

export const defaultStepGroups = [
  {
    name: '👋 欢迎认识 Quest 3',
    parts: [],
    tools: [],
    description: `Meta Quest 3（2023年10月发售）是 Meta 的第三代 VR 一体机。

📊 核心参数：
• 重量：${quest3Specs.weight}
• 芯片：${quest3Specs.processor}
• 屏幕：${quest3Specs.display} @ ${quest3Specs.refreshRate}
• 摄像头：${quest3Specs.cameras}

💡 点击"下一步"开始拆解之旅。用鼠标左键旋转，滚轮缩放。`
  },
  {
    name: '① 前面板 - 脸面',
    parts: ['前面板'],
    tools: ['👁️ 肉眼观察', '💡 良好的光线'],
    description: `前面板是 Quest 3 的"门面"：

🎨 设计
• 白色哑光磨砂塑料外壳
• 中央印有 Meta 标志（可反光）
• 四周有细密的散热通风口（共5条）

🔍 摄像头阵列
从左上到右下：
• 左上 + 右上：1000万像素 RGB 摄像头（彩色透视）
• 正中上方：ToF 深度传感器
• 底部：红外追踪摄像头

💡 试试在 3D 视图中找找这些摄像头！`
  },
  {
    name: '② 摄像头模组 - 眼睛',
    parts: ['左摄像头', '右摄像头', '中置摄像头', '下置追踪摄像头'],
    tools: ['🔍 放大镜（可选）', '💡 充足光线'],
    description: `Quest 3 有 **4 颗摄像头** 负责"看懂"世界：

📷 彩色透视（2颗）
• 左右各一颗 1000万像素 RGB 摄像头
• 提供高清彩色 Mixed Reality 体验
• 比 Quest 2 的黑白透视提升巨大

👁️ 追踪摄像头（2颗）
• 红外摄像头，不可见光
• 追踪头显在空间中的位置（6DoF）
• 追踪 Touch Plus 手柄

⚡ 这就是 Inside-Out 追踪的核心！`
  },
  {
    name: '③ 头带与头带臂 - 支撑',
    parts: ['左头带臂', '右头带臂', '头带'],
    tools: ['✋ 双手', '💪 轻微力气'],
    description: `佩戴舒适的关键组件：

🎯 正确佩戴方法
1. 头显放在眼睛前方
2. 头带拉到后脑勺**偏下**位置
3. 调整旋钮让重心平衡

🧩 组件说明
• 头带臂：塑料支架，连接主机身
• 柔性头带：可拉伸材质，分散重量
• 总重量 515g 均匀分布在额头和后脑勺

💡 Quest 3 的头带比 Quest 2 更短更紧凑。`
  },
  {
    name: '④ 面罩海绵 - 亲密接触',
    parts: ['面罩海绵'],
    tools: ['✋ 双手', '🔧 塑料撬棒（可选）'],
    description: `紧贴你脸部的记忆海绵：

☁️ 作用
• 阻挡外部光线，提升沉浸感
• 柔软缓冲，长时间佩戴舒适
• 防止"漏光"导致的眩晕

📦 官方配件
Meta 提供 4 种厚度可选：
• 2mm（薄）- 适合戴眼镜用户
• 4mm（标准）- 大多数人
• 6mm（厚）- 深眼窝用户
• 8mm（特厚）- 需要最大遮光

🔄 可轻松更换，撕下旧的，贴上新的。`
  },
  {
    name: '⑤ 透镜模组 - 通往虚拟世界',
    parts: ['左透镜模组', '右透镜模组'],
    tools: ['👁️ 仔细观察', '💡 旋转查看内部'],
    description: `这是 VR 头显**最重要的部件**！

🔬 Pancake 透镜技术
• 比 Quest 2 的菲涅尔透镜**更薄**
• 光路折叠设计，减少头显厚度
• 边缘画质大幅改善

📐 光学规格
• 单眼分辨率：${quest3Specs.display}
• 刷新率：${quest3Specs.refreshRate}
• 视场角（FOV）：${quest3Specs.fov}
• 屈光度调节：±50°（近视党福音！）

💡 你可以不用戴眼镜，直接调节旋钮就能看清！`
  },
  {
    name: '⑥ 主板与显示屏 - 大脑',
    parts: ['主板/显示屏'],
    tools: ['🔧 精密螺丝刀（虚拟）', '📋 耐心细致'],
    description: `Quest 3 的"大脑"和"眼睛"：

🧠 主板（绿色 PCB）
• 芯片：${quest3Specs.processor}
• 图形：${quest3Specs.gpu}
• 内存：${quest3Specs.memory}
• 存储：${quest3Specs.storage.join(' / ')}

👁️ 显示屏（主板后面）
• 2× LCD 面板（你看到的是透过透镜的像）
• ${quest3Specs.display}
• ${quest3Specs.refreshRate}
• RGB-stripe 排列（减少纱窗效应）

⚡ 散热
主板上有散热片覆盖 SoC 芯片，保持冷静运行。`
  },
  {
    name: '🎉 拆解完成！',
    parts: [],
    tools: [],
    description: `恭喜！你已经完成 Quest 3 的完整拆解之旅！

📦 总共发现了 15 个主要部件

💡 下一步你可以：
• 点击"爆炸视图"重新组合
• 点击"重置"回到初始状态
• 上传自己的 3D 模型来拆解
• 在 3D 视图中旋转观察细节

❓ 有疑问？可以问我任何关于 Quest 3 的问题！`
  },
];
