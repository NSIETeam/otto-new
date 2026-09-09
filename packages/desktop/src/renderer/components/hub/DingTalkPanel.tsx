/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import React, { useState } from 'react';
import { IconExternalLink } from '../icons.js';
import { Card, Panel } from './HubUI.js';
import { ChannelInstallationList } from './ChannelInstallationList.js';
import { ChannelPairingCard } from './ChannelPairingCard.js';

export const DINGTALK_DEVELOPER_URL = 'https://open-dev.dingtalk.com/';
export const DINGTALK_PLUGIN_URL = 'https://github.com/DingTalk-Real-AI/dingtalk-openclaw-connector';

type Destination = 'developer' | 'plugin';
const DESTINATIONS: Record<Destination, string> = {
  developer: DINGTALK_DEVELOPER_URL,
  plugin: DINGTALK_PLUGIN_URL,
};

export async function openDingTalkDestination(destination: Destination): Promise<void> {
  if (!window.otto?.openExternal) throw new Error('桌面外部链接服务未就绪');
  await window.otto.openExternal(DESTINATIONS[destination]);
}

export function DingTalkPanel(): React.JSX.Element {
  const [opening, setOpening] = useState<Destination | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const open = async (destination: Destination): Promise<void> => {
    if (opening) return;
    setOpening(destination);
    setMessage(null);
    try { await openDingTalkDestination(destination); }
    catch (error) { setMessage(`无法打开钉钉页面：${error instanceof Error ? error.message : String(error)}`); }
    finally { setOpening(null); }
  };

  return (
    <Panel title="钉钉接入" desc="扫码创建或绑定钉钉机器人，通过官方 Stream 长连接安全控制这台电脑。">
      <ChannelPairingCard provider="dingtalk" />
      <ChannelInstallationList provider="dingtalk" />
      <div className="otto-hub__section-title">高级配置与官方资料</div>
      <Card className="otto-hub__card--pad">
        <div className="otto-hub__row-name">企业自建应用兼容模式</div>
        <p className="otto-hub__field-hint">
          主路径使用钉钉官方扫码授权；只有企业策略要求自行创建应用时，才需要手动配置 Client ID 和 Client Secret。
        </p>
        <div className="otto-hub__feishu-actions">
          <button type="button" className="otto-hub__btn" disabled={opening !== null} onClick={() => void open('developer')}>
            <span>{opening === 'developer' ? '正在打开…' : '打开钉钉开发者后台'}</span><IconExternalLink size={12} />
          </button>
          <button type="button" className="otto-hub__btn" disabled={opening !== null} onClick={() => void open('plugin')}>
            <span>{opening === 'plugin' ? '正在打开…' : '查看钉钉官方连接器'}</span><IconExternalLink size={12} />
          </button>
        </div>
        {message ? <div className="otto-hub__feishu-message" role="alert">{message}</div> : null}
      </Card>
    </Panel>
  );
}
