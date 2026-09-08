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
    expect(DEFAULT_ENTERPRISE_SERVER_URL).toBe('https://59.110.154.44:7777');
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
});
