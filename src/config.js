/**
 * Delete sandbox mode for `archiveManager.delete`.
 * `danger-full-access` runs unconfined; `workspace-write` is confined and fails
 * when the session root is outside allowed roots or no backend is usable.
 */
export const defaultConfig = {
  deleteSandbox: 'danger-full-access',
};

/**
 * Resolve a partial caller config onto defaults.
 * @param {object} [input]
 * @returns {{deleteSandbox:'workspace-write'|'danger-full-access'}}
 */
export function resolveConfig(input) {
  const src = input && typeof input === 'object' ? input : {};
  const deleteSandbox = src.deleteSandbox === 'workspace-write' ? 'workspace-write' : 'danger-full-access';
  return { deleteSandbox };
}
