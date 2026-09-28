/**
 * dsh-message-preview — web client half.
 *
 * A right-side quick-navigation rail over the chat, listing ONLY the
 * session's user-sent messages:
 *   - one blue pill per user message; heights normalize to fill the rail
 *     (blocks shrink as the count grows; the layout always fits)
 *   - an ACTIVE pill follows the reading position: while you scroll, the
 *     pill tracks the user message nearest the reading line
 *   - the rail is invisible by default and fades in on hover; the active
 *     pill stays as a subtle position indicator
 *   - auto-hidden when the session has fewer than 2 user messages
 *   - hovering a block shows a thumbnail preview card; clicking jumps the
 *     chat to that message and flashes the target row
 *
 * Data sources, fastest first: host messageIndex projection -> loaded chat
 * nodes -> background loadOlder loop (stopped as soon as a faster source
 * delivers). Mounted in conversation.input.dock, portal-rendered to body.
 */
window.__ModuleLoader__.load({
	id: "dsh-message-preview",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let react_dom = require("react-dom");
		//#region dsh-message-preview styles
		const cssTrack =
			".dshmp_rail{position:fixed;z-index:900;box-sizing:border-box;width:18px;display:flex;flex-direction:column;gap:0;padding:7px 4px;border-radius:12px;background:transparent;border:1px solid transparent}" +
			".dshmp_rail::before{content:'';position:absolute;inset:-10px -22px;border-radius:16px;pointer-events:auto}" +
			".dshmp_track{position:absolute;z-index:0;inset:0;border-radius:12px;background:linear-gradient(180deg,rgba(128,144,255,.12),rgba(90,105,190,.07));border:1px solid var(--dsw-alias-border-l1);box-shadow:0 6px 24px rgba(10,16,40,.22);opacity:0;transition:opacity .15s ease;pointer-events:none}" +
			".dshmp_block{position:relative;z-index:1;flex:none;width:100%;box-sizing:border-box;border:none;padding:0;cursor:pointer;transition:opacity .15s ease,transform .12s ease,filter .12s ease,box-shadow .12s ease;background:linear-gradient(180deg,#7B95FF,#4D6BFE);border-radius:999px;opacity:0}" +
			".dshmp_block:hover,.dshmp_block:focus-visible{transform:scaleX(1.3);filter:brightness(1.5);box-shadow:0 0 8px rgba(122,152,255,.85);outline:2px solid #fff;outline-offset:1px}" +
			".dshmp_active{position:absolute;z-index:2;left:2px;right:2px;border-radius:999px;background:linear-gradient(180deg,#FFFFFF,#B9CCFF);box-shadow:0 0 14px rgba(122,152,255,.9),0 0 4px rgba(140,168,255,.8);opacity:.75;transition:opacity .15s ease,top .15s ease,height .15s ease;pointer-events:none}" +
			".dshmp_rail:hover .dshmp_track,.dshmp_rail:hover .dshmp_block,.dshmp_rail:focus-within .dshmp_track,.dshmp_rail:focus-within .dshmp_block{opacity:1}" +
			".dshmp_rail:hover .dshmp_active,.dshmp_rail:focus-within .dshmp_active{opacity:1;box-shadow:0 0 18px rgba(122,152,255,1),0 0 6px rgba(160,185,255,.9)}" +
			".dshmp_loading{position:relative;z-index:1;flex:none;width:100%;height:4px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 45%,transparent);opacity:1;animation:dshmpPulse 1.1s ease-in-out infinite}";
		const cssCard =
			".dshmp_card{position:fixed;z-index:950;box-sizing:border-box;width:min(320px,calc(100vw - 16px));max-height:216px;background:var(--dsw-specific-tip);border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #4D6BFE;border-radius:12px;box-shadow:0 14px 40px rgba(8,12,34,.32);padding:0;pointer-events:none;display:flex;flex-direction:column;overflow:hidden}" +
			".dshmp_cardHead{flex:none;display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-specific-tip) 96%,transparent)}" +
			".dshmp_cardChip{flex:none;border-radius:999px;padding:2px 9px;font-size:11px;line-height:15px;font-weight:600;letter-spacing:.02em;color:#fff;background:linear-gradient(180deg,#7B95FF,#4D6BFE);font-variant-numeric:tabular-nums}" +
			".dshmp_cardTime{flex:1;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;text-align:right;white-space:nowrap}" +
			".dshmp_cardText{flex:1;min-height:0;overflow:hidden;display:-webkit-box;-webkit-line-clamp:8;-webkit-box-orient:vertical;color:var(--dsw-alias-label-primary);font-size:12px;line-height:19px;white-space:pre-wrap;overflow-wrap:anywhere;padding:9px 13px 11px}" +
			".dshmp_emptyCard{color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px;padding:10px 13px 11px}" +
			".dshmp_flash{animation:dshmpFlash 1.2s ease-out}" +
			"@keyframes dshmpFlash{0%,100%{background-color:transparent}35%{background-color:var(--dsw-alias-state-business-primary)}}" +
			"@keyframes dshmpPulse{0%,100%{opacity:.3}50%{opacity:.95}}" +
			"@media (prefers-reduced-motion:reduce){.dshmp_block,.dshmp_active,.dshmp_track{transition:none}.dshmp_loading{animation:none}.dshmp_flash{animation:none;background-color:var(--dsw-alias-state-business-primary)}}";
		const css = cssTrack + cssCard;
		const tagId = "dsh-message-preview/styles.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-message-preview";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		const styles = {
			rail: "dshmp_rail",
			track: "dshmp_track",
			block: "dshmp_block",
			active: "dshmp_active",
			loading: "dshmp_loading",
			card: "dshmp_card",
			cardHead: "dshmp_cardHead",
			cardChip: "dshmp_cardChip",
			cardTime: "dshmp_cardTime",
			cardText: "dshmp_cardText",
			emptyCard: "dshmp_emptyCard",
			flash: "dshmp_flash"
		};
		//#endregion
		//#region dsh-message-preview logic
		const NOOP_STORE = {
			getSnapshot: () => void 0,
			subscribe: () => () => {}
		};
		/** Extract preview text from a user message's ContentBlock list. */
		function userTextOf(content) {
			if (!Array.isArray(content)) return "";
			let out = "";
			for (const block of content) {
				if (block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string") out += block.text;
			}
			return out.trim().slice(0, 80);
		}
		/** Normalize one entry to { seq, time, text, key?, id? }. */
		function normalize(m) {
			if (m === null || typeof m !== "object") return null;
			if (typeof m.seq !== "number") return null;
			return {
				seq: m.seq,
				time: typeof m.time === "number" ? m.time : 0,
				text: typeof m.text === "string" ? m.text : "",
				...(typeof m.key === "string" ? { key: m.key } : {}),
				...(typeof m.id === "string" ? { id: m.id } : {})
			};
		}
		/** Fallback collector: enumerate user messages from the loaded chat nodes. */
		function collectFromNodes(snapshot) {
			const out = [];
			if (snapshot === void 0 || snapshot.chat === void 0) return out;
			for (const node of snapshot.chat.nodes.values()) {
				if (node === null || typeof node !== "object") continue;
				if (node.kind !== "user") continue;
				const data = node.data;
				if (data === null || typeof data !== "object") continue;
				if (typeof data.time !== "number" || !Array.isArray(data.content)) continue;
				const key = typeof node.key === "string" ? node.key : void 0;
				if (key === void 0) continue;
				out.push({ seq: node.anchorSeq, time: data.time, text: userTextOf(data.content), key });
			}
			out.sort((a, b) => a.seq - b.seq);
			return out;
		}
		/** Resolve the chat node's data-chat-anchor-key (direct key or reconstructed). */
		function anchorKeyOf(m) {
			if (typeof m.key === "string" && m.key !== "") return m.key;
			if (typeof m.id === "string" && m.id !== "") return "13:input-message" + m.id;
			return void 0;
		}
		const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
		/** Ensure the message node is in the loaded window, then scroll to its row. */
		async function jumpToMessage(sessionsService, sessionId, key) {
			const session = sessionsService.binding(sessionId)?.session;
			if (session === void 0) return false;
			let guard = 0;
			while (guard++ < 120) {
				const snapshot = session.getSnapshot();
				if (snapshot?.chat?.nodes?.get(key) !== void 0) break;
				if (snapshot?.hasMore !== true) return false;
				if (snapshot.loadingOlder === true) {
					await delay(50);
					continue;
				}
				await session.loadOlder();
			}
			const scrollport = typeof document !== "undefined" ? document.querySelector("[data-conversation-scroll]") : null;
			const row = scrollport === null ? null : scrollport.querySelector('[data-chat-anchor-key="' + CSS.escape(key) + '"]');
			if (row === null) return false;
			const reducedMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
			row.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
			row.classList.add(styles.flash);
			setTimeout(() => row.classList.remove(styles.flash), 1400);
			return true;
		}
		/** Gap formula shared by layoutBlocks and the active pill offset. */
		function gapOf(n) {
			return n > 100 ? 0 : n > 60 ? 1 : n > 24 ? 2 : 3;
		}
		/** Normalize block heights so they ALWAYS fit the rail. */
		function layoutBlocks(messages, railHeight) {
			const n = messages.length;
			if (n === 0) return [];
			const gap = gapOf(n);
			const pad = 16;
			const usable = Math.max(1, railHeight - pad - gap * (n - 1));
			const weightOf = (m) => Math.max(0.5, Math.min(3, 0.6 + m.text.length / 90));
			const weights = messages.map(weightOf);
			const total = weights.reduce((a, b) => a + b, 0);
			return weights.map((w) => (usable * w) / total);
		}
		/** Sum of block heights + gaps before `index` (excludes container padding). */
		function blockTopBefore(heights, index, gap) {
			let top = 0;
			for (let i = 0; i < index; i++) top += heights[i] + gap;
			return top;
		}
		function fmtClock(ms) {
			const d = new Date(ms);
			const pad = (n) => String(n).padStart(2, "0");
			return d.getMonth() + 1 + "/" + d.getDate() + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
		}
		/** Relative time for the preview header (刚刚 / N 分钟前 / 昨天 / 具体时间). */
		function fmtRelative(ms, t) {
			const diff = Date.now() - ms;
			if (diff < 60000) return t("justNow");
			if (diff < 3600000) return t("minutesAgo", { n: Math.max(1, Math.floor(diff / 60000)) });
			if (diff < 86400000) return t("hoursAgo", { n: Math.floor(diff / 3600000) });
			if (diff < 172800000) return t("yesterday") + " " + fmtClock(ms);
			return fmtClock(ms);
		}
		//#endregion
		//#region dsh-message-preview components
		function PreviewCard({ message, index, total, railLeft, blockTop, t }) {
			const cardLeft = Math.max(8, railLeft - 320 - 12);
			const cardTop = Math.max(8, Math.min(blockTop - 30, window.innerHeight - 218));
			return (0, react_jsx_runtime.jsx)("div", {
				className: styles.card,
				style: { left: cardLeft, top: cardTop },
				children: [
					(0, react_jsx_runtime.jsx)("div", { className: styles.cardHead, children: [
						(0, react_jsx_runtime.jsx)("span", { className: styles.cardChip, children: index + " / " + total }),
						(0, react_jsx_runtime.jsx)("span", { className: styles.cardTime, children: fmtRelative(message.time, t) })
					] }),
					message.text === ""
						? (0, react_jsx_runtime.jsx)("div", { className: styles.emptyCard, children: t("noText") })
						: (0, react_jsx_runtime.jsx)("div", { className: styles.cardText, children: message.text })
				]
			});
		}
		function MessageRail({ useProjection, sessionId, sessionsService, t }) {
			const projected = useProjection("dshMessagePreview");
			const session = sessionId === void 0 ? void 0 : sessionsService.binding(sessionId)?.session;
			const fallbackStore = session === void 0 ? NOOP_STORE : session;
			const nodeSnapshot = react.useSyncExternalStore(
				(cb) => fallbackStore.subscribe(cb),
				() => fallbackStore.getSnapshot()
			);
			let messages = [];
			let source = "nodes";
			if (Array.isArray(projected?.messages) && projected.messages.length > 0) {
				messages = projected.messages.map(normalize).filter((m) => m !== null);
				source = "projection";
			}
			if (messages.length === 0) {
				messages = collectFromNodes(nodeSnapshot);
				source = "nodes";
			}
			const [railRect, setRailRect] = react.useState(null);
			const [hover, setHover] = react.useState(null);
			const [loadedAll, setLoadedAll] = react.useState(false);
			const [activeIndex, setActiveIndex] = react.useState(-1);
			// Background full-history load: follow the runtime's authoritative
			// hasMore flag, but STOP as soon as the projection delivers.
			react.useEffect(() => {
				if (session === void 0) return;
				setLoadedAll(false);
				if (Array.isArray(projected?.messages) && projected.messages.length > 0) {
					setLoadedAll(true);
					return;
				}
				let cancelled = false;
				const run = async () => {
					let guard = 0;
					while (!cancelled && guard++ < 120) {
						if (Array.isArray(projected?.messages) && projected.messages.length > 0) {
							setLoadedAll(true);
							return;
						}
						const snap = session.getSnapshot();
						if (snap?.hasMore !== true) {
							setLoadedAll(true);
							return;
						}
						if (snap.loadingOlder === true) {
							await delay(50);
							continue;
						}
						await session.loadOlder();
					}
					if (!cancelled) setLoadedAll(true);
				};
				run().catch(() => {
					if (!cancelled) setLoadedAll(true);
				});
				return () => {
					cancelled = true;
				};
			}, [sessionId, session === void 0 ? "none" : "ready", Array.isArray(projected?.messages) && projected.messages.length > 0 ? "have" : "none"]);
			// Measure + track the reading position (active pill).
			react.useEffect(() => {
				let last = null;
				const messageIndexByKey = new Map();
				for (let i = 0; i < messages.length; i++) {
					const key = anchorKeyOf(messages[i]);
					if (key !== void 0) messageIndexByKey.set(key, i);
				}
				const measure = () => {
					const el = document.querySelector("[data-conversation-scroll]");
					const next = el === null
						? { left: Math.max(16, window.innerWidth - 30), top: 64, height: Math.min(480, Math.max(160, window.innerHeight * 0.62)) }
						: (() => {
							const r = el.getBoundingClientRect();
							const left = Math.max(8, Math.min(r.right + 10, window.innerWidth - 30));
							return { left, top: r.top + 44, height: Math.max(120, r.height - 88) };
						})();
					const same = last !== null && last.left === next.left && last.top === next.top && last.height === next.height;
					if (!same) {
						last = next;
						setRailRect(next);
					}
				};
				const updateActive = () => {
					const sp = document.querySelector("[data-conversation-scroll]");
					if (sp === null || messages.length === 0) return;
					const rect = sp.getBoundingClientRect();
					if (rect.height === 0) return;
					const line = rect.top + rect.height * 0.4;
					const rows = sp.querySelectorAll('[data-chat-anchor-key^="13:input-message"]');
					let best = -1;
					let bestDist = Infinity;
					for (const row of rows) {
						const key = row.getAttribute("data-chat-anchor-key");
						if (key === null) continue;
						const idx = messageIndexByKey.get(key) ?? -1;
						if (idx === -1) continue;
						const r = row.getBoundingClientRect();
						const dist = Math.abs(r.top + r.height / 2 - line);
						if (dist < bestDist) {
							bestDist = dist;
							best = idx;
						}
					}
					setActiveIndex(best);
				};
				measure();
				updateActive();
				window.addEventListener("resize", measure);
				const el = document.querySelector("[data-conversation-scroll]");
				let ro = null;
				if (typeof ResizeObserver !== "undefined" && el !== null) {
					ro = new ResizeObserver(measure);
					ro.observe(el);
				}
				let scrollTimer = null;
				const onScroll = () => {
					if (scrollTimer !== null) return;
					scrollTimer = setTimeout(() => {
						scrollTimer = null;
						updateActive();
					}, 60);
				};
				el === null ? void 0 : el.addEventListener("scroll", onScroll, { passive: true });
				const timer = setInterval(() => {
					measure();
					updateActive();
				}, 2000);
				return () => {
					window.removeEventListener("resize", measure);
					if (scrollTimer !== null) clearTimeout(scrollTimer);
					el === null ? void 0 : el.removeEventListener("scroll", onScroll);
					clearInterval(timer);
					if (ro !== null) ro.disconnect();
				};
			}, [sessionId, messages.length, source]);
			if (sessionId === void 0 || messages.length < 2 || railRect === null) return null;
			const gap = gapOf(messages.length);
			const showLoading = !loadedAll && source === "nodes" && messages.length > 0;
			const heights = layoutBlocks(messages, railRect.height - (showLoading ? 8 : 0));
			const activeTopPx = activeIndex >= 0 && activeIndex < heights.length
				? 7 + (showLoading ? 4 + gap : 0) + blockTopBefore(heights, activeIndex, gap)
				: -1;
			return react_dom.createPortal(
				(0, react_jsx_runtime.jsx)(react.Fragment, {
					children: [
						(0, react_jsx_runtime.jsx)("div", {
							className: styles.rail,
							style: { left: railRect.left, top: railRect.top, height: railRect.height, gap },
							role: "navigation",
							"aria-label": t("railLabel"),
							children: [
								(0, react_jsx_runtime.jsx)("div", { className: styles.track }),
								activeTopPx >= 0 && (0, react_jsx_runtime.jsx)("div", {
									className: styles.active,
									style: { top: activeTopPx, height: Math.max(heights[activeIndex], 5) }
								}),
								showLoading && (0, react_jsx_runtime.jsx)("span", { className: styles.loading, "aria-hidden": true }),
								...messages.map((m, i) => {
									const key = anchorKeyOf(m);
									const showPreview = (element) => {
										const rect = element.getBoundingClientRect();
										setHover({ message: m, index: i + 1, blockTop: rect.top + rect.height / 2, railLeft: railRect.left });
									};
									const moveFocus = (event) => {
										let next = i;
										if (event.key === "ArrowDown") next = Math.min(messages.length - 1, i + 1);
										else if (event.key === "ArrowUp") next = Math.max(0, i - 1);
										else if (event.key === "Home") next = 0;
										else if (event.key === "End") next = messages.length - 1;
										else return;
										event.preventDefault();
										const buttons = event.currentTarget.parentElement?.querySelectorAll("button." + styles.block);
										buttons?.[next]?.focus();
									};
									return (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: styles.block,
										style: { height: heights[i] },
										tabIndex: i === (activeIndex >= 0 ? activeIndex : 0) ? 0 : -1,
										title: m.text === "" ? t("noText") : m.text.slice(0, 200),
										"aria-label": t("roleUser") + ": " + (m.text.slice(0, 60) || t("noText")),
										"aria-current": activeIndex === i ? "location" : void 0,
										"aria-posinset": i + 1,
										"aria-setsize": messages.length,
										onMouseEnter: (e) => showPreview(e.currentTarget),
										onMouseLeave: () => setHover(null),
										onFocus: (e) => showPreview(e.currentTarget),
										onBlur: () => setHover(null),
										onKeyDown: moveFocus,
										onClick: () => {
											if (key === void 0) return;
											jumpToMessage(sessionsService, sessionId, key).catch(() => {});
										}
									}, m.seq);
								})
							]
						}),
						hover !== null && (0, react_jsx_runtime.jsx)(PreviewCard, {
							message: hover.message,
							index: hover.index,
							total: messages.length,
							railLeft: hover.railLeft,
							blockTop: hover.blockTop,
							t
						})
					]
				}),
				document.body
			);
		}
		//#endregion
		//#region dsh-message-preview plugin body
		const NS = "message-preview";
		const inject = ["slots", "locale", "sessions"];
		const zh = {
			"railLabel": "消息导航",
			"roleUser": "用户",
			"noText": "（无文本内容）",
			"justNow": "刚刚",
			"minutesAgo": "{n} 分钟前",
			"hoursAgo": "{n} 小时前",
			"yesterday": "昨天"
		};
		const en = {
			"railLabel": "Message navigation",
			"roleUser": "User",
			"noText": "(no text)",
			"justNow": "just now",
			"minutesAgo": "{n}m ago",
			"hoursAgo": "{n}h ago",
			"yesterday": "Yesterday"
		};
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "message-preview: dictionaries");
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "message-preview",
				order: 40,
				locale: NS,
				inject: () => ({ sessionsService: ctx.sessions })
			}, MessageRail));
		}
		//#endregion
		exports.MessageRail = MessageRail;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
