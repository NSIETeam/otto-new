# 北控宏创科技园企业公开资料演示数据

调研日期：2026-09-08。用途：Otto 企业资料与企业星链图的演示种子数据。数据来自企业官网、政府与药监公开资料、中国石油大学就业平台；行业归类由本次调研整理。

## 文件与范围

- `enterprises.csv`：21 条主体记录，17 条 `includeInDemo=true`；另有 3 条待核实候选、1 条园区运营方。
- `industry-taxonomy.csv`：13 个统一行业分类（含候选与运营方使用的分类）。这是产品演示分类，不是国民经济行业标准代码。
- 两个 CSV 均为 UTF-8 BOM、英文列名、中文内容，标准 CSV 引号转义。Excel 可打开；程序应按 `utf-8-sig` 读取。

这是可追溯的公开资料样本，**不是园区当前完整官方租户名册**。公开地址可能没有及时更新，`includeInDemo` 表示推荐作为演示样本，不代表园区确认今日在驻。未获取企业自行填写的合作需求，也没有填写虚构营收、人数、交易关系或联系人。

园区主体为北京北控宏创科技有限公司，地址北京市昌平科技园区超前路甲1号；[园区官网联系页](https://www.behhc.com/col.jsp?id=102)提供运营方及详细地址。[2026-07-09 北京市投资促进服务局园区介绍](https://invest.beijing.gov.cn/tcgz/lqzs/202607/t20260709_4754686.html)介绍园区规模与产业，并未提供完整现租户名册。不要把该报道所列历史培育企业全部判为当前入驻。

## 默认演示企业

盈科视控、广网数据、航研射频、联众集群、杰创永恒、圣钧科技、清晖翔、清博华、企安安、金钢科技、特智诚、丰科卓辰、鑫汇迈科、国金源富、新羿制造、超目科技、瑞健高科。

暂不默认导入：昆仑隆源（地址线索需复核）、大威激光（北京联系点的实际法律主体未明确）、海精高创（官网多地址角色未明确）。北控宏创为运营方，可初始化园区资料，但不应当成普通企业加入图谱。

## 字段字典

| 字段 | 类型与规则 |
| --- | --- |
| seedId | 稳定的演示键，如 bhc-demo-002；不是现有 organizationId。后续增量更新保留原 ID，不按行号重新分配。 |
| parkName | 北控宏创科技园。parkId 由导入器关联演示园区，不填真实园区 ID。 |
| organizationName / displayName | 主体全称 / 图中展示简称；简称由调研整理。 |
| entityRole | enterprise 或 park_operator。 |
| summary | 根据公开业务归纳的简短介绍。 |
| website | 已核验对应主体的站点；未确认留空，不拼接猜测域名。 |
| industryTags | JSON 字符串数组。第一项为统一行业，其余为业务标签；不代表企业自己确认。 |
| productsServices | JSON 字符串数组，来源支持的产品或服务；标注“许可生产范围”的条目不可宣传为具体已上市产品。 |
| capabilities / cooperationNeeds | JSON 数组，本版均为 []。未额外杜撰能力承诺和采购、合作意向。 |
| publicContact | 官网公开企业电话或邮箱；留空表示未核验，不表示企业没有联系方式。没有收集私人手机号。 |
| isPublic | 本版均为 false。不能把公开网页采集等同企业在 Otto 主动公开资料；演示可见性见后文。 |
| primaryIndustryCode / primaryIndustryName | 本次建议的统一主营行业编码 / 名称；编码见行业表。 |
| industryClassificationBasis | 固定 researcher_classified_from_public_business，表示调研归类。 |
| industryConfirmedByCompany | 本版均 false；不得显示“企业已认证主营行业”。 |
| officeAddress | 已查到的园区相关地址；历史字段名不保证一定是办公地址，应结合 addressType 展示。 |
| addressType | public_contact=官网或招聘联系地址；production=生产地址；registered=许可住所；park_only=只核实到园区。 |
| parkRelationStatus | 园区关系证据类型，见下表；不等于租约状态。 |
| parkEvidence | 园区关联证据摘要，多数为来源所列地址的规范化记录；不是统一的逐字引文。 |
| parkSourceUrl / profileSourceUrl | 园区关联来源 / 业务来源；来源支持不同字段，不可混用发布日期。 |
| sourcePublishedAt | 园区关联来源明确的发文或发证日期；没有明确日期留空，不用抓取时间代替。 |
| retrievedAt | 本次核查日期 2026-09-08；不是企业资料更新时间，也不保证后续仍有效。 |
| includeInDemo | 小写 true / false；推荐默认演示筛选值。 |
| dataOrigin | public_web_research。 |
| notes | 更名、地址角色、资料冲突、主体边界等说明；导入后保留。 |

| parkRelationStatus | 含义 |
| --- | --- |
| official_contact_address | 企业官网所列联系地址与园区名称或标准地址一致。 |
| official_document_address | 企业官网产品手册列明园区地址，文档日期未知。 |
| university_employer_profile_address | 高校就业平台企业资料列园区地址；没有确认在驻租约。 |
| government_reported_tenant | 指定日期政府报道明确称入驻企业。 |
| regulator_production_address | 药监许可列园区生产场所；不是总部地址。 |
| regulator_registered_and_production_address | 药监许可的住所与生产场所均位于园区。 |
| conflicting_location_evidence | 不同地点线索需要进一步核对。 |
| beijing_contact_entity_unconfirmed | 官网有北京联系点，但实际经营法律主体待确认。 |
| multiple_addresses_unresolved | 同一官网有多地址，未明确各自角色。 |

## 给后续 AI 开发者的导入约定

现有字段定义位于 `packages/server/src/modules/park_services/parkPartnershipTypes.ts` 的 `EnterprisePublicProfileInput`。现有企业资料可直接复用 summary、website、industryTags、productsServices、capabilities、cooperationNeeds、publicContact、isPublic。CSV 是数据交付，**本次没有修改接口、创建组织或导入数据库**。

1. 使用标准 CSV 解析器读取；不得直接用逗号 split。JSON 数组字段须 JSON.parse；布尔值必须显式比较字符串 `=== 'true'`，不要用 Boolean('false')。
2. 只将 `includeInDemo=true && entityRole==='enterprise'` 的 17 条用于默认图谱。
3. 使用独立演示园区或演示数据提供器。建立 `(dataset='bhc-public-2026-09-08', seedId) -> organizationId` 映射，幂等更新，不按简称合并或覆盖已有真实组织；所有组织使用一致的演示 parkId。不要复制生产账号、负责人身份或权限。
4. 现有接口只返回公开资料。CSV 中 isPublic=false 是生产导入的保守初值；**独立演示环境**的导入器可为这 17 个演示 profile 明确设置 isPublic=true，或在演示数据提供器中展示；不能修改真实企业的发布开关来达成演示。演示页面标注“公开资料演示数据”。
5. organizationName 属于组织记录；displayName、行业编码、地址和来源属于新增元数据，不是当前 profile 接口已有字段。可保存在演示旁表/数据提供器中，不要无检查地传入现有 DTO。
6. 现有行业标签为自由文本，当前关系匹配仍基于业务供需文本；**导入 CSV 不会自动实现同行业连线**。应另加按 primaryIndustryCode 精确相等的无向关系策略。不要用“某标签包含某字”替代标准行业匹配。
7. 同行业只表示分类相同，不表示双方认识、合作或存在真实交易；不生成上下游、已合作、供需匹配关系。合作需求为空时保持为空。
8. 示例数据不提供气泡大小指标。同行业内全连接时每个节点度数都相同，度数不能代表企业实力；首版建议等大节点，通过选中态放大和高亮关联节点表达焦点。避免为了画面大小差异编造企业规模。
9. 每次重导入保留来源和 notes。企业将来认领并修改的字段应优先保留，不被演示脚本回写覆盖。

统一行业粒度用于园区浏览，例如“电子与通信设备”包含射频、通信和服务器设备，表示宽口径同行而非产品完全一致。“软件与信息技术服务”包含国金源富和广网数据，细分业务仍由标签区分。若产品将“同行业”定义为更细的主营业务，需要调整分类和文案，不能为了增加连线强行合并行业。

## 数据纠错与未纳入线索

- 超目使用 2026-08-19 药监记录的“超目科技（北京）股份有限公司”。旧名有限公司不另建节点；园区地址是生产场所，住所位于生命科学园。来源见该行。
- 广网数据采用现官网主体。2016 园区页出现“广网互联（北京）数据服务有限公司”，更名关系未核实，未当成第二家公司。
- 国金源富的大学就业页给出园区10号楼6层；工商注册地址不同，未混为一谈。
- 新羿只核实到园区层级，未猜测楼栋；部分公司的官网、联系渠道留空。后续可由园区补充，不使用假值填满。
- 青山绿野出现多个法律名称；奥格特未找到足够的公开园区地址证据；弘进久安与三安新特的主体关系尚待核实。因此未列为本版默认企业。
- [2023年国家级孵化器推荐官方通知](https://www.ncsti.gov.cn/kjdt/tzgg/202301/t20230130_107627.html)的[第三方转载](https://www.10100.com/article/147504779)包含历史在孵、毕业企业线索。本轮没有取得名单原始附件，也没有将毕业企业批量认作当前租户。若要扩大样本，应逐家重新核实主体及地址。

## 验证

本版完成 CSV 回读、列数一致、ID 与全称唯一、布尔枚举、JSON 数组、行业映射、来源 URL 格式和默认企业数量检查。上述检查不等于工商核验、租约核验或所有 URL 的持续可访问保证。本次为纯数据与说明文件，不运行应用构建或业务测试。
