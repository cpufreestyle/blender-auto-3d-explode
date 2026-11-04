#!/usr/bin/env node
/**
 * 单元测试 — 步骤深链（src/step-link.js）
 *
 * 钉住的不变量：
 *   - 解析只认非负整数："" / "abc" / "1.5" / "-1" / " 2 " 的处理各有断言
 *     （空白trim后算合法、小数与负号不算，负数靠 \d+ 先行挡掉）；
 *   - 超过 totalSteps 视为越界（换模型后步骤数会变，旧链接不能落到不存在的步）；
 *   - totalSteps 缺省 / 非整数时不做越界判断，交给调用方；
 *   - buildStepUrl 在 file://（origin 为 "null"）下降级为 pathname + search；
 *   - syncStepToUrl 值没变不碰 history：控制器每帧都调，白写会把历史写穿；
 *   - applyStepFromLocation 只在实际换步时调 goToStep，重复深链不触发动画。
 *
 * 用法：node tests/step-link-test.mjs
 */

import {
  applyStepFromLocation,
  buildStepUrl,
  parseStepFromHash,
  STEP_HASH_KEY,
  syncStepToUrl,
} from "../src/step-link.js";

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    console.log("  OK " + message);
    passed++;
  } else {
    console.error("  FAIL " + message);
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

function fakeHistory() {
  const calls = [];
  return {
    calls,
    replaceState(state, unused, url) {
      calls.push({ state, unused, url });
    },
  };
}

describe("parseStepFromHash", () => {
  it("认 #step=3", () => {
    assert(parseStepFromHash("#step=3", 8) === 3, "#step=3 → 3");
  });
  it("路径与其它参数不影响解析", () => {
    assert(parseStepFromHash("#foo=1&step=2&bar=3", 8) === 2, "夹在别的参数里也认");
  });
  it("边缘值 0 与 totalSteps 合法", () => {
    assert(parseStepFromHash("#step=0", 8) === 0, "0 合法");
    assert(parseStepFromHash("#step=8", 8) === 8, "等于 totalSteps 合法（已完成态）");
  });
  it("越界与非法一律 null", () => {
    assert(parseStepFromHash("#step=9", 8) === null, "大于 totalSteps → null");
    assert(parseStepFromHash("#step=-1", 8) === null, "负数 → null");
    assert(parseStepFromHash("#step=1.5", 8) === null, "小数 → null");
    assert(parseStepFromHash("#step=abc", 8) === null, "非数字 → null");
    assert(parseStepFromHash("#step=", 8) === null, "空值 → null");
    assert(parseStepFromHash("#other=3", 8) === null, "没有 step 键 → null");
    assert(parseStepFromHash("", 8) === null, "空 hash → null");
    assert(parseStepFromHash(undefined, 8) === null, "hash 缺失 → null");
  });
  it("两侧空白按合法处理", () => {
    assert(parseStepFromHash("#step= 4 ", 8) === 4, "trim 后是整数 → 合法");
  });
  it("totalSteps 不可信时不做越界判断", () => {
    assert(parseStepFromHash("#step=99", null) === 99, "totalSteps 缺省 → 原样返回");
    assert(parseStepFromHash("#step=99", 0) === 99, "totalSteps=0 视为未知");
  });
});

describe("buildStepUrl", () => {
  it("http 站点拼完整地址", () => {
    const url = buildStepUrl({
      origin: "https://example.com",
      pathname: "/index.html",
      search: "?v=3.3.2",
      hash: "",
    }, 4);
    assert(url === "https://example.com/index.html?v=3.3.2#step=4", url);
  });
  it("file:// 下 origin 是 null，退化为 pathname + search", () => {
    const url = buildStepUrl({
      origin: "null",
      pathname: "/Users/me/index.html",
      search: "",
      hash: "",
    }, 2);
    assert(url === "/Users/me/index.html#step=2", url);
  });
  it("步数非法返回空串", () => {
    assert(buildStepUrl(null, 1) === "", "location 缺失 → 空");
    assert(buildStepUrl({ origin: "https://a.com", pathname: "/" }, -1) === "", "负数 → 空");
    assert(buildStepUrl({ origin: "https://a.com", pathname: "/" }, 1.5) === "", "小数 → 空");
  });
});

describe("syncStepToUrl", () => {
  it("地址栏已是该步时不碰 history", () => {
    const history = fakeHistory();
    const out = syncStepToUrl({
      location: { hash: "#" + STEP_HASH_KEY + "=5" },
      history,
      step: 5,
    });
    assert(out.changed === false && out.url === "", "changed=false");
    assert(history.calls.length === 0, "replaceState 零调用");
  });
  it("步数变化时 replaceState 到新 hash", () => {
    const history = fakeHistory();
    const out = syncStepToUrl({ location: { hash: "#step=1" }, history, step: 2 });
    assert(out.changed === true && out.url === "#step=2", "changed=true 且给出新 hash");
    assert(history.calls.length === 1 && history.calls[0].url === "#step=2", "replaceState(#step=2)");
  });
  it("没有 history 也不抛", () => {
    let threw = false;
    try {
      syncStepToUrl({ location: { hash: "" }, history: null, step: 3 });
    } catch {
      threw = true;
    }
    assert(!threw, "history 缺失时静默跳过");
  });
});

describe("applyStepFromLocation", () => {
  it("合法深链触发一次 goToStep", () => {
    const seen = [];
    const applied = applyStepFromLocation({
      location: { hash: "#step=6" },
      goToStep: n => seen.push(n),
      totalSteps: 8,
      currentStep: 0,
    });
    assert(applied === true && seen.length === 1 && seen[0] === 6, "落到第 6 步");
  });
  it("无效或重复深链不触发", () => {
    const seen = [];
    const goToStep = n => seen.push(n);
    assert(applyStepFromLocation({ location: { hash: "" }, goToStep, totalSteps: 8 }) === false, "空 hash");
    assert(applyStepFromLocation({ location: { hash: "#step=99" }, goToStep, totalSteps: 8 }) === false, "越界");
    assert(
      applyStepFromLocation({ location: { hash: "#step=2" }, goToStep, totalSteps: 8, currentStep: 2 }) === false,
      "已在目标步",
    );
    assert(seen.length === 0, "一次都没调 goToStep");
  });
});

for (const { name, fn } of describeQueue) {
  console.log(name);
  fn();
}

console.log("结果: " + passed + " 通过, " + failed + " 失败");
if (failed > 0) {
  console.error("失败项:", failures.join("; "));
  process.exit(1);
}
