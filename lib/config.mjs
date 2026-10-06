// 插件配置（不含任何密钥）：端口、与用量方框的间距、会话自启开关、跟随探测间隔。
import fs from 'node:fs'
import { CONFIG_FILE, DATA_DIR, STATE_FILE } from './paths.mjs'

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (err) {
    return null
  }
}

// 跟随探测间隔：低于 16ms 没有可见收益，高于 2s 方框会明显跟不上窗口
export function normalizeFollowInterval(value) {
  const n = Number(value)
  if (!isFinite(n) || n <= 0) return null
  return Math.min(2000, Math.max(16, Math.round(n)))
}

// 与用量方框之间的垂直间距（像素）：速度方框贴在会话用量方框上方时留的缝
function normalizeGap(value) {
  const n = Number(value)
  if (!isFinite(n) || n < 0) return null
  return Math.min(200, Math.round(n))
}

export function readConfig() {
  const c = readJson(CONFIG_FILE) || {}
  return {
    port: Number.isInteger(c.port) && c.port > 0 && c.port < 65536 ? c.port : null,
    // 贴靠间距：默认 10px，速度方框底边与会话用量方框顶边之间的空档
    stackGapPx: normalizeGap(c.stackGapPx) == null ? 10 : normalizeGap(c.stackGapPx),
    // 默认开启：会话启动时幂等拉起本地服务（对应挂件「每次打开界面自动启用」）
    autoStartWidget: c.autoStartWidget !== false,
    // 会话启动时顺便把桌面浮层也拉起来（前提是 Electron 运行时已装）
    autoStartOverlay: c.autoStartOverlay !== false,
    followIntervalMs: normalizeFollowInterval(c.followIntervalMs),
  }
}

// 只更新传入的字段，其余保持原值。
export function writeConfig(patch) {
  const current = readJson(CONFIG_FILE) || {}
  const next = { ...current }
  for (const key of ['port', 'stackGapPx', 'autoStartWidget', 'autoStartOverlay', 'followIntervalMs']) {
    if (patch && patch[key] !== undefined) next[key] = patch[key]
  }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8')
  return readConfig()
}

// hook 状态：会话 id + 提问时刻。--current 守卫用它判断「本问是否已经产生了模型请求」。
export function readState() {
  return readJson(STATE_FILE) || {}
}

export function writeState(patch) {
  const current = readState()
  const next = { ...current, ...patch, ts: Date.now() }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), 'utf8')
  } catch (err) {}
  return next
}
