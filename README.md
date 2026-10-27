# dsh-archive-manager

[English](./README.en.md) · **中文**

[![npm package](https://img.shields.io/npm/v/@chushiz/dsh-archive-manager.svg?label=npm)](https://www.npmjs.com/package/@chushiz/dsh-archive-manager)
[![DSH Web Plugin](https://img.shields.io/badge/DSH%20Web-Plugin-0f766e.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

DeepSeek Harness Web GUI 的**归档会话管理**插件，位于 **设置 > 归档会话**。harness 内置的"归档"是单向的：只隐藏会话、没有取消归档。本插件补齐浏览、恢复、删除：

- **浏览** —— 按工作区分组列出已归档会话；分组可折叠，会话少时默认全展开、归档多时默认折成项目行（一眼看全所有项目），展开/折叠全部一键切换，折叠状态自动记忆；搜索时同样可折叠，列表只有外侧一条滚动条，分组标题滚动到顶部时吸顶，滚到下个项目自动换成下一个项目的标题，某个项目会话再多也不会找不到自己滚到哪了。
- **快速首屏** —— 列表只读会话头，标题走内存 + 本地双层缓存并由后台预热，不再在每个会话的完整日志上等待。
- **全文搜索** —— 可搜会话正文：用户消息、AI 回复、工具调用的命令与输出，也能按标题 / 目录 / id / 预设匹配；命中高亮、关键词居中短窗口、每会话最多 3 条（默认只显示 1 条，可展开），可按类型筛选。
- **批量操作** —— 多选复选框 + 顶部批量删除；删除前自动停掉活着的 agent，避免文件占用。
- **对话预览** —— 点击标题展开最近 4 条用户 / AI 消息，无需恢复即可判断是否为目标会话。
- **恢复并打开** —— 取消归档并打开，可查看历史、继续对话。
- **删除** —— 物理移除会话日志目录，**不可逆**。

![搜索：类型筛选 + 关键词高亮](assets/screenshots/search-highlight.png)

![预览：点击标题展开最近 4 条用户 / AI 消息](assets/screenshots/preview-dialog.png)

## 安装

```sh
dsh plugin --profile web add @chushiz/dsh-archive-manager
```


## 配置

配置写在 profile 的 `cordis.patch.yml` 中 `id: archive-manager` 那一行：

```yaml
- id: archive-manager
  config:
    deleteSandbox: danger-full-access   # 或 workspace-write
    warmTitles: true                    # 启动后是否预热标题缓存
    warmDelayMs: 6000                   # 预热延迟（毫秒）
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `deleteSandbox` | `danger-full-access` | 删除会话日志时使用的 shell 沙箱模式 |
| `warmTitles` | `true` | 启动后台读取归档标题，打开设置页更快 |
| `warmDelayMs` | `6000` | 后台预热延迟（0–60000） |

## 兼容性

| dsh 版本 | 状态 |
| --- | --- |
| `0.2.1-rc.3` | ✅ 本机实测：列表、搜索、预览（删除需要后端提供日志目录定位，JSONL 后端满足） |
| `0.2.0-rc.2` | ✅ 历史实测 |
| 其他版本 | ⚠️ 由 `engines.dsh` 声明范围 `>=0.2.0-rc.2 <0.3.0` |

## 安全

- `/archive-manager/api/*` 是插件自己的浏览器路由，不经过 GUI 的浏览器登录认证；它只信任指向本监听地址或 loopback 的 Host、拒绝 `Sec-Fetch-Site: cross-site`，Origin 存在时必须与 Host 同源，请求体上限 8 KiB。

## License

MIT
