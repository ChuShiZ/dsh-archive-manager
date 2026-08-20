# dsh-archive-manager

<div align="center">

English · [中文](./README.md)

</div>

A DeepSeek Harness Web GUI plugin for managing **archived** sessions, under **Settings > 归档会话**. The harness's built-in "archive" is one-way: it only hides a session, with no un-archive. This plugin adds browse, restore, and true delete:

- **Browse** — list archived sessions, searchable by title / cwd / id / preset.
- **Restore & open** — un-archive and open, so you can view history and continue the conversation.
- **Delete** — physically removes the session's log directory. **Irreversible.**

```
host:   archive set + persisted title/metadata  --archiveManager service--> browser
client: Settings page "归档会话" (search + restore & open + delete)
```

## Install

```sh
dsh plugin --profile web add dsh-archive-manager
```

Then restart the web service to load the host half and the new client bundle. For local development use `dsh plugin --profile web add .`.

The settings section lives under **Settings > 归档会话**.

## Configuration

Host-side options live on the plugin row in `cordis.patch.yml`:

```yaml
- id: archive-manager
  name: dsh-archive-manager
  config:
    deleteSandbox: danger-full-access   # sandbox mode used when deleting the log dir
```

| Option | Default | Effect |
| --- | --- | --- |
| `deleteSandbox` | `danger-full-access` | Mode for the delete command. `danger-full-access` runs unconfined; `workspace-write` is confining and fails when the host session root is outside the allowed roots or no sandbox backend is usable. Keep it confined on shared/multi-tenant hosts. |

## Permission boundary

- The **host** half reads/writes the workspace registry's **archive set** and **persistence** state: `list` is read-only, `unarchive` reverses an archive, `delete` removes the log directory via a shell command. It never writes logs and registers no model-facing tools.
- The **client** half registers the `settings.section` page and calls the `archiveManager` service.

## Known limitations

- `delete` writes outside the workspace (`~/.dsh/sessions/...`), so under a confined sandbox it may fail if the root is outside allowed roots or no backend is usable.
- Restore relies on the harness's `sessions.open`; after un-archiving you must wait for the list refresh before opening (a built-in delay).

## License

MIT
