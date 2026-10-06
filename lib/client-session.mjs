// 「用户当前在看哪个会话」——读 ZCode 客户端日志。
//
// ZCode 插件拿不到 UI 事件，但客户端每次从会话列表打开一个会话，都会往
// <dataBaseDir>/.zcode/v2/logs/<日期>.log 写一行 v4.session_data.acquire（带 sessionId），
// 这是唯一能反映「用户正在看哪个会话」的可读信号。日志里读不到时返回 null，调用方
// 再退回「最近有调用的会话」。
//
// 增量扫描而不是只读尾部：客户端每分钟都会写内存采样等噪音行，一次 acquire 几百 KB
// 后就会被挤出尾部窗口，只读尾部必然读不到。这里记住上次读到的偏移，每次只读新增部分。
//
// 为什么不按日期拼日志文件名：客户端按本地日期命名，若用 UTC 日期去拼，北京时间
// 00:00–08:00 之间会拼成前一天、读不到文件。这里直接取目录里最新的。
//
// 本模块与挂件 zcode-whale-widget 的 session-usage.mjs 同源（同一套日志扫描逻辑），
// 只保留「取当前会话 id」这一件事。
import fs from 'node:fs'
import path from 'node:path'
import { CLIENT_LOG_DIR, CLIENT_SETTING_FILE } from './paths.mjs'

// 建立基线时最多回看多少字节；超出则放弃日志、回退数据库
const FIRST_SCAN_BYTES = 8 * 1024 * 1024
// 未成行残片的上限，超出即丢弃，避免异常长行撑爆内存
const PENDING_MAX = 64 * 1024

function candidateLogDirs() {
  const dirs = []
  try {
    const cfg = JSON.parse(fs.readFileSync(CLIENT_SETTING_FILE, 'utf8'))
    const base = typeof cfg.dataBaseDir === 'string' ? cfg.dataBaseDir.trim() : ''
    // dataBaseDir 指的是「ZCode 的根目录」，客户端数据在其下的 .zcode/v2
    if (base) dirs.push(path.join(base, '.zcode', 'v2', 'logs'))
  } catch (err) {}
  dirs.push(CLIENT_LOG_DIR)
  return dirs
}

function newestLogFile() {
  let best = null
  for (const dir of candidateLogDirs()) {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      continue
    }
    for (const e of entries) {
      if (!e.isFile() || !/\.log$/i.test(e.name)) continue
      const full = path.join(dir, e.name)
      let mtime = 0
      try {
        mtime = fs.statSync(full).mtimeMs
      } catch (err) {
        continue
      }
      if (!best || mtime > best.mtime) best = { full, mtime }
    }
  }
  return best ? best.full : null
}

function readRange(file, start, end) {
  const fd = fs.openSync(file, 'r')
  try {
    const len = Math.max(0, end - start)
    const buf = Buffer.alloc(len)
    if (len > 0) fs.readSync(fd, buf, 0, len, start)
    return buf.toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

function extractSessionId(line) {
  if (!line.includes('session_data.acquire') && !line.includes('conversation.subscribe.activated')) {
    return ''
  }
  // acquire 行带 sessionId；subscribe.activated 只有 topic，从 topic 里取
  const m = /"sessionId":"([^"]+)"/.exec(line) || /"topic":"conversation\/([^"]+)"/.exec(line)
  return m && m[1] ? m[1] : ''
}

let logState = { file: null, offset: 0, pending: '', sessionId: '' }

// 返回日志里最近一次打开的会话 id；读不到返回 null
export function activeSessionFromLog() {
  const file = newestLogFile()
  if (!file) return logState.sessionId || null

  let st
  try {
    st = fs.statSync(file)
  } catch (err) {
    return logState.sessionId || null
  }

  let fromMiddle = false
  // 换文件（跨天）或被截断 → 重新建立基线
  if (logState.file !== file || st.size < logState.offset) {
    logState.file = file
    logState.pending = ''
    const start = Math.max(0, st.size - FIRST_SCAN_BYTES)
    logState.offset = start
    fromMiddle = start > 0
  }

  if (st.size <= logState.offset) return logState.sessionId || null

  let text
  try {
    text = readRange(file, logState.offset, st.size)
  } catch (err) {
    return logState.sessionId || null
  }
  logState.offset = st.size

  if (fromMiddle) {
    // 从中间起读，第一段必然是被截断的半行，丢掉
    const nl = text.indexOf('\n')
    text = nl === -1 ? '' : text.slice(nl + 1)
  }

  const combined = (logState.pending || '') + text
  const lines = combined.split(/\r?\n/)
  const tail = lines.pop() || ''
  logState.pending = tail.length > PENDING_MAX ? '' : tail

  for (const line of lines) {
    const sid = extractSessionId(line)
    if (sid) logState.sessionId = sid
  }

  return logState.sessionId || null
}
