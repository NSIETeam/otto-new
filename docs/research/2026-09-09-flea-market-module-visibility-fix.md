# 跳蚤市场模块可发现性修复

用户指出：跳蚤市场是可添加模块，不应以业务启用或readiness作为模块目录显示条件。本次按该反馈修正，替代旧自查报告中“只有就绪才显示入口”的产品行为。

原因：moduleCatalog以canUseMarket隐藏模块；能力加载先请求市场settings；管理模块页面还过滤了整个park类别，并且类别排序漏掉park。

修复：跳蚤市场采用普通园区模块规则，删除专用显示标志和额外settings请求；管理模块恢复园区分类，支持搜索、勾选、保存和移除。已有用户布局不强制添加模块。服务端业务状态不控制模块是否进入目录；发布等业务权限仍由服务端检查。

验证：先更新回归，旧实现3项失败；修复后5文件83项通过。新增组件用例使用真实模块目录，验证搜索跳蚤市场、保存到园区组、重新显示勾选状态、点击工作台模块触发park-flea-market对话框激活。桌面typecheck、ESLint、doctor、git diff --check和code-map:check通过。未运行App或登录账号；组件验证不冒充真机验收。

命令：

```sh
npm exec --workspace=packages/desktop -- vitest run src/renderer/moduleCatalog.test.ts src/renderer/components/ModuleMarketplaceDialog.test.tsx src/renderer/components/ModuleWorkspace.test.tsx src/renderer/state/useModuleWorkspaceCapabilities.test.ts src/renderer/moduleWorkspace.test.ts
npm run typecheck --workspace=packages/desktop
npm run build --workspace=packages/desktop
npm run doctor
npm run code-map:check
```

本地证据：/tmp/otto-market-module-red.log、/tmp/otto-market-module-final.log、/tmp/otto-market-module-types.log、/tmp/otto-market-module-build.log。分支codex/blue-heron-7f3a9c；本地提交，不推送。

最终桌面完整build退出0；main/preload/renderer均构建成功。

## 后续：添加入口统一为末尾网格占位符

按用户确认的布局修改：移除满三行时网格外的长条按钮；添加入口始终使用日常办公的虚线加号格，紧跟最后一个模块。按模块数量自动增加行数，9个模块后位于第四行第一格；10个后位于第四行第二格；12个后位于第五行第一格。沿用“管理模块”文案与点击当前功能组管理页面的行为，折叠与拖拽流程保留。

自动化：旧实现3个新增场景失败，修改后ModuleWorkspace、ModuleWorkspace.reorder、ModuleMarketplaceDialog共39项通过；覆盖满行、非满行、点击目标组和既有六模块布局。没有启动App。证据日志位于/tmp/otto-module-add-grid-{red,green,types,build,doctor}.log。

该布局修改的桌面typecheck、renderer构建、定向ESLint、doctor和code-map:check均通过。
