# dsh-archive-manager

<div align="center">

[English](./README.en.md) · **中文**

</div>

DeepSeek Harness Web GUI 的**归档会话管理**插件，位于 **设置 > 归档会话**。harness 内置的"归档"是单向的：只隐藏会话、没有取消归档。本插件补齐浏览、恢复、真删除：

- **浏览** —— 列出已归档会话，按标题 / 目录 / id / 预设搜索。
- **恢复并打开** —— 取消归档并打开，可查看历史、继续对话。
- **删除** —— 物理移除会话日志目录，**不可逆**。

```
host:   归档集合 + 持久化标题/元数据  --archiveManager 服务--> 浏览器
client: 设置页"归档会话"（搜索 + 恢复并打开 + 删除）
```

## 安装

```sh
dsh plugin --profile web add dsh-archive-manager
```

随后重启 web 服务以加载 host 半边与新 client bundle。本地开发用 `dsh plugin --profile web add .`。

设置段位于 **设置 > 归档会话**。

## 配置

Host 侧可调参数在 `cordis.patch.yml` 的插件行上：

```yaml
- id: archive-manager
  name: dsh-archive-manager
  config:
    deleteSandbox: danger-full-access   # 删除日志目录用的沙箱模式
```

| 配置项 | 默认 | 作用 |
| --- | --- | --- |
| `deleteSandbox` | `danger-full-access` | 删除命令的运行模式。`danger-full-access` 不加限制；`workspace-write` 受限，主机会话根目录在允许根之外或无可用沙箱后端时会失败。共享/多租户主机请保持受限。 |

## 权限边界

- host 侧操作工作区注册表的**归档集合**与**持久化**状态：`list` 只读、`unarchive` 反向归档、`delete` 经 shell 移除日志目录；不写日志、不注册面向模型的工具。
- client 侧注册设置页 `settings.section`，通过 `archiveManager` 服务调用以上操作。

## 已知限制

- `delete` 会写到工作区之外（`~/.dsh/sessions/...`），受限沙箱下可能因根目录/后端不可用而失败。
- 恢复依赖 harness 的 `sessions.open`，取消归档后需等待列表刷新再打开（内置延迟）。

## License

MIT
