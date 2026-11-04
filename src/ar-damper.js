// AR 位姿阻尼器（纯数学模块，无 three / DOM 依赖）。
//
// 机制学习自 model-viewer ARRenderer 的 Damper：二阶临界阻尼弹簧的精确解。
// 所有用同一衰减常数的状态以统一速率收敛；当速度与加速度同时足够小时直接
// 吸附到目标，避免渐进逼近永不停止、渲染循环空转。
//
// 另附 smoothingAlpha：帧率无关的指数平滑系数（用于四元数 slerp），
// 替代"每帧固定增量"的帧率相关写法。

export const DECAY_MILLISECONDS = 50;
const MIN_DECAY_MILLISECONDS = 0.001;
const NIL_SPEED_FACTOR = 0.0002;

/**
 * 单轴二阶临界阻尼器。
 * update(x, goal, dt) 按时间步长把 x 向 goal 推进一步；速度状态内部维护。
 */
export class Damper {
  constructor(decayMilliseconds = DECAY_MILLISECONDS) {
    this.velocity = 0;
    this.naturalFrequency = 0;
    this.setDecayTime(decayMilliseconds);
  }

  setDecayTime(decayMilliseconds) {
    this.naturalFrequency = 1 / Math.max(MIN_DECAY_MILLISECONDS, decayMilliseconds);
  }

  /**
   * @param {number} x 当前值
   * @param {number} goal 目标值
   * @param {number} timeStepMilliseconds 帧步长（毫秒）
   * @param {number} normalization x 的量级参考（决定吸附阈值；AR 米级空间传 1 即可）
   * @returns {number} 新的 x
   */
  update(x, goal, timeStepMilliseconds, normalization) {
    const nilSpeed = NIL_SPEED_FACTOR * this.naturalFrequency;

    if (x == null || normalization === 0) {
      this.velocity = 0;
      return goal;
    }
    if (x === goal && this.velocity === 0) return goal;
    if (timeStepMilliseconds < 0) return x;

    // 临界阻尼 ODE 的精确单步解：x'' = ω²(goal-x) - 2ωx'
    const deltaX = x - goal;
    const intermediateVelocity = this.velocity + this.naturalFrequency * deltaX;
    const intermediateX = deltaX + timeStepMilliseconds * intermediateVelocity;
    const decay = Math.exp(-this.naturalFrequency * timeStepMilliseconds);
    const newVelocity =
      (intermediateVelocity - this.naturalFrequency * intermediateX) * decay;
    const acceleration =
      -this.naturalFrequency * (newVelocity + intermediateVelocity * decay);

    // 速度与加速度同向趋零时直接吸附，保证收敛后停止计算
    if (
      Math.abs(newVelocity) < nilSpeed * Math.abs(normalization) &&
      acceleration * deltaX >= 0
    ) {
      this.velocity = 0;
      return goal;
    }

    this.velocity = newVelocity;
    return goal + intermediateX * decay;
  }
}

/**
 * 帧率无关的指数平滑系数：alpha = 1 - e^(-rate * dt)。
 * 同样的 rate 下，无论 60Hz 还是 120Hz，单位时间的收敛进度一致。
 * @param {number} deltaSeconds 帧步长（秒）
 * @param {number} ratePerSecond 收敛速率（越大越快）
 * @returns {number} [0, 1) 区间的插值系数
 */
export function smoothingAlpha(deltaSeconds, ratePerSecond) {
  if (!(deltaSeconds > 0)) return 0;
  return 1 - Math.exp(-ratePerSecond * deltaSeconds);
}

