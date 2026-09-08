import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  installConfirmedSkillDraft,
  stageSkillDraft,
} from './skillDraftWorkflow.js';
import {
  describeSkillFunction,
  listSkillReleases,
  rollbackSkillRelease,
  recordSkillAcceptance,
  compareSkillReleases,
  withSkillReleaseLock,
} from './skillReleaseEvidence.js';

const roots: string[] = [];
async function root() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-skill-releases-'));
  roots.push(dir);
  return dir;
}
const markdown = (revision: number) => `---
name: report-helper
description: 将销售表整理成月报，列出异常数据，供负责人复核。
---
# 销售月报助手
## 需要你提供
- 销售明细表与统计月份
## 交付结果
- 可复核的销售月报（第 ${revision} 版）
## 适用范围
- 已授权的本地销售明细表
## 不适用与限制
- 不代替财务审核，不发送给外部人员
## 操作步骤
1. 核对输入与缺失字段，再计算合计并列出原始数据来源。
2. 缺少金额时询问用户，不编造数据；交付前核对输出文件及格式。
`;
async function install(
  dir: string,
  revision: number,
  mode: 'create' | 'enhance' = 'create',
) {
  const draft = await stageSkillDraft({
    userDir: dir,
    candidateId: `draft_report_${revision}`,
    name: 'report-helper',
    mode,
    files: [
      { path: 'SKILL.md', content: markdown(revision) },
      { path: 'references/template.txt', content: `template-${revision}` },
      ...(revision === 2
        ? [
            {
              path: 'scripts/new.cjs',
              content: "throw new Error('never execute')",
            },
          ]
        : []),
    ],
  });
  return installConfirmedSkillDraft(dir, draft);
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe('Skill 功能说明与版本证据', () => {
  it('从功能章节展示用途、输入、输出和限制，不把没有行为测试说成成功率', () => {
    const card = describeSkillFunction(markdown(1), 'report-helper');
    expect(card.title).toBe('销售月报助手');
    expect(card.inputs).toContain('销售明细表与统计月份');
    expect(card.outputs[0]).toContain('可复核的销售月报');
    expect(card.boundaries[0]).toContain('不代替财务审核');
  });
  it('保存完整上一版，回滚删除新版独有文件，保留当前版供再次恢复', async () => {
    const dir = await root();
    await install(dir, 1);
    await fs.writeFile(
      path.join(dir, 'skills/report-helper/profile.json'),
      '{"name":"月报专家"}',
    );
    const first = (await listSkillReleases(dir))[0].current;
    expect(first.acceptance).toEqual([]);
    await install(dir, 2, 'enhance');
    const before = (await listSkillReleases(dir))[0];
    expect(before.history[0].id).toBe(first.id);
    expect(compareSkillReleases(first, before.current).businessVerdict).toBe(
      'insufficient-evidence',
    );
    await rollbackSkillRelease(dir, {
      skillName: 'report-helper',
      versionId: first.id,
      expectedCurrentHash: before.current.id,
      confirmed: true,
    });
    expect(
      await fs.readFile(
        path.join(dir, 'skills/report-helper/references/template.txt'),
        'utf8',
      ),
    ).toBe('template-1');
    expect(
      await fs.readFile(
        path.join(dir, 'skills/report-helper/profile.json'),
        'utf8',
      ),
    ).toContain('月报专家');
    await expect(
      fs.access(path.join(dir, 'skills/report-helper/scripts/new.cjs')),
    ).rejects.toThrow();
    const after = (await listSkillReleases(dir))[0];
    expect(after.current.id).toBe(first.id);
    expect(
      after.history.some((version) => version.id === before.current.id),
    ).toBe(true);
  });
  it('拒绝过期确认、路径穿越、未确认以及被篡改的历史版本', async () => {
    const dir = await root();
    await install(dir, 1);
    const first = (await listSkillReleases(dir))[0].current;
    await install(dir, 2, 'enhance');
    const current = (await listSkillReleases(dir))[0].current;
    const input = {
      skillName: 'report-helper',
      versionId: first.id,
      expectedCurrentHash: current.id,
      confirmed: true as const,
    };
    await expect(
      rollbackSkillRelease(dir, { ...input, confirmed: false } as never),
    ).rejects.toThrow('确认');
    await expect(
      rollbackSkillRelease(dir, { ...input, skillName: '../escape' }),
    ).rejects.toThrow();
    await fs.appendFile(
      path.join(dir, 'skills/report-helper/SKILL.md'),
      '\n人工更改',
    );
    await expect(rollbackSkillRelease(dir, input)).rejects.toThrow('变化');
    await fs.appendFile(
      path.join(
        dir,
        'skill-versions/report-helper',
        first.id,
        'files/report-helper/SKILL.md',
      ),
      '\n篡改',
    );
    const changed = (await listSkillReleases(dir))[0];
    expect(changed.history).toEqual([]);
    expect(changed.warnings.join()).toContain('损坏');
    await expect(
      rollbackSkillRelease(dir, {
        ...input,
        expectedCurrentHash: changed.current.id,
      }),
    ).rejects.toThrow('损坏');
  });
  it('更新草稿预览后本地版本变化，禁止覆盖用户修改', async () => {
    const dir = await root();
    await install(dir, 1);
    const draft = await stageSkillDraft({
      userDir: dir,
      candidateId: 'draft_stale_update',
      name: 'report-helper',
      mode: 'enhance',
      files: [{ path: 'SKILL.md', content: markdown(2) }],
    });
    await fs.appendFile(
      path.join(dir, 'skills/report-helper/SKILL.md'),
      '\n人工更改',
    );
    await expect(installConfirmedSkillDraft(dir, draft)).rejects.toThrow(
      '变化',
    );
  });
  it('只有同案例、同输入、同验收标准、同环境的人工作业复核可比较；失败不被平均掩盖', async () => {
    const dir = await root();
    await install(dir, 1);
    const first = (await listSkillReleases(dir))[0].current;
    const trial = {
      skillName: 'report-helper',
      expectedCurrentHash: first.id,
      scenario: '缺少金额的销售表',
      input: 'A 商品金额为空',
      expected: '询问金额，不编造合计',
      actual: '直接给出合计 0',
      environment: 'Windows 11 / model-A / 本地表格 v1',
      verdict: 'failed' as const,
      confirmed: true as const,
    };
    await recordSkillAcceptance(dir, trial);
    await install(dir, 2, 'enhance');
    const current = (await listSkillReleases(dir))[0].current;
    await recordSkillAcceptance(dir, {
      ...trial,
      expectedCurrentHash: current.id,
      actual: '请补充 A 商品的金额',
      verdict: 'passed',
    });
    const report = (await listSkillReleases(dir))[0];
    const delta = compareSkillReleases(report.history[0], report.current);
    expect(delta.improved).toEqual(['缺少金额的销售表']);
    expect(delta.businessVerdict).toBe('improved-in-reviewed-cases');
    expect(report.current.acceptance[0].source).toBe('user-review');
    await recordSkillAcceptance(dir, {
      ...trial,
      expectedCurrentHash: current.id,
      actual: '调用另一模型后失败',
      environment: 'Windows 11 / model-B / 本地表格 v1',
    });
    const updated = (await listSkillReleases(dir))[0];
    expect(
      compareSkillReleases(updated.history[0], updated.current).businessVerdict,
    ).toBe('has-failures');
  });
  it('同一个 Skill 的发布操作互斥，其他 Skill 不被阻塞', async () => {
    const dir = await root();
    await withSkillReleaseLock(dir, 'report-helper', async () => {
      await expect(
        withSkillReleaseLock(dir, 'report-helper', async () => undefined),
      ).rejects.toThrow('正在');
      await withSkillReleaseLock(dir, 'other-skill', async () => undefined);
    });
    await withSkillReleaseLock(dir, 'report-helper', async () => undefined);
  });
  it('拒绝目录链接，不修改链接指向的其他目录', async () => {
    const dir = await root();
    const outside = await root();
    await fs.mkdir(path.join(dir, 'skills'));
    await fs.symlink(
      outside,
      path.join(dir, 'skills/report-helper'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(install(dir, 1)).rejects.toThrow('链接');
    expect(await fs.readdir(outside)).toEqual([]);
  });
  it('拒绝历史版本根的目录链接，不能跨目录回滚或写入复核', async () => {
    const dir = await root();
    const outside = await root();
    await fs.symlink(
      outside,
      path.join(dir, 'skill-versions'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(install(dir, 1)).rejects.toThrow('链接');
    expect(await fs.readdir(outside)).toEqual([]);
  });
  it('JSON 校验之外不把脚本存在或模型文本当作行为测试证据', async () => {
    const dir = await root();
    await install(dir, 1);
    const current = (await listSkillReleases(dir))[0].current;
    await expect(
      recordSkillAcceptance(dir, {
        skillName: 'report-helper',
        expectedCurrentHash: current.id,
        scenario: 'mock',
        input: '输入',
        expected: '结果',
        actual: '模型说通过',
        environment: 'model-A',
        verdict: 'passed',
        confirmed: false,
      } as never),
    ).rejects.toThrow('确认');
    expect((await listSkillReleases(dir))[0].current.acceptance).toHaveLength(
      0,
    );
  });
  it('重复试用保留失败记录，后一次成功不能抹掉同版本的失败', async () => {
    const dir = await root();
    await install(dir, 1);
    const current = (await listSkillReleases(dir))[0].current;
    const trial = {
      skillName: 'report-helper',
      expectedCurrentHash: current.id,
      scenario: '遗漏金额',
      input: '金额空白',
      expected: '先询问',
      actual: '编造金额',
      environment: 'model-A',
      verdict: 'failed' as const,
      confirmed: true as const,
    };
    await recordSkillAcceptance(dir, trial);
    await recordSkillAcceptance(dir, {
      ...trial,
      actual: '询问金额',
      verdict: 'passed',
    });
    const next = (await listSkillReleases(dir))[0].current;
    expect(next.acceptance).toHaveLength(2);
    expect(compareSkillReleases(current, next).businessVerdict).toBe(
      'has-failures',
    );
  });
});
