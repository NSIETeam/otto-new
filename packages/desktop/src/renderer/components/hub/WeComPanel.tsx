/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { IconExternalLink } from '../icons.js';
import { Card, Panel } from './HubUI.js';
import { ChannelPairingCard } from './ChannelPairingCard.js';
import { ChannelInstallationList } from './ChannelInstallationList.js';

export const WECOM_ADMIN_URL = 'https://work.weixin.qq.com/wework_admin/frame#apps';
export const WECOM_API_GUIDE_URL = 'https://developer.work.weixin.qq.com/document/path/90665';
export const WECOM_PLUGIN_URL = 'https://github.com/WecomTeam/wecom-openclaw-plugin';

type WeComDestination = 'admin' | 'guide' | 'plugin';

const DESTINATIONS: Record<WeComDestination, string> = {
  admin: WECOM_ADMIN_URL,
  guide: WECOM_API_GUIDE_URL,
  plugin: WECOM_PLUGIN_URL,
};

/** Keep external navigation closed over an allowlist; callers cannot inject a URL. */
export async function openWeComDestination(destination: WeComDestination): Promise<void> {
  if (!window.otto?.openExternal) throw new Error('桌面外部链接服务未就绪');
  await window.otto.openExternal(DESTINATIONS[destination]);
}

export function WeComPanel(): React.JSX.Element {
  const [opening, setOpening] = useState<WeComDestination | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const open = async (destination: WeComDestination): Promise<void> => {
    if (opening) return;
    setOpening(destination);
    setMessage(null);
    try {
      await openWeComDestination(destination);
    } catch (error) {
      setMessage(`无法打开企业微信页面：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setOpening(null);
    }
  };

  return (
    <Panel
      title="企业微信接入"
      desc="扫码创建或绑定企业微信智能机器人，通过官方长连接安全控制这台电脑。"
    >
      <ChannelPairingCard provider="wecom" />
      <ChannelInstallationList provider="wecom" />

      <div className="otto-hub__section-title">高级配置与兼容模式</div>
      <Card className="otto-hub__card--pad">
        <div className="otto-hub__row-name">企业自建应用兼容模式</div>
        <p className="otto-hub__field-hint">
          主路径使用企业微信官方扫码授权。只有企业策略要求自行创建应用时，才进入管理后台手工配置；Secret 不会通过链接传递，也不要粘贴到普通对话中。
        </p>
        <div className="otto-hub__feishu-actions">
          <button
            type="button"
            className="otto-hub__btn otto-hub__btn--primary"
            disabled={opening !== null}
            onClick={() => void open('admin')}
          >
            <span>{opening === 'admin' ? '正在打开…' : '打开企业微信管理后台'}</span>
            <IconExternalLink size={12} />
          </button>
          <button
            type="button"
            className="otto-hub__btn"
            disabled={opening !== null}
            onClick={() => void open('plugin')}
          >
            <span>{opening === 'plugin' ? '正在打开…' : '查看企业微信官方插件'}</span>
            <IconExternalLink size={12} />
          </button>
          <button
            type="button"
            className="otto-hub__btn"
            disabled={opening !== null}
            onClick={() => void open('guide')}
          >
            <span>{opening === 'guide' ? '正在打开…' : '查看官方接入说明'}</span>
            <IconExternalLink size={12} />
          </button>
        </div>
        {message ? <div className="otto-hub__feishu-message" role="alert">{message}</div> : null}
      </Card>

      <Card className="otto-hub__card--pad">
        <div className="otto-hub__row-name">当前能力边界</div>
        <p className="otto-hub__field-hint">
          扫码仅建立消息通道。扫码账号或后续成员必须绑定到本机 owner/白名单后才能控制任务；高风险工具仍经过确认、策略和审计。
        </p>
      </Card>
    </Panel>
  );
}
