/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { PolicySource } from './contracts.js';
// Official host directory verified 2026-09-08 against Beijing government footer:
// https://www.beijing.gov.cn/images/public_foot_response_2020.js
// HTTPS only, no redirect downgrade. This is an entry-point inventory, NOT an
// assertion that every province/city/county document has been ingested.
const provinces = [
  ['beijing', '北京市', 'www.beijing.gov.cn'],
  ['tianjin', '天津市', 'www.tj.gov.cn'],
  ['hebei', '河北省', 'www.hebei.gov.cn'],
  ['shanxi', '山西省', 'www.shanxi.gov.cn'],
  ['neimenggu', '内蒙古自治区', 'www.nmg.gov.cn'],
  ['liaoning', '辽宁省', 'www.ln.gov.cn'],
  ['jilin', '吉林省', 'www.jl.gov.cn'],
  ['heilongjiang', '黑龙江省', 'www.hlj.gov.cn'],
  ['shanghai', '上海市', 'www.shanghai.gov.cn'],
  ['jiangsu', '江苏省', 'www.jiangsu.gov.cn'],
  ['zhejiang', '浙江省', 'www.zj.gov.cn'],
  ['anhui', '安徽省', 'www.ah.gov.cn'],
  ['fujian', '福建省', 'www.fujian.gov.cn'],
  ['jiangxi', '江西省', 'www.jiangxi.gov.cn'],
  ['shandong', '山东省', 'www.shandong.gov.cn'],
  ['henan', '河南省', 'www.henan.gov.cn'],
  ['hubei', '湖北省', 'www.hubei.gov.cn'],
  ['hunan', '湖南省', 'www.hunan.gov.cn'],
  ['guangdong', '广东省', 'www.gd.gov.cn'],
  ['guangxi', '广西壮族自治区', 'www.gxzf.gov.cn'],
  ['hainan', '海南省', 'www.hainan.gov.cn'],
  ['chongqing', '重庆市', 'www.cq.gov.cn'],
  ['sichuan', '四川省', 'www.sc.gov.cn'],
  ['guizhou', '贵州省', 'www.guizhou.gov.cn'],
  ['yunnan', '云南省', 'www.yn.gov.cn'],
  ['xizang', '西藏自治区', 'www.xizang.gov.cn'],
  ['shaanxi', '陕西省', 'www.shaanxi.gov.cn'],
  ['gansu', '甘肃省', 'www.gansu.gov.cn'],
  ['qinghai', '青海省', 'www.qinghai.gov.cn'],
  ['ningxia', '宁夏回族自治区', 'www.nx.gov.cn'],
  ['xinjiang', '新疆维吾尔自治区', 'www.xinjiang.gov.cn'],
] as const;
export const nationalProvinceSources: PolicySource[] = provinces.map(
  ([id, province, host]) => ({
    id: `province-${id}`,
    name: `${province}政府政策入口`,
    listUrl: `https://${host}/`,
    allowedHosts: [host],
    level: ['beijing', 'tianjin', 'shanghai', 'chongqing'].includes(id)
      ? 'city'
      : 'province',
    region: { country: 'CN', province },
    discovery: 'portal',
  }),
);
