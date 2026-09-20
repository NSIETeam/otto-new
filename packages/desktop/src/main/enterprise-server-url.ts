export const DEFAULT_ENTERPRISE_SERVER_URL = 'https://101.200.190.204:7777';

// Only these retired public entrypoints belong to the recovered Otto service.
// Do not rewrite private deployments, arbitrary ports, paths or lookalike hosts.
const LEGACY_ENTERPRISE_SERVER_URLS = new Set([
  'https://59.110.154.44',
  'https://59.110.154.44:443',
  'https://59.110.154.44:7777',
  'https://59-110-154-44.sslip.io',
  'https://59-110-154-44.sslip.io:443',
  'https://59-110-154-44.sslip.io:7777',
]);

// A transport move must not change the namespace authenticated by encrypted
// state. This is a local, fixed allowlist, never a redirect supplied by a server.
export function enterpriseCryptoScopeMigration(serverUrl: string): {
  candidates: string[];
  defaultScope: string;
} | null {
  const current = ['https://101.200.190.204:7777', 'https://101.200.190.204', 'https://101.200.190.204:443'];
  if (!current.includes(serverUrl.trim().replace(/\/+$/, ''))) return null;
  return {
    candidates: [...LEGACY_ENTERPRISE_SERVER_URLS, ...current],
    // New devices must use the same deployment identity as existing devices.
    // This value is never used as the HTTP request destination.
    defaultScope: 'https://59.110.154.44:7777',
  };
}

export function defaultEnterpriseServerUrl(
  environmentValue: string | undefined,
): string {
  return environmentValue?.trim() || DEFAULT_ENTERPRISE_SERVER_URL;
}

export function migrateEnterpriseServerUrl(
  persistedValue: string | undefined,
  fallbackUrl: string,
): string {
  const value = persistedValue?.trim();
  if (!value) return fallbackUrl;

  const normalizedValue = value.replace(/\/+$/, '');
  return LEGACY_ENTERPRISE_SERVER_URLS.has(normalizedValue)
    ? fallbackUrl
    : value;
}

export function restoreEnterpriseServerTarget(
  persistedValue: string | undefined,
  configuredValue: string,
  explicitlyConfigured: boolean,
): { serverUrl: string; endpointChanged: boolean } {
  const serverUrl = explicitlyConfigured
    ? configuredValue
    : migrateEnterpriseServerUrl(persistedValue, configuredValue);
  const normalize = (value: string): string => value.trim().replace(/\/+$/, '');
  return {
    serverUrl,
    // Compare the original saved endpoint, before migration can hide a change.
    endpointChanged:
      Boolean(persistedValue?.trim()) &&
      normalize(persistedValue!) !== normalize(serverUrl),
  };
}
