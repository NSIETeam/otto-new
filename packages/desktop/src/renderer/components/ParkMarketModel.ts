/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
export interface MarketForm {
  title: string;
  category: string;
  saleMode: 'sale' | 'free';
  price: string;
  rememberedPrice: string;
  negotiable: boolean;
  condition: string;
  functionStatus: string;
  faultDescription: string;
  description: string;
  handoverArea: string;
  handoverTime: string;
  imageIds: string[];
}
export const emptyMarketForm = (): MarketForm => ({
  title: '',
  category: '',
  saleMode: 'sale',
  price: '',
  rememberedPrice: '',
  negotiable: false,
  condition: '',
  functionStatus: '',
  faultDescription: '',
  description: '',
  handoverArea: '',
  handoverTime: '',
  imageIds: [],
});
export function switchMarketSaleMode(
  form: MarketForm,
  mode: 'sale' | 'free',
): MarketForm {
  if (form.saleMode === mode) return form;
  return mode === 'free'
    ? {
        ...form,
        saleMode: mode,
        price: '0',
        rememberedPrice: form.price,
        negotiable: false,
      }
    : { ...form, saleMode: mode, price: form.rememberedPrice };
}
export function marketFormErrors(form: MarketForm): Record<string, string> {
  const count = (value: string) =>
    [
      ...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(
        value.trim(),
      ),
    ].length;
  const errors: Record<string, string> = {};
  for (const [field, min, max, label] of [
    ['title', 2, 40, '标题'],
    ['description', 5, 2000, '说明'],
    ['handoverArea', 2, 50, '交接区域'],
  ] as const)
    if (count(form[field]) < min || count(form[field]) > max)
      errors[field] = `${label}需要 ${min}–${max} 字`;
  if (
    !['electronics', 'office', 'home', 'sports', 'books', 'other'].includes(
      form.category,
    )
  )
    errors.category = '请选择分类';
  if (!['unused', 'like_new', 'used', 'worn'].includes(form.condition))
    errors.condition = '请选择成色';
  if (!['working', 'faulty', 'untested'].includes(form.functionStatus))
    errors.functionStatus = '请选择功能状态';
  if (
    form.functionStatus === 'faulty' &&
    (count(form.faultDescription) < 2 || count(form.faultDescription) > 500)
  )
    errors.faultDescription = '请用 2–500 字说明故障';
  if (
    form.saleMode === 'sale' &&
    (!/^\d{1,6}(?:\.\d{1,2})?$/.test(form.price) ||
      Number(form.price) <= 0 ||
      Number(form.price) > 999999.99)
  )
    errors.price = '售价须为 0.01–999999.99 元，最多两位小数';
  if (count(form.handoverTime) > 100)
    errors.handoverTime = '方便交接时间最多 100 字';
  if (!form.imageIds.length || form.imageIds.length > 9)
    errors.imageIds = '请上传 1–9 张有效图片';
  return errors;
}
export function selectMarketImages<T>(files: T[], occupied: number) {
  const remaining = Math.max(0, 9 - occupied);
  return {
    accepted: files.slice(0, remaining),
    rejected: files.slice(remaining),
  };
}
export function moveMarketImage(ids: string[], from: string, to: string) {
  const origin = ids.indexOf(from);
  const destination = ids.indexOf(to);
  if (origin < 0 || destination < 0 || origin === destination) return ids;
  const next = [...ids];
  next.splice(origin, 1);
  next.splice(destination, 0, from);
  return next;
}
