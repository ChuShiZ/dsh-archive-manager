/**
 * Shared shape documentation for the archive-manager plugin.
 *
 * These are kept as plain JSDoc because this scaffold ships runnable plain-JS
 * source. If you adapt it to the DSH TypeScript build (tsdown), convert these
 * to real interfaces under `src/shared/types.ts`.
 */

/**
 * One archived-session list row.
 * @typedef {Object} ArchivedSessionRow
 * @property {string} id          - Session id.
 * @property {string} title       - Folded session title ('' when the log has no title event).
 * @property {string} cwd         - Absolute working directory the session was created in.
 * @property {number} createdAt   - Unix epoch milliseconds.
 * @property {string} agentPreset - Agent preset the session was composed from.
 */
export {};
