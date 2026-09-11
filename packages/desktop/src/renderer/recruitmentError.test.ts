import { describe, expect, it } from 'vitest';
import { recruitmentErrorMessage } from './recruitmentError.js';
describe('recruitment errors', () => {
  it('explains incomplete model results and preserves actionable business errors', () => {
    expect(recruitmentErrorMessage("Error invoking remote method 'otto:recruitment-analyze-resume': Error: 招聘分析缺少维度：核心能力")).toContain('模型返回的评价不完整');
    expect(recruitmentErrorMessage('请先确认已取得授权')).toBe('请先确认已取得授权');
    expect(recruitmentErrorMessage('模型服务暂不可用')).toBe('模型服务暂不可用');
  });
  it('hides connection internals and credentials', () => {
    expect(recruitmentErrorMessage('502 Bad Gateway')).toContain('连接');
    for (const message of ['失败 Bearer private-secret', '模型故障 https://host.example?token=secret', 'ECONNRESET /private/resume.txt']) {
      expect(recruitmentErrorMessage(message)).not.toMatch(/private-secret|https:|ECONNRESET|resume.txt/);
    }
  });
});
