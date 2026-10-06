// 本问实时速度：读 ZCode 本地用量库（只读），算出「本问即时输出速率 / 首 token 延迟 /
// 采样时刻」。绝不写库、不联网。
//
// 数据源：~/.zcode/cli/db/db.sqlite 的 model_usage 表（请求完成时一次性落库，无 UPDATE）。
//
// 口径（对齐 deepseek-harness turn-metrics / 参考项目 zcode-tps-monitor）：
//   - 本问 = 当前会话最新的 turn_id。一次提问触发的全部模型请求共享同一个 turn_id，
//     含「模型→工具→模型」的每一段。
//   - 当前会话 = 用户此刻在客户端里打开的会话（读客户端日志 v4.session_data.acquire）；
//     日志读不到时退回「最近有完成请求的会话」。于是在 ZCode 里切换会话，方框会跟着切。
//   - 即时速率 = Σ output_tokens / Σ(completed_at − first_token_at)，按段加权：
//     多段时把各段纯生成时长相加、产出相加，天然排除段间的工具等待，等价于
//     「总产出 / 总生成时长」；单段时即该段速率。分母只计「有 first_token_at 且
//     生成时长落在合理区间」的段（命中率约 65%，其余是中断/非流式，回退会让速率偏低）。
//   - 含思考 token：ZCode 的 output_tokens **已包含** reasoning_tokens。已核对
//     raw_usage_json：totalTokens = inputTokens + outputTokens，reasoningTokens 是
//     outputTokens 的子集。所以这里直接用 output_tokens，绝不再加一次 reasoning，
//     否则会把速率抬高（参考项目 zcode-tps-monitor 的 `+ reasoning` 即为此类重复计数）。
//   - 首 token 延迟 TTFT = 本问第一段的 time_to_first_token_ms。
//   - 采样时刻 = 本问最后一段的 completed_at（最近一次工具调用之后的落库时刻）。
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { DB_FILE } from './paths.mjs'
import { readState } from './config.mjs'
import { activeSessionFromLog } from './client-session.mjs'

const require = createRequire(import.meta.url)

// 有效样本：纯生成时长（completed_at − first_token_at）落在这个区间才算速率
const MIN_GEN_MS = 150
const MAX_GEN_MS = 3_600_000 // 1h

// 只统计主对话；子代理/标题生成不计入「本问」。（compact 也不计入——它不是本问的产出）
const QUERY_SOURCE = 'main_turn'

let sqliteModule = null
let sqliteProbed = false

function loadSqlite() {
  if (sqliteProbed) return sqliteModule
  sqliteProbed = true
  try {
    // node:sqlite 自 Node 22.5 起内置；拿不到就没有数据源
    sqliteModule = require('node:sqlite')
  } catch (err) {
    sqliteModule = null
  }
  return sqliteModule
}

const SQL_SESSION_BY_ID = 'SELECT id, title FROM session WHERE id = ?'
const SQL_LATEST_SESSION = `
  SELECT session_id FROM model_usage
  WHERE status = 'completed' AND query_source = '${QUERY_SOURCE}'
  ORDER BY completed_at DESC LIMIT 1
`
// 最新一问的 turn_id（按完成时刻取最新，兼容旧库无 turn_id 列时 try/catch 兜底）
const SQL_LATEST_TURN = `
  SELECT turn_id FROM model_usage
  WHERE session_id = ? AND query_source = '${QUERY_SOURCE}' AND turn_id IS NOT NULL
  ORDER BY completed_at DESC LIMIT 1
`
const SQL_TURN_ROWS = `
  SELECT model_id, status, output_tokens, reasoning_tokens, input_tokens,
         cache_read_input_tokens, first_token_at, completed_at,
         time_to_first_token_ms, started_at
  FROM model_usage
  WHERE session_id = ? AND query_source = '${QUERY_SOURCE}' AND turn_id = ?
  ORDER BY completed_at ASC
`
// 会话里最近若干段的峰值（窗口内），供「峰」展示。需带 reasoning_tokens/started_at，
// 与 toSegment 的思考段窗口对齐。
const SQL_RECENT_ROWS = `
  SELECT output_tokens, reasoning_tokens, first_token_at, completed_at, started_at
  FROM model_usage
  WHERE session_id = ? AND query_source = '${QUERY_SOURCE}' AND status = 'completed'
  ORDER BY completed_at DESC LIMIT ?
`

function num(v) {
  const n = Number(v)
  return isFinite(n) ? n : 0
}

// 单段：纯生成时长与速率（含思考 token，见文件头口径）
function toSegment(r) {
  const output = num(r.output_tokens)
  const reasoning = num(r.reasoning_tokens)
  const hasTime =
    Number.isFinite(r.first_token_at) &&
    Number.isFinite(r.completed_at) &&
    r.completed_at > r.first_token_at
  let genMs = hasTime ? r.completed_at - r.first_token_at : null
  // 有思考 token 的段，生成窗口要从 started_at 起算：ZCode 把 first_token_at 盖在「首个回答
  // token」上，思考 token 是在它之前的 TTFT 窗口里生成的（实测某段思考 5,332 tok / TTFT
  // 29.6s ≈ 180 tok/s，吻合）。若仍用 (completed − first_token)，思考生成时段被整个漏掉，
  // 速率会被高估到物理上不可能的值（实测出现过 9579 tok/s）。改用整段 [started, completed]。
  if (hasTime && reasoning > 0 && Number.isFinite(r.started_at) && r.completed_at > r.started_at) {
    genMs = r.completed_at - r.started_at
  }
  const valid = genMs != null && genMs >= MIN_GEN_MS && genMs < MAX_GEN_MS && output > 0
  return {
    model: r.model_id,
    output,
    reasoning,
    ttftMs: Number.isFinite(r.time_to_first_token_ms) ? r.time_to_first_token_ms : null,
    genMs,
    valid,
    tokPerSec: valid ? (output / genMs) * 1000 : null,
    completedAt: r.completed_at,
  }
}

function shortenModel(m) {
  const s = String(m || '')
  const i = s.lastIndexOf('/')
  return i >= 0 ? s.slice(i + 1) : s
}

function titleOf(db, sid) {
  try {
    const t = db.prepare(SQL_SESSION_BY_ID).get(sid)
    return (t && t.title) || ''
  } catch (err) {
    return ''
  }
}

// 本问速度快照。opts.current=true 时启用 --current 守卫：
// 若最新 turn 的所有段都早于「本次提问时刻」，说明本问尚未产生任何模型请求（典型是
// 纯问答轮尚未结束），返回 ok:false 而绝不用上一轮的数据冒充本问。
export function turnSpeedSnapshot(opts = {}) {
  const sqlite = loadSqlite()
  if (!sqlite) return { ok: false, reason: 'no-sqlite', hint: '需要 Node 22.5+（内置 node:sqlite）' }
  if (!fs.existsSync(DB_FILE)) return { ok: false, reason: 'no-db', db: DB_FILE }

  let db = null
  try {
    db = new sqlite.DatabaseSync(DB_FILE, { readOnly: true, timeout: 2000 })

    // 默认会话 = 用户此刻在客户端里打开的会话（读客户端日志）；日志读不到再退回
    // 「最近有完成请求的会话」。这样在 ZCode 里切换会话时，方框会跟着切到当前会话。
    let sid = opts.sessionId || ''
    let sessionSource = opts.sessionId ? 'explicit' : ''
    if (!sid) {
      const fromLog = activeSessionFromLog()
      if (fromLog) {
        sid = fromLog
        sessionSource = 'log'
      }
    }
    if (!sid) {
      const row = db.prepare(SQL_LATEST_SESSION).get()
      if (!row) return { ok: false, reason: 'no-session' }
      sid = row.session_id
      sessionSource = 'db'
    }

    let turnId = null
    try {
      const row = db.prepare(SQL_LATEST_TURN).get(sid)
      turnId = row ? row.turn_id : null
    } catch (err) {
      turnId = null // 旧版客户端没有 turn_id 列
    }
    if (!turnId) return { ok: false, reason: 'no-turn', sessionId: sid, sessionSource, title: titleOf(db, sid) }

    const rows = db.prepare(SQL_TURN_ROWS).all(sid, turnId)
    if (!rows.length) return { ok: false, reason: 'no-turn', sessionId: sid, sessionSource, title: titleOf(db, sid) }

    // --current 守卫：本问尚无模型请求时不冒充
    if (opts.current) {
      const st = readState()
      const promptTs = Number.isFinite(st.promptTs) ? st.promptTs : null
      const lastAt = Math.max(...rows.map((r) => num(r.completed_at)))
      if (promptTs && lastAt < promptTs) {
        return {
          ok: false,
          reason: 'no-current-turn',
          sessionId: sid,
          sessionSource,
          title: titleOf(db, sid),
        }
      }
    }

    const segments = rows.map(toSegment)
    const rated = segments.filter((s) => s.valid)

    // 本问即时速率 = Σ产出 / Σ纯生成时长（按段加权，排除工具等待）
    const totalOutput = segments.reduce((s, x) => s + x.output, 0)
    const totalReasoning = segments.reduce((s, x) => s + x.reasoning, 0)
    const genMs = rated.reduce((s, x) => s + x.genMs, 0)
    const ratedOutput = rated.reduce((s, x) => s + x.output, 0)
    const tokPerSec = genMs >= MIN_GEN_MS && ratedOutput > 0 ? (ratedOutput / genMs) * 1000 : null

    // 首 token 延迟：本问第一段（含无 first_token_at 的行时，取第一条有 TTFT 的段）
    const firstWithTtft = segments.find((s) => s.ttftMs != null)
    const ttftMs = firstWithTtft ? firstWithTtft.ttftMs : null

    // 采样时刻：本问最后一段完成时刻
    const lastSeg = segments[segments.length - 1]
    const sampleAt = lastSeg ? lastSeg.completedAt : null

    // 会话近期峰值（窗口内）
    const recent = db.prepare(SQL_RECENT_ROWS).all(sid, 60).map(toSegment).filter((s) => s.valid)
    const peakTokPerSec = recent.length ? Math.max(...recent.map((s) => s.tokPerSec)) : tokPerSec

    const model = lastSeg ? lastSeg.model : ''

    return {
      ok: true,
      sessionId: sid,
      sessionSource,
      title: titleOf(db, sid),
      turnId,
      model,
      modelShort: shortenModel(model),
      tokPerSec, // 本问即时速率（tok/s，含思考 token）
      ttftMs, // 首 token 延迟（ms）
      outputTokens: totalOutput, // 本问输出（已含思考 token）
      reasoningTokens: totalReasoning, // 其中思考 token（展示用，不参与速率分子）
      genMs, // 本问纯生成时长（Σ段）
      segments: segments.length, // 本问段数
      ratedSegments: rated.length, // 计入速率的段数
      fallback: rated.length === 0 || rated.length < segments.length,
      peakTokPerSec,
      sampleAt, // 采样时刻（epoch ms，本问最后一段完成时刻）
      updatedAt: Date.now(),
    }
  } catch (err) {
    return { ok: false, reason: 'query-failed', error: String((err && err.message) || err).slice(0, 200) }
  } finally {
    try {
      if (db) db.close()
    } catch (err) {}
  }
}

// ---------- 供 CLI / MCP 用的紧凑文本 ----------
function fmtInt(n) {
  return Number(Math.round(num(n))).toLocaleString('en-US')
}

function fmtClock(ms) {
  if (!Number.isFinite(ms)) return '-'
  const d = new Date(ms)
  const p = (v) => String(v).padStart(2, '0')
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}

export function formatTurnLine(s) {
  if (!s || !s.ok) {
    const map = {
      'no-sqlite': '读不到 node:sqlite（需要 Node 22.5+）',
      'no-db': '找不到用量库 db.sqlite',
      'no-session': '本地库暂无模型请求记录',
      'no-turn': '本会话暂无已完成的一问',
      'no-current-turn': '本问尚未产生模型请求（纯问答轮，收尾后才可见）',
    }
    return '⚡ 无数据（' + (map[s && s.reason] || (s && s.reason) || 'unknown') + '）'
  }
  const rps = s.tokPerSec != null ? s.tokPerSec.toFixed(1) : '-'
  const ttft = s.ttftMs != null ? (s.ttftMs / 1000).toFixed(1) + 's' : '-'
  const seg = s.segments > 1 ? ` · ${s.segments}段/峰 ${s.peakTokPerSec != null ? s.peakTokPerSec.toFixed(1) : '-'}` : ''
  return (
    `⚡ ${rps} tok/s（本问） · 首 token ${ttft} · 输出 ${fmtInt(s.outputTokens)} tok` +
    ` · 采样 ${fmtClock(s.sampleAt)}${seg}`
  )
}
