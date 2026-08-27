/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parseManifest } from './update-core.js';

const SHA256 = 'a'.repeat(64);

describe('desktop installer manifest distribution boundary', () => {
  it('keeps legacy standard manifests compatible as the normal Otto channel', () => {
    expect(parseManifest({ version: '1.9.8', assets: {} })).toMatchObject({
      ok: true,
      manifest: { distributionId: 'otto', version: '1.9.8' },
    });
  });

  it('accepts a Green manifest only for a Green client', () => {
    const parsed = parseManifest(
      {
        distributionId: 'otto-green',
        version: '1.9.9',
        assets: {
          'win-x64': {
            name: 'Otto.green-1.9.9.exe',
            url: 'https://59.110.154.44:7777/downloads/otto-green/Otto.green-1.9.9.exe',
            size: 123,
            sha256: SHA256,
          },
        },
      },
      ['https://59.110.154.44:7777'],
      'otto-green',
    );
    expect(parsed).toMatchObject({
      ok: true,
      manifest: {
        distributionId: 'otto-green',
        assets: { 'win-x64': { sha256: SHA256 } },
      },
    });
  });

  it('fails closed when Green receives the normal Otto manifest or vice versa', () => {
    expect(
      parseManifest({ version: '1.9.9', assets: {} }, [], 'otto-green'),
    ).toMatchObject({ ok: false });
    expect(
      parseManifest(
        { distributionId: 'otto-green', version: '1.9.9', assets: {} },
        [],
        'otto',
      ),
    ).toMatchObject({ ok: false });
  });
});
