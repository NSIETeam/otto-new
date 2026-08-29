/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ComponentLoadLevel,
  ComponentSource,
  ComponentType,
} from '../models/unified.js';
import { SettingsManager } from '../settings-manager.js';
import { MarketplaceLoader } from './marketplace-loader.js';
import { UniversalComponentLoader } from './universal-component-loader.js';

describe('component loader wiring', () => {
  let root: string;
  let marketplacePath: string;
  let settingsManager: SettingsManager;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-component-loader-'));
    marketplacePath = path.join(root, 'fixture-marketplace');
    const pluginPath = path.join(marketplacePath, 'plugins', 'demo');
    const skillPath = path.join(pluginPath, 'skills', 'demo-skill');
    await fs.ensureDir(path.join(marketplacePath, '.claude-plugin'));
    await fs.ensureDir(skillPath);
    await fs.writeJson(
      path.join(marketplacePath, '.claude-plugin', 'marketplace.json'),
      {
        name: 'Fixture Marketplace',
        plugins: [
          {
            name: 'demo',
            source: 'plugins/demo',
            version: '1.0.0',
            description: 'Fixture plugin',
            skills: ['skills/demo-skill'],
          },
        ],
      },
    );
    await fs.writeFile(
      path.join(skillPath, 'SKILL.md'),
      [
        '---',
        'name: demo-skill',
        'description: Fixture skill',
        '---',
        '',
        'Run the fixture skill.',
      ].join('\n'),
    );

    const installedPlugin = {
      id: 'fixture:demo',
      name: 'demo',
      marketplaceId: 'fixture',
      installedAt: '2026-08-29T00:00:00.000Z',
      enabled: true,
      skillCount: 1,
    };
    settingsManager = {
      initialize: vi.fn(async () => undefined),
      readInstalledPlugins: vi.fn(async () => ({
        plugins: { 'fixture:demo': installedPlugin },
        lastUpdated: '2026-08-29T00:00:00.000Z',
      })),
      getMarketplaces: vi.fn(async () => [
        {
          id: 'fixture',
          name: 'Fixture Marketplace',
          source: 'local',
          location: marketplacePath,
          enabled: true,
          addedAt: '2026-08-29T00:00:00.000Z',
        },
      ]),
      getInstalledPlugin: vi.fn(async (pluginId: string) =>
        pluginId === installedPlugin.id ? installedPlugin : null,
      ),
    } as unknown as SettingsManager;
  });

  afterEach(async () => {
    await fs.remove(root);
  });

  it('loads one installed plugin through the same marketplace rules as bulk discovery', async () => {
    const loader = new MarketplaceLoader(settingsManager);

    await expect(loader.loadPlugin('fixture:demo')).resolves.toMatchObject({
      id: 'fixture:demo',
      version: '1.0.0',
      enabled: true,
      components: [
        {
          name: 'demo-skill',
          type: ComponentType.SKILL,
          pluginId: 'fixture:demo',
        },
      ],
    });
    await expect(loader.loadPlugin('fixture:missing')).resolves.toBeNull();
  });

  it('registers the marketplace loader by default and indexes its components', async () => {
    const loader = new UniversalComponentLoader({ settingsManager });

    await loader.initialize();

    expect(settingsManager.initialize).toHaveBeenCalledOnce();
    await expect(loader.getPlugins()).resolves.toMatchObject([
      { id: 'fixture:demo', enabled: true },
    ]);
    await expect(
      loader.getComponents({ type: ComponentType.SKILL, search: 'fixture' }),
    ).resolves.toMatchObject([
      { name: 'demo-skill', pluginId: 'fixture:demo' },
    ]);
  });

  it('allows an explicit loader set to replace marketplace discovery', async () => {
    const component = {
      id: 'local:fixture',
      type: ComponentType.SKILL,
      name: 'local-fixture',
      description: 'Component supplied by an injected loader',
      source: ComponentSource.LOCAL,
      location: { type: 'memory' as const, path: 'local:fixture' },
      executable: true,
      scripts: [],
      references: [],
      installed: true,
      enabled: true,
      loadLevel: ComponentLoadLevel.FULL,
    };
    const injectedLoader = {
      load: vi.fn(async () => [component]),
      loadDetails: vi.fn(async (componentId: string) =>
        componentId === component.id ? component : null,
      ),
    };
    const loader = new UniversalComponentLoader({ loaders: [injectedLoader] });

    await expect(loader.getComponents()).resolves.toEqual([component]);
    expect(injectedLoader.load).toHaveBeenCalledOnce();
  });
});
