# 企业星链图实施与验收记录

工作分支：`codex/blue-heron-7f3a9c`。
工作目录：`/Users/yang/Desktop/otto-carpool-fixed-91bc4e`。
需求基准：`/Users/yang/Desktop/otto-carpool-fixed-91bc4e/docs/plans/2026-09-08-enterprise-star-map-prd.md`。

## 已实现

- SQLite幂等行业迁移、集群资料读写和迁移元数据；只按标准主营行业代码连接已确认且授权公开的同行，无向去重。
- 复用企业资料表单：可搜索行业、保留公开开关、保存反馈、只读权限、未保存提示。外层服务窗口关闭检查未保存字段，星链图最小化保留挂载和探索状态。
- 北控宏创独立演示：21条CSV筛选17家，10组行业、11对关系；公开来源可追溯，未写入生产账号或数据库。
- Obsidian风格Canvas图谱：小点外置名称、薄线、行业聚集、拖拽跟随、悬停与固定选择分离、平移缩放、节点大小设置、局部同行及相机恢复。
- 搜索、1000条虚拟列表及键盘End/Home、详情及公开联系方式、窄屏列表、深浅主题与减少动态设置。
- 身份隔离会话几何缓存、30秒前台刷新、失效清空、请求竞态保护、离线提示和联网刷新；超过300家全图自动使用完整企业列表。
- 仅发本地结构化使用事件，不含搜索词、企业ID或联系方式；尚未接入业务统计接收方。

## 最终自动化验证

- 前端7文件79项通过：图谱、模型、会话缓存、虚拟列表、关闭保护、资料表单，以及现有园区服务58项回归。
- 后端4文件14项通过：行业规则、SQLite资料/迁移、集群路由、可见性与园区隔离。
- server、desktop main/preload/renderer类型检查通过。
- 本功能生产文件及园区窗口、模块目录针对性eslint零警告。
- renderer正式生产构建通过（约26.9秒）。
- CSV生成一致性、code-map及git diff --check通过。
- 当前工作目录doctor通过，源码49.97MB/50MB预算。原目录的历史doctor失败不代表本分支当前结果。

## 实际界面与性能观察

- 浏览器17家初始图、选中企业、同行详情、局部视图、拖拽不误点；720×900窄屏列表和全宽详情已观察。
- 本分支Electron实际园区入口及演示加载已观察。修复窗口较小时企业名称被全部隐藏的问题，50家以内保留标签；入口描述同步主营行业语义。最终Electron复核已确认名称显示；最小化再还原仍保留北控宏创演示及17家节点。
- React严格模式、避让布局版本：100家/4,950对业务关系/99条物理约束，稳定2358.9ms，布局帧间隔p95 17.3ms；300家/44,850对/299条，稳定2504.9ms，p95 18.7ms；1000家/499,500对/999条，稳定2968.3ms，p95 21ms。
- 20次关闭重开（40次按钮操作）后第41轮图谱正常恢复；300家实例稳定2329.7ms，p95 18.3ms。空闲5秒曾观察1次按钮触发的绘制，未观察持续重绘。
- 以上都是本机浏览器布局测量；不等同于首次可交互时间、拖拽输入延迟、双端性能、30秒CPU或堆内存无泄漏证明。

## 后续可选验证（不属于本次代码交付范围）

用户于2026-09-09明确将本次交付范围限定为代码开发，不要求真机验证。代码及自动化检查已完成。Windows实机、125%/150%系统缩放、用户测试、双账号在线联动及完整CPU/内存测量保留为后续可选验证，不阻塞本次代码交付；下表继续保留事实记录，不将未执行项标为通过。

## 运行方式

- 预览构建：`npx webpack --config packages/desktop/webpack.star-map.cjs`
- 本地预览：`python3 -m http.server 4387 --bind 127.0.0.1 --directory packages/desktop/star-map-preview-dist`
- 演示：`http://127.0.0.1:4387/`；性能夹具：`http://127.0.0.1:4387/?count=300`（可选100、1000）。
- 前端：在packages/desktop运行 `npx vitest run src/renderer/starMap src/renderer/components/EnterpriseStarMapView.test.tsx src/renderer/components/EnterprisePublicProfilePanel.test.tsx src/renderer/components/ParkServicesPlugin.test.tsx`。
- 后端：仓库根目录运行 `npx vitest run packages/server/src/modules/park_services/enterpriseIndustry.test.ts packages/server/src/modules/park_services/parkPartnershipRepository.test.ts packages/server/src/modules/park_services/parkCoreSchema.test.ts packages/server/src/enterprise/enterpriseStarMapRoutes.test.ts`。

## AC01–AC25证据索引

“自动化”只表示列明的回归覆盖；“观察”指本机实际界面；“源码”不等同于端到端通过。

| 验收项 | 证据与状态 |
| --- | --- |
| AC01 演示17/10/11 | 数据生成校验、model测试、浏览器和Electron观察；通过。 |
| AC02 精确同行连线 | enterpriseIndustry测试、repository测试；去重无向计数通过。Canvas不绘箭头。 |
| AC03 标签不决定行业 | 服务端仅标准代码匹配，规则测试；通过。 |
| AC04 缺失/未确认 | 服务端裁剪关系测试、UI行业待完善文案；完整人工流程未逐一执行。 |
| AC05 连线不弹解释 | Canvas只响应节点/背景，没有连线详情处理；源码证据。 |
| AC06 连接方式 | 浏览器真实菜单显示同行业及5个禁用规划项；通过。 |
| AC07 悬停与固定选择 | view测试、浏览器选择观察；通过。 |
| AC08 拖拽不误点 | 浏览器拖动后位置改变且未误打开详情；通过本机观察。 |
| AC09 相机稳定 | 会话缓存测试、Canvas按数据拓扑复用坐标；所有刷新时序仍需扩展人工检查。 |
| AC10 搜索与度数 | model及view测试；通过。 |
| AC11 跨范围搜索 | view局部范围退出与提示逻辑；需单独人工复核。 |
| AC12 局部返回 | view测试及浏览器同行局部观察；通过。 |
| AC13 关联数大小 | model边界/度数测试，设置明确提示；通过。 |
| AC14 密集簇 | model测试，300家使用299条物理约束；不展开完整边。 |
| AC15 空/单点/无关系 | 空数据与加载失败view测试，源码保留孤立点；单点人工未执行。 |
| AC16 同名不同ID | graphIndex按ID建索引及去重；长列表显示完整名称；同名辨认需产品人工复核。 |
| AC17 权限撤回 | route可见集测试、view失效清空测试；通过。 |
| AC18 网络/403 | view旧数据保留与拒绝清空测试；通过。 |
| AC19 演示幂等隔离 | 构建脚本确定性生成、独立demo来源；未写真实账号/数据库。 |
| AC20 企业资料事实 | CSV和生成JSON保持超目股份名/地址类型及新羿公开地址；数据一致性通过。 |
| AC21 公开渠道 | 安全URL校验、clipboard/openExternal成功失败处理；实际外链及系统剪贴板未逐一操作。 |
| AC22 键盘/减少动态 | 搜索键盘与1000条列表End/Home测试；减少动态实现，真实系统设置未完整观察。 |
| AC23 性能/释放 | 本机300、1000压力观察及20轮重开有记录；双平台输入延迟、CPU、内存未达到完整验收证据。 |
| AC24 异步竞态 | view倒序请求回归通过；账号失效使代次失效。 |
| AC25 修改行业 | profile保留公开状态、repository旧客户端兼容/清空/行业校验测试；跨两账号实时联动尚未人工验证。 |

外部验收仍包括Windows实机、125%/150%系统缩放和5位目标用户无引导测试；没有将这些项目标为通过。

## 2026-09-09 供需模式增量交付

- 新增供需连接方式及方向箭头、具体匹配说明；既有公开产品和需求精确词条匹配，未修改后端或资料保存接口。
- 新增独立8家虚拟企业/12对关系；支持演示需求完成/恢复，所有修改仅存于组件状态。
- 节点默认关联企业数；保留用户已保存的统一大小设置。企业对去重、两个方向不重复计数，大小不代表营收/员工数。
- 86项整组测试通过（含现有园区服务61项）；后续增加2项边界测试，相关15项重跑通过，共88项覆盖。现有园区服务测试有React act提示但无失败。
- renderer类型检查、针对性eslint、正式renderer构建、code-map:check及git diff --check通过。
- 本轮按用户要求仅交付代码，不执行真机验证；真实需求生命周期仍使用既有资料编辑，演示中的完成/恢复不写入真实数据。
- 新数据及可复现操作说明：`docs/data/supply-demand-demo/README.md`。
