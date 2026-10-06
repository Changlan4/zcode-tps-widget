// SessionStart 自启：会话打开时幂等拉起本地服务，已装 Electron 运行时的话顺带把浮层
// 拉到桌面上。对应挂件的「每次打开界面自动启用」体验。
//
// 作为 ZCode 的 SessionStart hook 运行。hook 的 stdout 会被当作 JSON 严格校验，
// 所以这里全程静默——任何成功/失败都不输出内容，只记录状态并顺手记下当前会话 id
// （供 --current 守卫判断「本问是否已产生模型请求」）。
import fs from 'node:fs'
import path from 'node:path'
import { AUTOSTART_LOG, DATA_DIR } from './paths.mjs'
import { readConfig, writeState } from './config.mjs'
import { ensureServer } from './service.mjs'
import { isRuntimeInstalled, startOverlay } from './overlay.mjs'
import { turnSpeedSnapshot } from './metrics.mjs'

const LOG_KEEP_LINES = 200

function record(text) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.appendFileSync(AUTOSTART_LOG, new Date().toISOString() + ' ' + text + '\n', 'utf8')
    const lines = fs.readFileSync(AUTOSTART_LOG, 'utf8').split(/\r?\n/).filter(Boolean)
    if (lines.length > LOG_KEEP_LINES) {
      fs.writeFileSync(AUTOSTART_LOG, lines.slice(-LOG_KEEP_LINES).join('\n') + '\n', 'utf8')
    }
  } catch (err) {}
}

try {
  // 记下当前会话（hook 的环境里有 ZCODE_SESSION_ID 时优先，否则退回「最近完成请求的会话」）
  const envSid = String(process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || '').trim()
  const snap = turnSpeedSnapshot({ current: false })
  const sessionId = envSid || (snap.ok ? snap.sessionId : '')
  writeState({ sessionId, promptTs: Date.now() })

  const cfg = readConfig()
  if (!cfg.autoStartWidget) {
    record('skip: autoStartWidget=false')
  } else {
    const svc = await ensureServer({ waitReadyMs: 5000 })
    let overlayNote = 'skipped'
    if (svc.running && cfg.autoStartOverlay) {
      if (isRuntimeInstalled()) {
        const r = await startOverlay()
        overlayNote = r.running ? (r.started ? 'started' : 'reused') : 'failed:' + (r.error || 'unknown')
      } else {
        overlayNote = 'skipped:no-runtime'
      }
    }
    record(
      'server=' + (svc.running ? (svc.started ? 'started' : 'reused') : 'failed:' + (svc.error || 'unknown')) +
        ' overlay=' + overlayNote +
        ' session=' + (sessionId || 'unknown')
    )
  }
} catch (err) {
  // 自启失败不能影响会话启动；需要排查时看 autostart.log 的上一行
  record('error: ' + String((err && err.message) || err))
}
