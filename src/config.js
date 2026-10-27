/**
 * Plugin configuration for dsh-archive-manager.
 *
 * `apply(ctx, config)` receives the Config validated by src/index.js; these
 * helpers fill defaults for direct service callers and config overrides.
 */
export const defaultConfig = {
  /** Sandbox mode for the shell command that removes the log directory. */
  deleteSandbox: 'danger-full-access',
  /** Warm folded titles in the background after startup. */
  warmTitles: true,
  /** Delay before the background title warm-up starts, in milliseconds. */
  warmDelayMs: 6000,
};

/**
 * Resolve a partial config onto a base (plugin config or defaults).
 * @param {object} [input]
 * @param {object} [base]
 * @returns {{deleteSandbox:'workspace-write'|'danger-full-access', warmTitles:boolean, warmDelayMs:number}}
 */
export function resolveConfig(input, base = defaultConfig) {
  const src = input && typeof input === 'object' ? input : {};
  const inherited = base && typeof base === 'object' ? base : defaultConfig;
  const deleteSandbox = src.deleteSandbox === 'workspace-write'
    ? 'workspace-write'
    : src.deleteSandbox === 'danger-full-access'
      ? 'danger-full-access'
      : inherited.deleteSandbox === 'workspace-write' ? 'workspace-write' : 'danger-full-access';
  const warmTitles = typeof src.warmTitles === 'boolean'
    ? src.warmTitles
    : typeof inherited.warmTitles === 'boolean' ? inherited.warmTitles : true;
  const warmDelayMs = Number.isFinite(src.warmDelayMs)
    ? Math.max(0, Math.min(60000, src.warmDelayMs))
    : Number.isFinite(inherited.warmDelayMs) ? inherited.warmDelayMs : 6000;
  return { deleteSandbox, warmTitles, warmDelayMs };
}
