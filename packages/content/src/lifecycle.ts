/**
 * 生命周期语义已在 `workspace.ts` 中实现（trashContent/restoreContent/
 * waiveObligation/purgePreview/purgeContent）。本文件保留稳定入口并承载
 * 将来扩展的生命周期查询，避免模块散落在界面层。
 */
export {
  purgeContent, purgePreview, restoreContent, trashContent, waiveObligation,
} from './workspace.js';
