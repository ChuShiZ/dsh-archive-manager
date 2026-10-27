/**
 * Client half of dsh-archive-manager.
 *
 * Registers a Settings page (settings.section) labelled 归档会话 that renders
 * the ArchivedList UI: search, restore-and-open, and hard delete.
 *
 * RPC note: unlike the dynamic-plugin preview (which used the dynamic
 * `host.call('arcdl.*', …)` bridge), this package consumes the host's
 * `archiveManager` service directly through the runtime's service wiring.
 * Add `archiveManager` to the client's available services; if your DSH runtime
 * hides it from the client, expose it via a `@Remote` method on the service so
 * `ctx.archiveManager.*` is callable in the browser.
 */
import { defaultCollapsedGroups, groupRows, isGroupCollapsed } from './grouping.js';

export const inject = ['slots', 'sessions', 'timer', 'locale'];

const React = typeof require !== 'undefined' ? require('react') : globalThis.React;

const I18N = {
  zh: {
    settingsLabel: '归档会话',
    searchPlaceholder: '搜索名称 / 目录 / id / 预设 / 会话正文…',
    chips: { all: '全部', user: '用户消息', assistant: 'AI 回复', tool: '工具调用' },
    countAll: (n) => `共 ${n} 个归档会话`,
    countMatch: (n, mode) => `匹配 ${n} 个${mode ? `（${mode}）` : ''}`,
    modeLabels: { fts: 'FTS 全文', scan: '逐会话扫描', 'fts+scan': 'FTS + 扫描补充' },
    batchSelected: (n) => `已选 ${n} 个`,
    deleteSelected: '删除所选',
    confirmDelete: '确认删除',
    confirmDeleteSelected: '确认删除所选',
    cancel: '取消',
    restoreOpen: '恢复并打开',
    delete: '删除',
    deleting: '删除中…',
    loading: '加载中…',
    searching: '搜索中…',
    emptyNoArchived: '没有已归档的会话。',
    emptyNoMatch: '无匹配的归档会话。',
    moreHits: (n) => `… 还有 ${n} 处命中`,
    previewLoading: '加载预览中…',
    previewEmpty: '无可预览消息',
    previewTitle: '点击切换对话预览',
    hideHits: '收起命中',
    titleLoading: '标题加载中…（先显示目录名）',
    expandAll: '展开全部',
    collapseAll: '折叠全部',
    expandGroup: '展开该分组',
    collapseGroup: '折叠该分组',
    refreshingSuffix: '  ·  更新中…',
    unknownWorkspace: '(未知工作区)',
    roleUser: '用户：',
    roleAssistant: 'AI：',
    errorLoad: (msg) => `加载失败: ${msg}`,
    errorSearch: (msg) => `搜索失败: ${msg}`,
    errorRestore: (msg) => `恢复失败: ${msg}`,
    errorDelete: (msg) => `删除失败: ${msg}`,
    errorBatch: (s, f, detail) => `批量删除完成：成功 ${s} 失败 ${f}${detail ? '；' + detail : ''}`,
    errorBatchFailed: (msg) => `批量删除失败: ${msg}`,
    searchingSuffix: '  ·  搜索中…',
  },
  en: {
    settingsLabel: 'Archived Sessions',
    searchPlaceholder: 'Search name / cwd / id / preset / content…',
    chips: { all: 'All', user: 'User', assistant: 'Assistant', tool: 'Tools' },
    countAll: (n) => `${n} archived sessions`,
    countMatch: (n, mode) => `Matched ${n}${mode ? ` (${mode})` : ''}`,
    modeLabels: { fts: 'FTS', scan: 'scan', 'fts+scan': 'FTS + scan' },
    batchSelected: (n) => `${n} selected`,
    deleteSelected: 'Delete selected',
    confirmDelete: 'Confirm delete',
    confirmDeleteSelected: 'Confirm delete selected',
    cancel: 'Cancel',
    restoreOpen: 'Restore & open',
    delete: 'Delete',
    deleting: 'Deleting…',
    loading: 'Loading…',
    searching: 'Searching…',
    emptyNoArchived: 'No archived sessions.',
    emptyNoMatch: 'No matching archived sessions.',
    moreHits: (n) => `… ${n} more hit(s)`,
    previewLoading: 'Loading preview…',
    previewEmpty: 'No previewable messages',
    previewTitle: 'Click to toggle preview',
    hideHits: 'Hide hits',
    titleLoading: 'Loading title… (showing folder name)',
    expandAll: 'Expand all',
    collapseAll: 'Collapse all',
    expandGroup: 'Expand group',
    collapseGroup: 'Collapse group',
    refreshingSuffix: '  ·  updating…',
    unknownWorkspace: '(unknown workspace)',
    roleUser: 'User:',
    roleAssistant: 'Assistant:',
    errorLoad: (msg) => `Load failed: ${msg}`,
    errorSearch: (msg) => `Search failed: ${msg}`,
    errorRestore: (msg) => `Restore failed: ${msg}`,
    errorDelete: (msg) => `Delete failed: ${msg}`,
    errorBatch: (s, f, detail) => `Batch delete: ${s} succeeded, ${f} failed${detail ? '; ' + detail : ''}`,
    errorBatchFailed: (msg) => `Batch delete failed: ${msg}`,
    searchingSuffix: '  ·  searching…',
  },
};

function getLocaleId(ctx) {
  // Current client locale service (dsh-client-locale): a snapshot store read
  // through getSnapshot(). All official client plugins use this shape.
  try {
    const snap = ctx.locale?.getSnapshot?.();
    if (snap && typeof snap.active === 'string' && snap.active) {
      return snap.active.toLowerCase().startsWith('en') ? 'en' : 'zh';
    }
  } catch {}
  // Legacy shape kept for older client runtimes.
  try {
    const snap = ctx.locale?.getLocale?.();
    if (snap && typeof snap.active === 'string' && snap.active) {
      return snap.active.toLowerCase().startsWith('en') ? 'en' : 'zh';
    }
  } catch {}
  try {
    const lang = (typeof navigator !== 'undefined' && (navigator.language || (navigator.languages && navigator.languages[0]))) || '';
    if (String(lang).toLowerCase().startsWith('en')) return 'en';
  } catch {}
  return 'zh';
}

// The module-loader wrapper below is the shape the web build produces. Source
// targets/tsdown uses, so keep `apply` as the frame that registers the slot UI.
export function apply(ctx) {
  const slots = ctx.slots ?? ctx.get('slots');
  const sessions = ctx.sessions ?? ctx.get('sessions');
  const timer = ctx.timer ?? ctx.get('timer');
  if (slots === undefined) return;
  // HTTP fallback via webServer route (for runtimes that don't proxy archiveManager).
  // Also used for titles() when the proxied service lacks that newer method.
  const httpCall = (path, body, signal) => {
    const init = body
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {};
    if (signal) init.signal = signal;
    return fetch(path, init)
    .then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      return j;
    });
  };
  const httpTitles = (ids) => httpCall('/archive-manager/api/titles', { ids: ids || [] });
  const getManager = () => {
    try {
      const m = ctx.archiveManager ?? ctx.get('archiveManager');
      if (m && typeof m.list === 'function') return m;
    } catch {}
    return {
      list: () => httpCall('/archive-manager/api/list'),
      titles: httpTitles,
      search: (opts) => {
        const src = opts && typeof opts === 'object' ? opts : {};
        const signal = src.signal;
        const body = { ...src };
        delete body.signal;
        return httpCall('/archive-manager/api/search', body, signal);
      },
      unarchive: (id) => httpCall('/archive-manager/api/unarchive', { id }),
      delete: (id, cfg) => httpCall('/archive-manager/api/delete', { id, config: cfg }),
      deleteMany: (ids, cfg) => httpCall('/archive-manager/api/deleteMany', { ids, config: cfg }),
      preview: (id, n) => httpCall('/archive-manager/api/preview?id=' + encodeURIComponent(id) + '&count=' + (n || 4)),
    };
  };

  const CSS = [
    '.ds-ardl-search{width:100%;box-sizing:border-box;margin-bottom:10px;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;outline:none;}',
    '.ds-ardl-search:focus{border-color:var(--dsw-alias-brand-primary);}',
    '.ds-ardl-count-row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 8px;}',
    '.ds-ardl-count{font-size:12px;color:var(--dsw-alias-label-secondary);}',
    '.ds-ardl-linkbtn{border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;cursor:pointer;padding:2px 6px;border-radius:4px;}',
    '.ds-ardl-linkbtn:hover{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent);}',
    '.ds-ardl-list{max-height:62vh;overflow:auto;margin:0;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l2) transparent;}',
    '.ds-ardl-list::-webkit-scrollbar{width:10px;}',
    '.ds-ardl-list::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:5px;border:2px solid transparent;background-clip:content-box;}',
    '.ds-ardl-list::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-label-secondary);background-clip:content-box;}',
    '.ds-ardl-list::-webkit-scrollbar-track{background:transparent;}',
    '.ds-ardl-group{margin-bottom:0;}',
    '.ds-ardl-group-header{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;margin:0;padding:8px;font:inherit;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border:0;border-bottom:1px solid var(--dsw-alias-border-l1);cursor:pointer;text-align:left;box-shadow:0 8px 12px -12px rgba(0,0,0,.5);}',
    '.ds-ardl-group-header:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);}',
    '.ds-ardl-group-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;}',
    '.ds-ardl-group-caret{flex:none;width:12px;font-size:10px;line-height:1;color:var(--dsw-alias-label-secondary);}',
    '.ds-ardl-group-name{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.ds-ardl-group-count{flex:none;font-size:11px;font-weight:600;background:color-mix(in srgb, var(--dsw-alias-brand-primary) 9%, transparent);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 7px;}',
    '.ds-ardl-title-pending{font-size:11px;font-weight:400;color:var(--dsw-alias-label-secondary);opacity:.65;margin-left:6px;}',
    '.ds-ardl-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
    '.ds-ardl-row:hover{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 4%, transparent);}',
    '.ds-ardl-meta{min-width:0;flex:1;}',
    '.ds-ardl-title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary);}',
    '.ds-ardl-sub{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px;}',
    '.ds-ardl-snippet{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:4px;background:color-mix(in srgb, var(--dsw-alias-brand-primary) 7%, transparent);padding:3px 6px;border-radius:4px;}',
    '.ds-ardl-snippet.expandable{cursor:pointer;}',
    '.ds-ardl-snippet.expanded{white-space:normal;cursor:pointer;word-break:break-all;}',
    '.ds-ardl-mark{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, transparent);color:var(--dsw-alias-label-primary);font-weight:600;border-radius:2px;padding:0 1px;}',
    '.ds-ardl-chips{display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap;}',
    '.ds-ardl-chip{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:3px 10px;font-size:12px;cursor:pointer;}',
    '.ds-ardl-chip:hover{background:var(--dsw-alias-bg-layer-1);}',
    '.ds-ardl-chip.active{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent);}',
    '.ds-ardl-batch-bar{display:flex;align-items:center;gap:10px;margin-bottom:8px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);}',
    '.ds-ardl-batch-info{font-size:12px;color:var(--dsw-alias-label-secondary);flex:1;}',
    '.ds-ardl-preview{margin-top:8px;padding:6px 0;border-top:1px dashed var(--dsw-alias-border-l2);}',
    '.ds-ardl-preview-msg{font-size:12px;padding:4px 6px;margin-top:4px;border-radius:6px;background:color-mix(in srgb, var(--dsw-alias-bg-layer-1) 80%, transparent);}',
    '.ds-ardl-preview-msg.user{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 6%, transparent);}',
    '.ds-ardl-preview-role{font-weight:600;margin-right:4px;color:var(--dsw-alias-label-primary);}',
    '.ds-ardl-preview-text{color:var(--dsw-alias-label-secondary);word-break:break-word;white-space:pre-wrap;}',
    '.ds-ardl-preview-loading,.ds-ardl-preview-empty{font-size:12px;color:var(--dsw-alias-label-secondary);padding:4px 6px;}',
    '.ds-ardl-snippets{margin-top:2px;}',
    '.ds-ardl-snippet-more{font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.7;margin-top:3px;}',
    '.ds-ardl-hit-toggle{border:0;background:transparent;color:var(--dsw-alias-brand-primary);font-size:11px;padding:3px 2px;margin-top:3px;cursor:pointer;text-align:left;}',
    '.ds-ardl-hit-toggle:hover{text-decoration:underline;}',
    '.ds-ardl-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;flex:0 1 auto;min-width:0;white-space:nowrap;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 12px;cursor:pointer;font-size:13px;}',
    '.ds-ardl-btn:hover{background:var(--dsw-alias-bg-layer-1);}',
    '.ds-ardl-btn:disabled{opacity:.5;cursor:default;}',
    '.ds-ardl-btn.restore{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);background:transparent;}',
    '.ds-ardl-btn.restore:hover{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent);}',
    '.ds-ardl-btn.danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);background:transparent;}',
    '.ds-ardl-btn.danger:hover{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent);}',
    '.ds-ardl-btn.primary{background:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);color:#fff;}',
    '.ds-ardl-btn.primary:hover{filter:brightness(.94);}',
    '.ds-ardl-actions{display:flex;gap:6px;}',
    '.ds-ardl-empty{color:var(--dsw-alias-label-secondary);padding:14px 4px;}',
    '.ds-ardl-err{color:var(--dsw-alias-state-error-primary);font-size:12px;margin:8px 2px;}',
  ].join('');

  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {};
    if (document.getElementById('ds-ardl-style')) return () => {};
    const el = document.createElement('style');
    el.id = 'ds-ardl-style';
    el.textContent = CSS;
    document.head.appendChild(el);
    return () => el.remove();
  });

  function basenameOf(p) {
    const s = (p || '').replace(/[\\/]$/, '');
    const parts = s.split(/[\\/]/);
    return parts[parts.length - 1] || '';
  }
  function fmtTime(v) {
    if (!v) return '';
    const t = typeof v === 'number' ? v : Date.parse(v);
    if (Number.isNaN(t)) return String(v);
    const d = new Date(t);
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  const shortId = (id) => String(id).slice(0, 10);
  const titleOf = (r) => r.title || basenameOf(r.cwd) || shortId(r.id);
  const subOf = (r) => [basenameOf(r.cwd), fmtTime(r.createdAt), r.agentPreset, shortId(r.id)].filter(Boolean).join('   ·   ');

  // ── Local cache ───────────────────────────────────────────────────────
  // Every settings open used to start from a blank "加载中". Painting the last
  // snapshot from localStorage (then revalidating behind it) makes the list feel
  // instant; titles live in a second cache because folding one is expensive.
  const CACHE_ROWS = 'ds-ardl.rows.v1';
  const CACHE_TITLES = 'ds-ardl.titles.v1';
  const CACHE_COLLAPSED = 'ds-ardl.collapsed.v2';
  const EMPTY_COLLAPSE_DEFAULTS = {};
  function storageGet(key, fallback) {
    try {
      if (typeof localStorage === 'undefined') return fallback;
      const raw = localStorage.getItem(key);
      return raw === null || raw === undefined ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  }
  function storageSet(key, value) {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }
  function cachedTitles() {
    const map = storageGet(CACHE_TITLES, {});
    return map && typeof map === 'object' ? map : {};
  }
  function cachedRows() {
    const snapshot = storageGet(CACHE_ROWS, null);
    if (!snapshot || !Array.isArray(snapshot.rows)) return [];
    const titles = cachedTitles();
    return snapshot.rows.map((row) => ({ ...row, title: row.title || titles[row.id] || '' }));
  }

  function ArchivedList(props) {
    const close = props && props.close;
    const [localeId, setLocaleId] = React.useState(() => getLocaleId(ctx));
    React.useEffect(() => {
      const update = () => setLocaleId(getLocaleId(ctx));
      let off1, off2;
      try { off1 = ctx.locale?.subscribe?.(update); } catch {}
      try { off2 = ctx.on?.('locale/change', update); } catch {}
      return () => { try { off1?.(); } catch{} try { off2?.(); } catch{} };
    }, []);
    const t = I18N[localeId] || I18N.zh;
    const [rows, setRows] = React.useState(cachedRows);
    const [query, setQuery] = React.useState('');
    const [loading, setLoading] = React.useState(() => cachedRows().length === 0);
    const [refreshing, setRefreshing] = React.useState(false);
    const [titlesPending, setTitlesPending] = React.useState(0);
    const [searching, setSearching] = React.useState(false);
    const [searchMode, setSearchMode] = React.useState('');
    const [confirmId, setConfirmId] = React.useState(undefined);
    const [busyId, setBusyId] = React.useState(undefined);
    const [error, setError] = React.useState('');
    const [typeFilter, setTypeFilter] = React.useState('all');
    const [expandedHits, setExpandedHits] = React.useState({});
    const [selectedIds, setSelectedIds] = React.useState(new Set());
    const [batchConfirm, setBatchConfirm] = React.useState(false);
    const [batchBusy, setBatchBusy] = React.useState(false);
    const [previewCache, setPreviewCache] = React.useState({});
    const [expandedPreview, setExpandedPreview] = React.useState({});
    const [collapsedGroups, setCollapsedGroups] = React.useState(() => {
      const saved = storageGet(CACHE_COLLAPSED, null);
      return saved && typeof saved === 'object' ? saved : null;
    });
    // Search results keep their own in-memory collapse state: a fresh search opens
    // every project (so matches are visible), but each header can be folded too.
    const [searchCollapsedGroups, setSearchCollapsedGroups] = React.useState({});
    const rowsRef = React.useRef(rows);
    rowsRef.current = rows;
    const requestSeq = React.useRef(0);
    const searchAbort = React.useRef(null);
    const composingRef = React.useRef(false);
    const [compositionTick, setCompositionTick] = React.useState(0);
    const [expandedHitRows, setExpandedHitRows] = React.useState(new Set());

    const TYPE_CHIPS = [
      { key: 'all', label: t.chips.all, types: [] },
      { key: 'user', label: t.chips.user, types: ['user/message'] },
      { key: 'assistant', label: t.chips.assistant, types: ['assistant/message'] },
      { key: 'tool', label: t.chips.tool, types: ['tool/call', 'tool/result'] },
    ];

    // Titles are folded on the host by reading whole session logs. Fetch them in
    // small batches after the rows are painted so the list fills in progressively
    // instead of blocking on the slowest session.
    const hydrateTitles = React.useCallback(async (ids, seq) => {
      const queue = Array.isArray(ids) ? ids.slice() : [];
      while (queue.length > 0) {
        if (seq !== requestSeq.current) return;
        const chunk = queue.splice(0, 4);
        try {
          const m = getManager();
          const r = m && typeof m.titles === 'function' ? await m.titles(chunk) : await httpTitles(chunk);
          const got = (r && r.titles) || {};
          const entries = Object.entries(got).filter(([, value]) => typeof value === 'string');
          if (entries.length > 0) {
            const cache = cachedTitles();
            for (const [id, title] of entries) cache[id] = title;
            storageSet(CACHE_TITLES, cache);
            if (seq === requestSeq.current) {
              setRows((prev) => prev.map((row) => (Object.prototype.hasOwnProperty.call(got, row.id) ? { ...row, title: got[row.id] } : row)));
            }
          }
        } catch {
          /* keep the fallback title; the next open retries */
        }
        if (seq === requestSeq.current) setTitlesPending(queue.length);
      }
      if (seq === requestSeq.current) setTitlesPending(0);
    }, []);

    const refresh = React.useCallback(async (opts) => {
      const seq = ++requestSeq.current;
      const silent = !!(opts && opts.silent) || rowsRef.current.length > 0;
      if (!silent) setLoading(true);
      setRefreshing(true);
      setError('');
      try {
        const m = getManager();
        if (!m) throw new Error('archiveManager not ready');
        const r = await m.list();
        if (seq !== requestSeq.current) return;
        const titles = cachedTitles();
        const nextRows = (r && r.rows ? r.rows : []).map((row) => ({ ...row, title: row.title || titles[row.id] || '' }));
        setRows(nextRows);
        setSelectedIds((prev) => {
          if (prev.size === 0) return prev;
          const present = new Set(nextRows.map((row) => row.id));
          const next = new Set([...prev].filter((id) => present.has(id)));
          return next.size === prev.size ? prev : next;
        });
        storageSet(CACHE_ROWS, { savedAt: Date.now(), rows: nextRows });
        setSearchMode('');
        const missing = r && Array.isArray(r.titlesMissing)
          ? r.titlesMissing
          : nextRows.filter((row) => !row.title).map((row) => row.id);
        setTitlesPending(missing.length);
        if (missing.length > 0) hydrateTitles(missing, seq);
      } catch (e) {
        if (seq === requestSeq.current) setError(t.errorLoad(e && e.message ? e.message : String(e)));
      } finally {
        if (seq === requestSeq.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    }, [t, hydrateTitles]);

    // debounced full-text search: query -> manager.search()
    const searchTimer = React.useRef(null);
    const doSearch = React.useCallback(async (q, types) => {
      const trimmed = String(q || '').trim();
      if (!trimmed) {
        await refresh({ silent: true });
        return;
      }
      if (searchAbort.current) {
        try { searchAbort.current.abort(); } catch {}
      }
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      searchAbort.current = controller;
      const seq = ++requestSeq.current;
      setSearching(true);
      setError('');
      setTitlesPending(0);
      try {
        const m = getManager();
        if (!m) throw new Error('archiveManager not ready');
        if (typeof m.search === 'function') {
          const r = await m.search({
            query: trimmed,
            limit: 50,
            ...(types && types.length > 0 ? { types } : {}),
            ...(controller ? { signal: controller.signal } : {}),
          });
          if (seq !== requestSeq.current) return;
          const titles = cachedTitles();
          setRows((r && r.rows ? r.rows : []).map((row) => ({ ...row, title: row.title || titles[row.id] || '' })));
          setSelectedIds(new Set());
          setExpandedHitRows(new Set());
          setSearchMode(r && r.mode ? r.mode : '');
        } else {
          const r = await m.list();
          if (seq !== requestSeq.current) return;
          const low = trimmed.toLowerCase();
          const filtered = (r.rows || []).filter((row) => (row.title && row.title.toLowerCase().indexOf(low) !== -1) || String(row.id).toLowerCase().indexOf(low) !== -1);
          setRows(filtered);
          setSelectedIds(new Set());
          setExpandedHitRows(new Set());
        }
      } catch (e) {
        if (controller && controller.signal.aborted) return; // superseded by a newer query
        if (seq === requestSeq.current) setError(t.errorSearch(e && e.message ? e.message : String(e)));
      } finally {
        if (searchAbort.current === controller) searchAbort.current = null;
        if (seq === requestSeq.current) setSearching(false);
      }
    }, [refresh, t]);

    const switchTypeFilter = (key) => {
      setTypeFilter(key);
      // The query effect below re-runs the search when typeFilter changes.
    };

    // Exactly one list() on mount: the query effect below used to fire a second
    // one, doubling the (previously seconds-long) first load.
    const firstQueryEffect = React.useRef(true);
    React.useEffect(() => {
      refresh();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Closing the panel cancels background title hydration and any search.
    React.useEffect(() => () => {
      requestSeq.current += 1;
      if (searchAbort.current) {
        try { searchAbort.current.abort(); } catch {}
        searchAbort.current = null;
      }
    }, []);

    React.useEffect(() => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
      const trimmed = String(query || '').trim();
      if (!trimmed) {
        if (searchAbort.current) {
          try { searchAbort.current.abort(); } catch {}
          searchAbort.current = null;
        }
        if (firstQueryEffect.current) {
          firstQueryEffect.current = false;
          return;
        }
        // Cleared: restore the full list (instant from the local cache) and drop
        // the search-only collapse state so the next search opens every project.
        setSearchCollapsedGroups({});
        refresh({ silent: true });
        return;
      }
      // Never search intermediate IME composition text.
      if (composingRef.current) return;
      if (searchAbort.current) {
        try { searchAbort.current.abort(); } catch {}
        searchAbort.current = null;
      }
      const chip = TYPE_CHIPS.find((c) => c.key === typeFilter);
      searchTimer.current = setTimeout(() => { doSearch(query, chip ? chip.types : []); }, 280);
      return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
    }, [query, typeFilter, doSearch, refresh, compositionTick]);

    const doRestore = async (id) => {
      setBusyId(id);
      setError('');
      try {
        const m = getManager();
        if (!m) throw new Error('archiveManager not ready');
        await m.unarchive(id);
        setConfirmId(undefined);
        if (close) close();
        timer.timeout(() => {
          try { if (sessions) sessions.open(id); } catch (_e) {}
        }, 300);
      } catch (e) {
        setError(t.errorRestore(e && e.message ? e.message : String(e)));
      } finally {
        setBusyId(undefined);
      }
    };

    const doDelete = async (id) => {
      setBusyId(id);
      setError('');
      try {
        const m = getManager();
        if (!m) throw new Error('archiveManager not ready');
        await m.delete(id);
        setConfirmId(undefined);
        setSelectedIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
        const chip = TYPE_CHIPS.find((c) => c.key === typeFilter);
        const trimmed = String(query || '').trim();
        if (trimmed) await doSearch(trimmed, chip ? chip.types : []);
        else await refresh();
      } catch (e) {
        setError(t.errorDelete(e && e.message ? e.message : String(e)));
      } finally {
        setBusyId(undefined);
      }
    };

    const doBatchDelete = async () => {
      if (selectedIds.size === 0) return;
      setBatchBusy(true);
      setError('');
      try {
        const m = getManager();
        if (!m) throw new Error('archiveManager not ready');
        const ids = [...selectedIds];
        const r = m.deleteMany ? await m.deleteMany(ids) : await (async () => {
          const res = [];
          for (const id of ids) { try { await m.delete(id); res.push({ id, ok: true }); } catch (e) { res.push({ id, ok: false, error: e && e.message ? e.message : String(e) }); } }
          return { results: res, succeeded: res.filter((x) => x.ok).length, failed: res.filter((x) => !x.ok).length };
        })();
        setBatchConfirm(false);
        setSelectedIds(new Set());
        if (r.failed > 0) {
          const fails = r.results.filter((x) => !x.ok).map((x) => x.id.slice(0, 8) + ':' + x.error).join('; ');
          setError(t.errorBatch(r.succeeded, r.failed, fails));
        }
        const chip = TYPE_CHIPS.find((c) => c.key === typeFilter);
        const trimmed = String(query || '').trim();
        if (trimmed) await doSearch(trimmed, chip ? chip.types : []);
        else await refresh();
      } catch (e) {
        setError(t.errorBatchFailed(e && e.message ? e.message : String(e)));
      } finally {
        setBatchBusy(false);
      }
    };

    const togglePreview = async (id) => {
      const expanded = !!expandedPreview[id];
      if (expanded) { setExpandedPreview((prev) => { const n = { ...prev }; delete n[id]; return n; }); return; }
      setExpandedPreview((prev) => ({ ...prev, [id]: true }));
      if (previewCache[id]) return;
      try {
        const m = getManager();
        if (!m || !m.preview) throw new Error('preview not ready');
        const r = await m.preview(id, 4);
        setPreviewCache((prev) => ({ ...prev, [id]: r.messages || [] }));
      } catch (e) {
        setPreviewCache((prev) => ({ ...prev, [id]: [{ role: 'error', text: e && e.message ? e.message : String(e) }] }));
      }
    };

    const isBusy = loading || searching;

    // group rows by workspace; groups follow their most recent session
    const groups = React.useMemo(() => groupRows(rows, t.unknownWorkspace), [rows, t.unknownWorkspace]);
    const collapsedDefaults = React.useMemo(() => defaultCollapsedGroups(groups), [groups]);
    const searchingNow = String(query || '').trim().length > 0;
    const effectiveCollapsed = (key) => (searchingNow
      ? isGroupCollapsed(searchCollapsedGroups, EMPTY_COLLAPSE_DEFAULTS, key)
      : isGroupCollapsed(collapsedGroups, collapsedDefaults, key));
    const setGroupCollapsed = (key, next) => {
      if (searchingNow) {
        setSearchCollapsedGroups((prev) => ({ ...prev, [key]: !!next }));
        return;
      }
      setCollapsedGroups((prev) => {
        const base = prev || collapsedDefaults;
        const nextMap = { ...base, [key]: !!next };
        storageSet(CACHE_COLLAPSED, nextMap);
        return nextMap;
      });
    };
    const allCollapsed = groups.length > 0 && groups.every((group) => effectiveCollapsed(group.key));
    const setAllCollapsed = (next) => {
      const nextMap = {};
      for (const group of groups) nextMap[group.key] = !!next;
      if (searchingNow) {
        setSearchCollapsedGroups(nextMap);
        return;
      }
      storageSet(CACHE_COLLAPSED, nextMap);
      setCollapsedGroups(nextMap);
    };

    const renderRow = (s) => {
      const confirming = confirmId === s.id;
      const snippetList = (s.snippets && s.snippets.length > 0 ? s.snippets : (s.snippet ? [{ segments: [{ text: s.snippet, hit: false }] }] : []));
      const allHitsOpen = expandedHitRows.has(s.id);
      const visibleHits = allHitsOpen ? snippetList : snippetList.slice(0, 1);
      const totalHits = typeof s.matchCount === 'number' ? Math.max(s.matchCount, snippetList.length) : snippetList.length;
      const hiddenHits = Math.max(0, totalHits - visibleHits.length);
      const previewOpen = !!expandedPreview[s.id];
      const previewMsgs = previewCache[s.id];
      const isSelected = selectedIds.has(s.id);
      const renderHit = (h, i) => {
        const key = s.id + ':' + i;
        const expanded = !!expandedHits[key];
        const segments = h.segments && h.segments.length > 0 ? h.segments : [{ text: h.snippet || '', hit: false }];
        return React.createElement('div', {
          key: i,
          className: 'ds-ardl-snippet' + (expanded ? ' expanded' : ' expandable'),
          title: expanded ? '' : (h.fullText || segments.map((seg) => seg.text).join('')),
          onClick: () => setExpandedHits((prev) => ({ ...prev, [key]: !prev[key] })),
        },
          segments.map((seg, j) => seg.hit
            ? React.createElement('mark', { key: j, className: 'ds-ardl-mark' }, seg.text)
            : React.createElement('span', { key: j }, seg.text))
        );
      };
      return React.createElement('div', { key: s.id, className: 'ds-ardl-row' },
        React.createElement('input', {
          type: 'checkbox',
          checked: isSelected,
          onChange: (e) => {
            const next = new Set(selectedIds);
            if (e.target.checked) next.add(s.id); else next.delete(s.id);
            setSelectedIds(next);
          },
          style: { marginRight: '8px' },
        }),
        React.createElement('div', { className: 'ds-ardl-meta' },
          React.createElement('div', {
            className: 'ds-ardl-title',
            style: { cursor: 'pointer' },
            onClick: (e) => { e.stopPropagation(); togglePreview(s.id); },
            title: s.title ? (s.title + ' — ' + t.previewTitle) : t.previewTitle,
          },
            titleOf(s),
            !s.title && titlesPending > 0
              ? React.createElement('span', { className: 'ds-ardl-title-pending', title: t.titleLoading }, '···')
              : null,
            previewOpen ? '  ▲' : '  ▾'
          ),
          React.createElement('div', { className: 'ds-ardl-sub' }, subOf(s)),
          snippetList.length > 0
            ? React.createElement('div', { className: 'ds-ardl-snippets' },
                visibleHits.map(renderHit),
                allHitsOpen && snippetList.length > 1
                  ? React.createElement('button', { type: 'button', className: 'ds-ardl-hit-toggle', onClick: () => setExpandedHitRows((prev) => {
                      const next = new Set(prev);
                      next.delete(s.id);
                      return next;
                    }) }, t.hideHits)
                  : hiddenHits > 0
                    ? React.createElement('button', { type: 'button', className: 'ds-ardl-hit-toggle', onClick: () => setExpandedHitRows((prev) => {
                        const next = new Set(prev);
                        next.add(s.id);
                        return next;
                      }) }, t.moreHits(hiddenHits))
                    : null
              )
            : null,
          previewOpen
            ? React.createElement('div', { className: 'ds-ardl-preview' },
                previewMsgs === undefined
                  ? React.createElement('div', { className: 'ds-ardl-preview-loading' }, t.previewLoading)
                  : (previewMsgs.length === 0
                      ? React.createElement('div', { className: 'ds-ardl-preview-empty' }, t.previewEmpty)
                      : previewMsgs.map((m, idx) => React.createElement('div', { key: idx, className: 'ds-ardl-preview-msg ' + m.role },
                          React.createElement('span', { className: 'ds-ardl-preview-role' }, m.role === 'user' ? t.roleUser : m.role === 'assistant' ? t.roleAssistant : m.role + '：'),
                          React.createElement('span', { className: 'ds-ardl-preview-text' }, m.text)
                        )))
              )
            : null
        ),
        confirming
          ? React.createElement('div', { className: 'ds-ardl-actions' },
              React.createElement('button', { className: 'ds-ardl-btn primary', disabled: busyId === s.id, onClick: () => doDelete(s.id) }, busyId === s.id ? t.deleting : t.confirmDelete),
              React.createElement('button', { className: 'ds-ardl-btn', disabled: busyId === s.id, onClick: () => setConfirmId(undefined) }, t.cancel)
            )
          : React.createElement('div', { className: 'ds-ardl-actions' },
              React.createElement('button', { className: 'ds-ardl-btn restore', disabled: busyId === s.id, onClick: () => doRestore(s.id) }, t.restoreOpen),
              React.createElement('button', { className: 'ds-ardl-btn danger', disabled: busyId === s.id, onClick: () => setConfirmId(s.id) }, t.delete)
            )
      );
    };

    const body = isBusy && rows.length === 0
      ? React.createElement('div', { className: 'ds-ardl-empty' }, searching ? t.searching : t.loading)
      : rows.length === 0
        ? React.createElement('div', { className: 'ds-ardl-empty' }, query.trim() ? t.emptyNoMatch : t.emptyNoArchived)
        : groups.map((group) => {
            const collapsed = effectiveCollapsed(group.key);
            return React.createElement('div', { key: group.key, className: 'ds-ardl-group' + (collapsed ? ' collapsed' : '') },
              React.createElement('button', {
                type: 'button',
                className: 'ds-ardl-group-header',
                'aria-expanded': !collapsed,
                title: collapsed ? t.expandGroup : t.collapseGroup,
                onClick: () => setGroupCollapsed(group.key, !collapsed),
              },
                React.createElement('span', { className: 'ds-ardl-group-caret' }, collapsed ? '▸' : '▾'),
                React.createElement('span', { className: 'ds-ardl-group-name', title: group.key }, group.label),
                React.createElement('span', { className: 'ds-ardl-group-count' }, String(group.items.length))
              ),
              collapsed ? null : group.items.map(renderRow)
            );
          });

    const countText = (() => {
      if (loading) return '';
      if (!searchingNow) return t.countAll(rows.length);
      const modeLabel = t.modeLabels[searchMode] || '';
      return t.countMatch(rows.length, modeLabel);
    })();

    return React.createElement(React.Fragment, null,
      React.createElement('input', {
        className: 'ds-ardl-search', type: 'text',
        placeholder: t.searchPlaceholder, value: query,
        onChange: (e) => setQuery(e.target.value),
        onCompositionStart: () => { composingRef.current = true; },
        onCompositionEnd: (e) => {
          composingRef.current = false;
          const value = e && e.currentTarget ? e.currentTarget.value : undefined;
          if (typeof value === 'string') setQuery(value);
          setCompositionTick((tick) => tick + 1);
        },
      }),
      React.createElement('div', { className: 'ds-ardl-chips' },
        TYPE_CHIPS.map((c) => React.createElement('button', {
          key: c.key,
          className: 'ds-ardl-chip' + (typeFilter === c.key ? ' active' : ''),
          onClick: () => switchTypeFilter(c.key),
        }, c.label))
      ),
      selectedIds.size > 0
        ? React.createElement('div', { className: 'ds-ardl-batch-bar' },
            React.createElement('span', { className: 'ds-ardl-batch-info' }, t.batchSelected(selectedIds.size)),
            batchConfirm
              ? React.createElement(React.Fragment, null,
                  React.createElement('button', { className: 'ds-ardl-btn primary', disabled: batchBusy, onClick: doBatchDelete }, batchBusy ? t.deleting : t.confirmDeleteSelected),
                  React.createElement('button', { className: 'ds-ardl-btn', disabled: batchBusy, onClick: () => setBatchConfirm(false) }, t.cancel)
                )
              : React.createElement('button', { className: 'ds-ardl-btn danger', disabled: batchBusy, onClick: () => setBatchConfirm(true) }, t.deleteSelected)
          )
        : null,
      !loading ? React.createElement('div', { className: 'ds-ardl-count-row' },
        React.createElement('span', { className: 'ds-ardl-count' }, countText + (searching ? t.searchingSuffix : refreshing ? t.refreshingSuffix : '')),
        groups.length > 1
          ? React.createElement('button', { type: 'button', className: 'ds-ardl-linkbtn', onClick: () => setAllCollapsed(!allCollapsed) }, allCollapsed ? t.expandAll : t.collapseAll)
          : null
      ) : null,
      error ? React.createElement('div', { className: 'ds-ardl-err' }, error) : null,
      React.createElement('div', { className: 'ds-ardl-list' }, body)
    );
  }

  // The settings shell resolves a section's `label` through the slot system and
  // re-reads it on every locale revision, so the label is a function bound to our
  // locale namespace instead of a manual register/unregister pair.
  const LOCALE_NS = 'archiveManager';
  const LOCALE_DICTIONARY = {
    zh: { settingsLabel: I18N.zh.settingsLabel },
    en: { settingsLabel: I18N.en.settingsLabel },
  };
  try {
    ctx.effect(() => ctx.locale.register(LOCALE_NS, LOCALE_DICTIONARY), 'ds-ardl: locale dictionary');
  } catch {}
  const translate = (() => {
    try {
      if (typeof ctx.locale?.bind === 'function') return ctx.locale.bind(LOCALE_NS);
    } catch {}
    return (key) => (I18N[getLocaleId(ctx)] || I18N.zh)[key] || key;
  })();

  slots.inject('settings.section', () => slots.register(
    {
      name: 'settings.section',
      id: 'ds-arch-section',
      order: 80,
      label: () => translate('settingsLabel'),
      locale: LOCALE_NS,
    },
    (props) => React.createElement(ArchivedList, { close: props ? props.close : undefined })
  ));
}
