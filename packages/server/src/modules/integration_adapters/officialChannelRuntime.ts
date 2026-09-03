/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { WSClient, type TextMessage, type WsFrame } from '@wecom/aibot-node-sdk';
import {
  DWClient,
  EventAck,
  TOPIC_ROBOT,
  type DWClientDownStream,
  type RobotTextMessage,
} from 'dingtalk-stream';
import type { BrokerInboundChannelMessage } from './brokerChannelRuntime.js';
import type { ChannelHealth, ChannelInstallation, ChannelSendInput } from './channelConnector.js';
import type { ChannelRuntimeAdapterV1 } from './managedChannelConnector.js';

interface Credential { kind: 'wecom-aibot-v1' | 'dingtalk-stream-v1'; id: string; secret: string }
interface RuntimeState {
  installation: ChannelInstallation;
  client: WSClient | DWClient;
  running: boolean;
  state: ChannelHealth['state'];
  reconnectCount: number;
  startedAtMs: number;
  connectedAtMs?: number;
  lastReceivedAtMs?: number;
  lastSentAtMs?: number;
  message?: string;
}

export interface OfficialChannelRuntimeOptions {
  onInbound: (
    installation: Readonly<ChannelInstallation>,
    message: Readonly<BrokerInboundChannelMessage>,
  ) => Promise<'ack' | 'hold'>;
  fetchImpl?: typeof fetch;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

function parseCredential(raw: string): Credential {
  let value: Record<string, unknown>;
  try { value = JSON.parse(raw) as Record<string, unknown>; }
  catch { throw new Error('official channel credential is invalid'); }
  if (value.kind === 'wecom-aibot-v1') {
    const id = typeof value.botId === 'string' ? value.botId.trim() : '';
    const secret = typeof value.secret === 'string' ? value.secret.trim() : '';
    if (id && secret) return { kind: value.kind, id, secret };
  }
  if (value.kind === 'dingtalk-stream-v1') {
    const id = typeof value.clientId === 'string' ? value.clientId.trim() : '';
    const secret = typeof value.clientSecret === 'string' ? value.clientSecret.trim() : '';
    if (id && secret) return { kind: value.kind, id, secret };
  }
  throw new Error('official channel credential is invalid');
}

export class OfficialChannelRuntimeV1 implements ChannelRuntimeAdapterV1 {
  private readonly states = new Map<string, RuntimeState>();
  private readonly fetchImpl: typeof fetch;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: OfficialChannelRuntimeOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  }

  async start(installation: Readonly<ChannelInstallation>, plaintextCredential: string): Promise<ChannelHealth> {
    const credential = parseCredential(plaintextCredential);
    if ((installation.provider === 'wecom') !== (credential.kind === 'wecom-aibot-v1')) {
      throw new Error('official channel credential provider mismatch');
    }
    if (installation.provider !== 'wecom' && installation.provider !== 'dingtalk') {
      throw new Error('official channel runtime does not support this provider');
    }
    const prior = this.states.get(installation.installationId);
    if (prior?.running && prior.state === 'connected') return this.snapshot(prior);
    if (prior) await this.stop(installation.installationId);
    return credential.kind === 'wecom-aibot-v1'
      ? this.startWeCom(installation, credential)
      : this.startDingTalk(installation, credential);
  }

  async stop(installationId: string): Promise<ChannelHealth> {
    const state = this.require(installationId);
    state.running = false;
    state.state = 'stopped';
    if (state.client instanceof WSClient) state.client.disconnect();
    else state.client.disconnect();
    return this.snapshot(state);
  }

  health(installationId: string): Promise<ChannelHealth> {
    return Promise.resolve(this.snapshot(this.require(installationId)));
  }

  async revoke(installation: Readonly<ChannelInstallation>): Promise<void> {
    const state = this.states.get(installation.installationId);
    if (state) await this.stop(installation.installationId);
    throw new Error('provider does not expose remote credential revocation; remove the bot in provider admin');
  }

  async send(
    installation: Readonly<ChannelInstallation>,
    plaintextCredential: string,
    input: Readonly<ChannelSendInput>,
  ): Promise<{ providerMessageId: string }> {
    const credential = parseCredential(plaintextCredential);
    const state = this.require(installation.installationId);
    if (!state.running || state.state !== 'connected') throw new Error('official channel is not connected');
    let providerMessageId: string;
    if (credential.kind === 'wecom-aibot-v1') {
      const response = await (state.client as WSClient).sendMessage(input.target, {
        msgtype: 'markdown', markdown: { content: input.text },
      });
      providerMessageId = String(response.headers?.req_id ?? '').trim();
    } else {
      providerMessageId = await this.sendDingTalk(credential, input);
    }
    state.lastSentAtMs = Date.now();
    if (!providerMessageId) {
      throw new Error('provider accepted the request without a durable message receipt');
    }
    return { providerMessageId };
  }

  private startWeCom(
    installation: Readonly<ChannelInstallation>,
    credential: Credential,
  ): Promise<ChannelHealth> {
    const client = new WSClient({
      botId: credential.id,
      secret: credential.secret,
      maxReconnectAttempts: -1,
      maxAuthFailureAttempts: 3,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    const state = this.createState(installation, client);
    client.on('message.text', (frame: WsFrame<TextMessage>) => {
      const body = frame.body;
      if (!body?.msgid || !body.from?.userid || !body.text?.content) return;
      state.lastReceivedAtMs = Date.now();
      void this.options.onInbound(installation, {
        deviceId: installation.installationId,
        messageId: body.msgid,
        tenantId: installation.tenantId,
        userId: body.from.userid,
        text: body.text.content,
        receivedAtMs: body.create_time ? body.create_time * 1_000 : Date.now(),
      }).then((outcome) => {
        state.message = outcome === 'hold'
          ? `等待本机绑定企业微信用户：${body.from.userid}`
          : undefined;
      }).catch((error: unknown) => { state.message = error instanceof Error ? error.message : '企业微信消息处理失败'; });
    });
    client.on('reconnecting', (attempt) => {
      state.state = 'reconnecting'; state.reconnectCount = attempt;
    });
    client.on('disconnected', (reason) => { state.state = state.running ? 'reconnecting' : 'stopped'; state.message = reason; });
    client.on('error', (error) => { state.message = error.message; });
    const ready = this.waitForConnected(state, (resolve) => client.on('authenticated', resolve));
    client.connect();
    return ready;
  }

  private startDingTalk(
    installation: Readonly<ChannelInstallation>,
    credential: Credential,
  ): Promise<ChannelHealth> {
    const client = new DWClient({
      clientId: credential.id,
      clientSecret: credential.secret,
      keepAlive: true,
      autoReconnect: true,
      maxPendingEventHandlers: 20,
      maxPendingCallbackHandlers: 20,
      subscriptions: [{ type: 'CALLBACK', topic: TOPIC_ROBOT }],
    });
    const state = this.createState(installation, client);
    client.registerAllEventListener(async (event: DWClientDownStream) => {
      if (event.headers.topic !== TOPIC_ROBOT) return { status: EventAck.SUCCESS };
      let body: RobotTextMessage;
      try { body = JSON.parse(event.data) as RobotTextMessage; }
      catch { return { status: EventAck.SUCCESS }; }
      if (body.msgtype !== 'text' || !body.msgId || !body.senderStaffId || !body.text?.content) {
        return { status: EventAck.SUCCESS };
      }
      state.lastReceivedAtMs = Date.now();
      const outcome = await this.options.onInbound(installation, {
        deviceId: installation.installationId,
        messageId: body.msgId,
        tenantId: installation.tenantId,
        userId: body.senderStaffId,
        text: body.text.content,
        receivedAtMs: body.createAt || Date.now(),
      });
      state.message = outcome === 'hold'
        ? `等待本机绑定钉钉用户：${body.senderStaffId}`
        : undefined;
      return { status: outcome === 'ack' ? EventAck.SUCCESS : EventAck.LATER };
    });
    return client.connect().then(() => {
      state.state = 'connected'; state.connectedAtMs = Date.now();
      return this.snapshot(state);
    });
  }

  private async sendDingTalk(credential: Credential, input: Readonly<ChannelSendInput>): Promise<string> {
    const tokenResponse = await this.request('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appKey: credential.id, appSecret: credential.secret }),
    });
    const tokenBody = await tokenResponse.json() as { accessToken?: unknown };
    const token = typeof tokenBody.accessToken === 'string' ? tokenBody.accessToken : '';
    if (!tokenResponse.ok || !token) throw new Error('DingTalk access token request failed');
    const response = await this.request('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-acs-dingtalk-access-token': token,
        'idempotency-key': input.idempotencyKey,
      },
      body: JSON.stringify({
        robotCode: credential.id,
        userIds: [input.target],
        msgKey: 'sampleMarkdown',
        msgParam: JSON.stringify({ title: 'ClawMaster', text: input.text }),
      }),
    });
    const body = await response.json() as { processQueryKey?: unknown };
    if (!response.ok) throw new Error(`DingTalk message send failed (${response.status})`);
    return typeof body.processQueryKey === 'string' ? body.processQueryKey : '';
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timer.unref?.();
    try { return await this.fetchImpl(url, { ...init, signal: controller.signal }); }
    finally { clearTimeout(timer); }
  }

  private createState(installation: Readonly<ChannelInstallation>, client: WSClient | DWClient): RuntimeState {
    const state: RuntimeState = {
      installation: { ...installation, grantedScopes: [...installation.grantedScopes] },
      client, running: true, state: 'reconnecting', reconnectCount: 0, startedAtMs: Date.now(),
    };
    this.states.set(installation.installationId, state);
    return state;
  }

  private waitForConnected(state: RuntimeState, subscribe: (resolve: () => void) => void): Promise<ChannelHealth> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('official channel connection timed out'));
      }, this.connectTimeoutMs);
      timer.unref?.();
      subscribe(() => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        state.state = 'connected'; state.connectedAtMs = Date.now();
        resolve(this.snapshot(state));
      });
    });
  }

  private require(installationId: string): RuntimeState {
    const state = this.states.get(installationId);
    if (!state) throw new Error('official channel runtime was not started');
    return state;
  }

  private snapshot(state: RuntimeState): ChannelHealth {
    return {
      installationId: state.installation.installationId,
      running: state.running,
      state: state.state,
      reconnectCount: state.reconnectCount,
      startedAtMs: state.startedAtMs,
      ...(state.connectedAtMs ? { connectedAtMs: state.connectedAtMs } : {}),
      ...(state.lastReceivedAtMs ? { lastReceivedAtMs: state.lastReceivedAtMs } : {}),
      ...(state.lastSentAtMs ? { lastSentAtMs: state.lastSentAtMs } : {}),
      ...(state.message ? { message: state.message } : {}),
    };
  }
}
