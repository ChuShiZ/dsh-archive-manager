# Changelog

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
