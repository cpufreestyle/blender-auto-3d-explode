// GLTFLoader 惰性加载器（从 main.js 抽取，行为不变）。
//
// 搬迁 main.js 的 loadGLTFLoader + 模块级缓存 let GLTFLoader：首次调用才
// 动态 import（webpack 自动 tree-shake），之后复用同一份类引用。缓存从
// main.js 的模块级 let 收进provider 实例（main.js 只创建一个实例，语义不变），
// 换来的好处是惰性加载行为可在测试里直接观测。
//
// 无依赖注入：动态 import 的说明符与浏览器/webpack 环境一致。
export function createGLTFLoaderProvider() {
  let GLTFLoader = null;
  async function loadGLTFLoader() {
    if (!GLTFLoader) {
      const module = await import("three/examples/jsm/loaders/GLTFLoader.js");
      GLTFLoader = module.GLTFLoader;
    }
    return GLTFLoader;
  }

  return { loadGLTFLoader };
}
