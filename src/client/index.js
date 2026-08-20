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
export {};

// The module-loader wrapper below is the shape the web build produces. Source
// targets/tsdown uses, so keep `apply` as the frame that registers the slot UI.
export function apply(ctx) {
  const slots = ctx.get('slots');
  const sessions = ctx.get('sessions');
  const timer = ctx.get('timer');
  const manager = ctx.get('archiveManager');
  if (slots === undefined || manager === undefined) return;

  const CSS = [
    '.ds-ardl-search{width:100%;box-sizing:border-box;margin-bottom:10px;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;outline:none;}',
    '.ds-ardl-search:focus{border-color:var(--dsw-alias-brand-primary);}',
    '.ds-ardl-count{font-size:12px;color:var(--dsw-alias-label-secondary);margin:0 0 8px;}',
    '.ds-ardl-list{max-height:62vh;overflow:auto;margin:0;}',
    '.ds-ardl-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
    '.ds-ardl-meta{min-width:0;}',
    '.ds-ardl-title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary);}',
    '.ds-ardl-sub{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px;}',
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
  function matchRow(q, r) {
    if (!q) return true;
    const s = q.toLowerCase();
    return (
      (r.title && r.title.toLowerCase().indexOf(s) !== -1) ||
      (r.cwd && r.cwd.toLowerCase().indexOf(s) !== -1) ||
      String(r.id).toLowerCase().indexOf(s) !== -1 ||
      (r.agentPreset && r.agentPreset.toLowerCase().indexOf(s) !== -1)
    );
  }
  const shortId = (id) => String(id).slice(0, 10);
  const titleOf = (r) => r.title || basenameOf(r.cwd) || shortId(r.id);
  const subOf = (r) => [basenameOf(r.cwd), fmtTime(r.createdAt), r.agentPreset, shortId(r.id)].filter(Boolean).join('   ·   ');

  function ArchivedList(props) {
    const close = props && props.close;
    const [rows, setRows] = React.useState([]);
    const [query, setQuery] = React.useState('');
    const [loading, setLoading] = React.useState(false);
    const [confirmId, setConfirmId] = React.useState(undefined);
    const [busyId, setBusyId] = React.useState(undefined);
    const [error, setError] = React.useState('');

    const refresh = React.useCallback(async () => {
      setLoading(true);
      setError('');
      try {
        const r = await manager.list();
        setRows(r && r.rows ? r.rows : []);
      } catch (e) {
        setError('加载失败: ' + (e && e.message ? e.message : String(e)));
      } finally {
        setLoading(false);
      }
    }, []);

    React.useEffect(() => {
      refresh();
    }, [refresh]);

    const doRestore = async (id) => {
      setBusyId(id);
      setError('');
      try {
        await manager.unarchive(id);
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
        await manager.delete(id);
        setConfirmId(undefined);
        await refresh();
      } catch (e) {
        setError('删除失败: ' + (e && e.message ? e.message : String(e)));
      } finally {
        setBusyId(undefined);
      }
    };

    const filtered = rows.filter((r) => matchRow(query, r));

    const body = loading
      ? React.createElement('div', { className: 'ds-ardl-empty' }, '加载中…')
      : rows.length === 0
        ? React.createElement('div', { className: 'ds-ardl-empty' }, '没有已归档的会话。')
        : filtered.length === 0
          ? React.createElement('div', { className: 'ds-ardl-empty' }, '无匹配的归档会话。')
          : filtered.map((s) => {
              const confirming = confirmId === s.id;
              return React.createElement('div', { key: s.id, className: 'ds-ardl-row' },
                React.createElement('div', { className: 'ds-ardl-meta' },
                  React.createElement('div', { className: 'ds-ardl-title' }, titleOf(s)),
                  React.createElement('div', { className: 'ds-ardl-sub' }, subOf(s))
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
            });

    return React.createElement(React.Fragment, null,
      React.createElement('input', {
        className: 'ds-ardl-search', type: 'text',
        placeholder: '搜索名称 / 目录 / id / 预设…', value: query,
        onChange: (e) => setQuery(e.target.value),
      }),
      !loading
        ? React.createElement('div', { className: 'ds-ardl-count' }, '共 ' + rows.length + ' 个归档会话' + (query ? '，匹配 ' + filtered.length + ' 个' : ''))
        : null,
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
