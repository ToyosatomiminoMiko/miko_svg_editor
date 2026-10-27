/**
 * ESLint 扁平配置（ESLint 10 + ts7-eslint）。
 *
 * 为什么是 ts7-eslint：项目编译器是 TypeScript 7（原生 Go 版），它不再导出 JS 编译器 API
 * （typescript 包的根导出只剩版本号，编译能力在 ./unstable/*）。上游 typescript-eslint 的
 * peer 范围是 >=4.8.4 <6.1.0，import 时直接拒绝 TS 7，所以改用 ts7-eslint：
 * 它在 typescript/unstable/* 上重建了编译器适配层，跑的是同一套 @typescript-eslint 规则。
 * 注意它不支持 parserOptions.projectService，只支持「显式 project」或「向上找最近的 tsconfig」，
 * 本仓库是单 tsconfig 项目，用显式 project 指向根 tsconfig。
 *
 * 分层规则（箭头 = 允许 import，只能向下）：
 *   app ──► ui ──► render ──► core ──► config
 * 组合根是 app/main.ts；core 是可在 node 里直接单测的纯逻辑内核；render 是 canvas/SVG
 * 输出适配层；ui 是 miko_ui 组件封装。各层禁止反向 import（core 不碰 render/ui/app，
 * render 不碰 ui/app，ui 不碰 app），需要视图数据时改为参数注入。
 * 约定例外：config 可以 type-only 引用 core 的类型（constraints-meta 需要 Constraint/EntityKind），
 * 运行期依赖仍只有 core → config 一个方向。
 * 具体到文件/函数的地图见 docs/ARCHITECTURE.md「依赖规则」；README「依赖方向与配置分层」
 * 是面向使用者的说明。
 */

import js from '@eslint/js';
import tseslint from 'ts7-eslint';
import prettier from 'eslint-config-prettier';

/** 由 ts7-eslint 解析（需要 TypeScript 程序）的文件 */
const TS_FILES = ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'];

/** 分层目录：规则按「谁禁止 import 谁」分别声明 */
const CORE_FILES = ['src/core/**/*.ts'];
const CONFIG_FILES = ['src/config/**/*.ts'];
const RENDER_FILES = ['src/render/**/*.ts'];
const UI_FILES = ['src/ui/**/*.ts'];

/**
 * 生成「禁止 import 这些目录」的通配模式。
 * no-restricted-imports 的 patterns 用 minimatch 匹配「源码里写的原始路径」，不做模块解析，
 * 所以必须按相对路径深度分开列：从本层目录上跳一层写 '../x'，层内子目录里写 '../../x'。
 * 不用 './x'：它会在同目录里误伤同名文件（config/index.ts 的 './ui' 是 config/ui.ts，
 * 只是交互常量，不是 UI 层）。
 */
const forbidLayers = (targets) =>
  targets.flatMap((target) =>
    ['../', '../../'].flatMap((up) => [`${up}${target}`, `${up}${target}/*`]),
  );

/** core/config 同时禁止引 miko_ui：纯逻辑层不该依赖 DOM 组件库 */
const COMPONENT_LIB = ['miko_ui', 'miko_ui/*'];

const CORE_MESSAGE =
  'core 是纯逻辑内核，禁止 import render/ui/app 或 miko_ui：需要视图数据请参数注入（见 docs/ARCHITECTURE.md「依赖规则」）。';
const CONFIG_MESSAGE =
  'config 是纯数据/常量层，禁止 import render/ui/app 或 miko_ui；允许 type-only 引用 core 的类型（见 docs/ARCHITECTURE.md「依赖规则」）。';
const RENDER_MESSAGE =
  'render 是绘图/输出适配层，禁止 import ui/app 或 miko_ui：绘制数据由调用方传入（见 docs/ARCHITECTURE.md「依赖规则」）。';
const UI_MESSAGE =
  'ui 只能依赖 core/render/config 与 miko_ui，禁止反向 import app（组合根在 app/main.ts，见 docs/ARCHITECTURE.md「依赖规则」）。';

export default [
  {
    // demo/ 是本机 gitignored 的 Cartopy 快照与浏览器验收产物，.work/ 是临时协作/验证目录：
    // 两者都不属于源码，eslint 不应扫描（CI checkout 里通常也不存在）。
    ignores: [
      'dist/**',
      'node_modules/**',
      '.npm-cache/**',
      'audit/**',
      'coverage/**',
      'demo/**',
      '.work/**',
    ],
  },

  js.configs.recommended,

  ...tseslint.configs.recommendedTypeChecked,

  {
    files: TS_FILES,
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  {
    files: TS_FILES,
    rules: {
      // switch 必须穷尽联合类型的所有分支（配合 assertNever 在编译期之外再兜底）
      '@typescript-eslint/switch-exhaustiveness-check': 'error',

      // 禁止阻塞式弹窗：提示统一走 UI 层（notify.ts / 状态栏）
      'no-alert': 'error',
      'no-restricted-globals': ['error', 'alert', 'confirm'],

      // 禁止 console：日志应通过 UI 提示或显式调试工具
      'no-console': 'error',

      // 与 tsconfig 的 noUnusedParameters 口径一致：下划线前缀表示「占位参数」。
      // 多态基类的默认实现要保留参数签名（子类按同一签名重写），但默认实现本身用不到它。
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],

      // 命名：类型/接口/类 PascalCase；变量/函数 camelCase，常量允许 UPPER_CASE
      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'default', format: ['camelCase'], leadingUnderscore: 'allow' },
        {
          selector: 'variable',
          format: ['camelCase', 'UPPER_CASE'],
          leadingUnderscore: 'allow',
        },
        { selector: 'function', format: ['camelCase'] },
        { selector: 'parameter', format: ['camelCase'], leadingUnderscore: 'allow' },
        { selector: 'typeLike', format: ['PascalCase'] },
        { selector: 'interface', format: ['PascalCase'] },
        { selector: 'class', format: ['PascalCase'] },
        { selector: 'enum', format: ['PascalCase'] },
        { selector: 'typeParameter', format: ['PascalCase'] },
        { selector: 'enumMember', format: ['UPPER_CASE', 'PascalCase'] },
        { selector: 'import', format: ['camelCase', 'PascalCase'] },
        // 对象属性名是数据契约（如 SVG 属性、CSS 变量），不强制命名风格
        {
          selector: ['classProperty', 'objectLiteralProperty', 'typeProperty', 'parameterProperty'],
          format: null,
        },
        {
          selector: ['classMethod', 'objectLiteralMethod', 'typeMethod'],
          format: ['camelCase'],
        },
      ],
    },
  },

  {
    // 纯逻辑内核：可在 node 里直接单测，只能依赖 config
    files: CORE_FILES,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [...forbidLayers(['render', 'ui', 'app']), ...COMPONENT_LIB],
              message: CORE_MESSAGE,
            },
          ],
        },
      ],
    },
  },

  {
    // 配置层：只能被依赖，不反向依赖视图层；允许 type-only 引用 core 类型
    files: CONFIG_FILES,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [...forbidLayers(['render', 'ui', 'app']), ...COMPONENT_LIB],
              message: CONFIG_MESSAGE,
            },
          ],
        },
      ],
    },
  },

  {
    // 输出适配层：只用 core/config，绘制数据由参数注入
    files: RENDER_FILES,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: [...forbidLayers(['ui', 'app']), ...COMPONENT_LIB], message: RENDER_MESSAGE },
          ],
        },
      ],
    },
  },

  {
    // 组件封装层：可以用 core/render/config 与 miko_ui，但不能反向依赖组合根
    files: UI_FILES,
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: forbidLayers(['app']), message: UI_MESSAGE }] },
      ],
    },
  },

  // 必须放在最后：关掉与 prettier 冲突的格式类规则
  prettier,
];
