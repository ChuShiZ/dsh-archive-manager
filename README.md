# dsh-archive-manager

[English](./README.en.md) · **中文**

[![npm package](https://img.shields.io/npm/v/@chushiz/dsh-archive-manager.svg?label=npm)](https://www.npmjs.com/package/@chushiz/dsh-archive-manager)
[![DSH Web Plugin](https://img.shields.io/badge/DSH%20Web-Plugin-0f766e.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

DeepSeek Harness Web GUI 的**归档会话管理**插件，位于 **设置 > 归档会话**。harness 内置的"归档"是单向的：只隐藏会话、没有取消归档。本插件补齐浏览、恢复、删除：

- **浏览** —— 按工作区分组列出已归档会话。
- **全文搜索** —— 可搜会话正文：用户消息、AI 回复、工具调用的命令与输出，也能按标题 / 目录 / id / 预设匹配；命中高亮、关键词居中短窗口、每会话最多 5 条，可按类型筛选。
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


## 兼容性

| dsh 版本 | 状态 |
| --- | --- |
| `0.2.0-rc.2` | ✅ 本机实测：列表、搜索、预览正常 |
| 其他版本 | ⚠️ 未实测 |

## License

MIT
