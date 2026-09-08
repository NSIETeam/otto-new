import { describe, expect, it } from 'vitest';
import { withRecruitmentIntakeContext } from './recruitmentIntakeContext.js';
import { RecruitmentWorkspaceStore } from './recruitmentWorkspaceStore.js';
import type { RecruitmentSemanticAnalysisInput } from '../main/recruitmentSemantic.js';

describe('shared inbox coordination hints', () => {
  it('requires current shared scope and attaches the exact item without matching by a name', () => {
    const store = new RecruitmentWorkspaceStore('org:hr'); const input: RecruitmentSemanticAnalysisInput = { candidateId: 'c', jobTitle: '前端', jobDescription: 'React', redactedResume: '简历全文' };
    expect(withRecruitmentIntakeContext(store, input)).toBe(input);
    expect(() => withRecruitmentIntakeContext(store, input, 'a'.repeat(64))).toThrow();
    store.setSharedJob({ id: 'job', revision: 1, savedFingerprint: '', sync: { scopeToken: 'b'.repeat(64), headerToken: 'c'.repeat(64), candidateTokens: {} }, base: { id: 'job', revision: 1, title: '前端', description: 'React', collaboratorAccountIds: [], updatedAt: '', updatedBy: '', candidates: [], incomingMaterials: [{ id: 'a'.repeat(64), receivedAt: '', expiresAt: new Date(Date.now() + 86400000).toISOString(), material: {} as never }] } });
    expect(withRecruitmentIntakeContext(store, input)).toBe(input);
    expect(withRecruitmentIntakeContext(store, input, 'a'.repeat(64)).sharedIntake).toMatchObject({ itemId: 'a'.repeat(64), jobId: 'job', scopeId: 'org:hr' });
  });
});
