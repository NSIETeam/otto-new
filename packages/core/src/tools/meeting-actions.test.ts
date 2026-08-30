import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dueMeetingActions,
  MeetingActionsTool,
  registerMeetingActions,
} from './meeting-actions.js';

afterEach(() => vi.unstubAllEnvs());

describe('meeting action tracking', () => {
  it('registers structured actions and selects due open/doing tasks', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'meeting-actions-'));
    const file = path.join(dir, 'store.json');
    try {
      await registerMeetingActions(file, '周会', [
        { task: '交付方案', assignee: '小明', due: '2026-08-13' },
        { task: '已完成', assignee: '小红', due: '2026-08-12', status: 'done' },
      ]);
      const due = await dueMeetingActions(file, '2026-08-13');
      expect(due).toHaveLength(1);
      expect(due[0]).toMatchObject({
        task: '交付方案', assignee: '小明', status: 'open', source_meeting: '周会',
      });
      expect(JSON.parse(await readFile(file, 'utf8')).actionItems).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('lists due work without silently sending through a second provider gateway', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'meeting-actions-'));
    const file = path.join(dir, 'store.json');
    vi.stubEnv('OTTO_MEETING_ACTIONS_FILE', file);
    try {
      await registerMeetingActions(file, '周会', [
        { task: '确认发布', assignee: '小王', due: '2026-08-13' },
      ]);
      const result = await new MeetingActionsTool().execute({
        action: 'list_due', today: '2026-08-13',
      }, new AbortController().signal);
      expect(result.llmContent).toContain('尚未外发');
      expect(result.llmContent).toContain('确认发布');
      expect(result.returnDisplay).toContain('1 项');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects action items without an accountable owner/date', async () => {
    await expect(registerMeetingActions('unused', '周会', [
      { task: '任务', assignee: '', due: '待确认' },
    ])).rejects.toThrow('YYYY-MM-DD');
  });
});
