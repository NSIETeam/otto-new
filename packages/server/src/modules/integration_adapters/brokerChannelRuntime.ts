/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import WebSocket, { type RawData } from 'ws';
import type {
  ChannelHealth,
  ChannelInstallation,
  ChannelSendInput,
} from './channelConnector.js';
import type { ChannelRuntimeAdapterV1 } from './managedChannelConnector.js';

export interface BrokerInboundChannelMessage {
  messageId: string;
  tenantId: string;
  userId: string;
  text: string;
  receivedAtMs: number;
}

export interface BrokerChannelSocketV1 {
  on(event: 'open', listener: () => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'message', listener: (data: RawData | string) => void): this;
  send(data: string): void;
  close(): void;
}

export interface BrokerChannelRuntimeOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  createSocket?: (url: string, headers: Record<string, string>) => BrokerChannelSocketV1;
  onInbound: (
    installation: Readonly<ChannelInstallation>,
    message: Readonly<BrokerInboundChannelMessage>,
  ) => Promise<'ack' | 'hold'>;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

interface RuntimeCredential {
  brokerAccessToken: string;
  deviceId: string;
}

interface RuntimeState {
  installation: ChannelInstallation;
  credential: RuntimeCredential;
  socket?: BrokerChannelSocketV1;
  running: boolean;
  state: ChannelHealth['state'];
  reconnectCount: number;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  generation: number;
  lastReceivedAtMs?: number;
  lastSentAtMs?: number;
  message?: string;
}

function normalizeBaseUrl(value: string): URL {
  const url = new URL(value);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !loopback) {
    throw new Error('managed channel runtime must use HTTPS');
  }
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url;
}

function parseCredential(value: string): RuntimeCredential {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('managed channel credential is invalid'); }
  if (!parsed || typeof parsed !== 'object') throw new Error('managed channel credential is invalid');
  const input = parsed as Record<string, unknown>;
  const brokerAccessToken = typeof input.brokerAccessToken === 'string'
    ? input.brokerAccessToken.trim() : '';
  const deviceId = typeof input.deviceId === 'string' ? input.deviceId.trim() : '';
  if (!brokerAccessToken || !deviceId || deviceId.length > 200) {
    throw new Error('managed channel credential is invalid');
  }
  return { brokerAccessToken, deviceId };
}

export class BrokerChannelRuntimeV1 implements ChannelRuntimeAdapterV1 {
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly createSocket: NonNullable<BrokerChannelRuntimeOptions['createSocket']>;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly states = new Map<string, RuntimeState>();

  constructor(private readonly options: BrokerChannelRuntimeOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.createSocket = options.createSocket ?? ((url, headers) =>
      new WebSocket(url, { headers }) as BrokerChannelSocketV1);
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  }

  async start(
    installation: Readonly<ChannelInstallation>,
    plaintextCredential: string,
  ): Promise<ChannelHealth> {
    const existing = this.states.get(installation.installationId);
    if (existing?.running && existing.state === 'connected') return this.snapshot(existing);
    const state: RuntimeState = existing ?? {
      installation: { ...installation, grantedScopes: [...installation.grantedScopes] },
      credential: parseCredential(plaintextCredential),
      running: true,
      state: 'reconnecting',
      reconnectCount: 0,
      generation: 0,
    };
    state.credential = parseCredential(plaintextCredential);
    state.running = true;
    state.state = 'reconnecting';
    this.states.set(installation.installationId, state);
    await this.connect(state);
    return this.snapshot(state);
  }

  async stop(installationId: string): Promise<ChannelHealth> {
    const state = this.requireState(installationId);
    state.running = false;
    state.state = 'stopped';
    state.generation += 1;
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    state.reconnectTimer = undefined;
    state.socket?.close();
    state.socket = undefined;
    return this.snapshot(state);
  }

  health(installationId: string): Promise<ChannelHealth> {
    return Promise.resolve(this.snapshot(this.requireState(installationId)));
  }

  async revoke(
    installation: Readonly<ChannelInstallation>,
    plaintextCredential: string,
  ): Promise<void> {
    const credential = parseCredential(plaintextCredential);
    const state = this.states.get(installation.installationId);
    if (state) await this.stop(installation.installationId);
    await this.request(
      credential,
      'DELETE',
      `/v1/channel-installations/${installation.installationId}`,
    );
    if (state) {
      state.state = 'revoked';
      this.states.delete(installation.installationId);
    }
  }

  async send(
    installation: Readonly<ChannelInstallation>,
    plaintextCredential: string,
    input: Readonly<ChannelSendInput>,
  ): Promise<{ providerMessageId: string }> {
    const credential = parseCredential(plaintextCredential);
    const result = await this.request(
      credential,
      'POST',
      `/v1/channel-installations/${installation.installationId}/messages`,
      input,
      input.idempotencyKey,
    );
    if (!result || typeof result !== 'object' || typeof (result as { providerMessageId?: unknown }).providerMessageId !== 'string') {
      throw new Error('managed channel broker returned invalid message receipt');
    }
    const providerMessageId = (result as { providerMessageId: string }).providerMessageId.trim();
    if (!providerMessageId) throw new Error('managed channel broker returned invalid message receipt');
    const state = this.states.get(installation.installationId);
    if (state) state.lastSentAtMs = Date.now();
    return { providerMessageId };
  }

  private connect(state: RuntimeState): Promise<void> {
    const generation = ++state.generation;
    const wsUrl = new URL(this.baseUrl.toString());
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl.pathname = `/v1/channel-installations/${encodeURIComponent(state.installation.installationId)}/stream`;
    wsUrl.searchParams.set('device_id', state.credential.deviceId);
    const socket = this.createSocket(wsUrl.toString(), {
      authorization: `Bearer ${state.credential.brokerAccessToken}`,
    });
    state.socket = socket;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.close();
        reject(new Error('managed channel connection timed out'));
      }, this.connectTimeoutMs);
      timer.unref?.();
      socket.on('open', () => {
        if (generation !== state.generation) return;
        clearTimeout(timer);
        settled = true;
        state.state = 'connected';
        state.message = undefined;
        resolve();
      });
      socket.on('message', (data) => void this.handleMessage(state, socket, generation, data));
      socket.on('error', (error) => {
        state.message = error.message;
        if (!settled) {
          clearTimeout(timer);
          settled = true;
          reject(new Error('managed channel connection failed'));
        }
      });
      socket.on('close', () => {
        if (generation !== state.generation || !state.running) return;
        state.state = 'reconnecting';
        this.scheduleReconnect(state);
      });
    });
  }

  private scheduleReconnect(state: RuntimeState): void {
    if (state.reconnectTimer || !state.running) return;
    state.reconnectCount += 1;
    const delay = Math.min(60_000, 1_000 * 2 ** Math.min(6, state.reconnectCount - 1));
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = undefined;
      void this.connect(state).catch(() => {
        if (state.running) this.scheduleReconnect(state);
      });
    }, delay);
    state.reconnectTimer.unref?.();
  }

  private async handleMessage(
    state: RuntimeState,
    socket: BrokerChannelSocketV1,
    generation: number,
    data: RawData | string,
  ): Promise<void> {
    if (generation !== state.generation || !state.running) return;
    const bytes = typeof data === 'string'
      ? Buffer.from(data)
      : Array.isArray(data)
        ? Buffer.concat(data)
        : data instanceof ArrayBuffer
          ? Buffer.from(new Uint8Array(data))
          : Buffer.from(data);
    if (bytes.length > 64 * 1024) return;
    let input: unknown;
    try { input = JSON.parse(bytes.toString('utf8')); } catch { return; }
    if (!input || typeof input !== 'object') return;
    const frame = input as Record<string, unknown>;
    if (
      frame.type !== 'message' ||
      typeof frame.messageId !== 'string' || !frame.messageId.trim() || frame.messageId.length > 200 ||
      typeof frame.tenantId !== 'string' || frame.tenantId !== state.installation.tenantId ||
      typeof frame.userId !== 'string' || !frame.userId.trim() || frame.userId.length > 200 ||
      typeof frame.text !== 'string' || !frame.text.trim() || frame.text.length > 20_000 ||
      typeof frame.receivedAtMs !== 'number' || !Number.isFinite(frame.receivedAtMs)
    ) return;
    const message: BrokerInboundChannelMessage = {
      messageId: frame.messageId.trim(),
      tenantId: frame.tenantId,
      userId: frame.userId.trim(),
      text: frame.text,
      receivedAtMs: frame.receivedAtMs,
    };
    const decision = await this.options.onInbound(state.installation, message).catch(() => 'hold' as const);
    state.lastReceivedAtMs = Date.now();
    if (decision === 'ack' && state.socket === socket) {
      socket.send(JSON.stringify({ type: 'ack', messageId: message.messageId }));
    }
  }

  private async request(
    credential: RuntimeCredential,
    method: 'POST' | 'DELETE',
    requestPath: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timeout.unref?.();
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(requestPath, this.baseUrl).toString(), {
        method,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${credential.brokerAccessToken}`,
          'x-otto-device-id': credential.deviceId,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Error('managed channel broker request timed out');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new Error(`managed channel broker request failed (${response.status})`);
    if (response.status === 204) return undefined;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 64 * 1024) throw new Error('managed channel broker response is too large');
    try { return JSON.parse(bytes.toString('utf8')) as unknown; }
    catch { throw new Error('managed channel broker returned invalid JSON'); }
  }

  private requireState(installationId: string): RuntimeState {
    const state = this.states.get(installationId);
    if (!state) throw new Error('managed channel runtime is not started');
    return state;
  }

  private snapshot(state: RuntimeState): ChannelHealth {
    return {
      installationId: state.installation.installationId,
      running: state.running,
      state: state.state,
      reconnectCount: state.reconnectCount,
      ...(state.lastReceivedAtMs ? { lastReceivedAtMs: state.lastReceivedAtMs } : {}),
      ...(state.lastSentAtMs ? { lastSentAtMs: state.lastSentAtMs } : {}),
      ...(state.message ? { message: state.message } : {}),
    };
  }
}
