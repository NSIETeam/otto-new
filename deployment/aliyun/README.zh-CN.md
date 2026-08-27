# 阿里云零服务器部署契约（本地安全边界）

`otto-compute-nest-contract.json` 是 ROS/计算巢适配前的不可变契约层，覆盖 #281–#284、#289–#293 以及 #237 的部署注册边界。`plan-definitions.json` 定义试用、标准和高可用套餐，`templates/ros/*.json` 是从套餐定义生成的第一批 ROS 基础设施模板。它们描述私网资源、加密、秘密引用、幂等和 Portal 状态机，但 `realDeploymentEnabled` 固定为 `false`。

这不是阿里云 staging 证据，也不会创建真实资源。没有账户余额、RAM、KMS、RDS/Tair/OSS 或计算巢权限时，任何上层适配器都必须拒绝执行，而不是退回明文凭据、默认密码、HTTP 或“模拟成功”。

本地校验：

```bash
node scripts/validate-aliyun-deployment-contract.mjs
node scripts/scan-aliyun-deployment-secrets.mjs
npm run test:scripts -- --run scripts/tests/aliyun-deployment-contract.test.js
```

## CLOUD-02 签名服务器部署物

正式服务器包继续复用企业一键包，但发布链已经拆成两个权限域：

1. 普通构建阶段使用 `OTTO_DEFER_ENTERPRISE_SIGNING=1 npm run bundle:enterprise`，只能生成未签名归档、SHA-256、CycloneDX SBOM、第三方许可证清单和构建 provenance；该阶段拿不到发布私钥。
2. 受保护签名阶段使用 `npm run sign:aliyun:server`，先验证包内逐文件摘要、供应链清单、秘密扫描和归档路径，再生成企业包签名以及独立的计算巢部署物索引签名。

签名发布新增两个文件：

```text
otto-aliyun-server-artifact-v<version>-<build>.json
otto-aliyun-server-artifact-v<version>-<build>.json.sig
```

索引固定版本、源码提交、构建 ID、运行架构、数据库迁移范围、归档大小与 SHA-256、SBOM/许可证/provenance 摘要、发布序号、元数据有效期、最低资源和秘密交付边界。`verify:aliyun:server` 必须使用包外可信 Ed25519 公钥，拒绝篡改、错误架构、过期、吊销及低于本机防回滚序号的部署物。

目标 ECS 镜像或独立配置管理必须在允许部署前预置以下固定信任文件：

```text
/usr/local/libexec/otto-enterprise/verify-aliyun-server-artifact.mjs
/etc/otto-enterprise/trust/aliyun-artifact-signing-ed25519.pem
```

验证器目录需要同时包含其本地依赖模块。两个路径及全部父目录必须由 `root:root` 持有、组和其他用户不可写、不能经过符号链接；公钥必须是 Ed25519 SPKI 公钥。发布/部署 workflow 只能读取这些路径，不会把仓库验证脚本或 GitHub Secret 中的公钥上传到目标机，也不得创建、覆盖或轮换它们。信任根轮换必须通过受控基础镜像、KMS 或独立配置管理完成，并与普通制品发布分权。任一路径缺失、权限不安全、密钥算法错误或验签失败时，目标机在解包前 fail-closed。

正式构建还要求 `native/sqlcipher-node/linux-x64` 和 `linux-arm64` 两个平台原生资产齐全。缺任一平台时构建会 fail-closed；本地 Windows 不能用普通 `better-sqlite3` 代替。服务器包会从 `packages/server/package.json` 递归打入 PostgreSQL、Redis、S3、WebSocket、飞书和模型运行依赖，SBOM 只统计最终包中实际存在的组件。

当前 GitHub Secret 仅作为过渡签名后端和上传前附加验签来源，不能作为目标机信任根。商用上线前仍须把签名步骤迁入受保护 Environment，并通过 OIDC 调用 KMS/HSM 或独立签名机；构建 Job 不得获得明文私钥。计算巢 `ArtifactId`、跨地域分发、固定信任文件的镜像预置和真实 ECS 镜像证据仍属于阿里云 staging 工作，不能用本地测试替代。

修改套餐后运行 `npm run deployment:aliyun:generate` 重新生成模板；CI 使用 `--check` 模式验证提交的模板没有漂移。

## CLOUD-03 ALB 与 HTTPS 本地合同

三套预览模板现在统一选择阿里云 ALB，公网只创建 HTTPS 443 Listener；不创建 HTTP 80 Listener，ECS 继续没有公网 IP。ALB 使用两个独立可用区和 `10.42.10.0/24`、`10.42.11.0/24` 两个专用入口 vSwitch，ECS 的私网 7777 只允许这两个入口子网访问。健康检查固定为 `GET /enterprise/health`，TLS 策略固定为 `tls_cipher_policy_1_2_strict_with_1_3`，标准版和高可用版把两台 ECS 都注册到启用跨区与连接排空的 Server Group。

HTTPS Listener 只接受已经存在且与 `DomainName` 匹配的 CAS `TlsCertificateId`。模板不会接收证书 PEM 或私钥。`DnsZoneName`、`DnsRecordRr` 和证书 ID 均由部署控制面校验后作为隐藏参数注入；模板在部署账号已有的 DNS Zone 中创建指向 ALB 的 CNAME，并输出 `LoadBalancerDnsName` 与 `PublicHttpsOrigin`。`managed` 临时域名与 `existing` 客户域名在进入 ROS 前都必须完成域名控制权、备案适用性、证书签发状态和账号归属检查，缺任一项必须 fail-closed。

服务器包新增 `OTTO_CADDY_MODE=alb`：Caddy 只在私网 7777 提供受控 HTTP 源站，校验 Host、清洗代理 Host，保留上传限制、安全头和未完成功能 404，再反代到 `127.0.0.1:7778`。公网 TLS 只在 ALB 终止，不能把该源站端口直接开放互联网。

这仍是本地可生成、可负向验证的合同，不是 #283 完成证据。域名申请/续期/失败告警控制面、计算巢无 SSH 安装引导、三套餐真实创建删除、TLS 扫描、双实例切换、附件/长轮询和公网攻击测试仍必须在真实阿里云完成；`realDeploymentEnabled` 继续保持 `false`。

契约特别固定了：数据库、Tair、Otto Server 和秘密服务均为私网资源；当前公网只有 443，不创建 80 Listener；TLS 最低 1.2；SSH 默认关闭；ROS 参数和输出不得包含密码、License、AccessKey、私钥或连接串；重复订单必须由 `orderId + deploymentId + idempotencyKey + templateVersion` 去重；秘密依赖不可用时 fail-closed。

当前模板建立 VPC、应用与 ALB 专用 vSwitch、安全组、无公网 IP 的 ECS、双区 ALB HTTPS 入口、DNS CNAME、私网 RDS、私网 Tair、私有 KMS 加密 OSS、AES-256 KMS 密钥和最小权限实例角色。ECS 镜像、CAS 证书 ID，以及数据库、Tair 凭据只接受计算巢隐藏参数或 OOS 加密参数引用，不包含默认证书私钥、数据库密码、AccessKey 或 License。

这里的 `trial` 是 Otto 的低配按量套餐，不等同于计算巢平台的“免费试用服务”。如果后续发布计算巢免费试用入口，须按平台规则另建“选择客户现有 VPC/vSwitch”的模板，不能复用当前会创建 VPC 的模板。

签名服务器镜像安装、域名/证书生命周期控制面、Control 自动注册和数据库初始化必须分别完成 CLOUD-02、CLOUD-03、CLOUD-04 及后续验收后，才允许把真实部署开关改为 `true`。CLOUD-02 当前完成的是可验证文件部署物，CLOUD-03 当前完成的是 ALB/HTTPS 本地合同；两者都不等于真实云交付完成。真实完成仍需要版本化的阿里云证据：三套餐 ROS lint/预检/创建/删除、失败回滚、RDS/Tair/OSS/KMS 实例与网络验证、HTTPS 续期、Portal 全流程以及升级回滚。这些在本地不能伪造。
