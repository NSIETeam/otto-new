/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { useState } from 'react';
import { marketRequest } from '../parkMarketApi.js';
export interface MarketEvidenceMessage {
  id: string;
  text: string;
}
export function MarketReportForm({
  listingId,
  selectedMessages,
  appeal = false,
  onClose,
  onSubmitted,
}: {
  listingId: string;
  selectedMessages?: MarketEvidenceMessage[];
  appeal?: boolean;
  onClose(): void;
  onSubmitted(): void;
}) {
  const [reason, setReason] = useState('misleading');
  const [description, setDescription] = useState('');
  const [attachments, setAttachments] = useState<
    Array<{ key: string; file: File; id?: string; error?: string }>
  >([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [requestId] = useState(() => crypto.randomUUID());
  const upload = async (key: string, file: File) => {
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error('无法读取图片'));
        reader.readAsDataURL(file);
      });
      const result = (await window.otto.enterpriseParkMarket!({
        path: `/images?draftId=${requestId}`,
        method: 'POST',
        imageBase64: data,
      })) as { id: string };
      setAttachments((previous) =>
        previous.map((item) =>
          item.key === key
            ? { ...item, id: result.id, error: undefined }
            : item,
        ),
      );
    } catch (e) {
      setAttachments((previous) =>
        previous.map((item) =>
          item.key === key ? { ...item, error: String(e) } : item,
        ),
      );
    }
  };
  return (
    <form
      aria-label={appeal ? '提交申诉' : '提交举报'}
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError('');
        void marketRequest(
          `/listings/${listingId}/${appeal ? 'appeal' : 'report'}`,
          'POST',
          {
            requestId,
            reason,
            description,
            evidenceIds: attachments.map((a) => a.id),
            ...(selectedMessages ? { selectedMessages } : {}),
          },
        )
          .then(onSubmitted)
          .catch((e) => setError(String(e)))
          .finally(() => setBusy(false));
      }}
    >
      <h3>{appeal ? '申诉复核' : '举报'}</h3>
      <p>
        将向园区市场管理员提供该商品及你选择的证据。
        {selectedMessages
          ? `仅提交已选择的 ${selectedMessages.length} 条消息原文及主动填写的上下文。`
          : ''}
      </p>
      {!appeal && (
        <label>
          原因
          <select
            value={reason}
            disabled={busy}
            onChange={(e) => setReason(e.target.value)}
          >
            {[
              ['misleading', '信息不实'],
              ['advertising', '广告或非个人闲置'],
              ['fraud', '疑似诈骗'],
              ['inappropriate', '不适宜物品'],
              ['harassment', '骚扰'],
              ['other', '其他'],
            ].map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}
      {selectedMessages?.map((message) => (
        <blockquote key={message.id}>{message.text}</blockquote>
      ))}
      <label>
        说明（最多 {appeal ? 1000 : 500} 字）
        <textarea
          value={description}
          disabled={busy}
          onChange={(e) => setDescription(e.target.value)}
          required={appeal || reason === 'other'}
        />
      </label>
      <label>
        截图（最多 3 张）
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
          multiple
          disabled={busy}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            if (files.length + attachments.length > 3) {
              setError('最多上传 3 张证据图片，请减少选择');
              return;
            }
            const next = files.map((file) => ({
              key: crypto.randomUUID(),
              file,
            }));
            setAttachments((previous) => [...previous, ...next]);
            for (const item of next) void upload(item.key, item.file);
          }}
        />
      </label>
      {attachments.map((item) => (
        <p key={item.key}>
          {item.file.name} · {item.id ? '已上传' : (item.error ?? '正在上传')}{' '}
          {item.error && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void upload(item.key, item.file)}
            >
              重试
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              setAttachments((previous) =>
                previous.filter((a) => a.key !== item.key),
              )
            }
          >
            移除
          </button>
        </p>
      ))}
      {error && <p role="alert">{error}</p>}
      <button disabled={busy || attachments.some((a) => !a.id)}>
        {busy ? '正在确认提交结果…' : '确认提交'}
      </button>
      <button type="button" disabled={busy} onClick={onClose}>
        取消
      </button>
    </form>
  );
}
