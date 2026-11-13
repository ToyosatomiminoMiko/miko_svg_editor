/**
 * SVG 导入标定:文件入口(选择框接受的类型/大小)与「几何简化」的离散/数量口径.
 *
 * 为什么单独一个配置文件:导入是草图页唯一的外部输入入口,所有阈值(多大算过大,
 * 一条曲线离散几段,最多导入多少图元)集中在这里,ui(文件读取)与 core(树 -> 图元)
 * 读同一份,避免两处各写一个魔数后口径漂移.
 * 为什么这些阈值存在:草图编辑器没有撤销/重做,导出一个几千图元的 SVG 后仍然要能流畅
 * 拖拽/求解;上限的意义是把「浏览器卡死」变成一条中文提示,而不是静默拒绝或卡住.
 */

/** 文件选择框的 accept:只收 SVG(导出侧文件名是 sketch.svg) */
export const IMPORT_ACCEPT = '.svg,image/svg+xml';

/** 单个 SVG 文件大小上限(8 MB):超过时在读取前就拒绝,不把整份文本读进内存 */
export const IMPORT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 读取阶段允许的 DOM 节点数上限(含非图形节点).
 * 与 IMPORT_MAX_SHAPES 分开:节点上限挡「一万层 <g>」这类结构攻击,图元上限挡几何数量.
 */
export const IMPORT_MAX_NODES = 20000;

/** 一次导入最多写进模型的图元数;超过后停止转换并提示已截断 */
export const IMPORT_MAX_SHAPES = 5000;

/** 三次/二次贝塞尔每段离散出的折线数;段数越多越接近曲线,但会成倍增加图元 */
export const IMPORT_CURVE_SEGMENTS = 12;

/** 椭圆(以及 path 里的椭圆弧)离散成折线的段数;椭圆没有圆心/半径可表达,只能折线逼近 */
export const IMPORT_ELLIPSE_SEGMENTS = 48;

/** 提示里最多列出的「被跳过元素种类」数,其余折叠成「等」 */
export const IMPORT_WARN_LIMIT = 4;

/** 解析成功但没有任何「能写进模型」的几何图元(含全部退化)时的提示文案 */
export const IMPORT_EMPTY_MESSAGE =
  '这个 SVG 里没有可导入的几何图元(只支持直线/圆/圆弧/点/路径轮廓,且图元尺寸不能过小)';

/** 文件不是有效 SVG(DOMParser 报错 / 根元素不是 svg)时的提示文案 */
export const IMPORT_INVALID_MESSAGE = '不是有效的 SVG 文件:XML 解析失败或根元素不是 <svg>';

/** 文件过大提示里的上限说明(单位 MB,保留一位小数) */
export const IMPORT_MAX_BYTES_LABEL = `${IMPORT_MAX_BYTES / (1024 * 1024)} MB`;
