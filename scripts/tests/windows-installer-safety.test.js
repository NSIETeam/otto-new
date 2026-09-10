import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');
const compiler = process.env.OTTO_NSIS_SAFETY_MAKENSIS;
const nsis = (value) => value.replaceAll('$', '$$').replaceAll('"', '$\\"');

function runtime(directory) {
  mkdirSync(path.join(directory, 'resources'), { recursive: true });
  writeFileSync(path.join(directory, 'Otto.exe'), 'synthetic application');
  writeFileSync(
    path.join(directory, 'Uninstall Otto.exe'),
    'synthetic, never executed',
  );
  writeFileSync(
    path.join(directory, 'resources/app.asar'),
    'synthetic archive',
  );
}

function nativeFixture({
  arrange,
  uninstall = false,
  changeAfterInit = false,
  useProfileRoot = false,
  executionTimeoutMs = 15_000,
}) {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'otto-nsis-safety-'));
  const target = path.join(fixture, 'Otto destination');
  const old = path.join(fixture, 'Otto old');
  mkdirSync(target);
  const options = {
    fixture,
    target,
    old,
    registered: '',
    command: '',
    hive: 'HKCU',
  };
  arrange?.(options);
  // This fixture substitutes ONLY the four fixed registry read outputs. It
  // neither reads nor writes Otto/user registry keys and never runs an actual
  // uninstaller. The production include contains no test override switch.
  const include = read('packages/desktop/build/installer-safety.nsh')
    .replace(
      'DetailPrint "[otto-install-safety] blocked: $OttoSafetyReason"',
      `FileOpen $9 "${nsis(path.join(fixture, 'blocked-reason.txt'))}" w\n  FileWrite $9 "$OttoSafetyReason"\n  FileClose $9\n  DetailPrint "[otto-install-safety] blocked: $OttoSafetyReason"`,
    )
    .replace(
      'ReadRegStr $OttoSafetyOldPath ${ROOT} "${INSTALL_REGISTRY_KEY}" "InstallLocation"',
      `StrCpy $OttoSafetyOldPath ""\n  \${If} "\${ROOT}" == "${options.hive}"\n    StrCpy $OttoSafetyOldPath "${nsis(options.registered)}"\n  \${EndIf}`,
    )
    .replace(
      'ReadRegStr $OttoSafetyOldCommand ${ROOT} "${UNINSTALL_REGISTRY_KEY}" "UninstallString"',
      `StrCpy $OttoSafetyOldCommand ""\n  \${If} "\${ROOT}" == "${options.hive}"\n    StrCpy $OttoSafetyOldCommand "${nsis(options.command)}"\n  \${EndIf}`,
    );
  expect(include).not.toContain('ReadRegStr');
  writeFileSync(path.join(fixture, 'safety.nsh'), include);
  const changed = changeAfterInit ? options.unsafe : options.target;
  const marker = path.join(fixture, 'main-section-reached.txt');
  const script = `Unicode true
Name "Otto safety NON-INSTALLING fixture"
OutFile "${nsis(path.join(fixture, 'fixture.exe'))}"
RequestExecutionLevel user
SilentInstall silent
!define APP_EXECUTABLE_FILENAME "Otto.exe"
!define UNINSTALL_FILENAME "Uninstall Otto.exe"
!define INSTALL_REGISTRY_KEY "Software\\OttoSafetyNonInstallingFixture"
!define UNINSTALL_REGISTRY_KEY "Software\\OttoSafetyNonInstallingFixture\\Uninstall"
${uninstall ? '!define BUILD_UNINSTALLER' : ''}
!include "${nsis(path.join(fixture, 'safety.nsh'))}"
!insertmacro customHeader
Function .onInit
  StrCpy $INSTDIR "${useProfileRoot ? '$PROFILE' : nsis(options.target)}"
  ${uninstall ? '' : '!insertmacro customInit'}
  ${!uninstall && changeAfterInit ? `StrCpy $INSTDIR "${nsis(changed)}"` : ''}
FunctionEnd
Section "main"
${uninstall ? `  WriteUninstaller "${nsis(path.join(fixture, 'fixture-uninstall.exe'))}"` : `  FileOpen $0 "${nsis(marker)}" w\n  FileWrite $0 "main only; no install/uninstall actions"\n  FileClose $0`}
SectionEnd
${uninstall ? `Function un.onInit\n  StrCpy $INSTDIR "${nsis(options.target)}"\n  !insertmacro customUnInit\nFunctionEnd\nSection "Uninstall"\n  ${changeAfterInit ? `StrCpy $INSTDIR "${nsis(changed)}"` : ''}\n  !insertmacro customUnInstall\n  FileOpen $0 "${nsis(marker)}" w\n  FileWrite $0 "uninstall marker only; no removal"\n  FileClose $0\nSectionEnd` : ''}
`;
  const scriptFile = path.join(fixture, 'fixture.nsi');
  writeFileSync(scriptFile, script);
  const compiled = spawnSync(
    compiler,
    ['/V3', '/INPUTCHARSET', 'UTF8', scriptFile],
    {
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
    },
  );
  writeFileSync(
    path.join(fixture, 'compile.log'),
    `${compiled.stdout}\n${compiled.stderr}`,
  );
  expect(
    compiled.status,
    `NSIS compile evidence: ${fixture}\n${compiled.stdout}\n${compiled.stderr}`,
  ).toBe(0);
  let executed = spawnSync(path.join(fixture, 'fixture.exe'), ['/S'], {
    encoding: 'utf8',
    timeout: executionTimeoutMs,
    windowsHide: true,
  });
  if (uninstall) {
    expect(executed.status).toBe(0);
    executed = spawnSync(
      path.join(fixture, 'fixture-uninstall.exe'),
      ['/S', `_?=${options.target}`],
      {
        encoding: 'utf8',
        timeout: 15_000,
        windowsHide: true,
        windowsVerbatimArguments: true,
      },
    );
  }
  const reason = existsSync(path.join(fixture, 'blocked-reason.txt'))
    ? readFileSync(path.join(fixture, 'blocked-reason.txt'), 'utf8')
    : null;
  writeFileSync(
    path.join(fixture, 'receipt.json'),
    JSON.stringify(
      {
        compiler,
        fixture,
        mode: uninstall ? 'uninstall' : 'install',
        exitCode: executed.status,
        signal: executed.signal,
        mainReached: existsSync(marker),
        reason,
        registryTransport: 'synthetic outputs; no registry IO',
        realInstallation: false,
        realUninstaller: false,
      },
      null,
      2,
    ),
  );
  expect(
    executed.error?.message,
    `NSIS execution evidence: ${fixture}`,
  ).toBeUndefined();
  return {
    ...options,
    exitCode: executed.status,
    mainReached: existsSync(marker),
    reason,
  };
}

describe('Windows installer directory preservation contract', () => {
  it('includes the guard without replacing the locked upstream installer', () => {
    const config = JSON.parse(read('packages/desktop/package.json')).build.nsis;
    expect(config.include).toBe('build/installer-safety.nsh');
    expect(config.script).toBeUndefined();
    expect(config.oneClick).toBe(false);
  });

  it('checks before old uninstall, including silent mode and changed target directories', () => {
    const upstream = read(
      'node_modules/app-builder-lib/templates/nsis/installer.nsi',
    );
    const guard = read('packages/desktop/build/installer-safety.nsh');
    expect(upstream.indexOf('!insertmacro customHeader')).toBeLessThan(
      upstream.indexOf('Section "install" INSTALL_SECTION_ID'),
    );
    expect(guard).toContain('!macro customInit');
    expect(guard).toContain('Section "-Otto directory safety"');
    expect(guard).toContain('SectionIn RO');
    expect(guard).toContain('!macro customUnInit');
    expect(guard).toContain('!macro customUnInstall');
    expect(guard).toContain('!insertmacro OttoSafetyCheckRegistry HKCU');
    expect(guard).toContain('!insertmacro OttoSafetyCheckRegistry HKLM');
    expect(guard).toContain('SetErrorLevel 73');
    expect(guard).not.toMatch(
      /^\s*(?:Delete|RMDir|Rename|WriteReg\w*|DeleteReg\w*)\s/m,
    );
  });
});

describe.skipIf(process.platform !== 'win32' || !compiler)(
  'actual NSIS guarded marker executables (not product installers)',
  () => {
    it('allows an empty new directory', () => {
      expect(nativeFixture({})).toMatchObject({
        exitCode: 0,
        mainReached: true,
      });
    });

    it('allows standard runtime files and debug.log in a dedicated directory', () => {
      const result = nativeFixture({
        arrange: ({ target }) => {
          runtime(target);
          mkdirSync(path.join(target, 'locales'));
          writeFileSync(path.join(target, 'locales/zh-CN.pak'), 'fixture');
          writeFileSync(
            path.join(target, 'debug.log'),
            'existing log preserved',
          );
        },
      });
      expect(result).toMatchObject({ exitCode: 0, mainReached: true });
      expect(readFileSync(path.join(result.target, 'debug.log'), 'utf8')).toBe(
        'existing log preserved',
      );
    });

    for (const hive of ['HKCU', 'HKLM']) {
      it(`allows a consistent dedicated old ${hive} installation at a different path`, () => {
        expect(
          nativeFixture({
            arrange: (options) => {
              runtime(options.old);
              options.registered = options.old;
              options.command = `"${path.join(options.old, 'Uninstall Otto.exe')}" /currentuser`;
              options.hive = hive;
            },
          }),
        ).toMatchObject({ exitCode: 0, mainReached: true, reason: null });
      });

      it(`protects a different old ${hive} directory before the main section`, () => {
        const result = nativeFixture({
          arrange: (options) => {
            runtime(options.old);
            mkdirSync(path.join(options.old, 'source-project'));
            writeFileSync(
              path.join(options.old, 'source-project/keep.txt'),
              'must survive',
            );
            options.registered = options.old;
            options.command = `"${path.join(options.old, 'Uninstall Otto.exe')}" /currentuser`;
            options.hive = hive;
          },
        });
        expect(result).toMatchObject({ exitCode: 73, mainReached: false });
        expect(result.reason).toContain('unknown directory');
        expect(
          readFileSync(
            path.join(result.old, 'source-project/keep.txt'),
            'utf8',
          ),
        ).toBe('must survive');
      });
    }

    for (const kind of ['file', 'directory', 'nested']) {
      it(`rejects a ${kind} repository marker without removing it`, () => {
        const result = nativeFixture({
          arrange: ({ target }) => {
            runtime(target);
            const marker =
              kind === 'nested'
                ? path.join(target, 'resources/.git')
                : path.join(target, '.git');
            if (kind === 'file') writeFileSync(marker, 'gitdir: ../worktree');
            else mkdirSync(marker);
          },
        });
        expect(result).toMatchObject({ exitCode: 73, mainReached: false });
        expect(
          existsSync(
            path.join(
              result.target,
              kind === 'nested' ? 'resources/.git' : '.git',
            ),
          ),
        ).toBe(true);
      });
    }

    it('rejects an unquoted old command rather than guessing', () => {
      expect(
        nativeFixture({
          arrange: (options) => {
            runtime(options.old);
            options.registered = options.old;
            options.command = `${path.join(options.old, 'Uninstall Otto.exe')} /currentuser`;
          },
        }),
      ).toMatchObject({
        exitCode: 73,
        mainReached: false,
        reason:
          'previous uninstall command is not an exact recognised Otto command',
      });
    });

    it('rejects residual registration without an uninstall command', () => {
      expect(
        nativeFixture({
          arrange: (options) => {
            options.registered = options.old;
          },
        }),
      ).toMatchObject({
        exitCode: 73,
        mainReached: false,
        reason: 'incomplete or ambiguous previous installation registration',
      });
    });

    it('rejects an old command whose parent differs from InstallLocation', () => {
      expect(
        nativeFixture({
          arrange: (options) => {
            runtime(options.old);
            options.registered = options.old;
            options.command = `"${path.join(options.target, 'Uninstall Otto.exe')}"`;
          },
        }),
      ).toMatchObject({
        exitCode: 73,
        mainReached: false,
        reason: 'previous uninstaller and installation directory disagree',
      });
    });

    for (const uninstall of [false, true]) {
      it(`rechecks a changed directory after ${uninstall ? 'uninstaller' : 'installer'} initialization`, () => {
        const result = nativeFixture({
          uninstall,
          changeAfterInit: true,
          arrange: (options) => {
            options.unsafe = path.join(
              options.fixture,
              'different destination',
            );
            mkdirSync(options.unsafe);
            writeFileSync(path.join(options.unsafe, 'keep.txt'), 'user-owned');
          },
        });
        expect(result).toMatchObject({ exitCode: 73, mainReached: false });
        expect(result.reason).toContain('unknown file');
        expect(readFileSync(path.join(result.unsafe, 'keep.txt'), 'utf8')).toBe(
          'user-owned',
        );
      });
    }

    it('rejects a redirected ancestor without following it into a source tree', () => {
      expect(
        nativeFixture({
          arrange: (options) => {
            const actual = path.join(options.fixture, 'actual');
            mkdirSync(actual);
            const redirect = path.join(options.fixture, 'redirect');
            symlinkSync(actual, redirect, 'junction');
            options.target = path.join(redirect, 'Otto');
          },
        }),
      ).toMatchObject({
        exitCode: 73,
        mainReached: false,
        reason:
          'installation path contains a redirect or non-directory ancestor',
      });
    });

    it('rejects a drive root without creating anything there', () => {
      expect(
        nativeFixture({
          arrange: (options) => {
            options.target = path.parse(options.fixture).root;
          },
        }),
      ).toMatchObject({ exitCode: 73, mainReached: false });
    });

    it('allows a Unicode and space containing new target', () => {
      expect(
        nativeFixture({
          arrange: (options) => {
            options.target = path.join(options.fixture, 'Otto 中文目录');
          },
        }),
      ).toMatchObject({ exitCode: 0, mainReached: true });
    });

    it('allows a newly generated non-destructive uninstaller fixture in a dedicated layout', () => {
      expect(
        nativeFixture({
          uninstall: true,
          arrange: ({ target }) => runtime(target),
        }),
      ).toMatchObject({ exitCode: 0, mainReached: true, reason: null });
    });

    it('rejects an extra source directory directly under resources even without git', () => {
      const result = nativeFixture({
        arrange: ({ target }) => {
          runtime(target);
          mkdirSync(path.join(target, 'resources/my-source'));
          writeFileSync(
            path.join(target, 'resources/my-source/main.js'),
            'keep this source',
          );
        },
      });
      expect(result).toMatchObject({ exitCode: 73, mainReached: false });
      expect(
        readFileSync(
          path.join(result.target, 'resources/my-source/main.js'),
          'utf8',
        ),
      ).toBe('keep this source');
    });

    it('fails closed at the bounded runtime depth limit', () => {
      expect(
        nativeFixture({
          arrange: ({ target }) => {
            runtime(target);
            mkdirSync(
              path.join(
                target,
                'resources/app.asar.unpacked',
                ...Array(33).fill('a'),
              ),
              { recursive: true },
            );
          },
        }),
      ).toMatchObject({
        exitCode: 73,
        mainReached: false,
        reason: 'runtime directory inspection limit exceeded',
      });
    });

    it('fails closed at the bounded runtime entry limit', () => {
      expect(
        nativeFixture({
          // The unchanged 8193-file scan measured ~21s on a busy Windows host.
          // Only this stress fixture gets extra time; rejection stays required.
          executionTimeoutMs: 45_000,
          arrange: ({ target }) => {
            runtime(target);
            const directory = path.join(target, 'resources/app.asar.unpacked');
            mkdirSync(directory);
            for (let index = 0; index < 8193; index++)
              writeFileSync(path.join(directory, `file-${index}.js`), '');
          },
        }),
      ).toMatchObject({
        exitCode: 73,
        mainReached: false,
        reason: 'runtime directory inspection limit exceeded',
      });
    }, 60_000);

    it('rejects a redirect within a recognised runtime subtree', () => {
      expect(
        nativeFixture({
          arrange: ({ target, fixture }) => {
            runtime(target);
            const actual = path.join(fixture, 'external');
            mkdirSync(actual);
            const unpacked = path.join(target, 'resources/app.asar.unpacked');
            mkdirSync(unpacked);
            symlinkSync(actual, path.join(unpacked, 'redirect'), 'junction');
          },
        }),
      ).toMatchObject({
        exitCode: 73,
        mainReached: false,
        reason: 'runtime entry is inaccessible or redirected',
      });
    });

    it('rejects the current profile root before enumerating its files', () => {
      expect(
        nativeFixture({
          // NSIS resolves the executing Windows token, not inherited HOME.
          useProfileRoot: true,
        }),
      ).toMatchObject({
        exitCode: 73,
        mainReached: false,
        reason:
          'a system, profile or shared storage root is not a dedicated application directory',
      });
    });
  },
);
