/**
 * promptfoo 断言：把模型输出喂给真正的 ESL 校验器（`pnpm lab assert`，读 stdin）。
 * 规则只写在 packages/esl 一处，这里不重复实现，避免「回归矩阵」和实际流水线判得不一样。
 *
 * 阈值按运行配置对齐（config/run-smoke20f.yaml 的 oov_warn 0.08 / oov_block 0.25）：
 * 断言默认值 2%/5% 比流水线严得多，会把「能过流水线」的批次判成失败。
 * allowed_extra 从用例变量透传，等价于流水线把 brief.vocab.allowed_extra 并进词表。
 *
 * promptfoo 用法：assert: [{ type: javascript, value: file://esl-assert.js }]
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

/** apps/lab/promptfoo → 仓库根 */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const OOV_WARN = '0.08';
const OOV_BLOCK = '0.25';

module.exports = (output, context) => {
  const allowedExtra = String(context?.vars?.allowed_extra ?? '').trim();
  const args = ['--dir', REPO_ROOT, 'lab', 'assert', '--oov-warn', OOV_WARN, '--oov-block', OOV_BLOCK];
  if (allowedExtra) args.push('--allowed-extra', allowedExtra);
  const run = spawnSync('pnpm', args, {
    input: String(output ?? ''),
    encoding: 'utf8',
    shell: true,
    timeout: 180_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  if (run.error) {
    return { pass: false, score: 0, reason: `断言进程启动失败：${run.error.message}` };
  }
  const ok = run.status === 0;
  const text = (ok ? run.stdout : run.stderr || run.stdout || '').trim();
  const reason = text.split('\n').slice(0, 12).join('\n') || `lab assert 退出码 ${run.status}`;
  return { pass: ok, score: ok ? 1 : 0, reason };
};
