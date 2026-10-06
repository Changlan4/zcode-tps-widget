---
name: zcode-tps-widget
description: 操作与排查 ZCode 实时速度方框（本问即时输出速率 / 首 token 延迟 TTFT / 采样时刻，浮在会话用量方框正上方）。适用于：想看当前这一问模型输出多快（tok/s，含思考 token）、首 token 等了多久、采样发生在什么时候；把方框作为桌面浮层显示在 ZCode 界面之上（Electron 运行时复用会话用量方框挂件那一份）；启停方框服务、调整贴靠间距、配置端口或会话自启；以及方框不显示、位置不对、速率口径不清楚时的排查。
---

# ZCode 实时速度方框

本插件是**会话用量方框**（`zcode-whale-widget`）的速度孪生：UI 风格一致、紧贴在会话用量方框**正上方**（同左边缘、间隔 `stackGapPx`，宽度与字号跟随会话用量方框）。它显示「本问」的三项指标。

## 三项指标的口径

- **本问即时输出速率（tok/s）**：本问 = 当前会话最新的 `turn_id`（一次提问触发的全部模型请求共享同一个 turn_id，含「模型→工具→模型」的每一段）。
  - 速率 = Σ 本问各段 `output_tokens` ÷ Σ 各段**纯生成时长**，按段加权，**排除段间的工具等待**；单段时即该段速率。
  - **生成时长的取窗要分有没有思考 token**（关键，早期版本在这里算错过）：
    - 无思考的段（`reasoning_tokens = 0`）：`completed_at − first_token_at`（first_token 即首个输出 token）。
    - 有思考的段（`reasoning_tokens > 0`）：改用 `completed_at − started_at`。因为 ZCode 把 `first_token_at` 盖在「首个**回答** token」上，思考 token 是在它之前的窗口里生成的；若仍用 `completed − first_token`，整段思考生成时段被漏掉，速率会被夸大成物理上不可能的值（实测出现过 **9579 tok/s**，真值约 180）。改用整段 [started, completed] 后，分母覆盖思考+回答的全部生成时长。
  - **含思考 token**：ZCode 的 `output_tokens` 已包含 `reasoning_tokens`（已核对 `raw_usage_json`：`totalTokens = inputTokens + outputTokens`，`reasoningTokens` 是 `outputTokens` 的子集）。因此**直接用 `output_tokens`，不再加一次 `reasoning_tokens`**——重复相加会把速率抬高。
  - 无时序（`first_token_at` 为空）或生成时长落在 [150ms, 1h) 之外的段不计入分母。
- **首 token 延迟（TTFT）**：本问**第一段**的 `time_to_first_token_ms`。
- **采样时刻**：本问**最后一段**的 `completed_at`，即「最近一次工具调用之后」本问的落库时刻。

> ZCode 只在模型请求**完成时**才把记录落库，所以数据是「每段完成后刷新」；生成中沿用最近一段的值。

## 数据源

只读 `~/.zcode/cli/db/db.sqlite` 的 `model_usage` 表（`query_source = 'main_turn'`）。只统计主对话，不含子代理 / 标题生成 / 压缩。需要 Node 22.5+（内置 `node:sqlite`）。不写库、不联网。

## 刷新与当前会话

- 方框每 **2 秒**刷新一次。
- **当前会话 = 你此刻在客户端里打开的会话**：数据侧读客户端日志（`v4.session_data.acquire` / `conversation.subscribe.activated`，从最新日志文件增量扫描）确定会话 id；在 ZCode 里切换会话，方框会在 2 秒内跟着切到新会话，并做一次 600ms 补刷。日志读不到（例如日志目录不可达）时退回「最近有完成请求的会话」。
- **方框不会空掉**：每个会话最近一次的有效快照会缓存在浮层 `localStorage`（键 `zcw-tps-last-v1`）。切到还没产生新对话的会话、或本问尚未产生模型请求时，显示缓存里的**上轮数据**（脚注标「上轮数据 · …」、指标标签变「上轮输出」、圆点转琥珀色）；一旦有新数据立即刷新回本问。
- ZCode 只在模型请求**完成时**落库，所以数据是「每段完成后刷新」；生成中沿用最近一段。

## 位置与外观

- 方框**固定在**会话用量方框正上方：同一左边缘、垂直间隔 `stackGapPx`（默认 10px），宽度与会话用量方框一致（300 × 字号倍率），字号也跟随，做到两个方框「UI 长度一致、位置紧挨」。
- 锚点来自会话用量方框记住的位置（挂件 Electron 用户数据目录里的 `localStorage` 键 `zcw-box-pos`）与字号（同目录的 `zcw-box-view` 的 `scale`，默认 1）。读不到时退回工作区左上角。
- 桌面浮层透明、无边框、始终置顶、**默认鼠标穿透**（指针压到方框上才接管鼠标），并由常驻 PowerShell 脚本跟随 ZCode 主窗口移动/缩放。

## 常用命令

```bash
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" status    # 本问速率 + 服务/浮层状态 + 锚点
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" speed     # 只回本问速度单行
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" json      # 机器可读
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" start     # 启动网页版方框服务
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" window start   # 桌面浮层（贴在会话用量方框上方）
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" desktop install # 首次用浮层前装 Electron 运行时（已装过挂件的会复用）
```

`/speed` 命令做同样的事；MCP 工具为 `tps_speed` / `tps_widget` / `tps_config`。

## 排查

- **看不到方框**：ZCode 客户端不提供界面注入点，所以走桌面浮层。先 `window start`；提示「需要 Electron 运行时」时先 `desktop install`。
- **本问无数据**：方框**不会空掉**——切到还没产生新对话的会话、或纯问答轮尚未收尾时，会显示缓存里的**上轮数据**（脚注标「上轮数据 · 本会话暂无已完成的一问 / 本问尚未产生模型请求」，圆点琥珀色），有新数据立即刷新。`tps_speed` 工具默认同样返回最新可见的一轮，不因「本问暂无」而空手；需要严格「本问」（无数据就明确报无）时读 `/tps/speed.json?current=1`。
- **速率偏低**：本问有段缺少首字时序（`first_token_at` 为空）而被排除在分母外偏保守，属数据源限制。
- **速率异常偏高**：如果看到明显超出模型能力的值（如几千 tok/s），多为思考段取窗问题；本插件已按上面「有思考的段改用 `completed − started_at`」处理。可用 `node lib/cli.mjs speed` 复核。
- **位置不对**：方框贴在会话用量方框上方；若会话用量方框从未运行或从未移动过，锚点读不到，会停在左上角。先把用量方框拖到位，再双击速度方框刷新锚点。
- **两个方框重叠/间距不理想**：`tps_config` 的 `stackGapPx` 调整间隔。
- **配置目录**：`~/.zcode/tps/`（`config.json` / `state.json` / `overlay.json` / `server.json` / `autostart.log`）。
