/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OttoAuthHandler } from './ottoAuth.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const secretBearingIdentifiers = new Set([
  'accessToken',
  'allParams',
  'authUrl',
  'code',
  'errorText',
  'jwtData',
  'refreshToken',
  'token',
  'url',
  'user_id',
]);

function secretIdentifiersLoggedByConsole(fileName: string): string[] {
  const filePath = path.join(currentDir, fileName);
  const source = fs.readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const violations: string[] = [];

  const collectIdentifiers = (node: ts.Node, identifiers: Set<string>): void => {
    if (ts.isIdentifier(node)) identifiers.add(node.text);
    ts.forEachChild(node, (child) => collectIdentifiers(child, identifiers));
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'console'
    ) {
      const identifiers = new Set<string>();
      for (const argument of node.arguments) collectIdentifiers(argument, identifiers);
      const secrets = [...identifiers].filter((name) => secretBearingIdentifiers.has(name));
      if (secrets.length > 0) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        violations.push(`${fileName}:${line} logs ${secrets.join(', ')}`);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

describe('authentication logging safety', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never writes Otto callback credentials to console output', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = new OttoAuthHandler({
      authUrl: 'https://auth.example.test/login',
      redirectUri: 'http://localhost:7863/callback?plat=otto',
    });
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjQ3NjUwNDY0MDAsImlhdCI6MTcwMDAwMDAwMH0.signature';
    const userId = 'sensitive-user-id';
    const state = 'c'.repeat(64);

    const result = handler.handleCallback(
      new URL(`http://localhost:7863/callback?plat=otto&token=${jwt}&user_id=${userId}&state=${state}`),
      (candidate) => candidate === state,
    );

    expect(result).toMatchObject({ success: true, token: jwt, user_id: userId });
    const output = JSON.stringify([...log.mock.calls, ...error.mock.calls]);
    expect(output).not.toContain(jwt);
    expect(output).not.toContain(userId);
  });

  it('keeps secret-bearing auth values out of every console call', () => {
    expect([
      ...secretIdentifiersLoggedByConsole('ottoAuth.ts'),
      ...secretIdentifiersLoggedByConsole('authServer.ts'),
    ]).toEqual([]);
  });
});
