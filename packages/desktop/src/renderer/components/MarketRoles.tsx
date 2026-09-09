import { MarketMutation } from '../parkMarketMutation.js';
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { marketRequest } from '../parkMarketApi.js';
export function MarketRoles({
  parkId,
  onChanged,
}: {
  parkId: string;
  onChanged(): void;
}) {
  const mutation = useRef(new MarketMutation());
  const [roles, setRoles] = useState<Array<{ account_id: string }>>([]);
  const [account, setAccount] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(
    () =>
      marketRequest<Array<{ account_id: string }>>(`/roles/${parkId}`)
        .then(setRoles)
        .catch((e) => setError(String(e))),
    [parkId],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const assign = async (accountId: string, enabled: boolean) => {
    if (
      !window.confirm(
        `${enabled ? '授予' : '撤销'}账号 ${accountId} 的市场管理权限？操作会记入审计。`,
      )
    )
      return;
    setBusy(true);
    setError('');
    try {
      await mutation.current.run(`/roles/${parkId}`, 'PUT', {
        accountId,
        enabled,
      });
      await refresh();
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="市场管理员授权">
      <h3>市场管理员授权</h3>
      <p>
        由园区管理方显式授权，可指定本园区有效账号。普通企业管理员不会自动获得市场管理权限。
      </p>
      {error && <p role="alert">{error}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void assign(account.trim(), true);
        }}
      >
        <label>
          管理员账号 ID
          <input value={account} onChange={(e) => setAccount(e.target.value)} />
        </label>
        <button disabled={busy || !account.trim()}>授予权限</button>
      </form>
      {roles.map((role) => (
        <p key={role.account_id}>
          {role.account_id}{' '}
          <button
            disabled={busy}
            onClick={() => void assign(role.account_id, false)}
          >
            撤销权限
          </button>
        </p>
      ))}
    </section>
  );
}
