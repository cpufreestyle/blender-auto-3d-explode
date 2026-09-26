// 增强灯光系统（从 main.js 抽取，行为不变）。
//
// 搬迁 main.js 的「增强灯光系统」块：环境光 / 主光（唯一投影光源）/ 补光 /
// 轮廓光 / 底部反射光五盏灯的构造、position 布置，以及按 lowPowerMode
// 分档的强度与阴影贴图尺寸。五盏灯只 add 进注入的 scene：原 main.js 也不
// 持有这些引用（照明由 scene 遍历取用），故返回值仅给测试断言用，
// main.js 接线上不接收。
//
// DI 接缝：scene / lowPowerMode 分别是本模块的稳定引用与布尔值，工厂创建时
// 直接传入。五盏 Light 在 Node 环境均可直构（无 GL 上下文依赖），测试可逐项
// 钉住色值 / 强度分档 / 阴影贴图尺寸 / bias / near / far / angle / penumbra /
// decay / distance 与「每盏灯都进 scene」。
import { AmbientLight, DirectionalLight, SpotLight } from "three";

export function createLighting({ scene, lowPowerMode }) {
  const ambientLight = new AmbientLight(0xffffff, 0.45);
  scene.add(ambientLight);

  const mainLight = new DirectionalLight(0xffffff, lowPowerMode ? 1.2 : 1.5);
  mainLight.position.set(6, 10, 7);
  mainLight.castShadow = true;
  // 阴影贴图：桌面 1024（2048 观感提升有限、开销却是 4 倍），低功耗 512
  mainLight.shadow.mapSize.set(lowPowerMode ? 512 : 1024, lowPowerMode ? 512 : 1024);
  mainLight.shadow.bias = -0.0001;
  mainLight.shadow.camera.near = 0.5;
  mainLight.shadow.camera.far = 30;
  scene.add(mainLight);

  const fillLight = new DirectionalLight(0x99bbff, lowPowerMode ? 0.4 : 0.6);
  fillLight.position.set(-6, 4, -5);
  scene.add(fillLight);

  const rimLight = new SpotLight(0xffffff, lowPowerMode ? 1.0 : 1.8);
  rimLight.position.set(0, 8, -7);
  rimLight.angle = Math.PI / 5;
  rimLight.penumbra = 0.5;
  rimLight.decay = 2;
  rimLight.distance = 35;
  // 移除 rimLight.castShadow 以减少移动端 GPU 填充率消耗（仅保留 mainLight 投射阴影）
  scene.add(rimLight);

  // 补充底部反射光
  const bottomLight = new DirectionalLight(0x334466, lowPowerMode ? 0.15 : 0.3);
  bottomLight.position.set(0, -5, 0);
  scene.add(bottomLight);

  return { ambientLight, mainLight, fillLight, rimLight, bottomLight };
}
