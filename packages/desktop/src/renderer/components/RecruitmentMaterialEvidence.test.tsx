import { render, screen } from '@testing-library/react';
import { it, expect } from 'vitest';
import { RecruitmentMaterialEvidence } from './RecruitmentMaterialEvidence.js';
import type { CandidateWorkspace } from '../recruitmentWorkspaceStore.js';

it('shows extraction coverage and explicitly distinguishes byte hashes from stored originals', () => {
  const candidate = { sourceMaterial: { source: { sourceLabel: 'Workable' }, retrievedAt: '2026-09-08T00:00:00Z', material: { completeness: 'partial', text: '部分文字', reason: '含图片，需补充纯文本', attachment: { sha256: 'a'.repeat(64), bytes: 2000, format: 'pdf', pages: 2, extractorVersion: 'otto-resume-v1' } } } } as CandidateWorkspace;
  render(<RecruitmentMaterialEvidence candidate={candidate} />);
  expect(screen.getByText(/2 页/)).toBeTruthy();
  expect(screen.getByText(/原始附件尚未托管/)).toBeTruthy();
  expect(screen.getByText(/含图片，需补充纯文本/)).toBeTruthy();
  expect(document.body.textContent).toContain('a'.repeat(64));
});
