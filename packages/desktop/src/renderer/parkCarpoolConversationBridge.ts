/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type {
  EnterpriseParkCarpoolIntent,
  EnterpriseParkCarpoolPlace,
  EnterpriseParkCarpoolPlaceSuggestion,
  EnterpriseParkCarpoolPublishInput,
  EnterpriseParkCarpoolState,
  EnterpriseParkCarpoolTravelOption,
} from '../preload/index.js';

interface DraftFields {
  originQuery?: string;
  destinationQuery?: string;
  departureTime?: string;
  flexibleMinutes?: number;
  travelOptions?: EnterpriseParkCarpoolTravelOption[];
}

interface PendingCarpoolDraft {
  scopeId: string;
  sessionId: string;
  phase: 'collecting' | 'confirming_publish' | 'confirming_stop';
  fields: DraftFields;
  resolved?: {
    origin: EnterpriseParkCarpoolPlace;
    destination: EnterpriseParkCarpoolPlace;
  };
  intentId?: string;
  expiresAt: number;
}

export class ParkCarpoolConversationRegistry {
  private readonly pending = new Map<string, PendingCarpoolDraft>();
  private key(scopeId: string, sessionId: string): string { return `${scopeId}:${sessionId}`; }
  get(scopeId: string, sessionId: string, now = Date.now()): PendingCarpoolDraft | undefined {
    const key = this.key(scopeId, sessionId);
    const value = this.pending.get(key);
    if (value && value.expiresAt <= now) {
      this.pending.delete(key);
      return undefined;
    }
    return value;
  }
  set(value: Omit<PendingCarpoolDraft, 'expiresAt'>, now = Date.now()): void {
    this.pending.set(this.key(value.scopeId, value.sessionId), {
      ...value,
      expiresAt: now + 30 * 60_000,
    });
  }
  clear(scopeId: string, sessionId: string): void {
    this.pending.delete(this.key(scopeId, sessionId));
  }
}

const CARPOOL_INTENT = /(?:我要|想|需要|帮我)?(?:拼车|找同路|找同行|搭车)|(?:同路|同行)(?:的人|伙伴)/u;
const MATCH_QUERY = /(?:查看|看看|刷新|有(?:没有)?|查找).{0,8}(?:拼车|同路|同行)(?:匹配|结果|伙伴|的人)?|(?:拼车|同行)匹配/u;
const STOP_INTENT = /(?:停止|取消|结束|不再)(?:寻找|查找)?(?:拼车|同行|同路)/u;
const NON_TODAY_REQUEST = /(?:明天|后天|下周|周[一二三四五六日天]|星期[一二三四五六日天])/u;

function shanghaiDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function parseFields(text: string, today: string): DraftFields {
  const fields: DraftFields = {};
  const route = text.match(/从\s*([^，,。；;]+?)\s*到\s*([^，,。；;]+?)(?=，|,|。|；|;|$)/u);
  if (route?.[1]?.trim()) fields.originQuery = route[1].trim();
  if (route?.[2]?.trim()) fields.destinationQuery = route[2].trim();
  const time = text.match(/(?:今天|今晚|晚上|下午)?\s*([01]?\d|2[0-3])\s*(?:[:：点时]\s*([0-5]?\d)\s*分?)?/u);
  if (time) {
    const hour = Number(time[1]);
    const minute = Number(time[2] ?? 0);
    fields.departureTime = `${today}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`;
  }
  const flexible = text.match(/(?:前后|提前或延后|可接受)\s*(\d{1,3})\s*分钟/u)?.[1];
  if (flexible) fields.flexibleMinutes = Math.min(120, Number(flexible));
  const travelOptions: EnterpriseParkCarpoolTravelOption[] = [];
  if (/(?:我有车|我开车|可以开车|顺路带人)/u.test(text)) travelOptions.push('driver');
  if (/(?:想搭车|我要搭车|乘坐同行|搭别人的车|搭车)/u.test(text)) travelOptions.push('rider');
  if (/(?:一起叫车|一起打车|共同叫车)/u.test(text)) travelOptions.push('shared_taxi');
  if (travelOptions.length) fields.travelOptions = travelOptions;
  return fields;
}

function mergeFields(current: DraftFields, patch: DraftFields): DraftFields {
  return { ...current, ...patch };
}

function missingFields(fields: DraftFields): string[] {
  return [
    ...(!fields.originQuery ? ['出发地'] : []),
    ...(!fields.destinationQuery ? ['目的地'] : []),
    ...(!fields.departureTime ? ['出发时间'] : []),
    ...(!fields.travelOptions?.length ? ['出行方式（我有车／搭车／一起叫车，可多选）'] : []),
  ];
}

function modeLabels(options: readonly EnterpriseParkCarpoolTravelOption[]): string {
  const labels: Record<EnterpriseParkCarpoolTravelOption, string> = {
    driver: '我有车（可以由我开车并顺路带人）',
    rider: '搭车',
    shared_taxi: '一起叫车',
  };
  return options.map((item) => labels[item]).join('、');
}

function departureLabel(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value));
}

function matchSummary(state: EnterpriseParkCarpoolState): string {
  if (!state.currentIntent || state.currentIntent.status !== 'active') {
    return '你当前没有正在寻找的同行意向。可以告诉我：“今天 18:30 从宏创园区南门到回龙观，想搭车”。';
  }
  if (!state.matches.length) {
    return `当前意向：${departureLabel(state.currentIntent.departureTime)} 从 ${state.currentIntent.origin.label} 到 ${state.currentIntent.destination.label}。\n暂时没有合适的同行伙伴；意向仍在有效期内，稍后可让我“刷新拼车匹配”。`;
  }
  const modes: Record<string, string> = {
    current_rides_candidate_vehicle: '你可以搭对方的车',
    candidate_rides_current_vehicle: '对方可以搭你的车',
    shared_taxi: '可以一起叫车',
  };
  const lines = state.matches.slice(0, 8).map((match, index) => (
    `${index + 1}. ${match.displayName} · ${match.organizationName} · 园区身份已认证\n`
    + `   约 ${match.overlapPercent}% 同路，时间相差 ${match.timeDifferenceMinutes} 分钟，共同方向约 ${(match.commonDistanceMeters / 1_000).toFixed(1)} 公里\n`
    + `   ${match.compatibleModes.map((mode) => modes[mode] ?? mode).join('；')}。${match.explanation}`
  ));
  return `找到 ${state.matches.length} 个同行结果，已按路线重合度排序：\n\n${lines.join('\n\n')}\n\n候选阶段不会展示精确住址、坐标或手机号。`;
}

function selectedPlace(suggestion: EnterpriseParkCarpoolPlaceSuggestion): EnterpriseParkCarpoolPlace {
  return { label: suggestion.label, coordinate: suggestion.coordinate };
}

export async function handleParkCarpoolConversation(input: {
  text: string;
  scopeId: string;
  sessionId: string;
  registry: ParkCarpoolConversationRegistry;
  getState(): Promise<EnterpriseParkCarpoolState>;
  searchPlaces(query: string, city?: string): Promise<EnterpriseParkCarpoolPlaceSuggestion[]>;
  publish(value: EnterpriseParkCarpoolPublishInput): Promise<EnterpriseParkCarpoolIntent>;
  stop(intentId: string): Promise<EnterpriseParkCarpoolIntent>;
  postMessage(role: 'user' | 'assistant', text: string): void;
  now?(): Date;
}): Promise<boolean> {
  const text = input.text.trim();
  const currentTime = input.now?.() ?? new Date();
  const pending = input.registry.get(input.scopeId, input.sessionId, currentTime.getTime());
  if ((pending || CARPOOL_INTENT.test(text)) && NON_TODAY_REQUEST.test(text)) {
    input.postMessage('assistant', '拼车助手首发版本只支持发布当天的单程同行意向，请改为今天的出发时间。');
    return true;
  }
  if (pending?.phase === 'confirming_publish') {
    if (/^(?:确认发布|确认|发布)$/u.test(text)) {
      const fields = pending.fields;
      const resolved = pending.resolved!;
      const intent = await input.publish({
        travelDate: shanghaiDate(currentTime),
        origin: resolved.origin,
        destination: resolved.destination,
        departureTime: fields.departureTime!,
        flexibleMinutes: fields.flexibleMinutes ?? 30,
        travelOptions: fields.travelOptions!,
      });
      input.registry.clear(input.scopeId, input.sessionId);
      input.postMessage('assistant', `同行意向已发布：${departureLabel(intent.departureTime)} 从 ${intent.origin.label} 到 ${intent.destination.label}，可接受前后 ${intent.flexibleMinutes} 分钟，方式为${modeLabels(intent.travelOptions)}。\n出现匹配后可说“刷新拼车匹配”。`);
      return true;
    }
    if (/^(?:取消|不发布|放弃)$/u.test(text)) {
      input.registry.clear(input.scopeId, input.sessionId);
      input.postMessage('assistant', '已取消，本次同行意向没有发布。');
      return true;
    }
  }
  if (pending?.phase === 'confirming_stop') {
    if (/^(?:确认停止|确认|停止)$/u.test(text)) {
      await input.stop(pending.intentId!);
      input.registry.clear(input.scopeId, input.sessionId);
      input.postMessage('assistant', '已停止寻找；你的同行意向不会再出现在新的匹配结果中。');
      return true;
    }
    if (/^(?:取消|继续寻找|不停止)$/u.test(text)) {
      input.registry.clear(input.scopeId, input.sessionId);
      input.postMessage('assistant', '已取消停止操作，当前同行意向继续有效。');
      return true;
    }
  }

  if (STOP_INTENT.test(text)) {
    const state = await input.getState();
    if (!state.currentIntent || state.currentIntent.status !== 'active') {
      input.postMessage('assistant', '你当前没有正在寻找的同行意向。');
      return true;
    }
    input.registry.set({
      scopeId: input.scopeId,
      sessionId: input.sessionId,
      phase: 'confirming_stop',
      fields: {},
      intentId: state.currentIntent.id,
    }, currentTime.getTime());
    input.postMessage('assistant', `将停止 ${departureLabel(state.currentIntent.departureTime)} 从 ${state.currentIntent.origin.label} 到 ${state.currentIntent.destination.label} 的同行意向。回复“确认停止”后才会执行；回复“取消”则继续寻找。`);
    return true;
  }
  if (MATCH_QUERY.test(text)) {
    input.postMessage('assistant', matchSummary(await input.getState()));
    return true;
  }

  if (!pending && !CARPOOL_INTENT.test(text)) return false;
  if (!pending) {
    const state = await input.getState();
    if (state.currentIntent?.status === 'active' && !/(?:修改|重新发布|更新)/u.test(text)) {
      input.postMessage('assistant', `${matchSummary(state)}\n\n如需改变路线或时间，请明确说“修改拼车信息”。`);
      return true;
    }
  }
  let fields = mergeFields(
    pending?.fields ?? {},
    parseFields(text, shanghaiDate(currentTime)),
  );
  if (pending?.phase === 'collecting' && Object.keys(parseFields(text, shanghaiDate(currentTime))).length === 0) {
    const missing = missingFields(fields);
    if (missing[0] === '出发地') fields = { ...fields, originQuery: text };
    else if (missing[0] === '目的地') fields = { ...fields, destinationQuery: text };
  }
  const missing = missingFields(fields);
  if (missing.length) {
    input.registry.set({
      scopeId: input.scopeId,
      sessionId: input.sessionId,
      phase: 'collecting',
      fields,
    }, currentTime.getTime());
    input.postMessage('assistant', `可以，我还需要：${missing.join('、')}。\n你也可以一次回复：“今天 18:30 从宏创园区南门到回龙观地铁站，想搭车或一起叫车，前后 30 分钟都可以”。`);
    return true;
  }
  if (Date.parse(fields.departureTime!) < currentTime.getTime() - 5 * 60_000) {
    input.registry.set({
      scopeId: input.scopeId,
      sessionId: input.sessionId,
      phase: 'collecting',
      fields: { ...fields, departureTime: undefined },
    }, currentTime.getTime());
    input.postMessage('assistant', '这个出发时间已经过去，请补充今天稍后的出发时间，例如“今天 18:30”。');
    return true;
  }
  const [origins, destinations] = await Promise.all([
    input.searchPlaces(fields.originQuery!, '北京'),
    input.searchPlaces(fields.destinationQuery!, '北京'),
  ]);
  if (!origins[0] || !destinations[0]) {
    input.registry.set({
      scopeId: input.scopeId,
      sessionId: input.sessionId,
      phase: 'collecting',
      fields,
    }, currentTime.getTime());
    input.postMessage('assistant', '有地点没有搜索到标准位置。请补充更明确的地标、小区或地址；本次不会使用模糊文本发布。');
    return true;
  }
  const resolved = {
    origin: selectedPlace(origins[0]),
    destination: selectedPlace(destinations[0]),
  };
  input.registry.set({
    scopeId: input.scopeId,
    sessionId: input.sessionId,
    phase: 'confirming_publish',
    fields,
    resolved,
  }, currentTime.getTime());
  input.postMessage('assistant', `请确认同行意向：\n- 出发地：${resolved.origin.label}${origins[0].district ? `（${origins[0].district}）` : ''}\n- 目的地：${resolved.destination.label}${destinations[0].district ? `（${destinations[0].district}）` : ''}\n- 时间：今天 ${departureLabel(fields.departureTime!)}，可接受前后 ${fields.flexibleMinutes ?? 30} 分钟\n- 方式：${modeLabels(fields.travelOptions!)}\n\n发布后，同园区且路线、时间符合条件的用户会看到脱敏意向。回复“确认发布”后才会执行；回复“取消”则不发布。`);
  return true;
}
