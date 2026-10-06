// UserPromptSubmit 钩子：记下「本问」的提问时刻，供 --current 守卫判断
// 「最新一问是否已经产生了模型请求」。每次提问都会覆盖 promptTs，所以换到新一问后
// 方框会先显示「本问尚未产生模型请求」，等本问第一段落库后才显示速率——绝不会把
// 上一轮的数字冒充本问。
//
// 作为 ZCode 的 UserPromptSubmit hook 运行。hook 的 stdout 会被当作 JSON 严格校验，
// 所以这里全程静默。
import { writeState } from './config.mjs'

try {
  const envSid = String(process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || '').trim()
  const patch = { promptTs: Date.now() }
  if (envSid) patch.sessionId = envSid
  writeState(patch)
} catch (err) {
  // 记录失败不能影响提问流程
}
