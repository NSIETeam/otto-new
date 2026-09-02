/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared park-service form contract.
 *
 * The right-panel forms and the conversation bridge deliberately consume the
 * same definitions so a field cannot silently become required in one surface
 * while remaining unknown to the other.
 */
export interface ParkServiceFormField {
  key: string;
  label: string;
  placeholder: string;
  options?: Array<string | { value: string; label: string }>;
  inputType?: 'text' | 'date' | 'time' | 'number' | 'textarea';
  min?: number;
  max?: number;
  allowCustom?: boolean;
}

export const COMMON_SERVICE_FORM_FIELDS: readonly ParkServiceFormField[] = [
  { key: 'company', label: '公司名称', placeholder: '请输入公司名称' },
  { key: 'roomNumber', label: '房间号', placeholder: '请输入门牌或房间号' },
  { key: 'contact', label: '联系人', placeholder: '请输入联系人姓名' },
  { key: 'phone', label: '联系电话', placeholder: '请输入联系电话' },
] as const;

const COMMON_SERVICE_FORM_KEYS = new Set(COMMON_SERVICE_FORM_FIELDS.map((field) => field.key));

export const PARK_SERVICE_FORM_FIELDS: Readonly<Record<string, readonly ParkServiceFormField[]>> = {
  renovation: [
    { key: 'area', label: '装修区域', placeholder: '例如：A 座 1203 室' },
    { key: 'startDate', label: '计划开工日期', placeholder: '请选择计划开工日期', inputType: 'date' },
  ],
  parking: [
    { key: 'applicationType', label: '申请内容', placeholder: '请选择停车办理内容', options: [
      { value: 'underground-fixed', label: '地下固定停车位 · 260 元/月' },
      { value: 'underground-tandem', label: '地下固定子母停车位 · 390 元/月' },
      { value: 'surface-temporary', label: '地上临时停车位 · 1200 元/半年' },
      { value: 'underground-temporary', label: '地下临时停车位 · 1560 元/半年' },
      { value: 'cancel', label: '退停车位' },
    ] },
    { key: 'quantity', label: '申请数量', placeholder: '请输入申请数量', inputType: 'number', min: 1 },
  ],
  'network-phone': [
    { key: 'businessType', label: '业务类型', placeholder: '请选择业务类型', options: [
      { value: 'phone-open', label: '开通电话 · 235 元/部，另收 35 元/月/部' },
      { value: 'caller-id', label: '来电显示 · 50 元/部，另收 5 元/月/部' },
      { value: 'number-hold', label: '停机保号 · 5 元/月/部' },
      { value: 'landline-stop', label: '固话停机' },
      { value: 'leased-line-15', label: '企业专线 15M · 500 元/月' },
      { value: 'leased-line-30', label: '企业专线 30M · 1000 元/月' },
      { value: 'leased-line-45', label: '企业专线 45M · 1600 元/月' },
      { value: 'leased-line-75', label: '企业专线 75M · 2900 元/月' },
    ] },
    { key: 'quantity', label: '工位或号码数量', placeholder: '请输入数量', inputType: 'number', min: 1 },
    { key: 'expectedDate', label: '期望开通日期', placeholder: '请选择期望开通日期', inputType: 'date' },
  ],
  'meeting-room': [
    { key: 'attendees', label: '参会人数', placeholder: '请输入人数', inputType: 'number', min: 1 },
    { key: 'meetingContent', label: '会议内容', placeholder: '请简要填写会议主题或内容', inputType: 'textarea' },
  ],
  'electric-card': [
    {
      key: 'chargingKwh',
      label: '充电度数',
      placeholder: '请输入充电度数（1.2 元/度）',
      inputType: 'number',
      min: 0.1,
    },
  ],
  repair: [
    { key: 'category', label: '报修类别', placeholder: '选择或输入报修类别', allowCustom: true, options: [
      '灯具维修', '配电维修', '暖通维修', '网络、电话故障维修', '园区车辆车牌变更',
    ] },
    { key: 'issue', label: '故障描述', placeholder: '请说明发生了什么问题', inputType: 'textarea' },
    { key: 'urgency', label: '紧急程度', placeholder: '请选择紧急程度', options: ['普通', '紧急', '影响办公'] },
  ],
  'vehicle-visit': [
    { key: 'visitDate', label: '来访日期', placeholder: '请选择来访日期', inputType: 'date' },
    { key: 'visitTime', label: '具体来访时间', placeholder: '请选择具体来访时间', inputType: 'time' },
    { key: 'reason', label: '拜访企业及事由', placeholder: '请填写拜访对象和事由', inputType: 'textarea' },
    { key: 'vehicleCount', label: '来访车辆数量', placeholder: '无车辆可填写 0', inputType: 'number', min: 0, max: 20 },
  ],
} as const;

export function serviceFormFields(serviceId: string): ParkServiceFormField[] {
  const specific = PARK_SERVICE_FORM_FIELDS[serviceId] ?? [];
  return [
    ...COMMON_SERVICE_FORM_FIELDS,
    ...specific.filter((field) => !COMMON_SERVICE_FORM_KEYS.has(field.key)),
  ].map((field) => ({ ...field, options: field.options ? [...field.options] : undefined }));
}

export function serviceOptionValue(
  option: NonNullable<ParkServiceFormField['options']>[number],
): string {
  return typeof option === 'string' ? option : option.value;
}

export function serviceOptionLabel(
  option: NonNullable<ParkServiceFormField['options']>[number],
): string {
  return typeof option === 'string' ? option : option.label;
}

export function serviceFormDisplayValue(field: ParkServiceFormField, value: string): string {
  const option = field.options?.find((candidate) => serviceOptionValue(candidate) === value);
  return option ? serviceOptionLabel(option) : value;
}
