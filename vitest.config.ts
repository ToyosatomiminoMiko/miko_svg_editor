/**
 * Vitest 配置：只跑纯逻辑单测，node 环境（不依赖 DOM）。
 * 测试文件显式 import { describe, it, expect } from 'vitest'，globals 保持关闭，
 * 这样测试在 tsc 下就是普通 ES 模块，不需要额外的全局类型声明。
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
  },
});
