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
 * 分层规则：纯逻辑/纯计算模块禁止 import 渲染、编辑器、工具栏、主题、UI 层，
 * 需要视图数据时改为参数注入（见 audit/AUDIT.md §5.1）；UI 层（editor/renderer/toolbar/
 * main/ui）不受此限制。
 */

import js from '@eslint/js';
import tseslint from 'ts7-eslint';
import prettier from 'eslint-config-prettier';

/** 由 ts7-eslint 解析（需要 TypeScript 程序）的文件 */
const TS_FILES = ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'];

/** src 根目录下的纯逻辑/纯计算模块（与 UI 层同级） */
const PURE_ROOT_FILES = [
  'src/{model,geometry,constraints,solver,dimensions,entities,vec,camera}.ts',
];

/** config 目录同样是纯逻辑层，但相对路径深度不同，单独一套规则 */
const PURE_CONFIG_FILES = ['src/config/**/*.ts'];

/** 纯逻辑层禁止引用的 UI/视图模块名 */
const UI_MODULES = ['renderer', 'editor', 'toolbar', 'main', 'theme', 'ui'];

/** 违规时给读者的统一提示 */
const PURE_LAYER_MESSAGE =
  '纯逻辑层禁止 import renderer/editor/toolbar/main/theme/ui：改为参数注入（见 audit/AUDIT.md §5.1）。';

/**
 * 生成禁止 import 的路径模式。
 * no-restricted-imports 的 patterns 用 minimatch 匹配「源码里写的原始路径」，不做模块解析，
 * 所以必须按相对路径深度分开列：src 根目录的纯逻辑文件只会写 './renderer'，
 * config/*.ts 只会写 '../renderer'（更深一层是 '../../renderer'）。
 * 不能用按模块名的通配（例如把 ui 当成任何层级都禁止）：它会把 src/config/index.ts 里的 './ui'
 * （config/ui.ts，只是外观/交互常量，仍是纯配置）误判成 UI 层。
 */
const UI_IMPORTS_FROM_SRC_ROOT = UI_MODULES.flatMap((name) => [`./${name}`, `./${name}/*`]);
const UI_IMPORTS_FROM_CONFIG = UI_MODULES.flatMap((name) => [
  `../${name}`,
  `../${name}/*`,
  `../../${name}`,
  `../../${name}/*`,
]);

export default [
  {
    ignores: ['dist/**', 'node_modules/**', '.npm-cache/**', 'audit/**', 'coverage/**'],
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

      // 禁止阻塞式弹窗：提示统一走 UI 层（audit/AUDIT.md §5.1）
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
    files: PURE_ROOT_FILES,
    rules: {
      // 纯逻辑层不得依赖 UI/视图层，保证这些模块能在 node 里直接单测
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: UI_IMPORTS_FROM_SRC_ROOT, message: PURE_LAYER_MESSAGE }] },
      ],
    },
  },

  {
    files: PURE_CONFIG_FILES,
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: UI_IMPORTS_FROM_CONFIG, message: PURE_LAYER_MESSAGE }] },
      ],
    },
  },

  // 必须放在最后：关掉与 prettier 冲突的格式类规则
  prettier,
];
