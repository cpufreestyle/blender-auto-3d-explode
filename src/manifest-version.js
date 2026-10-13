// manifest 版本协商（version negotiation）
//
// 背景：manifest 是跨版本流通的格式——今天导出的文件，明年用新版打开；
// 别人用别的手段生成的文件，也可能落到我们的重放页里。`version` 字段就是
// 为这种流通存在的，但此前 parseSplitManifest / replayPlan 都不看它：
// 一个 v2 的 manifest 会被静默按 v1 语义解析，字段含义变了也不会报错，
// 用户看到的是一个「看起来对但其实是错的」重放结果。
//
// 本模块把「这个文件我能不能正确解读」变成可判定的：
//   · inspectManifestVersion(m)  ->  { status, version, supported, message }
//   · checkManifestCompatibility(m) ->  同上，但缺 version 时按兼容处理
//
// 三种状态的取舍：
//   · compatible   —— 已知版本，放心用；
//   · missing      —— 没有 version 字段。**按兼容处理**：v1 是第一个版本，
//                     早期文件与手写文件都可能没有它，为此拒绝加载会让
//                     老文件全部失效，代价大于收益；
//   · unsupported  —— 版本比我们支持的更新，或根本不是数字。**拒绝**：
//                     我们无法知道它新增/改变了哪些字段，硬解析的产物
//                     是错的，而错比重更糟。
//
// 不支持「降级读取」旧版本（version < 1）：那需要为每个历史版本写迁移
// 函数，而目前只有一个版本。等真有第二个版本时再补迁移表，比现在凭空
// 造一套用不上的机制诚实。

export const MANIFEST_SUPPORTED_VERSION = 1;

/**
 * 检查 manifest 的版本兼容性。
 *
 * @param {object} manifest 任意来源的 manifest 对象（未做结构校验，只取 version）
 * @returns {{status:"compatible"|"missing"|"unsupported",
 *           version:(number|null), supported:boolean, message:string}}
 *   status:
 *     compatible  已知版本，可放心解析
 *     missing     无 version 字段，按 v1 兼容处理（见文件头取舍）
 *     unsupported 版本更新 / 非法，拒绝解析
 */
export function inspectManifestVersion(manifest) {
  const base = {
    version: null,
    supported: false,
    message: "",
  };

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return Object.assign(base, {
      status: "unsupported",
      message: "manifest 不是一个对象",
    });
  }

  // 字段不存在，或显式为 undefined：按兼容处理。
  // null 也归入此类——JSON 里写 "version": null 与不写在语义上同义，
  // 都是「没有版本信息」，为它报错没有意义。
  if (manifest.version === undefined || manifest.version === null) {
    return Object.assign(base, {
      status: "missing",
      version: null,
      supported: true,
      message:
        "manifest 未声明 version，按 v" +
        MANIFEST_SUPPORTED_VERSION +
        " 兼容读取；建议重新导出一份带版本号的文件",
    });
  }

  const v = manifest.version;
  if (typeof v !== "number" || !Number.isInteger(v)) {
    return Object.assign(base, {
      status: "unsupported",
      message: "version 必须是整数，实际是 " + JSON.stringify(v),
    });
  }

  if (v < 1) {
    return Object.assign(base, {
      status: "unsupported",
      version: v,
      message: "version " + v + " 不是有效版本号（有效版本从 1 开始）",
    });
  }

  if (v > MANIFEST_SUPPORTED_VERSION) {
    return Object.assign(base, {
      status: "unsupported",
      version: v,
      message:
        "manifest 版本 v" +
        v +
        " 高于本程序支持的 v" +
        MANIFEST_SUPPORTED_VERSION +
        "，请升级程序后重试",
    });
  }

  return {
    status: "compatible",
    version: v,
    supported: true,
    message: "",
  };
}

/**
 * 便捷判定：这个 manifest 能不能被解析。
 * missing 与 compatible 都算能——调用方若想把两者区别对待，
 * 应直接用 inspectManifestVersion 读 status。
 */
export function isManifestCompatible(manifest) {
  return inspectManifestVersion(manifest).supported;
}

