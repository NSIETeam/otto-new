/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
// Read-only source comparison. No model, network, fixture mutation or build output.
import { build } from 'esbuild';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

async function load(root) {
  const entry = path.join(root, 'packages/server/src/turnControlPolicy.ts');
  const bundle = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  });
  return {
    api: await import(
      `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
    ),
    sourceSha256: createHash('sha256')
      .update(readFileSync(entry))
      .digest('hex'),
  };
}
const [beforeRoot, afterRoot = process.cwd()] = process.argv.slice(2);
if (!beforeRoot || !path.isAbsolute(beforeRoot) || !path.isAbsolute(afterRoot))
  throw new Error(
    'Usage: node scripts/measure-agent-output.mjs ABSOLUTE_BEFORE_SOURCE [ABSOLUTE_AFTER_SOURCE]',
  );
const before = await load(beforeRoot),
  after = await load(afterRoot);
const prompts = [
  '你好',
  '1 + 1 是多少？',
  '用一句话解释向量数据库',
  '修复登录代码并运行测试',
  '创建 PPT',
  '简短比较最新政策',
  '部署服务器，只要结论',
];
const measurements = prompts.map((text) => {
  const input = { text, source: 'local', toolFree: false };
  const oldPolicy = before.api.deriveTurnControlPolicy(input),
    newPolicy = after.api.deriveTurnControlPolicy(input);
  const { presentation: _old, ...oldControl } = oldPolicy;
  const { presentation: _new, ...newControl } = newPolicy;
  assert.deepEqual(
    newControl,
    oldControl,
    `Native control changed for ${text}`,
  );
  const oldLength = before.api.formatTurnControlDirective(oldPolicy).length;
  const newLength = after.api.formatTurnControlDirective(newPolicy).length;
  return {
    prompt: text,
    beforeDirectiveCharacters: oldLength,
    afterDirectiveCharacters: newLength,
    deltaCharacters: newLength - oldLength,
    controlUnchanged: true,
  };
});
console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      beforeRoot,
      afterRoot,
      beforeSourceSha256: before.sourceSha256,
      afterSourceSha256: after.sourceSha256,
      measurements,
      paidModelCalls: 0,
      limits:
        'Character counts only; not token usage, latency, costs or real-model answer quality. Task-ledger directive savings are separately covered by runtime tests.',
    },
    null,
    2,
  ),
);
