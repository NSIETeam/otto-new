/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import type {
  EnterprisePublicProfile,
  EnterprisePublicProfileInput,
} from '../../preload/index.js';

interface ProfileDraft {
  summary: string;
  website: string;
  industryTags: string;
  productsServices: string;
  capabilities: string;
  cooperationNeeds: string;
  publicContact: string;
  isPublic: boolean;
}
const EMPTY_DRAFT: ProfileDraft = {
  summary: '',
  website: '',
  industryTags: '',
  productsServices: '',
  capabilities: '',
  cooperationNeeds: '',
  publicContact: '',
  isPublic: false,
};

function lines(values: string[]): string {
  return values.join('\n');
}

function list(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\n,，、;；]+/u)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function draftFromProfile(profile: EnterprisePublicProfile): ProfileDraft {
  return {
    summary: profile.summary,
    website: profile.website,
    industryTags: lines(profile.industryTags),
    productsServices: lines(profile.productsServices),
    capabilities: lines(profile.capabilities),
    cooperationNeeds: lines(profile.cooperationNeeds),
    publicContact: profile.publicContact,
    isPublic: profile.isPublic,
  };
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+':\s*/u, '')
    .replace(/^Error:\s*/u, '');
}

export function EnterprisePublicProfilePanel(): React.JSX.Element {
  const [profile, setProfile] = useState<EnterprisePublicProfile | null>(null);
  const [draft, setDraft] = useState<ProfileDraft>(EMPTY_DRAFT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.otto
      .enterprisePublicProfile()
      .then((next) => {
        if (cancelled) return;
        setProfile(next);
        setDraft(draftFromProfile(next));
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = <K extends keyof ProfileDraft>(
    key: K,
    value: ProfileDraft[K],
  ): void => setDraft((current) => ({ ...current, [key]: value }));

  const save = async (): Promise<void> => {
    setSaving(true);
    setMessage(null);
    setError(null);
    const input: EnterprisePublicProfileInput = {
      summary: draft.summary,
      website: draft.website,
      industryTags: list(draft.industryTags),
      productsServices: list(draft.productsServices),
      capabilities: list(draft.capabilities),
      cooperationNeeds: list(draft.cooperationNeeds),
      publicContact: draft.publicContact,
      isPublic: draft.isPublic,
    };
    try {
      const saved = await window.otto.enterprisePublicProfileUpdate(input);
      setProfile(saved);
      setDraft(draftFromProfile(saved));
      setMessage(
        saved.isPublic
          ? '企业资料已公开，星链图将在刷新后使用这些字段。'
          : '企业资料已保存为私有，不会进入星链图。',
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="otto-enterprise-profile" aria-label="企业公开资料">
      <div className="otto-enterprise-profile__notice">
        <strong>由企业自行维护，默认不公开</strong>
        <p>
          公开后，同一园区成员可看到下列资料，星链图只用“产品与服务、企业能力、合作需求”推理合作线索。
          成员名单、内部消息和经营数据不会参与推理。
        </p>
      </div>
      {loading ? <p className="otto-enterprise-profile__status">正在读取企业资料…</p> : null}
      {!loading ? (
        <div className="otto-enterprise-profile__layout">
          <form
            className="otto-enterprise-profile__form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label className="is-wide">
              <span>企业简介</span>
              <textarea
                aria-label="企业简介"
                value={draft.summary}
                maxLength={1000}
                onChange={(event) => update('summary', event.target.value)}
                placeholder="说明企业主营方向、服务对象和核心优势"
              />
            </label>
            <label>
              <span>企业官网</span>
              <input
                aria-label="企业官网"
                value={draft.website}
                onChange={(event) => update('website', event.target.value)}
                placeholder="https://example.com"
              />
            </label>
            <label>
              <span>公开联系方式</span>
              <input
                aria-label="公开联系方式"
                value={draft.publicContact}
                onChange={(event) => update('publicContact', event.target.value)}
                placeholder="建议填写商务邮箱或企业电话"
              />
            </label>
            <label>
              <span>行业标签</span>
              <textarea
                aria-label="行业标签"
                value={draft.industryTags}
                onChange={(event) => update('industryTags', event.target.value)}
                placeholder={'每行一项，例如：\n智能制造\n工业软件'}
              />
            </label>
            <label>
              <span>产品与服务</span>
              <textarea
                aria-label="产品与服务"
                value={draft.productsServices}
                onChange={(event) => update('productsServices', event.target.value)}
                placeholder="每行填写一项可对外提供的产品或服务"
              />
            </label>
            <label>
              <span>企业能力</span>
              <textarea
                aria-label="企业能力"
                value={draft.capabilities}
                onChange={(event) => update('capabilities', event.target.value)}
                placeholder="每行填写一项可验证的交付能力"
              />
            </label>
            <label>
              <span>合作需求</span>
              <textarea
                aria-label="合作需求"
                value={draft.cooperationNeeds}
                onChange={(event) => update('cooperationNeeds', event.target.value)}
                placeholder="每行填写一项当前希望对接的资源或服务"
              />
            </label>
            <label className="otto-enterprise-profile__visibility is-wide">
              <input
                type="checkbox"
                checked={draft.isPublic}
                onChange={(event) => update('isPublic', event.target.checked)}
              />
              <span>
                <strong>向同一园区公开这份企业资料</strong>
                <small>关闭后立即退出星链图；填写内容仍保存在企业服务器中。</small>
              </span>
            </label>
            <div className="otto-enterprise-profile__actions is-wide">
              <button type="submit" disabled={saving}>
                {saving ? '正在保存…' : '保存企业资料'}
              </button>
              {profile?.updatedAt ? (
                <small>最近更新：{new Date(profile.updatedAt).toLocaleString('zh-CN')}</small>
              ) : null}
            </div>
            {message ? <p className="otto-enterprise-profile__success is-wide">{message}</p> : null}
            {error ? <p className="otto-enterprise-profile__error is-wide" role="alert">{error}</p> : null}
          </form>
          <aside className="otto-enterprise-profile__preview" aria-label="企业资料公开预览">
            <span>PUBLIC PREVIEW</span>
            <h3>{profile?.organizationName ?? '本企业'}</h3>
            <p>{draft.summary || '填写企业简介后在这里预览。'}</p>
            <dl>
              <div><dt>产品与服务</dt><dd>{list(draft.productsServices).join('、') || '未填写'}</dd></div>
              <div><dt>企业能力</dt><dd>{list(draft.capabilities).join('、') || '未填写'}</dd></div>
              <div><dt>合作需求</dt><dd>{list(draft.cooperationNeeds).join('、') || '未填写'}</dd></div>
            </dl>
            <strong className={draft.isPublic ? 'is-public' : 'is-private'}>
              {draft.isPublic ? '将向同园区公开' : '当前仅企业管理员可见'}
            </strong>
          </aside>
        </div>
      ) : null}
    </section>
  );
}
