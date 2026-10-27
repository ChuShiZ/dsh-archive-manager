/**
 * Shared shape documentation for the archive-manager plugin.
 *
 * These are kept as plain JSDoc because this plugin ships runnable plain-JS
 * source built with tsdown.
 */

/**
 * One archived-session list row (from `archiveManager.list()` / `search()`).
 * @typedef {Object} ArchivedSessionRow
 * @property {string} id          - Session id.
 * @property {string} title       - Folded title. Usually '' from list(): folding one title
 *                                  needs the session's full log, so the host fills an
 *                                  in-memory cache on demand and the client requests the
 *                                  rest through titles(ids) after painting.
 * @property {string} cwd         - Absolute working directory the session was created in.
 * @property {string} workspace   - Basename of `cwd` (grouping key in the UI).
 * @property {number} createdAt   - Unix epoch milliseconds.
 * @property {string} agentPreset - Agent preset the session was composed from.
 */

/**
 * `archiveManager.list()` result.
 * @typedef {Object} ArchivedListResult
 * @property {ArchivedSessionRow[]} rows    - Rows, newest first.
 * @property {string[]} [titlesMissing]     - Ids whose title still needs titles().
 */

/**
 * `archiveManager.titles(ids)` result.
 * @typedef {Object} ArchivedTitlesResult
 * @property {Object<string, string>} titles - Folded titles keyed by session id.
 */

/**
 * One full-text search hit inside a session (from `archiveManager.search()`).
 * @typedef {Object} ArchivedSessionHit
 * @property {string} snippet - Context excerpt around the match.
 * @property {number} time    - Event timestamp (Unix epoch milliseconds).
 * @property {string} type    - Session event type (e.g. 'user/message').
 */

/**
 * Search result row: an {@link ArchivedSessionRow} plus its hits.
 * @typedef {ArchivedSessionRow} SearchResultRow
 * @property {ArchivedSessionHit[]} snippets - Up to 5 hits, best first.
 * @property {number} matchCount             - Total hits in this session (may exceed snippets length).
 */
export {};
