# dsh-archive-manager

English · [中文](./README.md)

[![npm package](https://img.shields.io/npm/v/@chushiz/dsh-archive-manager.svg?label=npm)](https://www.npmjs.com/package/@chushiz/dsh-archive-manager)
[![DSH Web Plugin](https://img.shields.io/badge/DSH%20Web-Plugin-0f766e.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A DeepSeek Harness Web GUI plugin for managing **archived** sessions, under **Settings > 归档会话**. The harness's built-in "archive" is one-way: it only hides a session, with no un-archive. This plugin adds browse, restore, and true delete:

- **Browse** — archived sessions grouped by workspace. Groups collapse: short archives stay expanded, longer ones fold into one row per project (every project readable at a glance); expand/collapse-all is one click away and the collapse state is remembered. Search results fold the same way; there is a single outer scrollbar and each project header pins to the top as you scroll through its sessions, then hands the pin to the next project's header.
- **Fast first paint** — the list reads stored session headers only; titles come from a host + localStorage cache and are warmed in the background, instead of waiting on each session's full log.
- **Full-text search** — searches session content: user messages, assistant replies, and tool-call commands and output, plus title / cwd / id / preset matching. Highlighted, keyword-centered snippets, up to 3 hits per session (one shown by default, expandable), filterable by type.
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

## Configuration

Set config on the `id: archive-manager` row in the profile `cordis.patch.yml`:

```yaml
- id: archive-manager
  config:
    deleteSandbox: danger-full-access   # or workspace-write
    warmTitles: true                    # warm the title cache after startup
    warmDelayMs: 6000                   # warm-up delay in ms (0-60000)
```

| Field | Default | Meaning |
| --- | --- | --- |
| `deleteSandbox` | `danger-full-access` | Shell sandbox mode for deleting a session log |
| `warmTitles` | `true` | Fold archived titles in the background for a faster settings page |
| `warmDelayMs` | `6000` | Delay before the background warm-up starts |

## Compatibility

| dsh version | status |
| --- | --- |
| `0.2.1-rc.3` | ✅ tested locally: list, search, preview (delete needs backend log-location support; the JSONL backend has it) |
| `0.2.0-rc.2` | ✅ tested historically |
| other versions | ⚠️ declared by `engines.dsh`: `>=0.2.0-rc.2 <0.3.0` |

## Security

- Delete has no recycle bin: a `node -e` command `rmSync`s that session's own directory (`<sessions>/<workspace>/<session id>/`). **Irreversible.**
- That command runs in the `danger-full-access` sandbox mode by default (a caller may pass `workspace-write` to tighten it), applies only to **archived** sessions, and cancels any still-running agent for that session first.
- The web routes `/archive-manager/api/*` are separate from the GUI's browser authentication (the host web server only routes; each route owner owns its trust policy). They trust only this listener's Host authority or a loopback spelling of it (with the listener port), refuse `Sec-Fetch-Site: cross-site`, require an `Origin` (when present) to match that authority, and cap bodies at 8 KiB.

## License

MIT
