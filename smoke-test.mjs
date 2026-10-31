/**
 * Scratch smoke test for the 0.2.0-rc.2 compatibility fixes (not shipped).
 * Runs the real src/index.js against a fake Cordis ctx.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, Config } from './src/index.js';
import { resolveConfig } from './src/config.js';
import { defaultCollapsedGroups, groupRows, isGroupCollapsed } from './src/client/grouping.js';

// Isolate the persistent restore-grace file from the real DSH home.
const TEST_HOME = mkdtempSync(join(tmpdir(), 'dsh-archive-manager-test-'));
process.env.DSH_HOME = TEST_HOME;

function makeCtx({ list, stat, locate, shell, fs, registry, titleSnapshots, agents, sessions } = {}) {
  const ctx = {
    sessionPersistence: {
      list,
      ...(stat ? { stat } : {}),
      ...(locate ? { locate } : {}),
    },
    workspaceRegistry: registry,
    sessionQuery: {
      readTitleSnapshots: titleSnapshots || (async (ids) =>
        ids.map((sessionId) => ({ status: 'fulfilled', sessionId, value: { session: { id: sessionId }, title: { title: 'T:' + sessionId } } }))),
      filterEvents: async () => [],
      readSurface: async (id) => ({ events: [{ type: 'user/message', time: 1, data: { content: [{ text: 'hello world' }] } }] }),
      readSession: async () => ({ events: [] }),
    },
    fs,
    shell,
    agents,
    sessions,
    get(name) { return this[name]; },
    provide(name, svc) { this[name] = svc; },
    inject() { return { dispose() {} }; },
    effect() {},
  };
  return ctx;
}

const snap = (id, cwd) => ({ header: { id, cwd, createdAt: 5, agentPreset: 'std' }, revision: 'r1', sizeBytes: 10 });

const DAY_MS = 24 * 60 * 60 * 1000;
/** Subagent child snapshot: same shape plus the header markers DSH writes. */
function childSnap(id, cwd, ageDays) {
  const snapshot = ageSnap(id, cwd, ageDays);
  snapshot.header.origin = 'subagent';
  snapshot.header.parentSession = 'parent-' + id;
  return snapshot;
}

/** Snapshot with a JSONL-style revision carrying the given last-activity age. */
function ageSnap(id, cwd, ageDays) {
  const activity = Date.now() - ageDays * DAY_MS;
  const mtimeNs = (BigInt(Math.trunc(activity)) * 1000000n).toString();
  return {
    header: { id, cwd, createdAt: activity, agentPreset: 'std' },
    revision: `1:1:100:${mtimeNs}:0`,
    sizeBytes: 10,
  };
}

/** Registry fake that records archiveSession calls and mutates its archive set. */
function autoRegistry(initial = []) {
  return {
    archivedSessionIds: [...initial],
    pinnedSessionIds: [],
    archiveCalls: [],
    archiveSession(id, options) {
      this.archiveCalls.push([id, options]);
      if (!this.archivedSessionIds.includes(id)) this.archivedSessionIds = [...this.archivedSessionIds, id];
      return Promise.resolve();
    },
    unarchiveSession(id) {
      this.archivedSessionIds = this.archivedSessionIds.filter((value) => value !== id);
      return Promise.resolve();
    },
  };
}

// ── 1. snapshot shape (DSH >= 0.1.5-rc.1): the issue #2 regression ──────────
{
  const ctx = makeCtx({
    list: async () => [snap('s1', 'D:\\work\\proj'), snap('s2', 'D:\\work\\other')],
    registry: { archivedSessionIds: ['s1', 's2', 'ghost'] },
    fs: { resolve: async (p) => ({ key: p }), stat: async () => undefined },
    shell: {},
  });
  apply(ctx);
  const res = await ctx.archiveManager.list();
  assert.equal(res.rows.length, 2, 'both archived sessions must be found (ghost dropped)');
  assert.deepEqual(res.rows.map((r) => r.id).sort(), ['s1', 's2']);
  assert.equal(res.rows[0].workspace.length > 0, true);
  assert.equal(res.rows[0].title, '', 'list() no longer folds titles: that is a full-log read');
  const folded = await ctx.archiveManager.titles(res.titlesMissing);
  assert.equal(folded.titles[res.rows[0].id], 'T:' + res.rows[0].id, 'titles() folds on demand');
  console.log('ok  1. list() unwraps { header, revision, sizeBytes } snapshots');
}

// ── 2. legacy bare-header shape still works ────────────────────────────────
{
  const ctx = makeCtx({
    list: async () => [snap('s1', 'D:\\work\\proj').header],
    registry: { archivedSessionIds: ['s1'] },
    fs: { resolve: async (p) => ({ key: p }), stat: async () => undefined },
    shell: {},
  });
  apply(ctx);
  const res = await ctx.archiveManager.list();
  assert.equal(res.rows.length, 1, 'legacy header-array shape must keep working');
  console.log('ok  2. list() still works on the legacy bare-header shape');
}

// ── 3. delete(): stat() lookup, dirname location, shell.execute + result() ──
{
  const calls = { execute: 0, run: 0, removed: [], unarchived: 0, detached: 0, resolvedPath: undefined };
  let gone = false;
  const ctx = makeCtx({
    list: async () => [],
    stat: async (id) => (gone ? undefined : snap(id, 'D:\\work\\proj')),
    locate: (meta) => ({ kind: 'jsonl', path: 'C:\\sessions\\proj\\' + meta.id + '\\v4.jsonl.zstd' }),
    registry: {
      archivedSessionIds: ['s1'],
      unarchiveSession() { calls.unarchived++; return Promise.resolve(); },
      resolveByPath(p) {
        calls.resolvedPath = p;
        return Promise.resolve({ detachSession() { calls.detached++; return Promise.resolve(); } });
      },
      list() { return []; },
    },
    fs: { resolve: async (p) => ({ key: p }), stat: async () => (gone ? undefined : { size: 1 }) },
    shell: {
      resolve: (req) => ({ ...req, resolved: true }),
      run() { calls.run++; return { exitCode: 0 }; },
      execute(spec) {
        calls.execute++;
        assert.equal(spec.resolved, true, 'spec must come from shell.resolve()');
        assert.equal(spec.sandboxPolicy.mode, 'danger-full-access');
        gone = true; // the command really deletes the directory
        return Promise.resolve({ result: async () => ({ exitCode: 0, signal: null, stdout: { text: '' }, stderr: { text: '' } }) });
      },
    },
  });
  apply(ctx);
  const res = await ctx.archiveManager.delete('s1');
  assert.equal(res.ok, true);
  assert.equal(calls.execute, 1, 'delete() must use 0.2.0-rc.x shell.execute()');
  assert.equal(calls.run, 0, 'the removed shell.run() must not be called');
  assert.equal(res.alreadyGone, undefined);
  assert.equal(calls.unarchived, 1, 'delete() must drop the id from the archive set');
  assert.equal(calls.detached, 1, 'delete() must detach the id from its workspace membership');
  assert.equal(calls.resolvedPath, 'D:\\work\\proj', 'the owning workspace is resolved from the session cwd');
  console.log('ok  3. delete() uses shell.execute() + result() and verifies removal');
}

// ── 4. delete() surfaces a failing shell run with stderr.text ───────────────
{
  const ctx = makeCtx({
    list: async () => [],
    stat: async (id) => snap(id, 'D:\\work\\proj'),
    locate: (meta) => ({ kind: 'jsonl', path: 'C:\\sessions\\proj\\' + meta.id + '\\v4.jsonl.zstd' }),
    registry: { archivedSessionIds: ['s1'] },
    fs: { resolve: async (p) => ({ key: p }), stat: async () => ({ size: 1 }) },
    shell: {
      resolve: (req) => req,
      execute: async () => ({ result: async () => ({ exitCode: 1, signal: null, stdout: { text: '' }, stderr: { text: 'sandbox denied' } }) }),
    },
  });
  apply(ctx);
  await assert.rejects(() => ctx.archiveManager.delete('s1'), /sandbox denied/);
  console.log('ok  4. delete() reports a failed command with stderr.text');
}

// ── 5. delete() refuses non-archived ids ────────────────────────────────────
{
  const ctx = makeCtx({
    list: async () => [],
    registry: { archivedSessionIds: [] },
    fs: { resolve: async (p) => ({ key: p }), stat: async () => undefined },
    shell: {},
  });
  apply(ctx);
  await assert.rejects(() => ctx.archiveManager.delete('live-1'), /已归档/);
  console.log('ok  5. delete() still refuses sessions that are not archived');
}

// ── 6. unarchive() prefers the public workspaceRegistry API ─────────────────
{
  let viaPublic = 0;
  let viaState = 0;
  const ctx = makeCtx({
    list: async () => [],
    registry: {
      archivedSessionIds: ['s1'],
      unarchiveSession(id) { viaPublic++; assert.equal(id, 's1'); return Promise.resolve(); },
      requireState() { viaState++; return { archivedSessionIds: ['s1'] }; },
      setState() { return Promise.resolve(); },
    },
    fs: { resolve: async (p) => ({ key: p }), stat: async () => undefined },
    shell: {},
  });
  apply(ctx);
  await ctx.archiveManager.unarchive('s1');
  assert.equal(viaPublic, 1, 'unarchiveSession() must be preferred');
  assert.equal(viaState, 0, 'the state write must not run when the public API exists');
  console.log('ok  6. unarchive() uses workspaceRegistry.unarchiveSession()');
}

// ── 7. unarchive() falls back to the state write on older registries ────────
{
  let written;
  const ctx = makeCtx({
    list: async () => [],
    registry: {
      archivedSessionIds: ['s1'],
      requireState: () => ({ archivedSessionIds: ['s1', 's2'], workspaceIds: [] }),
      setState(next) { written = next; return Promise.resolve(); },
      enqueueOperation(fn) { return fn(); },
    },
    fs: { resolve: async (p) => ({ key: p }), stat: async () => undefined },
    shell: {},
  });
  apply(ctx);
  await ctx.archiveManager.unarchive('s1');
  assert.deepEqual(written.archivedSessionIds, ['s2']);
  console.log('ok  7. unarchive() falls back to the registry state write');
}

// ── 8. delete() on an already-removed log still clears both references ──────
{
  let unarchived = 0;
  let detached = 0;
  const ctx = makeCtx({
    list: async () => [],
    stat: async () => undefined,
    registry: {
      archivedSessionIds: ['ghost'],
      unarchiveSession() { unarchived++; return Promise.resolve(); },
      list() { return [{ sessionIds: ['ghost'], detachSession() { detached++; return Promise.resolve(); } }]; },
    },
    fs: { resolve: async (p) => ({ key: p }), stat: async () => undefined },
    shell: {},
  });
  apply(ctx);
  const res = await ctx.archiveManager.delete('ghost');
  assert.equal(res.ok, true);
  assert.equal(res.alreadyGone, true);
  assert.equal(unarchived, 1, 'a ghost id must be dropped from the archive set');
  assert.equal(detached, 1, 'a ghost id must be detached from its workspace membership');
  console.log('ok  8. delete() clears both references when the log is already gone');
}

// ── 9. list() is title-free; titles() folds and caches on demand ────────────
{
  let titleReads = 0;
  const ctx = makeCtx({
    list: async () => [snap('s1', 'D:/work/proj'), snap('s2', 'D:/work/proj')],
    registry: { archivedSessionIds: ['s1', 's2'] },
    titleSnapshots: async (ids) => {
      titleReads++;
      return ids.map((sessionId) => ({ status: 'fulfilled', sessionId, value: { session: { id: sessionId }, title: { title: 'T:' + sessionId } } }));
    },
    fs: { resolve: async (p) => ({ key: p }), stat: async () => undefined },
    shell: {},
  });
  apply(ctx);
  const first = await ctx.archiveManager.list();
  assert.equal(first.rows.length, 2);
  assert.equal(titleReads, 0, 'list() must not fold titles: each fold is a full session-log read');
  assert.deepEqual(first.titlesMissing.slice().sort(), ['s1', 's2']);
  assert.equal(first.rows.every((row) => row.title === ''), true);

  const filled = await ctx.archiveManager.titles(['s1', 's2']);
  assert.equal(titleReads, 1, 'titles() folds the requested ids in one batch');
  assert.equal(filled.titles.s2, 'T:s2');

  const second = await ctx.archiveManager.list();
  assert.equal(second.rows.find((row) => row.id === 's1').title, 'T:s1', 'cached titles are served by the next list()');
  assert.deepEqual(second.titlesMissing, []);

  await ctx.archiveManager.titles(['s1']);
  assert.equal(titleReads, 1, 'cached ids must not be read again');
  console.log('ok  9. list() never blocks on title folding; titles() fills a per-id cache');
}

// ── 10. grouping helpers: newest project first, long archives start collapsed ──
{
  const small = [
    { id: 'a', workspace: 'alpha', createdAt: 10 },
    { id: 'b', workspace: 'beta', createdAt: 30 },
    { id: 'c', workspace: 'alpha', createdAt: 20 },
    { id: 'd', createdAt: 5 },
  ];
  const groups = groupRows(small, '(unknown)');
  assert.deepEqual(groups.map((group) => group.key), ['beta', 'alpha', '(unknown)']);
  assert.deepEqual(groups.map((group) => group.label), ['beta', 'alpha', '(unknown)']);
  assert.deepEqual(groups[1].items.map((row) => row.id), ['a', 'c']);
  assert.deepEqual(defaultCollapsedGroups(groups), {}, 'a short archive starts fully expanded');

  const collide = groupRows([
    { id: 'x', workspace: 'web', cwd: 'D:/a/web', createdAt: 2 },
    { id: 'y', workspace: 'web', cwd: 'D:/b/web', createdAt: 1 },
  ], '(unknown)');
  assert.equal(collide.length, 2, 'same basename in different directories stays separate');
  assert.deepEqual(collide.map((group) => group.label), ['web', 'web']);
  assert.deepEqual(collide.map((group) => group.key), ['D:/a/web', 'D:/b/web']);

  const big = [
    ...Array.from({ length: 11 }, (_, i) => ({ id: 'big' + i, workspace: 'big', createdAt: 100 + i })),
    ...Array.from({ length: 3 }, (_, i) => ({ id: 'mid' + i, workspace: 'mid', createdAt: 50 + i })),
    { id: 'small', workspace: 'small', createdAt: 1 },
  ];
  const bigGroups = groupRows(big, '(unknown)');
  const defaults = defaultCollapsedGroups(bigGroups);
  assert.equal(defaults.big, true, 'a project long enough to fill the panel starts collapsed');
  assert.equal(defaults.mid, true);
  assert.equal(defaults.small, true);
  assert.equal(isGroupCollapsed(null, defaults, 'big'), true);
  assert.equal(isGroupCollapsed({ big: false }, defaults, 'big'), false, 'a persisted expand wins');
  console.log('ok 10. grouping helpers order by recency and collapse long archives by default');
}

// ── 11. plugin HTTP routes refuse foreign hosts and cross-site requests ─────
{
  const routes = [];
  const ctx = makeCtx({
    list: async () => [],
    registry: { archivedSessionIds: [] },
    fs: { resolve: async (p) => ({ key: p }), stat: async () => undefined },
    shell: {},
  });
  ctx.inject = (names, callback) => {
    callback({
      webServer: {
        register(route) { routes.push(route); return () => {}; },
        getOrigin: () => 'http://127.0.0.1:5934',
        port: 5934,
        protocol: 'http:',
      },
      effect(fn) { fn(); },
    });
    return { dispose() {} };
  };
  apply(ctx);
  assert.equal(routes.length, 1, 'the plugin must register one prefix route');
  const call = async (headers) => {
    let status = 0;
    const req = { method: 'GET', url: '/archive-manager/api/list', headers };
    const res = { writeHead(code) { status = code; }, end() {} };
    await routes[0].handler(req, res);
    return status;
  };
  assert.equal(await call({ host: '127.0.0.1:5934' }), 200, 'the listener Host is accepted');
  assert.equal(await call({ host: 'localhost:5934', origin: 'http://localhost:5934' }), 200, 'a loopback Host is accepted');
  assert.equal(await call({ host: 'evil.example:5934', origin: 'http://evil.example:5934' }), 403, 'a foreign Host is refused (DNS rebinding)');
  assert.equal(await call({ host: '127.0.0.1:5934', 'sec-fetch-site': 'cross-site' }), 403, 'cross-site fetch metadata is refused');
  assert.equal(await call({ host: '127.0.0.1:5934', origin: 'http://evil.example:5934' }), 403, 'a cross-site Origin is refused');
  console.log('ok 11. HTTP routes trust only this listener / loopback and refuse cross-site requests');
}

// ── 12. delete() explains an unsupported persistence backend ───────────────
{
  const ctx = makeCtx({
    list: async () => [],
    stat: async (id) => snap(id, 'D:/work/proj'),
    registry: { archivedSessionIds: ['s1'] },
    fs: { resolve: async (p) => ({ key: p }), stat: async () => ({ size: 1 }) },
    shell: {},
  });
  apply(ctx);
  await assert.rejects(() => ctx.archiveManager.delete('s1'), /不提供日志目录定位/);
  console.log('ok 12. delete() names the missing backend capability instead of throwing a TypeError');
}

// ── 13. Config schema + apply(config) reaches the delete shell policy ──────
{
  const defaults = Config({});
  assert.equal(defaults.deleteSandbox, 'danger-full-access');
  assert.equal(defaults.warmTitles, true);
  assert.equal(defaults.warmDelayMs, 6000);
  assert.equal(Config({ deleteSandbox: 'workspace-write' }).deleteSandbox, 'workspace-write');
  const defaultAuto = defaults.autoArchive.get();
  assert.equal(defaultAuto.enabled, false, 'auto-archive is opt-in');
  assert.equal(defaultAuto.maxAgeDays, 5);
  assert.equal(defaultAuto.minAgeDays, 1);
  assert.equal(defaultAuto.intervalMinutes, 60);
  assert.equal('graceHours' in defaultAuto, false, 'the restore grace is derived from maxAgeDays');
  const custom = Config({ autoArchive: { enabled: true, maxPerWorkspace: 5 } }).autoArchive.get();
  assert.equal(custom.enabled, true);
  assert.equal(custom.maxPerWorkspace, 5);
  assert.equal(custom.maxAgeDays, 5, 'unspecified fields keep their default');
  assert.equal(resolveConfig(Config({ autoArchive: { maxAgeDays: 12 } })).autoArchive.maxAgeDays, 12, 'resolveConfig unwraps volatile fields');

  let gone = false;
  let sandboxMode;
  const ctx = makeCtx({
    list: async () => [],
    stat: async (id) => (gone ? undefined : snap(id, 'D:/work/proj')),
    locate: (meta) => ({ kind: 'jsonl', path: 'C:/sessions/proj/' + meta.id + '/v4.jsonl.zstd' }),
    registry: { archivedSessionIds: ['s1'] },
    fs: { resolve: async (p) => ({ key: p }), stat: async () => (gone ? undefined : { size: 1 }) },
    shell: {
      resolve: (req) => req,
      execute: async (spec) => {
        sandboxMode = spec.sandboxPolicy && spec.sandboxPolicy.mode;
        gone = true;
        return { result: async () => ({ exitCode: 0, signal: null, stdout: { text: '' }, stderr: { text: '' } }) };
      },
    },
  });
  apply(ctx, { deleteSandbox: 'workspace-write', warmTitles: false, warmDelayMs: 1000 });
  const res = await ctx.archiveManager.delete('s1');
  assert.equal(res.ok, true);
  assert.equal(sandboxMode, 'workspace-write', 'apply(config) must drive the delete sandbox');
  console.log('ok 13. Config schema fills defaults and apply(config) drives deleteSandbox');
}

// ── 14. search cache, trimmed payload, titles restricted to archived ids ───
{
  let scans = 0;
  const ctx = makeCtx({
    list: async () => [snap('s1', 'D:/work/proj')],
    registry: { archivedSessionIds: ['s1'] },
    fs: { resolve: async (p) => ({ key: p }), stat: async () => undefined },
    shell: {},
  });
  ctx.sessionQuery.filterEvents = async () => {
    scans++;
    return [{ text: '怎么安装插件', time: 1, type: 'user/message' }];
  };
  apply(ctx);
  const first = await ctx.archiveManager.search({ query: '怎么' });
  assert.equal(first.rows.length, 1);
  assert.equal(scans, 1);
  assert.equal(first.rows[0].snippets.length, 1);
  assert.equal('fullText' in first.rows[0].snippets[0], false, 'payload drops fullText');
  assert.equal('bestMatch' in first.rows[0], false, 'payload drops bestMatch');
  assert.equal('snippet' in first.rows[0], false, 'payload drops the duplicate snippet string');

  await ctx.archiveManager.search({ query: '怎么' });
  assert.equal(scans, 1, 'repeat search is served from the result cache');
  await ctx.archiveManager.search({ query: '安装' });
  assert.equal(scans, 2, 'a different query scans again');

  const titles = await ctx.archiveManager.titles(['s1', 'not-archived']);
  assert.equal('not-archived' in titles.titles, false, 'titles() only folds archived ids');
  console.log('ok 14. search is cached, the payload is trimmed, and titles() is archived-only');
}

// ── 15. auto-archive: age rule skips archived / pinned / live sessions ─────
{
  const registry = autoRegistry(['already15']);
  registry.pinnedSessionIds = ['pinned15'];
  const ctx = makeCtx({
    list: async () => [
      ageSnap('old15', 'D:/w/a', 40),
      ageSnap('new15', 'D:/w/a', 2),
      ageSnap('pinned15', 'D:/w/a', 40),
      ageSnap('already15', 'D:/w/a', 40),
      ageSnap('live15', 'D:/w/b', 40),
    ],
    registry,
    sessions: { get: (id) => (id === 'live15' ? {} : undefined) },
    fs: { resolve: async (p) => ({ key: p }), stat: async () => undefined },
    shell: {},
  });
  apply(ctx);
  const status = await ctx.archiveManager.autoArchiveRun({ maxAgeDays: 30, minAgeDays: 0 });
  assert.equal(status.scanned, 5);
  assert.equal(status.archived, 1, 'only the idle old session is archived');
  assert.deepEqual(status.archivedIds, ['old15']);
  assert.equal(status.skippedPinned, 1);
  assert.equal(status.skippedLive, 1);
  assert.equal(registry.archivedSessionIds.includes('old15'), true);
  console.log('ok 15. auto-archive applies the age rule and skips archived / pinned / live sessions');
}

// ── 16. auto-archive: per-workspace quota keeps the newest N ───────────────
{
  const registry = autoRegistry();
  const ctx = makeCtx({
    list: async () => [
      ageSnap('q0', 'D:/w/q', 10),
      ageSnap('q1', 'D:/w/q', 20),
      ageSnap('q2', 'D:/w/q', 30),
      ageSnap('q3', 'D:/w/q', 40),
      ageSnap('q4', 'D:/w/q', 50),
      ageSnap('other', 'D:/w/other', 60),
    ],
    registry,
    fs: { resolve: async (p) => ({ key: p }), stat: async () => undefined },
    shell: {},
  });
  apply(ctx);
  const status = await ctx.archiveManager.autoArchiveRun({ maxAgeDays: 0, maxPerWorkspace: 2, minAgeDays: 0 });
  assert.equal(status.archived, 3, 'the three oldest in the five-session project');
  assert.deepEqual(status.archivedIds.slice().sort(), ['q2', 'q3', 'q4']);
  assert.equal(registry.archivedSessionIds.includes('q0'), false, 'the newest session stays');
  assert.equal(registry.archivedSessionIds.includes('q1'), false);
  assert.equal(registry.archivedSessionIds.includes('other'), false, 'a project under the limit keeps its session');
  console.log('ok 16. auto-archive keeps the newest N sessions per project');
}

// ── 17. auto-archive: one sweep writes at most 50 archives ─────────────────
{
  const registry = autoRegistry();
  const ctx = makeCtx({
    list: async () => Array.from({ length: 60 }, (_, index) => ageSnap('cap' + index, 'D:/w', 40)),
    registry,
    fs: { resolve: async (p) => ({ key: p }), stat: async () => undefined },
    shell: {},
  });
  apply(ctx);
  const status = await ctx.archiveManager.autoArchiveRun({ maxAgeDays: 30, minAgeDays: 0 });
  assert.equal(status.planned, 50);
  assert.equal(status.truncated, true, 'the remaining candidates wait for the next sweep');
  assert.equal(status.archived, 50);
  assert.equal(registry.archiveCalls.length, 50);
  console.log('ok 17. auto-archive caps one sweep at 50 archives and reports truncation');
}

// ── 18. auto-archive: live sessions stay skipped, active refusals reported ──
{
  const registry = autoRegistry();
  registry.archiveSession = function archiveSession(id) {
    this.archiveCalls.push([id]);
    if (id === 'busy18') {
      const error = new Error('active turn');
      error.name = 'WorkspaceActiveSessionError';
      throw error;
    }
    return Promise.resolve();
  };
  const ctx = makeCtx({
    list: async () => [ageSnap('liveA18', 'D:/w', 40), ageSnap('busy18', 'D:/w', 40)],
    registry,
    sessions: { get: (id) => (id === 'liveA18' ? {} : undefined) },
    fs: { resolve: async (p) => ({ key: p }), stat: async () => undefined },
    shell: {},
  });
  apply(ctx);
  const status = await ctx.archiveManager.autoArchiveRun({ maxAgeDays: 30, minAgeDays: 0 });
  assert.equal(status.archived, 0);
  assert.equal(status.skippedLive, 1, 'an open session is always skipped');
  assert.equal(status.skippedActive, 1, 'a raced active session is reported, not thrown');
  assert.deepEqual(registry.archiveCalls.map((call) => call[0]), ['busy18']);
  console.log('ok 18. live sessions are always skipped and active refusals are reported');
}

// ── 19. auto-archive: a restarted (unarchived) session gets a grace period ──
{
  const registry = autoRegistry(['old19']);
  const ctx = makeCtx({
    list: async () => [ageSnap('old19', 'D:/w', 40)],
    registry,
    fs: { resolve: async (p) => ({ key: p }), stat: async () => undefined },
    shell: {},
  });
  apply(ctx);
  await ctx.archiveManager.unarchive('old19');
  const status = await ctx.archiveManager.autoArchiveRun({ maxAgeDays: 30, minAgeDays: 0 });
  assert.equal(status.archived, 0, 'the restore grace window keeps the session out of the sweep');
  assert.equal(registry.archiveCalls.length, 0);
  console.log('ok 19. auto-archive honors the restore grace period');
}

// ── 20. auto-archive: status is exposed and no-rule sweeps are no-ops ───────
{
  const registry = autoRegistry();
  const ctx = makeCtx({
    list: async () => [ageSnap('old20', 'D:/w', 40)],
    registry,
    fs: { resolve: async (p) => ({ key: p }), stat: async () => undefined },
    shell: {},
  });
  apply(ctx);
  const before = ctx.archiveManager.autoArchiveStatus();
  assert.equal(before.enabled, false, 'the scheduler is off by default');
  assert.equal(before.lastRun, null);
  const status = await ctx.archiveManager.autoArchiveRun({ maxAgeDays: 0, maxPerWorkspace: 0 });
  assert.equal(status.candidates, 0);
  assert.equal(status.archived, 0);
  const after = ctx.archiveManager.autoArchiveStatus();
  assert.equal(after.lastRun.at, status.at, 'the last sweep report is retained');
  console.log('ok 20. auto-archive status is exposed and no-rule sweeps are no-ops');
}

// ── 21. auto-archive: the scheduler effect exists only while enabled ───────
{
  const makeEffects = (ctx) => {
    const effects = [];
    ctx.effect = (fn, name) => effects.push({ fn, name });
    return effects;
  };
  const withTimerSpy = (fn) => {
    const realSetTimeout = globalThis.setTimeout;
    let timers = 0;
    globalThis.setTimeout = (...args) => {
      timers += 1;
      return realSetTimeout(...args);
    };
    try {
      const result = fn();
      return { result, timers };
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  };

  const disabledCtx = makeCtx({ list: async () => [], registry: autoRegistry(), fs: { resolve: async (p) => ({ key: p }), stat: async () => undefined }, shell: {} });
  const disabledEffects = makeEffects(disabledCtx);
  apply(disabledCtx, { autoArchive: { enabled: false } });
  const disabledScheduler = disabledEffects.find((entry) => entry.name === 'archiveManager.autoArchive');
  assert.ok(disabledScheduler, 'the scheduler effect is always installed');
  const disabledRun = withTimerSpy(() => disabledScheduler.fn());
  assert.equal(disabledRun.timers, 1, 'the config poll is armed even while disabled (live-enable support)');
  disabledRun.result();

  const enabledCtx = makeCtx({ list: async () => [], registry: autoRegistry(), fs: { resolve: async (p) => ({ key: p }), stat: async () => undefined }, shell: {} });
  const enabledEffects = makeEffects(enabledCtx);
  apply(enabledCtx, { autoArchive: { enabled: true, startDelayMs: 60000 } });
  const scheduler = enabledEffects.find((entry) => entry.name === 'archiveManager.autoArchive');
  assert.ok(scheduler, 'enabled: the scheduler effect is installed');
  const enabledRun = withTimerSpy(() => scheduler.fn());
  assert.equal(enabledRun.timers, 1, 'enabled: the poll timer is armed');
  enabledRun.result();
  console.log('ok 21. auto-archive arms its live-config poll timer');
}

// ── 22. volatile Config references drive apply-time policy reads ────────────
{
  const registry = autoRegistry();
  const ctx = makeCtx({
    list: async () => [ageSnap('old22', 'D:/w', 50)],
    registry,
    fs: { resolve: async (p) => ({ key: p }), stat: async () => undefined },
    shell: {},
  });
  apply(ctx, Config({ autoArchive: { enabled: true, maxAgeDays: 40, minAgeDays: 0 } }));
  const status = await ctx.archiveManager.autoArchiveRun();
  const live = ctx.archiveManager.autoArchiveStatus();
  assert.equal(live.enabled, true, 'the status reads the volatile reference');
  assert.equal(status.policy.maxAgeDays, 40, 'the sweep reads the volatile reference');
  assert.equal(status.archived, 1, 'the session idle for 50 days is archived at a 40-day threshold');
  assert.deepEqual(status.archivedIds, ['old22']);
  console.log('ok 22. volatile Config references drive live policy reads');
}

// ── 23. auto-archive: subagent child sessions are never archived or listed ──
{
  const registry = autoRegistry();
  const ctx = makeCtx({
    list: async () => [ageSnap('real23', 'D:/w', 40), childSnap('child23', 'D:/w', 40)],
    registry,
    fs: { resolve: async (p) => ({ key: p }), stat: async () => undefined },
    shell: {},
  });
  apply(ctx);
  const status = await ctx.archiveManager.autoArchiveRun({ maxAgeDays: 30, minAgeDays: 0 });
  assert.equal(status.archived, 1);
  assert.deepEqual(status.archivedIds, ['real23'], 'the child session stays out of the sweep');

  registry.archivedSessionIds = ['child23', 'real23'];
  const list = await ctx.archiveManager.list();
  assert.equal(list.rows.some((row) => row.id === 'child23'), false, 'archived child ids are hidden from the plugin page');
  assert.equal(list.rows.some((row) => row.id === 'real23'), true);
  console.log('ok 23. auto-archive and list() ignore subagent child sessions');
}

// ── 24. auto-archive quota: normalized cwd, children excluded ──────────────
{
  const registry = autoRegistry();
  const ctx = makeCtx({
    list: async () => [
      ageSnap('q0', 'D:/w/q', 10),
      ageSnap('q1', 'D:/w/q/', 20),
      ageSnap('q2', 'D:/w/q', 30),
      ageSnap('q3', 'D:/w/q/', 40),
      ageSnap('q4', 'D:/w/q', 50),
      childSnap('child24', 'D:/w/q', 60),
    ],
    registry,
    fs: { resolve: async (p) => ({ key: p }), stat: async () => undefined },
    shell: {},
  });
  apply(ctx);
  const status = await ctx.archiveManager.autoArchiveRun({ maxAgeDays: 0, maxPerWorkspace: 2, minAgeDays: 0 });
  assert.equal(status.archived, 3, 'trailing-slash variants count as one workspace; the child is not counted');
  assert.deepEqual(status.archivedIds.slice().sort(), ['q2', 'q3', 'q4']);
  assert.equal(registry.archivedSessionIds.includes('child24'), false);
  console.log('ok 24. quota normalizes cwd separators and excludes child sessions');
}

// ── 25. auto-archive: non-integer overrides are quantized, not fatal ────────
{
  const registry = autoRegistry();
  const ctx = makeCtx({
    list: async () => [
      ageSnap('r0', 'D:/w', 10),
      ageSnap('r1', 'D:/w', 20),
      ageSnap('r2', 'D:/w', 30),
      ageSnap('r3', 'D:/w', 40),
      ageSnap('r4', 'D:/w', 50),
    ],
    registry,
    fs: { resolve: async (p) => ({ key: p }), stat: async () => undefined },
    shell: {},
  });
  apply(ctx);
  const status = await ctx.archiveManager.autoArchiveRun({ maxAgeDays: 0, maxPerWorkspace: 2.5, minAgeDays: 0 });
  assert.equal(status.error, undefined);
  assert.equal(status.policy.maxPerWorkspace, 3, '2.5 is quantized to 3');
  assert.equal(status.archived, 2, 'keeps the newest 3, archives the oldest 2');
  console.log('ok 25. non-integer quota overrides are quantized instead of crashing the sweep');
}

// ── 26. auto-archive: restore grace survives a process restart ──────────────
{
  const registry = autoRegistry(['old26']);
  const make = () => makeCtx({
    list: async () => [ageSnap('old26', 'D:/w', 40)],
    registry,
    fs: { resolve: async (p) => ({ key: p }), stat: async () => undefined },
    shell: {},
  });
  const first = make();
  apply(first);
  await first.archiveManager.unarchive('old26');
  const second = make();
  apply(second);
  const status = await second.archiveManager.autoArchiveRun({ maxAgeDays: 30, minAgeDays: 0 });
  assert.equal(status.archived, 0, 'the persisted grace still protects the restored session after a restart');
  assert.equal(registry.archiveCalls.length, 0);
  console.log('ok 26. restore grace is persisted and survives a restart');
}

// ── 27. HTTP /autoArchive/run refuses when disabled and ignores overrides ──
{
  const harness = (config) => {
    const routes = [];
    const registry = autoRegistry();
    const ctx = makeCtx({
      list: async () => [ageSnap('old27', 'D:/w', 40)],
      registry,
      fs: { resolve: async (p) => ({ key: p }), stat: async () => undefined },
      shell: {},
    });
    ctx.inject = (names, callback) => {
      callback({
        webServer: {
          register(route) { routes.push(route); return () => {}; },
          getOrigin: () => 'http://127.0.0.1:5934',
          port: 5934,
          protocol: 'http:',
        },
        effect(fn) { fn(); },
      });
      return { dispose() {} };
    };
    apply(ctx, config);
    const post = async (body) => {
      let status = 0;
      let payload = '';
      const req = {
        method: 'POST',
        url: '/archive-manager/api/autoArchive/run',
        headers: { host: '127.0.0.1:5934', 'content-type': 'application/json' },
        async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); },
      };
      const res = { writeHead(code) { status = code; }, end(text) { payload = text; } };
      await routes[0].handler(req, res);
      return { status, body: payload ? JSON.parse(payload) : {} };
    };
    return { registry, post };
  };

  const disabled = harness();
  const blocked = await disabled.post({ maxAgeDays: 0, maxPerWorkspace: 1 });
  assert.equal(blocked.status, 409, 'real sweeps are refused while auto-archive is disabled');

  const enabled = harness(Config({ autoArchive: { enabled: true, maxAgeDays: 30, minAgeDays: 0 } }));
  const real = await enabled.post({ maxAgeDays: 0, maxPerWorkspace: 1, stopLive: true });
  assert.equal(real.status, 200);
  assert.equal(real.body.archived, 1, 'the profile policy decides, not the body');
  assert.equal(real.body.policy.maxAgeDays, 30, 'overrides in the request body are ignored');
  assert.equal(enabled.registry.archiveCalls.length, 1);
  console.log('ok 27. HTTP run endpoint refuses while disabled and ignores policy overrides');
}

// ── 28. auto-archive: a broken pin projection aborts instead of losing pins ─
{
  const registry = autoRegistry();
  Object.defineProperty(registry, 'pinnedSessionIds', { get() { throw new Error('pin store unavailable'); } });
  const ctx = makeCtx({
    list: async () => [ageSnap('old28', 'D:/w', 40)],
    registry,
    fs: { resolve: async (p) => ({ key: p }), stat: async () => undefined },
    shell: {},
  });
  apply(ctx);
  const status = await ctx.archiveManager.autoArchiveRun({ maxAgeDays: 30, minAgeDays: 0 });
  assert.match(String(status.error), /pin store unavailable/);
  assert.equal(status.archived, 0);
  assert.equal(registry.archiveCalls.length, 0);
  console.log('ok 28. a broken pin projection fails the sweep closed');
}

// ── 29. quota counts pinned sessions but never archives them ───────────────
{
  const registry = autoRegistry();
  registry.pinnedSessionIds = ['p0'];
  const ctx = makeCtx({
    list: async () => [
      ageSnap('p0', 'D:/w', 10),
      ageSnap('n1', 'D:/w', 20),
      ageSnap('n2', 'D:/w', 30),
    ],
    registry,
    fs: { resolve: async (p) => ({ key: p }), stat: async () => undefined },
    shell: {},
  });
  apply(ctx);
  const status = await ctx.archiveManager.autoArchiveRun({ maxAgeDays: 0, maxPerWorkspace: 2, minAgeDays: 0 });
  assert.equal(status.archived, 1, 'the pinned session occupies a quota slot');
  assert.deepEqual(status.archivedIds, ['n2']);
  assert.equal(registry.archivedSessionIds.includes('p0'), false, 'the pinned session is never archived');
  console.log('ok 29. quota counts pinned sessions without archiving them');
}

// ── 30. auto-archive sweeps are single-flight ───────────────────────────────
{
  const registry = autoRegistry();
  const ctx = makeCtx({
    list: async () => [ageSnap('old29', 'D:/w', 40)],
    registry,
    fs: { resolve: async (p) => ({ key: p }), stat: async () => undefined },
    shell: {},
  });
  apply(ctx);
  const first = ctx.archiveManager.autoArchiveRun({ maxAgeDays: 30, minAgeDays: 0 });
  const second = ctx.archiveManager.autoArchiveRun({ maxAgeDays: 30, minAgeDays: 0 });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b, 'concurrent calls share one sweep and one status object');
  assert.equal(registry.archiveCalls.filter((call) => call[0] === 'old29').length, 1, 'the candidate is archived once');
  console.log('ok 30. auto-archive sweeps are single-flight');
}

rmSync(TEST_HOME, { recursive: true, force: true });
console.log('\nALL SMOKE TESTS PASSED');
