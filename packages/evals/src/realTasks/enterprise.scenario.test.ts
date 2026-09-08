/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  startEnterpriseFixture,
  executeTenantBoundary,
  executeParkReplies,
} from './enterprise.js';
import { EvidenceJournal } from './evidence.js';
it('real isolated HTTP routes enforce tenancy and record the current unsupported two-staff reply flow as failure (no UI/model score)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'otto-real-enterprise-'));
  const fixture = await startEnterpriseFixture(path.join(root, 'database'));
  try {
    const tenantJournal = new EvidenceJournal(path.join(root, 'tenant'));
    const tenant = await tenantJournal.finish(
      'tenant-boundary',
      await executeTenantBoundary(fixture, tenantJournal),
      { mode: 'scripted' },
    );
    expect(tenant.independentPass, JSON.stringify(tenant.checks)).toBe(true);
    const parkJournal = new EvidenceJournal(path.join(root, 'park'));
    const { observations } = await executeParkReplies(fixture, parkJournal);
    const park = await parkJournal.finish('park-replies', observations, {
      mode: 'scripted',
    });
    expect(park.independentPass).toBe(false);
    expect(
      fixture.requests.some(
        (r) =>
          r.status === 400 && JSON.stringify(r.data).includes('回复并转交'),
      ),
    ).toBe(true);
    expect(park.traceComplete).toBe(false); // A product failure cannot invent a UI screenshot.
  } finally {
    await fixture.close();
  }
}, 90000);
