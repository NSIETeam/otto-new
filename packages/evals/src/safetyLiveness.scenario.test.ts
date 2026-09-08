/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';
import { Config, ApprovalMode, generateCustomModelId } from 'otto-core';
import { CoreSessionRuntime } from '../../server/src/runtime.js';
import { InMemorySessionStore } from '../../server/src/sessions.js';
import type { ToolCall, ServerToClient } from '../../server/src/protocol.js';
import { scriptedProvider } from './realTasks/loopbackProvider.js';

// Actual Config -> local HTTP provider -> CoreSessionRuntime -> wrapped native
// tools -> filesystem. The provider is a fixed script, NOT a real-model score.
it.each(['read', 'document'] as const)(
  'actual constrained runtime: %s makes progress without lifting unsafe execution or delivery gates',
  async (mode) => {
    const root = mkdtempSync(
      // A publication word in an operand must not turn reads/local generation
      // into an external operation, regardless of the machine's output folder.
      path.join(
        process.env.OTTO_BASELINE_OUTPUT ?? tmpdir(),
        'otto-publish-liveness-',
      ),
    );
    const workspace = path.join(root, 'workspace');
    mkdirSync(workspace);
    const source = path.join(workspace, 'instructions.txt');
    const output = path.join(workspace, 'report.pptx');
    const marker = path.join(workspace, 'should-not-exist.txt');
    writeFileSync(source, 'Overview: constrained generation');
    const provider = await scriptedProvider((round) => {
      if (round === 1)
        return { name: 'read_file', args: { absolute_path: source } };
      if (mode === 'read')
        return '说明文件的内容是：Overview: constrained generation。';
      if (round === 2)
        return {
          name: 'generate_safe_document',
          args: {
            file_path: output,
            title: 'Overview',
            slides: [{ title: 'Overview', body: 'constrained generation' }],
          },
        };
      if (round === 3)
        return {
          name: 'run_shell_command',
          args: {
            command: `node -e "require('fs').writeFileSync('should-not-exist.txt','unexpected')"`,
            directory: workspace,
          },
        };
      // Deliberately premature wording: writing a valid file must NOT certify all
      // task acceptance, UI preview or visual layout as passed.
      return `全部验收通过。[report.pptx](<${output.replace(/\\/gu, '/')}>)`;
    });
    const oldUserDir = process.env.OTTO_USER_DIR;
    process.env.OTTO_USER_DIR = path.join(root, 'profile');
    const store = new InMemorySessionStore();
    const session = store.createEphemeralSession({ workspacePath: workspace });
    const config = new Config({
      sessionId: session.sessionId,
      cwd: workspace,
      targetDir: workspace,
      debugMode: false,
      model: generateCustomModelId(provider.model),
      customModels: [provider.model],
      coreTools: ['read_file', 'generate_safe_document', 'run_shell_command'],
      disableMcpDiscovery: true,
      disableEnvironmentContext: true,
      approvalMode: ApprovalMode.DEFAULT,
      telemetry: { enabled: false, logPrompts: false },
      usageStatisticsEnabled: false,
      silentMode: true,
      noBrowser: true,
      maxSessionTurns: 6,
    });
    const runtime = new CoreSessionRuntime(
      store,
      session.sessionId,
      config,
      { log: async () => undefined },
      { recoveryStore: false },
    );
    const calls = new Map<string, ToolCall>();
    const frames: ServerToClient[] = [];
    const unsubscribe = store.subscribe(session.sessionId, (frame) => {
      frames.push(frame);
      if (frame.type === 'tool_calls_update')
        for (const call of frame.payload.toolCalls) calls.set(call.id, call);
      // No arbitrary execution approval. Read and new-file generation need none.
      if (frame.type === 'tool_confirmation_request')
        runtime.resolveToolConfirmation(frame.payload.callId, 'rejected');
    });
    const timeout = setTimeout(() => runtime.cancel(), 45_000);
    try {
      await runtime.initialize();
      const request =
        mode === 'read'
          ? `读取说明文件并告诉我内容，不要打开 WPS。文件：${source}`
          : `先读取说明文件，然后使用受控入口生成一页 PPT，标题是 Overview，正文是 constrained generation，保存为 report.pptx，不要打开 WPS，不要显示绝对路径。说明文件：${source}`;
      await runtime.run([{ type: 'text', value: request }], 'local');
      const turn = store
        .getHistory(session.sessionId)
        .find((m) => m.turn)?.turn;
      writeFileSync(
        path.join(root, 'evidence.json'),
        JSON.stringify(
          { mode, realModelScoreEligible: false, request, frames, turn },
          null,
          2,
        ),
      );
      const nativeRead = [...calls.values()].find(
        (c) => c.toolName === 'read_file',
      );
      expect(turn?.control).toMatchObject({
        intent: mode === 'read' ? 'answer' : 'create_artifact',
        riskLevel: mode === 'read' ? 'read_only' : 'local_write',
      });
      expect(nativeRead?.status, JSON.stringify(nativeRead)).toBe('success');
      if (mode === 'read')
        expect(turn?.status, JSON.stringify(turn?.verification)).toBe(
          'completed',
        );
      else {
        const generated = [...calls.values()].find(
          (c) => c.toolName === 'generate_safe_document',
        );
        expect(generated?.status, JSON.stringify(generated)).toBe('success');
        const zip = await JSZip.loadAsync(readFileSync(output));
        const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
        expect(xml).toContain('Overview');
        expect(xml).toContain('constrained generation');
        const shell = [...calls.values()].find(
          (c) => c.toolName === 'run_shell_command',
        );
        expect(shell?.status, JSON.stringify(shell)).toBe('error');
        expect(existsSync(marker)).toBe(false);
        expect(turn?.status).toBe('incomplete');
      }
    } finally {
      clearTimeout(timeout);
      unsubscribe();
      await runtime.dispose();
      await provider.close();
      if (oldUserDir === undefined) delete process.env.OTTO_USER_DIR;
      else process.env.OTTO_USER_DIR = oldUserDir;
      if (!process.env.OTTO_BASELINE_OUTPUT)
        rmSync(root, { recursive: true, force: true });
    }
  },
  60000,
);
