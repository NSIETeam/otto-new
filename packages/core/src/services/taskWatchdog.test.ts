/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Tests for TaskWatchdog
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TaskWatchdog,
  resetTaskWatchdog,
} from '../services/taskWatchdog.js';

describe('TaskWatchdog', () => {
  let watchdog: TaskWatchdog;

  beforeEach(() => {
    resetTaskWatchdog();
    vi.useFakeTimers();
    watchdog = new TaskWatchdog({
      stallTimeoutMs: 5000,      // 5 秒（测试用）
      heartbeatIntervalMs: 1000, // 1 秒
      autoCheckpoint: false,      // 测试中禁用以避免文件 IO
      lowMemoryThresholdMB: 10000, // 极高，避免意外触发
    });
  });

  afterEach(() => {
    watchdog.stop(false);
    vi.useRealTimers();
  });

  describe('start and stop', () => {
    it('should start in active state', () => {
      watchdog.start('session-1', 'Test task');
      const s = watchdog.getStatus();
      expect(s.state).toBe('active');
      expect(s.sessionId).toBe('session-1');
    });

    it('should stop and return to idle', () => {
      watchdog.start('session-1');
      watchdog.stop(true);
      const s = watchdog.getStatus();
      expect(s.state).toBe('idle');
    });
  });

  describe('heartbeat', () => {
    it('should keep state active with regular heartbeats', () => {
      watchdog.start('session-1');

      // Advance time 4 seconds (still under 5s threshold)
      vi.advanceTimersByTime(4000);
      watchdog.heartbeat('Still working...');

      const s = watchdog.getStatus();
      expect(s.state).toBe('active');
      expect(s.idleDurationMs).toBeLessThan(5000);
    });

    it('marks a task stalled when periodic checks see no real output', async () => {
      const onStalled = vi.fn();
      const wd = new TaskWatchdog(
        { stallTimeoutMs: 5000, heartbeatIntervalMs: 1000, autoCheckpoint: false, lowMemoryThresholdMB: 10000 },
        { onStalled },
      );
      wd.start('session-stalled');

      await vi.advanceTimersByTimeAsync(6000);

      expect(wd.getStatus().state).toBe('stalled');
      expect(onStalled).toHaveBeenCalledOnce();
      wd.stop(false);
    });

    it('recovers a stalled task only after a real output heartbeat', async () => {
      const onRecovered = vi.fn();
      const wd = new TaskWatchdog(
        { stallTimeoutMs: 5000, heartbeatIntervalMs: 1000, autoCheckpoint: false, lowMemoryThresholdMB: 10000 },
        { onRecovered },
      );
      wd.start('session-recovered');
      await vi.advanceTimersByTimeAsync(6000);

      wd.heartbeat('new output');

      expect(wd.getStatus().state).toBe('active');
      expect(onRecovered).toHaveBeenCalledOnce();
      wd.stop(false);
    });
  });

  describe('formatStatus', () => {
    it('should output readable status', () => {
      watchdog.start('session-abc123', 'Testing watchdog');
      const formatted = watchdog.formatStatus();
      expect(typeof formatted).toBe('string');
      expect(formatted).toContain('Watchdog Status');
      expect(formatted).toContain('active');
    });
  });

  describe('low memory mode', () => {
    it('should enable/disable low memory mode', () => {
      watchdog.start('session-1');

      expect(watchdog.getStatus().lowMemoryMode).toBe(false);

      watchdog.enableLowMemoryMode();
      expect(watchdog.getStatus().lowMemoryMode).toBe(true);

      watchdog.disableLowMemoryMode();
      expect(watchdog.getStatus().lowMemoryMode).toBe(false);
    });
  });

  describe('callbacks', () => {
    it('should fire state change callback', () => {
      const onStateChange = vi.fn();
      const wd = new TaskWatchdog(
        { stallTimeoutMs: 5000, heartbeatIntervalMs: 1000, autoCheckpoint: false, lowMemoryThresholdMB: 10000 },
        { onStateChange },
      );

      wd.start('session-1');
      expect(onStateChange).toHaveBeenCalledWith('idle', 'active');

      wd.stop(true);
      expect(onStateChange).toHaveBeenCalledWith('active', 'idle');

      wd.stop(false);
    });
  });

  describe('getPendingTask', () => {
    it('should return hasPending: false when no checkpoints', async () => {
      const result = await watchdog.getPendingTask();
      expect(result.hasPending).toBe(false);
    });
  });
});
