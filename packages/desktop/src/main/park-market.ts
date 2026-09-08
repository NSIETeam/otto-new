/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
  MarketDesktopRequest,
  MarketDraft,
  MarketDraftScope,
} from '../shared/park-market.js';
export function validateMarketRequest(value: unknown): MarketDesktopRequest {
  if (!value || typeof value !== 'object') throw new Error('市场请求无效');
  const input = value as MarketDesktopRequest;
  if (
    typeof input.path !== 'string' ||
    input.path.length > 3000 ||
    !/^\/(?:mls|contacts|contact-prepare|conversations|blocks|settings|mine|listings|favorites|notifications|records|admin|reports|appeals|restore|restrictions|roles|images|drafts)?(?:\/[A-Za-z0-9_-]+){0,2}(?:\?[^#]*)?$/.test(
      input.path,
    ) ||
    !['GET', 'POST', 'PUT', 'DELETE'].includes(input.method)
  )
    throw new Error('市场请求无效');
  if (
    input.imageBase64 !== undefined &&
    (input.path.split('?')[0] !== '/images' ||
      input.method !== 'POST' ||
      typeof input.imageBase64 !== 'string' ||
      input.imageBase64.length > 28_000_000)
  )
    throw new Error('图片请求无效');
  return input;
}
export function assertMarketDraftScope(
  current: MarketDraftScope,
  expected: unknown,
): void {
  const value = expected as MarketDraftScope | undefined;
  if (
    !value ||
    value.server !== current.server ||
    value.organization !== current.organization ||
    value.account !== current.account
  )
    throw new Error('账号或服务器已切换，原草稿未写入当前账号');
}
export class MarketDraftStore {
  constructor(
    private root: string,
    private encrypt: (text: string) => Buffer,
    private decrypt: (bytes: Buffer) => string,
    private maxEntries = 20,
  ) {}
  private path(scope: MarketDraftScope) {
    if (!scope.server || !scope.organization || !scope.account)
      throw new Error('请先登录账号');
    return join(
      this.root,
      `${createHash('sha256')
        .update(
          JSON.stringify([scope.server, scope.organization, scope.account]),
        )
        .digest('hex')}.draft`,
    );
  }
  load(scope: MarketDraftScope): MarketDraft[] {
    const file = this.path(scope);
    if (!existsSync(file)) return [];
    const value = JSON.parse(this.decrypt(readFileSync(file)));
    if (!Array.isArray(value))
      throw new Error('草稿数据损坏，请保留文件并联系支持');
    return value;
  }
  save(scope: MarketDraftScope, drafts: unknown) {
    if (
      !Array.isArray(drafts) ||
      drafts.length > this.maxEntries ||
      drafts.some(
        (d) => !d || typeof d !== 'object' || typeof d.id !== 'string',
      )
    )
      throw new Error('草稿数据无效');
    const text = JSON.stringify(drafts);
    if (Buffer.byteLength(text) > 2_000_000) throw new Error('草稿过大');
    const file = this.path(scope);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, this.encrypt(text), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  }
}
/** Renew retention only; preserve the latest local text and any concurrent edits. */
export async function renewMarketDraftLeases(
  store: MarketDraftStore,
  scope: MarketDraftScope,
  isCurrent: () => boolean,
  renew: (draftId: string, imageIds: string[]) => Promise<unknown>,
) {
  for (const draft of store.load(scope)) {
    if (!isCurrent()) return;
    const imageIds = (draft.form as { imageIds?: unknown } | undefined)
      ?.imageIds;
    if (
      !Array.isArray(imageIds) ||
      imageIds.length > 9 ||
      imageIds.some((id) => typeof id !== 'string')
    )
      continue;
    let failed = false;
    try {
      await renew(draft.id, imageIds);
    } catch {
      failed = true;
    }
    if (!isCurrent()) return;
    const latest = store
      .load(scope)
      .map((current) =>
        current.id === draft.id &&
        JSON.stringify(
          (current.form as { imageIds?: unknown } | undefined)?.imageIds,
        ) === JSON.stringify(imageIds)
          ? { ...current, imageLeaseFailed: failed }
          : current,
      );
    store.save(scope, latest);
  }
}
