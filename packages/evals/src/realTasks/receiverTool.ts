/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { BaseTool, Icon, type ToolResult } from 'otto-core';
/** A real loopback HTTP connector, not a stubbed business/recovery function. */
export class EvaluationReceiptTool extends BaseTool<
  Record<string, never>,
  ToolResult
> {
  constructor(private readonly receiver: string) {
    super(
      'eval_send_receipt',
      'Send to isolated receiver',
      'Send the fixed evaluation message to the controller-owned local receiver. Has a real external side effect; never blindly replay.',
      Icon.Tasks,
      { type: 'OBJECT' as BaseTool['parameterSchema']['type'], properties: {} },
    );
    const url = new URL(receiver);
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      url.pathname !== '/receipt' ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new Error('Only the isolated receiver is allowed');
  }
  async shouldConfirmExecute() {
    return {
      type: 'exec' as const,
      title: 'Send isolated test message',
      command: 'eval_send_receipt',
      rootCommand: 'eval_send_receipt',
      onConfirm: async () => undefined,
    };
  }
  async execute(
    _params: Record<string, never>,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const response = await fetch(this.receiver, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'fixed-evaluation-message' }),
      signal,
    });
    if (!response.ok) throw new Error(`Receiver HTTP ${response.status}`);
    const text = await response.text();
    return { llmContent: text, returnDisplay: text };
  }
}
