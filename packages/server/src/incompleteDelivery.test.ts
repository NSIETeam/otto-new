import { expect, it } from 'vitest';
import {
  incompleteDelivery,
  unverifiedDeliveryText,
} from './incompleteDelivery.js';
it('retains natively observed readable output links even if the last model draft omits them', () => {
  const result = incompleteDelivery('尚需修正第二份文件。', {
    missing: [{ id: 'second', label: '第二份文件缺失', status: 'not_run' }], blocked: false,
  }, [{ id: 'a', label: '报告.json', path: '/repo/report.json', verified: true },
      { id: 'b', label: '坏文件.json', path: '/repo/bad.json', verified: false }]);
  expect(result).toContain('[报告.json](</repo/report.json>)');
  expect(result).not.toContain('bad.json');
  expect(result).toContain('尚未完成验收');
});
it('keeps meaningful intermediate findings but identifies them as provisional', () => {
  expect(unverifiedDeliveryText('全部完成。')).toBe('');
  expect(unverifiedDeliveryText('已定位原因。\n[补丁](</repo/fix.ts>)')).toBe(
    '以下为尚未验收的过程说明：\n\n已定位原因。\n[补丁](</repo/fix.ts>)',
  );
});
it('preserves partial findings, citations and artifact links while clearly withholding completion', () => {
  const text = incompleteDelivery(
    '全部完成。\n\n已修复登录。下载 [结果](</repo/result.json>)。\n来源：[说明](https://example.com)',
    {
      missing: [{ id: 'x', label: '登录过期测试', status: 'not_run' }],
      blocked: true,
      blockers: ['需要确认文件访问权限'],
    },
  );
  expect(text).toContain('尚未完成验收');
  expect(text).toContain('[结果](</repo/result.json>)');
  expect(text).toContain('[说明](https://example.com)');
  expect(text).toContain('需要确认文件访问权限');
  expect(text).not.toContain('全部完成');
  expect(text).not.toContain('已有文件');
});
