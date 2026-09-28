/*
 * dsmon client half — hand-authored classic-script bundle for the Web
 * ModuleLoader (no build step). Registers two additive seats:
 *
 *   1) conversation.composer.dock  (id: dsmon-peak)
 *      A colored strip below the chat composer: DeepSeek 峰谷 (peak/off-peak,
 *      Beijing time) status with countdown, per-session token totals read from
 *      the durable `tokenUsage` projection, and the RECORDED session cost from
 *      the host cost ledger (/dsmon/api/cost) — priced per attempt at the
 *      window in force when that request was issued.
 *
 *   2) settings.section            (id: dsmon-monitor)
 *      “DeepSeek 监控” page: the cost ledger (today / 7d / total, per-day and
 *      per-session tables), system overview, performance overview with history
 *      sparklines, process/thread tree, top consumers and disk usage — polling
 *      the same-origin /dsmon API served by the host half.
 *
 * The host owns all billing rules: the price table, the epoch scheme, the
 * holiday calendar and the ledger. This half only renders host values, plus a
 * local mirror of the (tiny) window rule so the countdown ticks per second
 * without a request per tick.
 *
 * Only baseline modules are required (react). All markup uses
 * React.createElement; styles are injected once with a scoped id.
 */
window.__ModuleLoader__.load({
	id: "dsmon",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = require("react");

		// ------------------------------------------------------------------
		// Live window rule. The authoritative tables (peak windows, holiday
		// list, price epochs) come from the host; this is only the pure
		// function that turns them into a peak/idle verdict for one instant,
		// so the strip can tick every second without polling.
		// ------------------------------------------------------------------
		const BJ_OFFSET_MS = 8 * 3600e3;
		const DAY_MS = 86400e3;

		function bjParts(ms) {
			const d = new Date(ms + BJ_OFFSET_MS);
			const p = (n) => String(n).padStart(2, "0");
			return {
				year: d.getUTCFullYear(),
				month: d.getUTCMonth() + 1,
				day: d.getUTCDate(),
				hour: d.getUTCHours(),
				minute: d.getUTCMinutes(),
				second: d.getUTCSeconds(),
				weekday: d.getUTCDay(),
				date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
				minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
			};
		}

		function clockText(ms) {
			const p = bjParts(ms);
			const z = (n) => String(n).padStart(2, "0");
			return `${z(p.hour)}:${z(p.minute)}:${z(p.second)}`;
		}

		function toLabel(minutes) {
			const h = String(Math.floor(minutes / 60)).padStart(2, "0");
			const m = String(minutes % 60).padStart(2, "0");
			return `${h}:${m}`;
		}

		function fmtDurationMin(minutes) {
			if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return "—";
			if (minutes < 60) return `${Math.max(0, Math.round(minutes))} 分钟`;
			const h = Math.floor(minutes / 60);
			const m = Math.round(minutes % 60);
			return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`;
		}

		function epochAt(ms, epochs) {
			let found = epochs[0];
			for (const epoch of epochs) {
				if (ms >= epoch.from) found = epoch;
				else break;
			}
			return found;
		}

		/** Peak/idle verdict for one instant under the host's own tables. */
		function liveWindow(ms, pricing) {
			const at = bjParts(ms);
			const epoch = epochAt(ms, pricing.epochs);
			const weekend = at.weekday === 0 || at.weekday === 6;
			const holiday = holidaySet(pricing).has(at.date);
			const inWindow = pricing.peakWindows.some((w) => at.minutes >= w[0] && at.minutes < w[1]);
			const forcedIdle = (epoch.weekendsIdle && weekend) || (epoch.holidaysIdle && holiday);
			const peak = inWindow && !forcedIdle;
			return {
				...at,
				weekend,
				holiday,
				epoch: epoch.name,
				window: peak ? "peak" : "idle",
				multiplier: peak ? epoch.peakMultiplier : 1,
			};
		}

		const holidayCache = new WeakMap();
		function holidaySet(pricing) {
			let set = holidayCache.get(pricing);
			if (!set) {
				set = new Set(pricing.holidays || []);
				holidayCache.set(pricing, set);
			}
			return set;
		}

		/** Next instant the verdict changes (mirrors the host's candidate set). */
		function nextChange(ms, pricing) {
			const current = liveWindow(ms, pricing).window;
			const edges = new Set([0]);
			for (const w of pricing.peakWindows) {
				edges.add(w[0]);
				edges.add(w[1]);
			}
			const dayStart = Date.parse(`${bjParts(ms).date}T00:00:00+08:00`);
			const candidates = [];
			for (let d = 0; d <= 8; d += 1) {
				for (const minute of edges) {
					const at = dayStart + d * DAY_MS + minute * 60000;
					if (at > ms) candidates.push(at);
				}
			}
			candidates.sort((a, b) => a - b);
			for (const at of candidates) {
				if (liveWindow(at, pricing).window !== current) return at;
			}
			return null;
		}

		// ------------------------------------------------------------------
		// small formatting helpers
		// ------------------------------------------------------------------
		function fmtTokens(n) {
			const scaled = (v) => (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10));
			if (n < 1e3) return String(n);
			if (n < 1e6) return `${scaled(n / 1e3)}K`;
			return `${scaled(n / 1e6)}M`;
		}

		function fmtYuan(y, digits) {
			if (y === null || y === undefined || !Number.isFinite(y)) return "—";
			if (y === 0) return "¥0";
			if (!Number.isFinite(digits) && y < 0.0001) return "¥<0.0001";
			const s = Number.isFinite(digits) ? y.toFixed(digits) : y >= 1 ? y.toFixed(2) : y.toFixed(4);
			return `¥${s}`;
		}

		function fmtGB(bytes) {
			const gb = bytes / 1024 / 1024 / 1024;
			return gb >= 10 ? `${gb.toFixed(1)} GB` : `${gb.toFixed(2)} GB`;
		}

		function fmtMB(bytes) {
			const mb = bytes / 1024 / 1024;
			return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
		}

		function shortId(id) {
			if (typeof id !== "string") return "—";
			return id.length > 26 ? `${id.slice(0, 14)}…${id.slice(-8)}` : id;
		}

		function stamp(ms) {
			if (!Number.isFinite(ms)) return "—";
			const p = bjParts(ms);
			const z = (n) => String(n).padStart(2, "0");
			return `${p.date} ${z(p.hour)}:${z(p.minute)}`;
		}

		// ------------------------------------------------------------------
		// styles (one scoped style tag; inserted by the apply disposer)
		// ------------------------------------------------------------------
		const CSS_ID = "dsmon-client";
		const CSS = `
[data-plugin="dsmon"].dsmonDock,
.dsmonDock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance, 0px) * 2);max-width:var(--dsh-chat-content-width, 760px);margin:0 auto;padding:2px 16px 6px;display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;color:var(--dsw-alias-label-secondary, #6b7280);font-size:12px;line-height:18px}
.dsmonPill{display:inline-flex;align-items:center;gap:6px;padding:1px 8px 1px 6px;border-radius:999px;font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap}
.dsmonPill .dsmonDot{width:7px;height:7px;border-radius:50%;flex:none}
.dsmonPill.isIdle{color:#2f9e63;background:rgba(48,164,108,.14)}
.dsmonPill.isIdle .dsmonDot{background:#30a46c;box-shadow:0 0 0 3px rgba(48,164,108,.18)}
.dsmonPill.isPeak{color:#d6433c;background:rgba(229,72,77,.14)}
.dsmonPill.isPeak .dsmonDot{background:#e5484d;box-shadow:0 0 0 3px rgba(229,72,77,.18)}
.dsmonPill.isSoon{color:#c47f0a;background:rgba(245,165,36,.14)}
.dsmonPill.isSoon .dsmonDot{background:#f5a524;box-shadow:0 0 0 3px rgba(245,165,36,.18)}
.dsmonClock{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary, #9ca3af)}
.dsmonCost{display:inline-flex;align-items:center;gap:4px;white-space:nowrap;color:var(--dsw-alias-label-secondary, #6b7280)}
.dsmonCost b{color:var(--dsw-alias-label-primary, #111827);font-weight:600;font-variant-numeric:tabular-nums}
.dsmonTag{display:inline-block;padding:0 5px;border-radius:4px;font-size:10px;line-height:15px;background:rgba(77,107,254,.14);color:#4d6bfe}
.dsmonTag.isWarn{background:rgba(245,165,36,.18);color:#c47f0a}
.dsmonHint{color:var(--dsw-alias-label-tertiary, #9ca3af)}
.dsmonPage{box-sizing:border-box;width:100%;max-width:960px;margin:0 auto;padding:20px 8px 40px;color:var(--dsw-alias-label-primary,#18181b);font-size:13px;line-height:20px}
.dsmonPage h2{font-size:15px;font-weight:600;margin:0 0 10px}
.dsmonCard{background:var(--dsw-alias-bg-layer-1, #ffffff);border:1px solid var(--dsw-alias-border-l3, rgba(0,0,0,.08));border-radius:12px;padding:14px 16px;margin:0 0 16px}
.dsmonGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.dsmonKpi{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsmonKpiLabel{color:var(--dsw-alias-label-tertiary,#9ca3af);font-size:12px}
.dsmonKpiValue{font-size:20px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsmonKpiSub{color:var(--dsw-alias-label-tertiary,#9ca3af);font-size:11px}
.dsmonMeter{height:6px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));overflow:hidden;margin:6px 0 2px}
.dsmonMeterFill{height:100%;border-radius:999px;transition:width .5s ease}
.dsmonMeterFill.ok{background:#30a46c}.dsmonMeterFill.warn{background:#f5a524}.dsmonMeterFill.crit{background:#e5484d}
.dsmonRow{display:flex;justify-content:space-between;gap:12px;align-items:baseline;padding:1px 0}
.dsmonTableWrap{overflow:auto;max-height:340px}
table.dsmonTable{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}
.dsmonTable th{text-align:left;color:var(--dsw-alias-label-tertiary,#9ca3af);font-weight:500;padding:4px 8px 4px 0;white-space:nowrap;position:sticky;top:0}
.dsmonTable td{padding:4px 8px 4px 0;white-space:nowrap;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.05))}
.dsmonTable td.dsmonNum{text-align:right;font-variant-numeric:tabular-nums}
.dsmonName{max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsmonMono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280)}
.dsmonSpark{width:100%;height:34px;display:block;margin-top:4px}
.dsmonError{color:#e5484d;background:rgba(229,72,77,.08);border:1px solid rgba(229,72,77,.25);border-radius:10px;padding:8px 12px}
.dsmonThreadBtn{cursor:pointer;color:var(--dsw-alias-accent,#4d6bfe);background:none;border:none;padding:0;font:inherit;font-variant-numeric:tabular-nums}
.dsmonThreadBtn:hover{text-decoration:underline}
.dsmonMuted{color:var(--dsw-alias-label-tertiary,#9ca3af)}
.dsmonTier{font-size:11px;color:var(--dsw-alias-label-tertiary,#9ca3af);padding:0 4px}
.dsmonTable tr.dsmonSelf td{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.dsmonTable tr.dsmonSelf td:first-child{box-shadow:inset 3px 0 0 var(--dsw-alias-accent,#4d6bfe)}
.dsmonSplit{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}
.dsmonFootnote{margin-top:10px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,#9ca3af);word-break:break-all}
.dsmonFootnote code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
`;

		function ensureCss() {
			if (typeof document === "undefined") return null;
			const existing = document.querySelector(`style[data-plugin-css="${CSS_ID}"]`);
			if (existing) {
				if (existing.textContent !== CSS) existing.textContent = CSS;
				return existing;
			}
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsmon";
			tag.dataset.pluginCss = CSS_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
			return tag;
		}

		// ------------------------------------------------------------------
		// shared: poll one same-origin dsmon endpoint
		// ------------------------------------------------------------------
		function useDsmonEndpoint(path, intervalMs) {
			const [state, setState] = react.useState({ data: null, error: null, at: 0 });
			const [tick, setTick] = react.useState(0);
			react.useEffect(() => {
				let cancelled = false;
				let timer = 0;
				const load = async () => {
					try {
						const r = await fetch(path, { cache: "no-store" });
						if (!r.ok) throw new Error(`HTTP ${r.status}`);
						const json = await r.json();
						if (!cancelled) setState({ data: json, error: null, at: Date.now() });
					} catch (e) {
						if (!cancelled) setState((prev) => ({ data: prev.data, error: e instanceof Error ? e.message : String(e), at: prev.at }));
					}
				};
				load();
				timer = setInterval(load, intervalMs);
				return () => {
					cancelled = true;
					clearInterval(timer);
				};
			}, [path, intervalMs, tick]);
			return [state, () => setTick((n) => n + 1)];
		}

		// ------------------------------------------------------------------
		// seat 1 — composer dock strip (peak/off-peak + tokens + booked cost)
		// ------------------------------------------------------------------
		function DockStrip(props) {
			const useProjection = typeof props.useProjection === "function" ? props.useProjection : null;
			const usage = useProjection ? useProjection("tokenUsage") : undefined;
			const sessionId = typeof props.sessionId === "string" ? props.sessionId : null;
			const [now, setNow] = react.useState(() => Date.now());

			const costPath = sessionId ? `/dsmon/api/cost?sessionId=${encodeURIComponent(sessionId)}` : "/dsmon/api/cost";
			const [cost, refreshCost] = useDsmonEndpoint(costPath, 5000);

			react.useEffect(() => {
				const id = setInterval(() => setNow(Date.now()), 1000);
				return () => clearInterval(id);
			}, []);

			// Re-read the ledger as soon as the harness reports new usage, and
			// right after a window boundary, so the strip never lags a turn.
			const usageKey = usage ? `${usage.uncachedInputTokens}|${usage.outputTokens}|${usage.cacheReadTokens}|${usage.cacheWriteTokens}` : "";
			const lastUsageKey = react.useRef("");
			react.useEffect(() => {
				if (lastUsageKey.current === usageKey) return;
				lastUsageKey.current = usageKey;
				if (usageKey !== "") refreshCost();
			}, [usageKey]);

			const pricing = cost.data && cost.data.pricing ? cost.data.pricing : null;
			const live = pricing ? liveWindow(now, pricing) : null;
			const boundary = pricing ? nextChange(now, pricing) : null;

			const pillClass = !live ? "dsmonPill isSoon" : live.window === "peak" ? "dsmonPill isPeak" : "dsmonPill isIdle";
			const windowRange = pricing
				? pricing.peakWindows.map((w) => `${toLabel(w[0])}–${toLabel(w[1])}`).join("、")
				: "09:00–12:00、14:00–18:00";

			let statusText;
			if (!live) {
				statusText = "峰谷时段读取中…";
			} else if (live.window === "idle") {
				const why = live.holiday ? "法定节假日" : live.weekend ? "周末" : "非高峰时段";
				statusText = `空闲优惠时段 · 高峰半价（${why}；工作日 ${windowRange} 为高峰）`;
			} else {
				statusText = `算力高峰时段 · 原价计费（距空闲半价还有 ${fmtDurationMin((boundary - now) / 60000)}，${boundary ? stamp(boundary).slice(11) : "—"} 起）`;
			}

			const hasUsage = !!usage && (usage.uncachedInputTokens > 0 || usage.outputTokens > 0 || usage.cacheReadTokens > 0);
			const tokensIn = hasUsage ? (usage.uncachedInputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0) : 0;
			const tokensOut = hasUsage ? usage.outputTokens || 0 : 0;
			const session = cost.data && cost.data.session ? cost.data.session : null;

			const children = [];

			children.push(react.createElement("span", { className: pillClass, key: "pill" },
				react.createElement("span", { className: "dsmonDot" }),
				react.createElement("span", null, statusText)
			));

			children.push(react.createElement("span", { className: "dsmonClock", key: "clock" },
				`北京时间 ${clockText(now)}`
			));

			if (hasUsage) {
				children.push(react.createElement("span", { className: "dsmonCost", key: "tokens" },
					`Tokens ${fmtTokens(tokensIn)} 入 / ${fmtTokens(tokensOut)} 出`
				));
			}

			if (session && session.attempts > 0) {
				const model = session.byModel && session.byModel.length > 0 ? session.byModel[0].model : "—";
				children.push(react.createElement("span", { className: "dsmonCost", key: "cost" },
					react.createElement("span", { className: "dsmonTag" }, "已记账"),
					react.createElement("b", null, fmtYuan(session.totals.cny)),
					react.createElement("span", { className: "dsmonHint" },
						`（${model} · ${session.attempts} 次逐笔计费：高峰 ${fmtYuan(session.totals.peak.cny)} / 空闲 ${fmtYuan(session.totals.idle.cny)}）`
					)
				));
				if (session.unpricedModels && session.unpricedModels.length > 0) {
					children.push(react.createElement("span", { className: "dsmonCost", key: "unpriced" },
						react.createElement("span", { className: "dsmonTag isWarn" }, "未单独定价"),
						react.createElement("span", { className: "dsmonHint" },
							`${session.unpricedModels.join("、")} 暂按 ${cost.data.pricing.fallback} 价目计算`
						)
					));
				}
				if (cost.error) {
					// Stale ledger data is still shown, but never silently.
					children.push(react.createElement("span", { className: "dsmonCost", key: "stale" },
						react.createElement("span", { className: "dsmonTag isWarn" }, "台账离线"),
						react.createElement("span", { className: "dsmonHint" }, `显示上次读取结果（${cost.error}）`)
					));
				}
				const backfill = cost.data.ledger ? cost.data.ledger.backfill : null;
				if (backfill && backfill.state === "running") {
					children.push(react.createElement("span", { className: "dsmonCost", key: "backfill" },
						react.createElement("span", { className: "dsmonTag isWarn" }, "回填中"),
						react.createElement("span", { className: "dsmonHint" },
							`历史会话 ${backfill.done}/${backfill.total}，完成后金额才是全量`
						)
					));
				}
			} else if (cost.error) {
				children.push(react.createElement("span", { className: "dsmonCost", key: "err" },
					react.createElement("span", { className: "dsmonTag isWarn" }, "台账不可用"),
					react.createElement("span", { className: "dsmonHint" }, cost.error)
				));
			} else {
				children.push(react.createElement("span", { className: "dsmonHint", key: "empty" },
					"发送消息后逐笔计价并写入台账（/dsmon/api/cost）"
				));
			}

			return react.createElement("div", { className: "dsmonDock", "data-plugin": "dsmon", "data-dsmon-dock": "" }, children);
		}

		// ------------------------------------------------------------------
		// seat 2 — settings section: cost ledger + server monitor
		// ------------------------------------------------------------------
		function gaugeClass(pct) {
			if (pct === null || pct === undefined || !Number.isFinite(pct)) return "ok";
			if (pct >= 90) return "crit";
			if (pct >= 70) return "warn";
			return "ok";
		}

		function kpi(label, value, sub) {
			return react.createElement("div", { className: "dsmonKpi", key: label },
				react.createElement("span", { className: "dsmonKpiLabel" }, label),
				react.createElement("span", { className: "dsmonKpiValue" }, value),
				sub ? react.createElement("span", { className: "dsmonKpiSub" }, sub) : null
			);
		}

		function meter(label, pct, valueText) {
			const v = typeof pct === "number" && Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
			return react.createElement("div", { key: label, style: { marginTop: 8 } },
				react.createElement("div", { className: "dsmonRow" },
					react.createElement("span", null, label),
					react.createElement("span", null, valueText ?? (Number.isFinite(pct) ? `${pct}%` : "—"))
				),
				react.createElement("div", { className: "dsmonMeter" },
					react.createElement("div", { className: `dsmonMeterFill ${gaugeClass(pct)}`, style: { width: `${v}%` } })
				)
			);
		}

		function table(headers, rows, emptyText) {
			return react.createElement("div", { className: "dsmonTableWrap" },
				react.createElement("table", { className: "dsmonTable" },
					react.createElement("thead", null, react.createElement("tr", null,
						headers.map((h) => react.createElement("th", { key: h.key, className: h.num ? "dsmonNum" : undefined }, h.label))
					)),
					react.createElement("tbody", null,
						rows.length === 0
							? react.createElement("tr", null, react.createElement("td", { colSpan: headers.length }, emptyText ?? "暂无数据"))
							: rows
					)
				)
			);
		}

		/** The cost ledger card: what the host computed and recorded. */
		function CostCard({ cost, sessionId, nowMs }) {
			if (!cost) {
				return react.createElement("div", { className: "dsmonCard" },
					react.createElement("div", { className: "dsmonMuted" }, "费用台账加载中…（/dsmon/api/cost）")
				);
			}
			const ledger = cost.ledger ?? {};
			const totals = ledger.totals ?? null;
			const today = ledger.today ?? null;
			const last7 = ledger.last7d ?? null;
			const session = cost.session ?? null;
			const live = cost.pricing ? liveWindow(nowMs, cost.pricing) : null;

			const kpis = [];
			if (today) kpis.push(kpi("今日", fmtYuan(today.cny), `${today.date} · ${today.attempts} 次调用`));
			if (last7) kpis.push(kpi("近 7 日", fmtYuan(last7.cny), `${last7.attempts} 次调用`));
			if (totals) kpis.push(kpi("台账累计", fmtYuan(totals.cny), `${totals.attempts} 次调用 · ${ledger.sessions ?? 0} 个会话`));
			if (totals) kpis.push(kpi("高峰 / 空闲", `${fmtYuan(totals.peak.cny)} / ${fmtYuan(totals.idle.cny)}`, `高峰 ${totals.peak.attempts} 次 · 空闲 ${totals.idle.attempts} 次`));

			const dayRows = (ledger.byDay ?? []).slice(0, 14).map((d) => react.createElement("tr", { key: d.day },
				react.createElement("td", null, d.day),
				react.createElement("td", { className: "dsmonNum" }, String(d.attempts)),
				react.createElement("td", { className: "dsmonNum" }, fmtTokens(d.tokens.billedIn)),
				react.createElement("td", { className: "dsmonNum" }, fmtTokens(d.tokens.out)),
				react.createElement("td", { className: "dsmonNum" }, fmtYuan(d.peakCny)),
				react.createElement("td", { className: "dsmonNum" }, fmtYuan(d.idleCny)),
				react.createElement("td", { className: "dsmonNum" }, fmtYuan(d.cny))
			));

			const sessionRows = (ledger.topSessions ?? []).slice(0, 10).map((s) => react.createElement("tr", {
				key: s.sessionId,
				className: s.sessionId === sessionId ? "dsmonSelf" : "",
			},
				react.createElement("td", { className: "dsmonMono", title: s.sessionId }, shortId(s.sessionId)),
				react.createElement("td", { className: "dsmonName dsmonMuted", title: s.cwd ?? "" }, s.origin === "subagent" ? "子会话" : (s.cwd ?? "—")),
				react.createElement("td", null, stamp(s.last)),
				react.createElement("td", { className: "dsmonNum" }, String(s.attempts)),
				react.createElement("td", { className: "dsmonNum" }, fmtYuan(s.cny))
			));

			const modelRows = (session?.byModel ?? []).map((m) => react.createElement("tr", { key: m.model },
				react.createElement("td", null, m.model),
				react.createElement("td", { className: "dsmonNum" }, String(m.attempts)),
				react.createElement("td", { className: "dsmonNum" }, fmtTokens(m.tokens.billedIn)),
				react.createElement("td", { className: "dsmonNum" }, fmtTokens(m.tokens.out)),
				react.createElement("td", { className: "dsmonNum" }, fmtYuan(m.cny))
			));

			const cards = [];

			cards.push(react.createElement("div", { className: "dsmonCard", key: "c-cost-kpi" },
				react.createElement("div", { className: "dsmonRow", style: { marginBottom: 8 } },
					react.createElement("span", { className: "dsmonKpiLabel" }, "费用台账（宿主逐笔计价后落盘，非估算）"),
					react.createElement("span", { className: "dsmonMuted" },
						live ? `当前 ${live.window === "peak" ? "高峰" : "空闲"} · 方案 ${live.epoch}` : ""
					)
				),
				react.createElement("div", { className: "dsmonGrid" }, kpis)
			));

			const split = [];
			split.push(react.createElement("div", { key: "day" },
				react.createElement("div", { className: "dsmonKpiLabel", style: { marginBottom: 4 } }, "按日（北京时间，最近 14 天）"),
				table([
					{ key: "d", label: "日期" },
					{ key: "n", label: "次数", num: true },
					{ key: "in", label: "输入 tokens", num: true },
					{ key: "out", label: "输出 tokens", num: true },
					{ key: "p", label: "高峰", num: true },
					{ key: "i", label: "空闲", num: true },
					{ key: "t", label: "合计", num: true },
				], dayRows, "台账中暂无记录")
			));
			split.push(react.createElement("div", { key: "sess" },
				react.createElement("div", { className: "dsmonKpiLabel", style: { marginBottom: 4 } }, "按会话（最近 10 个，高亮为当前会话）"),
				table([
					{ key: "s", label: "会话" },
					{ key: "c", label: "工作区" },
					{ key: "l", label: "最后活动" },
					{ key: "n", label: "次数", num: true },
					{ key: "t", label: "金额", num: true },
				], sessionRows, "台账中暂无会话")
			));
			cards.push(react.createElement("div", { className: "dsmonCard", key: "c-cost-tables" },
				react.createElement("div", { className: "dsmonSplit" }, split)
			));

			if (session && session.attempts > 0) {
				cards.push(react.createElement("div", { className: "dsmonCard", key: "c-cost-session" },
					react.createElement("div", { className: "dsmonRow", style: { marginBottom: 6 } },
						react.createElement("span", { className: "dsmonKpiLabel" }, `当前会话 ${shortId(sessionId)}`),
						react.createElement("span", { className: "dsmonMuted" },
							`${session.attempts} 次调用 · 首次 ${stamp(session.first)} · 最近 ${stamp(session.last)}`
						)
					),
					react.createElement("div", { className: "dsmonGrid" },
						kpi("会话金额", fmtYuan(session.totals.cny), `高峰 ${fmtYuan(session.totals.peak.cny)} · 空闲 ${fmtYuan(session.totals.idle.cny)}`),
						kpi("计费输入", fmtTokens(session.totals.tokens.billedIn), `未命中 ${fmtTokens(session.totals.tokens.uncached + session.totals.tokens.cacheWrite)} · 命中 ${fmtTokens(session.totals.tokens.cacheRead)}`),
						kpi("输出", fmtTokens(session.totals.tokens.out), `含思考 tokens`)
					),
					modelRows.length > 0
						? react.createElement("div", { style: { marginTop: 10 } },
							react.createElement("div", { className: "dsmonKpiLabel", style: { marginBottom: 4 } }, "按模型（价目表归一后的计费档）"),
							table([
								{ key: "m", label: "计费模型" },
								{ key: "n", label: "次数", num: true },
								{ key: "i", label: "输入 tokens", num: true },
								{ key: "o", label: "输出 tokens", num: true },
								{ key: "t", label: "金额", num: true },
							], modelRows)
						)
						: null
				));
			}

			const notes = [];
			if (cost.pricing) {
				notes.push(`价目表来源：${cost.pricing.source === "override" ? `自定义 ${cost.pricing.file}` : "内置官方表"}（${cost.pricing.sourceUrl}）`);
				notes.push(`当前生效方案 ${live ? live.epoch : "—"}；高峰 ${cost.pricing.peakWindows.map((w) => `${toLabel(w[0])}–${toLabel(w[1])}`).join("、")}（工作日），周末与法定节假日全天按空闲价；共载入 ${cost.pricing.holidays.length} 个节假日。`);
				notes.push(`计价口径：每次调用按“发起时刻”判定峰谷，输入按缓存命中/未命中分档、缓存写入按未命中计、输出含思考 tokens；失败/未知路由按 ${cost.pricing.fallback} 档计并单独标注。`);
			}
			notes.push(`台账文件：${ledger.file ?? "—"}${ledger.updatedAt ? `（最近写入 ${stamp(ledger.updatedAt)}）` : ""}；按日汇总：${ledger.dailyCsv ?? "—"}；已记 ${ledger.records ?? 0} 笔。`);
			const backfill = ledger.backfill ?? null;
			if (backfill) {
				const failures = Array.isArray(backfill.failures) ? backfill.failures : [];
				if (backfill.state === "running") notes.push(`正在回填历史会话账单：${backfill.done}/${backfill.total}（逐个顺序读取，完成后“今日 / 近 7 日 / 累计”才是全量）。`);
				else if (backfill.state === "done") notes.push(`历史回填已完成：读取 ${backfill.total} 个，跳过 ${backfill.skipped ?? 0} 个未变更的日志${backfill.failed > 0 ? `，${backfill.failed} 个读取失败` : ""}。`);
				else notes.push(`历史回填异常：${backfill.error ?? backfill.state}。“今日 / 近 7 日 / 累计”可能不完整。`);
				if (backfill.source) notes.push(`回填数据源：${backfill.source === "files" ? "本地会话日志" : backfill.source === "query" ? "sessionQuery 服务" : "本地会话日志 + sessionQuery 服务"}。`);
				if (failures.length > 0) notes.push(`读取失败的会话：${failures.map((f) => `${shortId(f.id)}（${f.error}）`).join("；")}`);
			}
			if (ledger.prunedRecords > 0) notes.push(`已按保留策略清理 ${ledger.prunedRecords} 笔过期记录（保留 120 天 / 每会话 4000 笔）。`);
			if (ledger.loadError) notes.push(`台账告警：${ledger.loadError}`);
			if (ledger.unpricedModels && ledger.unpricedModels.length > 0) notes.push(`台账中存在价目表未覆盖的模型：${ledger.unpricedModels.join("、")}（已按 ${cost.pricing ? cost.pricing.fallback : "默认档"} 估算并标记，请在自定义价目表中补充）。`);

			cards.push(react.createElement("div", { className: "dsmonCard", key: "c-cost-note" },
				react.createElement("div", { className: "dsmonKpiLabel", style: { marginBottom: 4 } }, "计价与台账说明"),
				react.createElement("div", { className: "dsmonFootnote" }, notes.map((n, i) => react.createElement("div", { key: i }, n)))
			));

			return react.createElement(react.Fragment, null, cards);
		}

		function sparkline(points, stroke, domainMax) {
			if (!points || points.length < 2) {
				return react.createElement("div", { className: "dsmonMuted", style: { height: 34, paddingTop: 8 } }, "采样中…");
			}
			const w = 100;
			const h = 28;
			const max = domainMax || Math.max(...points, 1);
			const coords = points.map((p, i) => {
				const x = (i / (points.length - 1)) * w;
				const y = h - (Math.max(0, Math.min(p, max)) / max) * (h - 3) - 1;
				return `${x.toFixed(2)},${y.toFixed(2)}`;
			});
			return react.createElement("svg", {
				className: "dsmonSpark",
				viewBox: `0 0 ${w} ${h}`,
				preserveAspectRatio: "none",
			}, react.createElement("polyline", {
				points: coords.join(" "),
				fill: "none",
				stroke,
				strokeWidth: 1.5,
				strokeLinejoin: "round",
				strokeLinecap: "round",
			}));
		}

		function MonitorPage(props) {
			const sessionId = typeof props.sessionId === "string" ? props.sessionId : null;
			const [snap, refreshSnap] = useDsmonEndpoint("/dsmon/api/snapshot", 3000);
			const [cost, refreshCost] = useDsmonEndpoint(
				sessionId ? `/dsmon/api/cost?sessionId=${encodeURIComponent(sessionId)}` : "/dsmon/api/cost",
				6000
			);
			const [threadPid, setThreadPid] = react.useState(null);
			const [threads, setThreads] = react.useState(null);
			const [nowMs, setNowMs] = react.useState(() => Date.now());

			react.useEffect(() => {
				const id = setInterval(() => setNowMs(Date.now()), 1000);
				return () => clearInterval(id);
			}, []);

			react.useEffect(() => {
				if (threadPid === null || threadPid === undefined) return;
				let cancelled = false;
				let timer = 0;
				const load = async () => {
					try {
						const r = await fetch(`/dsmon/api/threads?pid=${threadPid}`, { cache: "no-store" });
						const json = await r.json();
						if (!cancelled) setThreads(json);
					} catch {
						/* keep last value */
					}
				};
				load();
				timer = setInterval(load, 4000);
				return () => {
					cancelled = true;
					clearInterval(timer);
				};
			}, [threadPid]);

			const onThread = (pid) => {
				setThreadPid(pid);
				setThreads(null);
			};

			const data = snap.data;
			const err = snap.error;
			const sys = data && data.system;
			const ov = data && data.overview;
			const service = data && data.service;
			const hist = data && data.history;

			const memPct = ov && typeof ov.memPct === "number" ? ov.memPct : null;
			const cpuPct = ov && typeof ov.cpuPct === "number" ? ov.cpuPct : null;

			const rows = [];

			rows.push(react.createElement("h2", { key: "t-cost" }, "费用台账"));
			rows.push(react.createElement(CostCard, { key: "cost", cost: cost.data, sessionId, nowMs }));

			rows.push(react.createElement("h2", { key: "t-sys" }, "系统运行概况"));
			const sysItems = [];
			if (sys) {
				sysItems.push(kpi("主机", sys.hostname, `${sys.type} ${sys.release}`));
				sysItems.push(kpi("平台", `${sys.platform} / ${sys.arch}`, `Node ${sys.node}`));
				sysItems.push(kpi("运行用户", sys.user || "—", `启动于 ${String(sys.bootedAt).slice(0, 19).replace("T", " ")}`));
				sysItems.push(kpi("系统已运行", sys.bootedAgo, `${sys.cpu.cores} 逻辑核心 · ${sys.cpu.model}`));
			} else {
				sysItems.push(kpi("系统信息", "不可用", err || ""));
			}
			rows.push(react.createElement("div", { className: "dsmonCard dsmonGrid", key: "c-sys" }, sysItems));

			if (service) {
				const svcItems = [
					kpi("dsh web 进程 (PID)", String(service.pid), service.name || ""),
					kpi("服务 CPU", service.cpuPct === null ? "—" : `${service.cpuPct}%`, "单核占用"),
					kpi("服务内存", service.ws === null ? "—" : fmtMB(service.ws), ""),
					kpi("服务线程数", service.threads === null ? "—" : String(service.threads), ""),
				];
				rows.push(react.createElement("div", { className: "dsmonCard dsmonGrid", key: "c-svc" }, svcItems));
			}

			rows.push(react.createElement("h2", { key: "t-perf" }, "性能总览"));
			const perfItems = [kpi("CPU 使用率", cpuPct === null ? "—" : `${cpuPct}%`, "处理器平均负载")];
			if (sys) perfItems.push(kpi("内存", memPct === null ? "—" : `${memPct}%`, `${fmtGB(sys.mem.used)} / ${fmtGB(sys.mem.total)}`));
			if (data && data.totals) perfItems.push(kpi("进程 / 线程", `${data.totals.processes} / ${data.totals.threads}`, `总内存占用 ${fmtGB(data.totals.workingSet)}`));
			rows.push(react.createElement("div", { className: "dsmonCard", key: "c-perf" },
				react.createElement("div", { className: "dsmonGrid" }, perfItems),
				meter("CPU", cpuPct),
				meter("内存", memPct),
				react.createElement("div", { className: "dsmonMuted", style: { marginTop: 8 } }, "近 2 分钟趋势（CPU 绿/内存 蓝，采样每 ~3 秒）"),
				react.createElement("div", null,
					react.createElement("svg", { className: "dsmonSpark", viewBox: "0 0 100 28", preserveAspectRatio: "none" },
						hist && hist.length > 1 ? react.createElement("polyline", {
							points: hist.map((h, i) => `${(i / (hist.length - 1)) * 100},${(28 - Math.max(0, Math.min(h.cpu || 0, 100)) / 100 * 25) - 1}`).join(" "),
							fill: "none", stroke: "#30a46c", strokeWidth: 1.5, strokeLinejoin: "round",
						}) : null,
						hist && hist.length > 1 ? react.createElement("polyline", {
							points: hist.map((h, i) => `${(i / (hist.length - 1)) * 100},${(28 - Math.max(0, Math.min(h.mem || 0, 100)) / 100 * 25) - 1}`).join(" "),
							fill: "none", stroke: "#4d6bfe", strokeWidth: 1.5, strokeLinejoin: "round",
						}) : null
					)
				)
			));

			rows.push(react.createElement("h2", { key: "t-proc" }, "进程与线程"));
			const procCards = [];
			if (service && service.chain && service.chain.length > 0) {
				const chainRows = service.chain.map((c, i) => react.createElement("div", { className: "dsmonRow", key: c.pid },
					react.createElement("span", null,
						`${" ".repeat(Math.max(0, service.chain.length - 1 - i))}${i === 0 ? "▲ 当前 " : "└ 父 "}`.trim(),
						react.createElement("span", { className: "dsmonMono" }, c.name)
					),
					react.createElement("span", null, `PID ${c.pid} · CPU ${c.cpuPct ?? "—"}% · 内存 ${c.ws ? fmtMB(c.ws) : "—"} · ${c.threads ?? "—"} 线程`)
				));
				procCards.push(react.createElement("div", { className: "dsmonCard", key: "c-chain" },
					react.createElement("div", { className: "dsmonKpiLabel", style: { marginBottom: 6 } }, "启动链（自 cmd/scheduled task 到 dsh web）"),
					chainRows
				));
			}

			const treeData = data && data.tree ? data.tree : [];
			const treeBody = treeData.length === 0
				? react.createElement("tr", { key: "empty" }, react.createElement("td", { colSpan: 7 }, "暂无进程采样数据"))
				: treeData.map((p) => react.createElement("tr", { key: p.pid, className: p.pid === (service && service.pid) ? "dsmonSelf" : "" },
					react.createElement("td", { className: "dsmonName" }, p.name),
					react.createElement("td", null, String(p.pid)),
					react.createElement("td", null, p.ppid === 0 ? "—" : String(p.ppid)),
					react.createElement("td", { className: "dsmonNum" }, `${p.cpuPct ?? "—"}%`),
					react.createElement("td", { className: "dsmonNum" }, p.ws ? fmtMB(p.ws) : "—"),
					react.createElement("td", { className: "dsmonNum" }, String(p.threads ?? "—")),
					react.createElement("td", { className: "dsmonNum" },
						react.createElement("button", { className: "dsmonThreadBtn", onClick: () => onThread(p.pid) }, "线程")
					)
				));
			procCards.push(react.createElement("div", { className: "dsmonCard", key: "c-tree" },
				react.createElement("div", { className: "dsmonRow", style: { marginBottom: 4 } },
					react.createElement("span", { className: "dsmonKpiLabel" }, `dsh 进程树（含子进程，共 ${treeData.length} 个；高亮为本服务）`),
					react.createElement("span", { className: "dsmonMuted" }, "CPU 为单核百分比，点击“线程”查看详情")
				),
				react.createElement("div", { className: "dsmonTableWrap" },
					react.createElement("table", { className: "dsmonTable" },
						react.createElement("thead", null, react.createElement("tr", null,
							react.createElement("th", null, "进程"),
							react.createElement("th", null, "PID"),
							react.createElement("th", null, "父 PID"),
							react.createElement("th", { className: "dsmonNum" }, "CPU"),
							react.createElement("th", { className: "dsmonNum" }, "内存"),
							react.createElement("th", { className: "dsmonNum" }, "线程数"),
							react.createElement("th", null, "详情")
						)),
						react.createElement("tbody", null, treeBody)
					)
				)
			));

			if (threadPid !== null) {
				const tdata = threads && threads.ok ? threads.threads : null;
				const threadRows = tdata && tdata.length > 0
					? tdata.map((t) => react.createElement("tr", { key: t.id },
						react.createElement("td", null, String(t.id)),
						react.createElement("td", null, String(t.state ?? "—")),
						react.createElement("td", null, String(t.priority ?? "—")),
						react.createElement("td", { className: "dsmonNum" }, `${t.cpuSec ?? 0}s`),
						react.createElement("td", null, t.start ? String(t.start).slice(11, 19) : "—")
					))
					: react.createElement("tr", { key: "empty" }, react.createElement("td", { colSpan: 5 }, tdata ? "该进程当前无可见线程记录" : "加载中…"));
				procCards.push(react.createElement("div", { className: "dsmonCard", key: "c-threads" },
					react.createElement("div", { className: "dsmonRow", style: { marginBottom: 4 } },
						react.createElement("span", { className: "dsmonKpiLabel" }, `PID ${threadPid} 的线程（最多 400 条，含 CPU 累计时间）`),
						react.createElement("button", { className: "dsmonThreadBtn", onClick: () => { setThreadPid(null); setThreads(null); } }, "关闭")
					),
					react.createElement("div", { className: "dsmonTableWrap", style: { maxHeight: 240 } },
						react.createElement("table", { className: "dsmonTable" },
							react.createElement("thead", null, react.createElement("tr", null,
								react.createElement("th", null, "线程 ID"),
								react.createElement("th", null, "状态"),
								react.createElement("th", { className: "dsmonNum" }, "优先级"),
								react.createElement("th", { className: "dsmonNum" }, "CPU 时间"),
								react.createElement("th", null, "创建时间")
							)),
							react.createElement("tbody", null, threadRows)
						)
					)
				));
			}
			rows.push(react.createElement(react.Fragment, { key: "proc-group" }, procCards));

			rows.push(react.createElement("h2", { key: "t-res" }, "资源占用细节"));
			const topData = data && data.top ? data.top : [];
			const topBody = topData.length === 0
				? react.createElement("tr", { key: "empty" }, react.createElement("td", { colSpan: 6 }, "暂无数据"))
				: topData.map((p) => react.createElement("tr", { key: p.pid, className: p.pid === (service && service.pid) ? "dsmonSelf" : "" },
					react.createElement("td", { className: "dsmonName" }, p.name),
					react.createElement("td", null, String(p.pid)),
					react.createElement("td", { className: "dsmonNum" }, `${p.cpuPct ?? "—"}%`),
					react.createElement("td", { className: "dsmonNum" }, p.ws ? fmtMB(p.ws) : "—"),
					react.createElement("td", { className: "dsmonNum" }, String(p.threads ?? "—")),
					react.createElement("td", { className: "dsmonName dsmonMono" }, p.cmd || "")
				));
			const resCards = [react.createElement("div", { className: "dsmonCard", key: "c-top" },
				react.createElement("div", { className: "dsmonRow", style: { marginBottom: 4 } },
					react.createElement("span", { className: "dsmonKpiLabel" }, "CPU / 内存占用最高的 15 个进程（高亮为本服务）"),
					react.createElement("span", { className: "dsmonMuted" }, "每 ~3 秒刷新")
				),
				react.createElement("div", { className: "dsmonTableWrap" },
					react.createElement("table", { className: "dsmonTable" },
						react.createElement("thead", null, react.createElement("tr", null,
							react.createElement("th", null, "进程"),
							react.createElement("th", null, "PID"),
							react.createElement("th", { className: "dsmonNum" }, "CPU(单核%)"),
							react.createElement("th", { className: "dsmonNum" }, "内存"),
							react.createElement("th", { className: "dsmonNum" }, "线程数"),
							react.createElement("th", null, "命令行")
						)),
						react.createElement("tbody", null, topBody)
					)
				)
			)];
			if (data && data.disks && data.disks.length > 0) {
				const diskItems = data.disks.map((d) => {
					const total = d.size || 0;
					const free = d.free || 0;
					const usedPct = total > 0 ? Math.round(((total - free) / total) * 100) : 0;
					return react.createElement("div", { key: d.drive, style: { marginTop: 8 } },
						react.createElement("div", { className: "dsmonRow" },
							react.createElement("span", null, `磁盘 ${d.drive}${d.label ? `（${d.label}）` : ""} · ${d.fs || ""}`.trim()),
							react.createElement("span", null, `已用 ${fmtGB(total - free)} / ${fmtGB(total)}`)
						),
						react.createElement("div", { className: "dsmonMeter" },
							react.createElement("div", { className: `dsmonMeterFill ${gaugeClass(usedPct)}`, style: { width: `${usedPct}%` } })
						)
					);
				});
				resCards.push(react.createElement("div", { className: "dsmonCard", key: "c-disk" },
					react.createElement("div", { className: "dsmonKpiLabel", style: { marginBottom: 6 } }, "磁盘（本地固定盘）"),
					diskItems
				));
			}
			rows.push(react.createElement(react.Fragment, { key: "res-group" }, resCards));

			if (err) {
				rows.unshift(react.createElement("div", { className: "dsmonError", key: "err" },
					`无法连接监控 API（/dsmon/api/snapshot）：${err} —— 请确认 dsmon 插件已随 dsh web 服务加载。`
				));
			}
			if (data && data.errors && data.errors.length > 0) {
				rows.push(react.createElement("div", { className: "dsmonCard", key: "warn" },
					react.createElement("div", { className: "dsmonMuted" }, "部分采样告警：" + data.errors.join("；"))
				));
			}
			rows.push(react.createElement("div", { className: "dsmonMuted", key: "foot" },
				"dsmon v0.2.1 · 系统数据来自 dsh web 宿主进程所在主机（Windows/WSL 通过 PowerShell+CIM 采样）。费用由宿主按 DeepSeek 官方峰谷价目表逐笔计价并落盘到本地台账，浏览器只展示宿主算出的金额。"
			));

			return react.createElement("div", { className: "dsmonPage", "data-plugin": "dsmon" }, rows);
		}

		// ------------------------------------------------------------------
		// plugin entry
		// ------------------------------------------------------------------
		function apply(ctx) {
			// Styles live for the plugin fiber and are removed on unload.
			ctx.effect(() => {
				const cssTag = ensureCss();
				return () => {
					if (cssTag && cssTag.parentNode) cssTag.parentNode.removeChild(cssTag);
				};
			}, "dsmon: styles");

			// Both seats are additive list slots: register with unique ids and let
			// the framework own entry lifecycle (inject waits for the declaring
			// owner and re-runs on remount; the fiber disposes registrations).
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register(
				{ name: "conversation.composer.dock", id: "dsmon-peak", order: 300, label: () => "DeepSeek 峰谷/费用" },
				DockStrip
			));
			ctx.slots.inject("settings.section", () => ctx.slots.register(
				{ name: "settings.section", id: "dsmon-monitor", order: 800, label: () => "DeepSeek 监控" },
				MonitorPage
			));
		}

		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	}
});
