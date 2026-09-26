// 模型样式切换（原生 / 乐高）（从 main.js 抽取，行为不变）。
//
// 搬迁 main.js 的 applyModelStyle：记录当前样式，再对 questGroup 与
// customModelGroup 做深度遍历——mesh 首次被访问时把原生材质缓存进
// userData._nativeMaterial，随后按目标样式取乐高映射材质或还原原生材质。
//
// 依赖注入：两个模型组为稳定 const 引用（typeof 守卫随搬迁保留，缺组时跳过）；
// getLegoMaterialForMesh 直接依赖 lego-materials.js（与 main.js 共用同一份
// 材质实例）。与逐字搬迁的唯一差异：currentModelStyle = style 改写为
// setState({ currentModelStyle: style })（main.js 侧桥接写回同一个 let，
// custom-model-finalize 的收尾链路也读它）。
import { getLegoMaterialForMesh } from "./lego-materials.js";

export function createModelStyleSwitcher({ questGroup, customModelGroup, setState }) {
  function applyModelStyle(style) {
    setState({ currentModelStyle: style });
    const setLego = style === "lego";
    const groups = [questGroup];
    if (typeof customModelGroup !== "undefined") groups.push(customModelGroup);
    groups.forEach(group => {
      group.traverse(child => {
        if (!child.isMesh) return;
        if (child.userData._nativeMaterial === undefined) {
          child.userData._nativeMaterial = child.material;
        }
        child.material = setLego ? getLegoMaterialForMesh(child) : child.userData._nativeMaterial;
      });
    });
  }

  return { applyModelStyle };
}
