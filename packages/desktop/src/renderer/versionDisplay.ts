/** Convert the release SemVer into Otto's compact user-facing beta label. */
export function displayOttoVersion(version: string): string {
  return version.replace(/-beta(?:\.0)?$/u, 'beta');
}
