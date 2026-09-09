/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import {
  openSync,
  fstatSync,
  readSync,
  closeSync,
  realpathSync,
  lstatSync,
} from 'node:fs';
import path from 'node:path';
import { ToolCallStatus, type ToolCall } from './protocol.js';
import { WorkspacePathIdentity } from './workspacePathIdentity.js';
import {
  verificationKind,
  hasFailedVerificationReceipt,
  hasSuccessfulProcessReceipt,
} from './verificationEvidence.js';

export interface RepairContext {
  workspacePath?: string;
  requestRevision: number;
  /** Host digest of acceptance definitions, excluding changing evidence IDs. */
  acceptanceKey: string;
}
export interface RepairBudget {
  version: 1;
  batches: number;
  comparisons: number;
  formats: number;
}
export function validateRepairBudget(value: unknown): RepairBudget {
  const b = object(value);
  if (
    b.version !== 1 ||
    !['batches', 'comparisons', 'formats'].every(
      (key) => Number.isSafeInteger(b[key]) && Number(b[key]) >= 0,
    ) ||
    Number(b.batches) > 2 ||
    Number(b.comparisons) > 6 ||
    Number(b.formats) > 8
  )
    throw new Error('Invalid repair budget');
  return {
    version: 1,
    batches: Number(b.batches),
    comparisons: Number(b.comparisons),
    formats: Number(b.formats),
  };
}
export interface RepairComparison {
  selectedId?: string;
  failedToolCallId: string;
  acceptanceKey: string;
  requestRevision: number;
  alternatives: Array<{
    id: string;
    eligible: boolean;
    reason: string;
    fileCount: number;
    addedTests: number;
    estimatedBytes: number;
    risk: number;
  }>;
  requiresReverification: true;
  remainingBatches: number;
}
const MAX_FILE = 2_000_000;
const MAX_BATCHES = 2;
const normalize = (file: string) =>
  process.platform === 'win32' ? file.toLowerCase() : file;
function fileState(
  file: string,
  allowAbsent = false,
): { hash: string; data: Buffer } | undefined {
  let fd: number | undefined;
  try {
    if (!path.isAbsolute(file) || /[\0]|^\\\\|^\/\//u.test(file)) return;
    let absent = false;
    for (let p = file; ; p = path.dirname(p)) {
      try {
        const s = lstatSync(p, { bigint: true });
        if (
          s.isSymbolicLink() ||
          (s.isFile() && s.nlink > 1n) ||
          normalize(realpathSync(p)) !== normalize(p)
        )
          return;
      } catch (error) {
        // lstat observes dangling links; only a truly absent final file may be
        // proposed as a new regression. Missing/linked parents are never scope.
        if (
          (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
          p !== file ||
          !allowAbsent
        )
          return;
        absent = true;
      }
      if (p === path.dirname(p)) break;
    }
    if (absent) return { hash: 'absent', data: Buffer.alloc(0) };
    const before = lstatSync(file, { bigint: true });
    fd = openSync(file, 'r');
    const stat = fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      !stat.isFile() ||
      stat.dev !== before.dev ||
      stat.ino !== before.ino ||
      stat.nlink > 1n ||
      stat.size > BigInt(MAX_FILE)
    )
      return;
    const buffer = Buffer.alloc(MAX_FILE + 1);
    let size = 0;
    let count = 0;
    do {
      count = readSync(fd, buffer, size, buffer.length - size, null);
      size += count;
    } while (count && size < buffer.length);
    const after = lstatSync(file, { bigint: true });
    if (
      size > MAX_FILE ||
      !after.isFile() ||
      after.nlink > 1n ||
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.size !== stat.size ||
      after.mtimeNs !== stat.mtimeNs ||
      after.ctimeNs !== stat.ctimeNs
    )
      return;
    const data = buffer.subarray(0, size);
    return {
      data,
      hash: `${stat.dev}:${stat.ino}:${createHash('sha256').update(data).digest('hex')}`,
    };
  } catch {
    return;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    !!relative &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
function sourceFile(file: string): boolean {
  return (
    !file
      .split(/[\\/]/u)
      .some(
        (p) =>
          p.startsWith('.') ||
          /^(?:node_modules|dist|build|vendor|coverage)$/iu.test(p),
      ) &&
    !/^(?:package(?:-lock)?|tsconfig|credentials|secrets|settings)\.json$/iu.test(
      path.basename(file),
    ) &&
    /\.(?:[cm]?[jt]sx?|py|rs|go|css|scss|html|json)$/iu.test(file)
  );
}
function acceptanceTest(file: string): boolean {
  return /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|[\\/])test_[^\\/]+\.py$|_test\.(?:py|go)$)/iu.test(
    file,
  );
}
function pairedTest(source: string, test: string): boolean {
  const stem = path.basename(source).replace(/\.[^.]+$/u, '');
  const dir = path.dirname(source);
  const name = path.basename(test);
  return (
    [dir, path.join(dir, '__tests__'), path.join(dir, 'tests')].includes(
      path.dirname(test),
    ) &&
    (['ts', 'tsx', 'js', 'jsx', 'mts', 'mjs', 'cts', 'cjs'].some(
      (ext) => name === `${stem}.test.${ext}` || name === `${stem}.spec.${ext}`,
    ) ||
      name === `test_${stem}.py`)
  );
}
function imports(source: string, candidate: string): boolean {
  const state = fileState(source);
  if (!state) return false;
  const refs = [
    ...state.data
      .toString('utf8')
      .matchAll(
        /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|"\$ref"\s*:\s*)["'](\.[^"'\r\n]+)["']/gu,
      ),
  ];
  return refs.some((m) => {
    const base = normalize(path.resolve(path.dirname(source), m[1]));
    return [
      base,
      ...['.ts', '.tsx', '.js', '.jsx', '.json'].map(
        (ext) => base.replace(/\.[cm]?js$/u, '') + ext,
      ),
      path.join(base, 'index.ts'),
    ].includes(candidate);
  });
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid repair proposal');
  return value as Record<string, unknown>;
}

/** Additional restriction, NOT authority. Two repair batches, fresh native file
 * versions, four files per batch. Policy/confirmation/constraints still run. No
 * shell repairs, dependency installation, automatic rollback or external replay. */
export class DeliveryRepairGuard {
  private context: RepairContext;
  private workspaceIdentity?: WorkspacePathIdentity;
  private touched = new Set<string>();
  private inspected = new Set<string>();
  private reads = new Map<string, string>();
  private failure?: {
    id: string;
    inputs: Set<string>;
    command: string;
    directory: string;
  };
  private protectedTests = new Set<string>();
  private fastPathConsumed = false;
  private attempts = 0;
  private comparisons = 0;
  private generation = 0;
  private seen = new Set<string>();
  private reserved = new Map<
    string,
    { file: string; hash: string; generation: number; callHash: string }
  >();
  private selected?: Map<string, { hash: string; writes: number }>;
  private formats = 0;
  constructor(
    context: RepairContext = {
      requestRevision: 1,
      acceptanceKey: 'legacy-local',
    },
  ) {
    this.context = { ...context };
    if (context.workspacePath)
      this.workspaceIdentity = new WorkspacePathIdentity(context.workspacePath);
  }

  private root(): string | undefined {
    const root = this.workspaceIdentity?.currentPath();
    return root && normalize(root);
  }
  private resolveFile(raw: unknown): string | undefined {
    if (
      typeof raw !== 'string' ||
      !path.isAbsolute(raw) ||
      /[\0]|^\\\\|^\/\//u.test(raw) ||
      raw.split(/[\\/]/u).includes('..')
    )
      return;
    try {
      // Only the host-selected root can supply an alias mapping. Descendants
      // remain lexical and must pass the no-link checks in fileState.
      return normalize(
        this.workspaceIdentity
          ? this.workspaceIdentity.resolveTarget(raw)
          : path.resolve(raw),
      );
    } catch {
      return;
    }
  }
  private target(tool: ToolCall): string | undefined {
    return this.resolveFile(
      tool.parameters.file_path ??
        tool.parameters.path ??
        tool.parameters.absolute_path,
    );
  }
  private fileState(file: string, allowAbsent = false) {
    if (this.workspaceIdentity && !this.root()) return;
    const state = fileState(file, allowAbsent);
    if (this.workspaceIdentity && !this.root()) return;
    return state;
  }

  budgetSnapshot(): RepairBudget {
    return {
      version: 1,
      batches: this.attempts,
      comparisons: this.comparisons,
      formats: this.formats,
    };
  }
  restoreBudget(value: unknown): void {
    const b = validateRepairBudget(value);
    this.attempts = Math.max(this.attempts, b.batches);
    this.comparisons = Math.max(this.comparisons, b.comparisons);
    this.formats = Math.max(this.formats, b.formats);
    this.generation++;
    this.failure = undefined;
    this.selected = undefined;
    this.reads.clear();
  }

  revise(context: RepairContext): void {
    if (JSON.stringify(this.context) === JSON.stringify(context)) return;
    const authorityChanged =
      this.context.requestRevision !== context.requestRevision ||
      this.context.workspacePath !== context.workspacePath;
    if (this.context.workspacePath !== context.workspacePath)
      this.workspaceIdentity = context.workspacePath
        ? new WorkspacePathIdentity(context.workspacePath)
        : undefined;
    this.context = { ...context };
    this.generation++;
    this.selected = undefined;
    this.reads.clear();
    this.failure = undefined;
    if (authorityChanged) {
      this.touched.clear();
      this.inspected.clear();
    }
  }
  observe(tool: ToolCall, closing: boolean, inputPaths: string[] = []): void {
    if (this.seen.has(tool.id)) return;
    this.seen.add(tool.id);
    const receipt = tool.result?.process;
    if (hasFailedVerificationReceipt(tool) && receipt) {
      this.fastPathConsumed = false;
      this.failure = {
        id: tool.id,
        inputs: new Set(
          inputPaths
            .map((p) => this.resolveFile(p))
            .filter((p): p is string => p !== undefined),
        ),
        command: receipt.command,
        directory: receipt.directory,
      };
      for (const file of this.failure.inputs)
        if (acceptanceTest(file)) this.protectedTests.add(file);
      this.reads.clear();
      this.selected = undefined;
      this.generation++;
      return;
    }
    if (
      this.failure &&
      verificationKind(tool) &&
      hasSuccessfulProcessReceipt(tool) &&
      receipt?.command === this.failure.command &&
      receipt.directory === this.failure.directory &&
      (tool.parameters.directory === undefined ||
        tool.parameters.directory === receipt.directory)
    ) {
      this.failure = undefined;
      this.selected = undefined;
      this.reads.clear();
      this.generation++;
      return;
    }
    if (tool.status !== ToolCallStatus.Success || tool.result?.success !== true)
      return;
    const file = this.target(tool);
    if (!file) return;
    if (['write_file', 'replace'].includes(tool.toolName)) {
      const state = this.fileState(file);
      if (!closing && state && this.touched.size < 128) this.touched.add(file);
      this.reads.delete(file);
      const selected = this.selected?.get(file);
      if (selected && state) selected.hash = state.hash;
    } else if (tool.toolName === 'read_file') {
      if (this.inspected.size < 256) this.inspected.add(file);
      if (this.failure || this.selected) {
        const state = this.fileState(file);
        if (state) this.reads.set(file, state.hash);
      }
    }
  }
  private eligible(file: string): { hash: string; data: Buffer } | undefined {
    const root = this.root();
    if (!root || !within(root, file) || !sourceFile(path.relative(root, file)))
      return;
    if (this.protectedTests.has(file)) return;
    const state = this.fileState(file, true);
    if (!state) return;
    const anchors = [...this.touched].filter(
      (p) => within(root, p) && !!this.fileState(p),
    );
    if (state.hash === 'absent') {
      // A failing, freshly read direct dependency is already eligible for local
      // repair. Its named regression should not require first editing that file
      // merely to turn it into a "touched" anchor. No recursive scope growth.
      const related = [...(this.failure?.inputs ?? [])].filter((p) => {
        if (
          !within(root, p) ||
          !sourceFile(path.relative(root, p)) ||
          !this.inspected.has(p)
        )
          return false;
        const current = this.fileState(p);
        return (
          current &&
          this.reads.get(p) === current.hash &&
          anchors.some((a) => imports(a, p) || imports(p, a))
        );
      });
      return [...anchors, ...related].some((p) => pairedTest(p, file))
        ? state
        : undefined;
    }
    if (this.reads.get(file) !== state.hash) return;
    if (this.touched.has(file)) return state;
    if (!this.inspected.has(file) || !this.failure?.inputs.has(file)) return;
    return anchors.some(
      (p) => imports(p, file) || imports(file, p) || pairedTest(p, file),
    )
      ? state
      : undefined;
  }
  compare(
    value: unknown,
    current: RepairContext,
    capabilities: readonly string[] = ['read_file', 'replace', 'write_file'],
  ): RepairComparison {
    const proposal = object(value);
    if (
      proposal.requestRevision !== this.context.requestRevision ||
      JSON.stringify(current) !== JSON.stringify(this.context)
    )
      throw new Error('Repair request revision or acceptance changed');
    if (
      !this.failure ||
      this.selected ||
      this.fastPathConsumed ||
      this.attempts >= MAX_BATCHES ||
      this.comparisons >= 6
    )
      throw new Error(
        'Repair batch needs a new native failure and remaining budget',
      );
    if (proposal.failedToolCallId !== this.failure.id)
      throw new Error('Repair must reference the current failed native check');
    if (
      !Array.isArray(proposal.alternatives) ||
      proposal.alternatives.length < 1 ||
      proposal.alternatives.length > 3
    )
      throw new Error('Compare one to three concrete alternatives');
    if (
      Object.keys(proposal).some(
        (k) =>
          !['requestRevision', 'failedToolCallId', 'alternatives'].includes(k),
      )
    )
      throw new Error('Repair cannot change acceptance or authority');
    const candidates = proposal.alternatives.map((raw) => {
      const item = object(raw);
      if (
        Object.keys(item).some((k) => !['id', 'reason', 'files'].includes(k)) ||
        typeof item.id !== 'string' ||
        !/^[\w-]{1,64}$/u.test(item.id) ||
        typeof item.reason !== 'string' ||
        !item.reason.trim() ||
        item.reason.length > 1000 ||
        !Array.isArray(item.files) ||
        !item.files.length ||
        item.files.length > 4
      )
        throw new Error('Invalid bounded repair alternative');
      const files = item.files.map((p) => {
        if (typeof p !== 'string' || p.length > 1000 || !path.isAbsolute(p))
          throw new Error('Repair requires exact absolute files');
        const file = this.resolveFile(p);
        if (!file)
          throw new Error(
            'Repair requires a safe file and stable workspace identity',
          );
        return file;
      });
      if (new Set(files).size !== files.length)
        throw new Error('Duplicate repair file');
      const states = files.map((file) => this.eligible(file));
      const capable = states.every((s) =>
        s?.hash === 'absent'
          ? capabilities.includes('write_file')
          : capabilities.includes('write_file') ||
            capabilities.includes('replace'),
      );
      const eligible = states.every(Boolean) && capable;
      const addedTests = states.filter((s) => s?.hash === 'absent').length;
      return {
        id: item.id,
        files,
        states,
        eligible,
        reason: files.some((file) => this.protectedTests.has(file))
          ? 'Existing observed acceptance tests are read-only during automatic repair; fix implementation or add a separate regression'
          : !capable
            ? 'Required write capability is unavailable; no automatic installation'
            : eligible
              ? 'Fresh, related native scope; original acceptance retained'
              : 'Missing fresh read, linked/unsafe file, or outside the observed repair scope',
        fileCount: files.length,
        addedTests,
        estimatedBytes: states.reduce(
          (sum, s) => sum + (s?.data.length ?? 0),
          0,
        ),
        risk: files.filter((p) => !this.touched.has(p)).length * 2 + addedTests,
      };
    });
    if (new Set(candidates.map((c) => c.id)).size !== candidates.length)
      throw new Error('Duplicate strategy ID');
    this.comparisons++;
    const selected = candidates
      .filter((c) => c.eligible)
      .sort(
        (a, b) =>
          a.risk - b.risk ||
          a.fileCount - b.fileCount ||
          a.estimatedBytes - b.estimatedBytes ||
          a.id.localeCompare(b.id),
      )[0];
    if (selected) {
      this.attempts++;
      this.selected = new Map(
        selected.files.map((file, i) => [
          file,
          { hash: selected.states[i]!.hash, writes: 0 },
        ]),
      );
    }
    return {
      ...(selected ? { selectedId: selected.id } : {}),
      failedToolCallId: this.failure.id,
      acceptanceKey: this.context.acceptanceKey,
      requestRevision: this.context.requestRevision,
      alternatives: candidates.map(
        ({
          id,
          eligible,
          reason,
          fileCount,
          addedTests,
          estimatedBytes,
          risk,
        }) => ({
          id,
          eligible,
          reason,
          fileCount,
          addedTests,
          estimatedBytes,
          risk,
        }),
      ),
      requiresReverification: true,
      remainingBatches: MAX_BATCHES - this.attempts,
    };
  }
  reserve(tool: ToolCall): boolean {
    if (!['write_file', 'replace'].includes(tool.toolName)) return false;
    const file = this.target(tool);
    if (!file) return false;
    const root = this.root();
    // The fast path is not a bypass of the explicit plan's scope restrictions.
    if (
      this.protectedTests.has(file) ||
      !sourceFile(root ? path.relative(root, file) : file) ||
      (this.workspaceIdentity && (!root || !within(root, file)))
    )
      return false;
    const state = this.fileState(file, true);
    if (!state) return false;
    for (const key of ['content', 'new_string'])
      if (
        typeof tool.parameters[key] === 'string' &&
        Buffer.byteLength(tool.parameters[key] as string) > MAX_FILE
      )
        return false;
    if (
      tool.toolName === 'replace' &&
      typeof tool.parameters.old_string === 'string' &&
      tool.parameters.old_string &&
      typeof tool.parameters.new_string === 'string'
    ) {
      const delta =
        Buffer.byteLength(tool.parameters.new_string) -
        Buffer.byteLength(tool.parameters.old_string);
      const count =
        state.data.toString('utf8').split(tool.parameters.old_string).length -
        1;
      if (state.data.length + count * delta > MAX_FILE) return false;
    }
    const selected = this.selected?.get(file);
    if (this.selected) {
      if (
        !selected ||
        selected.writes >= 2 ||
        selected.hash !== state.hash ||
        (state.hash !== 'absent' && this.reads.get(file) !== state.hash) ||
        (state.hash === 'absent' && tool.toolName !== 'write_file')
      )
        return false;
      selected.writes++;
    } else {
      if (
        !this.failure ||
        this.fastPathConsumed ||
        this.attempts >= MAX_BATCHES ||
        !this.touched.has(file) ||
        this.reads.get(file) !== state.hash
      )
        return false;
      this.attempts++;
      // Keep the failed scope until revalidation so a passing receipt can
      // revoke pending approvals; it cannot fund a second repair by itself.
      this.fastPathConsumed = true;
    }
    this.reserved.set(tool.id, {
      file,
      hash: state.hash,
      generation: this.generation,
      callHash: createHash('sha256')
        .update(JSON.stringify([tool.toolName, tool.parameters]))
        .digest('hex'),
    });
    this.reads.delete(file);
    return true;
  }
  validateReserved(
    callId: string,
    call?: { name: string; args: Record<string, unknown> },
  ): boolean {
    const reservation = this.reserved.get(callId);
    return (
      !reservation ||
      (reservation.generation === this.generation &&
        this.fileState(reservation.file, true)?.hash === reservation.hash &&
        (!call ||
          reservation.callHash ===
            createHash('sha256')
              .update(JSON.stringify([call.name, call.args]))
              .digest('hex')))
    );
  }
  async prepareFormat(raw: string): Promise<{
    content: string;
    sourceFingerprint: string;
    written: false;
    formatter: string;
  }> {
    const file = this.resolveFile(raw) ?? '';
    const selected = this.selected?.get(file);
    const state = this.fileState(file);
    if (
      !selected ||
      !state ||
      state.data.length > 256_000 ||
      state.hash !== selected.hash ||
      state.hash !== this.reads.get(file) ||
      this.formats >= 8
    )
      throw new Error(
        'Formatting requires a fresh selected repair file (maximum 256 KB) and budget',
      );
    const parser = (
      {
        '.ts': 'typescript',
        '.tsx': 'typescript',
        '.js': 'babel',
        '.jsx': 'babel',
        '.mjs': 'babel',
        '.cjs': 'babel',
        '.json': 'json',
        '.css': 'css',
        '.scss': 'scss',
        '.html': 'html',
      } as Record<string, string>
    )[path.extname(file)];
    if (!parser) throw new Error('No bundled formatter for this file type');
    this.formats++;
    const generation = this.generation;
    const { format, version } = await import('prettier');
    const content = await format(state.data.toString('utf8'), {
      parser,
      plugins: [],
      endOfLine: 'lf',
    });
    if (
      generation !== this.generation ||
      this.fileState(file)?.hash !== state.hash ||
      Buffer.byteLength(content) > MAX_FILE
    )
      throw new Error('Formatting became stale; reread the file');
    return {
      content,
      sourceFingerprint: state.hash,
      written: false,
      formatter: `prettier@${version}`,
    };
  }
}
