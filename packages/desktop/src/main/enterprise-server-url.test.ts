import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ENTERPRISE_SERVER_URL,
  defaultEnterpriseServerUrl,
  migrateEnterpriseServerUrl,
  restoreEnterpriseServerTarget,
} from './enterprise-server-url.js';

describe('enterprise server URL', () => {
  it('lets an explicit launch target replace persisted state and invalidates its token', () => {
    expect(
      restoreEnterpriseServerTarget(
        'https://otto.example.com/',
        'http://127.0.0.1:7777',
        true,
      ),
    ).toEqual({ serverUrl: 'http://127.0.0.1:7777', endpointChanged: true });
    expect(
      restoreEnterpriseServerTarget(
        'http://127.0.0.1:7777/',
        'http://127.0.0.1:7777',
        true,
      ).endpointChanged,
    ).toBe(false);
  });

  it('preserves a custom saved endpoint unless the launch target is explicit', () => {
    expect(
      restoreEnterpriseServerTarget(
        'https://otto.example.com/',
        DEFAULT_ENTERPRISE_SERVER_URL,
        false,
      ),
    ).toEqual({
      serverUrl: 'https://otto.example.com/',
      endpointChanged: false,
    });
  });

  it.each([true, false])(
    'invalidates the old token on legacy endpoint migration (explicit=%s)',
    (explicit) => {
      expect(
        restoreEnterpriseServerTarget(
          'https://59-110-154-44.sslip.io/',
          DEFAULT_ENTERPRISE_SERVER_URL,
          explicit,
        ),
      ).toEqual({
        serverUrl: DEFAULT_ENTERPRISE_SERVER_URL,
        endpointChanged: true,
      });
    },
  );

  it('uses the reachable IP HTTPS endpoint by default', () => {
    expect(DEFAULT_ENTERPRISE_SERVER_URL).toBe('https://101.200.190.204:7777');
    expect(defaultEnterpriseServerUrl(undefined)).toBe(
      DEFAULT_ENTERPRISE_SERVER_URL,
    );
  });

  it('keeps an explicit environment override', () => {
    expect(
      defaultEnterpriseServerUrl('  https://enterprise.example.com/  '),
    ).toBe('https://enterprise.example.com/');
  });

  it('migrates the blocked legacy endpoint from persisted sessions', () => {
    expect(
      migrateEnterpriseServerUrl(
        'https://59-110-154-44.sslip.io/',
        DEFAULT_ENTERPRISE_SERVER_URL,
      ),
    ).toBe(DEFAULT_ENTERPRISE_SERVER_URL);
  });

  it('preserves a custom persisted endpoint', () => {
    expect(
      migrateEnterpriseServerUrl(
        'https://otto.example.com/',
        DEFAULT_ENTERPRISE_SERVER_URL,
      ),
    ).toBe('https://otto.example.com/');
  });

  it.each([
    'https://59.110.154.44:7777',
    'https://59.110.154.44',
    'https://59.110.154.44:443',
    'https://59-110-154-44.sslip.io',
    'https://59-110-154-44.sslip.io:443',
    'https://59-110-154-44.sslip.io:7777',
  ])('migrates the retired official endpoint %s without reusing its token', (url) => {
    expect(restoreEnterpriseServerTarget(`  ${url}/  `, DEFAULT_ENTERPRISE_SERVER_URL, false))
      .toEqual({ serverUrl: 'https://101.200.190.204:7777', endpointChanged: true });
  });

  it.each([
    'https://59.110.154.44:7777/tenant',
    'https://59.110.154.44:7777?tenant=example',
    'https://59.110.154.44:7777#example',
    'https://59.110.154.44:8888',
    'https://59.110.154.44.example.com:7777',
    'https://59-110-154-44.sslip.io.example.com',
    'https://user@59.110.154.44:7777',
    'http://127.0.0.1:7777',
    'https://enterprise.example.com',
    'https://101.200.190.204:7777',
  ])('does not retarget an unrelated or already migrated deployment: %s', (url) => {
    expect(restoreEnterpriseServerTarget(url, DEFAULT_ENTERPRISE_SERVER_URL, false))
      .toEqual({ serverUrl: url, endpointChanged: false });
  });

  it('uses the new default for a first launch without reporting a session change', () => {
    expect(restoreEnterpriseServerTarget(undefined, DEFAULT_ENTERPRISE_SERVER_URL, false))
      .toEqual({ serverUrl: 'https://101.200.190.204:7777', endpointChanged: false });
    expect(defaultEnterpriseServerUrl('  ')).toBe('https://101.200.190.204:7777');
  });
});
