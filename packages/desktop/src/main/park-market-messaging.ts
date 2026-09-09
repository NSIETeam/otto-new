import { readFileSync, writeFileSync, unlinkSync, readdirSync, lstatSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { ParkMarketMls, MarketMlsPacket } from './park-market-mls.js';
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import type {
  EnterpriseE2eeCrypto,
  EnterpriseE2eeDeviceBundle,
  EnterpriseE2eeKeyTransparencyView,
  EnterpriseE2eeSendPayload,
  EnterpriseE2eeWireMessage,
  EnterpriseE2eePlainAttachmentUpload,
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
type AttachmentView = { id: string; nonce: string; ciphertextSize: number };
type StoredEnvelope = Omit<EnterpriseE2eeSendPayload, 'attachments'> & {
  attachments: AttachmentView[];
  senderIdentitySigningPublicKey?: string;
};
function discardUploads(uploads: Array<{ file: string }>) {
  for (const upload of uploads) {
    try {
      unlinkSync(upload.file);
    } catch {
      /* A failed filesystem deletion contains ciphertext only. */
    }
  }
}
function pruneInterruptedUploads(directory:string,records:Array<Record<string,unknown>>) {
  const referenced=new Set(records.flatMap(record=>Array.isArray(record.uploads)?record.uploads.flatMap(upload=>typeof upload?.file==='string'?[basename(upload.file)]:[]):[]));
  let deleted=0;
  for(const entry of readdirSync(directory,{withFileTypes:true})){
    if(deleted>=100)break;
    if(!entry.isFile() || referenced.has(entry.name))continue;
    const file=join(directory,entry.name);
    try{if(Date.now()-lstatSync(file).mtimeMs>=86400000){unlinkSync(file);deleted++;}}catch{/* Missing or unavailable cache files never invalidate a pending send. */}
  }
}
export class ParkMarketMessaging {
  private downloads = new Map<
    string,
    { message: EnterpriseE2eeWireMessage; parkId: string }
  >();
  constructor(
    private deps: {
      context(): Context;
      ensureDevice(): Promise<unknown>;
      request(
        path: string,
        method?: 'GET' | 'POST',
        body?: Record<string, unknown>,
      ): Promise<unknown>;
      uploadAttachment?(input: {
        path: string;
        method: 'POST';
        attachmentBase64: string;
        attachmentProof: {
          deviceId: string;
          signature: string;
          payload: Record<string, unknown>;
        };
      }): Promise<unknown>;
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
    attachments?: EnterpriseE2eePlainAttachmentUpload[];
  }) {
    if (
      !input ||
      !['listing', 'conversation', 'reply'].includes(input.kind) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.id) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId)
    )
      throw new Error('咨询参数无效');
    const files = input.attachments ?? [];
    if (
      !Array.isArray(files) ||
      files.length > 6 ||
      (files.length && input.kind !== 'conversation')
    )
      throw new Error('首次问题和接受前回复不能附带文件；正常聊天最多6个附件');
    for (const file of files)
      if (
        !file ||
        typeof file.fileName !== 'string' ||
        !file.fileName.trim() ||
        file.fileName.length > 255 ||
        typeof file.mimeType !== 'string' ||
        file.mimeType.length > 200 ||
        !Number.isSafeInteger(file.size) ||
        file.size < 1 ||
        file.size > 10 * 1024 * 1024 ||
        typeof file.data !== 'string' ||
        file.data.length > 14_000_000
      )
        throw new Error('每个聊天附件限10MB');
    if (files.length && !this.deps.uploadAttachment)
      throw new Error('当前客户端缺少安全附件上传能力');
    const question = input.question.trim();
    const length = [
      ...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(
        question,
      ),
    ].length;
    if (
      (!length && !files.length) ||
      length > (input.kind === 'listing' ? 500 : 4000)
    )
      throw new Error(
        input.kind === 'listing'
          ? '首次问题需要 1–500 字'
          : '消息最多4000字，可附带文件',
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
    pruneInterruptedUploads(this.deps.pending.attachmentDirectory(this.scope(context)),saved);
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
      const encrypted =
        !context.requiresMls || files.length
          ? context.crypto.encryptMessage({
              serverScope: context.serverScope,
              organizationId: `park-market:${prepared.parkId}`,
              senderAccountId: context.accountId,
              recipientAccountId: prepared.peerId,
              messageId: input.requestId,
              content: question,
              contentType: 'message',
              devices,
              attachments: files,
            })
          : null;
      const uploads: Array<{
        id: string;
        file: string;
        nonce: string;
        ciphertextSize: number;
        sha256: string;
      }> = [];
      let retained = false;
      try {
        for (const attachment of encrypted?.attachments ?? []) {
          const bytes = Buffer.from(attachment.ciphertext, 'base64');
          const file = join(
            this.deps.pending.attachmentDirectory(this.scope(context)),
            attachment.id,
          );
          writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
          uploads.push({
            id: attachment.id,
            file,
            nonce: attachment.nonce,
            ciphertextSize: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          });
        }
        const references = uploads.map(({ id, nonce, ciphertextSize }) => ({
          id,
          nonce,
          ciphertextSize,
        }));
        const stored = encrypted
          ? { ...encrypted, attachments: references }
          : null;
        // With attachments the entire existing E2EE key envelope is carried INSIDE
        // the native MLS application message. No attachment key escapes MLS, and
        // the server cannot downgrade this packet to the legacy transport.
        const envelope = context.requiresMls
          ? await this.deps.mls!.encrypt(
              context,
              prepared.conversationId,
              input.requestId,
              files.length
                ? JSON.stringify({
                    format: 'otto:market-attachments:v1',
                    envelope: stored,
                  })
                : question,
              devices,
              references,
            )
          : stored;
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
        pending = {
          id: input.requestId,
          fingerprint,
          path,
          body,
          uploads,
          conversationId: prepared.conversationId,
        };
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
          retained = true;
        }
      } finally {
        if (!retained) discardUploads(uploads);
      }
    }
    this.check(context);
    let result: unknown;
    try {
      for (const upload of (pending.uploads ?? []) as Array<{
        id: string;
        file: string;
        sha256: string;
      }>) {
        this.check(context);
        const bytes = readFileSync(upload.file);
        if (createHash('sha256').update(bytes).digest('hex') !== upload.sha256)
          throw new Error('待重试附件损坏，未发送');
        const payload = {
          id: upload.id,
          conversationId: pending.conversationId,
          messageId: input.requestId,
          sha256: upload.sha256,
        };
        const proof = {
          payload,
          ...context.crypto.signParkMarketMls({
            ...context,
            action: 'attachment-upload',
            payload,
          }),
        };
        await this.deps.uploadAttachment!({
          path: `/chat-attachments/${upload.id}`,
          method: 'POST',
          attachmentBase64: bytes.toString('base64'),
          attachmentProof: proof,
        });
      }

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
        discardUploads((pending.uploads ?? []) as Array<{ file: string }>);
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
    discardUploads((pending.uploads ?? []) as Array<{ file: string }>);
    return result;
  }
  async download(
    conversationId: string,
    messageId: string,
    sequence: number,
    attachmentId: string,
  ) {
    const context = this.deps.context();
    await this.messages(conversationId, sequence + 1);
    this.check(context);
    const entry = this.downloads.get(
      `${JSON.stringify(this.scope(context))}:${messageId}:${attachmentId}`,
    );
    if (!entry) throw new Error('此设备不能解密该附件，请在原设备查看');
    const payload = { id: attachmentId };
    const proof = {
      payload,
      ...context.crypto.signParkMarketMls({
        ...context,
        action: 'attachment-read',
        payload,
      }),
    };
    const result = (await this.deps.request(
      `/chat-attachments/${attachmentId}/read`,
      'POST',
      proof,
    )) as { data: string };
    this.check(context);
    const attachment = entry.message.attachments.find(
      (a) => a.id === attachmentId,
    )!;
    return context.crypto.decryptAttachment({
      serverScope: context.serverScope,
      organizationId: `park-market:${entry.parkId}`,
      accountId: context.accountId,
      message: entry.message,
      attachment: {
        id: attachmentId,
        nonce: attachment.nonce,
        ciphertext: result.data,
      },
    });
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
    const decryptEnvelope = (
      item: EncryptedMessage,
      envelope: StoredEnvelope,
    ) => {
      const sender = devices.find(
        (d) =>
          d.accountId === item.senderId &&
          d.deviceId === envelope.senderDeviceId,
      );
      if (
        !sender ||
        (envelope.senderIdentitySigningPublicKey &&
          sender.identitySigningPublicKey !==
            envelope.senderIdentitySigningPublicKey)
      )
        throw new Error('发送设备无法通过身份校验');
      const message: EnterpriseE2eeWireMessage = {
        ...envelope,
        senderIdentitySigningPublicKey: sender.identitySigningPublicKey,
        id: item.id,
        senderAccountId: item.senderId,
        recipientAccountId: item.recipientId,
        createdAt: new Date(item.createdAt).toISOString(),
        readAt:
          item.readAt === null ? null : new Date(item.readAt).toISOString(),
        attachments: envelope.attachments ?? [],
      };
      const plaintext = context.crypto.decryptMessage({
        serverScope: context.serverScope,
        organizationId: `park-market:${response.parkId}`,
        accountId: context.accountId,
        message,
      });
      for (const attachment of plaintext.attachments)
        this.downloads.set(
          `${JSON.stringify(this.scope(context))}:${item.id}:${attachment.id}`,
          { message, parkId: response.parkId },
        );
      while (this.downloads.size > 1200)
        this.downloads.delete(this.downloads.keys().next().value!);
      return { content: plaintext.content, attachments: plaintext.attachments };
    };
    const items = response.items.map((item) => {
      try {
        const packet = item.envelope as unknown as MarketMlsPacket;
        let plaintext: {
          content: string;
          attachments: Array<{
            id: string;
            fileName: string;
            mimeType: string;
            size: number;
          }>;
        };
        if (packet.encryption === 'mls') {
          const text = mlsContent.get(item.id);
          if (text === undefined)
            throw new Error('此设备无法解密该历史消息，请使用原设备');
          if (packet.payload.attachments?.length) {
            const wrapped = JSON.parse(text);
            if (
              wrapped.format !== 'otto:market-attachments:v1' ||
              JSON.stringify(wrapped.envelope?.attachments) !==
                JSON.stringify(packet.payload.attachments)
            )
              throw new Error('附件加密上下文不一致');
            plaintext = decryptEnvelope(item, wrapped.envelope);
          } else plaintext = { content: text, attachments: [] };
        } else
          plaintext = decryptEnvelope(
            item,
            item.envelope as unknown as StoredEnvelope,
          );
        return { ...item, envelope: undefined, ...plaintext, error: '' };
      } catch {
        return {
          ...item,
          envelope: undefined,
          content: '',
          attachments: [],
          error: '此设备无法解密该历史消息或附件，请使用原设备',
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
