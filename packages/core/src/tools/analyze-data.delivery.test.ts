/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { AnalyzeDataTool } from './analyze-data.js';
import { DoctorService } from '../services/doctor.js';
import { createMockConfig } from '../utils/test-helpers.js';

describe('AnalyzeDataTool file delivery outcomes', () => {
  let root: string;
  let tool: AnalyzeDataTool;
  const signal = () => new AbortController().signal;
  const input = (name: string, contents: string) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, contents);
    return file;
  };
  const exportExcel = (file: string, output = path.join(root, 'result.xlsx'), abort = signal()) =>
    tool.execute({ input_path: file, operation: 'export_excel', output_path: output }, abort);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-data-delivery-'));
    tool = new AnalyzeDataTool(createMockConfig());
    // Deterministic no-external-engine environment, independent of host PATH.
    vi.spyOn(DoctorService.prototype, 'check').mockResolvedValue({
      platform: process.platform, presentCount: 0, missingCount: 2,
      affectedCapabilities: ['数据分析'],
      checks: ['duckdb', 'gnuplot'].map(name => ({
        name, category: '数据分析', present: false, installHint: `install ${name}`,
      })),
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('rejects engine failure instead of resolving a successful tool result', async () => {
    const file = input('data.csv', 'name,amount\n甲,2\n');
    await expect(tool.execute({ input_path: file, operation: 'summary' }, signal()))
      .rejects.toThrow(/duckdb.*install|install.*duckdb/i);
  });

  it('rejects invalid parameters even when called without the scheduler validator', async () => {
    await expect(exportExcel(path.join(root, 'absent.csv'))).rejects.toThrow(/not found/);
  });

  it('does not write a CSV pivot after cancellation', async () => {
    const file = input('data.csv', 'name,amount\n甲,2\n');
    const output = path.join(root, 'cancelled.csv');
    const abort = new AbortController();
    abort.abort();
    await expect(tool.execute({ input_path: file, operation: 'pivot',
      group_column: 'name', aggregate: 'SUM(amount)', output_path: output }, abort.signal))
      .rejects.toThrow();
    expect(fs.existsSync(output)).toBe(false);
  });

  it('exports a real XLSX from quoted Unicode CSV without DuckDB', async () => {
    const file = input('data.csv', 'name,amount,note\n"甲,乙",2,"A < B & C"\n');
    const output = path.join(root, 'result.xlsx');
    const result = await exportExcel(file, output);
    expect(result.llmContent).toContain('analyze_data OK');
    expect(fs.readFileSync(output).subarray(0, 2).toString()).toBe('PK');
    const workbook = XLSX.read(fs.readFileSync(output), { type: 'buffer' });
    expect(XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]))
      .toEqual([{ name: '甲,乙', amount: 2, note: 'A < B & C' }]);
    expect(DoctorService.prototype.check).not.toHaveBeenCalled();
  });

  it('exports JSON records as real spreadsheet cells', async () => {
    const file = input('data.json', JSON.stringify([{ name: '甲', amount: 7 }, { name: '乙', amount: 3 }]));
    expect((await exportExcel(file)).llmContent).toContain('analyze_data OK');
    const workbook = XLSX.read(fs.readFileSync(path.join(root, 'result.xlsx')), { type: 'buffer' });
    expect(XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]))
      .toEqual([{ name: '甲', amount: 7 }, { name: '乙', amount: 3 }]);
  });

  it('converts legacy XLS bytes to XLSX rather than renaming them', async () => {
    const file = path.join(root, 'legacy.xls');
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['name', 'amount'], ['甲', 5]]), '原表');
    fs.writeFileSync(file, XLSX.write(workbook, { bookType: 'biff8', type: 'buffer' }));
    await exportExcel(file);
    const output = path.join(root, 'result.xlsx');
    expect(fs.readFileSync(output).subarray(0, 2).toString()).toBe('PK');
    const actual = XLSX.read(fs.readFileSync(output), { type: 'buffer' });
    expect(actual.SheetNames).toEqual(['原表']);
    expect(XLSX.utils.sheet_to_json(actual.Sheets['原表'])).toEqual([{ name: '甲', amount: 5 }]);
  });

  it('preserves an existing destination and source on malformed input', async () => {
    const file = input('broken.json', '{');
    const output = input('result.xlsx', 'prior destination');
    await expect(exportExcel(file, output)).rejects.toThrow();
    expect(fs.readFileSync(output, 'utf8')).toBe('prior destination');
    expect(fs.readFileSync(file, 'utf8')).toBe('{');
  });

  it('rejects an extension that would disguise spreadsheet bytes as another format', async () => {
    const file = input('data.csv', 'name,amount\n甲,2\n');
    const output = path.join(root, 'disguised.pdf');
    await expect(exportExcel(file, output)).rejects.toThrow(/xlsx/i);
    expect(fs.existsSync(output)).toBe(false);
  });

  it.each(['xlsx', 'xls'])('rejects text disguised as a %s workbook', async extension => {
    const file = input(`disguised.${extension}`, 'not a workbook');
    await expect(exportExcel(file)).rejects.toThrow(/workbook|格式|Excel/i);
    expect(fs.existsSync(path.join(root, 'result.xlsx'))).toBe(false);
  });

  it('supports five consecutive mixed spreadsheet exports in the same tool instance', async () => {
    for (let round = 1; round <= 5; round++) {
      const csv = round % 2 === 1;
      const file = input(`round-${round}.${csv ? 'csv' : 'json'}`, csv
        ? `name,amount\n合成${round},${round}\n`
        : JSON.stringify([{ name: `合成${round}`, amount: round }]));
      const output = path.join(root, `round-${round}.xlsx`);
      expect((await exportExcel(file, output)).llmContent).toContain('analyze_data OK');
      const workbook = XLSX.read(fs.readFileSync(output), { type: 'buffer' });
      expect(XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]))
        .toEqual([{ name: `合成${round}`, amount: round }]);
    }
  });

  it('preserves all sheets and formula cells when exporting an existing XLSX', async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['name'], ['甲']]), '一');
    const sheet = XLSX.utils.aoa_to_sheet([[2, 3, 5]]);
    sheet.C1.f = 'A1+B1';
    XLSX.utils.book_append_sheet(workbook, sheet, '二');
    const file = path.join(root, 'input.xlsx');
    const source = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    fs.writeFileSync(file, source);
    await exportExcel(file);
    const actual = XLSX.read(fs.readFileSync(path.join(root, 'result.xlsx')), { type: 'buffer' });
    expect(actual.SheetNames).toEqual(['一', '二']);
    expect(actual.Sheets['二'].C1.f).toBe('A1+B1');
    expect(fs.readFileSync(file)).toEqual(source);
  });

  it('rejects malformed JSON records without leaving a final spreadsheet', async () => {
    const file = input('scalar.json', '[1,null]');
    await expect(exportExcel(file)).rejects.toThrow(/array of records/);
    expect(fs.existsSync(path.join(root, 'result.xlsx'))).toBe(false);
  });
});
