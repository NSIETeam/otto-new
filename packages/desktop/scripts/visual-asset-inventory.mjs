/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FIXED_SURFACES = [
  { file: 'src/renderer/components/RightPanel.tsx', context: 'right-rail' },
  { file: 'src/renderer/components/ModuleWorkspace.tsx', context: 'right-rail' },
  { file: 'src/renderer/components/ModuleMarketplaceDialog.tsx', context: 'module-launcher' },
  { file: 'src/renderer/components/WorkspaceDialogs.tsx', context: 'expert-card' },
  { file: 'src/renderer/components/CustomAgentIconPicker.tsx', context: 'icon-editor' },
  { file: 'src/renderer/components/FeishuStatusBadge.tsx', context: 'connection-card' },
];

const FUNCTIONAL_INLINE_SVG = new Map([
  ['src/renderer/components/hub/ChannelPairingCard.tsx', 'functional-qr'],
  ['src/renderer/components/hub/PrivacyDataPanel.tsx', 'functional-qr'],
]);

async function discoverSurfaces() {
  const hubDirectory = path.join(packageRoot, 'src', 'renderer', 'components', 'hub');
  const hubSurfaces = (await readdir(hubDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tsx') && !entry.name.includes('.test.'))
    .map((entry) => ({
      file: `src/renderer/components/hub/${entry.name}`,
      context: entry.name === 'ChannelPairingCard.tsx' ? 'connection-card' : 'module-subpage',
    }));
  return [...FIXED_SURFACES, ...hubSurfaces];
}

function classify(component, file) {
  if (component === 'ModuleIcon' || /^Icon[A-Z]/u.test(component)) {
    return 'registered-semantic-svg';
  }
  if (component === 'GeneratedIcon') return 'generated-raster';
  if (component === 'img') return 'raster-image';
  if (component === 'svg') return FUNCTIONAL_INLINE_SVG.get(file) ?? 'inline-unregistered-svg';
  return 'unclassified';
}

export async function buildVisualAssetInventory() {
  const assets = [];
  const surfaces = await discoverSurfaces();
  for (const surface of surfaces) {
    const source = await readFile(path.join(packageRoot, surface.file), 'utf8');
    const lines = source.split('\n');
    for (const [index, line] of lines.entries()) {
      for (const match of line.matchAll(/<(ModuleIcon|GeneratedIcon|Icon[A-Z][A-Za-z0-9]*|svg|img)\b/gu)) {
        const component = match[1];
        assets.push({
          file: surface.file,
          line: index + 1,
          context: surface.context,
          component,
          classification: classify(component, surface.file),
          themeAware: component !== 'GeneratedIcon' && component !== 'img',
        });
      }
    }
  }
  return {
    schemaVersion: 1,
    generatedFrom: surfaces.map(({ file, context }) => ({ file, context })),
    assets,
  };
}

async function main() {
  const inventory = await buildVisualAssetInventory();
  const invalid = inventory.assets.filter((asset) =>
    asset.classification === 'unclassified'
      || asset.classification === 'inline-unregistered-svg');
  if (invalid.length > 0) {
    throw new Error(`Unclassified production visual assets:\n${JSON.stringify(invalid, null, 2)}`);
  }
  const outputIndex = process.argv.indexOf('--output');
  const serialized = `${JSON.stringify(inventory, null, 2)}\n`;
  if (outputIndex >= 0) {
    const requested = process.argv[outputIndex + 1];
    if (!requested) throw new Error('--output requires a path');
    const output = path.resolve(process.cwd(), requested);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, serialized, 'utf8');
  } else {
    process.stdout.write(serialized);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
