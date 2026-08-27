export const GREEN_DISTRIBUTION_ID = 'otto-green';
export const GREEN_UPDATE_ASSET_BASE_URL =
  'https://59.110.154.44:7777/downloads/otto-green';
export const GREEN_UPDATE_MANIFEST_URL =
  'https://59.110.154.44:7777/otto-green-releases/latest.json';

export function resolveGreenUpdateAssetBaseUrl(
  candidate = process.env.OTTO_GREEN_UPDATE_ASSET_BASE_URL,
) {
  const raw = candidate?.trim() || GREEN_UPDATE_ASSET_BASE_URL;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid OTTO_GREEN_UPDATE_ASSET_BASE_URL: ${raw}`);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      'OTTO_GREEN_UPDATE_ASSET_BASE_URL must be an HTTPS URL without credentials, query, or fragment',
    );
  }
  return parsed.toString().replace(/\/+$/, '');
}
