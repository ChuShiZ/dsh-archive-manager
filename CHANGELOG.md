# Changelog

## 0.11.0

- 新增自动归档（默认关闭）：按闲置天数 `autoArchive.maxAgeDays`（默认 5 天）和/或每工作区保留上限 `maxPerWorkspace` 归档旧会话。
- 固定安全行为：跳过已归档 / 置顶 / 打开或运行中的会话、subagent 子会话，`minAgeDays` 保护近期活跃会话；取消归档后按 `maxAgeDays` 天冷静期，避免刚恢复又被归档。
- 最后活动时间取 JSONL 日志文件 mtime（不读正文），非 JSONL 后端退回会话创建时间；新增 `autoArchive/status` 与 `autoArchive/run` HTTP 路由。
- 新增「插件」页配置卡片：在 **插件 → dsh-archive-manager** 直接修改自动归档选项，配置以 volatile 字段持久化到当前 profile 并即时生效，无需手改 `cordis.patch.yml`；删除沙箱 / 标题预热仍为 YAML 配置。
- 自动归档策略改为运行时读取（volatile 引用），修改开关/阈值无需重载插件；调度器轮询配置以支持实时启用/停用。
- 修复：自动归档不再处理任务派生的子会话，归档页也会隐藏它们；每个项目的数量按项目目录分组统计（Windows 路径大小写/分隔符差异会合并）。
- 修复：恢复冷静期持久化到 `$DSH_HOME/archive-manager/grace.json`，重启后仍生效；启动时以当前归档集为基线。
- 加固：HTTP `/autoArchive/run` 不接受策略覆盖，未启用时返回 409；卡片只保留「启用自动归档」开关和数值项（去掉演练/置顶/停活等额外开关），「立即扫描」二次确认后执行；sweep 单飞、每轮上限 50、归档前复查 live/pin/已归档、pin 读取失败中止、整数/step 校验、错误上限、停用后中止进行中的扫描。
- 修复：插件页配置卡读取 `archiveManager` 时不再直接访问未注入的服务（此前会显示 “cannot get property archiveManager without inject”），改为 `ctx.get()` + HTTP 兜底。
- 测试：30 项（新增子会话过滤、quota 归一化、整数覆盖、跨重启冷静期、HTTP 覆盖参数、pin fail-closed、单飞、每轮上限、pin 占配额）。
- `package.json` 增加 `keywords`（`dsh-plugin` / `deepseek-harness` / `archive` 等），提升 npm 搜索与插件市场收录曝光。
- README 兼容表补充 `0.2.1-rc.5` 实测记录。

## 0.10.0

- 搜索：宿主结果缓存（60s）、请求取消、中文输入法防抖；payload 去掉重复的 `fullText` / `snippet` / `bestMatch`，默认每会话 3 条命中。
- 搜索结果默认只展示 1 条命中，可展开/收起其余命中。
- 分组键改用完整 `cwd`，同名目录不再合并；分组头 hover 显示完整路径。
- 修复关闭设置页后仍继续补标题、切换搜索后选择状态残留、标题 tooltip 不显示全名。
- 分组间距归零，吸顶标题交接无空档。

## 0.9.0

- 新增 Config schema：`deleteSandbox` / `warmTitles` / `warmDelayMs` 可通过 `cordis.yml` 配置。
- 补 `export const name`；`dsh.client.inject` 增加 settings UI 包；设置页 label 走 locale namespace。
- 可选服务 `agents` 改用 `ctx.get()`。

## 0.8.0

- 安全：插件 HTTP 路由的 Host/Origin/Sec-Fetch-Site 信任校验对齐 `isTrustedApiRequest`，拒绝非本监听地址与跨站请求。
- 删除：`sessionPersistence.locate` 能力守卫、`shell.resolve` 能力检查。
- 发布：加 `engines.dsh`、`prepack`、CI build+test；host 不再生成未使用的 `lib/index.js`。

## 0.7.x

- 首屏：`list()` 只读会话头，标题拆成 `titles()` 按需缓存 + 后台预热 + 本地缓存。
- 分组可折叠；默认折叠策略；搜索时也可折叠；单滚动条 + 分组标题吸顶。
