/**
 * Host half of dsh-archive-manager.
 *
 * A Cordis plugin row (see cordis.patch.yml) that provides the `archiveManager`
 * service:
 *   - list()      archived sessions still in persistence (ghosts dropped); fast
 *                 (headers only), with titles served from an in-memory cache.
 *   - titles()    fold titles for given ids (one full-log read each, cached).
 *   - unarchive() remove an id from the durable workspace archive set.
 *   - delete()    truly remove the archived session's on-disk JSONL log dir.
 *
 * Installed as a profile bundle:  dsh plugin --profile <profile> add dsh-archive-manager
 * The client half (src/client/index.js + the `dsh.client` entry) reaches this
 * service through the harness's service/Remote plumbing.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import Schema from '@deepseek-ai/schemastery';
import { defaultConfig, resolveAutoArchive, resolveConfig } from './config.js';

/** Plugin identity (Cordis/docs convention: `name`; matches the loader row id). */
export const name = 'archive-manager';

/** Legacy module identity kept for older harness builds that read `id`. */
export const id = name;

/**
 * Plugin config schema: Cordis validates the row's `config` and fills defaults.
 */
export const Config = Schema.object({
  deleteSandbox: Schema.union(['danger-full-access', 'workspace-write']).default(defaultConfig.deleteSandbox),
  warmTitles: Schema.boolean().default(defaultConfig.warmTitles),
  warmDelayMs: Schema.number().min(0).max(60000).step(500).default(defaultConfig.warmDelayMs),
  // Only the auto-archive policy is exposed on the Plugins page. Its volatile
  // declaration lets the DSH settings service derive a live form and update the
  // reference in place, so the plugin reads `.get()` at decision time.
  autoArchive: Schema.object({
    enabled: Schema.boolean().default(defaultConfig.autoArchive.enabled),
    maxAgeDays: Schema.number().min(0).max(3650).step(1).default(defaultConfig.autoArchive.maxAgeDays),
    maxPerWorkspace: Schema.number().min(0).max(1000).step(1).default(defaultConfig.autoArchive.maxPerWorkspace),
    minAgeDays: Schema.number().min(0).max(3650).step(1).default(defaultConfig.autoArchive.minAgeDays),
    intervalMinutes: Schema.number().min(5).max(1440).step(5).default(defaultConfig.autoArchive.intervalMinutes),
    startDelayMs: Schema.number().min(0).max(300000).step(1000).default(defaultConfig.autoArchive.startDelayMs),
  }).volatile(),
});

/** Hard dependencies on harness services. `agents` is optional (best-effort live-agent stop before delete). */
export const inject = ['sessionPersistence', 'workspaceRegistry', 'fs', 'shell', 'sessionQuery'];

/**
 * The Cordis plugin. `apply(ctx)` runs once the injected services exist.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx, config) {
  const settings = resolveConfig(config);
  /** Live read: the volatile auto-archive policy changes in place without a remount. */
  const readAutoArchive = () => resolveAutoArchive(config && config.autoArchive);
  const { sessionPersistence, workspaceRegistry, fs, shell, sessionQuery } = ctx;

  /**
   * Normalize one `sessionPersistence.list()` / `stat()` entry to a SessionHeader.
   *
   * DSH >= 0.1.5-rc.1 (including 0.2.0-rc.2) returns snapshots shaped
   * `{ header, revision, sizeBytes? }`; older backends returned the bare header.
   * Reading `entry.id` off a snapshot yields `undefined`, which silently emptied
   * every archived-session join — the root cause of issue #2.
   */
  function snapshotHeader(entry) {
    if (entry === null || typeof entry !== 'object') return undefined;
    const header = entry.header;
    return header !== null && typeof header === 'object' ? header : entry;
  }

  /** `list()` snapshots → headers, order preserved, unusable entries dropped. */
  function headersOf(snapshots) {
    const headers = [];
    for (const snap of snapshots || []) {
      const header = snapshotHeader(snap);
      if (header && header.id) headers.push(header);
    }
    return headers;
  }

  // ── Title cache ────────────────────────────────────────────────────────
  // Folding a title reads the session's WHOLE event log: on a real profile one
  // archived log decompresses to ~19 MB and costs ~1s. Titles must therefore
  // never block the first paint: list() serves this cache and reports the ids
  // that still need a title, and the client asks for those through titles(ids)
  // after the rows are already on screen.
  const TITLE_CACHE_LIMIT = 500;
  const titleCache = new Map(); // id -> folded title ('' = log has no title event)
  const titlePending = new Map(); // id -> Promise, dedupes concurrent reads
  const titleEpoch = new Map(); // id -> generation, bumped when a title is forgotten
  let listInflight = null;

  function cachedTitle(id) {
    const title = titleCache.get(id);
    return typeof title === 'string' ? title : '';
  }

  function forgetTitle(id) {
    titleCache.delete(id);
    titleEpoch.set(id, (titleEpoch.get(id) || 0) + 1);
  }

  /** Fold the given ids' titles, reusing cached values; resolves { id: title }. */
  async function readTitles(ids) {
    const wanted = [];
    const seen = new Set();
    for (const raw of ids || []) {
      const id = String(raw || '');
      if (!id || seen.has(id) || titleCache.has(id)) continue;
      seen.add(id);
      wanted.push(id);
    }
    const titles = {};
    if (wanted.length === 0) return titles;

    const waits = [];
    const fresh = [];
    for (const id of wanted) {
      const pending = titlePending.get(id);
      if (pending) waits.push(pending);
      else fresh.push(id);
    }
    if (fresh.length > 0) {
      const run = (async () => {
        const epochs = new Map(fresh.map((id) => [id, titleEpoch.get(id) || 0]));
        try {
          const snaps = await sessionQuery.readTitleSnapshots(fresh);
          for (const r of snaps) {
            if (!r || r.status !== 'fulfilled') continue;
            // A title forgotten (unarchive/delete) while the log was being read
            // must not be cached again by this stale observation.
            if ((titleEpoch.get(r.sessionId) || 0) !== (epochs.get(r.sessionId) || 0)) continue;
            const folded = r.value && r.value.title;
            titleCache.set(r.sessionId, folded && typeof folded.title === 'string' ? folded.title : '');
          }
        } catch (_e) {
          /* titles stay missing; retried on the next open */
        } finally {
          for (const id of fresh) titlePending.delete(id);
        }
      })();
      for (const id of fresh) titlePending.set(id, run);
      waits.push(run);
    }
    await Promise.all(waits);
    for (const id of wanted) {
      if (titleCache.has(id)) titles[id] = cachedTitle(id);
    }
    while (titleCache.size > TITLE_CACHE_LIMIT) {
      const oldest = titleCache.keys().next().value;
      if (oldest === undefined) break;
      titleCache.delete(oldest);
      titleEpoch.delete(oldest);
    }
    return titles;
  }

  async function listArchived() {
    const archived = workspaceRegistry.archivedSessionIds || [];
    const headers = headersOf(await sessionPersistence.list());
    const byId = new Map();
    // Subagent child logs never surface in the archived-sessions page.
    for (const h of headers) if (!isChildSession(h)) byId.set(h.id, h);
    const present = archived.filter((id) => byId.has(id));

    const rows = present.map((id) => {
      const h = byId.get(id);
      return {
        id,
        title: cachedTitle(id),
        cwd: h.cwd || '',
        workspace: basenameOf(h.cwd),
        createdAt: h.createdAt || 0,
        agentPreset: h.agentPreset || '',
      };
    });
    rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    // Newest rows first, so the client fills the visible titles first.
    const titlesMissing = rows.filter((row) => !titleCache.has(row.id)).map((row) => row.id);
    return { rows, byId, present, titlesMissing };
  }

  function basenameOf(p) {
    const s = String(p || '').replace(/[\\/]+$/, '');
    const parts = s.split(/[\\/]/);
    return parts[parts.length - 1] || s;
  }

  // ── Search display helpers ─────────────────────────────────────────────
  // Same matching semantics as session-query's compileSessionTextFilter:
  // case-insensitive, whitespace-flexible, regex-safe literal terms.
  function buildKeywordRegex(query) {
    const pattern = String(query).trim().split(/\s+/u)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
      .join('\\s+');
    return new RegExp(pattern, 'giu');
  }

  // Display-only noise reduction: collapse long path-like runs to …\last-segment,
  // squash whitespace. Raw logs are never touched.
  function normalizeForDisplay(text) {
    let s = String(text || '');
    s = s.replace(/[^\s"']*[\\/][^\s"']*/g, (m) => {
      if (m.length <= 48) return m;
      const parts = m.split(/[\\/]/).filter(Boolean);
      const last = parts[parts.length - 1] || m;
      return '…' + (m.includes('\\') ? '\\' : '/') + last;
    });
    return s.replace(/\s+/gu, ' ').trim();
  }

  // Cut a keyword-centered window and return structured segments for <mark> rendering.
  // Returns [{ text, hit }]; hit=true segments should be highlighted client-side.
  function buildSnippetSegments(text, keywordRegex, radius = 40) {
    const normalized = normalizeForDisplay(text);
    keywordRegex.lastIndex = 0;
    const m = keywordRegex.exec(normalized);
    if (!m) {
      return [{ text: normalized.slice(0, radius * 2) + (normalized.length > radius * 2 ? '…' : ''), hit: false }];
    }
    const start = Math.max(0, m.index - radius);
    const end = Math.min(normalized.length, m.index + m[0].length + radius);
    let window = normalized.slice(start, end);
    if (start > 0) window = '…' + window;
    if (end < normalized.length) window = window + '…';

    // Split the window on keyword occurrences into segments.
    const segments = [];
    let last = 0;
    keywordRegex.lastIndex = 0;
    let km;
    while ((km = keywordRegex.exec(window)) !== null) {
      if (km.index > last) segments.push({ text: window.slice(last, km.index), hit: false });
      segments.push({ text: km[0], hit: true });
      last = km.index + km[0].length;
      if (km[0].length === 0) keywordRegex.lastIndex++;
    }
    if (last < window.length) segments.push({ text: window.slice(last), hit: false });
    return segments.length > 0 ? segments : [{ text: window, hit: false }];
  }

  // ── Search result cache ────────────────────────────────────────────────
  // A full-text scan rereads every archived log, so identical queries (chip
  // toggles, clearing and retyping, reopening the panel) are served from memory.
  const SEARCH_CACHE_TTL_MS = 60 * 1000;
  const SEARCH_CACHE_LIMIT = 20;
  const searchCache = new Map();

  function rememberSearch(key, result) {
    searchCache.delete(key);
    searchCache.set(key, { time: Date.now(), result });
    while (searchCache.size > SEARCH_CACHE_LIMIT) {
      const oldest = searchCache.keys().next().value;
      if (oldest === undefined) break;
      searchCache.delete(oldest);
    }
    return result;
  }

  function invalidateSearch() {
    searchCache.clear();
  }

  // ── Auto archive ───────────────────────────────────────────────────────
  // Policy sweep over stored sessions: idle-age and per-workspace quota rules,
  // applied through the public workspace-registry archive seam. The archive set
  // is the same durable state the built-in archive uses, so every automatic
  // archive is reversible from 设置 > 归档会话.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const AUTO_ARCHIVE_PREVIEW_LIMIT = 100;
  const AUTO_ARCHIVE_MAX_PER_RUN = 50;
  const AUTO_ARCHIVE_MAX_ERRORS = 20;
  const GRACE_LIMIT = 2000;
  const unarchiveCooldown = new Map(); // id -> deadline (ms); set when the user restores a session
  let autoArchiveLast = null;
  let autoArchiveInflight = null;
  // Archived ids baseline: lets the first sweep of a process detect restores made
  // after startup even though the durable grace file only knows our own restores.
  let lastArchivedIds = new Set(workspaceRegistry.archivedSessionIds || []);

  // Restore grace survives restarts in $DSH_HOME/archive-manager/grace.json.
  const graceDir = () => join(process.env.DSH_HOME || join(os.homedir(), '.dsh'), 'archive-manager');
  const graceFile = () => join(graceDir(), 'grace.json');
  let graceWrite = Promise.resolve();

  async function loadGrace() {
    try {
      const data = JSON.parse(await readFile(graceFile(), 'utf8'));
      const now = Date.now();
      for (const [id, until] of Object.entries(data && typeof data === 'object' ? data : {})) {
        if (typeof until === 'number' && until > now) unarchiveCooldown.set(String(id), until);
      }
    } catch {
      /* no grace file or malformed: start empty */
    }
  }
  const graceReady = loadGrace();

  function persistGrace() {
    const payload = JSON.stringify(Object.fromEntries(unarchiveCooldown));
    graceWrite = graceWrite.then(async () => {
      try {
        await mkdir(graceDir(), { recursive: true });
        const temporary = `${graceFile()}.${process.pid}.tmp`;
        await writeFile(temporary, payload, 'utf8');
        await rename(temporary, graceFile());
      } catch {
        /* grace is best effort; the in-memory map still guards this process */
      }
    });
    return graceWrite;
  }

  /** A subagent child session: not a sidebar conversation and never auto-archived. */
  function isChildSession(header) {
    return !!header && (header.parentSession !== undefined || header.origin === 'subagent' || header.origin === 'sub-agent');
  }

  /** Canonical cwd for the per-workspace quota (Windows is case-insensitive / slash-agnostic). */
  function normalizeCwd(cwd) {
    const raw = String(cwd || '').trim();
    if (!raw) return '';
    if (process.platform === 'win32') return raw.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    return raw.replace(/\/+$/, '');
  }

  /**
   * JSONL backend revision (`dev:ino:size:mtimeNs:ctimeNs[:corpus]`) → file
   * mtime. It is the last-activity signal that costs no session-log read;
   * backends whose revision is not file-based fall back to `createdAt`.
   */
  function revisionMtimeMs(revision) {
    try {
      const parts = String(revision || '').split(':');
      if (parts.length < 5) return undefined;
      const ns = BigInt(parts[3]);
      const ms = Number(ns / 1000000n);
      return Number.isSafeInteger(ms) && ms > 0 ? ms : undefined;
    } catch {
      return undefined;
    }
  }

  function lastActivityOf(header, snapshot) {
    return revisionMtimeMs(snapshot && snapshot.revision) ?? (header && header.createdAt) ?? 0;
  }

  function registryList(name) {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : ctx[name];
    } catch {
      return undefined;
    }
  }

  /** Whether the session is still attached (open) or has a live agent. */
  function isSessionLive(id) {
    const sessions = registryList('sessions');
    try {
      if (sessions && typeof sessions.get === 'function' && sessions.get(id) !== undefined) return true;
    } catch {}
    const agents = registryList('agents');
    try {
      if (agents && typeof agents.get === 'function' && agents.get(id) !== undefined) return true;
    } catch {}
    return false;
  }

  /** Fail closed: a broken pin projection must abort the sweep, not lose pins. */
  function pinnedSessionIds() {
    const ids = workspaceRegistry.pinnedSessionIds;
    if (ids === undefined || ids === null) return [];
    if (!Array.isArray(ids)) throw new Error('workspaceRegistry.pinnedSessionIds 不是数组');
    return ids;
  }

  /**
   * Grace after a restore, derived from the age threshold: a session restored
   * today may be old enough for the age rule again only after maxAgeDays days.
   * Persisted so a DSH restart cannot re-archive just-restored sessions.
   */
  function noteUnarchived(id, cfg) {
    const key = String(id);
    if (!cfg || cfg.maxAgeDays <= 0) {
      if (unarchiveCooldown.delete(key)) return persistGrace();
      return undefined;
    }
    const now = Date.now();
    pruneCooldown(now);
    while (unarchiveCooldown.size >= GRACE_LIMIT) {
      const oldest = unarchiveCooldown.keys().next().value;
      if (oldest === undefined) break;
      unarchiveCooldown.delete(oldest);
    }
    unarchiveCooldown.set(key, now + cfg.maxAgeDays * DAY_MS);
    return persistGrace();
  }

  /** Drop a grace entry (e.g. the session was deleted, not restored). */
  function forgetUnarchived(id) {
    if (unarchiveCooldown.delete(String(id))) return persistGrace();
    return undefined;
  }

  function pruneCooldown(now) {
    let removed = false;
    for (const [id, until] of unarchiveCooldown) {
      if (until <= now) {
        unarchiveCooldown.delete(id);
        removed = true;
      }
    }
    if (removed) void persistGrace();
  }

  /** Build one sweep's plan (pure read: sessions, pinned ids, cooldown map). */
  async function planAutoArchive(cfg, now) {
    await graceReady;
    pruneCooldown(now);
    const archived = new Set(workspaceRegistry.archivedSessionIds || []);
    const pinned = new Set(pinnedSessionIds());
    const snapshots = await sessionPersistence.list();
    const entries = [];
    for (const snap of snapshots || []) {
      const header = snapshotHeader(snap);
      if (!header || !header.id) continue;
      // Subagent child logs are not sidebar conversations: never auto-archive.
      if (isChildSession(header)) continue;
      entries.push({
        id: String(header.id),
        cwd: header.cwd || '',
        group: normalizeCwd(header.cwd),
        activity: lastActivityOf(header, snap),
      });
    }

    // Detect restores made outside this plugin (the built-in unarchive): an id
    // archived at the last baseline that is absent now gets grace.
    for (const id of lastArchivedIds) {
      if (!archived.has(id) && !unarchiveCooldown.has(id)) noteUnarchived(id, cfg);
    }
    await graceWrite;

    const ageLimitMs = cfg.maxAgeDays * DAY_MS;
    const minAgeMs = cfg.minAgeDays * DAY_MS;
    const quotaOn = cfg.maxPerWorkspace > 0;
    if (ageLimitMs <= 0 && !quotaOn) {
      return { entries, candidates: [], skippedPinned: 0, skippedLive: 0 };
    }

    let skippedPinned = 0;
    let skippedLive = 0;
    const candidates = [];
    const selected = new Set();
    const eligible = (entry) => {
      if (archived.has(entry.id) || selected.has(entry.id)) return false;
      if (pinned.has(entry.id)) return false;
      const cooldown = unarchiveCooldown.get(entry.id);
      if (cooldown !== undefined && cooldown > now) return false;
      if (isSessionLive(entry.id)) return false;
      return now - entry.activity >= minAgeMs;
    };
    const select = (entry, reason) => {
      if (selected.has(entry.id)) return;
      selected.add(entry.id);
      candidates.push({ id: entry.id, cwd: entry.cwd, activity: entry.activity, reason });
    };

    for (const entry of entries) {
      if (archived.has(entry.id)) continue;
      if (pinned.has(entry.id)) {
        skippedPinned += 1;
        continue;
      }
      if (isSessionLive(entry.id)) {
        skippedLive += 1;
        continue;
      }
      const cooldown = unarchiveCooldown.get(entry.id);
      if (cooldown !== undefined && cooldown > now) continue;
      if (now - entry.activity < minAgeMs) continue;
      if (ageLimitMs > 0 && now - entry.activity >= ageLimitMs) select(entry, 'age');
    }

    if (quotaOn) {
      // The quota counts every unarchived session (child logs were dropped
      // above); pinned/live/recent ones occupy slots but are never selected.
      const groups = new Map();
      for (const entry of entries) {
        if (archived.has(entry.id)) continue;
        const list = groups.get(entry.group) || [];
        list.push(entry);
        groups.set(entry.group, list);
      }
      const keep = Math.max(0, Math.floor(cfg.maxPerWorkspace));
      for (const list of groups.values()) {
        list.sort((a, b) => b.activity - a.activity);
        for (let i = keep; i < list.length; i++) {
          if (eligible(list[i])) select(list[i], 'quota');
        }
      }
    }

    return { entries, candidates, skippedPinned, skippedLive };
  }

  /** Single-flight wrapper: a timer/manual/HTTP sweep can never overlap another. */
  async function runAutoArchive(trigger, overrides, shouldStop) {
    if (autoArchiveInflight !== null) return autoArchiveInflight;
    const task = runAutoArchiveOnce(trigger, overrides, shouldStop);
    autoArchiveInflight = task;
    try {
      return await task;
    } finally {
      if (autoArchiveInflight === task) autoArchiveInflight = null;
    }
  }

  /** Run one policy sweep. Manual calls work even while the scheduler is off. */
  async function runAutoArchiveOnce(trigger, overrides, shouldStop) {
    const started = Date.now();
    const basePolicy = readAutoArchive();
    const overridePolicy = overrides && typeof overrides === 'object' ? overrides : {};
    const cfg = resolveAutoArchive({ ...basePolicy, ...overridePolicy }, basePolicy);
    const status = {
      at: new Date(started).toISOString(),
      trigger,
      enabled: cfg.enabled,
      policy: { ...cfg },
      scanned: 0,
      candidates: 0,
      planned: 0,
      truncated: false,
      cancelled: false,
      archived: 0,
      archivedIds: [],
      skippedPinned: 0,
      skippedLive: 0,
      skippedActive: 0,
      skippedUnknown: 0,
      errors: [],
      errorCount: 0,
      durationMs: 0,
    };
    if (typeof workspaceRegistry.archiveSession !== 'function') {
      status.error = '当前 workspaceRegistry 不提供 archiveSession()，无法自动归档';
      status.durationMs = Date.now() - started;
      autoArchiveLast = status;
      return status;
    }
    let plan;
    try {
      plan = await planAutoArchive(cfg, started);
    } catch (e) {
      status.error = e && e.message ? e.message : String(e);
      status.durationMs = Date.now() - started;
      autoArchiveLast = status;
      return status;
    }
    status.scanned = plan.entries.length;
    status.skippedPinned = plan.skippedPinned;
    status.skippedLive = plan.skippedLive;
    status.candidates = plan.candidates.length;
    const planned = plan.candidates.slice(0, AUTO_ARCHIVE_MAX_PER_RUN);
    status.planned = planned.length;
    status.truncated = plan.candidates.length > planned.length;
    for (const candidate of planned) {
      if (shouldStop && shouldStop()) {
        status.cancelled = true;
        break;
      }
      try {
        // Re-check after planning: the user may have opened, pinned, or
        // archived this session between the plan and this write.
        if ((workspaceRegistry.archivedSessionIds || []).includes(candidate.id)) continue;
        if (pinnedSessionIds().includes(candidate.id)) continue;
        if (isSessionLive(candidate.id)) continue;
        await workspaceRegistry.archiveSession(candidate.id);
        status.archived += 1;
        if (status.archivedIds.length < AUTO_ARCHIVE_PREVIEW_LIMIT) status.archivedIds.push(candidate.id);
      } catch (e) {
        const errorName = e && e.name ? String(e.name) : '';
        if (errorName === 'WorkspaceActiveSessionError') status.skippedActive += 1;
        else if (errorName === 'WorkspaceUnknownSessionError') status.skippedUnknown += 1;
        else {
          status.errorCount += 1;
          if (status.errors.length < AUTO_ARCHIVE_MAX_ERRORS) {
            status.errors.push((candidate.id + ': ' + (e && e.message ? e.message : String(e))).slice(0, 500));
          }
        }
      }
    }
    if (status.archived > 0) invalidateSearch();
    try {
      lastArchivedIds = new Set(workspaceRegistry.archivedSessionIds || []);
    } catch {
      /* keep the previous baseline rather than losing restore detection */
    }
    status.durationMs = Date.now() - started;
    autoArchiveLast = status;
    return status;
  }

  const service = {
    /**
     * List archived sessions that still exist in persistence.
     * Fast: reads stored headers only, serves titles from the in-memory cache and
     * reports ids whose title still has to be folded through titles().
     */
    async list() {
      if (listInflight === null) {
        listInflight = listArchived()
          .then(({ rows, titlesMissing }) => ({ rows, titlesMissing }))
          .finally(() => { listInflight = null; });
      }
      return listInflight;
    },

    /**
     * Fold titles for the given archived ids.
     * Expensive (one full-log read per uncached id) and cached per id; the client
     * calls it after the rows are painted, in small batches.
     */
    async titles(ids) {
      const archived = new Set(workspaceRegistry.archivedSessionIds || []);
      const wanted = (Array.isArray(ids) ? ids : [])
        .map((id) => String(id || ''))
        .filter((id) => id && archived.has(id))
        .slice(0, 100);
      return { titles: await readTitles(wanted) };
    },

    /** Current auto-archive policy and the last sweep's report. */
    autoArchiveStatus() {
      let archivedCount = 0;
      try {
        archivedCount = (workspaceRegistry.archivedSessionIds || []).length;
      } catch {}
      const policy = readAutoArchive();
      return {
        enabled: policy.enabled,
        policy: { ...policy },
        archivedCount,
        lastRun: autoArchiveLast,
      };
    },

    /** Run one auto-archive sweep now (manual or scheduled). */
    async autoArchiveRun(overrides) {
      return runAutoArchive('manual', overrides);
    },

    /**
     * Full-text search over archived sessions.
     * Tries FTS5 (sessionQuery.searchSessions) first, falls back to per-session filterEvents.
     * @param {string|{query:string,limit?:number}} opts
     */
    async search(opts) {
      const query = typeof opts === 'string' ? opts : (opts && opts.query) || '';
      const limit = opts && typeof opts === 'object' && Number.isFinite(opts.limit) ? opts.limit : 50;
      const perSession = opts && typeof opts === 'object' && Number.isFinite(opts.perSession) ? Math.max(1, Math.min(10, opts.perSession)) : 3;
      const types = opts && typeof opts === 'object' && Array.isArray(opts.types) ? opts.types.filter((t) => typeof t === 'string' && t) : [];
      const signal = opts && typeof opts === 'object' ? opts.signal : undefined;
      const throwIfAborted = () => { if (signal && signal.aborted) throw new Error('搜索已取消'); };
      const trimmed = String(query || '').trim();
      if (!trimmed) {
        const { rows } = await listArchived();
        return { rows, query: '' };
      }
      const archived = workspaceRegistry.archivedSessionIds || [];
      if (archived.length === 0) return { rows: [], query: trimmed };

      const cacheKey = [trimmed, types.join(','), String(limit), String(perSession), archived.join('\u0000')].join('\u0001');
      const cached = searchCache.get(cacheKey);
      if (cached !== undefined && Date.now() - cached.time < SEARCH_CACHE_TTL_MS) {
        searchCache.delete(cacheKey);
        searchCache.set(cacheKey, cached);
        return cached.result;
      }
      throwIfAborted();

      const keywordRegex = buildKeywordRegex(trimmed);
      // Display-only segments; the client derives the tooltip from them, so the
      // duplicate fullText/snippet/bestMatch fields stay out of the payload.
      const toHit = (text, time, type) => ({
        segments: buildSnippetSegments(text, keywordRegex),
        time: time || 0,
        type: type || '',
      });

      // 1) Prefer FTS5 cross-session search (sqlite backend)
      if (sessionQuery && typeof sessionQuery.searchSessions === 'function') {
        try {
          throwIfAborted();
          const res = await sessionQuery.searchSessions({
            query: trimmed,
            limit,
            sessionFilters: [{ kind: 'id', values: archived }],
          });
          const ids = res.items.map((it) => it.header.id);
          const titles = new Map();
          if (ids.length > 0) {
            try {
              const snaps = await sessionQuery.readTitleSnapshots(ids);
              for (const r of snaps) if (r.status === 'fulfilled') titles.set(r.sessionId, r.value?.title?.title || '');
            } catch {}
          }
          // Per-session event hits (up to `perSession` snippets each)
          const hitsBySession = new Map();
          if (typeof sessionQuery.searchEvents === 'function') {
            await Promise.all(res.items.map(async (item) => {
              try {
                const ev = await sessionQuery.searchEvents({
                  sessionId: item.header.id,
                  query: trimmed,
                  limit: perSession,
                  ...(types.length > 0 ? { filters: [{ kind: 'type', values: types }] } : {}),
                });
                hitsBySession.set(item.header.id, (ev.items || []).map((e) => ({
                  snippet: e.snippet || '',
                  text: e.snippet || '',
                  time: e.time || 0,
                  type: e.type || '',
                })).filter((h) => h.text));
              } catch {}
            }));
          }
          const rows = res.items.map((item) => {
            const h = item.header;
            const best = item.bestMatch || null;
            const hits = hitsBySession.get(h.id);
            const rawHits = hits && hits.length > 0 ? hits.slice(0, perSession) : (best && best.snippet ? [{ text: best.snippet, time: best.time || 0, type: best.type || '' }] : []);
            const snippets = rawHits.map((h2) => toHit(h2.text, h2.time, h2.type));
            return {
              id: h.id,
              title: titles.get(h.id) || '',
              cwd: h.cwd || '',
              workspace: basenameOf(h.cwd),
              createdAt: h.createdAt || 0,
              agentPreset: h.agentPreset || '',
              snippets,
              matchCount: snippets.length,
            };
          });
          // FTS5 unicode61 won't substring-match inside CJK token runs:
          // "聊" inside token "简单聊两句就可以" is one token → no match.
          // If FTS found nothing, supplement with scan (same query+type filter)
          // so Chinese substring searches always return results.
          if (rows.length === 0) {
            // fall through to scan block below
          } else {
            // Also merge any additional sessions that FTS missed (CJK inside token):
            // run a quick scan, keep sessions not already in FTS results.
            try {
              const ftsIds = new Set(rows.map((r) => r.id));
              const headers2 = headersOf(await sessionPersistence.list());
              const byId2 = new Map(headers2.map((h) => [h.id, h]));
              const present2 = archived.filter((id) => byId2.has(id) && !ftsIds.has(id));
              if (present2.length > 0) {
                const extra = [];
                let cur2 = 0;
                const scanHits2 = async () => {
                  while (cur2 < present2.length) {
                    const idx = cur2++;
                    const id = present2[idx];
                    try {
                      const filters = [{ kind: 'text', text: trimmed }];
                      if (types.length > 0) filters.push({ kind: 'type', values: types });
                      const docs = await sessionQuery.filterEvents(id, filters);
                      if (docs.length > 0) {
                        const hits = docs.slice(0, perSession).map((d) => toHit(d.text, d.time, d.type));
                        extra.push({ id, header: byId2.get(id), hits, total: docs.length });
                      }
                    } catch {}
                  }
                };
                const conc2 = Math.min(6, present2.length);
                await Promise.all(Array.from({ length: conc2 }, () => scanHits2()));
                if (extra.length > 0) {
                  const titles2b = new Map();
                  try {
                    const snaps = await sessionQuery.readTitleSnapshots(extra.map((m) => m.id));
                    for (const r of snaps) if (r.status === 'fulfilled') titles2b.set(r.sessionId, r.value?.title?.title || '');
                  } catch {}
                  const extraRows = extra.map((m) => ({
                    id: m.id,
                    title: titles2b.get(m.id) || '',
                    cwd: m.header.cwd || '',
                    workspace: basenameOf(m.header.cwd),
                    createdAt: m.header.createdAt || 0,
                    agentPreset: m.header.agentPreset || '',
                    snippets: m.hits,
                    matchCount: m.total,
                  }));
                  // Append scan-found sessions after FTS-ranked ones
                  const merged = [...rows, ...extraRows];
                  merged.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
                  const sliced = merged.slice(0, limit);
                  return rememberSearch(cacheKey, { rows: sliced, query: trimmed, nextCursor: res.nextCursor || null, mode: sliced.length > rows.length ? 'fts+scan' : 'fts', scanSupplement: extraRows.length });
                }
              }
            } catch {}
            return rememberSearch(cacheKey, { rows, query: trimmed, nextCursor: res.nextCursor || null, mode: 'fts' });
          }
        } catch (e) {
          const code = e && e.code ? String(e.code) : '';
          if (code === 'SESSION_QUERY_INVALID_QUERY' || code === 'SESSION_QUERY_INVALID_FILTER') throw e;
          if (code === 'SESSION_QUERY_SEARCH_DISABLED' || code === 'SESSION_QUERY_INDEX_FAILED') {
            // fall through to per-session scan
          } else if (code) {
            // unknown search error -> fallback but keep throw for cursor errors
            if (code.includes('CURSOR') || code.includes('LIMIT')) throw e;
          }
        }
      }

      // 2) Fallback: backend-independent per-session text scan
      throwIfAborted();
      const headers = headersOf(await sessionPersistence.list());
      const byId = new Map(headers.map((h) => [h.id, h]));
      const present = archived.filter((id) => byId.has(id));
      const matched = [];
      const concurrency = 6;
      let cursor = 0;
      async function worker() {
        while (cursor < present.length) {
          if (signal && signal.aborted) return;
          const idx = cursor++;
          const id = present[idx];
          try {
            const filters = [{ kind: 'text', text: trimmed }];
            if (types.length > 0) filters.push({ kind: 'type', values: types });
            const docs = await sessionQuery.filterEvents(id, filters);
            if (docs.length > 0) {
              const hits = docs.slice(0, perSession).map((d) => toHit(d.text, d.time, d.type));
              matched.push({ id, header: byId.get(id), hits, total: docs.length });
            }
          } catch {}
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, present.length) }, () => worker()));
      throwIfAborted();
      const titles2 = new Map();
      if (matched.length > 0) {
        try {
          const snaps = await sessionQuery.readTitleSnapshots(matched.map((m) => m.id));
          for (const r of snaps) if (r.status === 'fulfilled') titles2.set(r.sessionId, r.value?.title?.title || '');
        } catch {}
      }
      const rows = matched.map((m) => ({
        id: m.id,
        title: titles2.get(m.id) || '',
        cwd: m.header.cwd || '',
        workspace: basenameOf(m.header.cwd),
        createdAt: m.header.createdAt || 0,
        agentPreset: m.header.agentPreset || '',
        snippets: m.hits,
        matchCount: m.total,
      }));
      rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      const sliced = rows.slice(0, limit);
      return rememberSearch(cacheKey, { rows: sliced, query: trimmed, mode: 'scan' });
    },

    /**
     * Remove an id from the durable archive set (reverse of archiveSession).
     * `options.noGrace` skips the restore grace (used when deleting a session).
     */
    async unarchive(id, options) {
      if (!id) throw new Error('缺少会话 id');
      const reg = ctx.workspaceRegistry;
      const noGrace = !!(options && options.noGrace);
      // Public API since dsh-workspace 0.2.0-rc.2; older builds only expose the
      // registry-global state write, which stays as the fallback.
      if (typeof reg.unarchiveSession === 'function') {
        await reg.unarchiveSession(id);
        forgetTitle(id);
        invalidateSearch();
        if (noGrace) await forgetUnarchived(id);
        else await noteUnarchived(id, readAutoArchive());
        return { ok: true };
      }
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
      forgetTitle(id);
      invalidateSearch();
      if (noGrace) await forgetUnarchived(id);
      else await noteUnarchived(id, readAutoArchive());
      return { ok: true };
    },

    /** Truly delete the archived session's on-disk JSONL log directory. */
    async delete(id, configOverride) {
      if (!id) throw new Error('缺少会话 id');
      const deleteConfig = resolveConfig(configOverride, settings);

      const archived = workspaceRegistry.archivedSessionIds || [];
      if (!archived.includes(id)) {
        throw new Error('只能删除已归档的会话（活动会话请先用内置菜单归档）');
      }

      // Stop a live agent before touching its files: cancel the active turn
      // (cause 'disposed' — durable record marks it as disposed), wait for full
      // quiescence so no process still holds the JSONL directory open.
      let stoppedLiveAgent = false;
      try {
        // `agents` is optional (not in `inject`): read it through ctx.get().
        const agents = typeof ctx.get === 'function' ? ctx.get('agents') : ctx.agents;
        const agent = agents && typeof agents.get === 'function' ? agents.get(id) : undefined;
        if (agent) {
          agent.cancel({ kind: 'disposed' });
          if (typeof agent.whenIdle === 'function') await agent.whenIdle();
          stoppedLiveAgent = true;
        }
      } catch {
        // registry lookup/cancel is best-effort; fall through to delete
      }

      // Two durable leftovers outlive the log directory, and each one leaves a row
      // the user cannot get rid of:
      //  - the archive set keeps the id, so DSH keeps rendering it as an archived
      //    session ("已归档对话暂时无法查看") although its log is gone, and the
      //    built-in archive is one-way;
      //  - the workspace's ordered membership keeps the id until the registry's next
      //    mutation or a restart prunes it, which keeps the sidebar row.
      // Clear both, best effort: an id naming no stored session is harmless in the
      // archive set, and the entity's own write path also prunes stale ids.
      const cleanupAfterRemoval = async (cwd) => {
        forgetTitle(id);
        invalidateSearch();
        try {
          await service.unarchive(id, { noGrace: true });
        } catch {
          // best effort: a leftover id only leaves a ghost row
        }
        forgetUnarchived(id);
        // The workspace's ordered membership still names the session until the
        // registry's next mutation or a restart prunes it, which keeps a sidebar row.
        // Resolve the owning workspace from the session's own cwd and detach the id;
        // `sessionIds` is filtered on read (its path lookup can hide the very id we
        // want to drop), so it is only the fallback, never the gate.
        try {
          let target;
          if (typeof workspaceRegistry.resolveByPath === 'function' && cwd) {
            try {
              target = await workspaceRegistry.resolveByPath(cwd);
            } catch {
              // a cwd that no longer resolves falls through to the scan below
            }
          }
          if (target === undefined && typeof workspaceRegistry.list === 'function') {
            for (const ws of workspaceRegistry.list() || []) {
              const ids = ws && ws.sessionIds;
              if (Array.isArray(ids) && ids.includes(id)) {
                target = ws;
                break;
              }
            }
          }
          if (target && typeof target.detachSession === 'function') await target.detachSession(id);
        } catch {
          // best effort: the row clears on the next restart anyway
        }
      };

      // Prefer the id-addressed observation (session-persistence seam `stat`);
      // fall back to scanning `list()` snapshots on older backends.
      let header;
      if (typeof sessionPersistence.stat === 'function') {
        header = snapshotHeader(await sessionPersistence.stat(id));
      }
      if (header === undefined) {
        header = headersOf(await sessionPersistence.list()).find((h) => h.id === id);
      }
      if (header === undefined) {
        await cleanupAfterRemoval();
        return { ok: true, alreadyGone: true, stoppedLiveAgent };
      }

      // 'locate' is a JSONL-backend refusal hook, not part of the documented
      // persistence contract (create/open/stat/list + SessionHandle), so another
      // backend may not expose it. Fail with a clear message, never a TypeError.
      if (typeof sessionPersistence.locate !== 'function') {
        throw new Error('当前持久化后端不提供日志目录定位（删除需要 JSONL 后端的 locate 能力）: ' + id);
      }
      const loc = sessionPersistence.locate({ cwd: header.cwd, id });
      if (!loc || typeof loc.path !== 'string' || loc.path.length === 0) {
        throw new Error('持久化后端未返回可用的日志路径，无法删除: ' + id);
      }
      const dir = String(loc.path).replace(/[\\/][^\\/]*$/, '');

      const target = await fs.resolve(dir);
      const info = await fs.stat(target);
      if (info === undefined) {
        await cleanupAfterRemoval(header.cwd);
        return { ok: true, alreadyGone: true, stoppedLiveAgent };
      }

      // ShellExecRequest has NO args field: build the full command string and pass
      // the dir via process.argv[1], avoiding nested-quoting/escaping.
      const script = "require('fs').rmSync(process.argv[1],{recursive:true,force:true})";
      const commandLine = 'node -e "' + script + '" ' + JSON.stringify(dir);
      // 'sandboxPolicy' is not part of the public ShellExecRequest type, but the
      // bundled bash/pwsh sandbox executors honor
      // 'request.sandboxPolicy ?? ctx.sandboxPolicy.resolve()'. The session log
      // lives outside the workspace, so deletion needs the full-access override.
      if (typeof shell.resolve !== 'function') {
        throw new Error('shell 服务不支持 resolve()，无法执行删除  [' + dir + ']');
      }
      const spec = shell.resolve({
        command: commandLine,
        sandboxPolicy: { mode: deleteConfig.deleteSandbox, workspaceRoot: dir },
      });

      // dsh-shell 0.2.0-rc.x dropped `run()`: `execute(spec)` resolves a live
      // execution handle whose `result()` carries
      // `{ exitCode, signal, stdout: { text }, stderr: { text }, sandbox }`.
      // Older builds still expose the single-shot `run(spec)`; try both.
      let result;
      if (typeof shell.execute === 'function') {
        const execution = await shell.execute(spec);
        result = await execution.result();
      } else if (typeof shell.run === 'function') {
        result = await shell.run(spec);
      } else {
        throw new Error('shell 服务既不支持 execute() 也不支持 run()，无法执行删除  [' + dir + ']');
      }

      if (result && (result.exitCode !== 0 || result.signal)) {
        const raw = result.stderr;
        const errText = typeof raw === 'string'
          ? raw
          : raw && typeof raw.text === 'string' ? raw.text : raw ? JSON.stringify(raw) : '';
        const status = result.signal ? 'signal ' + result.signal : 'exit ' + result.exitCode;
        throw new Error('删除命令失败 (' + status + '): ' + errText + '  [' + dir + ']');
      }

      const after = await fs.stat(await fs.resolve(dir));
      if (after !== undefined) {
        throw new Error('目录删除后仍存在（可能被占用或沙箱限制）: ' + dir);
      }

      await cleanupAfterRemoval(header.cwd);
      return { ok: true, stoppedLiveAgent };
    },

    /** Batch delete: sequentially reuses delete() so each live-agent stop + shell removal is isolated. */
    async deleteMany(ids, configOverride) {
      if (!Array.isArray(ids) || ids.length === 0) throw new Error('ids 不能为空');
      const unique = [...new Set(ids.map((v) => String(v).trim()).filter(Boolean))];
      const results = [];
      for (const id of unique) {
        try {
          const r = await service.delete(id, configOverride);
          results.push({ id, ok: true, ...r });
        } catch (e) {
          results.push({ id, ok: false, error: e && e.message ? e.message : String(e) });
        }
      }
      const succeeded = results.filter((r) => r.ok).length;
      return { results, succeeded, failed: results.length - succeeded, total: results.length };
    },

    /** Preview: last N user/assistant messages (read-only, no tool noise). Ensures even count starts with user for coherent dialogue. */
    async preview(id, count = 4) {
      if (!id) throw new Error('缺少会话 id');
      const n = Number.isFinite(count) ? Math.max(1, Math.min(10, count)) : 4;
      // Prefer current surface (folded view), fall back to full read.
      let events = [];
      try {
        const surf = await sessionQuery.readSurface(id);
        events = surf.events || [];
      } catch {
        try {
          const loaded = await sessionQuery.readSession(id);
          events = loaded.events || [];
        } catch (e) {
          throw new Error('无法读取会话: ' + (e && e.message ? e.message : String(e)));
        }
      }
      const msgs = [];
      for (let i = events.length - 1; i >= 0 && msgs.length < n; i--) {
        const ev = events[i];
        if (!ev || !ev.type) continue;
        let role = '';
        let text = '';
        if (ev.type === 'user/message') {
          role = 'user';
          text = (ev.data?.content || []).map((b) => (b && b.text) || '').join(' ').trim();
        } else if (ev.type === 'assistant/message') {
          role = 'assistant';
          const c = ev.data?.message?.content || [];
          text = c.map((b) => (b && b.text) || '').join(' ').trim();
        } else {
          continue;
        }
        if (!text) continue;
        text = normalizeForDisplay(text);
        if (text.length > 200) text = text.slice(0, 200) + '…';
        msgs.push({ role, text, time: ev.time || 0, type: ev.type });
      }
      msgs.reverse();
      return { messages: msgs, total: msgs.length };
    },
  };
  ctx.provide('archiveManager', service);

  // Background warm-up: fold titles for the newest archived sessions shortly
  // after startup so the first open of 设置 > 归档会话 already has real titles.
  // Bounded to 40 ids and paced, so it cannot hog the event loop at boot.
  ctx.effect(() => {
    if (!settings.warmTitles) return () => {};
    const timer = setTimeout(() => {
      (async () => {
        try {
          const { titlesMissing } = await service.list();
          const missing = (titlesMissing || []).slice(0, 40);
          for (let i = 0; i < missing.length; i += 4) {
            await readTitles(missing.slice(i, i + 4));
            await new Promise((resolve) => setTimeout(resolve, 40));
          }
        } catch {
          /* warm-up is best effort */
        }
      })();
    }, settings.warmDelayMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return () => clearTimeout(timer);
  }, 'archiveManager.titleWarmup');

  // Scheduled auto-archive sweep. The policy fields are volatile (live-editable
  // from the Plugins page), so a slow poll re-reads them instead of relying on
  // a remount: enabling, disabling, or changing the interval takes effect on
  // the next tick. A sweep never overlaps itself because the tick awaits it.
  ctx.effect(() => {
    const POLL_MS = 15000;
    let disposed = false;
    let timer;
    let nextSweepAt = 0;
    let wasEnabled = false;
    const arm = (delayMs) => {
      timer = setTimeout(tick, Math.max(0, delayMs));
      if (timer && typeof timer.unref === 'function') timer.unref();
    };
    const tick = async () => {
      if (disposed) return;
      try {
        const cfg = readAutoArchive();
        const now = Date.now();
        if (!cfg.enabled) {
          wasEnabled = false;
          nextSweepAt = 0;
        } else {
          if (!wasEnabled || nextSweepAt === 0) {
            wasEnabled = true;
            nextSweepAt = now + Math.max(0, cfg.startDelayMs);
          }
          if (now >= nextSweepAt) {
            const latest = readAutoArchive();
            if (!latest.enabled) {
              wasEnabled = false;
              nextSweepAt = 0;
            } else {
              await runAutoArchive('timer', undefined, () => disposed);
              nextSweepAt = Date.now() + Math.max(5, readAutoArchive().intervalMinutes) * 60000;
            }
          }
        }
      } catch {
        /* one failed tick must not stop the chain */
      } finally {
        if (!disposed) arm(POLL_MS);
      }
    };
    arm(POLL_MS);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, 'archiveManager.autoArchive');

  // HTTP fallback for browser clients where service wiring is not yet proxied.
  // DSH's web server only routes: plugin routes own their trust policy (the /api
  // bridge and the SPA shell own their authentication). This fence therefore
  // stands on its own and mirrors client-connection's isTrustedApiRequest:
  //  - Host must parse as an authority literal for THIS listener or a loopback
  //    spelling of it (a DNS-rebinding page would otherwise pass with its own
  //    hostname), with the listener's port;
  //  - Sec-Fetch-Site: cross-site is refused outright;
  //  - an Origin, when present, must equal the accepted Host authority;
  //  - bodies stay capped at 8 KiB, enforced two ways.
  const webFiber = ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer;
    if (!webServer) return;
    const MAX_BODY_BYTES = 8 * 1024;
    const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
    const isLoopbackHostname = (name) => {
      const value = String(name || '').toLowerCase();
      if (LOOPBACK_HOSTNAMES.has(value)) return true;
      return /^127(?:\.\d{1,3}){3}$/.test(value);
    };
    const asAuthority = (value) => {
      try {
        const url = new URL('http://' + String(value || ''));
        return { hostname: url.hostname.toLowerCase(), port: url.port || '80' };
      } catch {
        return undefined;
      }
    };
    /** The listener's own authority, or undefined while it is not observable. */
    const listenerAuthority = () => {
      try {
        const origin = new URL(String(webServer.getOrigin ? webServer.getOrigin() : ''));
        return {
          hostname: origin.hostname.toLowerCase(),
          port: origin.port || (origin.protocol === 'https:' ? '443' : '80'),
        };
      } catch {
        return undefined;
      }
    };
    const trustCheck = (req) => {
      const host = String(req.headers?.host || '');
      if (!host) return false; // no Host -> possible DNS rebinding
      if (!/^[a-zA-Z0-9.\-:\[\]]+$/.test(host)) return false; // authority literals only
      const authority = asAuthority(host);
      if (authority === undefined) return false;
      const listener = listenerAuthority();
      if (listener !== undefined) {
        if (authority.port !== listener.port) return false;
        if (authority.hostname !== listener.hostname && !isLoopbackHostname(authority.hostname)) return false;
      } else if (!isLoopbackHostname(authority.hostname)) {
        return false; // listener authority unknown: trust loopback only
      }
      if (String(req.headers?.['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false;
      const origin = req.headers?.origin;
      if (origin === undefined || origin === null) return true;
      if (String(origin) === 'null') return false; // opaque origin (sandboxed iframe)
      try {
        const o = new URL(String(origin));
        if (o.protocol !== 'http:' && o.protocol !== 'https:') return false;
        return o.host.toLowerCase() === host.toLowerCase();
      } catch {
        return false;
      }
    };
    const readBody = async (req) => {
      const len = Number(req.headers?.['content-length'] || 0);
      if (len > MAX_BODY_BYTES) throw new Error('body too large');
      const chunks = [];
      let total = 0;
      for await (const c of req) {
        total += c.length;
        if (total > MAX_BODY_BYTES) throw new Error('body too large');
        chunks.push(Buffer.from(c));
      }
      return Buffer.concat(chunks).toString('utf8');
    };
    webCtx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/archive-manager/api',
      handler: async (req, res) => {
        const url = new URL(req.url || '/', 'http://localhost');
        const path = url.pathname.replace(/^\/archive-manager\/api/, '') || '/';
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(obj));
        };
        try {
          if (!trustCheck(req)) return send(403, { error: 'untrusted request' });
          if (req.method === 'GET' && (path === '/list' || path === '/')) {
            const r = await service.list();
            return send(200, r);
          }
          if (req.method === 'POST' && path === '/search') {
            const body = await readBody(req);
            const data = body ? JSON.parse(body) : {};
            // A disconnected caller cancels the scan: forward a signal the service
            // checks between archived sessions.
            const controller = new AbortController();
            const abort = () => controller.abort();
            res.on('close', abort);
            try {
              const r = await service.search({ ...data, signal: controller.signal });
              return send(200, r);
            } finally {
              res.off?.('close', abort);
            }
          }
          if (req.method === 'POST' && path === '/titles') {
            const body = await readBody(req);
            const data = body ? JSON.parse(body) : {};
            const r = await service.titles(Array.isArray(data.ids) ? data.ids : []);
            return send(200, r);
          }
          if (req.method === 'POST' && path === '/unarchive') {
            const body = await readBody(req);
            const data = body ? JSON.parse(body) : {};
            const r = await service.unarchive(data.id || data.sessionId);
            return send(200, r);
          }
          if (req.method === 'POST' && path === '/delete') {
            const body = await readBody(req);
            const data = body ? JSON.parse(body) : {};
            const r = await service.delete(data.id || data.sessionId, data.config);
            return send(200, r);
          }
          if (req.method === 'POST' && path === '/deleteMany') {
            const body = await readBody(req);
            const data = body ? JSON.parse(body) : {};
            const r = await service.deleteMany(data.ids || [], data.config);
            return send(200, r);
          }
          if (req.method === 'GET' && path.startsWith('/preview')) {
            const id = url.searchParams.get('id') || url.searchParams.get('sessionId') || '';
            const n = Number(url.searchParams.get('count') || 3);
            const r = await service.preview(id, n);
            return send(200, r);
          }
          if (req.method === 'GET' && path === '/autoArchive/status') {
            return send(200, service.autoArchiveStatus());
          }
          if (req.method === 'POST' && path === '/autoArchive/run') {
            await readBody(req).catch(() => '');
            // No policy overrides over HTTP: the profile settings decide, and a
            // sweep only runs while auto-archive is enabled.
            if (!service.autoArchiveStatus().enabled) {
              return send(409, { error: '自动归档未启用' });
            }
            const r = await service.autoArchiveRun();
            return send(200, r);
          }
          return send(404, { error: 'not found' });
        } catch (e) {
          return send(500, { error: e && e.message ? e.message : String(e) });
        }
      },
    }), 'archiveManager.webServer');
  });
  ctx.effect(() => () => webFiber.dispose(), 'archiveManager.webServer.cleanup');
}
