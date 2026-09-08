/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let fixtureRoot: string;
let fixtureHome: string;
beforeEach(async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'otto-user-root-'));
  fixtureHome = path.join(fixtureRoot, 'home');
  await mkdir(fixtureHome);
  vi.stubEnv('HOME', fixtureHome);
  vi.stubEnv('USERPROFILE', fixtureHome);
  vi.stubEnv('OTTO_USER_DIR', path.join(fixtureRoot, 'profile'));
  vi.resetModules();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(fixtureRoot, { recursive: true, force: true });
});

it('creates memory and session state beneath the current isolated profile at construction time', async () => {
  const { AutoMemoryEngine } = await import('../memory/autoMerge.js');
  const { OttoSessionManager } = await import('../sessions/sessionManager.js');
  for (const profile of ['first', 'second']) {
    const userRoot = path.join(fixtureRoot, profile);
    vi.stubEnv('OTTO_USER_DIR', userRoot);
    await new AutoMemoryEngine().initialize();
    const sessions = new OttoSessionManager();
    await sessions.initialize();
    const session = await sessions.createSession({
      channel: 'local',
      title: profile,
    });
    expect(
      JSON.parse(
        await readFile(path.join(userRoot, 'memory/memory-index.json'), 'utf8'),
      ),
    ).toEqual([]);
    expect(
      JSON.parse(
        await readFile(path.join(userRoot, 'sessions/sessions.json'), 'utf8'),
      )[0].id,
    ).toBe(session.id);
  }
  await expect(
    stat(path.join(fixtureHome, '.otto-user')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

it('seeds builtin skills only in the isolated profile while keeping explicit storage overrides', async () => {
  const { seedDefaultSkills } = await import('../skills/seed-skills.js');
  const seeded = seedDefaultSkills();
  expect(seeded.length).toBeGreaterThan(0);
  expect(
    (await stat(path.join(fixtureRoot, 'profile/skills'))).isDirectory(),
  ).toBe(true);
  const { OttoSessionManager } = await import('../sessions/sessionManager.js');
  const explicit = path.join(fixtureRoot, 'explicit-sessions');
  const manager = new OttoSessionManager({ storageDir: explicit });
  await manager.initialize();
  await manager.createSession({ channel: 'local' });
  expect(
    JSON.parse(await readFile(path.join(explicit, 'sessions.json'), 'utf8')),
  ).toHaveLength(1);
  await expect(
    stat(path.join(fixtureHome, '.otto-user')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});
