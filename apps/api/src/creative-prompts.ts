/**
 * 兼容入口：提示词已移到 `@endless/generation`，这里只重新导出。
 * 既有导入方（生成器与测试）不需要改路径，提示词仍只有一份实现。
 */
export { buildCreativePrompt, creativeSystem, type CreativePromptInput } from '@endless/generation';
