//#region src/config.js
/**
* Resolve a partial caller config onto defaults.
* @param {object} [input]
* @returns {{deleteSandbox:'workspace-write'|'danger-full-access'}}
*/
function resolveConfig(input) {
	return { deleteSandbox: (input && typeof input === "object" ? input : {}).deleteSandbox === "workspace-write" ? "workspace-write" : "danger-full-access" };
}
//#endregion
//#region src/index.js
/**
* Host half of dsh-archive-manager.
*
* A Cordis plugin row (see cordis.patch.yml) that provides the `archiveManager`
* service:
*   - list()      archived sessions still in persistence (ghosts dropped), with
*                 folded titles via sessionQuery.
*   - unarchive() remove an id from the durable workspace archive set.
*   - delete()    truly remove the archived session's on-disk JSONL log dir.
*
* Installed as a profile bundle:  dsh plugin --profile <profile> add dsh-archive-manager
* The client half (src/client/index.js + the `dsh.client` entry) reaches this
* service through the harness's service/Remote plumbing.
*/
/** Plugin identity used by the loader (matches row `id` in cordis.patch.yml). */
const id = "archive-manager";
/** Hard dependencies on harness services. `agents` is optional (best-effort live-agent stop before delete). */
const inject = [
	"sessionPersistence",
	"workspaceRegistry",
	"fs",
	"shell",
	"sessionQuery"
];
/**
* The Cordis plugin. `apply(ctx)` runs once the injected services exist.
* @param {import('@deepseek-ai/cordis').Context} ctx
*/
function apply(ctx) {
	const { sessionPersistence, workspaceRegistry, fs, shell, sessionQuery } = ctx;
	async function listArchived() {
		const archived = workspaceRegistry.archivedSessionIds || [];
		const headers = await sessionPersistence.list();
		const byId = /* @__PURE__ */ new Map();
		for (const h of headers) byId.set(h.id, h);
		const present = archived.filter((id) => byId.has(id));
		const titles = /* @__PURE__ */ new Map();
		if (present.length > 0) try {
			const snaps = await sessionQuery.readTitleSnapshots(present);
			for (const r of snaps) if (r.status === "fulfilled") {
				const t = r.value && r.value.title;
				titles.set(r.sessionId, t && typeof t.title === "string" ? t.title : "");
			}
		} catch (_e) {}
		const rows = present.map((id) => {
			const h = byId.get(id);
			return {
				id,
				title: titles.get(id) || "",
				cwd: h.cwd || "",
				workspace: basenameOf(h.cwd),
				createdAt: h.createdAt || 0,
				agentPreset: h.agentPreset || ""
			};
		});
		rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
		return {
			rows,
			byId,
			present
		};
	}
	function basenameOf(p) {
		const s = String(p || "").replace(/[\\/]+$/, "");
		const parts = s.split(/[\\/]/);
		return parts[parts.length - 1] || s;
	}
	function buildKeywordRegex(query) {
		const pattern = String(query).trim().split(/\s+/u).map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("\\s+");
		return new RegExp(pattern, "giu");
	}
	function normalizeForDisplay(text) {
		let s = String(text || "");
		s = s.replace(/[^\s"']*[\\/][^\s"']*/g, (m) => {
			if (m.length <= 48) return m;
			const parts = m.split(/[\\/]/).filter(Boolean);
			const last = parts[parts.length - 1] || m;
			return "…" + (m.includes("\\") ? "\\" : "/") + last;
		});
		return s.replace(/\s+/gu, " ").trim();
	}
	function buildSnippetSegments(text, keywordRegex, radius = 40) {
		const normalized = normalizeForDisplay(text);
		keywordRegex.lastIndex = 0;
		const m = keywordRegex.exec(normalized);
		if (!m) return [{
			text: normalized.slice(0, radius * 2) + (normalized.length > radius * 2 ? "…" : ""),
			hit: false
		}];
		const start = Math.max(0, m.index - radius);
		const end = Math.min(normalized.length, m.index + m[0].length + radius);
		let window = normalized.slice(start, end);
		if (start > 0) window = "…" + window;
		if (end < normalized.length) window = window + "…";
		const segments = [];
		let last = 0;
		keywordRegex.lastIndex = 0;
		let km;
		while ((km = keywordRegex.exec(window)) !== null) {
			if (km.index > last) segments.push({
				text: window.slice(last, km.index),
				hit: false
			});
			segments.push({
				text: km[0],
				hit: true
			});
			last = km.index + km[0].length;
			if (km[0].length === 0) keywordRegex.lastIndex++;
		}
		if (last < window.length) segments.push({
			text: window.slice(last),
			hit: false
		});
		return segments.length > 0 ? segments : [{
			text: window,
			hit: false
		}];
	}
	const service = {
		/** List archived sessions that still exist in persistence. */
		async list() {
			const { rows } = await listArchived();
			return { rows };
		},
		/**
		* Full-text search over archived sessions.
		* Tries FTS5 (sessionQuery.searchSessions) first, falls back to per-session filterEvents.
		* @param {string|{query:string,limit?:number}} opts
		*/
		async search(opts) {
			const query = typeof opts === "string" ? opts : opts && opts.query || "";
			const limit = opts && typeof opts === "object" && Number.isFinite(opts.limit) ? opts.limit : 50;
			const perSession = opts && typeof opts === "object" && Number.isFinite(opts.perSession) ? Math.max(1, Math.min(10, opts.perSession)) : 5;
			const types = opts && typeof opts === "object" && Array.isArray(opts.types) ? opts.types.filter((t) => typeof t === "string" && t) : [];
			const trimmed = String(query || "").trim();
			if (!trimmed) {
				const { rows } = await listArchived();
				return {
					rows,
					query: ""
				};
			}
			const archived = workspaceRegistry.archivedSessionIds || [];
			if (archived.length === 0) return {
				rows: [],
				query: trimmed
			};
			const keywordRegex = buildKeywordRegex(trimmed);
			const toHit = (text, time, type) => ({
				segments: buildSnippetSegments(text, keywordRegex),
				fullText: normalizeForDisplay(text),
				time: time || 0,
				type: type || ""
			});
			if (sessionQuery && typeof sessionQuery.searchSessions === "function") try {
				const res = await sessionQuery.searchSessions({
					query: trimmed,
					limit,
					sessionFilters: [{
						kind: "id",
						values: archived
					}]
				});
				const ids = res.items.map((it) => it.header.id);
				const titles = /* @__PURE__ */ new Map();
				if (ids.length > 0) try {
					const snaps = await sessionQuery.readTitleSnapshots(ids);
					for (const r of snaps) if (r.status === "fulfilled") titles.set(r.sessionId, r.value?.title?.title || "");
				} catch {}
				const hitsBySession = /* @__PURE__ */ new Map();
				if (typeof sessionQuery.searchEvents === "function") await Promise.all(res.items.map(async (item) => {
					try {
						const ev = await sessionQuery.searchEvents({
							sessionId: item.header.id,
							query: trimmed,
							limit: perSession,
							...types.length > 0 ? { filters: [{
								kind: "type",
								values: types
							}] } : {}
						});
						hitsBySession.set(item.header.id, (ev.items || []).map((e) => ({
							snippet: e.snippet || "",
							text: e.snippet || "",
							time: e.time || 0,
							type: e.type || ""
						})).filter((h) => h.text));
					} catch {}
				}));
				const rows = res.items.map((item) => {
					const h = item.header;
					const best = item.bestMatch || null;
					const hits = hitsBySession.get(h.id);
					const snippets = (hits && hits.length > 0 ? hits.slice(0, perSession) : best && best.snippet ? [{
						text: best.snippet,
						time: best.time || 0,
						type: best.type || ""
					}] : []).map((h2) => toHit(h2.text, h2.time, h2.type));
					return {
						id: h.id,
						title: titles.get(h.id) || "",
						cwd: h.cwd || "",
						workspace: basenameOf(h.cwd),
						createdAt: h.createdAt || 0,
						agentPreset: h.agentPreset || "",
						snippet: snippets[0]?.segments.map((s) => s.text).join("") || "",
						snippets,
						matchCount: snippets.length,
						bestMatch: best
					};
				});
				if (rows.length === 0) {} else {
					try {
						const ftsIds = new Set(rows.map((r) => r.id));
						const headers2 = await sessionPersistence.list();
						const byId2 = new Map(headers2.map((h) => [h.id, h]));
						const present2 = archived.filter((id) => byId2.has(id) && !ftsIds.has(id));
						if (present2.length > 0) {
							const extra = [];
							let cur2 = 0;
							const scanHits2 = async () => {
								while (cur2 < present2.length) {
									const idx = cur2++;
									const id = present2[idx];
									try {
										const filters = [{
											kind: "text",
											text: trimmed
										}];
										if (types.length > 0) filters.push({
											kind: "type",
											values: types
										});
										const docs = await sessionQuery.filterEvents(id, filters);
										if (docs.length > 0) {
											const hits = docs.slice(0, perSession).map((d) => toHit(d.text, d.time, d.type));
											extra.push({
												id,
												header: byId2.get(id),
												hits,
												total: docs.length
											});
										}
									} catch {}
								}
							};
							const conc2 = Math.min(6, present2.length);
							await Promise.all(Array.from({ length: conc2 }, () => scanHits2()));
							if (extra.length > 0) {
								const titles2b = /* @__PURE__ */ new Map();
								try {
									const snaps = await sessionQuery.readTitleSnapshots(extra.map((m) => m.id));
									for (const r of snaps) if (r.status === "fulfilled") titles2b.set(r.sessionId, r.value?.title?.title || "");
								} catch {}
								const extraRows = extra.map((m) => ({
									id: m.id,
									title: titles2b.get(m.id) || "",
									cwd: m.header.cwd || "",
									workspace: basenameOf(m.header.cwd),
									createdAt: m.header.createdAt || 0,
									agentPreset: m.header.agentPreset || "",
									snippet: m.hits[0]?.segments.map((s) => s.text).join("") || "",
									snippets: m.hits,
									matchCount: m.total,
									bestMatch: m.hits[0] || null
								}));
								const merged = [...rows, ...extraRows];
								merged.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
								const sliced = merged.slice(0, limit);
								return {
									rows: sliced,
									query: trimmed,
									nextCursor: res.nextCursor || null,
									mode: sliced.length > rows.length ? "fts+scan" : "fts",
									scanSupplement: extraRows.length
								};
							}
						}
					} catch {}
					return {
						rows,
						query: trimmed,
						nextCursor: res.nextCursor || null,
						mode: "fts"
					};
				}
			} catch (e) {
				const code = e && e.code ? String(e.code) : "";
				if (code === "SESSION_QUERY_INVALID_QUERY" || code === "SESSION_QUERY_INVALID_FILTER") throw e;
				if (code === "SESSION_QUERY_SEARCH_DISABLED" || code === "SESSION_QUERY_INDEX_FAILED") {} else if (code) {
					if (code.includes("CURSOR") || code.includes("LIMIT")) throw e;
				}
			}
			const headers = await sessionPersistence.list();
			const byId = new Map(headers.map((h) => [h.id, h]));
			const present = archived.filter((id) => byId.has(id));
			const matched = [];
			const concurrency = 6;
			let cursor = 0;
			async function worker() {
				while (cursor < present.length) {
					const idx = cursor++;
					const id = present[idx];
					try {
						const filters = [{
							kind: "text",
							text: trimmed
						}];
						if (types.length > 0) filters.push({
							kind: "type",
							values: types
						});
						const docs = await sessionQuery.filterEvents(id, filters);
						if (docs.length > 0) {
							const hits = docs.slice(0, perSession).map((d) => toHit(d.text, d.time, d.type));
							matched.push({
								id,
								header: byId.get(id),
								hits,
								total: docs.length
							});
						}
					} catch {}
				}
			}
			await Promise.all(Array.from({ length: Math.min(concurrency, present.length) }, () => worker()));
			const titles2 = /* @__PURE__ */ new Map();
			if (matched.length > 0) try {
				const snaps = await sessionQuery.readTitleSnapshots(matched.map((m) => m.id));
				for (const r of snaps) if (r.status === "fulfilled") titles2.set(r.sessionId, r.value?.title?.title || "");
			} catch {}
			const rows = matched.map((m) => ({
				id: m.id,
				title: titles2.get(m.id) || "",
				cwd: m.header.cwd || "",
				workspace: basenameOf(m.header.cwd),
				createdAt: m.header.createdAt || 0,
				agentPreset: m.header.agentPreset || "",
				snippet: m.hits[0]?.segments.map((s) => s.text).join("") || "",
				snippets: m.hits,
				matchCount: m.total,
				bestMatch: m.hits[0] || null
			}));
			rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
			return {
				rows: rows.slice(0, limit),
				query: trimmed,
				mode: "scan"
			};
		},
		/** Remove an id from the durable archive set (reverse of archiveSession). */
		async unarchive(id) {
			if (!id) throw new Error("缺少会话 id");
			const reg = ctx.workspaceRegistry;
			const run = async () => {
				const state = reg.requireState();
				if (!state.archivedSessionIds.includes(id)) return;
				await reg.setState({
					...state,
					archivedSessionIds: state.archivedSessionIds.filter((x) => x !== id)
				});
			};
			if (typeof reg.enqueueOperation === "function") await reg.enqueueOperation(run);
			else await run();
			return { ok: true };
		},
		/** Truly delete the archived session's on-disk JSONL log directory. */
		async delete(id, configOverride) {
			if (!id) throw new Error("缺少会话 id");
			const config = resolveConfig(configOverride);
			if (!(workspaceRegistry.archivedSessionIds || []).includes(id)) throw new Error("只能删除已归档的会话（活动会话请先用内置菜单归档）");
			let stoppedLiveAgent = false;
			try {
				const agent = ctx.agents?.get ? ctx.agents.get(id) : void 0;
				if (agent) {
					agent.cancel({ kind: "disposed" });
					if (typeof agent.whenIdle === "function") await agent.whenIdle();
					stoppedLiveAgent = true;
				}
			} catch {}
			const header = (await sessionPersistence.list()).find((h) => h.id === id);
			if (header === void 0) return {
				ok: true,
				alreadyGone: true,
				stoppedLiveAgent
			};
			const loc = sessionPersistence.locate({
				cwd: header.cwd,
				id
			});
			const dir = String(loc.path).replace(/[\\/][^\\/]*$/, "");
			const target = await fs.resolve(dir);
			if (await fs.stat(target) === void 0) return {
				ok: true,
				alreadyGone: true,
				stoppedLiveAgent
			};
			const commandLine = "node -e \"require('fs').rmSync(process.argv[1],{recursive:true,force:true})\" " + JSON.stringify(dir);
			const spec = shell.resolve({
				command: commandLine,
				sandboxPolicy: {
					mode: config.deleteSandbox,
					workspaceRoot: dir
				}
			});
			const result = await shell.run(spec);
			if (result && result.exitCode !== 0) {
				const raw = result.stderr;
				const errText = typeof raw === "string" ? raw : raw ? JSON.stringify(raw) : "";
				throw new Error("删除命令失败 (exit " + result.exitCode + "): " + errText + "  [" + dir + "]");
			}
			if (await fs.stat(await fs.resolve(dir)) !== void 0) throw new Error("目录删除后仍存在（可能被占用或沙箱限制）: " + dir);
			return {
				ok: true,
				stoppedLiveAgent
			};
		},
		/** Batch delete: sequentially reuses delete() so each live-agent stop + shell removal is isolated. */
		async deleteMany(ids, configOverride) {
			if (!Array.isArray(ids) || ids.length === 0) throw new Error("ids 不能为空");
			const unique = [...new Set(ids.map((v) => String(v).trim()).filter(Boolean))];
			const results = [];
			for (const id of unique) try {
				const r = await service.delete(id, configOverride);
				results.push({
					id,
					ok: true,
					...r
				});
			} catch (e) {
				results.push({
					id,
					ok: false,
					error: e && e.message ? e.message : String(e)
				});
			}
			const succeeded = results.filter((r) => r.ok).length;
			return {
				results,
				succeeded,
				failed: results.length - succeeded,
				total: results.length
			};
		},
		/** Preview: last N user/assistant messages (read-only, no tool noise). Ensures even count starts with user for coherent dialogue. */
		async preview(id, count = 4) {
			if (!id) throw new Error("缺少会话 id");
			const n = Number.isFinite(count) ? Math.max(1, Math.min(10, count)) : 4;
			let events = [];
			try {
				events = (await sessionQuery.readSurface(id)).events || [];
			} catch {
				try {
					events = (await sessionQuery.readSession(id)).events || [];
				} catch (e) {
					throw new Error("无法读取会话: " + (e && e.message ? e.message : String(e)));
				}
			}
			const msgs = [];
			for (let i = events.length - 1; i >= 0 && msgs.length < n; i--) {
				const ev = events[i];
				if (!ev || !ev.type) continue;
				let role = "";
				let text = "";
				if (ev.type === "user/message") {
					role = "user";
					text = (ev.data?.content || []).map((b) => b && b.text || "").join(" ").trim();
				} else if (ev.type === "assistant/message") {
					role = "assistant";
					text = (ev.data?.message?.content || []).map((b) => b && b.text || "").join(" ").trim();
				} else continue;
				if (!text) continue;
				text = normalizeForDisplay(text);
				if (text.length > 200) text = text.slice(0, 200) + "…";
				msgs.push({
					role,
					text,
					time: ev.time || 0,
					type: ev.type
				});
			}
			msgs.reverse();
			return {
				messages: msgs,
				total: msgs.length
			};
		}
	};
	ctx.provide("archiveManager", service);
	const webFiber = ctx.inject(["webServer"], (webCtx) => {
		const webServer = webCtx.webServer;
		if (!webServer) return;
		const MAX_BODY_BYTES = 8192;
		const trustCheck = (req) => {
			const host = String(req.headers?.host || "");
			if (!host) return false;
			if (!/^[-a-zA-Z0-9.]+(:\d+)?$/.test(host)) return false;
			const origin = req.headers?.origin;
			if (origin !== void 0 && origin !== null && origin !== "null") try {
				if (new URL(String(origin)).host.toLowerCase() !== host.toLowerCase()) return false;
			} catch {
				return false;
			}
			else if (origin === "null") return false;
			return true;
		};
		const readBody = async (req) => {
			if (Number(req.headers?.["content-length"] || 0) > MAX_BODY_BYTES) throw new Error("body too large");
			const chunks = [];
			let total = 0;
			for await (const c of req) {
				total += c.length;
				if (total > MAX_BODY_BYTES) throw new Error("body too large");
				chunks.push(Buffer.from(c));
			}
			return Buffer.concat(chunks).toString("utf8");
		};
		webCtx.effect(() => webServer.register({
			kind: "prefix",
			path: "/archive-manager/api",
			handler: async (req, res) => {
				const url = new URL(req.url || "/", "http://localhost");
				const path = url.pathname.replace(/^\/archive-manager\/api/, "") || "/";
				const send = (code, obj) => {
					res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
					res.end(JSON.stringify(obj));
				};
				try {
					if (!trustCheck(req)) return send(403, { error: "untrusted request" });
					if (req.method === "GET" && (path === "/list" || path === "/")) return send(200, await service.list());
					if (req.method === "POST" && path === "/search") {
						const body = await readBody(req);
						const data = body ? JSON.parse(body) : {};
						return send(200, await service.search(data));
					}
					if (req.method === "POST" && path === "/unarchive") {
						const body = await readBody(req);
						const data = body ? JSON.parse(body) : {};
						return send(200, await service.unarchive(data.id || data.sessionId));
					}
					if (req.method === "POST" && path === "/delete") {
						const body = await readBody(req);
						const data = body ? JSON.parse(body) : {};
						return send(200, await service.delete(data.id || data.sessionId, data.config));
					}
					if (req.method === "POST" && path === "/deleteMany") {
						const body = await readBody(req);
						const data = body ? JSON.parse(body) : {};
						return send(200, await service.deleteMany(data.ids || [], data.config));
					}
					if (req.method === "GET" && path.startsWith("/preview")) {
						const id = url.searchParams.get("id") || url.searchParams.get("sessionId") || "";
						const n = Number(url.searchParams.get("count") || 3);
						return send(200, await service.preview(id, n));
					}
					return send(404, { error: "not found" });
				} catch (e) {
					return send(500, { error: e && e.message ? e.message : String(e) });
				}
			}
		}), "archiveManager.webServer");
	});
	ctx.effect(() => () => webFiber.dispose(), "archiveManager.webServer.cleanup");
}
//#endregion
export { apply, id, inject };
