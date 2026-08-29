# Otto 1.9.14 npm 高危审计临时例外

状态：**限时、不可扩展、运行时不可达的发布例外**

复核截止：**2026-09-15 00:00:00 UTC**

适用版本：**Otto 1.9.14**

## 结论

截至 2026-08-29，完整 `npm audit --json` 仅报告以下两个 high 公告：

| 公告                  | 影响                                         | 受影响范围           | 已发布修复 |
| --------------------- | -------------------------------------------- | -------------------- | ---------- |
| `GHSA-w3rx-r6r6-pgpr` | 特制 ICNS 导致无限循环和事件循环拒绝服务     | `image-size <=2.0.2` | 无         |
| `GHSA-5p2g-fcmc-qvqq` | 特制 JXL/HEIF 导致无限循环和事件循环拒绝服务 | `image-size <=2.0.2` | 无         |

Otto 锁定的唯一依赖路径是：

```text
Otto / otto-core
└─ pptxgenjs@4.0.1
   └─ image-size@1.2.1
```

该例外不是对漏洞的忽略。发布门禁只有在依赖图、包版本、包完整性、PptxGenJS 运行时代码哈希、不可达性和 npm 审计结果全部保持本次复核状态时才放行。一项发生变化即失败。

## 为什么暂时不能升级修复

两个 GitHub Advisory 均标记所有 `<=2.0.2` 版本受影响且没有 patched version。npm 当前给出的 `fixAvailable` 是把 `pptxgenjs@4.0.1` 强制降级为 `1.1.5`，并明确标记为 semver-major；这不是已修复的兼容升级，会替换 Otto 已验证的 PPTX 运行时。

因此禁止执行 `npm audit fix --force`，也禁止伪造不存在的安全版本。真正的解除条件是：

1. `image-size` 发布可安装的修复版本，并由兼容的 PptxGenJS 使用；或
2. PptxGenJS 删除这项未使用依赖；或
3. Otto 删除或替换该依赖链。

## 不可达性证据

门禁同时验证以下条件：

- `package-lock.json` 中只有 `pptxgenjs@4.0.1 -> image-size@1.2.1` 这一条边，并校验两个 npm tarball 的精确 integrity。
- 只有根工作区和 `packages/core` 声明 PptxGenJS；任何工作区都不得直接依赖、override 或 resolution `image-size`。
- 安装后的 PptxGenJS `browser['image-size']` 必须继续为 `false`。
- PptxGenJS 4.0.1 的四个运行时 dist 文件必须与复核过的 SHA-256 完全一致。
- 所有 dist 运行时代码不得出现 `image-size` 模块引用。4.0.1 dist 中存在一段整块注释掉的旧 `getSizeFromImage`/`sizeof` 草稿，但它没有导入 `image-size`、不会执行，并由上述精确文件哈希固定；注释块或周边代码的任何变化都会触发失败和重新复核。
- Otto 全部受版本控制的 JavaScript/TypeScript 源码不得直接引用 `image-size`。

以上双重屏障说明漏洞解析器当前不在 Otto 的 PptxGenJS 执行路径上。任何版本、哈希、依赖边、浏览器屏障或源码引用变化都会使发布失败，而不是自动扩大例外。

## 发布门禁

Release workflow 在 `npm ci` 后运行：

```bash
npm run security:dependencies:release
```

该命令显式使用 `https://registry.npmjs.org/` 官方审计端点返回的实时 JSON；CI 明确禁止通过 `--audit-json` 使用快照。门禁要求当前审计结果精确为两个已审核公告，任何额外 high/critical、修复建议变化、公告范围变化或审计端点错误都会失败。

仓库内的 `config/security/npm-audit-1.9.14.expected.json` 只是 2026-08-29 的脱敏结构快照，用于离线回归测试，不能替代发布审计。

## 到期处理

从 2026-09-15 00:00:00 UTC 起，门禁无条件失败。发布负责人和安全负责人必须重新检查公告、npm 已发布版本与 PptxGenJS 依赖，再选择删除例外、升级依赖或通过新的代码审查设定更短的复核期。不得仅延长日期而不重新验证运行时文件和依赖图。

## 依据

- [GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr)
- [GHSA-5p2g-fcmc-qvqq](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq)
- [GitHub Advisory Database：已标注修复版本尚未发布的问题](https://github.com/github/advisory-database/issues/9028)
- [PptxGenJS 4.0.1 package.json](https://github.com/gitbrent/PptxGenJS/blob/v4.0.1/package.json)
