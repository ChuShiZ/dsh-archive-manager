# dsh-archive-manager

English · [中文](./README.md)

[![npm package](https://img.shields.io/npm/v/@chushiz/dsh-archive-manager.svg?label=npm)](https://www.npmjs.com/package/@chushiz/dsh-archive-manager)
[![DSH Web Plugin](https://img.shields.io/badge/DSH%20Web-Plugin-0f766e.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

DSH can archive a session but cannot undo it. This plugin adds the missing side under **Settings > Archived Sessions**: browse, search, restore, and delete archived sessions, plus optional automatic archiving for old conversations you no longer use.

## Features

- **Browse** — archived sessions grouped by project, with collapsible groups. The list opens fast because it only reads session headers.
- **Search** — look through conversation content, titles, and folders. Matches are highlighted, and you can filter by user message, assistant reply, or tool call.
- **Preview** — click a title to see the latest messages without restoring the session.
- **Restore & open** — un-archive a session and continue the conversation.
- **Batch delete** — select several sessions and delete them together. Deleting removes the conversation for good, so it **cannot be undone**.
- **Automatic archiving** — archive old sessions by idle days or by how many sessions a project keeps. Pinned and in-use sessions are never archived, and a restored session will not be archived again right away.
- **Settings in the Plugins page** — open **Plugins → dsh-archive-manager** to change the automatic archiving options; changes apply immediately with no config-file editing.

![Search: type filters + keyword highlighting](assets/screenshots/search-highlight.png)

![Preview: latest messages without restoring](assets/screenshots/preview-dialog.png)

## Install

Install **dsh-archive-manager** from the DSH plugin market, or run:

```sh
dsh plugin --profile web add @chushiz/dsh-archive-manager
```

Refresh the page after installing; restart DSH if it does not show up.

## Usage

Open **Settings > Archived Sessions** to browse, search, preview, restore, or delete archived sessions.

## Automatic archiving

Open **Plugins → dsh-archive-manager** and turn on "Enable automatic archiving". It is off by default.

You can set:

| Setting | Default | Meaning |
| --- | --- | --- |
| Idle days | 5 | Archive sessions unused for this many days; 0 means don't archive by time |
| Keep per project | 0 | Keep at most this many unarchived sessions per project, archiving the oldest extras; 0 means no limit |
| Safety window (days) | 1 | Sessions used within this many days are never archived |
| Check interval (minutes) | 60 | How often to check |
| First check delay (ms) | 60000 | How long after startup the first check runs |

Sessions matching either rule are archived and can always be restored from **Settings > Archived Sessions**. To run a check right away, click "Scan now" (you'll be asked to confirm).

## Compatibility

| DSH version | Status |
| --- | --- |
| 0.2.1-rc.5 | ✅ tested locally |
| 0.2.1-rc.3 | ✅ tested |
| 0.2.0-rc.2 | ✅ tested |
| other 0.2.x | likely works; prefer the versions above |

## License

MIT
