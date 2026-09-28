/**
 * dsmon host half.
 *
 * Two jobs:
 *
 *  1. The `/dsmon` HTTP API on the Harness web server (`webServer` service):
 *     one JSON snapshot carrying the system overview, CPU/memory gauges with a
 *     short history, the dsh process tree with per-process CPU/memory/threads,
 *     top consumers, disk usage, plus an on-demand thread listing endpoint. All
 *     sampling runs host-side (Node built-ins + PowerShell/CIM on Windows), so
 *     the browser never needs extra privileges.
 *
 *  2. The cost ledger. Every provider-reported token attempt in every durable
 *     session is priced AT ITS OWN EVENT CLOCK against the official DeepSeek
 *     peak/valley (峰谷) table, accumulated per session and per day, and
 *     persisted to `$DSH_HOME/logs/dsmon-cost-ledger.json`. `/dsmon/api/cost`
 *     serves it; the browser half only renders what this half computed, so no
 *     billing rule is duplicated in the client.
 *
 * The row is a dual-face loader entry: the browser half (lib/client.js) renders
 * the composer strip and the monitor page and polls this API.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

/** Cordis plugin name (informational; the row already carries it). */
export const name = 'dsmon'
/** Hard dependency: the web server route registry (dsh-host-webserver). */
export const inject = ['webServer']

const POLL_GAP_MS = 2200 // recompute host metrics at most this often
const CPU_SAMPLE_GAP_MS = 700 // dual-sample window for per-process CPU rate
const HISTORY_LEN = 120

// ===========================================================================
// Billing model — DeepSeek official peak/valley (峰谷) price table
//
// Source: https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
//         2026-09 补充说明（调休周末与法定节假日全天按空闲计费）
//
//  * 单价单位：元 / 百万 tokens。空闲时段单价 = 高峰时段单价 ÷ 2。
//  * 高峰时段：北京时间周一至周五（不含中国法定节假日）09:00-12:00、14:00-18:00。
//    其余时段为空闲，含周末、调休上班的周末，以及法定节假日全天。
//  * 计费口径：缓存命中输入按 hit，缓存未命中输入按 miss（缓存写入按未命中计），
//    输出按 out；reasoning 已包含在 outputTokens 内，不重复计费。
//  * 官方多次调价，故按「epoch」分档；每条 epoch 覆盖自其 from 起、下一条 from
//    之前发生的所有调用。
//  * 用户可在 $DSH_HOME/dsmon-prices.json 覆盖本表（见 README「自定义价目表」），
//    改完即时生效，无需重启、无需改代码。
// ===========================================================================

/** Beijing is UTC+8 all year (no DST). */
const BJ_OFFSET_MS = 8 * 3600e3
const DAY_MS = 86400e3

/** 元 / 百万 tokens —— 各 epoch 的「空闲时段」单价；高峰 = × peakMultiplier。 */
const BUILTIN_EPOCHS = [
  {
    from: '2026-08-17T00:00:00+08:00',
    name: 'v4-0817',
    weekendsIdle: false,
    holidaysIdle: false,
    peakMultiplier: 2,
    models: {
      'deepseek-flash': { hit: 0.05, miss: 1.5, out: 4.5 },
      'deepseek-v4-pro': { hit: 0.15, miss: 4.5, out: 13.5 },
    },
  },
  {
    from: '2026-08-23T00:00:00+08:00',
    name: 'v4-0823-weekends-idle',
    weekendsIdle: true,
    holidaysIdle: false,
    peakMultiplier: 2,
    models: {
      'deepseek-flash': { hit: 0.05, miss: 1.5, out: 4.5 },
      'deepseek-v4-pro': { hit: 0.15, miss: 4.5, out: 13.5 },
    },
  },
  {
    from: '2026-09-10T12:00:00+08:00',
    name: 'peak-valley-0910',
    weekendsIdle: true,
    holidaysIdle: true,
    peakMultiplier: 2,
    models: {
      'deepseek-flash': { hit: 0.02, miss: 1, out: 4 },
      'deepseek-v4-pro': { hit: 0.15, miss: 4.5, out: 13.5 },
    },
  },
]

/**
 * 官方模型名 → 价目表条目。旧名 `deepseek-v4-flash` 与
 * `deepseek-v4-flash-vision-exp` 仍可调用，但由 DeepSeek-V4.1-Flash 提供服务
 * 并按 Flash 档计费，故归一到 `deepseek-flash`。
 */
const BUILTIN_ROUTES = {
  'deepseek-flash': 'deepseek-flash',
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-v4-pro': 'deepseek-v4-pro',
}
const BUILTIN_FALLBACK = 'deepseek-flash'

/** 高峰窗口（北京时间当日分钟数，左闭右开）。 */
const BUILTIN_PEAK_WINDOWS = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
]

/** 国办发明电〔2025〕7 号《关于2026年部分节假日安排的通知》的放假区间。 */
const BUILTIN_HOLIDAY_RANGES = [
  ['2026-01-01', '2026-01-03'],
  ['2026-02-15', '2026-02-23'],
  ['2026-04-04', '2026-04-06'],
  ['2026-05-01', '2026-05-05'],
  ['2026-06-19', '2026-06-21'],
  ['2026-09-25', '2026-09-27'],
  ['2026-10-01', '2026-10-07'],
]

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return path.join(os.homedir(), '.dsh')
}
function logsDir() {
  return path.join(dshHome(), 'logs')
}
function priceFilePath() {
  return path.join(dshHome(), 'dsmon-prices.json')
}
function ledgerFilePath() {
  return path.join(logsDir(), 'dsmon-cost-ledger.json')
}
function dailyCsvPath() {
  return path.join(logsDir(), 'dsmon-cost-daily.csv')
}

/** Expand `[from, to]` date ranges into a Set of `YYYY-MM-DD`. */
function expandHolidays(ranges) {
  const out = new Set()
  if (!Array.isArray(ranges)) return out
  for (const item of ranges) {
    const pair = Array.isArray(item) ? item : [item, item]
    const from = Date.parse(`${pair[0]}T00:00:00+08:00`)
    const to = Date.parse(`${pair[1]}T00:00:00+08:00`)
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue
    for (let ms = from; ms <= to; ms += DAY_MS) out.add(bjDateKey(ms))
  }
  return out
}

/** Normalize one epoch's model entry to `{hit, miss, out}` idle rates. */
function normalizeModelEntry(raw) {
  if (!raw || typeof raw !== 'object') return null
  const src = raw.idle && typeof raw.idle === 'object' ? raw.idle : raw
  const hit = Number(src.hit)
  const miss = Number(src.miss)
  const out = Number(src.out)
  if (!Number.isFinite(hit) || !Number.isFinite(miss) || !Number.isFinite(out)) return null
  return { hit, miss, out }
}

function normalizePricing(raw, source) {
  const epochs = []
  const list = Array.isArray(raw?.epochs) && raw.epochs.length > 0 ? raw.epochs : BUILTIN_EPOCHS
  for (const epoch of list) {
    const from = typeof epoch?.from === 'number' ? epoch.from : Date.parse(String(epoch?.from))
    if (!Number.isFinite(from)) continue
    const models = {}
    for (const [key, value] of Object.entries(epoch.models ?? {})) {
      const normalized = normalizeModelEntry(value)
      if (normalized) models[key] = normalized
    }
    if (Object.keys(models).length === 0) continue
    const multiplier = Number(epoch.peakMultiplier)
    epochs.push({
      from,
      name: typeof epoch.name === 'string' ? epoch.name : new Date(from).toISOString(),
      weekendsIdle: epoch.weekendsIdle !== false,
      holidaysIdle: epoch.holidaysIdle !== false,
      peakMultiplier: Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 2,
      models,
    })
  }
  epochs.sort((a, b) => a.from - b.from)
  const windows = Array.isArray(raw?.peakWindows)
    ? raw.peakWindows
        .filter((w) => Array.isArray(w) && w.length === 2 && Number.isFinite(Number(w[0])) && Number.isFinite(Number(w[1])))
        .map((w) => [Number(w[0]), Number(w[1])])
    : BUILTIN_PEAK_WINDOWS
  const holidayRanges = Object.hasOwn(raw ?? {}, 'holidays') ? raw.holidays : BUILTIN_HOLIDAY_RANGES
  return {
    source,
    file: priceFilePath(),
    sourceUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
    note: typeof raw?.note === 'string' ? raw.note : '',
    epochs,
    routes: { ...BUILTIN_ROUTES, ...(raw?.routes ?? {}) },
    fallback: typeof raw?.fallback === 'string' ? raw.fallback : BUILTIN_FALLBACK,
    peakWindows: windows.length > 0 ? windows : BUILTIN_PEAK_WINDOWS,
    holidays: expandHolidays(holidayRanges),
  }
}

function bjParts(ms) {
  const d = new Date(ms + BJ_OFFSET_MS)
  const p = (n) => String(n).padStart(2, '0')
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: d.getUTCDay(), // 0 = Sunday
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  }
}
function bjDateKey(ms) {
  return bjParts(ms).date
}
function bjClock(ms) {
  const p = bjParts(ms)
  const z = (n) => String(n).padStart(2, '0')
  return `${p.date} ${z(p.hour)}:${z(p.minute)}`
}
function bjDayLabel(ms) {
  return bjParts(ms).date
}

/** The epoch in force at `ms`. */
function epochFor(ms, pricing) {
  let found = pricing.epochs[0]
  for (const epoch of pricing.epochs) {
    if (ms >= epoch.from) found = epoch
    else break
  }
  return found
}

/**
 * The billing window in force at one exact instant.
 * @returns peak/idle plus the calendar facts that decided it.
 */
function windowAt(ms, pricing) {
  const epoch = epochFor(ms, pricing)
  const at = bjParts(ms)
  const weekend = at.weekday === 0 || at.weekday === 6
  const holiday = pricing.holidays.has(at.date)
  const inWindow = pricing.peakWindows.some(([start, end]) => at.minutes >= start && at.minutes < end)
  const forcedIdle = (epoch.weekendsIdle && weekend) || (epoch.holidaysIdle && holiday)
  const peak = inWindow && !forcedIdle
  return {
    epoch,
    date: at.date,
    minutes: at.minutes,
    weekend,
    holiday,
    peak,
    window: peak ? 'peak' : 'idle',
    multiplier: peak ? epoch.peakMultiplier : 1,
  }
}

function toClockLabel(minutes) {
  const h = String(Math.floor(minutes / 60)).padStart(2, '0')
  const m = String(minutes % 60).padStart(2, '0')
  return `${h}:${m}`
}

/**
 * The next instant the billing window changes, plus a human label. Candidate
 * boundaries are the peak-window edges and every Beijing midnight (the only
 * instants a weekend/holiday verdict can change), searched eight days ahead.
 */
function nextWindowChange(nowMs, pricing) {
  const current = windowAt(nowMs, pricing)
  const start = bjParts(nowMs)
  const dayStart = Date.parse(`${start.date}T00:00:00+08:00`)
  const edges = new Set([0])
  for (const [s, e] of pricing.peakWindows) {
    edges.add(s)
    edges.add(e)
  }
  const candidates = []
  for (let d = 0; d <= 8; d += 1) {
    for (const minute of edges) {
      const at = dayStart + d * DAY_MS + minute * 60000
      if (at > nowMs) candidates.push(at)
    }
  }
  candidates.sort((a, b) => a - b)
  for (const at of candidates) {
    const w = windowAt(at, pricing)
    if (w.window !== current.window) {
      return {
        kind: current.window,
        nextKind: w.window,
        nextAt: at,
        nextAtLabel: bjClock(at),
        nextInMin: Math.max(0, Math.round((at - nowMs) / 60000)),
      }
    }
  }
  return { kind: current.window, nextKind: current.window, nextAt: null, nextAtLabel: '—', nextInMin: null }
}

/** Full live window report for the browser strip. */
function windowReport(nowMs, pricing) {
  const current = windowAt(nowMs, pricing)
  const next = nextWindowChange(nowMs, pricing)
  const at = bjParts(nowMs)
  return {
    now: nowMs,
    date: current.date,
    beijing: `${current.date} ${toClockLabel(current.minutes)}`,
    clock: `${String(at.hour).padStart(2, '0')}:${String(at.minute).padStart(2, '0')}:${String(at.second).padStart(2, '0')}`,
    minutes: current.minutes,
    window: current.window,
    multiplier: current.multiplier,
    weekend: current.weekend,
    holiday: current.holiday,
    epoch: current.epoch.name,
    peakWindows: pricing.peakWindows,
    nextKind: next.nextKind,
    nextAt: next.nextAt,
    nextAtLabel: next.nextAtLabel,
    nextInMin: next.nextInMin,
  }
}

/** Idle rate for one routed model at `ms`, with the alias actually applied. */
function rateFor(model, ms, pricing) {
  const epoch = epochFor(ms, pricing)
  const canonical = typeof model === 'string' && Object.hasOwn(pricing.routes, model) ? pricing.routes[model] : null
  const entry = canonical ? epoch.models[canonical] : null
  if (entry) return { epoch, pricedAs: canonical, rate: entry, alias: canonical !== model, unknownModel: false }
  const fallback = epoch.models[pricing.fallback] ?? Object.values(epoch.models)[0]
  return { epoch, pricedAs: pricing.fallback, rate: fallback, alias: true, unknownModel: true }
}

/** CNY for one attempt: uncached+write at miss, cache read at hit, output at out. */
function priceAttempt(record, pricing) {
  const lookup = rateFor(record.model, record.time, pricing)
  const window = windowAt(record.time, pricing)
  const miss = record.uncached + record.write
  const raw = (miss * lookup.rate.miss + record.read * lookup.rate.hit + record.out * lookup.rate.out) / 1e6
  return {
    pricedAs: lookup.pricedAs,
    unknownModel: lookup.unknownModel,
    epoch: lookup.epoch.name,
    window: window.window,
    multiplier: window.multiplier,
    rate: lookup.rate,
    cnyRaw: raw,
    cny: raw * window.multiplier,
  }
}

// ===========================================================================
// Durable-log fold: one record per billable attempt
// ===========================================================================

/** Bounded search for the last usage frame embedded in an assistant stream. */
function streamUsage(stream) {
  let found
  const seen = new Set()
  const walk = (value, depth) => {
    if (depth > 6 || value === null || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    if (value.type === 'usage' && value.usage && typeof value.usage.inputTokens === 'number') found = value.usage
    if (Array.isArray(value)) {
      for (const child of value) walk(child, depth + 1)
      return
    }
    for (const child of Object.values(value)) walk(child, depth + 1)
  }
  walk(stream, 0)
  return found
}

/**
 * The usage one durable event reports, if any. Assistant settlements embed the
 * sample under `data.usage` or inside their stream; other carriers (compaction
 * summaries, and any future billable event) report `data.usage` directly.
 */
function usageOf(event) {
  const data = event?.data
  if (!data || typeof data !== 'object') return undefined
  if (data.usage && typeof data.usage.inputTokens === 'number') return data.usage
  if (event.type === 'assistant/message' || event.type === 'assistant/attempt') return streamUsage(data.stream)
  return undefined
}

function bucketsOf(usage) {
  return {
    uncached: usage.inputTokens ?? 0,
    out: usage.outputTokens ?? 0,
    read: usage.cacheReadTokens ?? 0,
    write: usage.cacheWriteTokens ?? 0,
  }
}

/**
 * Fold one event into a session's cost state.
 *
 * Attempt identity mirrors the host `tokenUsage` projection so the ledger and
 * the harness never disagree: a later sample for the same (turn, step) REPLACES
 * the previous one, and `llm/retry-started` closes that slot so a retry is a
 * second charge. Non-assistant carriers key off their own event seq.
 */
function foldEvent(state, event) {
  if (!event || typeof event.seq !== 'number') return
  if (event.type === 'request/header') {
    const config = event.data?.header?.config
    if (config?.provider && config?.model) state.route = { provider: config.provider, model: config.model }
    state.consumed = Math.max(state.consumed, event.seq + 1)
    return
  }
  // A step's request begins at `step/start`; a retry re-issues it at
  // `llm/retry-started`. The provider prices the request when it arrives, so the
  // attempt is billed by that instant, not by the later settlement.
  if (event.type === 'step/start' || event.type === 'llm/retry-started') {
    if (typeof event.data?.turn === 'number' && typeof event.data?.step === 'number') {
      state.request = { turn: event.data.turn, step: event.data.step, time: event.time }
    }
    if (event.type === 'llm/retry-started') {
      const slot = state.slot
      if (slot && slot.turn === event.data?.turn && slot.step === event.data?.step) state.slot = null
    }
    state.consumed = Math.max(state.consumed, event.seq + 1)
    return
  }
  const usage = usageOf(event)
  if (!usage) {
    state.consumed = Math.max(state.consumed, event.seq + 1)
    return
  }
  const data = event.data
  const isAssistant = event.type === 'assistant/message' || event.type === 'assistant/attempt'
  let key
  let start = event.time
  if (isAssistant) {
    const turn = data.turn
    const step = data.step
    const slot = state.slot
    if (slot && slot.turn === turn && slot.step === step) {
      key = slot.key
      start = slot.start
    } else {
      const request = state.request
      start = request && request.turn === turn && request.step === step ? request.time : event.time
      key = `a:${turn}:${step}:${event.seq}`
      state.slot = { turn, step, key, start }
    }
  } else {
    key = `e:${event.type}:${event.seq}`
  }
  const source = data.message?.source
  const model = source?.provider && source?.model ? source.model : state.route?.model ?? null
  const provider = source?.provider && source?.model ? source.provider : state.route?.provider ?? null
  state.records[key] = {
    seq: event.seq,
    time: start,
    settled: event.time,
    type: event.type,
    turn: typeof data.turn === 'number' ? data.turn : null,
    step: typeof data.step === 'number' ? data.step : null,
    provider,
    model,
    ...bucketsOf(usage),
  }
  state.consumed = Math.max(state.consumed, event.seq + 1)
}

/** Fold a batch of already-ordered events into a session's cost state. */
export function foldEvents(state, events) {
  for (const event of events) foldEvent(state, event)
  return state
}

/** Add a fresh, empty fold state for one session. */
function newSessionState(session) {
  const inherited = Number(session?.inheritedEventCount ?? 0)
  const header = session?.header ?? {}
  return {
    consumed: Number.isFinite(inherited) ? inherited : 0,
    records: {},
    route: null,
    slot: null,
    request: null,
    cwd: typeof header.cwd === 'string' ? header.cwd : null,
    parent: typeof header.parentSession === 'string' ? header.parentSession : null,
    origin: typeof header.origin === 'string' ? header.origin : null,
    updatedAt: null,
  }
}

// ===========================================================================
// Aggregation
// ===========================================================================

function emptyTokens() {
  return { uncached: 0, cacheRead: 0, cacheWrite: 0, out: 0, billedIn: 0 }
}

function addTokens(target, record) {
  target.uncached += record.uncached
  target.cacheRead += record.read
  target.cacheWrite += record.write
  target.out += record.out
  target.billedIn += record.uncached + record.read + record.write
}

/**
 * Aggregate priced records. `priced` entries carry `cny`, `window`, `pricedAs`
 * and the raw token buckets.
 */
function aggregatePriced(priced) {
  const totals = { cny: 0, attempts: 0, tokens: emptyTokens(), peak: { cny: 0, attempts: 0 }, idle: { cny: 0, attempts: 0 } }
  const byDay = new Map()
  const byModel = new Map()
  const unpricedModels = new Set()
  let first = null
  let last = null
  for (const rec of priced) {
    totals.cny += rec.cny
    totals.attempts += 1
    addTokens(totals.tokens, rec)
    const bucket = rec.window === 'peak' ? totals.peak : totals.idle
    bucket.cny += rec.cny
    bucket.attempts += 1
    if (rec.unknownModel && rec.model) unpricedModels.add(rec.model)
    if (first === null || rec.time < first) first = rec.time
    if (last === null || rec.time > last) last = rec.time
    const day = bjDayLabel(rec.time)
    const dayBucket = byDay.get(day) ?? { day, cny: 0, attempts: 0, tokens: emptyTokens(), peakCny: 0, idleCny: 0 }
    dayBucket.cny += rec.cny
    dayBucket.attempts += 1
    addTokens(dayBucket.tokens, rec)
    if (rec.window === 'peak') dayBucket.peakCny += rec.cny
    else dayBucket.idleCny += rec.cny
    byDay.set(day, dayBucket)
    const modelKey = rec.pricedAs ?? rec.model ?? '(未知)'
    const modelBucket = byModel.get(modelKey) ?? { model: modelKey, cny: 0, attempts: 0, tokens: emptyTokens(), unbilled: false }
    modelBucket.cny += rec.cny
    modelBucket.attempts += 1
    addTokens(modelBucket.tokens, rec)
    if (rec.unknownModel) modelBucket.unbilled = true
    byModel.set(modelKey, modelBucket)
  }
  return {
    totals,
    first,
    last,
    byDay: [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1)),
    byModel: [...byModel.values()].sort((a, b) => b.cny - a.cny),
    unpricedModels: [...unpricedModels],
  }
}

// ===========================================================================
// Cost ledger
// ===========================================================================

const LEDGER_VERSION = 1
const MAX_RECORDS_PER_SESSION = 4000
const MAX_SESSIONS = 200
const MAX_RECORD_AGE_DAYS = 120
const SAVE_DEBOUNCE_MS = 2000
const SAVE_INTERVAL_MS = 60000
const PRICE_CACHE_MS = 5000
/**
 * Historical backfill bounds. Persisted logs are read once per host process,
 * newest file first, strictly sequentially and with a yield between sessions, so
 * "today / 7 days / total" is complete without spiking the event loop. The cap
 * only exists to bound a pathological corpus — long-lived sessions are grouped
 * by last-written file, and a session whose log has not changed since it was
 * last folded is skipped outright, so a repeat pass costs almost nothing.
 */
const BACKFILL_MAX_SESSIONS = 400
const BACKFILL_GAP_MS = 150
const BACKFILL_MAX_FAILURES = 12
/**
 * Stored session-log generations, newest first. dsh names the current generation
 * `session.v<N>.jsonl.zstd` and keeps the previous generation's file in place
 * when it migrates (v2 -> v3, and v3 -> v4 from dsh 0.1.7), so every generation
 * on disk is a readable source — preference simply follows the version.
 */
const SESSION_LOG_FILES = Object.freeze({
  'session.v4.jsonl.zstd': 'v4',
  'session.v3.jsonl.zstd': 'v3',
  'session.jsonl.zstd': 'legacy',
})
const SESSION_LOG_KEYS = Object.freeze(['v4', 'v3', 'legacy'])
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/**
 * Index every stored session log by session id: `$DSH_HOME/sessions/<workspace>/
 * <sessionId>/<file>`. Returns id -> { v4, v3, legacy } with the newest mtime per
 * generation, so the backfill can order by recency and skip unchanged logs.
 */
function sessionFileIndex() {
  const map = new Map()
  const root = path.join(dshHome(), 'sessions')
  let workspaces = []
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return map
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    const workspaceDir = path.join(root, workspace.name)
    let sessions = []
    try {
      sessions = fs.readdirSync(workspaceDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      let entry = map.get(session.name)
      for (const [name, key] of Object.entries(SESSION_LOG_FILES)) {
        const file = path.join(workspaceDir, session.name, name)
        let stat = null
        try {
          stat = fs.statSync(file)
        } catch {
          continue
        }
        if (!stat.isFile()) continue
        if (!entry) entry = {}
        if (!entry[key] || stat.mtimeMs > entry[key].mtimeMs) {
          entry[key] = { file, mtimeMs: stat.mtimeMs, size: stat.size }
        }
      }
      if (entry) map.set(session.name, entry)
    }
  }
  return map
}

/** Newest write time across the stored files of one indexed session. */
function newestMtime(entry) {
  let mtime = 0
  for (const key of SESSION_LOG_KEYS) {
    if (entry?.[key]?.mtimeMs > mtime) mtime = entry[key].mtimeMs
  }
  return mtime
}

/** Prefer the newest generation; older files only cover pre-migration history. */
function preferredFile(entry) {
  for (const key of SESSION_LOG_KEYS) {
    if (entry?.[key]?.file) return entry[key].file
  }
  return null
}

/**
 * Decode one stored session log to `{ header, events, cut }`.
 *
 * The file is a stream of concatenated zstd frames and `zstdDecompressSync`
 * silently stops after the first one, so the frame magics are indexed first:
 * a single-frame log decodes in one call, anything else decodes frame by frame.
 * A torn trailing frame (a log read mid-append) is dropped rather than fatal.
 *
 * `cut` is the fork boundary: a child's stored log opens with its parent's
 * events, and the last `session/end-seed` marker ends that inherited prefix (a
 * resumed session has no parent, so it keeps its whole log and is not double
 * counted against a parent that does not exist).
 */
function readSessionLogFile(file) {
  const raw = fs.readFileSync(file)
  const starts = []
  for (let i = 0; i + 4 <= raw.length; i += 1) {
    if (raw[i] === ZSTD_MAGIC[0] && raw[i + 1] === ZSTD_MAGIC[1] && raw[i + 2] === ZSTD_MAGIC[2] && raw[i + 3] === ZSTD_MAGIC[3]) {
      starts.push(i)
    }
  }
  let text = ''
  if (starts.length <= 1) {
    try {
      text = zlib.zstdDecompressSync(raw).toString('utf8')
    } catch {
      text = ''
    }
  } else {
    const parts = []
    for (let i = 0; i < starts.length; i += 1) {
      const slice = raw.subarray(starts[i], i + 1 < starts.length ? starts[i + 1] : raw.length)
      try {
        parts.push(zlib.zstdDecompressSync(slice).toString('utf8'))
      } catch {
        /* a partial trailing frame is normal for a log written mid-append */
      }
    }
    text = parts.join('')
  }
  if (text === '') return null
  const rows = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      /* a torn final line is ignorable */
    }
  }
  const header = rows[0] && rows[0].type === 'session' ? rows[0] : null
  const events = rows.filter((row) => typeof row.seq === 'number').sort((a, b) => a.seq - b.seq)
  let cut = 0
  if (header && typeof header.parentSession === 'string') {
    let last = -1
    for (const event of events) {
      if (event.type === 'session/end-seed' && event.seq > last) last = event.seq
    }
    cut = last + 1
  }
  return { header, events, cut }
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Read one optional service without letting a missing name break the plugin. */
function optionalService(ctx, name) {
  try {
    if (typeof ctx.get !== 'function') return null
    return ctx.get(name) ?? null
  } catch {
    return null
  }
}

class CostLedger {
  constructor() {
    this.sessions = new Map()
    this.pricing = normalizePricing(null, 'builtin')
    this.loadedAt = 0
    this.loadError = null
    this.priceMtime = 0
    this.priceCheckedAt = 0
    this.dirty = false
    this.lastSavedAt = null
    this.saveTimer = null
    this.interval = null
    this.prunedRecords = 0
    this.backfill = { state: 'idle', done: 0, total: 0, failed: 0, startedAt: null, finishedAt: null, error: null }
    this.load()
  }

  // --- pricing (re-read on change so a price fix needs no restart) --------
  refreshPricing(force = false) {
    const now = Date.now()
    if (!force && now - this.priceCheckedAt < PRICE_CACHE_MS) return this.pricing
    this.priceCheckedAt = now
    const file = priceFilePath()
    let mtime = 0
    try {
      mtime = fs.statSync(file).mtimeMs
    } catch {
      mtime = 0
    }
    if (mtime === 0) {
      if (this.pricing.source !== 'builtin') this.pricing = normalizePricing(null, 'builtin')
      this.priceMtime = 0
      return this.pricing
    }
    if (!force && mtime === this.priceMtime) return this.pricing
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      this.pricing = normalizePricing(raw, 'override')
      this.priceMtime = mtime
    } catch (e) {
      this.loadError = `价目表 ${file} 解析失败：${e instanceof Error ? e.message : String(e)}`
    }
    return this.pricing
  }

  // --- persistence --------------------------------------------------------
  load() {
    const file = ledgerFilePath()
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      const sessions = raw?.sessions && typeof raw.sessions === 'object' ? raw.sessions : {}
      for (const [id, value] of Object.entries(sessions)) {
        if (!value || typeof value !== 'object') continue
        this.sessions.set(id, {
          consumed: Number.isFinite(value.consumed) ? value.consumed : 0,
          records: value.records && typeof value.records === 'object' ? value.records : {},
          route: value.route ?? null,
          slot: value.slot ?? null,
          request: value.request ?? null,
          cwd: value.cwd ?? null,
          parent: value.parent ?? null,
          origin: value.origin ?? null,
          updatedAt: value.updatedAt ?? null,
        })
      }
      this.lastSavedAt = Number.isFinite(raw?.updatedAt) ? raw.updatedAt : null
    } catch (e) {
      if (e && e.code !== 'ENOENT') this.loadError = `台账 ${file} 读取失败：${e.message}`
      this.sessions = new Map()
    }
    this.loadedAt = Date.now()
  }

  stateFor(sessionId) {
    let state = this.sessions.get(sessionId)
    if (!state) {
      state = { consumed: 0, records: {}, route: null, slot: null, request: null, cwd: null, parent: null, origin: null, updatedAt: null }
      this.sessions.set(sessionId, state)
    }
    return state
  }

  markDirty() {
    this.dirty = true
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.save()
    }, SAVE_DEBOUNCE_MS)
    if (typeof this.saveTimer.unref === 'function') this.saveTimer.unref()
  }

  /** Prune old records so the ledger stays bounded. */
  prune(now) {
    const cutoff = now - MAX_RECORD_AGE_DAYS * DAY_MS
    let removed = 0
    for (const state of this.sessions.values()) {
      for (const [key, record] of Object.entries(state.records)) {
        if (record.time < cutoff) {
          delete state.records[key]
          removed += 1
        }
      }
      const keys = Object.keys(state.records)
      if (keys.length > MAX_RECORDS_PER_SESSION) {
        keys.sort((a, b) => state.records[a].time - state.records[b].time)
        for (const key of keys.slice(0, keys.length - MAX_RECORDS_PER_SESSION)) {
          delete state.records[key]
          removed += 1
        }
      }
    }
    if (this.sessions.size > MAX_SESSIONS) {
      const ordered = [...this.sessions.entries()].sort((a, b) => {
        const at = a[1].updatedAt ?? 0
        const bt = b[1].updatedAt ?? 0
        return at - bt
      })
      for (const [id] of ordered.slice(0, ordered.length - MAX_SESSIONS)) {
        this.sessions.delete(id)
        removed += 1
      }
    }
    this.prunedRecords += removed
    return removed
  }

  save(force = false) {
    if (!this.dirty && !force) return
    try {
      fs.mkdirSync(logsDir(), { recursive: true })
      const now = Date.now()
      this.prune(now)
      const sessions = {}
      for (const [id, state] of this.sessions) {
        sessions[id] = {
          consumed: state.consumed,
          cwd: state.cwd,
          parent: state.parent,
          origin: state.origin,
          updatedAt: state.updatedAt,
          route: state.route,
          slot: state.slot,
          request: state.request,
          records: state.records,
        }
      }
      const payload = { version: LEDGER_VERSION, updatedAt: now, sessions }
      const file = ledgerFilePath()
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8')
      fs.renameSync(tmp, file)
      this.lastSavedAt = now
      this.dirty = false
      this.writeDailyCsv()
    } catch (e) {
      this.loadError = `台账写入失败：${e instanceof Error ? e.message : String(e)}`
    }
  }

  /** Human-facing per-day rollup (Excel-friendly, no BOM, ASCII header). */
  writeDailyCsv() {
    try {
      const days = new Map()
      for (const state of this.sessions.values()) {
        for (const record of Object.values(state.records)) {
          const priced = priceAttempt(record, this.pricing)
          const day = bjDayLabel(record.time)
          const bucket = days.get(day) ?? { attempts: 0, peak: 0, idle: 0, uncached: 0, read: 0, write: 0, out: 0, cny: 0 }
          bucket.attempts += 1
          bucket[priced.window] += 1
          bucket.uncached += record.uncached
          bucket.read += record.read
          bucket.write += record.write
          bucket.out += record.out
          bucket.cny += priced.cny
          days.set(day, bucket)
        }
      }
      const lines = ['date,attempts,peak_attempts,idle_attempts,uncached_input,cache_read,cache_write,output,cny']
      for (const [day, b] of [...days.entries()].sort((a, c) => (a[0] < c[0] ? -1 : 1))) {
        lines.push([day, b.attempts, b.peak, b.idle, b.uncached, b.read, b.write, b.out, b.cny.toFixed(6)].join(','))
      }
      fs.writeFileSync(dailyCsvPath(), `${lines.join('\n')}\n`, 'utf8')
    } catch {
      /* the rollup is a convenience; never let it break the ledger */
    }
  }

  // --- folding ------------------------------------------------------------
  /**
   * Catch one live session's fold up to its durable tail. Constructor seeds do
   * not publish `session/event`, so the first sighting folds from the session's
   * fork-inherited prefix and backfills the whole live history.
   */
  sync(session) {
    if (!session || typeof session.id !== 'string') return null
    const id = session.id
    let state = this.sessions.get(id)
    if (!state) {
      state = newSessionState(session)
      this.sessions.set(id, state)
    }
    const end = Number(session.seq)
    if (!Number.isFinite(end) || state.consumed >= end) {
      state.updatedAt = state.updatedAt ?? Date.now()
      return state
    }
    let events = null
    try {
      events = session.snapshotEvents(state.consumed, end)
    } catch {
      try {
        events = session.snapshotEvents()
        state.consumed = Number(session.inheritedEventCount ?? 0)
      } catch {
        return state
      }
    }
    if (!Array.isArray(events) || events.length === 0) return state
    foldEvents(state, events)
    state.consumed = Math.max(state.consumed, end)
    state.updatedAt = Date.now()
    this.dirty = true
    this.markDirty()
    return state
  }

  /** Firehose listener: incremental, post-commit, never throws. */
  note(session, event) {
    try {
      if (!session || typeof session.id !== 'string' || !event) return
      let state = this.sessions.get(session.id)
      if (!state) state = this.sync(session)
      if (!state) return
      if (typeof event.seq === 'number' && event.seq < state.consumed) return
      foldEvent(state, event)
      state.updatedAt = Date.now()
      this.markDirty()
    } catch {
      /* the firehose must never take down an append */
    }
  }

  // --- historical backfill ------------------------------------------------
  /**
   * Fold one already-read log snapshot for a session that is not live. The
   * snapshot's `inheritedEventCount` is the durable fork cut, so a forked
   * child's inherited prefix (its parent's calls) is never charged twice.
   */
  foldSnapshot(sessionId, snapshot, cut) {
    const inherited = Number(cut ?? snapshot?.inheritedEventCount ?? 0)
    const header = snapshot?.session ?? snapshot?.header ?? {}
    let state = this.sessions.get(sessionId)
    if (!state) {
      state = {
        consumed: Number.isFinite(inherited) ? inherited : 0,
        records: {},
        route: null,
        slot: null,
        request: null,
        cwd: typeof header.cwd === 'string' ? header.cwd : null,
        parent: typeof header.parentSession === 'string' ? header.parentSession : null,
        origin: typeof header.origin === 'string' ? header.origin : null,
        updatedAt: null,
      }
      this.sessions.set(sessionId, state)
    }
    const events = Array.isArray(snapshot?.events) ? snapshot.events : []
    const tail = events.filter((event) => typeof event.seq === 'number' && event.seq >= state.consumed)
    if (tail.length === 0) {
      state.updatedAt = state.updatedAt ?? Date.now()
      return 0
    }
    foldEvents(state, tail)
    const last = tail[tail.length - 1]
    state.consumed = Math.max(state.consumed, last.seq + 1)
    state.updatedAt = Date.now()
    this.dirty = true
    this.markDirty()
    return tail.length
  }

  /** Start the one-shot historical backfill, at most once per host process. */
  ensureBackfill(ctx) {
    if (this.backfill.state !== 'idle') return this.backfill
    this.backfill = {
      state: 'running',
      done: 0,
      total: 0,
      failed: 0,
      skipped: 0,
      source: 'files',
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
      failures: [],
    }
    this.runBackfill(optionalService(ctx, 'sessionQuery'), optionalService(ctx, 'sessions')).catch((error) => {
      this.backfill.state = 'failed'
      this.backfill.error = messageOf(error)
      this.backfill.finishedAt = Date.now()
    })
    return this.backfill
  }

  /**
   * Read stored sessions newest-file-first and fold each one's own events.
   *
   * The stored log is preferred over the query service: it is available for
   * every session the persistence backend wrote, it carries no replay
   * validation that could reject a still-valid log, and its fork cut is derived
   * from the log itself. The service is the fallback for a session with no local
   * file, and supplies the session list when the file index is empty.
   */
  async runBackfill(query, sessionStore) {
    const index = sessionFileIndex()
    const ids = new Set(index.keys())
    if (query && typeof query.listSessions === 'function') {
      try {
        for (const record of await query.listSessions()) {
          const id = record?.header?.id
          if (typeof id === 'string') ids.add(id)
        }
        this.backfill.source = index.size > 0 ? 'files+query' : 'query'
      } catch (e) {
        this.backfill.failures.push({ id: '(listSessions)', error: messageOf(e) })
      }
    }
    const candidates = [...ids].map((id) => {
      const entry = index.get(id)
      return { id, entry, mtime: newestMtime(entry) }
    })
    const pending = candidates
      .filter((candidate) => {
        const state = this.sessions.get(candidate.id)
        // Already folded to the end of this file: nothing new to read.
        return !(state && state.updatedAt && candidate.mtime > 0 && candidate.mtime <= state.updatedAt)
      })
      .sort((a, b) => b.mtime - a.mtime)
    const list = pending.slice(0, BACKFILL_MAX_SESSIONS)
    this.backfill.total = list.length
    this.backfill.skipped = candidates.length - pending.length

    for (const candidate of list) {
      const { id, entry } = candidate
      try {
        const live = sessionStore && typeof sessionStore.get === 'function' ? sessionStore.get(id) : null
        if (live) {
          this.sync(live)
        } else {
          const file = preferredFile(entry)
          let folded = null
          if (file) {
            const log = readSessionLogFile(file)
            if (log) folded = this.foldSnapshot(id, { session: log.header, events: log.events }, log.cut)
          }
          if (folded === null) {
            if (!query || typeof query.readSession !== 'function') throw new Error('没有本地日志文件，且宿主未挂载 sessionQuery')
            this.foldSnapshot(id, await query.readSession(id))
          }
        }
      } catch (e) {
        this.backfill.failed += 1
        if (this.backfill.failures.length < BACKFILL_MAX_FAILURES) {
          this.backfill.failures.push({ id, error: messageOf(e) })
        }
      }
      this.backfill.done += 1
      await delay(BACKFILL_GAP_MS)
    }
    this.backfill.state = 'done'
    this.backfill.finishedAt = Date.now()
    this.save(true)
  }

  // --- reporting ----------------------------------------------------------
  recordsOf(state) {
    return Object.values(state?.records ?? {})
  }

  sessionReport(sessionId) {
    const state = this.sessions.get(sessionId)
    const records = this.recordsOf(state)
    const priced = records.map((record) => ({ ...record, ...priceAttempt(record, this.pricing) }))
    const agg = aggregatePriced(priced)
    const recent = [...priced].sort((a, b) => b.time - a.time).slice(0, 12)
    return {
      sessionId,
      cwd: state?.cwd ?? null,
      parent: state?.parent ?? null,
      origin: state?.origin ?? null,
      consumed: state?.consumed ?? 0,
      updatedAt: state?.updatedAt ?? null,
      ...agg,
      // Flat mirrors of the aggregate so both halves read the same contract.
      attempts: agg.totals.attempts,
      cny: agg.totals.cny,
      tokens: agg.totals.tokens,
      peak: agg.totals.peak,
      idle: agg.totals.idle,
      recent: recent.map((r) => ({
        time: r.time,
        at: bjClock(r.time),
        settledAt: r.settled === undefined ? null : bjClock(r.settled),
        type: r.type,
        turn: r.turn,
        step: r.step,
        model: r.pricedAs,
        window: r.window,
        cny: r.cny,
        tokens: { uncached: r.uncached, cacheRead: r.read, cacheWrite: r.write, out: r.out },
      })),
    }
  }

  report(sessionId) {
    const pricing = this.refreshPricing()
    const now = Date.now()
    const today = bjDateKey(now)
    const all = []
    const sessionRows = []
    for (const [id, state] of this.sessions) {
      const records = this.recordsOf(state)
      if (records.length === 0) continue
      const priced = records.map((record) => ({ ...record, ...priceAttempt(record, pricing) }))
      all.push(...priced)
      const agg = aggregatePriced(priced)
      sessionRows.push({
        sessionId: id,
        cwd: state.cwd,
        origin: state.origin,
        attempts: agg.totals.attempts,
        cny: agg.totals.cny,
        last: agg.last,
        lastAt: agg.last === null ? null : bjClock(agg.last),
        first: agg.first,
      })
    }
    const agg = aggregatePriced(all)
    const todayPriced = all.filter((r) => bjDayLabel(r.time) === today)
    const sevenDays = all.filter((r) => r.time >= now - 7 * DAY_MS)
    const summarize = (rows) => {
      const a = aggregatePriced(rows)
      return { cny: a.totals.cny, attempts: a.totals.attempts, tokens: a.totals.tokens, peak: a.totals.peak, idle: a.totals.idle }
    }
    sessionRows.sort((a, b) => (b.last ?? 0) - (a.last ?? 0))
    return {
      ok: true,
      generatedAt: now,
      now: windowReport(now, pricing),
      pricing: {
        source: pricing.source,
        file: pricing.file,
        sourceUrl: pricing.sourceUrl,
        note: pricing.note,
        peakWindows: pricing.peakWindows,
        routes: pricing.routes,
        fallback: pricing.fallback,
        epochs: pricing.epochs.map((e) => ({
          from: e.from,
          name: e.name,
          weekendsIdle: e.weekendsIdle,
          holidaysIdle: e.holidaysIdle,
          peakMultiplier: e.peakMultiplier,
          models: Object.fromEntries(
            Object.entries(e.models).map(([key, rate]) => [key, { idle: rate, peak: { hit: rate.hit * e.peakMultiplier, miss: rate.miss * e.peakMultiplier, out: rate.out * e.peakMultiplier } }]),
          ),
        })),
        holidays: [...pricing.holidays].sort(),
      },
      ledger: {
        file: ledgerFilePath(),
        dailyCsv: dailyCsvPath(),
        updatedAt: this.lastSavedAt,
        sessions: this.sessions.size,
        records: all.length,
        prunedRecords: this.prunedRecords,
        loadError: this.loadError,
        backfill: { ...this.backfill },
        totals: summarize(all),
        today: { date: today, ...summarize(todayPriced) },
        last7d: summarize(sevenDays),
        byDay: agg.byDay.slice(0, 30),
        byModel: agg.byModel,
        unpricedModels: agg.unpricedModels,
        topSessions: sessionRows.slice(0, 12),
      },
      session: sessionId ? this.sessionReport(sessionId) : null,
    }
  }
}

// ===========================================================================
// System monitor (unchanged behaviour)
// ===========================================================================

/** Run a PowerShell command and resolve with trimmed stdout (best effort). */
function runPs(script) {
  return new Promise((resolve) => {
    const exe = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]
    execFile(exe, args, { timeout: 15000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        resolve({ ok: false, text: '' })
        return
      }
      resolve({ ok: true, text: String(stdout ?? '').trim() })
    })
  })
}

async function cimJson(script) {
  const r = await runPs(script)
  if (!r.ok || r.text === '') return null
  try {
    return JSON.parse(r.text)
  } catch {
    return null
  }
}

const PROCESS_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
$rows = Get-CimInstance Win32_Process | ForEach-Object {
  $u = $_.UserModeTime;  if ($null -eq $u) { $u = 0 }
  $k = $_.KernelModeTime; if ($null -eq $k) { $k = 0 }
  $ws = $_.WorkingSetSize; if ($null -eq $ws) { $ws = 0 }
  $tc = $_.ThreadCount; if ($null -eq $tc) { $tc = 0 }
  $st = ''
  try { if ($null -ne $_.CreationDate) { $st = ([datetime]$_.CreationDate).ToString('o') } } catch {}
  [pscustomobject]@{
    pid = [int]$_.ProcessId
    ppid = [int]$_.ParentProcessId
    name = [string]$_.Name
    cmd = [string]$_.CommandLine
    threads = [int]$tc
    ws = [long]$ws
    start = $st
    ticks = [long]$u + [long]$k
  }
}
,($rows | ConvertTo-Json -Compress -Depth 3)
`

async function sampleProcesses() {
  const data = await cimJson(PROCESS_SCRIPT)
  if (!Array.isArray(data)) return null
  const byPid = new Map()
  for (const row of data) {
    if (row && typeof row.pid === 'number') {
      byPid.set(row.pid, {
        pid: row.pid,
        ppid: row.ppid,
        name: row.name ?? 'unknown',
        cmd: typeof row.cmd === 'string' && row.cmd.length > 0 ? row.cmd : null,
        threads: row.threads || 0,
        ws: row.ws || 0,
        start: typeof row.start === 'string' ? row.start : null,
        ticks: row.ticks || 0,
      })
    }
  }
  return byPid
}

async function sampleCpuPercent() {
  const r = await cimJson(`
$ErrorActionPreference='SilentlyContinue'
$procs = Get-CimInstance Win32_Processor | Select-Object -ExpandProperty LoadPercentage
$total = 0; $count = 0
foreach ($p in $procs) { $total += $p; $count++ }
[pscustomobject]@{ load = if ($count -gt 0) { [math]::Round($total / $count, 1) } else { -1 } } | ConvertTo-Json -Compress
`)
  if (!r) return null
  return typeof r.load === 'number' && r.load >= 0 ? r.load : null
}

async function sampleDisks() {
  const r = await cimJson(`
$ErrorActionPreference='SilentlyContinue'
$rows = Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
  [pscustomobject]@{
    drive = $_.DeviceID
    label = [string]$_.VolumeName
    fs = [string]$_.FileSystem
    size = [long]$_.Size
    free = [long]$_.FreeSpace
  }
}
,($rows | ConvertTo-Json -Compress -Depth 3)
`)
  if (!Array.isArray(r)) return []
  return r.map((d) => ({
    drive: d.drive ?? '',
    label: d.label ?? '',
    fs: d.fs ?? '',
    size: d.size || 0,
    free: d.free || 0,
    used: Math.max(0, (d.size || 0) - (d.free || 0)),
  }))
}

function cpuModelInfo() {
  const cpus = os.cpus()
  const cores = cpus.length
  const model = cpus.length > 0 ? cpus[0].model : os.arch()
  const speed = cpus.length > 0 ? cpus[0].speed : 0
  const physical = cores // logical core count; physical count not exposed by os
  return { model, cores, speed, physical }
}

function formatDurationSeconds(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n) => String(n).padStart(2, '0')
  if (d > 0) return `${d}天 ${pad(h)}:${pad(m)}:${pad(sec)}`
  if (h > 0) return `${h}小时 ${pad(m)}分 ${pad(sec)}秒`
  if (m > 0) return `${m}分 ${pad(sec)}秒`
  return `${sec}秒`
}

function chainInfo(startPid, byPid) {
  const chain = []
  let pid = startPid
  const seen = new Set()
  while (pid > 0 && pid !== undefined && !seen.has(pid)) {
    seen.add(pid)
    const row = byPid.get(pid)
    if (!row) break
    chain.unshift(row)
    pid = row.ppid
  }
  return chain
}

function descendantsOf(chainPids, byPid) {
  const roots = new Set(chainPids)
  const isInTree = (pid) => {
    const seen = new Set()
    let cursor = byPid.get(pid)
    while (cursor) {
      if (roots.has(cursor.pid)) return true
      if (seen.has(cursor.pid)) break
      seen.add(cursor.pid)
      cursor = byPid.get(cursor.ppid)
    }
    return false
  }
  const out = []
  for (const row of byPid.values()) {
    if (roots.has(row.pid) || isInTree(row.pid)) out.push(row)
  }
  return out
}

class Monitor {
  constructor() {
    this.history = []
    this.lastFullAt = 0
    this.lastCpuPct = null
    this.lastMemPct = null
  }

  pushHistory(cpuPct, memPct) {
    this.history.push({ t: Date.now(), cpu: cpuPct, mem: memPct })
    if (this.history.length > HISTORY_LEN) this.history.splice(0, this.history.length - HISTORY_LEN)
  }

  /** Compute a full snapshot; throttled. */
  async snapshot(force = false) {
    const now = Date.now()
    if (!force && now - this.lastFullAt < POLL_GAP_MS && this.last !== undefined) return this.last
    this.lastFullAt = now

    const started = Date.now()
    const out = {
      ts: new Date().toISOString(),
      meta: {
        plugin: 'dsmon',
        version: '0.2.2',
        computeMs: 0,
      },
      system: null,
      overview: null,
      service: null,
      tree: [],
      top: [],
      disks: [],
      totals: null,
      history: null,
      errors: [],
    }

    // --- system / OS overview -------------------------------------------
    try {
      const memTotal = os.totalmem()
      const memFree = os.freemem()
      const memUsed = memTotal - memFree
      const cpu = cpuModelInfo()
      const bootMs = Date.now() - os.uptime() * 1000
      out.system = {
        hostname: os.hostname(),
        platform: process.platform,
        type: os.type(),
        release: os.release(),
        arch: os.arch(),
        node: process.version,
        user: (os.userInfo() || {}).username ?? null,
        cpu: {
          model: cpu.model,
          cores: cpu.cores,
          speedMHz: cpu.speed,
        },
        mem: {
          total: memTotal,
          free: memFree,
          used: memUsed,
        },
        bootedAt: new Date(bootMs).toISOString(),
        bootedAgo: formatDurationSeconds(os.uptime()),
      }
    } catch (e) {
      out.errors.push(`system: ${e.message}`)
    }

    // --- CPU/memory gauges + history ------------------------------------
    const [cpuPct, diskRows] = await Promise.all([sampleCpuPercent(), sampleDisks()])
    const memPct = out.system ? Math.round(((out.system.mem.used / out.system.mem.total) * 100) * 10) / 10 : null
    this.lastCpuPct = cpuPct
    this.lastMemPct = memPct
    out.overview = {
      cpuPct,
      memPct,
      history: null, // replaced below
    }
    out.disks = diskRows || []
    this.pushHistory(cpuPct, memPct)
    out.history = this.history.map((h) => ({ ...h }))

    // --- processes: dual-sample CPU rate --------------------------------
    try {
      const a = await sampleProcesses()
      if (a) {
        const t1 = Date.now()
        await new Promise((resolve) => setTimeout(resolve, CPU_SAMPLE_GAP_MS))
        const b = await sampleProcesses()
        if (b) {
          const wall = Math.max(0.3, (Date.now() - t1) / 1000)
          const cores = Math.max(1, os.cpus().length)
          const rows = []
          for (const [pid, rb] of b) {
            const ra = a.get(pid)
            const ticks = rb.ticks - (ra ? ra.ticks : 0)
            const singleCorePct = Math.max(0, (ticks / 1e7) / wall * 100)
            rows.push({
              pid,
              ppid: rb.ppid,
              name: rb.name,
              cmd: rb.cmd,
              threads: rb.threads,
              ws: rb.ws,
              start: rb.start,
              cpuPct: Math.round(singleCorePct * 10) / 10,
              cpuMachinePct: Math.round(Math.min(singleCorePct / cores, 100) * 10) / 10,
            })
          }
          rows.sort((x, y) => y.cpuPct - x.cpuPct)
          const byPid = new Map(rows.map((r) => [r.pid, r]))

          // The dsh web service tree: this process plus ancestry + descendants.
          const chain = chainInfo(process.pid, byPid)
          const serviceSelf = byPid.get(process.pid) || null
          const tree = descendantsOf(chain.map((c) => c.pid), byPid).sort((x, y) => x.pid - y.pid)

          const totalThreads = rows.reduce((acc, r) => acc + r.threads, 0)
          const totalWs = rows.reduce((acc, r) => acc + r.ws, 0)

          out.service = {
            pid: process.pid,
            ppid: process.ppid,
            name: serviceSelf ? serviceSelf.name : process.title,
            cmd: serviceSelf ? serviceSelf.cmd : process.argv.join(' '),
            threads: serviceSelf ? serviceSelf.threads : null,
            ws: serviceSelf ? serviceSelf.ws : null,
            cpuPct: serviceSelf ? serviceSelf.cpuPct : null,
            chain: chain.slice(0, 12).map((c) => ({
              pid: c.pid,
              name: c.name,
              cpuPct: c.cpuPct,
              ws: c.ws,
              threads: c.threads,
            })),
          }
          out.tree = tree.slice(0, 120)
          out.top = rows.slice(0, 15)
          out.totals = {
            processes: rows.length,
            threads: totalThreads,
            workingSet: totalWs,
          }
        } else {
          out.errors.push('processes: second sample failed')
        }
      } else {
        out.errors.push('processes: first sample failed')
      }
    } catch (e) {
      out.errors.push(`processes: ${e.message}`)
    }

    out.meta.computeMs = Date.now() - started
    this.last = out
    return out
  }

  /** Thread detail for one pid (Win32_Thread), capped. */
  async threads(pid) {
    const r = await cimJson(`
$ErrorActionPreference='SilentlyContinue'
$pidN = ${Number.isFinite(pid) ? Number(pid) : -1}
$rows = Get-CimInstance Win32_Thread -Filter "ProcessHandle=$pidN" | ForEach-Object {
  $u = $_.UserModeTime;  if ($null -eq $u) { $u = 0 }
  $k = $_.KernelModeTime; if ($null -eq $k) { $k = 0 }
  $st = ''
  try { if ($null -ne $_.CreationDate) { $st = ([datetime]$_.CreationDate).ToString('o') } } catch {}
  [pscustomobject]@{
    id = [int]$_.Handle
    state = [string]$_.ThreadState
    priority = [int]$_.Priority
    cpuSec = [math]::Round(([long]$u + [long]$k) / 1e7, 3)
    start = $st
  }
}
,($rows | ConvertTo-Json -Compress -Depth 3)
`)
    if (!Array.isArray(r)) return { pid, ok: false, threads: [], error: 'sampling failed' }
    return { pid, ok: true, threads: r.slice(0, 400) }
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(text)
}

/** Look up a live session through the optional `sessions` service. */
function liveSession(ctx, sessionId) {
  try {
    if (typeof ctx.get !== 'function') return null
    const store = ctx.get('sessions')
    if (!store || typeof store.get !== 'function') return null
    return store.get(sessionId) ?? null
  } catch {
    return null
  }
}

/** Cordis plugin entry. */
export function apply(ctx) {
  const monitor = new Monitor()
  const ledger = new CostLedger()

  // Cost ledger wiring: the firehose feeds it incrementally, a timer bounds how
  // long a computed amount can stay unsaved.
  ctx.effect(() => {
    const offEvent = ctx.on('session/event', (session, event) => ledger.note(session, event))
    const interval = setInterval(() => ledger.save(), SAVE_INTERVAL_MS)
    if (typeof interval.unref === 'function') interval.unref()
    // Backfill every live session once at load so the ledger opens with history.
    try {
      const store = typeof ctx.get === 'function' ? ctx.get('sessions') : null
      if (store && typeof store.list === 'function') {
        for (const session of store.list()) ledger.sync(session)
        ledger.save()
      }
    } catch {
      /* a missing store only costs the initial backfill */
    }
    return () => {
      clearInterval(interval)
      try {
        if (typeof offEvent === 'function') offEvent()
      } catch {
        /* already disposed */
      }
      ledger.save(true)
    }
  }, 'dsmon: cost ledger')

  const disposer = ctx.webServer.register({
    kind: 'prefix',
    path: '/dsmon',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const path = url.pathname
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        if (path === '/dsmon/api/snapshot' || path === '/dsmon/api/system') {
          const snap = await monitor.snapshot()
          sendJson(res, 200, snap)
          return
        }
        if (path === '/dsmon/api/threads') {
          const pid = Number(url.searchParams.get('pid'))
          const out = await monitor.threads(pid)
          sendJson(res, Number.isFinite(pid) ? 200 : 400, out)
          return
        }
        if (path === '/dsmon/api/cost') {
          const sessionId = url.searchParams.get('sessionId')
          if (sessionId) {
            const session = liveSession(ctx, sessionId)
            if (session) ledger.sync(session)
          }
          // First cost request of the process also opens the historical
          // backfill, so "today / 7 days" is complete and not just "since the
          // last restart". It runs detached and reports its own progress.
          ledger.ensureBackfill(ctx)
          sendJson(res, 200, ledger.report(sessionId))
          return
        }
        if (path === '/dsmon/health') {
          sendJson(res, 200, { ok: true, ts: Date.now() })
          return
        }
        sendJson(res, 404, { ok: false, error: 'not found' })
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    },
  })

  ctx.effect(() => disposer, 'dsmon: /dsmon routes')
}

/** Exposed for offline verification (not part of the plugin contract). */
export const __test = {
  normalizePricing,
  windowAt,
  windowReport,
  priceAttempt,
  foldEvents,
  expandHolidays,
  bjClock,
  bjDayLabel,
}
