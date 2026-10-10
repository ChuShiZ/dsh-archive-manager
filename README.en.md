# dsh-archive-manager

English · [中文](./README.md)

[![npm package](https://img.shields.io/npm/v/@chushiz/dsh-archive-manager.svg?label=npm)](https://www.npmjs.com/package/@chushiz/dsh-archive-manager)
[![DSH Web Plugin](https://img.shields.io/badge/DSH%20Web-Plugin-0f766e.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A DeepSeek Harness Web GUI plugin for managing **archived** sessions, under **Settings > 归档会话**. The harness's built-in "archive" is one-way: it only hides a session, with no un-archive. This plugin adds browse, restore, and true delete:

- **Browse** — archived sessions grouped by workspace.
- **Full-text search** — searches session content: user messages, assistant replies, and tool-call commands and output, plus title / cwd / id / preset matching. Highlighted, keyword-centered snippets, up to 5 hits per session, filterable by type.
- **Batch ops** — checkboxes + top-bar batch delete; live agents are cancelled before removal.
- **Preview** — click the title to expand the last 4 user/assistant messages without restoring.
- **Restore & open** — un-archive and open, so you can view history and continue the conversation.
- **Delete** — physically removes the session's log directory. **Irreversible.**

![Search: type filters + keyword highlighting](assets/screenshots/search-highlight.png)

![Preview: last 4 user/assistant messages on title click](assets/screenshots/preview-dialog.png)

## Install

```sh
dsh plugin --profile web add @chushiz/dsh-archive-manager
```

Refresh the page after installing (Cmd/Ctrl+Shift+R); restart `dsh` if it does not show up. On Desktop, install it from the plugin market in Settings (**设置 → 插件市场**).

## Compatibility

| dsh version | status |
| --- | --- |
| `0.2.0-rc.2` | ✅ tested locally: list, search and preview work |
| other versions | ⚠️ not tested |

## Security

- Delete has no recycle bin: a `node -e` command `rmSync`s that session's own directory (`<sessions>/<workspace>/<session id>/`). **Irreversible.**
- That command runs in the `danger-full-access` sandbox mode by default (a caller may pass `workspace-write` to tighten it), applies only to **archived** sessions, and cancels any still-running agent for that session first.
- The web routes `/archive-manager/api/*` use the same trust fence as the host's `/api`: a mandatory Host header (DNS-rebinding defense), cross-site origins refused, an 8 KiB body cap.

## License

MIT
