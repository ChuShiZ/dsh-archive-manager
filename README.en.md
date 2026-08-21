# dsh-archive-manager

<div align="center">

English · [中文](./README.md)

</div>

A DeepSeek Harness Web GUI plugin for managing **archived** sessions, under **Settings > 归档会话**. The harness's built-in "archive" is one-way: it only hides a session, with no un-archive. This plugin adds browse, restore, and true delete:

- **Browse** — list archived sessions, searchable by title / cwd / id / preset / **full-text content** (FTS5 over user/assistant/tool messages, hit shows snippet).
- **Restore & open** — un-archive and open, so you can view history and continue the conversation.
- **Delete** — physically removes the session's log directory. **Irreversible**.

```
host:   archive set + persisted title/metadata  --archiveManager service--> browser
client: Settings page "归档会话" (search + restore & open + delete)
```

## Install

```sh
dsh plugin --profile web add @chushiz/dsh-archive-manager
```

Restart `dsh web` after install, then find it under **Settings > 归档会话**.

## Permission boundary

- The **host** half reads/writes the workspace registry's **archive set** and **persistence** state: `list` is read-only, `unarchive` reverses an archive, `delete` removes the log directory via a shell command. It never writes logs and registers no model-facing tools.
- The **client** half registers the `settings.section` page and calls the `archiveManager` service.

## Known limitations

- `delete` writes outside the workspace (`~/.dsh/sessions/...`), so under a confined sandbox it may fail if the root is outside allowed roots or no backend is usable.
- Restore relies on the harness's `sessions.open`; after un-archiving you must wait for the list refresh before opening (a built-in delay).

## License

MIT
