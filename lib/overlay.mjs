// 桌面浮层窗口的管理：单例检查、启动、停止，以及 Electron 运行时的复用/安装。
//
// 浮层用独立 Electron 进程承载。运行时体积大（约 150MB），本插件**优先复用**
// 挂件 zcode-whale-widget 已经装好的那一份（~/.zcode/whale/desktop-runtime）；
// 没有时才自行安装，装到同一个目录，两份插件共用一份二进制。
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, OVERLAY_INFO_FILE, PLUGIN_ROOT, WHALE_RUNTIME_DIR } from './paths.mjs'
import { readConfig } from './config.mjs'
import { ensureServer } from './service.mjs'

const RUNTIME_DIR = WHALE_RUNTIME_DIR
const ELECTRON_EXE = path.join(
  RUNTIME_DIR,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
)
const OVERLAY_ENTRY_DIR = path.join(PLUGIN_ROOT, 'desktop')
const ELECTRON_MIRROR = process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/'
const NPM_REGISTRY = process.env.TPS_NPM_REGISTRY || 'https://registry.npmmirror.com'

// 与依赖安装时的 electron 版本保持一致；升级这里即可换运行时。
const ELECTRON_RANGE = '^44.3.0'

function npmBin() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, shell: process.platform === 'win32' })
    let out = ''
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (out += c))
    child.on('error', (err) => resolve({ ok: false, out: out + String(err.message) }))
    child.on('close', (code) => resolve({ ok: code === 0, code, out }))
  })
}

export function isRuntimeInstalled() {
  try {
    return fs.statSync(ELECTRON_EXE).isFile()
  } catch (err) {
    return false
  }
}

export function runtimePaths() {
  return { runtimeDir: RUNTIME_DIR, electronExe: ELECTRON_EXE, overlayEntry: OVERLAY_ENTRY_DIR }
}

// 按需安装：npm 装 electron 包，再触发它自带的脚本下载二进制（走国内镜像）。
// 装到与挂件共用的目录；若挂件已装好，这里不会被调到。
export async function installRuntime() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true })
  const pkgFile = path.join(RUNTIME_DIR, 'package.json')
  if (!fs.existsSync(pkgFile)) {
    fs.writeFileSync(
      pkgFile,
      JSON.stringify(
        {
          name: 'zcode-tps-desktop-runtime',
          version: '1.0.0',
          private: true,
          dependencies: { electron: ELECTRON_RANGE },
        },
        null,
        2
      ),
      'utf8'
    )
  }

  const install = await run(npmBin(), ['install', '--no-audit', '--no-fund', '--registry=' + NPM_REGISTRY], {
    cwd: RUNTIME_DIR,
  })
  if (!install.ok) return { ok: false, step: 'npm install', output: install.out.slice(-1200) }

  if (!isRuntimeInstalled()) {
    const installer = path.join(RUNTIME_DIR, 'node_modules', 'electron', 'install.js')
    if (!fs.existsSync(installer)) {
      return { ok: false, step: 'electron install.js 缺失', output: install.out.slice(-800) }
    }
    const fetched = await run(process.execPath, [installer], {
      cwd: RUNTIME_DIR,
      env: { ...process.env, ELECTRON_MIRROR },
    })
    if (!fetched.ok || !isRuntimeInstalled()) {
      return {
        ok: false,
        step: '下载 Electron 二进制',
        output: (fetched.out || '').slice(-1200) + '\n可手动重试：cd ' + RUNTIME_DIR + ' && npm install',
      }
    }
  }
  return { ok: true, electronExe: ELECTRON_EXE }
}

function isProcessAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err && err.code === 'EPERM'
  }
}

export function readOverlayInfo() {
  try {
    const info = JSON.parse(fs.readFileSync(OVERLAY_INFO_FILE, 'utf8'))
    if (info && typeof info.pid === 'number') return info
  } catch (err) {}
  return null
}

function writeOverlayInfo(info) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(OVERLAY_INFO_FILE, JSON.stringify(info, null, 2), 'utf8')
  } catch (err) {}
}

function clearOverlayInfo() {
  try {
    fs.unlinkSync(OVERLAY_INFO_FILE)
  } catch (err) {}
}

export async function overlayStatus() {
  const info = readOverlayInfo()
  if (!info) return { running: false, installed: isRuntimeInstalled() }
  const alive = isProcessAlive(info.pid)
  if (!alive) clearOverlayInfo()
  return {
    running: alive,
    installed: isRuntimeInstalled(),
    pid: alive ? info.pid : null,
    port: info.port || null,
    startedAt: info.startedAt || null,
  }
}

export async function startOverlay() {
  const status = await overlayStatus()
  if (status.running) {
    return { running: true, started: false, pid: status.pid, port: status.port }
  }
  if (!isRuntimeInstalled()) {
    return {
      running: false,
      started: false,
      installed: false,
      error: '尚未安装 Electron 运行时',
      hint: '运行：node lib/cli.mjs desktop install（约 150MB，一次性；已装过挂件的可跳过）',
    }
  }

  // 浮层要连本插件的服务，先把服务确保在跑
  const svc = await ensureServer()
  if (!svc.running) {
    return { running: false, started: false, error: '速度方框服务未就绪：' + (svc.error || '未知原因') }
  }

  const child = spawn(ELECTRON_EXE, [OVERLAY_ENTRY_DIR], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env: {
      ...process.env,
      TPS_PORT: String(svc.port),
      TPS_TARGET_PROCESS: process.env.TPS_TARGET_PROCESS || 'ZCode',
      TPS_FOLLOW_INTERVAL_MS: String(
        readConfig().followIntervalMs || process.env.TPS_FOLLOW_INTERVAL_MS || 40
      ),
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    },
  })
  child.unref()

  writeOverlayInfo({
    pid: child.pid,
    port: svc.port,
    startedAt: new Date().toISOString(),
  })

  await new Promise((r) => setTimeout(r, 1800))
  const alive = isProcessAlive(child.pid)
  if (!alive) clearOverlayInfo()
  return {
    running: alive,
    started: alive,
    pid: alive ? child.pid : null,
    port: svc.port,
    error: alive ? null : '浮层进程启动后立即退出，可用 node lib/cli.mjs desktop install 检查运行时',
  }
}

export async function stopOverlay() {
  const info = readOverlayInfo()
  if (!info || !isProcessAlive(info.pid)) {
    clearOverlayInfo()
    return { ok: false, error: '浮层未在运行' }
  }
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(info.pid), '/T', '/F'], { windowsHide: true })
    } else {
      process.kill(info.pid)
    }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
  clearOverlayInfo()
  return { ok: true }
}
