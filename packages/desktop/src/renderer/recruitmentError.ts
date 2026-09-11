/** Format new and persisted failures without exposing Electron/provider internals. */
export function recruitmentErrorMessage(error: unknown): string {
  const message = (error instanceof Error ? error.message : typeof error === 'string' ? error : '')
    .replace(/^Error invoking remote method ['"][^'"]+['"]:\s*(?:Error:\s*)?/u, '')
    .replace(/^Error:\s*/u, '').trim();
  if (/招聘分析缺少维度|招聘分析摘要为空|招聘分析模型没有返回有效 JSON/u.test(message)) {
    return '模型返回的评价不完整，未生成有效分析。候选人材料已保留，可重新分析。';
  }
  if (/502|503|504|Bad Gateway|ECONN|fetch failed|Failed to fetch/iu.test(message)) {
    return '暂时无法连接招聘或模型服务。材料不会因此删除，请稍后重试。';
  }
  if (/timeout|timed out|超时/iu.test(message)) return '招聘分析等待超时，本次结果尚未确认。请先查看候选人处理记录与用量，避免重复提交。';
  if (/AbortError|aborted/iu.test(message)) return '招聘分析已取消，未生成新的评价。';
  if (/^[\u3400-\u9fff]/u.test(message) && !/https?:|Bearer\s|api[_-]?key|token\s*[=:]|[A-Z]:\\|\/(?:Users|home|private)\//iu.test(message)) return message.slice(0, 300);
  return '招聘处理暂未完成，请检查网络和当前对话的模型设置后重试。';
}
