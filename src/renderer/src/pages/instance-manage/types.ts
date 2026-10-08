/** 实例管理页的功能分栏。 */
export type Tab = 'mods' | 'saves' | 'resourcepacks' | 'shaders' | 'schematics' | 'version'

/**
 * 资源列表的分栏筛选。
 * 「已启用 / 已禁用」只有模组有这种语义（靠 .disabled 改名实现），资源包 / 光影只有「全部 / 可更新」。
 */
export type ResFilter = 'all' | 'enabled' | 'disabled' | 'updatable'
