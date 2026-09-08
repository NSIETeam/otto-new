/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import JSZip from 'jszip';
import type { Readable } from 'node:stream';
import { buildLocalArtifactPreview } from '../../../desktop/src/main/local-artifact-preview.js';
import {
  confinedFile,
  sha256,
  type EvidenceJournal,
  type Observation,
} from './evidence.js';
const require = createRequire(import.meta.url);

export async function parseArtifact(workspace: string, name: string) {
  const file = await confinedFile(workspace, name);
  const bytes = await readFile(file);
  if (bytes.length === 0 || bytes.length > 32 * 1024 * 1024)
    throw new Error('Artifact exceeds limits');
  let pages = 0;
  let content = '';
  if (name.endsWith('.pptx')) {
    const zip = await JSZip.loadAsync(bytes);
    const names = Object.keys(zip.files);
    if (!names.includes('[Content_Types].xml') || names.length > 2000)
      throw new Error('Invalid presentation container');
    const slides = names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/u.test(n));
    pages = slides.length;
    if (!pages || pages > 80) throw new Error('Invalid slide count');
    for (const entry of [
      ...slides,
      ...names.filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/u.test(n)),
    ]) {
      const stream = zip.files[entry].nodeStream() as Readable;
      let xml = '';
      for await (const chunk of stream) {
        xml += String(chunk);
        if (xml.length > 2_000_000) {
          stream.destroy();
          throw new Error('Oversized XML part');
        }
      }
      content +=
        '\n' +
        [...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>|\bdescr="([^"]*)"/gu)]
          .map((m) => m[1] ?? m[2])
          .join(' ');
    }
  } else if (name.endsWith('.pdf')) {
    if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-')))
      throw new Error('Invalid PDF header');
    // pdf-parse's package entry runs an example file when loaded by Vite. The
    // pinned library entry avoids that side effect; do not import its demo CLI.
    // eslint-disable-next-line no-restricted-syntax, import/no-internal-modules
    const parse = require('pdf-parse/lib/pdf-parse.js') as (
      buffer: Buffer,
    ) => Promise<{ numpages: number; text: string }>;
    const result = await parse(bytes);
    pages = result.numpages;
    content = result.text;
    if (!Number.isSafeInteger(pages) || pages < 1 || pages > 80)
      throw new Error('Invalid PDF pages');
  } else throw new Error('Unsupported format');
  const after = await readFile(await confinedFile(workspace, name));
  if (sha256(bytes) !== sha256(after))
    throw new Error('Artifact changed during parse');
  return {
    name,
    sha256: sha256(bytes),
    bytes: bytes.length,
    pages,
    content,
    contentBasis:
      'PPT text/alt/notes or PDF extracted text; not visual fidelity approval',
  };
}
export async function collectArtifactEvidence(
  workspace: string,
  names: string[],
  journal: EvidenceJournal,
  revised = false,
): Promise<Observation[]> {
  const observations: Observation[] = [];
  const parsedHashes = new Map<string, string>();
  for (const name of names) {
    const check = name.endsWith('.pptx') ? 'ppt-content' : 'pdf-content';
    try {
      const parsed = await parseArtifact(workspace, name);
      parsedHashes.set(name, parsed.sha256);
      const evidence = await journal.add(`${name}.parse.json`, parsed);
      const terms = [
        'Overview',
        revised ? 'Progress revised' : 'Progress',
        'Next Steps',
      ];
      observations.push({
        check,
        passed:
          terms.every((t) => parsed.content.includes(t)) &&
          (!name.endsWith('.pptx') || parsed.pages === 3),
        evidence: [evidence],
      });
      if (name.endsWith('.pptx'))
        try {
          const preview = await buildLocalArtifactPreview(
            await confinedFile(workspace, name),
          );
          await journal.add('native-preview-result.json', {
            ...preview,
            slides: preview.slides.map((s) => ({
              ...s,
              dataUrl: undefined,
              dataHash: sha256(s.dataUrl),
            })),
          });
          // Actual production preview parser, NOT a window click or screenshot.
          // Intentionally no preview-click/preview-screenshot success observation.
        } catch (error) {
          await journal.add('native-preview-error.json', {
            error: String(error),
          });
        }
    } catch (error) {
      const evidence = await journal.add(`${name}.error.json`, {
        error: String(error),
      });
      observations.push({ check, passed: false, evidence: [evidence] });
    }
  }
  if (names.length > 1) {
    const current = await Promise.all(
      names.map(async (name) => {
        try {
          return {
            name,
            sha256: sha256(await readFile(await confinedFile(workspace, name))),
          };
        } catch {
          return { name, sha256: null };
        }
      }),
    );
    const evidence = await journal.add('current-artifact-hashes.json', {
      current,
      parsed: Object.fromEntries(parsedHashes),
    });
    observations.push({
      check: 'current-hashes',
      passed: current.every(
        (f) => !!f.sha256 && f.sha256 === parsedHashes.get(f.name),
      ),
      evidence: [evidence],
    });
    // Destroy COPIES in a controller-owned new directory, never user artifacts.
    const controls = path.join(journal.directory, 'corruption-controls');
    await mkdir(controls);
    const results = [];
    for (const name of names) {
      try {
        const bytes = await readFile(await confinedFile(workspace, name));
        await writeFile(
          path.join(controls, name),
          bytes.subarray(0, Math.min(bytes.length, 12)),
          { flag: 'wx' },
        );
        let rejected = false;
        try {
          await parseArtifact(controls, name);
        } catch {
          rejected = true;
        }
        results.push({ name, rejected, originalHash: sha256(bytes) });
      } catch {
        results.push({
          name,
          rejected: null,
          reason: 'No current file; corruption control unavailable',
        });
      }
    }
    const controlEvidence = await journal.add(
      'corruption-control.json',
      results,
    );
    observations.push({
      check: 'corruption-control',
      passed: results.some((r) => r.rejected === null)
        ? null
        : results.every((r) => r.rejected),
      evidence: [controlEvidence],
    });
  }
  return observations;
}
