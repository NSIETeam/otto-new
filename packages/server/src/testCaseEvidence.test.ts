import { describe, expect, it } from 'vitest';
import { passedTestCases } from './testCaseEvidence.js';

describe('runner case evidence (not a semantic quality judge)', () => {
  it('parses complete Vitest/Jest JSON and excludes failed/skipped/duplicate cases', () => {
    const report = JSON.stringify({
      testResults: [
        {
          assertionResults: [
            { fullName: 'login normal', status: 'passed' },
            { fullName: 'login error', status: 'failed' },
            { fullName: 'login boundary', status: 'pending' },
            { fullName: 'duplicate', status: 'passed' },
            { fullName: 'duplicate', status: 'failed' },
          ],
        },
      ],
    });
    expect(passedTestCases(report)).toEqual(['login normal']);
  });
  it('requires a complete TAP plan and never counts skip/todo or diagnostic prose', () => {
    expect(
      passedTestCases(
        'TAP version 13\nok 1 - login normal\nok 2 - login error # SKIP\nnot ok 3 - login boundary\n1..3\n',
      ),
    ).toEqual(['login normal']);
    expect(passedTestCases('all tests passed; login normal')).toEqual([]);
    expect(passedTestCases('ok 1 - login normal')).toEqual([]);
    expect(
      passedTestCases('TAP version 13\nok 1 - login normal\n1..2'),
    ).toEqual([]);
    expect(
      passedTestCases('TAP version 13\nok 1 - login normal\nBail out!\n1..1'),
    ).toEqual([]);
  });
});
