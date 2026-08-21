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
export const inject = ['slots', 'sessions', 'timer'];

const React = typeof require !== 'undefined' ? require('react') : globalThis.React;

// The module-loader wrapper below is the shape the web build produces. Source
// targets/tsdown uses, so keep `apply` as the frame that registers the slot UI.
export function apply(ctx) {
  const slots = ctx.slots ?? ctx.get('slots');
  const sessions = ctx.sessions ?? ctx.get('sessions');
  const timer = ctx.timer ?? ctx.get('timer');
  if (slots === undefined) return;
  const getManager = () => {
    try {
      const m = ctx.archiveManager ?? ctx.get('archiveManager');
      if (m && typeof m.list === 'function') return m;
    } catch {}
    // HTTP fallback via webServer route (for runtimes that don't proxy archiveManager)
    const httpCall = (path, body) => fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    return {
      list: () => httpCall('/archive-manager/api/list'),
      search: (opts) => httpCall('/archive-manager/api/search', opts || {}),
      unarchive: (id) => httpCall('/archive-manager/api/unarchive', { id }),
      delete: (id, cfg) => httpCall('/archive-manager/api/delete', { id, config: cfg }),
    };
  };

  const CSS = [
    '.ds-ardl-search{width:100%;box-sizing:border-box;margin-bottom:10px;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;outline:none;}',
    '.ds-ardl-search:focus{border-color:var(--dsw-alias-brand-primary);}',
    '.ds-ardl-count{font-size:12px;color:var(--dsw-alias-label-secondary);margin:0 0 8px;}',
    '.ds-ardl-hint{font-size:11px;color:var(--dsw-alias-label-secondary);margin:0 0 8px;opacity:.8;}',
    '.ds-ardl-list{max-height:62vh;overflow:auto;margin:0;}',
    '.ds-ardl-group{margin-bottom:6px;}',
    '.ds-ardl-group-header{display:flex;align-items:center;justify-content:space-between;padding:8px 8px 4px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l2);}',
    '.ds-ardl-group-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.ds-ardl-group-count{flex:none;opacity:.7;}',
    '.ds-ardl-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
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
    '.ds-ardl-snippets{margin-top:2px;}',
    '.ds-ardl-snippet-more{font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.7;margin-top:3px;}',
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

  function ArchivedList(props) {
    const close = props && props.close;
    const [rows, setRows] = React.useState([]);
    const [query, setQuery] = React.useState('');
    const [loading, setLoading] = React.useState(false);
    const [searching, setSearching] = React.useState(false);
    const [searchMode, setSearchMode] = React.useState('');
    const [confirmId, setConfirmId] = React.useState(undefined);
    const [busyId, setBusyId] = React.useState(undefined);
    const [error, setError] = React.useState('');
    const [typeFilter, setTypeFilter] = React.useState('all');
    const [expandedHits, setExpandedHits] = React.useState({});

    const TYPE_CHIPS = [
      { key: 'all', label: '全部', types: [] },
      { key: 'user', label: '用户消息', types: ['user/message'] },
      { key: 'assistant', label: 'AI 回复', types: ['assistant/message'] },
      { key: 'tool', label: '工具调用', types: ['tool/call', 'tool/result'] },
    ];

    const refresh = React.useCallback(async () => {
      setLoading(true);
      setError('');
      try {
        const m = getManager();
        if (!m) throw new Error('archiveManager 服务未就绪');
        const r = await m.list();
        setRows(r && r.rows ? r.rows : []);
        setSearchMode('');
      } catch (e) {
        setError('加载失败: ' + (e && e.message ? e.message : String(e)));
      } finally {
        setLoading(false);
      }
    }, []);

    // debounced full-text search: query -> manager.search()
    const searchTimer = React.useRef(null);
    const doSearch = React.useCallback(async (q, types) => {
      const trimmed = String(q || '').trim();
      if (!trimmed) {
        await refresh();
        return;
      }
      setSearching(true);
      setError('');
      try {
        const m = getManager();
        if (!m) throw new Error('archiveManager 服务未就绪');
        if (typeof m.search === 'function') {
          const r = await m.search({ query: trimmed, limit: 50, ...(types && types.length > 0 ? { types } : {}) });
          setRows(r && r.rows ? r.rows : []);
          setSearchMode(r && r.mode ? r.mode : '');
        } else {
          const r = await m.list();
          const low = trimmed.toLowerCase();
          const filtered = (r.rows || []).filter((row) => (row.title && row.title.toLowerCase().indexOf(low) !== -1) || String(row.id).toLowerCase().indexOf(low) !== -1);
          setRows(filtered);
        }
      } catch (e) {
        setError('搜索失败: ' + (e && e.message ? e.message : String(e)));
      } finally {
        setSearching(false);
      }
    }, [refresh]);

    const switchTypeFilter = (key) => {
      setTypeFilter(key);
      const chip = TYPE_CHIPS.find((c) => c.key === key);
      const trimmed = String(query || '').trim();
      if (trimmed) doSearch(trimmed, chip ? chip.types : []);
    };

    React.useEffect(() => {
      refresh();
    }, [refresh]);

    React.useEffect(() => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
      const trimmed = String(query || '').trim();
      if (!trimmed) {
        // immediate refresh when cleared
        refresh();
        return;
      }
      searchTimer.current = setTimeout(() => { doSearch(query); }, 280);
      return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
    }, [query, doSearch, refresh]);

    const doRestore = async (id) => {
      setBusyId(id);
      setError('');
      try {
        const m = getManager();
        if (!m) throw new Error('archiveManager 服务未就绪');
        await m.unarchive(id);
        setConfirmId(undefined);
        if (close) close();
        timer.timeout(() => {
          try { if (sessions) sessions.open(id); } catch (_e) {}
        }, 300);
      } catch (e) {
        setError('恢复失败: ' + (e && e.message ? e.message : String(e)));
      } finally {
        setBusyId(undefined);
      }
    };

    const doDelete = async (id) => {
      setBusyId(id);
      setError('');
      try {
        const m = getManager();
        if (!m) throw new Error('archiveManager 服务未就绪');
        await m.delete(id);
        setConfirmId(undefined);
        const trimmed = String(query || '').trim();
        if (trimmed) await doSearch(trimmed);
        else await refresh();
      } catch (e) {
        setError('删除失败: ' + (e && e.message ? e.message : String(e)));
      } finally {
        setBusyId(undefined);
      }
    };

    const isBusy = loading || searching;

    // group rows by workspace (mirrors sidebar grouping)
    const groups = (() => {
      const map = new Map();
      for (const r of rows) {
        const key = r.workspace || '(未知工作区)';
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(r);
      }
      return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    })();

    const renderRow = (s) => {
      const confirming = confirmId === s.id;
      const snippetList = (s.snippets && s.snippets.length > 0 ? s.snippets : (s.snippet ? [{ segments: [{ text: s.snippet, hit: false }] }] : []));
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
        React.createElement('div', { className: 'ds-ardl-meta' },
          React.createElement('div', { className: 'ds-ardl-title' }, titleOf(s)),
          React.createElement('div', { className: 'ds-ardl-sub' }, subOf(s)),
          snippetList.length > 0
            ? React.createElement('div', { className: 'ds-ardl-snippets' },
                snippetList.map(renderHit),
                typeof s.matchCount === 'number' && s.matchCount > snippetList.length
                  ? React.createElement('div', { className: 'ds-ardl-snippet-more' }, '… 还有 ' + (s.matchCount - snippetList.length) + ' 处命中')
                  : null
              )
            : null
        ),
        confirming
          ? React.createElement('div', { className: 'ds-ardl-actions' },
              React.createElement('button', { className: 'ds-ardl-btn primary', disabled: busyId === s.id, onClick: () => doDelete(s.id) }, busyId === s.id ? '删除中…' : '确认删除'),
              React.createElement('button', { className: 'ds-ardl-btn', disabled: busyId === s.id, onClick: () => setConfirmId(undefined) }, '取消')
            )
          : React.createElement('div', { className: 'ds-ardl-actions' },
              React.createElement('button', { className: 'ds-ardl-btn restore', disabled: busyId === s.id, onClick: () => doRestore(s.id) }, '恢复并打开'),
              React.createElement('button', { className: 'ds-ardl-btn danger', disabled: busyId === s.id, onClick: () => setConfirmId(s.id) }, '删除')
            )
      );
    };

    const body = isBusy && rows.length === 0
      ? React.createElement('div', { className: 'ds-ardl-empty' }, searching ? '搜索中…' : '加载中…')
      : rows.length === 0
        ? React.createElement('div', { className: 'ds-ardl-empty' }, query.trim() ? '无匹配的归档会话。' : '没有已归档的会话。')
        : groups.map(([ws, items]) =>
            React.createElement('div', { key: ws, className: 'ds-ardl-group' },
              React.createElement('div', { className: 'ds-ardl-group-header' },
                React.createElement('span', { className: 'ds-ardl-group-name' }, ws),
                React.createElement('span', { className: 'ds-ardl-group-count' }, String(items.length))
              ),
              items.map(renderRow)
            )
          );

    const countText = (() => {
      const q = String(query || '').trim();
      if (loading) return '';
      if (!q) return '共 ' + rows.length + ' 个归档会话';
      const modeLabel = searchMode === 'fts' ? '（FTS 全文）' : searchMode === 'scan' ? '（逐会话扫描）' : '';
      return '匹配 ' + rows.length + ' 个' + modeLabel;
    })();

    return React.createElement(React.Fragment, null,
      React.createElement('input', {
        className: 'ds-ardl-search', type: 'text',
        placeholder: '搜索名称 / 目录 / id / 预设 / 会话正文…', value: query,
        onChange: (e) => setQuery(e.target.value),
      }),
      React.createElement('div', { className: 'ds-ardl-chips' },
        TYPE_CHIPS.map((c) => React.createElement('button', {
          key: c.key,
          className: 'ds-ardl-chip' + (typeFilter === c.key ? ' active' : ''),
          onClick: () => switchTypeFilter(c.key),
        }, c.label))
      ),
      React.createElement('div', { className: 'ds-ardl-hint' }, '支持全文：检索会话内的用户消息、AI 回复与工具调用内容（FTS5），每个会话最多展示 5 条命中，点击命中可展开，空输入显示全部归档'),
      !loading ? React.createElement('div', { className: 'ds-ardl-count' }, countText + (searching ? '  ·  搜索中…' : '')) : null,
      error ? React.createElement('div', { className: 'ds-ardl-err' }, error) : null,
      React.createElement('div', { className: 'ds-ardl-list' }, body)
    );
  }

  slots.inject('settings.section', () =>
    slots.register(
      { name: 'settings.section', id: 'ds-arch-section', order: 80, label: '归档会话' },
      (props) => React.createElement(ArchivedList, { close: props ? props.close : undefined })
    )
  );
}
