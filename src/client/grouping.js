/**
 * Pure grouping helpers for the archived-session list.
 *
 * Kept free of React and DOM so the browser bundle and the Node smoke test can
 * share exactly the same behaviour.
 */

/** Below this many archived sessions the whole list stays expanded. */
const EXPAND_ALL_MAX_ROWS = 12;
/** A single expanded group longer than this would push the other projects out of view. */
const EXPAND_GROUP_MAX_ROWS = 6;

/**
 * Group rows by working directory (falling back to the workspace name) and order
 * groups by their most recent session. Two directories that share a basename stay
 * separate groups, so "D:/a/web" and "D:/b/web" no longer merge.
 * @param {Array<{id:string,workspace?:string,cwd?:string,createdAt?:number}>} rows
 * @param {string} unknownLabel
 * @returns {Array<{key:string, label:string, items:Array, newest:number}>}
 */
export function groupRows(rows, unknownLabel) {
  const map = new Map();
  for (const row of rows || []) {
    const key = (row && (row.cwd || row.workspace)) || unknownLabel;
    const label = (row && (row.workspace || row.cwd)) || unknownLabel;
    let group = map.get(key);
    if (group === undefined) {
      group = { key, label, items: [], newest: 0 };
      map.set(key, group);
    }
    group.items.push(row);
    const time = Number(row && row.createdAt) || 0;
    if (time > group.newest) group.newest = time;
  }
  return [...map.values()].sort((a, b) => b.newest - a.newest || a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
}

/**
 * Collapse state used before the user has touched any group header.
 *
 * A short archive stays fully expanded. Once the archive is long enough to
 * overflow the panel, every project starts collapsed so each one is readable in
 * the group header list; the newest project keeps its rows visible only when it
 * is short enough not to hide the others.
 * @param {Array<{key:string, items:Array}>} groups
 * @returns {Object<string, boolean>}
 */
export function defaultCollapsedGroups(groups) {
  const list = groups || [];
  const collapsed = {};
  const total = list.reduce((sum, group) => sum + (group.items ? group.items.length : 0), 0);
  if (total <= EXPAND_ALL_MAX_ROWS) return collapsed;
  const first = list[0];
  const keepFirstOpen = !!first && (first.items ? first.items.length : 0) <= EXPAND_GROUP_MAX_ROWS;
  list.forEach((group, index) => {
    collapsed[group.key] = !(index === 0 && keepFirstOpen);
  });
  return collapsed;
}

/**
 * Effective collapse state for one group.
 * @param {Object<string, boolean>|null|undefined} saved - persisted map, null before any interaction
 * @param {Object<string, boolean>} defaults - result of {@link defaultCollapsedGroups}
 * @param {string} key
 * @returns {boolean}
 */
export function isGroupCollapsed(saved, defaults, key) {
  if (saved && Object.prototype.hasOwnProperty.call(saved, key)) return !!saved[key];
  return !!(defaults && defaults[key]);
}
