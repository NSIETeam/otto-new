/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */


/**
 * Otto统一认证处理器
 * 处理Otto统一认证系统的认证流程
 */

export interface OttoAuthConfig {
  authUrl: string;
  redirectUri: string;
}

export interface OttoAuthResult {
  success: boolean;
  token?: string;
  user_id?: string;
  error?: string;
}

export type OttoAuthStateConsumer = (state: string | null) => boolean;

/**
 * Otto统一认证处理器
 */
export class OttoAuthHandler {
  private config: OttoAuthConfig;

  constructor(config: OttoAuthConfig) {
    this.config = config;
  }

  /**
   * 构建Otto认证URL
   */
  buildAuthUrl(state: string): string {
    // BYO-key: 未配置认证服务地址时该登录流不可用，抛错由调用方 catch 优雅处理，
    // 避免生成以 '?redirect_to=' 开头的无效 URL。
    if (!this.config.authUrl) {
      throw new Error('未配置认证服务地址（OTTO_AUTH_URL），账号登录不可用');
    }
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(state)) {
      throw new Error('Otto OAuth state 格式无效');
    }

    // state 同时放入标准 OAuth 参数和 redirect_to。后者保证旧版
    // Otto 认证服务即使不主动回传 state，也会通过原始回调地址带回。
    const redirectUrl = new URL(this.config.redirectUri);
    redirectUrl.searchParams.set('state', state);
    const authUrl = new URL(this.config.authUrl);
    authUrl.searchParams.set('redirect_to', redirectUrl.toString());
    authUrl.searchParams.set('redirect_mode', 'same_window');
    authUrl.searchParams.set('state', state);
    console.log('🔗 Otto认证地址已生成');

    return authUrl.toString();
  }

  /**
   * 处理Otto认证回调
   */
  handleCallback(url: URL, consumeState: OttoAuthStateConsumer): OttoAuthResult {
    console.log('🔄 [Otto Auth] 处理Otto认证回调');

    const callbackState = url.searchParams.get('state');
    let stateAccepted = false;
    try {
      stateAccepted = consumeState(callbackState) === true;
    } catch {
      stateAccepted = false;
    }
    if (!stateAccepted) {
      console.error('❌ [Otto Auth] 认证请求已失效或state不匹配');
      return {
        success: false,
        error: 'Otto登录请求已失效，请重新发起登录'
      };
    }

    // 提取token和user_id参数
    const token = url.searchParams.get('token');
    const user_id = url.searchParams.get('user_id');
    const error = url.searchParams.get('error');

    if (error) {
      console.error('❌ [Otto Auth] 认证回调返回错误');
      return {
        success: false,
        error: `Otto认证失败: ${error}`
      };
    }

    if (!token) {
      console.error('❌ [Otto Auth] 缺少token参数');
      return {
        success: false,
        error: 'Otto认证回调中缺少token参数'
      };
    }

    if (!user_id) {
      console.error('❌ [Otto Auth] 缺少user_id参数');
      return {
        success: false,
        error: 'Otto认证回调中缺少user_id参数'
      };
    }

    console.log('✅ [Otto Auth] Otto认证成功');
    return {
      success: true,
      token,
      user_id
    };
  }
}

/**
 * 创建Otto认证处理器的便捷函数
 */
export function createOttoAuthHandler(callbackPort?: number): OttoAuthHandler {
  const actualPort = callbackPort || 7863;
  const config: OttoAuthConfig = {
    // BYO-key: 不再硬编码 otto 登录地址；可由 OTTO_AUTH_URL 配置，未配置则该登录流不可用。
    authUrl: process.env.OTTO_AUTH_URL || '',
    redirectUri: `http://localhost:${actualPort}/callback?plat=otto`,
  };

  return new OttoAuthHandler(config);
}
