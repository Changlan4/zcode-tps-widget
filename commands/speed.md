---
description: 查看本问实时输出速率、首 token 延迟、采样时刻，或启停实时速度方框服务与桌面浮层
argument-hint: "[status|speed|start|stop|json|url|window start|window stop]"
allowed-tools: Bash, mcp__tps__tps_speed, mcp__tps__tps_widget, mcp__tps__tps_config
---

用户请求操作 ZCode 的**实时速度方框**（浮在 ZCode 界面上的面板，贴在「会话用量方框」正上方，显示本问即时输出速率、首 token 延迟、采样时刻）。参数：`$ARGUMENTS`

背景：方框的数字来自本地用量库，**没有对应的 MCP 工具时**可直接读 `http://127.0.0.1:<port>/tps/speed.json`（`node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" json` 会给出端口），或让用户看屏幕上的方框。

按参数分派：

- 空 / `status`：调用 `tps_widget`（`action=status`）报告服务与浮层是否在运行、地址是什么；再调用 `tps_speed` 报告本问速率、首 token 延迟、采样时刻。
- `speed`：调用 `tps_speed`，报告本问速率（tok/s，含思考 token）、首 token 延迟（TTFT）、采样时刻。
- `start`：调用 `tps_widget`（`action=start`），把返回的地址告诉用户，并提示用浏览器打开即可看到方框。
- `stop`：调用 `tps_widget`（`action=stop`）。
- `url`：调用 `tps_widget`（`action=url`），只回地址。
- `window start`：调用 `tps_widget`（`action=overlay_start`），把方框作为**桌面浮层**显示在 ZCode 界面之上（透明置顶、默认鼠标穿透，贴在会话用量方框上方）。若返回「需要 Electron 运行时」，就让用户在终端执行 `node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" desktop install`（若装过用量方框挂件则会复用同一份运行时）后重试。
- `window stop`：调用 `tps_widget`（`action=overlay_stop`）。
- `window status`：调用 `tps_widget`（`action=overlay_status`）。

若 MCP 工具不可用（例如插件刚装好还没重启会话），退回命令行：

```bash
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" status          # 或 speed / json / start / stop / url
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" window start    # 桌面浮层（浮在 ZCode 上）
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" desktop install # 首次使用浮层前安装 Electron 运行时
```

输出要求：中文，先给结论（服务/浮层是否正常、本问速率多少），再补充首 token 延迟与采样时刻。说明速率口径：**本问**即时速率 = 本轮各段总产出 / 总纯生成时长（按段加权，排除工具等待），分子含思考 token；采样时刻是「最近一次工具调用之后」本问最后一段的落库时刻。方框跟随你在客户端里打开的会话（切换会话后 2 秒内跟上），且**不会空掉**——切到还没产生新对话的会话时显示缓存的上轮数据（脚注标「上轮数据」）。用户问「为什么界面上看不到方框」时，说明 ZCode 客户端不提供界面注入点，所以用桌面浮层窗口实现，并给出 `window start` 或 `desktop install` 的确切命令。
