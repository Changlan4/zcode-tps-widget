// 锚点：读出「会话用量方框」此刻的位置与字号，作为速度方框的贴靠基准。
//
// 会话用量方框（挂件 zcode-whale-widget）把两样东西写在 Electron 浮层用户数据目录下的
// Local Storage（LevelDB）里：
//   - zcw-box-pos  { left, top, ... }  位置（DIP，相对 ZCode 视口）
//   - zcw-box-view { scale }           字号倍率（Ctrl+滚轮缩放写入；没缩放过就没有这个键）
//
// 注意：不要用 ~/.zcode/whale/widget-state.json 里的 scale —— 那是网页版小鲸鱼挂件的
// 大小，和会话用量方框无关；方框真正的大小只看 zcw-box-view，缺省即 1（宽 300、字 13px）。
//
// 这里只读这两样，不改动挂件任何数据。读不到就返回 anchor:null，前端退回左上角常量位。
import fs from 'node:fs'
import path from 'node:path'
import { WHALE_OVERLAY_USERDATA } from './paths.mjs'

const POS_KEY = 'zcw-box-pos'
const VIEW_KEY = 'zcw-box-view'

// 从 LevelDB 文件里取某个键最后一次写入的 JSON 值。
// .log 是追加写（越靠后越新）；.ldb 是压实后的排序段。按文件 mtime 升序遍历，
// 后出现的覆盖先出现的，得到全局最新值。键与值之间只有极短的二进制前缀。
function readLevelDbValue(userDataDir, key) {
  const dir = path.join(userDataDir, 'Local Storage', 'leveldb')
  let files = []
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => /\.(log|ldb)$/i.test(f))
      .map((f) => {
        const full = path.join(dir, f)
        let mtime = 0
        try {
          mtime = fs.statSync(full).mtimeMs
        } catch (err) {}
        return { full, mtime }
      })
      .sort((a, b) => a.mtime - b.mtime)
  } catch (err) {
    return null
  }

  let best = null
  for (const f of files) {
    let text
    try {
      text = fs.readFileSync(f.full).toString('latin1')
    } catch (err) {
      continue
    }
    let idx = 0
    while ((idx = text.indexOf(key, idx)) !== -1) {
      const rest = text.slice(idx + key.length)
      const start = rest.indexOf('{')
      if (start > -1 && start < 40) {
        let depth = 0
        let end = -1
        for (let i = start; i < rest.length; i++) {
          const ch = rest[i]
          if (ch === '{') depth++
          else if (ch === '}') {
            depth--
            if (depth === 0) {
              end = i
              break
            }
          }
        }
        if (end > -1) {
          try {
            const val = JSON.parse(rest.slice(start, end + 1))
            if (val && typeof val === 'object') best = val
          } catch (err) {}
        }
      }
      idx += key.length
    }
  }
  return best
}

// 会话用量方框的位置（DIP，相对 ZCode 视口）。读不到返回 null。
export function whaleAnchor() {
  const pos = readLevelDbValue(WHALE_OVERLAY_USERDATA, POS_KEY)
  if (!pos || !isFinite(pos.left) || !isFinite(pos.top)) return null
  return { left: Number(pos.left), top: Number(pos.top) }
}

// 会话用量方框的字号倍率：取 zcw-box-view.scale，缺省 1（等于方框默认大小）。
export function whaleScale() {
  const view = readLevelDbValue(WHALE_OVERLAY_USERDATA, VIEW_KEY)
  const s = view && Number(view.scale)
  return isFinite(s) && s > 0 ? Math.min(2.4, Math.max(0.7, s)) : 1
}

// 给前端的锚点负载：位置 + 缩放 + 间距 + 数据来源说明。
export function anchorPayload(gapPx) {
  const scale = whaleScale()
  const anchor = whaleAnchor()
  return {
    ok: true,
    anchor: anchor || null,
    whaleScale: scale,
    gapPx: isFinite(gapPx) ? gapPx : 10,
    source: anchor ? 'whale-localstorage' : 'none',
    updatedAt: Date.now(),
  }
}
