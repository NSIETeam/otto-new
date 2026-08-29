import { describe, expect, it } from 'vitest';
import { adminAccountsHTML } from './server.js';

describe('enterprise admin web configuration', () => {
  it('内置真实的功能开关、部门职位与产业园管理入口', () => {
    const html = adminAccountsHTML();
    expect(html).toContain('功能开关');
    expect(html).toContain('部门与职位管理');
    expect(html).toContain('产业园邀请码');
    expect(html).toContain('/enterprise/organization/features');
    expect(html).toContain('/enterprise/organization/departments');
    expect(html).toContain('/enterprise/organization/positions');
    expect(html).toContain('/enterprise/park/services');
    expect(html).toContain('/enterprise/park/specialists');
    expect(html).not.toContain('宏创AI园区服务');
  });

  it('内联脚本保持可解析', () => {
    const html = adminAccountsHTML();
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
  });

  it('将配置、许可证授权和实际生效状态分开保存，并兼容旧服务器响应', () => {
    const html = adminAccountsHTML();
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? '';
    const applyStateSource = script
      .split('\n')
      .find((line) => line.startsWith('function applyOrganizationFeatureState'));
    expect(applyStateSource).toBeTruthy();

    const applyState = new Function(`
      let organizationFeatureState = null;
      let organizationFeatures = null;
      ${applyStateSource}
      return (data) => {
        applyOrganizationFeatureState(data);
        return { state: organizationFeatureState, effectiveAlias: organizationFeatures };
      };
    `)() as (data: Record<string, unknown>) => {
      state: {
        configured: Record<string, boolean>;
        entitled: Record<string, boolean>;
        effective: Record<string, boolean>;
      };
      effectiveAlias: Record<string, boolean>;
    };

    const configured = { enterprise_tree: true, park_service: true };
    const entitled = { enterprise_tree: false, park_service: true };
    const effective = { enterprise_tree: false, park_service: true };
    const explicit = applyState({
      features: effective,
      configured,
      entitled,
      effective,
    });
    expect(explicit.state).toEqual({ configured, entitled, effective });
    expect(explicit.effectiveAlias).toEqual(effective);
    expect(explicit.state.configured).not.toBe(configured);
    expect(explicit.state.entitled).not.toBe(entitled);
    expect(explicit.state.effective).not.toBe(effective);

    const legacyFeatures = { enterprise_tree: true, park_service: false };
    const legacy = applyState({ features: legacyFeatures });
    expect(legacy.state).toEqual({
      configured: legacyFeatures,
      entitled: { enterprise_tree: false, park_service: false },
      effective: { enterprise_tree: false, park_service: false },
    });
    expect(() => applyState({})).toThrow('功能开关响应格式不正确');
  });

  it('开关读取 configured，受保护接口只根据 effective 发起并显示授权状态', () => {
    const html = adminAccountsHTML();
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? '';

    expect(script).toContain("(configured[key]?'checked':'')");
    expect(script).toContain("status=!licensed?'未授权':active?'已生效':'未启用'");
    expect(script).toContain(
      'const effective=organizationFeatures&&organizationFeatures[key]===true',
    );
    expect(script).toContain("if(effective)await loadStructure()");
    expect(script).toContain("if(effective)await loadPark()");
    expect(script).not.toContain("if(enabled)await loadStructure()");
    expect(script).not.toContain("if(enabled)await loadPark()");
    expect(html).toContain('企业树尚未授权');
    expect(html).toContain('园区服务尚未授权');
    expect(html).toContain('当前企业配置已关闭');
  });
});
