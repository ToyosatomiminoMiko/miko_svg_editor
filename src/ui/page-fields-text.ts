/**
 * 文字元素的属性字段:内容 / 角色(仅页面文字)/ 对齐 / 旋转 + 「打开样式设置」入口.
 *
 * 是什么:选中 text 元素时构建的属性面板片段.字号/颜色/字重/斜体/行高/字距/光晕已全部
 * 迁到「样式设置」窗口(按分类统一覆盖),本面板不再写这些字段,只保留单条 item 自己的
 * 内容,角色,对齐,旋转;「左右居中」开关放在 x/y 下方(`page-fields-common.ts`,因为它约束
 * 的是 x),本文件只在对齐分段上反映它的禁用态.地图地名 item 不显示角色切换(role 固定
 * 'label'),改为显示一条只读说明,指向它真正的样式分类(geo.labels 的 role).
 * 为什么改角色后要调 core 的 applyCategoryStyleToItem:角色变了就等于换了一个分类,
 * 这条 item 必须立刻套用新分类的有效样式(覆盖优先),否则会保留旧角色的样式直到下次
 * 批量应用(`.work/STYLE-SETTINGS-SPEC.md` §7.2).
 * 为什么对齐分段在左右居中打开时禁用:`center_h` 是页面文字的派生约束(x 恒为纸张中心,
 * anchor 恒为 middle).此时改对齐不会生效,禁用比让用户白点一次更清楚;关闭开关后恢复可用.
 * 为什么注记文本域读写 `text` 而不是 `lines`:自动折行时 `lines` 是派生量,直接编辑它会把
 * 自动折出来的断行当成手动换行;文本域显示/写回原始内容,折行由编辑器的 `enforceNoteWrap`
 * 统一重算.注记还多一个「折行宽度(pt)」字段,改宽度立刻重排.
 * 为什么「打开样式设置」要带分类:窗口有 20 个分类,侧栏选中某条文字时用户想改的就是它
 * 所属的那一类;不带分类则窗口停在上次选中的分类,用户还得自己找.
 * 为什么单独成模块:文字字段仍是最多的一块(内容文本域 + 角色分段 + 对齐 + 旋转),
 * 单独一块改样式不会牵动图例/色标.
 * 元信息:作者 ToyosatomiminoMiko,2026-11-05.
 */

import {
  createButton,
  createControlGroup,
  create_element,
  createFieldLabel,
  createRow,
  createSegmented,
  nextWidgetId,
} from 'miko_ui';
import { PAGE_NOTE_WRAP_MIN_PT } from '../config/page';
import { TEXT_STYLE_CATEGORY_META, type TextStyleCategoryId } from '../config/text-style';
import {
  isAutoWrapTextItem,
  itemById,
  textContentOf,
  type TextAnchor,
  type TextItem,
  type TextRole,
} from '../core/page';
import { defaultNoteWrapWidth } from '../core/page-layout';
import { applyCategoryStyleToItem, textCategoryOfItem } from '../core/text-style';
import type { SidebarContext } from './page-sidebar-context';

const ROLE_LABELS: Readonly<Record<TextRole, string>> = {
  title: '标题',
  subtitle: '副标题',
  label: '地名',
  annotation: '标注',
  note: '注记',
  source: '来源',
};

const ANCHOR_LABELS: Readonly<Record<TextAnchor, string>> = {
  start: '左',
  middle: '中',
  end: '右',
};

/** 文字属性面板片段:内容 / 角色(页面文字)/ 对齐 / 旋转 / 打开样式设置 */
export function buildTextFields(ctx: SidebarContext, item: TextItem): HTMLElement[] {
  const fragments: HTMLElement[] = [];

  const textArea = create_element({ tag: 'textarea' }, { class: 'page-textarea' });
  textArea.value = textContentOf(item);
  textArea.rows = 4;
  textArea.id = nextWidgetId('page-text');
  textArea.addEventListener('input', () => {
    const value = textArea.value;
    ctx.handlers.onChange((layout) => {
      const target = itemById(layout, item.id);
      if (target?.kind !== 'text') return;
      // 自动折行的注记:文本域写原始内容,lines 由 enforceNoteWrap 重算;
      // 其它文字:文本域就是 lines(每行一条,回车=手动换行).
      if (isAutoWrapTextItem(target) || target.text !== null) target.text = value;
      else target.lines = value.split('\n');
    });
  });
  ctx.setTextEditor(textArea);
  ctx.controls.registerText('prop.lines', textArea, () => {
    const target = itemById(ctx.getLayout(), item.id);
    return target?.kind === 'text' ? textContentOf(target) : '';
  });
  const textRow = createRow(createFieldLabel('内容', textArea.id), textArea);
  textRow.classList.add('page-text-row');
  fragments.push(textRow);

  // 注记自动折行:宽度是折行的唯一几何输入,改宽度立刻重排(内容/字号/字距变化也走同一约束)
  if (isAutoWrapTextItem(item)) {
    const wrapRow = create_element({ tag: 'div' }, { class: 'page-field-grid' });
    ctx.controls.addNumberRow(
      wrapRow,
      'prop.wrapWidth',
      '折行宽度(pt)',
      () => {
        const target = itemById(ctx.getLayout(), item.id);
        if (target?.kind !== 'text') return PAGE_NOTE_WRAP_MIN_PT;
        return target.wrap_width_pt ?? defaultNoteWrapWidth(ctx.getLayout(), target);
      },
      (value) =>
        ctx.handlers.onChange((layout) => {
          const target = itemById(layout, item.id);
          if (target?.kind !== 'text') return;
          target.wrap_width_pt = value;
        }),
      { min: PAGE_NOTE_WRAP_MIN_PT, step: 1 },
    );
    fragments.push(
      createControlGroup(
        '自动换行',
        wrapRow,
        create_element(
          { tag: 'p' },
          { class: 'page-hint' },
          '内容超出该宽度自动折行;内容里的手动换行会保留.',
        ),
      ),
    );
  }

  // 页面文字可以换角色;地图地名 item 的 role 是生成端语义(固定 'label'),不提供切换.
  if (item.space === 'page') {
    const roleSegmented = createSegmented<TextRole>({
      columns: 3,
      ariaLabel: '文字角色',
      value: item.role,
      items: (Object.keys(ROLE_LABELS) as TextRole[]).map((role) => ({
        value: role,
        label: ROLE_LABELS[role],
      })),
    });
    roleSegmented.onChange((role) =>
      ctx.handlers.onChange((layout, geo) => {
        const target = itemById(layout, item.id);
        if (target?.kind !== 'text') return;
        target.role = role;
        // 角色 = 分类:立即把新分类的有效样式写进这条 item(字号要排除自己,
        // 否则读到的是切换前的角色字号)
        applyCategoryStyleToItem(layout, geo, target, { excludeSelf: true });
        // 切成/切离注记会改变本面板结构(只有注记有「自动换行」组),下一次 sync 重建
        ctx.markPropertyRebuild();
      }),
    );
    ctx.controls.registerSegmented(
      'prop.role',
      () => {
        const target = itemById(ctx.getLayout(), item.id);
        return target?.kind === 'text' ? target.role : 'annotation';
      },
      (value) => roleSegmented.set(value as TextRole),
    );
    fragments.push(createControlGroup('角色', roleSegmented.element));
  } else {
    // 只读说明:样式不在这里改;分类名取 geo.labels 的 role(地图地名真正的样式真源)
    const category = textCategoryOfItem(item, ctx.getGeo());
    const label =
      category === null ? '地图分类' : `地图分类「${TEXT_STYLE_CATEGORY_META[category].label}」`;
    fragments.push(
      create_element(
        { tag: 'p' },
        { class: 'page-hint' },
        `样式在${label}里统一设置,同分类全部地名一起改;单条文字不能单独改字号/颜色.`,
      ),
    );
  }

  fragments.push(buildAlignGroup(ctx, item));

  const rotationGrid = create_element({ tag: 'div' }, { class: 'page-field-grid' });
  ctx.controls.addNumberRow(
    rotationGrid,
    'prop.rotation',
    '旋转(°)',
    () => {
      const target = itemById(ctx.getLayout(), item.id);
      return target?.kind === 'text' ? target.rotation_deg : 0;
    },
    (value) =>
      ctx.handlers.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target?.kind === 'text') target.rotation_deg = value;
      }),
    { step: 1 },
  );
  fragments.push(createControlGroup('旋转', rotationGrid));

  // 面板底部:样式编辑的唯一入口(窗口状态由 app 持有,这里只转发打开动作 + 当前分类)
  const isMap = item.space === 'map';
  const mapCategory = isMap ? textCategoryOfItem(item, ctx.getGeo()) : null;
  const styleButton = createButton({
    text:
      mapCategory === null
        ? '打开样式设置'
        : `打开「${TEXT_STYLE_CATEGORY_META[mapCategory].label}」样式设置`,
    title: '按分类统一设置字号/颜色/字重/行高/字距/光晕(会作用到该分类全部文字)',
    class: 'page-wide-button',
  });
  styleButton.onClick(() => {
    // 分类在点击时按最新 layout 现算:页面文字换过角色后也能打开正确的分类
    const target = itemById(ctx.getLayout(), item.id);
    const category: TextStyleCategoryId | null =
      target?.kind === 'text' ? textCategoryOfItem(target, ctx.getGeo()) : null;
    if (category === null) ctx.handlers.openStyleSettings();
    else ctx.handlers.openStyleSettings(category);
  });
  fragments.push(styleButton.element);
  return fragments;
}

/**
 * 「对齐」组:水平对齐分段.
 * 页面文字开启「左右居中」时 anchor 被约束为 middle(开关在 x/y 下方,见 `page-fields-common.ts`),
 * 这里只负责在对齐分段上反映禁用态;开关切换与外部 sync 都通过 registerRefresh 从最新 layout 同步.
 * 地图地名没有居中约束,分段始终可用.
 */
function buildAlignGroup(ctx: SidebarContext, item: TextItem): HTMLElement {
  const grid = create_element({ tag: 'div' }, { class: 'page-field-grid' });
  const anchorSegmented = createSegmented<TextAnchor>({
    columns: 3,
    ariaLabel: '对齐',
    value: item.anchor,
    items: (Object.keys(ANCHOR_LABELS) as TextAnchor[]).map((anchor) => ({
      value: anchor,
      label: ANCHOR_LABELS[anchor],
    })),
  });
  anchorSegmented.onChange((anchor) =>
    ctx.handlers.onChange((layout) => {
      const target = itemById(layout, item.id);
      if (target?.kind === 'text') target.anchor = anchor;
    }),
  );
  ctx.controls.registerSegmented(
    'prop.anchor',
    () => {
      const target = itemById(ctx.getLayout(), item.id);
      return target?.kind === 'text' ? target.anchor : 'middle';
    },
    (value) => anchorSegmented.set(value as TextAnchor),
  );
  grid.append(anchorSegmented.element);

  /** 左右居中打开时 anchor 恒为 middle,对齐分段禁用(禁用态随每次 sync 同步) */
  const syncAnchorState = (): void => {
    const target = itemById(ctx.getLayout(), item.id);
    const centered = target?.kind === 'text' && target.space === 'page' && target.center_h === true;
    anchorSegmented.element.classList.toggle('is-disabled', centered);
    anchorSegmented.element.querySelectorAll('button').forEach((button) => {
      button.disabled = centered;
    });
  };
  ctx.controls.registerRefresh('prop.anchor_state', syncAnchorState);
  syncAnchorState();

  return createControlGroup('对齐', grid);
}
