# dsh-archive-manager

[English](./README.en.md) · **中文**

[![npm package](https://img.shields.io/npm/v/@chushiz/dsh-archive-manager.svg?label=npm)](https://www.npmjs.com/package/@chushiz/dsh-archive-manager)
[![DSH Web Plugin](https://img.shields.io/badge/DSH%20Web-Plugin-0f766e.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

DeepSeek Harness Web GUI 的**归档会话管理**插件，位于 **设置 > 归档会话**。harness 内置的"归档"是单向的：只隐藏会话、没有取消归档。本插件补齐浏览、恢复、删除：

- **浏览** —— 按工作区分组列出已归档会话，支持标题 / 目录 / id / 预设 / **会话正文全文**搜索。
- **全文搜索** —— 基于 harness 的 `sessionQuery` SQLite FTS5 索引：用户消息、AI 回复、工具调用与参数、todo 全部可搜；命中高亮、关键词居中短窗口、每会话最多 5 条，可按类型筛选。
- **批量操作** —— 多选复选框 + 顶部批量删除；删除前自动停掉活着的 agent，避免文件占用。
- **对话预览** —— 点击标题展开最近 4 句对话（用户-AI 交替），无需恢复即可判断是否为目标会话。
- **恢复并打开** —— 取消归档并打开，可查看历史、继续对话。
- **删除** —— 物理移除会话日志目录，**不可逆**。

![搜索：类型筛选 + 关键词高亮](assets/screenshots/search-highlight.png)

![预览：点击标题展开 4 句对话](assets/screenshots/preview-dialog.png)

```
host:   归档集合 + 持久化标题/元数据  --archiveManager 服务--> 浏览器
client: 设置页"归档会话"（工作区分组 + 全文搜索 + 恢复并打开 + 删除）
```

## 安装

```sh
dsh plugin --profile web add @chushiz/dsh-archive-manager
```

安装后重启 `dsh web`，在 **设置 > 归档会话** 中使用。

## 兼容性

| dsh 版本 | 状态 |
| --- | --- |
| `>= 0.1.0-rc.7` | ✅ 支持（FTS5 搜索 + 服务直连） |
| `< 0.1.0-rc.7` | ⚠️ 未验证（依赖 `sessionQuery.searchSessions` 与 `webServer` 载体） |

- Node.js `^22.19 || >=24`（随 dsh 要求）
- 无 FTS 后端（`openAt: never`）时自动回退逐会话扫描；服务未代理到浏览器时自动回退 HTTP API

## 权限边界

- host 侧操作工作区注册表的**归档集合**与**持久化**状态：`list` 只读、`unarchive` 反向归档、`delete` 经 shell 移除日志目录；不写日志、不注册面向模型的工具。
- client 侧注册设置页 `settings.section`，通过 `archiveManager` 服务调用以上操作。

## License

MIT
