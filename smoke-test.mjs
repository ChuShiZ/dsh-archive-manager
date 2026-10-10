/**
 * Scratch smoke test for the 0.2.0-rc.2 compatibility fixes (not shipped).
 * Runs the real src/index.js against a fake Cordis ctx.
 */
import assert from 'node:assert/strict';
import { apply } from './src/index.js';

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
  assert.equal(res.rows[0].title, 'T:' + res.rows[0].id);
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
  const calls = { execute: 0, run: 0, removed: [] };
  let gone = false;
  const ctx = makeCtx({
    list: async () => [],
    stat: async (id) => (gone ? undefined : snap(id, 'D:\\work\\proj')),
    locate: (meta) => ({ kind: 'jsonl', path: 'C:\\sessions\\proj\\' + meta.id + '\\v4.jsonl.zstd' }),
    registry: { archivedSessionIds: ['s1'] },
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

console.log('\nALL SMOKE TESTS PASSED');
