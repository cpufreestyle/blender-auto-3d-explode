// 服务身份标记路由 —— 给 macOS 桌面启动器（scripts/mac/quest3-launcher）识别
// 「这个端口上的服务是不是我」。
//
// 为什么单开一个端点：启动器原先用「curl / 有没有响应」判断服务是否已在运行，
// 端口被别的程序占用时会把别人的页面当成自己的打开（实测 :3001 被 freellmapi
// 占住后，双击桌面图标打开的是它的 Vite 脚手架首页，通知还写着「服务已在运
// 行」）。/api/health 顶不了这个缺：它要 execFile 跑一次 blender --version，
// 最长 10s，Blender 慢起时启动器会把它误判成「不是我的服务」。
//
// 所以这里只回一个即时、无副作用的标记：不 exec、不碰磁盘、不读配置，进程起
// 来就一定能答。启动器只认 app 字段是否等于 APP_ID，不相等就当陌生人处理。
//
// DI / 接缝（与 createBlenderRoutes / createGenerateRoutes 同构）：
//   · sendJSON 是唯一出口，注入以便测试断言状态码与响应体；
//   · version / pid / port 全部注入，测试用固定值，不依赖真实 package.json
//     与进程 PID。
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/** 项目唯一标识：桌面启动器与扫端口的工具都靠这个字符串认亲 */
export const APP_ID = "blender-auto-3d-explode";

/** 面向用户的名称，桌面通知与启动器对话框用它 */
export const APP_NAME = "Quest 3D 拆解";

/**
 * 从 package.json 读版本号；读不到就给 "unknown"（运行时目录被 git archive
 * 重建后 package.json 一定在，但万一缺文件也不该让服务起不来）。
 */
export function readPackageVersion(rootDir) {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(rootDir, "package.json"), "utf8")
    );
    return typeof pkg.version === "string" && pkg.version ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

/** 身份响应体。pid 交给启动器做「只终止自己」的二次确认。 */
export function createIdentityPayload({ version, pid, port }) {
  return {
    app: APP_ID,
    name: APP_NAME,
    version: String(version),
    pid: Number(pid),
    port: Number(port),
  };
}

export function createIdentityRoutes({
  sendJSON,
  version,
  pid = process.pid,
  port = 3001,
}) {
  /**
   * GET /api/identity — 返回 { app, name, version, pid, port }
   * 无入参、无副作用，故意不碰 Blender：慢依赖会让「是不是我」的判定不可靠。
   */
  async function handleIdentity(req, res) {
    sendJSON(res, 200, createIdentityPayload({ version, pid, port }));
  }

  return { handleIdentity };
}
