#!/usr/bin/env node
/**
 * 单元测试 — 图片特征提取（src/panels/image-features.js，
 * 从 src/panels/ai-paint-panel.js 抽取）
 *
 * 抽取的不变量：
 *   - 采样：scale = min(100/naturalWidth, 100/naturalHeight)，w/h 至少为 1
 *     （大图压到 100px 见方内，小图放大到 100px，细长图靠 max(1,...) 保底）；
 *   - drawImage 画到 (0,0)，尺寸即采样后的 w/h；
 *   - alpha < 128 的像素不参与任何统计；全透明图 resolve(null)；
 *   - 量化：每通道 Math.round(v/32)*32，因此 255 会量化成 256、104 → 96、
 *     120 → 128、150 → 160（三档位数值各自钉住）；
 *   - 主色按占比倒序取前 5，ratio = count / opaqueCount（三位小数）；
 *   - 平均色按不透明像素算且四舍五入（127.5 → 128，floor 会变 127）；
 *   - avgLuminance 分母 255；mood 判定顺序为 bright/dark → warm → cool →
 *     natural，后者覆盖前者；
 *   - 亮/暗判定阈值 lum > 180 与 lum < 60；
 *   - Sobel 边缘水平与垂直都要比，阈值 30，分母 w*h；
 *   - 对称度：左右镜像逐像素（步长 2）三通道差 < 30 记一分，symCount 为 0 时
 *     回落 0（不是 NaN）；
 *   - aspectRatio 保留两位小数、width/height 取 natural 尺寸（未缩放）。
 *
 * 用法：node tests/image-features-test.mjs
 */

import { buildFeatureStatusHtml, extractImageFeatures } from "../src/panels/image-features.js";

// ===== 测试框架（与仓库既有 .mjs 测试一致）=====
let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    console.log(`  OK ${message}`);
    passed++;
  } else {
    console.error(`  FAIL ${message}`);
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

// 模块每次提取都会 console.log 整个 feature 对象；这里把那条过滤掉，
// 只留测试框架自己的 OK/FAIL 行，输出才可读。
const realLog = console.log;
console.log = (...args) => {
  if (typeof args[0] === "string" && args[0].startsWith("🎨")) return;
  realLog(...args);
};

// ===== 假 canvas / 假 2d 上下文 =====
// installCanvas(makePixels)：makePixels(w,h) 按目标采样尺寸产出 RGBA 字节，
// 测试因此可以精确控制「图像内容」，不必真的解码图片。
const REAL_DOCUMENT = globalThis.document;
let lastDrawImage = null;

function installCanvas(makePixels) {
  lastDrawImage = null;
  const ctx = {
    drawImage: (img, x, y, w, h) => {
      lastDrawImage = { x, y, w, h };
    },
    getImageData: (x, y, w, h) => ({ data: makePixels(w, h) }),
  };
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => canvas },
  });
}

function img(naturalWidth, naturalHeight) {
  return { naturalWidth, naturalHeight };
}

// 把 (r,g,b[,a]) 规范成四元素
const rgba = c => [c[0], c[1], c[2], c[3] === undefined ? 255 : c[3]];

function blank(w, h) {
  return new Uint8ClampedArray(w * h * 4);
}

function put(d, w, x, y, c) {
  const i = (y * w + x) * 4;
  const [r, g, b, a] = rgba(c);
  d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a;
}

// 纯色图
function solid(r, g, b, a = 255) {
  return (w, h) => {
    const d = blank(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) put(d, w, x, y, [r, g, b, a]);
    }
    return d;
  };
}

// 左右分半图：x < w/2 用 left，其余用 right
function halves(left, right) {
  return (w, h) => {
    const d = blank(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) put(d, w, x, y, x < w / 2 ? left : right);
    }
    return d;
  };
}

// 上下分半图：y < h/2 用 top，其余用 bottom
function topBottom(top, bottom) {
  return (w, h) => {
    const d = blank(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) put(d, w, x, y, y < h / 2 ? top : bottom);
    }
    return d;
  };
}

// 棋盘格
function checkerboard(c1, c2) {
  return (w, h) => {
    const d = blank(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) put(d, w, x, y, (x + y) % 2 === 0 ? c1 : c2);
    }
    return d;
  };
}

// 竖条带：widths（列数，需和为 w）依次取 colors 里的颜色
function stripes(widths, colors) {
  return (w, h) => {
    const d = blank(w, h);
    const bounds = [];
    let acc = 0;
    for (const n of widths) { bounds.push([acc, acc + n]); acc += n; }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const k = bounds.findIndex(([s, e]) => x >= s && x < e);
        put(d, w, x, y, colors[k]);
      }
    }
    return d;
  };
}

// 横条带：bands 为 [行数, 颜色下标]（-1 表示全透明）
function bands(bandSpec, colors) {
  return (w, h) => {
    const d = blank(w, h);
    let row = 0;
    for (const [n, ci] of bandSpec) {
      for (let y = row; y < row + n; y++) {
        for (let x = 0; x < w; x++) {
          if (ci < 0) continue;
          put(d, w, x, y, colors[ci]);
        }
      }
      row += n;
    }
    return d;
  };
}

// 左右镜像，且左右像素每通道差恒为 D（D=0 即完全对称）。
// 注意：模块比的是「三通道差之和」，即每通道差 D 会变成总分 3D，
// 所以阈值 30 对应的每通道差只有 10。
function mirroredDelta(D) {
  return (w, h) => {
    const d = blank(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // 步长 3 且不超过 147，保证 base + D 仍在 0..255 内不被钳到 255
        const base = (Math.min(x, w - 1 - x) * 3) % 256;
        const v = x < w / 2 ? base : Math.min(255, base + D);
        put(d, w, x, y, [v, v, v, 255]);
      }
    }
    return d;
  };
}

// 偶数行完全对称、奇数行完全不对称：钉住对称度只隔行采样
function rowVariant(dEven, dOdd) {
  return (w, h) => {
    const d = blank(w, h);
    for (let y = 0; y < h; y++) {
      const D = y % 2 === 0 ? dEven : dOdd;
      for (let x = 0; x < w; x++) {
        // 步长 3 且不超过 147，保证 base + D 仍在 0..255 内不被钳到 255
        const base = (Math.min(x, w - 1 - x) * 3) % 256;
        const v = x < w / 2 ? base : Math.min(255, base + D);
        put(d, w, x, y, [v, v, v, 255]);
      }
    }
    return d;
  };
}

function restore() {
  if (REAL_DOCUMENT === undefined) delete globalThis.document;
  else Object.defineProperty(globalThis, "document", { configurable: true, value: REAL_DOCUMENT });
}

describe("采样尺寸", async() => {
  await it("大图压到 100px 见方内", async() => {
    installCanvas(solid(255, 255, 255));
    await extractImageFeatures(img(1000, 800));
    const a = `${lastDrawImage.w}x${lastDrawImage.h}`;
    assert(lastDrawImage.w === 100 && lastDrawImage.h === 80, `1000x800 → 100x80（实际 ${a}）`);
  });

  await it("小图放大到 100px（上限不是下限）", async() => {
    installCanvas(solid(255, 255, 255));
    await extractImageFeatures(img(50, 50));
    const a = `${lastDrawImage.w}x${lastDrawImage.h}`;
    assert(lastDrawImage.w === 100 && lastDrawImage.h === 100, `50x50 → 100x100（实际 ${a}）`);
  });

  await it("drawImage 画到 (0,0) 且尺寸与采样一致", async() => {
    installCanvas(solid(0, 0, 0));
    await extractImageFeatures(img(400, 400));
    assert(lastDrawImage.x === 0 && lastDrawImage.y === 0, "起点 (0,0)");
    const a = `${lastDrawImage.w}x${lastDrawImage.h}`;
    assert(lastDrawImage.w === 100 && lastDrawImage.h === 100, `尺寸 100x100（实际 ${a}）`);
  });

  await it("宽取整用 round 而非 floor", async() => {
    // 124x127 → scale=100/127，124*scale=97.6378：round=98、floor=97
    installCanvas(solid(255, 255, 255));
    await extractImageFeatures(img(124, 127));
    assert(lastDrawImage.w === 98, `w=98（实际 ${lastDrawImage.w}）`);
  });

  await it("细长图靠 max(1,...) 保底，不会得到空画布", async() => {
    // 100000x1 → scale=0.001，h=round(0.001)=0，靠 max(1,0) 抬到 1
    installCanvas(solid(255, 255, 255));
    const f = await extractImageFeatures(img(100000, 1));
    assert(f !== null, "h=0 会得到空画布进而返回 null，故必须被抬到 1");
    assert(lastDrawImage.h === 1, `采样高度 1（实际 ${lastDrawImage.h}）`);
    assert(f.width === 100000 && f.height === 1, `natural 尺寸 100000x1（实际 ${f.width}x${f.height}）`);
  });
});

describe("透明像素统计", async() => {
  await it("全透明图 resolve(null)", async() => {
    installCanvas(solid(0, 0, 0, 0));
    const f = await extractImageFeatures(img(100, 100));
    assert(f === null, "pixelCount 为 0 时返回 null");
  });

  await it("alpha < 128 的像素被完全跳过（颜色也不同才看得出来）", async() => {
    // 左半不透明白、右半 alpha=127 的蓝：被跳过则平均色仍是纯白
    installCanvas(halves([255, 255, 255, 255], [0, 0, 255, 127]));
    const f = await extractImageFeatures(img(100, 100));
    assert(f !== null, "仍有不透明像素，返回特征");
    assert(
      f.avgColor.r === 255 && f.avgColor.g === 255 && f.avgColor.b === 255,
      `平均色仍是 255,255,255（实际 ${f.avgColor.r},${f.avgColor.g},${f.avgColor.b}）`,
    );
    assert(f.brightRatio === 1 && f.darkRatio === 0, "亮暗比只由左半决定");
    assert(f.dominantColors.length === 1, `主色只有白一种（实际 ${f.dominantColors.length}）`);
  });

  await it("alpha = 128 计入（阈值是 < 128 才跳过）", async() => {
    installCanvas(halves([255, 255, 255, 255], [0, 0, 0, 128]));
    const f = await extractImageFeatures(img(100, 100));
    assert(f !== null, "128 视为不透明");
    assert(f.avgColor.r === 128, `左白右黑把平均色拉到 128（实际 ${f.avgColor.r}）`);
  });
});

describe("平均色 / 亮度 / 色调", async() => {
  await it("纯白：avgColor 255、avgLuminance 1、mood bright", async() => {
    installCanvas(solid(255, 255, 255));
    const f = await extractImageFeatures(img(200, 100));
    assert(f.avgColor.r === 255 && f.avgColor.g === 255 && f.avgColor.b === 255, "平均色 255,255,255");
    assert(f.avgLuminance === 1, `avgLuminance=1（实际 ${f.avgLuminance}）`);
    assert(f.mood === "bright", `mood=bright（实际 ${f.mood}）`);
  });

  await it("纯黑：avgLuminance 0、mood dark、darkRatio 1", async() => {
    installCanvas(solid(0, 0, 0));
    const f = await extractImageFeatures(img(200, 100));
    assert(f.avgLuminance === 0, `avgLuminance=0（实际 ${f.avgLuminance}）`);
    assert(f.mood === "dark", `mood=dark（实际 ${f.mood}）`);
    assert(f.darkRatio === 1 && f.brightRatio === 0, "darkRatio=1、brightRatio=0");
  });

  await it("平均色四舍五入（127.5 → 128，floor 会变 127）", async() => {
    installCanvas(halves([255, 0, 0], [0, 0, 255]));
    const f = await extractImageFeatures(img(100, 100));
    assert(f.avgColor.r === 128, `红蓝各半 → r=128（实际 ${f.avgColor.r}）`);
    assert(f.avgColor.b === 128, `红蓝各半 → b=128（实际 ${f.avgColor.b}）`);
    assert(f.avgColor.g === 0, "g=0");
  });

  await it("偏红：mood warm", async() => {
    installCanvas(solid(200, 100, 50));
    const f = await extractImageFeatures(img(200, 100));
    assert(f.mood === "warm", `mood=warm（实际 ${f.mood}）`);
  });

  await it("偏蓝：mood cool", async() => {
    installCanvas(solid(50, 100, 200));
    const f = await extractImageFeatures(img(200, 100));
    assert(f.mood === "cool", `mood=cool（实际 ${f.mood}）`);
  });

  await it("偏绿：mood natural", async() => {
    installCanvas(solid(50, 200, 80));
    const f = await extractImageFeatures(img(200, 100));
    assert(f.mood === "natural", `mood=natural（实际 ${f.mood}）`);
  });

  await it("色调顺序：warm 覆盖 dark", async() => {
    // 深红：avgLum≈0.156 先落 dark，但 R>G+30 且 R>B+30 又改成 warm
    installCanvas(solid(90, 20, 10));
    const f = await extractImageFeatures(img(200, 100));
    assert(f.avgLuminance < 0.3, `平均亮度确实低于 0.3（实际 ${f.avgLuminance}）`);
    assert(f.mood === "warm", `warm 覆盖 dark（实际 ${f.mood}）`);
  });

  await it("色调顺序：cool 覆盖 bright", async() => {
    // 亮蓝：avgLum≈0.786 先落 bright，随后 B>R+20 且 B>G 改成 cool
    installCanvas(solid(180, 200, 255));
    const f = await extractImageFeatures(img(200, 100));
    assert(f.avgLuminance > 0.7, `平均亮度确实高于 0.7（实际 ${f.avgLuminance}）`);
    assert(f.mood === "cool", `cool 覆盖 bright（实际 ${f.mood}）`);
  });

  await it("bright 阈值卡在 0.7：0.65 不算亮", async() => {
    installCanvas(solid(166, 166, 166));
    const f = await extractImageFeatures(img(200, 100));
    assert(f.mood === "neutral", `avgLum≈0.651 未过 0.7（实际 ${f.mood}）`);
  });

  await it("dark 阈值卡在 0.3：0.25 算暗", async() => {
    installCanvas(solid(64, 64, 64));
    const f = await extractImageFeatures(img(200, 100));
    assert(f.mood === "dark", `avgLum≈0.251 已过 0.3（实际 ${f.mood}）`);
  });

  await it("warm 的 +30 边界：R 恰好等于 G+30 不算 warm", async() => {
    installCanvas(solid(160, 130, 10));
    const f = await extractImageFeatures(img(200, 100));
    assert(f.mood === "neutral", `160 = 130+30 不满足严格大于（实际 ${f.mood}）`);
  });

  await it("cool 的 +20 边界：B 恰好等于 R+20 不算 cool", async() => {
    installCanvas(solid(100, 100, 119));
    const f = await extractImageFeatures(img(200, 100));
    assert(f.mood === "neutral", `119 < 100+20（实际 ${f.mood}）`);
  });

  await it("natural 的 +20 边界：G 恰好等于 R+20 不算 natural", async() => {
    installCanvas(solid(100, 119, 110));
    const f = await extractImageFeatures(img(200, 100));
    assert(f.mood === "neutral", `119 < 100+20（实际 ${f.mood}）`);
  });
});

describe("主色量化与占比", async() => {
  await it("纯白量化成 256（/32 取整可越界）", async() => {
    installCanvas(solid(255, 255, 255));
    const f = await extractImageFeatures(img(100, 100));
    assert(f.dominantColors.length === 1, "纯色只有一种主色");
    const c = f.dominantColors[0];
    assert(c.r === 256 && c.g === 256 && c.b === 256, `255 → 量化 256（实际 ${c.r},${c.g},${c.b}）`);
    assert(c.ratio === 1, `ratio=1（实际 ${c.ratio}）`);
  });

  await it("量化档位：104 → 96", async() => {
    installCanvas(solid(104, 0, 0));
    const f = await extractImageFeatures(img(100, 100));
    assert(f.dominantColors[0].r === 96, `round(104/32)*32=96（实际 ${f.dominantColors[0].r}）`);
  });

  await it("量化档位：120 → 128", async() => {
    installCanvas(solid(120, 0, 0));
    const f = await extractImageFeatures(img(100, 100));
    assert(f.dominantColors[0].r === 128, `round(120/32)*32=128（实际 ${f.dominantColors[0].r}）`);
  });

  await it("量化档位：150 → 160", async() => {
    installCanvas(solid(150, 0, 0));
    const f = await extractImageFeatures(img(100, 100));
    assert(f.dominantColors[0].r === 160, `round(150/32)*32=160（实际 ${f.dominantColors[0].r}）`);
  });

  await it("主色最多 5 个且按占比严格倒序", async() => {
    installCanvas(
      stripes([30, 20, 15, 12, 10, 8, 5], [
        [10, 0, 0], [50, 0, 0], [90, 0, 0], [130, 0, 0],
        [170, 0, 0], [210, 0, 0], [250, 0, 0],
      ]),
    );
    const f = await extractImageFeatures(img(100, 100));
    assert(f.dominantColors.length === 5, `7 种颜色只保留前 5（实际 ${f.dominantColors.length}）`);
    const rs = f.dominantColors.map(c => c.ratio);
    assert(
      rs.every((v, i) => i === 0 || rs[i - 1] > v),
      `占比严格递减（实际 ${rs.join(",")}）`,
    );
    assert(rs[0] === 0.3, `最宽条带 30 列 → 0.3（实际 ${rs[0]}）`);
  });

  await it("ratio 保留三位小数（两位小数会被四舍五入掉）", async() => {
    // 10000 像素中 5300 不着色 / 5400 A / 4500 B：opaque=9900
    installCanvas(bands([[54, 0], [45, 1], [1, -1]], [[200, 60, 60], [60, 60, 200]]));
    const f = await extractImageFeatures(img(100, 100));
    assert(f.dominantColors.length === 2, "两种主色");
    const [a, b] = f.dominantColors;
    assert(a.ratio === 0.545, `5400/9900 → 0.545（实际 ${a.ratio}）`);
    assert(b.ratio === 0.455, `4500/9900 → 0.455（实际 ${b.ratio}）`);
  });
});

describe("边缘密度与对称度", async() => {
  await it("棋盘格：每个内部像素都是边缘，edgeDensity=0.960", async() => {
    installCanvas(checkerboard([100, 100, 100], [140, 140, 140]));
    const f = await extractImageFeatures(img(100, 100));
    assert(f.edgeDensity === 0.96, `98*98/10000=0.960（实际 ${f.edgeDensity}）`);
  });

  await it("上下灰度分界：只有垂直方向有边", async() => {
    installCanvas(topBottom([100, 100, 100], [140, 140, 140]));
    const f = await extractImageFeatures(img(100, 100));
    assert(f.edgeDensity === 0.01, `交界那一行 98 个边缘 → 0.010（实际 ${f.edgeDensity}）`);
  });

  await it("纯色图无边缘", async() => {
    installCanvas(solid(128, 128, 128));
    const f = await extractImageFeatures(img(100, 100));
    assert(f.edgeDensity === 0, `edgeDensity=0（实际 ${f.edgeDensity}）`);
  });

  await it("左右黑白不对称：对称度低", async() => {
    installCanvas(halves([0, 0, 0], [255, 255, 255]));
    const f = await extractImageFeatures(img(100, 100));
    assert(f.symmetry < 0.2, `对称度低（实际 ${f.symmetry}）`);
  });

  await it("横向渐变左右对称：对称度 1", async() => {
    installCanvas(mirroredDelta(0));
    const f = await extractImageFeatures(img(100, 100));
    assert(f.symmetry === 1, `完全左右对称（实际 ${f.symmetry}）`);
  });

  await it("对称阈值下界：每通道差 7（总分 21 < 30）算对称", async() => {
    installCanvas(mirroredDelta(7));
    const f = await extractImageFeatures(img(100, 100));
    assert(f.symmetry === 1, `总分 21 全部计分（实际 ${f.symmetry}）`);
  });

  await it("对称阈值上界：每通道差 13（总分 39 >= 30）不算对称", async() => {
    installCanvas(mirroredDelta(13));
    const f = await extractImageFeatures(img(100, 100));
    assert(f.symmetry === 0, `总分 39 全部不计分（实际 ${f.symmetry}）`);
  });

  await it("对称度只隔行采样（偶数行对称即得满分）", async() => {
    installCanvas(rowVariant(0, 200));
    const f = await extractImageFeatures(img(100, 100));
    assert(f.symmetry === 1, `只扫偶数行 → 1（实际 ${f.symmetry}）`);
  });

  await it("宽度为 1 时：对称度回落 0 而不是 NaN，且宽度下界被抬到 1", async() => {
    // 1x100000 → scale=0.001，w=round(0.001)=0，靠 max(1,0) 抬到 1；
    // 去掉下界会得到空画布进而返回 null
    installCanvas(solid(255, 255, 255));
    const f = await extractImageFeatures(img(1, 100000));
    assert(f !== null, "宽度被抬到 1，仍有像素可取");
    assert(lastDrawImage.w === 1, `采样宽度 1（实际 ${lastDrawImage.w}）`);
    assert(f.symmetry === 0, `halfW=0 → symCount=0 → 0（实际 ${f.symmetry}）`);
    assert(f.edgeDensity === 0, `宽度 1 无内部像素可比（实际 ${f.edgeDensity}）`);
  });
});

describe("宽高比与原始尺寸", async() => {
  await it("aspectRatio 用 natural 尺寸（未缩放）", async() => {
    installCanvas(solid(255, 255, 255));
    const f = await extractImageFeatures(img(200, 100));
    assert(f.aspectRatio === 2, `200/100=2（实际 ${f.aspectRatio}）`);
    assert(f.width === 200 && f.height === 100, `width/height 取 natural（实际 ${f.width}x${f.height}）`);
  });

  await it("aspectRatio 保留两位小数", async() => {
    installCanvas(solid(255, 255, 255));
    const f = await extractImageFeatures(img(300, 700));
    assert(f.aspectRatio === 0.43, `300/700≈0.43（实际 ${f.aspectRatio}）`);
  });

  await it("亮暗阈值：193.92 算亮", async() => {
    installCanvas(solid(250, 170, 170));
    const f = await extractImageFeatures(img(100, 100));
    assert(f.brightRatio === 1 && f.darkRatio === 0, `lum≈193.92 过 180（实际 bright=${f.brightRatio}）`);
  });

  await it("亮暗阈值：56.69 算暗", async() => {
    installCanvas(solid(80, 50, 30));
    const f = await extractImageFeatures(img(100, 100));
    assert(f.darkRatio === 1 && f.brightRatio === 0, `lum≈56.69 过 60（实际 dark=${f.darkRatio}）`);
  });

  await it("亮度权重边界：180.25 算亮、换成 0.3/0.6/0.1 就差一点", async() => {
    // 0.299*5+0.587*255+0.114*255 = 180.25 > 180；
    // 0.3*5+0.6*255+0.1*255 = 180.0，恰好不过 180。
    // 这条专门钉住三个权重系数本身（0.299/0.587/0.114）。
    installCanvas(solid(5, 255, 255));
    const f = await extractImageFeatures(img(100, 100));
    assert(f.brightRatio === 1, `180.25 算亮（实际 bright=${f.brightRatio}）`);
  });
});

describe("特征状态文案 buildFeatureStatusHtml", async() => {
  const feat = (over = {}) =>
    Object.assign(
      {
        mood: "暖",
        symmetry: 0.42,
        edgeDensity: 0.07,
        dominantColors: [
          { r: 200, g: 100, b: 50, ratio: 0.4567 },
          { r: 0, g: 0, b: 0, ratio: 0.0049 },
        ],
      },
      over,
    );

  it("三项指标按 toFixed(0) 取整后拼进文案", () => {
    const html = buildFeatureStatusHtml(feat());
    assert(html.startsWith("🖼️ 已提取图片特征: 暖色调 · "), "开头固定 + mood");
    assert(html.includes("对称度42%"), "对称度 0.42 → 42%");
    assert(html.includes("边缘密度7%"), "边缘密度 0.07 → 7%");
  });

  it("色块按 dominantColors 原序输出，ratio 取整后进 title", () => {
    const html = buildFeatureStatusHtml(feat());
    const swatches = html.slice(html.indexOf("<div class=\"ai-paint-color-swatches\">"));
    assert(swatches.indexOf("rgb(200,100,50)") < swatches.indexOf("rgb(0,0,0)"), "色块顺序与输入一致");
    assert(html.includes("rgb(200,100,50) 46%"), "ratio 0.4567 → 46% 进 title");
    assert(html.includes("rgb(0,0,0) 0%"), "ratio 0.0049 → 0% 进 title");
    assert(html.includes("class=\"ai-paint-color-swatch\""), "色块带固定 class");
    assert(html.includes("style=\"background:rgb(200,100,50)\""), "background 取 rgb 而非占比");
    assert(html.includes("</span><span class=\"ai-paint-color-swatch\""), "多个色块之间无分隔符，直接相邻");
    assert(!html.includes("</span>,<span"), "色块之间不插逗号");
    assert(
      html.indexOf("<div class=\"ai-paint-color-swatches\">") < html.indexOf("class=\"ai-paint-color-swatch\""),
      "容器开标签排在首个色块之前",
    );
    assert(
      html.lastIndexOf("class=\"ai-paint-color-swatch\"") < html.lastIndexOf("</div>"),
      "最后一个色块排在容器闭标签之前",
    );
  });

  it("dominantColors 为空数组时输出空容器且不抛错", () => {
    const html = buildFeatureStatusHtml(feat({ dominantColors: [] }));
    assert(html.includes("<div class=\"ai-paint-color-swatches\"></div>"), "空容器原样闭合");
    assert(html.includes("对称度42%"), "指标部分不受色块影响");
  });

  it("边界取整：0 与 1 都是整百分比，0.005 落到 1%", () => {
    const html = buildFeatureStatusHtml(feat({ symmetry: 0, edgeDensity: 1, dominantColors: [] }));
    assert(html.includes("对称度0%"), "symmetry 0 → 0%");
    assert(html.includes("边缘密度100%"), "edgeDensity 1 → 100%");
    const html2 = buildFeatureStatusHtml(feat({ symmetry: 0.005, edgeDensity: 0.995, dominantColors: [] }));
    assert(html2.includes("对称度1%"), "symmetry 0.005 → 1%");
    assert(html2.includes("边缘密度100%"), "edgeDensity 0.995 → 100%");
  });

  it("mood 原样透传，不做二次加工", () => {
    assert(buildFeatureStatusHtml(feat({ mood: "冷", dominantColors: [] })).includes("冷色调"), "mood 冷");
    assert(buildFeatureStatusHtml(feat({ mood: "亮", dominantColors: [] })).includes("亮色调"), "mood 亮");
  });

  it("返回值是单行字符串", () => {
    assert(!buildFeatureStatusHtml(feat()).includes("\n"), "不含换行");
  });
});


// ===== 运行 =====
(async() => {
  try {
    for (const { name, fn } of describeQueue) {
      console.log(`\n── ${name}`);
      await fn();
    }
  } finally {
    restore();
  }
  console.log("\n════════════════════════════════════════════════════════════════");
  console.log(`  结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) {
    console.log("  失败的用例:");
    for (const f of failures) console.log("    - " + f);
    process.exit(1);
  }
  console.log("  ✅ 全部测试通过！");
})();
