# SVG 草图板

一个用约束求解驱动的 SVG 草图 demo：画线/矩形/圆/圆弧，加几何约束与尺寸，导出 SVG。

## 操作

- 左键绘制/拖拽，中键或右键拖拽平移，滚轮缩放，右键单击取消，`Esc` 结束当前操作。
- 选择工具：
  - 点击图元或点选中它，选中的图元和端点用粉色高亮，底部提示同步显示选中数量（图元 / 点分开计数）；
  - `Shift` 点击加减选；`Delete` 删除选中对象；
  - 空白处拖拽框选，方向决定选择方式：
    - **由下往上**拖：交叉选择，框到图元任意一部分就选中整个图元；
    - **由上往下**拖：窗口选择，必须完全包住图元才选中；
    - 框选同样会选中落在框内的点；`Shift` + 框选为累加选择。
- `吸附` 按钮或 `S` 键开关吸附（点、中点、曲线、网格）；关闭后落点就是鼠标位置。
- `固定` 锁定选中的点，以及选中图元的所有端点（红色显示），固定点不再被求解器移动。

## 运行

```bash
npm install
npm run dev        # 开发服务器
npm run build      # 类型检查 + 打包到 dist/
npm run preview    # 预览 dist/
npm run typecheck  # 只跑 tsc --noEmit
```

## 结构

```text
index.html          仅结构，无内联 CSS/JS（只保留 Vite 的 module 入口）
src/main.ts         入口：取 DOM 节点，组装 Editor 与工具栏
src/editor.ts       控制器：工具状态机、指针/键盘、约束动作、视图操作
src/renderer.ts     canvas 渲染（网格、图元、点、尺寸、预览、吸附标记）
src/model.ts        点/图元/约束的增删查与包围盒
src/solver.ts       LM 求解器 + 数值雅可比
src/constraints.ts  各类约束的残差方程
src/geometry.ts     拾取、吸附与框选判定
src/camera.ts       世界坐标 ↔ 屏幕坐标、缩放、网格间距
src/export-svg.ts   SVG 导出
src/toolbar.ts      工具栏 DOM 构建
src/tools.ts        工具/约束按钮的元数据
src/theme.ts        从 CSS 变量读取画布样式
src/styles.css      全部样式；设计常量集中在 :root 的 CSS 变量
```

## 样式约定

颜色、线宽、点半径等常量只写在 `src/styles.css` 的 `:root` 里，
CSS 与 canvas（`src/theme.ts`）共用同一批 `var(--*)`，不在 JS 里另存一份颜色值。
样式目前是暂定稿，调整时优先改这一处。
