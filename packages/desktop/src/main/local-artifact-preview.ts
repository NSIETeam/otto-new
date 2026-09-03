/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface LocalArtifactPreviewSlide {
  number: number;
  fileName: string;
  dataUrl: string;
}

export interface LocalArtifactPreviewResult {
  ok: boolean;
  kind: 'slides' | 'unsupported';
  fileName: string;
  mimeType: string;
  slides: LocalArtifactPreviewSlide[];
  error?: string;
  notice?: string;
}

const PRESENTATION_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const PREVIEW_DIRECTORIES = [
  'shots',
  'slides',
  'previews',
  'preview',
  'thumbs',
];
const IMAGE_MIME: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};
const MAX_SLIDES = 80;
const MAX_SLIDE_BYTES = 12 * 1024 * 1024;
const MAX_TOTAL_BYTES = 80 * 1024 * 1024;

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  );
}

function unsupported(
  filePath: string,
  error: string,
): LocalArtifactPreviewResult {
  return {
    ok: false,
    kind: 'unsupported',
    fileName: path.basename(filePath),
    mimeType: 'application/octet-stream',
    slides: [],
    error,
  };
}

/**
 * Read the slide PNG/JPEG files emitted beside an Otto-generated PPTX.
 * The directory is realpath-checked so a `shots` symlink cannot escape the
 * presentation's own output directory. No HTML or script is executed.
 */
export async function buildLocalArtifactPreview(
  filePath: string,
): Promise<LocalArtifactPreviewResult> {
  const extension = path.extname(filePath).toLowerCase();
  if (extension !== '.pptx' && extension !== '.ppt') {
    return unsupported(filePath, '该文件暂不支持在 Otto 内预览。');
  }

  let presentationPath: string;
  try {
    presentationPath = await fs.promises.realpath(filePath);
  } catch {
    return unsupported(filePath, 'PPT 文件不存在或不可读取。');
  }
  const outputRoot = path.dirname(presentationPath);

  const siblings = await fs.promises.readdir(outputRoot);
  const hasSingleDeck =
    siblings.filter((name) => /\.pptx?$/iu.test(name)).length === 1;

  for (const directoryName of PREVIEW_DIRECTORIES) {
    if (!hasSingleDeck) break; // Unbound sidecars must not preview another deck.
    let previewDirectory: string;
    try {
      previewDirectory = await fs.promises.realpath(
        path.join(outputRoot, directoryName),
      );
    } catch {
      continue;
    }
    if (!isInside(outputRoot, previewDirectory)) continue;

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(previewDirectory, {
        withFileTypes: true,
      });
    } catch {
      continue;
    }
    const imageEntries = entries
      .filter(
        (entry) =>
          entry.isFile() && IMAGE_MIME[path.extname(entry.name).toLowerCase()],
      )
      .sort((left, right) =>
        left.name.localeCompare(right.name, undefined, {
          numeric: true,
          sensitivity: 'base',
        }),
      )
      .slice(0, MAX_SLIDES);
    if (imageEntries.length === 0) continue;

    const slides: LocalArtifactPreviewSlide[] = [];
    let totalBytes = 0;
    for (const entry of imageEntries) {
      const slidePath = path.join(previewDirectory, entry.name);
      let stat: fs.Stats;
      try {
        if (!isInside(previewDirectory, await fs.promises.realpath(slidePath)))
          continue;
        stat = await fs.promises.stat(slidePath);
      } catch {
        continue;
      }
      if (
        !stat.isFile() ||
        stat.size <= 0 ||
        stat.size > MAX_SLIDE_BYTES ||
        totalBytes + stat.size > MAX_TOTAL_BYTES
      ) {
        continue;
      }
      const data = await fs.promises.readFile(slidePath);
      totalBytes += data.byteLength;
      const imageMime = IMAGE_MIME[path.extname(entry.name).toLowerCase()]!;
      slides.push({
        number: slides.length + 1,
        fileName: entry.name,
        dataUrl: `data:${imageMime};base64,${data.toString('base64')}`,
      });
    }
    if (slides.length > 0) {
      return {
        ok: true,
        kind: 'slides',
        fileName: path.basename(presentationPath),
        mimeType:
          extension === '.pptx'
            ? PRESENTATION_MIME
            : 'application/vnd.ms-powerpoint',
        slides,
      };
    }
  }

  if (extension === '.pptx') {
    try {
      const stat = await fs.promises.stat(presentationPath);
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024)
        throw new Error('size limit');
      const { renderPptxContent } = await import('./pptx-content-preview.js');
      const slides = await renderPptxContent(
        await fs.promises.readFile(presentationPath),
      );
      return {
        ok: true,
        kind: 'slides',
        fileName: path.basename(presentationPath),
        mimeType: PRESENTATION_MIME,
        slides,
        notice:
          '内容预览：直接读取 PPTX 中的文字和静态图片；版式、字体、图表和动画不保证与原稿一致。文件未上传，也未启动其他应用。',
      };
    } catch {
      return unsupported(
        presentationPath,
        '无法读取这份 PPTX：文件可能损坏、加密或超出安全预览上限（32 MB、80 页）。你仍可主动选择其他应用打开。',
      );
    }
  }

  return unsupported(
    presentationPath,
    '没有找到逐页预览图。PPT 仍可在文件夹中查看，或由你主动选择其他应用打开。',
  );
}
