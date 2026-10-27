/**
 * Scratch smoke test for the 0.2.0-rc.2 compatibility fixes (not shipped).
 * Runs the real src/index.js against a fake Cordis ctx.
 */
import assert from 'node:assert/strict';
import { apply, Config } from './src/index.js';
import { defaultCollapsedGroups, groupRows, isGroupCollapsed } from './src/client/grouping.js';

function makeCtx({ list, stat, locate, shell, fs, registry, titleSnapshots } = {}) {
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
    provide(name, svc) { this[name] = svc; },
    inject() { return { dispose() {} }; },
    effect() {},
  };
  return ctx;
}

const snap = (id, cwd) => ({ header: { id, cwd, createdAt: 5, agentPreset: 'std' }, revision: 'r1', sizeBytes: 10 });

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

console.log('\nALL SMOKE TESTS PASSED');
