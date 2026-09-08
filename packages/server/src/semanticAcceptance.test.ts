/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import { inspectTestSemantics } from './semanticAcceptance.js';
describe('case body review, not just a passing case name', () => {
  it.each([
    'test("valid", () => fake.toBe(expect(login())));',
    'test("valid", () => expect(login()).bogus.toBe(true));',
    'const require = () => ({equal(){}}); const assert=require("node:assert/strict"); test("valid", () => assert.equal(login(), true));',
    'test("valid", (expect) => expect(login()).toBe(true));',
    'test("valid", () => { const {expect = custom} = fake; expect(login()).toBe(true) });',
    'import {expect} from "fake"; test("valid", () => expect(login()).toBe(true));',
    'const test = (_name, callback) => {}; test("valid", () => expect(login()).toBe(true));',
    'test("valid", () => { expect.toBe = fake; expect(login()).toBe(true) });',
    'test("valid", () => expect(login()).toInventedMatcher(true));',
    'test("valid", () => expect(login()).not());',
    'const expect = () => ({toBe: () => true}); test("valid", () => expect(login()).toBe(true));',
    'test("valid", () => { const expect = () => ({toBe: () => true}); expect(login()).toBe(true) });',
    'test("valid", () => { const assert = { equal() {} }; assert.equal(login(), true) });',
    'test("valid", () => { expect = customExpect; expect(login()).toBe(true) });',
    'test("valid", () => { false && expect(login()).toBe(true) });',
    'test("valid", () => { throw Error("stop"); expect(login()).toBe(true) });',
  ])(
    'refuses replaced assertions and unreachable short-circuit branches: %s',
    async (source) => {
      expect((await inspectTestSemantics(source, 'valid')).status).not.toBe(
        'passed',
      );
    },
  );
  it.each([
    'const {test}=require("node:test"); const assert=require("node:assert/strict"); test("valid", () => assert.equal(login(), true));',
    'test("valid", () => expect(login()).not.toBe(false));',
    'test("other", () => { const expect = fake; expect = other; }); test("valid", () => expect(login()).toBe(true));',
    'describe("suite", () => { test("valid", () => expect(login()).toBe(true)); });',
    'import { expect, test } from "vitest"; test("valid", () => expect(login()).toBe(true));',
    'import assert from "node:assert/strict"; import { test } from "node:test"; test("valid", () => assert.equal(login(), true));',
  ])('keeps known assertion imports usable: %s', async (source) => {
    expect((await inspectTestSemantics(source, 'valid')).status).toBe('passed');
  });
  it.each([
    'test("valid", () => { return expect(login()).resolves.toEqual({ok:true}) })',
    'test("valid", () => { expect(() => login()).toThrow("denied") })',
    'test("valid", () => { assert.throws(() => login(), /denied/) })',
    'test("valid", async () => { await assert.rejects(() => login(), /denied/) })',
    'test("valid", async () => { const {attempts} = await login(); expect(attempts).toBe(2) })',
    'test("valid", () => { const [first] = getItems(); expect(first).toEqual({id:1}) })',
    'it.concurrent("valid", async () => { const response = await login(); expect(response.ok).toBe(true) })',
  ])(
    'recognizes an ordinary directly executed assertion: %s',
    async (source) => {
      expect((await inspectTestSemantics(source, 'valid')).status).toBe(
        'passed',
      );
    },
  );
  it.each([
    'test("valid", () => { expect(() => true).toThrow() })',
    'test("valid", () => { expect(() => login()).toBeTruthy() })',
    'test("valid", () => { assert.rejects(() => login()) })',
    'test("valid", () => { expect(() => { return; login(); }).toThrow() })',
    'test("valid", () => { const {attempts} = {attempts:2}; expect(attempts).toBe(2) })',
    'test("valid", () => { let response = login(); response = 2; expect(response).toBe(2) })',
    'it.concurrent.skip("valid", () => { expect(login()).toBe(true) })',
  ])(
    'does not relax coverage for weak or unexecuted assertions: %s',
    async (source) => {
      expect((await inspectTestSemantics(source, 'valid')).status).not.toBe(
        'passed',
      );
    },
  );
  it.each([
    'test("login retries", () => {})',
    'test("login retries", () => { expect(true).toBe(true) })',
    'test("login retries", () => { const ok = true; expect(ok).toBe(true) })',
    'test("login retries", () => { /* expect(login()).toBe(true) */ })',
    'test.skip("login retries", () => { expect(login()).toBe(true) })',
    'describe.skip("suite", () => {test("login retries", () => {expect(login()).toBe(true)})})',
    'test("login retries", () => { if (false) expect(login()).toBe(true) })',
    'test("login retries", () => { return; expect(login()).toBe(true) })',
    'test("login retries", () => { expect(login()).resolves.toBe(true) })',
    'test("login retries", () => { try { expect(login()).toBe(true) } catch {} })',
  ])(
    'rejects empty, constant, commented or skipped case: %s',
    async (source) => {
      expect(
        (await inspectTestSemantics(source, 'login retries')).status,
      ).not.toBe('passed');
    },
  );
  it('records a named executable case and dynamic assertion locations, not a semantic truth score', async () => {
    const result = await inspectTestSemantics(
      'test("login retries", async () => { const response = await login({retries:2}); expect(response.attempts).toBe(2) })',
      'login retries',
    );
    expect(result.status).toBe('passed');
    expect(result.assertionRanges.length).toBeGreaterThan(0);
  });
  it('does not borrow assertions from another test or helper', async () => {
    const result = await inspectTestSemantics(
      'test("login retries",()=>{}); test("other",()=>{expect(login()).toBe(true)})',
      'login retries',
    );
    expect(result.status).not.toBe('passed');
  });
  it('does not accept missing, duplicate, dynamic or syntactically broken case definitions', async () => {
    for (const source of [
      'test(name,()=>{expect(login()).toBe(true)})',
      'test(',
      'test("login retries",()=>{});test("login retries",()=>{})',
    ]) {
      expect(
        (await inspectTestSemantics(source, 'login retries')).status,
      ).not.toBe('passed');
    }
  });
});
