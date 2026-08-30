/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  DesktopAccessibilitySnapshot,
  DesktopRpaPortV1,
} from './desktop-driver.js';
import type { DesktopRpaTargetV1 } from './contracts.js';

const execFileAsync = promisify(execFile);
const APP_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{2,199}$/u;
const ROLE_MAP: Readonly<Record<string, string>> = {
  button: 'AXButton',
  checkbox: 'AXCheckBox',
  'text-field': 'AXTextField',
  textbox: 'AXTextField',
  'text-area': 'AXTextArea',
  'pop-up-button': 'AXPopUpButton',
  menuitem: 'AXMenuItem',
  link: 'AXLink',
  row: 'AXRow',
  tab: 'AXRadioButton',
  window: 'AXWindow',
};

export interface MacOsAccessibilityPortOptions {
  authorizeApp(input: {
    appId: string;
    action: 'inspect' | 'interact';
  }): boolean | Promise<boolean>;
  runAppleScript?: (script: string, args: readonly string[]) => Promise<string>;
  platform?: NodeJS.Platform;
}

const FIND_ELEMENT_HANDLER = String.raw`
on findElement(targetProcess, wantedRole, wantedName, wantedWindow)
  tell application "System Events"
    tell targetProcess
      repeat with candidateWindow in windows
        try
          set candidateTitle to name of candidateWindow as text
        on error
          set candidateTitle to ""
        end try
        if wantedWindow is "" or candidateTitle is wantedWindow then
          set candidates to entire contents of candidateWindow
          repeat with candidate in candidates
            try
              set candidateRole to role of candidate as text
              set candidateName to name of candidate as text
              if candidateRole is wantedRole and candidateName is wantedName then return candidate
            end try
          end repeat
        end if
      end repeat
    end tell
  end tell
  error "semantic accessibility element was not found"
end findElement
`;

const ACTION_SCRIPT = `${FIND_ELEMENT_HANDLER}
on run argv
  set bundleId to item 1 of argv
  set operation to item 2 of argv
  set wantedRole to item 3 of argv
  set wantedName to item 4 of argv
  set wantedWindow to item 5 of argv
  set suppliedValue to item 6 of argv
  tell application "System Events"
    if UI elements enabled is false then error "accessibility permission is not granted"
    set targetProcess to first application process whose bundle identifier is bundleId
    set frontmost of targetProcess to true
  end tell
  set targetElement to findElement(targetProcess, wantedRole, wantedName, wantedWindow)
  tell application "System Events"
    if operation is "click" then
      perform action "AXPress" of targetElement
    else if operation is "fill" then
      if wantedRole is not "AXTextField" and wantedRole is not "AXTextArea" then error "fill requires a text field"
      set value of targetElement to suppliedValue
    else if operation is "select" then
      perform action "AXPress" of targetElement
      delay 0.1
      set optionElement to findElement(targetProcess, "AXMenuItem", suppliedValue, wantedWindow)
      perform action "AXPress" of optionElement
    else if operation is "scroll-up" then
      perform action "AXScrollUp" of targetElement
    else if operation is "scroll-down" then
      perform action "AXScrollDown" of targetElement
    end if
  end tell
  return "ok"
end run`;

const INSPECT_SCRIPT = String.raw`
on safeText(valueToRead)
  try
    return valueToRead as text
  on error
    return ""
  end try
end safeText

on run argv
  set bundleId to item 1 of argv
  tell application "System Events"
    if UI elements enabled is false then error "accessibility permission is not granted"
    set targetProcess to first application process whose bundle identifier is bundleId
    set frontmost of targetProcess to true
    tell targetProcess
      if (count of windows) is 0 then error "application has no accessible window"
      set targetWindow to front window
      set windowTitle to my safeText(name of targetWindow)
      set outputLines to {}
      set itemCount to 0
      repeat with candidate in entire contents of targetWindow
        if itemCount is greater than or equal to 200 then exit repeat
        try
          set candidateRole to my safeText(role of candidate)
          set candidateName to my safeText(name of candidate)
          if candidateName is not "" and candidateRole is not "AXSecureTextField" then
            set end of outputLines to candidateRole & tab & candidateName
            set itemCount to itemCount + 1
          end if
        end try
      end repeat
      set AppleScript's text item delimiters to linefeed
      return windowTitle & linefeed & (outputLines as text)
    end tell
  end tell
end run`;

function normalizeAppId(appId: string): string {
  const clean = appId.trim();
  if (!APP_ID.test(clean)) throw new Error('Desktop RPA appId must be a bundle identifier.');
  return clean;
}

function normalizeTarget(target: DesktopRpaTargetV1): { role: string; name: string; windowTitle: string } {
  const normalized = target.role.trim().toLowerCase().replaceAll('_', '-');
  const role = ROLE_MAP[normalized];
  if (!role) throw new Error(`Desktop RPA accessibility role is unsupported: ${target.role}`);
  const name = target.name.trim();
  if (!name || name.length > 300) throw new Error('Desktop RPA accessible name is invalid.');
  if (role === 'AXSecureTextField' || /(password|passcode|密码|口令|验证码|token|secret)/iu.test(name)) {
    throw new Error('Desktop RPA cannot access credential fields.');
  }
  return { role, name, windowTitle: target.windowTitle?.trim().slice(0, 300) ?? '' };
}

export class MacOsAccessibilityPortV1 implements DesktopRpaPortV1 {
  private readonly runScript: (script: string, args: readonly string[]) => Promise<string>;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly options: MacOsAccessibilityPortOptions) {
    this.platform = options.platform ?? process.platform;
    this.runScript = options.runAppleScript ?? (async (script, args) => {
      const result = await execFileAsync('/usr/bin/osascript', ['-e', script, '--', ...args], {
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      });
      return result.stdout;
    });
  }

  async inspect(appId: string): Promise<DesktopAccessibilitySnapshot> {
    const safeAppId = await this.authorize(appId, 'inspect');
    const output = await this.runScript(INSPECT_SCRIPT, [safeAppId]);
    const [windowTitle = '', ...lines] = output.trim().split(/\r?\n/u);
    return {
      appId: safeAppId,
      windowTitle,
      redactedTree: lines.slice(0, 200).map((line) => {
        const [role = '', name = ''] = line.split('\t', 2);
        return { role, name };
      }),
    };
  }

  click(input: { appId: string; target: DesktopRpaTargetV1; idempotencyKey: string }): Promise<unknown> {
    return this.action('click', input.appId, input.target, '');
  }

  fill(input: { appId: string; target: DesktopRpaTargetV1; value: string; idempotencyKey: string }): Promise<unknown> {
    if (input.value.length > 20_000) throw new Error('Desktop RPA fill value is too large.');
    return this.action('fill', input.appId, input.target, input.value);
  }

  select(input: { appId: string; target: DesktopRpaTargetV1; option: string; idempotencyKey: string }): Promise<unknown> {
    if (!input.option.trim() || input.option.length > 300) throw new Error('Desktop RPA option is invalid.');
    return this.action('select', input.appId, input.target, input.option.trim());
  }

  async scroll(input: { appId: string; target?: DesktopRpaTargetV1; direction: 'up' | 'down'; amount: number }): Promise<unknown> {
    if (!input.target) throw new Error('Desktop RPA scroll requires a semantic target.');
    for (let index = 0; index < input.amount; index += 1) {
      await this.action(`scroll-${input.direction}`, input.appId, input.target, '');
    }
    return { scrolled: input.direction, amount: input.amount };
  }

  async wait(input: { appId: string; target: DesktopRpaTargetV1; timeoutMs: number }): Promise<unknown> {
    const deadline = Date.now() + input.timeoutMs;
    let lastError: unknown;
    do {
      try {
        await this.action('wait', input.appId, input.target, '');
        return { ready: true };
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } while (Date.now() < deadline);
    throw lastError instanceof Error ? lastError : new Error('Desktop RPA wait timed out.');
  }

  async screenshot(_appId: string): Promise<{ bytes: Uint8Array; redactedSummary: string }> {
    throw new Error('Desktop RPA screenshot is disabled until window-scoped redaction is available.');
  }

  private async action(
    operation: string,
    appId: string,
    target: DesktopRpaTargetV1,
    value: string,
  ): Promise<unknown> {
    const safeAppId = await this.authorize(appId, operation === 'wait' ? 'inspect' : 'interact');
    const safeTarget = normalizeTarget(target);
    await this.runScript(ACTION_SCRIPT, [
      safeAppId,
      operation,
      safeTarget.role,
      safeTarget.name,
      safeTarget.windowTitle,
      value,
    ]);
    return { appId: safeAppId, role: safeTarget.role, name: safeTarget.name, action: operation };
  }

  private async authorize(appId: string, action: 'inspect' | 'interact'): Promise<string> {
    if (this.platform !== 'darwin') throw new Error('Desktop Accessibility RPA is supported only on macOS.');
    const safeAppId = normalizeAppId(appId);
    if (!await this.options.authorizeApp({ appId: safeAppId, action })) {
      throw new Error(`Desktop RPA access was not authorized for ${safeAppId}.`);
    }
    return safeAppId;
  }
}
