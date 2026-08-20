/**
 * Host half of dsh-archive-manager.
 *
 * A Cordis plugin row (see cordis.patch.yml) that provides the `archiveManager`
 * service:
 *   - list()      archived sessions still in persistence (ghosts dropped), with
 *                 folded titles via sessionQuery.
 *   - unarchive() remove an id from the durable workspace archive set.
 *   - delete()    truly remove the archived session's on-disk JSONL log dir.
 *
 * Installed as a profile bundle:  dsh plugin --profile <profile> add dsh-archive-manager
 * The client half (src/client/index.js + the `dsh.client` entry) reaches this
 * service through the harness's service/Remote plumbing.
 */
import { resolveConfig } from './config.js';

/** Plugin identity used by the loader (matches row `id` in cordis.patch.yml). */
export const id = 'archive-manager';

/** Hard dependencies on harness services. */
export const inject = ['sessionPersistence', 'workspaceRegistry', 'fs', 'shell', 'sessionQuery'];

/**
 * The Cordis plugin. `apply(ctx)` runs once the injected services exist.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const { sessionPersistence, workspaceRegistry, fs, shell, sessionQuery } = ctx;

  return ctx.provide('archiveManager', {
    /** List archived sessions that still exist in persistence. */
    async list() {
      const archived = workspaceRegistry.archivedSessionIds || [];
      const headers = await sessionPersistence.list();
      const byId = new Map();
      for (const h of headers) byId.set(h.id, h);
      const present = archived.filter((id) => byId.has(id));

      const titles = new Map();
      if (present.length > 0) {
        try {
          const snaps = await sessionQuery.readTitleSnapshots(present);
          for (const r of snaps) {
            if (r.status === 'fulfilled') {
              const t = r.value && r.value.title;
              titles.set(r.sessionId, t && typeof t.title === 'string' ? t.title : '');
            }
          }
        } catch (_e) {
          /* titles are optional; fall back to cwd/id */
        }
      }

      const rows = present.map((id) => {
        const h = byId.get(id);
        return {
          id,
          title: titles.get(id) || '',
          cwd: h.cwd || '',
          createdAt: h.createdAt || 0,
          agentPreset: h.agentPreset || '',
        };
      });
      rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return { rows };
    },

    /** Remove an id from the durable archive set (reverse of archiveSession). */
    async unarchive(id) {
      if (!id) throw new Error('缺少会话 id');
      const reg = ctx.workspaceRegistry;
      const run = async () => {
        const state = reg.requireState();
        if (!state.archivedSessionIds.includes(id)) return;
        await reg.setState({
          ...state,
          archivedSessionIds: state.archivedSessionIds.filter((x) => x !== id),
        });
      };
      if (typeof reg.enqueueOperation === 'function') await reg.enqueueOperation(run);
      else await run();
      return { ok: true };
    },

    /** Truly delete the archived session's on-disk JSONL log directory. */
    async delete(id, configOverride) {
      if (!id) throw new Error('缺少会话 id');
      const config = resolveConfig(configOverride);

      const archived = workspaceRegistry.archivedSessionIds || [];
      if (!archived.includes(id)) {
        throw new Error('只能删除已归档的会话（活动会话请先用内置菜单归档）');
      }

      const headers = await sessionPersistence.list();
      const header = headers.find((h) => h.id === id);
      if (header === undefined) return { ok: true, alreadyGone: true };

      const loc = sessionPersistence.locate({ cwd: header.cwd, id });
      const dir = String(loc.path).replace(/[\\/][^\\/]*$/, '');

      const target = await fs.resolve(dir);
      const info = await fs.stat(target);
      if (info === undefined) return { ok: true, alreadyGone: true };

      // ShellExecRequest has NO args field: build the full command string and pass
      // the dir via process.argv[1], avoiding nested-quoting/escaping.
      const script = "require('fs').rmSync(process.argv[1],{recursive:true,force:true})";
      const commandLine = 'node -e "' + script + '" ' + JSON.stringify(dir);
      const spec = shell.resolve({
        command: commandLine,
        sandboxPolicy: { mode: config.deleteSandbox, workspaceRoot: dir },
      });

      const result = await shell.run(spec);
      if (result && result.exitCode !== 0) {
        const raw = result.stderr;
        const errText = typeof raw === 'string' ? raw : raw ? JSON.stringify(raw) : '';
        throw new Error('删除命令失败 (exit ' + result.exitCode + '): ' + errText + '  [' + dir + ']');
      }

      const after = await fs.stat(await fs.resolve(dir));
      if (after !== undefined) {
        throw new Error('目录删除后仍存在（可能被占用或沙箱限制）: ' + dir);
      }
      return { ok: true };
    },
  });
}
