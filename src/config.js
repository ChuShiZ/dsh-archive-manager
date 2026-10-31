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
  /**
   * Automatic archiving of idle sessions (disable by default; every rule is
   * opt-in).
   */
  autoArchive: {
    /** Master switch. Manual runs (`autoArchiveRun`) still work while false. */
    enabled: false,
    /** Archive sessions whose last activity is at least this many days old. 0 disables the rule. */
    maxAgeDays: 5,
    /** Keep at most this many unarchived sessions per cwd (0 disables the rule). */
    maxPerWorkspace: 0,
    /** Never archive a session active within this many days (safety floor for both rules). */
    minAgeDays: 1,
    /** Delay between sweeps, in minutes. */
    intervalMinutes: 60,
    /** Delay after plugin start before the first sweep, in milliseconds. */
    startDelayMs: 60000,
  },
};

const AUTO_ARCHIVE_DEFAULTS = defaultConfig.autoArchive;

function boolOf(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function numberOf(value, fallback, min, max) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Clamp to [min, max] and quantize onto the schema's step (integer-safe). */
function steppedOf(value, fallback, min, max, step) {
  const clamped = numberOf(value, fallback, min, max);
  return Math.min(max, Math.max(min, Math.round(clamped / step) * step));
}

/**
 * Unwrap a Cordis volatile config reference (`schema.volatile()`) so policy
 * reads always see the live value instead of the stable reference object.
 * Plain values pass through untouched, so service-call overrides still work.
 */
function unwrapVolatile(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get();
    } catch {
      return undefined;
    }
  }
  return value;
}

/**
 * Merge a (possibly partial) auto-archive config onto an inherited one.
 * @param {object} [input]
 * @param {object} [inherited]
 * @returns {object}
 */
export function resolveAutoArchive(input, inherited = AUTO_ARCHIVE_DEFAULTS) {
  const rawSrc = unwrapVolatile(input);
  const src = rawSrc && typeof rawSrc === 'object' ? rawSrc : {};
  const rawBase = unwrapVolatile(inherited);
  const base = rawBase && typeof rawBase === 'object' ? rawBase : AUTO_ARCHIVE_DEFAULTS;
  return {
    enabled: boolOf(src.enabled, boolOf(base.enabled, AUTO_ARCHIVE_DEFAULTS.enabled)),
    maxAgeDays: steppedOf(src.maxAgeDays, steppedOf(base.maxAgeDays, AUTO_ARCHIVE_DEFAULTS.maxAgeDays, 0, 3650, 1), 0, 3650, 1),
    maxPerWorkspace: steppedOf(src.maxPerWorkspace, steppedOf(base.maxPerWorkspace, AUTO_ARCHIVE_DEFAULTS.maxPerWorkspace, 0, 1000, 1), 0, 1000, 1),
    minAgeDays: steppedOf(src.minAgeDays, steppedOf(base.minAgeDays, AUTO_ARCHIVE_DEFAULTS.minAgeDays, 0, 3650, 1), 0, 3650, 1),
    intervalMinutes: steppedOf(src.intervalMinutes, steppedOf(base.intervalMinutes, AUTO_ARCHIVE_DEFAULTS.intervalMinutes, 5, 1440, 5), 5, 1440, 5),
    startDelayMs: steppedOf(src.startDelayMs, steppedOf(base.startDelayMs, AUTO_ARCHIVE_DEFAULTS.startDelayMs, 0, 300000, 1000), 0, 300000, 1000),
  };
}

/**
 * Resolve a partial config onto a base (plugin config or defaults).
 * @param {object} [input]
 * @param {object} [base]
 * @returns {{deleteSandbox:'workspace-write'|'danger-full-access', warmTitles:boolean, warmDelayMs:number, autoArchive:object}}
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
  const autoArchive = resolveAutoArchive(src.autoArchive, inherited.autoArchive);
  return { deleteSandbox, warmTitles, warmDelayMs, autoArchive };
}
