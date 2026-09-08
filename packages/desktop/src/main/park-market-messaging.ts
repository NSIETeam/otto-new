import type { ParkMarketMls, MarketMlsPacket } from './park-market-mls.js';
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import type {
  EnterpriseE2eeCrypto,
  EnterpriseE2eeDeviceBundle,
  EnterpriseE2eeKeyTransparencyView,
  EnterpriseE2eeSendPayload,
  EnterpriseE2eeWireMessage,
} from './enterprise-e2ee.js';
import type { MarketDraftStore } from './park-market.js';
import type { MarketDraftScope } from '../shared/park-market.js';
interface Context {
  crypto: EnterpriseE2eeCrypto;
  accountId: string;
  organizationId: string;
  serverScope: string;
  serverUrl: string;
  requiresMls: boolean;
}
interface Directory {
  organizationId: string;
  devices: EnterpriseE2eeDeviceBundle[];
  transparency: EnterpriseE2eeKeyTransparencyView;
}
interface Prepared {
  conversationId: string;
  parkId: string;
  peerId: string;
  version: number | null;
  directories: Directory[];
}
interface EncryptedMessage {
  id: string;
  sequence: number;
  senderId: string;
  recipientId: string;
  createdAt: number;
  readAt: number | null;
  envelope: EnterpriseE2eeSendPayload & {
    senderIdentitySigningPublicKey: string;
  };
  snapshot: Record<string, unknown> | null;
}
export class ParkMarketMessaging {
  constructor(
    private deps: {
      context(): Context;
      ensureDevice(): Promise<unknown>;
      request(
        path: string,
        method?: 'GET' | 'POST',
        body?: Record<string, unknown>,
      ): Promise<unknown>;
      pending: MarketDraftStore;
      mls?: ParkMarketMls;
    },
  ) {}
  private scope(context: Context): MarketDraftScope {
    return {
      server: context.serverUrl,
      account: context.accountId,
      organization: context.organizationId,
    };
  }
  private check(context: Context) {
    const latest = this.deps.context();
    if (
      latest.accountId !== context.accountId ||
      latest.organizationId !== context.organizationId ||
      latest.serverUrl !== context.serverUrl
    )
      throw new Error('账号已切换，请重新打开咨询');
  }
  private directory(context: Context, directories: Directory[]) {
    return directories.flatMap((directory) => {
      const transparency = context.crypto.verifyAndPinKeyTransparency({
        serverScope: context.serverScope,
        organizationId: directory.organizationId,
        view: directory.transparency,
      });
      return context.crypto
        .verifyDeviceDirectory({
          organizationId: directory.organizationId,
          devices: directory.devices,
          transparency: [transparency],
          includePending: true,
          includeRevoked: true,
        })
        .map((device) => ({
          ...device,
          organizationId: directory.organizationId,
        }));
    });
  }
  async send(input: {
    kind: 'listing' | 'conversation' | 'reply';
    id: string;
    conversationId?: string;
    expectedVersion?: number;
    question: string;
    requestId: string;
  }) {
    if (
      !input ||
      !['listing', 'conversation', 'reply'].includes(input.kind) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.id) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId)
    )
      throw new Error('咨询参数无效');
    const question = input.question.trim();
    const length = [
      ...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(
        question,
      ),
    ].length;
    if (length < 1 || length > (input.kind === 'listing' ? 500 : 5000))
      throw new Error(
        input.kind === 'listing'
          ? '首次问题需要 1–500 字'
          : '消息需要 1–5000 字',
      );
    const context = this.deps.context();
    if (context.requiresMls && !this.deps.mls)
      throw new Error(
        '此部署要求 MLS 加密；市场 MLS 通道尚未就绪，输入已保留，不会降级发送',
      );
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(input))
      .digest('hex');
    const saved = this.deps.pending.load(this.scope(context));
    let pending = saved.find((p) => p.id === input.requestId);
    if (pending && pending.fingerprint !== fingerprint)
      throw new Error('正在确认的消息不能修改；请先确认原消息结果');
    if (!pending) {
      await this.deps.ensureDevice();
      this.check(context);
      const kind = input.kind === 'listing' ? 'listing' : 'conversation';
      const id = input.kind === 'reply' ? input.conversationId : input.id;
      if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id))
        throw new Error('咨询会话无效');
      const prepared = (await this.deps.request(
        `/contact-prepare/${kind}/${id}`,
      )) as Prepared;
      this.check(context);
      const devices = this.directory(context, prepared.directories).filter(
        (d) => d.approvalState === 'approved' && !d.revokedAt,
      );
      const envelope = context.requiresMls
        ? await this.deps.mls!.encrypt(
            context,
            prepared.conversationId,
            input.requestId,
            question,
            devices,
          )
        : context.crypto.encryptMessage({
            serverScope: context.serverScope,
            organizationId: `park-market:${prepared.parkId}`,
            senderAccountId: context.accountId,
            recipientAccountId: prepared.peerId,
            messageId: input.requestId,
            content: question,
            contentType: 'message',
            devices,
          });
      const path =
        input.kind === 'listing'
          ? `/listings/${input.id}/contact`
          : input.kind === 'reply'
            ? `/contacts/${input.id}`
            : `/conversations/${input.id}`;
      const body = {
        requestId: input.requestId,
        expectedVersion: input.expectedVersion,
        envelope,
        ...(input.kind === 'reply' ? { action: 'reply' } : {}),
      };
      pending = { id: input.requestId, fingerprint, path, body };
      // Persist ciphertext before any send. A timeout retries the identical signed bytes.
      this.check(context);
      const latest = this.deps.pending.load(this.scope(context));
      const concurrent = latest.find((entry) => entry.id === input.requestId);
      if (concurrent) {
        if (concurrent.fingerprint !== fingerprint)
          throw new Error('正在确认的消息不能修改；请先确认原消息结果');
        pending = concurrent;
      } else {
        this.deps.pending.save(this.scope(context), [...latest, pending]);
      }
    }
    this.check(context);
    let result: unknown;
    try {
      result = await this.deps.request(
        String(pending.path),
        'POST',
        pending.body as Record<string, unknown>,
      );
    } catch (error) {
      const rejection = error as { status?: number; message?: string };
      const definitive: Record<string, number> = {
        INVALID_INPUT: 400,
        FORBIDDEN: 403,
        NOT_FOUND: 404,
        CONFLICT: 409,
        LIMIT_REACHED: 429,
      };
      if (
        typeof rejection?.message === 'string' &&
        definitive[rejection.message] === rejection.status &&
        rejection.status !== undefined
      ) {
        this.check(context);
        this.deps.pending.save(
          this.scope(context),
          this.deps.pending
            .load(this.scope(context))
            .filter((entry) => entry.id !== input.requestId),
        );
        throw new Error(
          `服务器已明确未发送，可修改后重试：${rejection.message}`,
          { cause: error },
        );
      }
      throw error;
    }
    this.check(context);
    this.deps.pending.save(
      this.scope(context),
      this.deps.pending
        .load(this.scope(context))
        .filter((p) => p.id !== input.requestId),
    );
    return result;
  }
  async recover(conversationId: string) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(conversationId) || !this.deps.mls)
      throw new Error('加密恢复不可用');
    const context = this.deps.context();
    if (!context.requiresMls) throw new Error('此会话未使用 MLS 加密');
    await this.deps.ensureDevice();
    this.check(context);
    const prepared = (await this.deps.request(
      `/contact-prepare/conversation/${conversationId}`,
    )) as Prepared;
    this.check(context);
    return this.deps.mls.recover(
      context,
      conversationId,
      this.directory(context, prepared.directories),
    );
  }
  async messages(conversationId: string, beforeSequence?: number) {
    if (
      beforeSequence !== undefined &&
      (!Number.isSafeInteger(beforeSequence) || beforeSequence < 1)
    )
      throw new Error('消息分页无效');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(conversationId))
      throw new Error('咨询会话无效');
    const context = this.deps.context();
    const prepared = (await this.deps.request(
      `/contact-prepare/conversation/${conversationId}`,
    )) as Prepared;
    this.check(context);
    const devices = this.directory(context, prepared.directories);
    const response = (await this.deps.request(
      `/conversations/${conversationId}${beforeSequence === undefined ? '' : `?beforeSequence=${beforeSequence}`}`,
    )) as {
      items: EncryptedMessage[];
      latestSequence: number;
      nextBeforeSequence: number | null;
      writable: boolean;
      parkId: string;
      peerId: string;
    };
    this.check(context);
    const mlsItems = response.items.filter(
      (item) =>
        (item.envelope as unknown as MarketMlsPacket).encryption === 'mls',
    );
    const mlsContent =
      mlsItems.length && this.deps.mls
        ? await this.deps.mls.decrypt(
            context,
            conversationId,
            mlsItems as unknown as Array<{
              id: string;
              senderId: string;
              envelope: MarketMlsPacket;
            }>,
            devices,
          )
        : new Map<string, string>();
    const items = response.items.map((item) => {
      if ((item.envelope as unknown as MarketMlsPacket).encryption === 'mls')
        return {
          ...item,
          envelope: undefined,
          content: mlsContent.get(item.id) ?? '',
          error: mlsContent.has(item.id)
            ? ''
            : '此设备无法解密该历史消息，请使用原设备',
        };
      const sender = devices.find(
        (d) =>
          d.accountId === item.senderId &&
          d.deviceId === item.envelope.senderDeviceId,
      );
      if (
        !sender ||
        sender.identitySigningPublicKey !==
          item.envelope.senderIdentitySigningPublicKey
      )
        return {
          ...item,
          envelope: undefined,
          content: '',
          error: '发送设备无法通过身份校验，消息未展示',
        };
      try {
        const message: EnterpriseE2eeWireMessage = {
          ...item.envelope,
          id: item.envelope.messageId,
          senderAccountId: item.senderId,
          recipientAccountId: item.recipientId,
          createdAt: new Date(item.createdAt).toISOString(),
          readAt:
            item.readAt === null ? null : new Date(item.readAt).toISOString(),
          attachments: [],
        };
        const plaintext = context.crypto.decryptMessage({
          serverScope: context.serverScope,
          organizationId: `park-market:${response.parkId}`,
          accountId: context.accountId,
          message,
        });
        return {
          ...item,
          envelope: undefined,
          content: plaintext.content,
          error: '',
        };
      } catch {
        return {
          ...item,
          envelope: undefined,
          content: '',
          error: '此设备无法解密该历史消息，请使用原设备或恢复密钥',
        };
      }
    });
    return {
      ...response,
      items,
      canRecoverMls:
        context.requiresMls &&
        Boolean(this.deps.mls) &&
        mlsItems.length > 0 &&
        response.writable,
    };
  }
}
