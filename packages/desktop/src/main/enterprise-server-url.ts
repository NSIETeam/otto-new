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
