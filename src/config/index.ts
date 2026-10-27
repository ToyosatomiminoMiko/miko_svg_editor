/**
 * 配置汇总出口：业务代码统一从 './config' 引入常量与元数据，
 * 不直接深引具体文件，便于以后按需拆包。
 */

export * from './angle';
export * from './constraints-meta';
export * from './export';
export * from './format';
export * from './layout';
export * from './limits';
export * from './mapdoc';
export * from './solver';
export * from './tolerances';
export * from './ui';
