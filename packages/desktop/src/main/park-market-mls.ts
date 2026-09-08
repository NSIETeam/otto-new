/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { createHash, verify } from 'node:crypto';
import { join } from 'node:path';
import {
  FileMlsStatePersistence,
  ParkMlsNativeKernel,
  type ParkMlsAuthority,
  type ParkMlsPackage,
} from '@otto/native';
import type {
  EnterpriseE2eeCrypto,
  EnterpriseE2eeDeviceBundle,
} from './enterprise-e2ee.js';
export interface MarketMlsContext {
  crypto: EnterpriseE2eeCrypto;
  accountId: string;
  organizationId: string;
  serverScope: string;
  serverUrl: string;
}
export interface MarketMlsPacket {
  encryption: 'mls';
  messageId: string;
  deviceId: string;
  signature: string;
  payload: {
    conversationId: string;
    generation: number;
    groupId: string;
    epoch: number;
    ciphertext: string;
    eventId: string;
    attachments?: Array<{ id: string; nonce: string; ciphertextSize: number }>;
  };
  senderScope?: string;
  authority?: ParkMlsAuthority;
}
interface Session {
  generation: number;
  state: string;
  authority: ParkMlsAuthority;
  groupId: string | null;
  welcome: string | null;
  reference: string | null;
  initialization: { leaseId: string; packages: ParkMlsPackage[] } | null;
}
interface State {
  generation: number | null;
  sessions: Session[];
}
export class ParkMarketMls {
  private kernel: ParkMlsNativeKernel | null = null;
  private identity = '';
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private options: {
      directory: string;
      binaryPath?: string;
      protect(value: string): string;
      unprotect(value: string): string;
      context(): MarketMlsContext;
      request(body: Record<string, unknown>): Promise<unknown>;
    },
  ) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private check(context: MarketMlsContext) {
    const latest = this.options.context();
    if (
      context.serverUrl !== latest.serverUrl ||
      context.accountId !== latest.accountId ||
      context.organizationId !== latest.organizationId
    )
      throw new Error('账号已切换，请重新打开咨询');
  }
  private async ready(context: MarketMlsContext) {
    this.check(context);
    const deviceId = context.crypto.localDevice(
      context.serverScope,
      context.accountId,
    ).deviceId;
    const scope = {
      serverUrl: context.serverUrl,
      organizationId: context.organizationId,
      accountId: context.accountId,
      deviceId,
    };
    const identity = createHash('sha256')
      .update(JSON.stringify(scope))
      .digest('hex');
    if (identity !== this.identity || !this.kernel) {
      await this.kernel?.close();
      this.kernel = new ParkMlsNativeKernel(
        scope,
        new FileMlsStatePersistence({
          filePath: join(this.options.directory, `${identity}.json`),
          protectStateKey: this.options.protect,
          unprotectStateKey: this.options.unprotect,
        }),
        this.options.binaryPath,
      );
      this.identity = identity;
    }
    return this.kernel;
  }
  private async command(
    context: MarketMlsContext,
    action: 'package' | 'state' | 'activate',
    payload: Record<string, unknown>,
  ) {
    this.check(context);
    const result = await this.options.request({
      action,
      payload,
      ...context.crypto.signParkMarketMls({ ...context, action, payload }),
    });
    this.check(context);
    return result;
  }
  private async inventory(
    context: MarketMlsContext,
    kernel: ParkMlsNativeKernel,
  ) {
    let usable = 0;
    for (const key of await kernel.listKeyPackages()) {
      // An expired native package must never acquire a fresh server lease.
      // Keep its private key for any previously issued, delayed welcome.
      if (!key.publishable) continue;
      const response = (await this.command(context, 'package', {
        device_scope: kernel.deviceScope,
        ...key,
      })) as { usable: boolean };
      if (response.usable) usable++;
    }
    while (usable < 5) {
      const key = await kernel.createKeyPackage();
      await this.command(context, 'package', {
        device_scope: kernel.deviceScope,
        ...key,
      });
      usable++;
    }
  }
  activate() {
    return this.serial(async () => {
      const context = this.options.context();
      const kernel = await this.ready(context);
      await this.inventory(context, kernel);
    });
  }
  close() {
    return this.serial(async () => {
      await this.kernel?.close();
      this.kernel = null;
      this.identity = '';
    });
  }
  private async synchronize(
    context: MarketMlsContext,
    kernel: ParkMlsNativeKernel,
    conversationId: string,
    members?: string[],
    recoverGeneration?: number,
  ) {
    let state = (await this.command(context, 'state', {
      conversationId,
      deviceScope: kernel.deviceScope,
      prepare: !!members,
      ...(recoverGeneration === undefined ? {} : { recoverGeneration }),
    })) as State;
    const known = await kernel.generations();
    for (const session of state.sessions) {
      if (session.authority.conversation_id !== conversationId)
        throw new Error('咨询密钥会话不匹配');
      if (
        members &&
        session.generation === state.generation &&
        JSON.stringify(session.authority.members) !== JSON.stringify(members)
      )
        throw new Error('咨询设备目录已变化，请重试');
      if (session.initialization) {
        const invite = await kernel.create(
          session.authority,
          session.initialization.packages,
        );
        await this.command(context, 'activate', {
          conversationId,
          deviceScope: kernel.deviceScope,
          generation: session.generation,
          leaseId: session.initialization.leaseId,
          groupId: invite.group_id,
          welcome: invite.welcome,
        });
      } else if (
        !known.some(
          (g) =>
            g.authority.conversation_id === conversationId &&
            g.authority.generation === session.generation,
        ) &&
        session.reference &&
        session.welcome &&
        session.groupId
      ) {
        try {
          await kernel.join(
            session.authority,
            session.reference,
            session.groupId,
            session.welcome,
          );
        } catch (error) {
          if (members && session.generation === state.generation) throw error;
          // Other generations remain readable; the message view labels unavailable history.
        }
      }
    }
    state = (await this.command(context, 'state', {
      conversationId,
      deviceScope: kernel.deviceScope,
    })) as State;
    return state;
  }
  recover(
    context: MarketMlsContext,
    conversationId: string,
    devices: Array<EnterpriseE2eeDeviceBundle & { organizationId: string }>,
  ) {
    return this.serial(async () => {
      const kernel = await this.ready(context);
      await this.inventory(context, kernel);
      const previous = (await this.command(context, 'state', {
        conversationId,
        deviceScope: kernel.deviceScope,
      })) as State;
      if (previous.generation === null)
        throw new Error('此会话尚无可恢复的 MLS 加密连接');
      const members = devices
        .filter((d) => d.approvalState === 'approved' && !d.revokedAt)
        .map(
          (d) =>
            `${kernel.deviceScope.split('/')[0]}/${d.organizationId}/${d.accountId}/${d.deviceId}`,
        )
        .sort();
      await this.synchronize(
        context,
        kernel,
        conversationId,
        members,
        previous.generation,
      );
      return { recovered: true };
    });
  }
  encrypt(
    context: MarketMlsContext,
    conversationId: string,
    messageId: string,
    text: string,
    devices: Array<EnterpriseE2eeDeviceBundle & { organizationId: string }>,
    attachments?: Array<{ id: string; nonce: string; ciphertextSize: number }>,
  ) {
    return this.serial(async (): Promise<MarketMlsPacket> => {
      const kernel = await this.ready(context);
      await this.inventory(context, kernel);
      const serverHash = kernel.deviceScope.split('/')[0];
      const members = devices
        .filter((d) => d.approvalState === 'approved' && !d.revokedAt)
        .map(
          (d) =>
            `${serverHash}/${d.organizationId}/${d.accountId}/${d.deviceId}`,
        )
        .sort();
      const state = await this.synchronize(
        context,
        kernel,
        conversationId,
        members,
      );
      const session = state.sessions.find(
        (s) => s.generation === state.generation && s.state === 'active',
      );
      if (!session) throw new Error('咨询加密正在准备，请稍后重试');
      const eventId = `${context.accountId}:${messageId}`;
      const encrypted = await kernel.encrypt(session.authority, eventId, text);
      const payload = {
        conversationId,
        generation: session.generation,
        groupId: encrypted.group_id,
        epoch: encrypted.epoch,
        ciphertext: encrypted.ciphertext,
        eventId,
        ...(attachments?.length ? { attachments } : {}),
      };
      return {
        encryption: 'mls',
        messageId,
        payload,
        ...context.crypto.signParkMarketMls({
          ...context,
          action: 'message',
          payload,
        }),
      };
    });
  }
  decrypt(
    context: MarketMlsContext,
    conversationId: string,
    messages: Array<{
      id: string;
      senderId: string;
      envelope: MarketMlsPacket;
    }>,
    devices: Array<EnterpriseE2eeDeviceBundle & { organizationId: string }>,
  ) {
    return this.serial(async () => {
      const kernel = await this.ready(context);
      const state = await this.synchronize(context, kernel, conversationId);
      const result = new Map<string, string>();
      for (const item of messages) {
        const packet = item.envelope;
        const payload = packet.payload;
        const sender = devices.find(
          (d) =>
            d.accountId === item.senderId && d.deviceId === packet.deviceId,
        );
        const session = state.sessions.find(
          (s) => s.generation === payload.generation,
        );
        if (
          !sender ||
          !session ||
          payload.conversationId !== conversationId ||
          payload.eventId !== `${item.senderId}:${item.id}` ||
          packet.messageId !== item.id ||
          payload.groupId !== session.groupId
        )
          continue;
        const signed = Buffer.from(
          JSON.stringify([
            'otto:park-market-mls:v1',
            'message',
            item.senderId,
            packet.deviceId,
            payload,
          ]),
        );
        if (
          !verify(
            null,
            signed,
            sender.identitySigningPublicKey,
            Buffer.from(packet.signature, 'base64'),
          )
        )
          continue;
        const senderScope = `${kernel.deviceScope.split('/')[0]}/${sender.organizationId}/${sender.accountId}/${sender.deviceId}`;
        try {
          result.set(
            item.id,
            await kernel.decrypt(
              session.authority,
              payload.eventId,
              senderScope,
              payload.ciphertext,
            ),
          );
        } catch {
          /* One unavailable generation must not hide readable messages. */
        }
      }
      this.check(context);
      return result;
    });
  }
}
