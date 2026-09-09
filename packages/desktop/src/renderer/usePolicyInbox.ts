/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PolicyInbox } from '../preload/index.js';
import { startNonOverlappingPoll } from './lib/nonOverlappingPoll.js';
const empty = (): PolicyInbox => ({
  notices: [],
  unreadCount: 0,
  watchedPolicyIds: [],
});
function validateInbox(inbox: PolicyInbox): void {
  if (
    !inbox ||
    !Array.isArray(inbox.notices) ||
    !Array.isArray(inbox.watchedPolicyIds) ||
    !Number.isSafeInteger(inbox.unreadCount) ||
    inbox.unreadCount < 0
  )
    throw new Error('Invalid policy inbox response');
}
export function usePolicyInbox(
  scopeId: string,
  enabled: boolean,
  activationKey?: string,
): { inbox: PolicyInbox; error: string; read(ids: string[]): Promise<void> } {
  const [state, setState] = useState<{ scope: string; inbox: PolicyInbox }>({
    scope: '',
    inbox: empty(),
  });
  const [error, setError] = useState('');
  const epoch = useRef(0);
  const revision = useRef(0);
  useEffect(() => {
    const current = ++epoch.current;
    setError('');
    if (!enabled || !window.otto.policyIntelligenceInbox) return;
    const stop = startNonOverlappingPoll(async () => {
      const version = revision.current;
      try {
        const inbox = await window.otto.policyIntelligenceInbox({ scopeId });
        validateInbox(inbox);
        if (current !== epoch.current || version !== revision.current) return;
        setState({ scope: scopeId, inbox });
        setError('');
      } catch (cause) {
        if (current === epoch.current && version === revision.current)
          setError(
            cause instanceof Error &&
              cause.message.includes('企业服务器版本过旧或功能不完整')
              ? '企业服务器需升级才能使用政策提醒，其他消息不受影响'
              : '政策提醒暂时无法加载，请稍后重试',
          );
      }
    }, 15_000);
    return () => {
      epoch.current = current + 1;
      stop();
    };
  }, [scopeId, enabled, activationKey]);
  const read = useCallback(
    async (ids: string[]): Promise<void> => {
      if (!enabled) return;
      const current = epoch.current;
      const version = ++revision.current;
      try {
        const inbox = await window.otto.policyIntelligenceInbox({
          scopeId,
          ids: ids.slice(0, 200),
        });
        validateInbox(inbox);
        if (current === epoch.current && version === revision.current) {
          setState({ scope: scopeId, inbox });
          setError('');
        }
      } catch {
        if (current === epoch.current)
          setError('政策消息已读状态未保存，请重试');
      }
    },
    [scopeId, enabled],
  );
  return {
    inbox: enabled && state.scope === scopeId ? state.inbox : empty(),
    error,
    read,
  };
}
