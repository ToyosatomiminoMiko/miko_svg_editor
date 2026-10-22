/**
 * 约束求解器（LM）的数值策略常量。
 * 迭代预算按使用场景命名，调用方不要直接写数字：
 * 拖拽要快，增量编辑次之，加约束 / 初始化允许更久。
 */

/** 拖拽期间每帧的迭代上限 */
export const ITER_DRAG = 15;

/** 增量操作（画完一段线、加尺寸等小改动） */
export const ITER_INCREMENTAL = 40;

/** 编辑已有尺寸 */
export const ITER_EDIT = 60;

/** 一般操作（固定点、默认值） */
export const ITER_FULL = 80;

/** 新增约束 / 尺寸创建后求稳 */
export const ITER_CONSTRAINT = 120;

/** 残差平方和收敛阈值 */
export const CONVERGE_EPS = 1e-13;

/** 求解结果给用户提示的残差阈值：超过它说明约束没被完全满足 */
export const SOLVE_WARN_EPS = 1e-6;

/* ---------------- LM 超参 ---------------- */

/** 阻尼初值 */
export const LAMBDA_INIT = 1e-4;

/** 尝试成功：λ 缩小倍数 */
export const LAMBDA_DECAY = 0.25;

/** 尝试失败：λ 放大倍数 */
export const LAMBDA_GROW = 10;

/** λ 下限 */
export const LAMBDA_MIN = 1e-12;

/** 每次迭代最多尝试的阻尼次数 */
export const RETRY_LIMIT = 10;

/** 数值雅可比的差分步长系数（步长 = 系数 × max(1, |q|)） */
export const JACOBIAN_STEP = 1e-7;

/** 高斯消元主元绝对值下限，低于它视为奇异矩阵 */
export const PIVOT_EPS = 1e-15;
