/**
 * Plugin configuration schema.
 *
 * In a real DSH build this becomes a Schemastery schema owned by the row. This
 * plain-JS module documents the fields and gives the defaults the host plugin
 * consumes.
 *
 * @typedef {Object} ArchiveManagerConfig
 * @property {'workspace-write'|'danger-full-access'} deleteSandbox
 *   - 'workspace-write'      : confine the delete shell command. Fails where the
 *                              session root is outside allowed roots or no sandbox
 *                              backend is usable (hard results surface stderr).
 *   - 'danger-full-access'   : run the delete command unconfined. Only for trusted
 *                              single-user hosts. Default.
 * @property {number} openDelayMs
 *   Wait before `sessions.open(id)` after un-archiving, so the host archive frame
 *   has time to put the session back into the active list. Default 300.
 */
export const defaultConfig = {
  deleteSandbox: 'danger-full-access',
  openDelayMs: 300,
};

/**
 * Resolve a partial caller config onto defaults, ignoring unknown keys.
 * @param {object} [input]
 * @returns {ArchiveManagerConfig}
 */
export function resolveConfig(input) {
  const src = input && typeof input === 'object' ? input : {};
  const deleteSandbox = src.deleteSandbox === 'workspace-write' ? 'workspace-write' : 'danger-full-access';
  const openDelayMs = Number.isFinite(src.openDelayMs) && src.openDelayMs > 0 ? src.openDelayMs : defaultConfig.openDelayMs;
  return { deleteSandbox, openDelayMs };
}
