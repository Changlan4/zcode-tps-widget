# ZCode 实时速度方框（zcode-tps-widget）

ZCode 会话里**当前这一问**模型输出有多快？本插件把答案做成一个常驻方框，浮在
ZCode 界面之上，**紧贴在「会话用量方框」正上方**，UI 风格与它保持一致、位置紧挨：
会话用量方框看「这一问花了多少」，实时速度方框看「这一问跑得多快」。

它参考了两个社区项目的数据口径思路：

- [shy3130/zcode-tps-monitor](https://github.com/shy3130/zcode-tps-monitor)（`turn_id` 口径、`--current` 守卫、每段加权）
- [yujuntea/zcode-tps-marketplace](https://github.com/yujuntea/zcode-tps-marketplace)（`decode 口径`、只读 `model_usage`）

并在 ZCode 的数据库上做了修正（见下「口径」）。

## 显示什么

| 字段 | 含义 |
| --- | --- |
| **本问即时输出速率** | 本问各段总产出 ÷ 各段纯生成时长（tok/s，**含思考 token**，多段按段加权、排除工具等待） |
| **首 token 延迟（TTFT）** | 本问**第一段**的首字延迟 |
| **采样时刻** | 本问**最后一段**的完成时刻（最近一次工具调用之后） |

方框显示：本问输出速率（大数字）、首 token 延迟、本问输出（含思考 token）、采样时刻，另附当前模型。

## 口径（为什么和参考项目略有不同）

- **本问 = 当前会话最新的 `turn_id`**。一次提问触发的全部模型请求共享同一个
  `turn_id`，含「模型 → 工具 → 模型」的每一段。
- **速率 = Σ 段产出 ÷ Σ 段纯生成时长**，即按段加权；段间的工具等待不进分母。
  **纯生成时长的取窗分两种**：无思考的段用 `completed_at − first_token_at` 起算；
  **有思考 token 的段改用 `completed_at − started_at`**——因为 `first_token_at` 被盖在
  「首个回答 token」上，思考 token 在它之前生成，若仍用 `completed − first_token`
  会漏掉整段思考生成时长、把速率夸大成物理不可能的值（实测出现过 9579 tok/s）。
- **含思考 token**：ZCode 的 `output_tokens` **已经包含** `reasoning_tokens`。核对
  `raw_usage_json` 得 `totalTokens = inputTokens + outputTokens`，`reasoningTokens`
  是 `outputTokens` 的子集。所以本插件**直接用 `output_tokens`，不再加一次
  `reasoning_tokens`**——参考项目的 `output + reasoning` 会重复计数、把速率抬高。
- 只有 `first_token_at` 存在、且生成时长落在 [150ms, 1h) 区间的段计入分母。
- **只统计主对话**（`query_source = 'main_turn'`），不含子代理 / 标题生成 / 压缩。
- **当前会话 = 你此刻在客户端里打开的会话**（读客户端日志 `v4.session_data.acquire`）；
  在 ZCode 里切换会话，方框会在 2 秒内跟着切到新会话。日志读不到时退回「最近有完成
  请求的会话」。
- **方框不会空掉**：每个会话最近一次的有效快照缓存在浮层 `localStorage`；切到还没
  产生新对话的会话、或本问尚未产生模型请求时，显示缓存里的**上轮数据**（脚注标
  「上轮数据 · …」、标签变「上轮输出」、圆点转琥珀色），有新数据立即刷新回本问。
- 方框每 **2 秒**刷新一次。
- ZCode 只在模型请求**完成时**落库，所以数据是「每段完成后刷新」；生成中沿用最近一段。

## 位置与外观

- 方框**固定在**会话用量方框正上方：同左边缘、垂直间隔 `stackGapPx`（默认 10px），
  宽度与字号跟随会话用量方框（同为 300 × 字号倍率的基准），两个方框长度一致、上下相邻。
- 锚点读自会话用量方框记住的位置（挂件 Electron 用户数据里的 `localStorage` 键
  `zcw-box-pos`）与字号（同目录的 `zcw-box-view` 的 `scale`，默认 1）。
- 桌面浮层透明、无边框、始终置顶、**默认鼠标穿透**，由常驻 PowerShell 脚本跟随
  ZCode 主窗口。

## 安装

### 前置条件

- ZCode 客户端（插件系统）
- Node.js 22.5+（插件用的是 Node 内置 `node:sqlite`；`node -v` 能跑即可）
- Windows（桌面浮层依赖 Win32 窗口 API；网页版方框跨平台）

### 从 GitHub 安装

```bash
git clone https://github.com/Changlan4/zcode-tps-widget.git ~/.zcode/plugins/zcode-tps-widget
```

后面的命令都假设你在仓库根目录下执行。接着**注册为本地插件市场**（二选一）：

- **界面**：设置 → 插件管理 → **发现** → 右上角 `+` → 选择**本地目录**，指向仓库根目录（内含 `marketplace.json`）。
- **手工**：在 `~/.zcode/cli/plugins/known_marketplaces.json` 的 `marketplaces` 数组里追加

  ```json
  {
    "id": "zcode-tps-local",
    "source": { "source": "directory", "path": "<仓库绝对路径>" },
    "name": "zcode-tps-local",
    "description": "Local marketplace for the ZCode live speed box.",
    "pluginCount": 1
  }
  ```

然后**安装并启用** `zcode-tps-widget`，**重启会话**让 MCP 与 hook 生效。

> **重要：改代码后要同步到缓存。** 插件安装时会把仓库**复制**一份到
> `~/.zcode/cli/plugins/cache/zcode-tps-local/zcode-tps-widget/<版本>/`，
> MCP、hook、浮层全部跑缓存那份。改了 clone 里的代码必须同步过去（或重装插件）才生效。

> 本插件是**会话用量方框**（[`zcode-whale-widget`](https://github.com/Changlan4/zcode-whale-widget)）
> 的配套：它复用那一份 Electron 运行时、并把方框贴在用量方框**正上方**。只装本插件也能跑，
> 但没有用量方框时锚点读不到，方框会停在左上角。

## 使用

安装后：

```
/speed            # 本问速率 + 服务/浮层状态
/speed window start   # 把方框作为桌面浮层贴在会话用量方框上方
```

命令行（`${ZCODE_PLUGIN_ROOT}` 换成插件安装目录）：

```bash
node lib/cli.mjs status          # 本问速率 + 服务/浮层状态 + 锚点
node lib/cli.mjs speed           # 只回本问速度单行
node lib/cli.mjs json            # 机器可读
node lib/cli.mjs window start    # 桌面浮层
node lib/cli.mjs desktop install # 首次用浮层前装 Electron 运行时（已装过挂件会复用同一份）
```

MCP 工具：`tps_speed` / `tps_widget` / `tps_config`。

## 依赖与数据

- Node **22.5+**（使用内置 `node:sqlite`）。
- 只读 `~/.zcode/cli/db/db.sqlite` 的 `model_usage` 表；**不写库、不联网**。
- 桌面浮层复用会话用量方框挂件已装的 Electron 运行时（`~/.zcode/whale/desktop-runtime`），
  不额外下载。
- 自身数据在 `~/.zcode/tps/`：`config.json` / `state.json` / `overlay.json` /
  `server.json` / `autostart.log`。

## 配置

`~/.zcode/tps/config.json`（或用 `tps_config` / `/speed`）：`port`、`stackGapPx`（贴靠间距）、
`autoStartWidget` / `autoStartOverlay`（会话自启）、`followIntervalMs`（跟随探测间隔）。

## 许可

MIT。数据口径思路参考上述两个 MIT 项目；浮层定位/穿透/合成自愈机制移植自同作者的
会话用量方框挂件（`zcode-whale-widget`）。
