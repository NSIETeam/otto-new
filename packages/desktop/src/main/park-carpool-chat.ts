/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  FileMlsStatePersistence,
  ParkMlsNativeKernel,
  type MlsDeviceScope,
} from '@otto/native';
import type {
  CarpoolWorkflowView,
  ParkTransportCommand,
  ParkTransportResult,
  ParkTransportView,
} from 'otto-server';

export interface ParkChatView {
  conversationId: string;
  status: string;
  generation: number;
  canSend: boolean;
  unavailableHistoryCount: number;
  failedMessageCount: number;
  messages: Array<{
    id: string;
    text: string;
    senderAccountId: string;
    senderDisplayName?: string;
    own: boolean;
    createdAt: string;
    sequence: number;
    pending: boolean;
  }>;
}
interface Options {
  stateDirectory: string;
  binaryPath?: string;
  secureStorage: {
    assertAvailable(): void;
    protect(value: string): string;
    unprotect(value: string): string;
  };
  onWorkflow?(workflow: CarpoolWorkflowView): void;
  client: {
    getParkCarpoolWorkflow(): Promise<CarpoolWorkflowView>;
    executeParkCarpoolTransport(
      command: ParkTransportCommand,
    ): Promise<ParkTransportResult>;
  };
}
/** Independent park authorization and MLS storage; enterprise-private scope rules stay unchanged. */
export class ParkCarpoolChat {
  private kernel: ParkMlsNativeKernel | null = null;
  private persistence: FileMlsStatePersistence | null = null;
  private scope: MlsDeviceScope | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private identityEpoch = 0;
  constructor(private readonly options: Options) {}
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
  async activate(
    scope: MlsDeviceScope & { approvalState: string },
  ): Promise<void> {
    await this.close();
    if (scope.approvalState !== 'approved')
      throw new Error('同行加密设备尚未获批准');
    this.options.secureStorage.assertAvailable();
    const identity = createHash('sha256')
      .update(JSON.stringify(scope))
      .digest('hex');
    this.scope = scope;
    this.kernel = new ParkMlsNativeKernel(
      scope,
      (this.persistence = new FileMlsStatePersistence({
        filePath: path.join(this.options.stateDirectory, `${identity}.json`),
        protectStateKey: (value) => {
          this.options.secureStorage.assertAvailable();
          return this.options.secureStorage.protect(value);
        },
        unprotectStateKey: (value) => {
          this.options.secureStorage.assertAvailable();
          return this.options.secureStorage.unprotect(value);
        },
      })),
      this.options.binaryPath,
    );
    await this.serial(() => this.inventory());
  }
  async clearLocalData(): Promise<void> {
    const scope = this.scope;
    const persistence = this.persistence;
    await this.close();
    await persistence?.clear();
    this.persistence = null;
    if (scope) {
      await this.activate({ ...scope, approvalState: 'approved' });
      this.start();
    }
  }
  start(): void {
    this.stopped = false;
    const epoch = this.identityEpoch;
    const tick = async () => {
      if (this.stopped || epoch !== this.identityEpoch) return;
      try {
        const workflow = await this.options.client.getParkCarpoolWorkflow();
        if (this.stopped || epoch !== this.identityEpoch) return;
        this.options.onWorkflow?.(workflow);
        await this.serial(async () => {
          if (this.kernel && epoch === this.identityEpoch) {
            const current = await this.options.client.getParkCarpoolWorkflow();
            if (this.kernel && epoch === this.identityEpoch)
              await this.kernel.retainConversations(
                current.conversations.map((conversation) => conversation.id),
              );
          }
        });
        for (const conversation of workflow.conversations) {
          if (this.stopped) break;
          if (conversation.status !== 'blocked')
            await this.read(conversation.id, false);
        }
      } catch {
        /* Explicit foreground reads expose errors and retain pending encrypted messages. */
      }
      if (!this.stopped && epoch === this.identityEpoch) {
        this.timer = setTimeout(() => void tick(), 15_000);
        this.timer.unref?.();
      }
    };
    if (!this.timer) {
      this.timer = setTimeout(() => void tick(), 1_000);
      this.timer.unref?.();
    }
  }
  async close(): Promise<void> {
    this.stopped = true;
    this.identityEpoch += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.queue;
    await this.kernel?.close();
    this.kernel = null;
    this.scope = null;
  }
  private ready() {
    if (!this.kernel || !this.scope)
      throw new Error('同行加密尚未就绪，请登录并批准当前设备');
    return { kernel: this.kernel, scope: this.scope };
  }
  private async inventory(): Promise<void> {
    const { kernel, scope } = this.ready();
    let usable = 0;
    for (const key of await kernel.listKeyPackages()) {
      const result = await this.options.client.executeParkCarpoolTransport({
        type: 'publish_key',
        deviceId: scope.deviceId,
        deviceScope: kernel.deviceScope,
        reference: key.reference,
        keyPackage: key.key_package,
        expired: !key.publishable,
      });
      if ('usable' in result && result.usable) usable += 1;
      else if ('retirable' in result && result.retirable)
        await kernel.retireKeyPackages([key.reference]);
    }
    while (usable < 5) {
      const key = await kernel.createKeyPackage();
      await this.options.client.executeParkCarpoolTransport({
        type: 'publish_key',
        deviceId: scope.deviceId,
        deviceScope: kernel.deviceScope,
        reference: key.reference,
        keyPackage: key.key_package,
      });
      usable += 1;
    }
  }
  private async state(conversationId: string): Promise<ParkTransportView> {
    const result = await this.options.client.executeParkCarpoolTransport({
      type: 'state',
      deviceId: this.ready().scope.deviceId,
      conversationId,
    });
    if (!result.sessions) throw new Error('同行加密服务返回了无效状态');
    return result as ParkTransportView;
  }
  private async synchronize(
    conversationId: string,
    markRead: boolean,
  ): Promise<ParkChatView> {
    const { kernel, scope } = this.ready();
    await this.inventory();
    let remote = await this.state(conversationId);
    const known = await kernel.generations();
    const packages = await kernel.listKeyPackages();
    for (const session of remote.sessions) {
      const exists = known.some(
        (g) =>
          g.authority.conversation_id === conversationId &&
          g.authority.generation === session.authority.generation,
      );
      if (session.initialization) {
        // Native create is idempotent, including a restart after Welcome persistence.
        const invitation = await kernel.create(
          session.authority,
          session.initialization.packages,
        );
        await this.options.client.executeParkCarpoolTransport({
          type: 'activate',
          deviceId: scope.deviceId,
          conversationId,
          generation: session.authority.generation,
          leaseId: session.initialization.leaseId,
          groupId: invitation.group_id,
          welcome: invitation.welcome,
        });
      } else if (
        !exists &&
        session.welcome &&
        session.reference &&
        session.groupId
      ) {
        if (packages.some((key) => key.reference === session.reference))
          await kernel.join(
            session.authority,
            session.reference,
            session.groupId,
            session.welcome,
          );
      }
    }
    remote = await this.state(conversationId);
    const local = await kernel.generations();
    let unavailableHistoryCount = 0;
    let failedMessageCount = 0;
    for (const event of remote.events) {
      if (
        !local.some(
          (g) =>
            g.authority.conversation_id === conversationId &&
            g.authority.generation === event.generation,
        )
      ) {
        unavailableHistoryCount += 1;
        continue;
      }
      const session = remote.sessions.find(
        (s) => s.authority.generation === event.generation,
      );
      if (!session) throw new Error('消息缺少授权密钥代次');
      try {
        await kernel.decrypt(
          session.authority,
          event.id,
          event.sender,
          event.ciphertext,
        );
      } catch {
        failedMessageCount += 1;
      }
    }
    // Native encryption persists before network writes. Retry only the current authorized generation.
    const active = remote.sessions.find(
      (s) =>
        s.authority.generation === remote.generation && s.status === 'active',
    );
    const messages: ParkChatView['messages'] = [];
    for (const session of remote.sessions) {
      if (
        !local.some(
          (g) =>
            g.authority.conversation_id === conversationId &&
            g.authority.generation === session.authority.generation,
        )
      )
        continue;
      for (const message of await kernel.history(session.authority)) {
        let event = remote.events.find((e) => e.id === message.event_id);
        if (
          !event &&
          message.sender === kernel.deviceScope &&
          session === active &&
          remote.status === 'active'
        ) {
          const receipt = await this.options.client.executeParkCarpoolTransport(
            {
              type: 'append',
              deviceId: scope.deviceId,
              conversationId,
              generation: session.authority.generation,
              eventId: message.event_id,
              groupId: message.group_id,
              epoch: message.epoch,
              ciphertext: message.ciphertext,
            },
          );
          if ('event' in receipt) event = receipt.event;
        }
        if (!event && message.sender !== kernel.deviceScope) continue;
        messages.push({
          id: message.event_id,
          text: message.plaintext,
          senderAccountId: message.sender.split('/')[2]!,
          senderDisplayName: (() => {
            const participant = remote.participants.find(
              (participant) =>
                participant.accountId === message.sender.split('/')[2],
            );
            return participant
              ? `${participant.displayName} · ${participant.role}`
              : '已离开的同行成员';
          })(),
          own: message.sender.split('/')[2] === scope.accountId,
          createdAt: event?.createdAt ?? '',
          sequence: event?.sequence ?? Number.MAX_SAFE_INTEGER,
          pending: !event,
        });
      }
    }
    messages.sort((a, b) => a.sequence - b.sequence);
    if (markRead && remote.events.length)
      await this.options.client.executeParkCarpoolTransport({
        type: 'read',
        deviceId: scope.deviceId,
        conversationId,
        sequence: Math.max(...remote.events.map((e) => e.sequence)),
      });
    return {
      conversationId,
      status: remote.status,
      generation: remote.generation,
      canSend:
        remote.writeEnabled &&
        remote.status === 'active' &&
        Boolean(active) &&
        local.some(
          (g) =>
            g.authority.conversation_id === conversationId &&
            g.authority.generation === remote.generation,
        ),
      messages,
      unavailableHistoryCount,
      failedMessageCount,
    };
  }
  recover(
    conversationId: string,
    expectedGeneration: number,
  ): Promise<ParkChatView> {
    return this.serial(async () => {
      await this.inventory();
      await this.options.client.executeParkCarpoolTransport({
        type: 'rekey',
        deviceId: this.ready().scope.deviceId,
        conversationId,
        expectedGeneration,
        availableReferences: (await this.ready().kernel.listKeyPackages()).map(
          (key) => key.reference,
        ),
      });
      return this.synchronize(conversationId, false);
    });
  }
  read(conversationId: string, markRead = true): Promise<ParkChatView> {
    return this.serial(() => this.synchronize(conversationId, markRead));
  }
  send(
    conversationId: string,
    text: string,
    eventId: string = randomUUID(),
  ): Promise<ParkChatView> {
    return this.serial(async () => {
      if (!text.trim() || text.length > 4000)
        throw new Error('消息需为 1–4000 字');
      const view = await this.synchronize(conversationId, false);
      if (!view.canSend)
        throw new Error('同行会话正在准备密钥或已归档，暂时不能发送');
      const { kernel, scope } = this.ready();
      const remote = await this.state(conversationId);
      const session = remote.sessions.find(
        (s) =>
          s.authority.generation === remote.generation && s.status === 'active',
      );
      if (!session) throw new Error('同行会话密钥尚未就绪');
      const encrypted = await kernel.encrypt(
        session.authority,
        eventId,
        text.trim(),
      );
      await this.options.client.executeParkCarpoolTransport({
        type: 'append',
        deviceId: scope.deviceId,
        conversationId,
        generation: session.authority.generation,
        eventId,
        groupId: encrypted.group_id,
        epoch: encrypted.epoch,
        ciphertext: encrypted.ciphertext,
      });
      return this.synchronize(conversationId, false);
    });
  }
}
