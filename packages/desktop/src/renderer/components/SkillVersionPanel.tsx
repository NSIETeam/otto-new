/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import React, { useState } from 'react';
import type {
  InstalledSkillReleases,
  SkillAcceptanceInput,
  SkillFunctionDescription,
  SkillRelease,
  SkillRollbackInput,
} from 'otto-server';
import './SkillVersionPanel.css';

export function SkillFunctionCard({
  value,
}: {
  value: SkillFunctionDescription;
}): React.JSX.Element {
  return (
    <div className="otto-skill-function">
      <p>{value.summary}</p>
      <dl>
        {(
          [
            ['你需要提供', value.inputs],
            ['你会得到', value.outputs],
            ['设计适用场景（不是验证结论）', value.scope],
            ['限制与不负责的事项', value.boundaries],
          ] as const
        ).map(([label, items]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              {items.length
                ? items.map((text) => <p key={text}>{text}</p>)
                : '尚未说明，请先补充后再使用。'}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function ReviewForm({
  skill,
  onRecord,
  onCancel,
  busy,
  seed,
}: {
  skill: InstalledSkillReleases;
  onRecord(input: SkillAcceptanceInput): void;
  onCancel(): void;
  busy: boolean;
  seed?: SkillRelease['acceptance'][number];
}): React.JSX.Element {
  const [form, setForm] = useState({
    scenario: seed?.scenario ?? '',
    input: seed?.input ?? '',
    expected: seed?.expected ?? '',
    actual: '',
    environment: seed?.environment ?? '',
  });
  const [verdict, setVerdict] = useState<'' | 'passed' | 'failed'>('');
  const [confirmed, setConfirmed] = useState(false);
  const ready =
    confirmed && verdict && Object.values(form).every((value) => value.trim());
  return (
    <form
      className="otto-skill-review"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && verdict)
          onRecord({
            ...form,
            skillName: skill.skillName,
            expectedCurrentHash: skill.current.id,
            verdict,
            confirmed: true,
          });
      }}
    >
      <h4>记录你实际试用的结果</h4>
      <p>
        这不是自动测试。请先在对话中使用此功能，再对照产物复核。只保存必要的脱敏样例，不填写密码或客户隐私。相同案例、输入、标准和环境才能比较版本。
      </p>
      {(
        [
          ['scenario', '试用场景'],
          ['input', '测试输入'],
          ['expected', '验收标准'],
          ['actual', '实际结果'],
          ['environment', '模型与运行环境'],
        ] as const
      ).map(([key, label]) => (
        <label key={key}>
          {label}
          <textarea
            aria-label={label}
            required
            maxLength={key === 'scenario' ? 200 : 4000}
            rows={key === 'scenario' || key === 'environment' ? 1 : 2}
            value={form[key]}
            onChange={(event) =>
              setForm({ ...form, [key]: event.target.value })
            }
          />
        </label>
      ))}
      <label>
        复核结论
        <select
          aria-label="复核结论"
          value={verdict}
          onChange={(event) => setVerdict(event.target.value as typeof verdict)}
        >
          <option value="">请选择实际结果</option>
          <option value="passed">达到本案例验收标准</option>
          <option value="failed">没有达到验收标准</option>
        </select>
      </label>
      <label className="otto-skill-check">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        我已亲自复核当前版本的实际输入与输出
      </label>
      <footer>
        <button type="submit" disabled={!ready || busy}>
          保存复核证据
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          取消
        </button>
      </footer>
    </form>
  );
}

function VersionEvidence({
  skill,
  onTrial,
}: {
  skill: InstalledSkillReleases;
  onTrial(seed?: SkillRelease['acceptance'][number]): void;
}): React.JSX.Element {
  const passed = skill.current.acceptance.filter(
    (item) => item.verdict === 'passed',
  );
  const failed = skill.current.acceptance.filter(
    (item) => item.verdict === 'failed',
  );
  const comparison = skill.comparison;
  return (
    <section className="otto-skill-evidence" aria-label="验证证据">
      <h4>验证到哪一步</h4>
      <p>
        结构与安全静态检查：
        {skill.current.staticValidation.passed ? '通过' : '未通过'}
        。没有执行脚本，也不证明业务效果。
      </p>
      {skill.current.staticValidation.errors.map((error) => (
        <p role="alert" key={error}>
          {error}
        </p>
      ))}
      {!skill.current.acceptance.length ? (
        <p className="otto-skill-warning">
          尚未验证业务效果：没有实际案例的复核证据，建议从低风险样例试用。
        </p>
      ) : (
        <p>
          人工复核：{passed.length} 项达到标准，{failed.length}{' '}
          项未达到。只是这些样例的结果，不代表总体成功率或生产保证。
        </p>
      )}
      {failed.length > 0 ? (
        <p className="otto-skill-warning">
          仍有失败案例，不建议直接用于这些场景；请保留人工检查或回滚。
        </p>
      ) : null}
      {comparison ? (
        <div>
          <h4>比最近保留版本好在哪里</h4>
          <p>
            文件事实：新增 {comparison.addedFiles.length}，修改{' '}
            {comparison.changedFiles.length}，移除{' '}
            {comparison.removedFiles.length}。文件变化不等于效果改善。
          </p>
          <p>
            可比案例 {comparison.comparableCases} 项；改善{' '}
            {comparison.improved.length} 项，退步 {comparison.regressed.length}{' '}
            项。
          </p>
          {comparison.improved.map((name) => (
            <p key={`better-${name}`}>
              改善（人工复核）：{name}，从未达标变为达标。
            </p>
          ))}
          {comparison.regressed.map((name) => (
            <p className="otto-skill-warning" key={`worse-${name}`}>
              退步（人工复核）：{name}，从达标变为未达标。
            </p>
          ))}
          {comparison.businessVerdict === 'insufficient-evidence' ? (
            <p>缺少同条件对照，不能证明新版更好。</p>
          ) : comparison.businessVerdict === 'no-proven-improvement' ? (
            <p>尚无证据证明新版优于保留版本。</p>
          ) : null}
        </div>
      ) : (
        <p>还没有完整历史版本可比较。从本次功能更新后开始保存完整快照。</p>
      )}
      {skill.current.acceptance.map((item, index) => (
        <details key={`${item.caseKey}:${index}`}>
          <summary>
            {item.verdict === 'passed' ? '达标记录' : '失败记录'}：
            {item.scenario} · 人工复核
          </summary>
          <p>环境：{item.environment}</p>
          <p>输入：{item.input}</p>
          <p>标准：{item.expected}</p>
          <p>实际结果：{item.actual}</p>
          <small>
            {item.recordedAt} · 仅绑定版本 {skill.current.id.slice(0, 8)} ·
            同场景有失败时不能视为稳定通过
          </small>
        </details>
      ))}
      {skill.history[0]?.acceptance.length ? (
        <details>
          <summary>用上一版的样例复核当前版</summary>
          {skill.history[0].acceptance
            .filter(
              (item, index, rows) =>
                rows.findIndex((row) => row.caseKey === item.caseKey) === index,
            )
            .map((item) => (
              <button
                type="button"
                key={item.caseKey}
                onClick={() => onTrial(item)}
              >
                复用案例：{item.scenario}
              </button>
            ))}
        </details>
      ) : null}
    </section>
  );
}

function InstalledSkillCard({
  skill,
  busy,
  onRollback,
  onRecord,
}: {
  skill: InstalledSkillReleases;
  busy: boolean;
  onRollback(input: SkillRollbackInput): void;
  onRecord(input: SkillAcceptanceInput): void;
}): React.JSX.Element {
  const [target, setTarget] = useState<SkillRelease | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [trial, setTrial] = useState<{
    seed?: SkillRelease['acceptance'][number];
  } | null>(null);
  const openTrial = (seed?: SkillRelease['acceptance'][number]) => {
    setTarget(null);
    setTrial({ seed });
  };
  return (
    <article className="otto-skill-release">
      <header>
        <h3>{skill.current.function.title}</h3>
        <small>
          {skill.skillName} · 当前版本 {skill.current.id.slice(0, 8)}
        </small>
      </header>
      <SkillFunctionCard value={skill.current.function} />
      <VersionEvidence skill={skill} onTrial={openTrial} />
      {skill.warnings.map((warning) => (
        <p role="alert" key={warning}>
          {warning}
        </p>
      ))}
      <button type="button" disabled={busy} onClick={() => openTrial()}>
        记录实际试用
      </button>
      {trial ? (
        <ReviewForm
          key={trial.seed?.caseKey ?? 'new'}
          seed={trial.seed}
          skill={skill}
          busy={busy}
          onRecord={onRecord}
          onCancel={() => setTrial(null)}
        />
      ) : null}
      <details>
        <summary>历史版本与回滚（{skill.history.length}）</summary>
        <p>
          恢复 Skill
          的说明、脚本、模板和专家配置，不撤销已发送消息、工单或已生成的业务文件。当前版会先保留，之后可再次恢复。
        </p>
        {!skill.history.length ? (
          <p>
            还没有可回滚的完整快照；旧版只有说明文件的历史记录不能当作完整版本。
          </p>
        ) : (
          skill.history.map((version) => (
            <div key={version.id}>
              <strong>
                {version.function.title} · {version.id.slice(0, 8)}
              </strong>
              <p>
                {version.capturedAt} · {Object.keys(version.files).length}{' '}
                个文件
              </p>
              <button
                type="button"
                disabled={busy || !version.staticValidation.passed}
                onClick={() => {
                  setTarget(version);
                  setConfirmed(false);
                  setTrial(null);
                }}
              >
                选择此版本回滚 · {version.id.slice(0, 8)}
              </button>
            </div>
          ))
        )}
      </details>
      {target ? (
        <section className="otto-skill-rollback" aria-label="回滚确认">
          <h4>确认恢复到 {target.id.slice(0, 8)}？</h4>
          <p>
            从 {skill.current.id.slice(0, 8)} 恢复到 {target.id.slice(0, 8)}
            。请完成或停止当前任务后操作；已有对话上下文不会被改写，回滚后请在新会话中使用。
          </p>
          <SkillFunctionCard value={target.function} />
          <ul>
            {Object.keys(skill.current.files)
              .filter((file) => !Object.hasOwn(target.files, file))
              .map((file) => (
                <li key={file}>移除：{file}</li>
              ))}
            {Object.keys(target.files)
              .filter(
                (file) => target.files[file] !== skill.current.files[file],
              )
              .map((file) => (
                <li key={file}>恢复：{file}</li>
              ))}
          </ul>
          <label className="otto-skill-check">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            我已了解恢复范围及不能撤销的业务操作
          </label>
          <footer>
            <button
              type="button"
              disabled={!confirmed || busy}
              onClick={() =>
                onRollback({
                  skillName: skill.skillName,
                  versionId: target.id,
                  expectedCurrentHash: skill.current.id,
                  confirmed: true,
                })
              }
            >
              确认回滚
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setTarget(null)}
            >
              取消回滚
            </button>
          </footer>
        </section>
      ) : null}
    </article>
  );
}

export function SkillVersionPanel({
  skills,
  busy,
  error,
  status,
  onRefresh,
  onRollback,
  onRecord,
}: {
  skills: InstalledSkillReleases[];
  busy: boolean;
  error: string | null;
  status?: string;
  onRefresh(): void;
  onRollback(input: SkillRollbackInput): void;
  onRecord(input: SkillAcceptanceInput): void;
}): React.JSX.Element {
  return (
    <section className="otto-skill-versions">
      <header>
        <h2>已安装功能 · 版本与证据</h2>
        <button type="button" disabled={busy} onClick={onRefresh}>
          刷新版本
        </button>
      </header>
      <p>
        先看能帮你完成什么，再看实际验证范围。升级和回滚都由你选择，不会为了生成证据自动执行脚本或调用大模型。
      </p>
      {busy ? <p role="status">正在读取或保存版本证据…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {status ? <p role="status">{status}</p> : null}
      {!skills.length && !busy && !error ? (
        <p>
          暂无已安装的个人
          Skill。安装下方草稿后，可在这里查看功能、复核样例并选择历史版本。
        </p>
      ) : null}
      {skills.map((skill) => (
        <InstalledSkillCard
          key={`${skill.skillName}:${skill.current.id}:${skill.current.acceptance.map((item) => item.recordedAt).join(',')}`}
          skill={skill}
          busy={busy}
          onRollback={onRollback}
          onRecord={onRecord}
        />
      ))}
    </section>
  );
}
