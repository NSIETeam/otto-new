/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

/** Parse bounded, native runner output, never model-supplied evidence names.
 * A reported passing case establishes execution, NOT adequacy of its assertions.
 * Unsupported, partial, ambiguous and skipped results fail closed. */
export function passedTestCases(output: unknown): string[] {
  if (typeof output !== 'string' || output.length > 2_000_000) return [];
  const cases = new Map<string, boolean>();
  const add = (name: unknown, passed: boolean) => {
    if (typeof name !== 'string' || !name.trim() || name.length > 500) return;
    // Even two successful cases with the same name are ambiguous.
    cases.set(name, !cases.has(name) && passed);
  };
  try {
    const report = JSON.parse(output);
    if (
      !Array.isArray(report.testResults) ||
      report.testResults.length > 10_000
    )
      return [];
    for (const suite of report.testResults) {
      if (
        !Array.isArray(suite.assertionResults) ||
        suite.assertionResults.length > 10_000
      )
        return [];
      for (const result of suite.assertionResults)
        add(result.fullName, result.status === 'passed');
    }
  } catch {
    const lines = output.split(/\r?\n/u);
    const start = lines.indexOf('TAP version 13');
    if (start < 0 || lines.some((line) => /^Bail out!/iu.test(line))) return [];
    let plan: number | undefined;
    const ids = new Set<number>();
    for (const line of lines.slice(start + 1)) {
      const range = line.match(/^1\.\.(\d+)\s*$/u);
      if (range) {
        if (plan !== undefined) return [];
        plan = Number(range[1]);
      }
      const match = line.match(/^(not ok|ok) (\d+) - (.+)$/u);
      if (!match) continue;
      const id = Number(match[2]);
      if (ids.has(id)) return [];
      ids.add(id);
      const name = match[3].split(/\s+#\s*(?:SKIP|TODO)\b/iu)[0];
      add(
        name,
        match[1] === 'ok' && !/\s+#\s*(?:SKIP|TODO)\b/iu.test(match[3]),
      );
    }
    if (
      !plan ||
      plan !== ids.size ||
      [...ids].some((id) => id < 1 || id > plan!)
    )
      return [];
  }
  return [...cases].filter(([, passed]) => passed).map(([name]) => name);
}
