// 插件内路径解析。集中在这里，方便迁移与调试。
//
// 本插件是「会话用量方框」(zcode-whale-widget) 的速度孪生：UI 风格一致、位置紧挨，
// 显示本问实时输出速率 / 首 token 延迟 / 采样时刻。它刻意复用挂件的 Electron
// 运行时与定位机制，只带自己的数据目录与端口，两者互不干扰。
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// lib/paths.mjs -> 插件根目录
export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const ZCODE_HOME = process.env.ZCODE_HOME || path.join(os.homedir(), '.zcode')

// 本插件的数据目录：配置、服务与浮层运行信息写这里（与挂件的 ~/.zcode/whale 分开）
export const DATA_DIR = path.join(ZCODE_HOME, 'tps')
// 用户配置（port / stackGapPx / 自启开关等）
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json')
// hook 状态：记录「用户最后所处的会话」与最近提问时刻（--current 守卫用）
export const STATE_FILE = path.join(DATA_DIR, 'state.json')
// 浮层运行信息（pid / port）
export const OVERLAY_INFO_FILE = path.join(DATA_DIR, 'overlay.json')
// 服务运行信息（pid / port / url），供命令与 MCP 复用同一个服务
export const SERVER_INFO_FILE = path.join(DATA_DIR, 'server.json')
// 自启日志（确认「打开 ZCode 时方框有没有被自动拉起」）
export const AUTOSTART_LOG = path.join(DATA_DIR, 'autostart.log')

// ZCode 的用量库：model_usage / turn_usage 表提供每段模型请求的真实 token 与耗时
export const DB_FILE = path.join(ZCODE_HOME, 'cli', 'db', 'db.sqlite')
// ZCode 客户端配置：用于发现 dataBaseDir（会话日志所在根目录）
export const CLIENT_SETTING_FILE = path.join(ZCODE_HOME, 'v2', 'setting.json')
// 客户端日志目录的兜底位置：里面记着「用户打开了哪个会话」（v4.session_data.acquire），
// 是判断当前会话的唯一可读信号。实际目录还可能走 dataBaseDir，见 client-session.mjs。
export const CLIENT_LOG_DIR = path.join(ZCODE_HOME, 'v2', 'logs')

// 挂件（zcode-whale-widget）的数据目录：本插件复用它的 Electron 运行时、并读它对齐位置与字号。
export const WHALE_DATA_DIR = path.join(ZCODE_HOME, 'whale')
// 挂件 Electron 浮层的用户数据目录（Electron app name = zcode-whale-overlay），
// 里面 Local Storage 存着会话用量方框的记忆位置（zcw-box-pos）。
export const WHALE_OVERLAY_USERDATA = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'zcode-whale-overlay'
)

// 与挂件共用同一个 Electron 运行时（避免再下一份 ~150MB 的二进制）
export const WHALE_RUNTIME_DIR = path.join(WHALE_DATA_DIR, 'desktop-runtime')

export const DEFAULT_PORT = 39331

// 服务身份标识：健康检查与探活校验共用，改这里即可，别再各写一份字面量。
export const APP_ID = 'zcode-tps-widget'
