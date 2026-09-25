// 图片特征提取（从 src/panels/ai-paint-panel.js 抽取，行为不变）。
//
// 搬迁 setupAIPaint 内部的「图片特征提取」块：把上传图按 SAMPLE_SIZE=100 缩
// 采样，逐像素统计（跳过 alpha < 128 的透明像素）主色调量化（每通道 8 档）、
// 平均色与平均亮度、亮/暗像素占比，再做简单 Sobel 边缘检测与左右镜像对称度
// 打分，最后给出整体色调 mood、宽高比，产出供 prompt 增强用的 feature 对象。
//
// 自包含：只用 document.createElement("canvas") 与传入的 imgElement（读
// naturalWidth / naturalHeight），闭包里不引用 setupAIPaint 的任何状态，因此
// 整段搬迁无需 DI 接缝；全透明图 resolve(null)。console.log 打点随函数保留
// （与原本每上传一张就打一次一致）。

export function extractImageFeatures(imgElement) {
  return new Promise(resolve => {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const SAMPLE_SIZE = 100; // 缩小采样以加速

    // 计算缩放比例
    const scale = Math.min(
      SAMPLE_SIZE / imgElement.naturalWidth,
      SAMPLE_SIZE / imgElement.naturalHeight,
    );
    const w = Math.max(1, Math.round(imgElement.naturalWidth * scale));
    const h = Math.max(1, Math.round(imgElement.naturalHeight * scale));

    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(imgElement, 0, 0, w, h);

    const imageData = ctx.getImageData(0, 0, w, h);
    const data = imageData.data;

    // 颜色量化与统计
    const colorMap = new Map();
    let totalR = 0,
      totalG = 0,
      totalB = 0;
    let pixelCount = 0;
    let brightPixels = 0;
    let darkPixels = 0;
    let edgePixels = 0;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (a < 128) continue; // 跳过透明像素

      totalR += r;
      totalG += g;
      totalB += b;
      pixelCount++;

      // 亮度判断
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (lum > 180) brightPixels++;
      if (lum < 60) darkPixels++;

      // 量化颜色（每个通道分8档）
      const qr = Math.round(r / 32) * 32;
      const qg = Math.round(g / 32) * 32;
      const qb = Math.round(b / 32) * 32;
      const key = `${qr},${qg},${qb}`;
      colorMap.set(key, (colorMap.get(key) || 0) + 1);
    }

    if (pixelCount === 0) {
      resolve(null);
      return;
    }

    // 平均色
    const avgR = Math.round(totalR / pixelCount);
    const avgG = Math.round(totalG / pixelCount);
    const avgB = Math.round(totalB / pixelCount);
    const avgLum = (0.299 * avgR + 0.587 * avgG + 0.114 * avgB) / 255;

    // 提取前5个主色
    const sortedColors = [...colorMap.entries()].sort((a, b) => b[1] - a[1]);
    const dominantColors = sortedColors.slice(0, 5).map(([key, count]) => {
      const [r, g, b] = key.split(",").map(Number);
      return { r, g, b, ratio: count / pixelCount };
    });

    // 边缘检测（简单 Sobel）
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = (y * w + x) * 4;
        const idxRight = (y * w + (x + 1)) * 4;
        const idxDown = ((y + 1) * w + x) * 4;
        const lumC = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
        const lumR =
          0.299 * data[idxRight] + 0.587 * data[idxRight + 1] + 0.114 * data[idxRight + 2];
        const lumD =
          0.299 * data[idxDown] + 0.587 * data[idxDown + 1] + 0.114 * data[idxDown + 2];
        if (Math.abs(lumC - lumR) > 30 || Math.abs(lumC - lumD) > 30) {
          edgePixels++;
        }
      }
    }
    const edgeRatio = edgePixels / (w * h);

    // 判断整体色调
    let mood = "neutral";
    if (avgLum > 0.7) mood = "bright";
    else if (avgLum < 0.3) mood = "dark";
    if (avgR > avgG + 30 && avgR > avgB + 30) mood = "warm";
    if (avgB > avgR + 20 && avgB > avgG) mood = "cool";
    if (avgG > avgR + 20 && avgG > avgB + 10) mood = "natural";

    // 宽高比
    const aspectRatio = imgElement.naturalWidth / imgElement.naturalHeight;

    // 是否对称（左右翻转差异大说明不对称）
    let symScore = 0;
    const halfW = Math.floor(w / 2);
    let symCount = 0;
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < halfW; x += 2) {
        const idxL = (y * w + x) * 4;
        const idxR = (y * w + (w - 1 - x)) * 4;
        const diff =
          Math.abs(data[idxL] - data[idxR]) +
          Math.abs(data[idxL + 1] - data[idxR + 1]) +
          Math.abs(data[idxL + 2] - data[idxR + 2]);
        if (diff < 30) symScore++;
        symCount++;
      }
    }
    const symmetry = symCount > 0 ? symScore / symCount : 0;

    const features = {
      dominantColors: dominantColors.map(c => ({
        r: c.r,
        g: c.g,
        b: c.b,
        ratio: parseFloat(c.ratio.toFixed(3)),
      })),
      avgColor: { r: avgR, g: avgG, b: avgB },
      avgLuminance: parseFloat(avgLum.toFixed(3)),
      mood,
      aspectRatio: parseFloat(aspectRatio.toFixed(2)),
      edgeDensity: parseFloat(edgeRatio.toFixed(3)),
      symmetry: parseFloat(symmetry.toFixed(3)),
      brightRatio: parseFloat((brightPixels / pixelCount).toFixed(3)),
      darkRatio: parseFloat((darkPixels / pixelCount).toFixed(3)),
      width: imgElement.naturalWidth,
      height: imgElement.naturalHeight,
    };

    console.log("🎨 图片特征提取:", features);
    resolve(features);
  });
}
