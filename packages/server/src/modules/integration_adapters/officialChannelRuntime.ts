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
const MAX_RESPONSE_BYTES = 64 * 1024;
type JsonRequest = (url: string, init: RequestInit) => Promise<Record<string, unknown>>;

/**
 * Isolated adapter for pinned dingtalk-stream 2.1.7-beta.1. Its getEndpoint
 * follows redirects and accepts arbitrary socket URLs. Override only that
 * public hook; keep SDK callback, heartbeat and reconnect behavior intact.
 * The SDK has no URL setter: fail closed if its own writable slot changes.
 */
export function bindDingTalkConnectionTransport(
  client: DWClient,
  request: JsonRequest,
  isActive: () => boolean,
): void {
  const slot = Object.getOwnPropertyDescriptor(client, 'dw_url');
  if (!slot?.writable) throw new Error('unsupported DingTalk SDK transport contract');
  client.getEndpoint = async () => {
    if (!isActive()) throw new Error('official channel connection cancelled');
    const body = await request('https://api.dingtalk.com/v1.0/gateway/connections/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        clientId: client.config.clientId,
        clientSecret: client.config.clientSecret,
        ua: client.config.ua,
        subscriptions: client.config.subscriptions,
      }),
    });
    if (!isActive()) throw new Error('official channel connection cancelled');
    let endpoint: URL;
    try { endpoint = new URL(typeof body.endpoint === 'string' ? body.endpoint : ''); }
    catch { throw new Error('invalid DingTalk connection endpoint'); }
    // Official Stream host; adding a regional host requires explicit review.
    if (endpoint.protocol !== 'wss:' || endpoint.hostname !== 'wss-open-connection.dingtalk.com'
      || endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error('invalid DingTalk connection endpoint');
    }
    const ticket = body.ticket;
    if (typeof ticket !== 'string' || !ticket.trim() || ticket.length > 2_048
      || [...ticket].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
      throw new Error('invalid DingTalk connection ticket');
    }
    client.config.endpoint = endpoint.toString();
    endpoint.searchParams.set('ticket', ticket);
    if (!Reflect.set(client, 'dw_url', endpoint.toString())) {
      throw new Error('unsupported DingTalk SDK transport contract');
    }
    return client;
  };
}
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
  cancelConnect?: (error?: Error) => void;
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
    state.cancelConnect?.();
    state.client.disconnect();
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
    if (!state.running || this.snapshot(state).state !== 'connected') throw new Error('official channel is not connected');
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
      if (!state.running || state.state !== 'connected') return;
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
      }).catch(() => { state.message = '企业微信消息处理失败，请在本机任务页核对。'; });
    });
    client.on('reconnecting', (attempt) => {
      if (!state.running) return;
      state.state = 'reconnecting'; state.reconnectCount = attempt;
    });
    client.on('disconnected', () => {
      state.state = state.running ? 'reconnecting' : 'stopped';
      state.message = state.running ? '企业微信连接已断开，正在重新连接。' : '企业微信连接已停止。';
    });
    client.on('error', () => { state.message = '企业微信连接异常，请检查网络及机器人授权。'; });
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
    bindDingTalkConnectionTransport(client, (url, init) => this.request(url, init), () => state.running);
    client.registerCallbackListener(TOPIC_ROBOT, async (event: DWClientDownStream) => {
      if (!state.running || !client.connected) return;
      const acknowledge = (): void => client.socketCallBackResponse(event.headers.messageId, { status: EventAck.SUCCESS });
      let body: RobotTextMessage;
      try { body = JSON.parse(event.data) as RobotTextMessage; }
      catch { acknowledge(); return; }
      if (body.msgtype !== 'text' || !body.msgId || !body.senderStaffId || !body.text?.content) {
        acknowledge(); return;
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
      if (state.running && outcome === 'ack') acknowledge();
    });
    return this.waitForConnected(state, (connected) => {
      void client.connect().then(() => {
        // This SDK deliberately resolves after caught network/auth failures.
        if (!client.connected) throw new Error('official channel connection failed');
        connected();
      }).catch(() => {
        state.cancelConnect?.(new Error('official channel connection failed'));
      });
    });
  }

  private async sendDingTalk(credential: Credential, input: Readonly<ChannelSendInput>): Promise<string> {
    const tokenBody = await this.request('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appKey: credential.id, appSecret: credential.secret }),
    });
    const token = typeof tokenBody.accessToken === 'string' ? tokenBody.accessToken : '';
    if (!token) throw new Error('DingTalk access token request failed');
    const body = await this.request('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
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
        msgParam: JSON.stringify({ title: 'Otto', text: input.text }),
      }),
    });
    return typeof body.processQueryKey === 'string' ? body.processQueryKey : '';
  }

  private async request(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    const target = new URL(url);
    if (target.origin !== 'https://api.dingtalk.com' || target.username || target.password) {
      throw new Error('official channel endpoint is invalid');
    }
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer!: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('official channel request timed out'));
        controller.abort();
        void reader?.cancel().catch(() => undefined);
      }, this.requestTimeoutMs);
      timer.unref?.();
    });
    const responseBody = async (): Promise<Record<string, unknown>> => {
      const response = await this.fetchImpl(target, { ...init, signal: controller.signal, redirect: 'error' });
      if (!response.ok || response.redirected) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error(`official channel request failed (${response.status})`);
      }
      reader = response.body?.getReader();
      if (!reader) throw new Error('official channel response body is missing');
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          void reader.cancel().catch(() => undefined);
          throw new Error('official channel response is too large');
        }
        chunks.push(value);
      }
      if (controller.signal.aborted) throw new Error('official channel request timed out');
      let parsed: unknown;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new Error('official channel response is invalid'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('official channel response is invalid');
      }
      return parsed as Record<string, unknown>;
    };
    try { return await Promise.race([responseBody(), deadline]); }
    catch (error) {
      // Provider/network errors must not echo credential bodies or URL tickets.
      const message = error instanceof Error ? error.message : '';
      if (/^official channel (?:request (?:timed out|failed \(\d{3}\))|response (?:body is missing|is too large|is invalid))$/u.test(message)) {
        throw new Error(message);
      }
      throw new Error('official channel request failed');
    }
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
      const fail = (error = new Error('official channel connection cancelled')): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        state.running = false;
        state.state = 'stopped';
        state.cancelConnect = undefined;
        state.client.disconnect();
        reject(error);
      };
      const timer = setTimeout(() => {
        fail(new Error('official channel connection timed out'));
      }, this.connectTimeoutMs);
      timer.unref?.();
      state.cancelConnect = fail;
      subscribe(() => {
        if (!state.running) return;
        state.state = 'connected'; state.connectedAtMs = Date.now();
        if (settled) return;
        settled = true; clearTimeout(timer);
        state.cancelConnect = undefined;
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
    if (state.running && state.installation.provider === 'dingtalk') {
      state.state = (state.client as DWClient).connected ? 'connected' : 'reconnecting';
    }
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
