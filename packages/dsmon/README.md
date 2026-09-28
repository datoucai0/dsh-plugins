# dsmon — DeepSeek 峰谷提醒 · 费用台账 · 服务器监控

面向 DeepSeek Harness Web GUI（profile `web`）的一个零依赖 Cordis 组合包插件。

**v0.2.0 起：金额不再是"估算"。** 宿主半区把每一次调用按其**发起时刻**判定峰谷、
按**官方价目表**逐笔计价，落盘成本地台账；浏览器只展示宿主算出的数字，
计价规则不再在客户端重复一份。

**v0.2.2 兼容 dsh 0.1.7 的会话日志换代**：dsh 0.1.7 起会话格式升到 v4，落盘文件名为
`session.v4.jsonl.zstd`（并把旧的 v3 文件保留在原处）。回填的文件索引现在按代际识别
`v4 / v3 / legacy` 三种文件名并优先取最新代，因此升级后本地日志回填照旧可用；若退回
0.1.5-rc.3，它会读回 v3 文件（历史会分叉：0.1.7 期间写入的事件只存在于 v4 文件里）。
**v0.2.1 修正回填完整性**：回填改为**直接读本地会话日志**（多帧 zstd 逐帧解码），
不再受 `sessionQuery` 的"只取最新 60 个会话"上限与重放校验失败影响；按日志 mtime
排序、未变更的日志直接跳过（同一进程只读一次，跨进程几乎零成本）；fork 切点由日志
自身的 `session/end-seed` 推导；读取失败的会话会**列出 id 与失败原因**，而不是只报
一个数字。修正前（v0.2.0）实测漏掉 6 个会话、09-15→09-23 少记 ¥16.42。

## 功能

### 1. 聊天输入框下方状态条（`conversation.composer.dock`）

- DeepSeek API **峰谷分时**文字提醒（北京时间，颜色标识）：
  - 🔴 高峰（原价）：**工作日**（周一至周五，不含法定节假日）`09:00–12:00`、`14:00–18:00`
  - 🟢 空闲（高峰半价）：其余所有时段，**含周末、调休上班的周末、法定节假日全天**
- 每分钟刷新北京时间，并倒计时到下一个时段切换点；
- 读取官方 `tokenUsage` 投影，显示**本次会话**输入/输出 Tokens；
- **本次会话已记账金额**：`已记账 ¥x.xx（模型 · N 次逐笔计费：高峰 ¥a / 空闲 ¥b）`，
  数据来自宿主台账 API `/dsmon/api/cost`，与 Harness 的 token 投影交叉展示；
- 台账读不到时不会静默：显示`台账不可用`或`台账离线`（保留上次结果并标注）。

### 2. "DeepSeek 监控"设置页（`settings.section`）

- **费用台账**（新增，置顶）：
  - KPI：今日 / 近 7 日 / 台账累计 / 高峰·空闲拆分；
  - **按日表**（北京时间，最近 14 天）：次数、输入/输出 tokens、高峰金额、空闲金额、合计；
  - **按会话表**（最近 10 个，高亮当前会话）：工作区、最后活动、次数、金额；
  - **当前会话**：金额、计费输入（未命中/命中）、输出、按模型的计费档；
  - **计价与台账说明**：价目表来源、生效方案、计价口径、台账文件路径、回填状态。
- **系统运行概况**：主机名 / OS / Node / 用户 / 开机时间 / 逻辑核心 / 运行时长；
- **性能总览**：CPU 使用率、内存占用与趋势曲线（近 2 分钟）、进程/线程总数；
- **进程与线程**：dsh web 启动链与整棵进程树（CPU/内存/线程数，可点开线程明细）；
- **资源占用细节**：CPU/内存最高的 15 个进程（含命令行）、本地磁盘用量。

## 计价口径（宿主实现，浏览器只展示）

价目来源：<https://api-docs.deepseek.com/zh-cn/quick_start/pricing/>
（2026-09 补充说明：调休上班的周末与法定节假日全天均按空闲时段计费）

| 模型 | 输入·缓存命中 | 输入·缓存未命中 | 输出 |
| --- | --- | --- | --- |
| `deepseek-flash`（空闲） | 0.02 | 1 | 4 |
| `deepseek-flash`（高峰） | 0.04 | 2 | 8 |
| `deepseek-v4-pro`（空闲） | 0.15 | 4.5 | 13.5 |
| `deepseek-v4-pro`（高峰） | 0.30 | 9.0 | 27.0 |

单位：元 / 百万 tokens。**高峰单价 = 空闲单价 × 2**（官方规则，代码里也只存空闲价再乘倍率）。

- **逐笔计价**：每次调用的金额 = 该次 usage × 该次**发起时刻**对应的时段倍率。
  时段按调用发起时刻（`step/start`、`llm/retry-started`）判定 —— 官方是在**请求到达时**
  计价，所以不用响应结算时刻（结算时刻也记录在台账里，仅作对照）。
- **计费分桶**：缓存命中输入按 `hit`；缓存未命中输入与缓存写入按 `miss`；
  输出按 `out`（`reasoningTokens` 已包含在 `outputTokens` 内，不重复计费）。
- **尝试口径与官方投影一致**：同一次尝试（同 `turn`+`step`）的后一个 usage 样本
  **替换**前一个；`llm/retry-started` 结束该槽位，因此重试是**第二笔**费用。
  另外还统计 `assistant/message` 之外的计费事件（如 `compaction/summary`），
  所以台账的 token 数会**大于**状态条上的 `tokenUsage` 投影 —— 后者不含压缩调用。
- **按时间分档（epoch）**：官方多次调价，故内置三档，各自覆盖其 `from` 之后：
  1. `2026-08-17` v4 峰谷（flash 空闲 0.05 / 1.5 / 4.5）
  2. `2026-08-23` 同一价目，但**周末全天计入空闲**
  3. `2026-09-10 12:00` flash 系列降价（本表上方的现行价），周末 + 法定节假日全天空闲
- **路由归一**：旧模型名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 仍可调用，
  但官方已由 DeepSeek-V4.1-Flash 提供服务并按 Flash 档计费，故归一到 `deepseek-flash`。
- **未知模型**：价目表未覆盖的路由按 `fallback`（默认 flash）计价，但会在状态条与
  监控页明确标注`未单独定价`，不会静默按默认档。

### 自定义价目表（改价不用改代码、不用重启）

在 `$DSH_HOME/dsmon-prices.json` 放一个覆盖文件即可，宿主每 5 秒检查一次修改时间：

```json
{
  "note": "2026-10-01 起的自定价格",
  "peakWindows": [[540, 720], [840, 1080]],
  "holidays": [["2026-10-01", "2026-10-07"], "2027-01-01"],
  "fallback": "deepseek-flash",
  "routes": { "deepseek-v4-pro": "deepseek-v4-pro" },
  "epochs": [
    {
      "from": "2026-09-10T12:00:00+08:00",
      "name": "peak-valley-0910",
      "weekendsIdle": true,
      "holidaysIdle": true,
      "peakMultiplier": 2,
      "models": {
        "deepseek-flash": { "hit": 0.02, "miss": 1, "out": 4 },
        "deepseek-v4-pro": { "hit": 0.15, "miss": 4.5, "out": 13.5 }
      }
    }
  ]
}
```

- `models` 填的是**空闲时段**单价（元 / 百万 tokens，键名 `hit`/`miss`/`out`），
  高峰价 = `× peakMultiplier`（默认 2）；也接受 `{"idle": {...}}` 写法。
- 省略的键沿用内置值；`epochs` 一旦给出就整体替换内置分档。
- 节假日写 `"YYYY-MM-DD"` 或 `["开始", "结束"]`；内置 2026 年放假安排
  （国办发明电〔2025〕7 号），共 33 天。
- 内置节假日表只覆盖 2026 年：跨年后请在覆盖文件里补上新一年的放假安排。

### 台账与统计

- 落盘：`$DSH_HOME/logs/dsmon-cost-ledger.json`（记账状态 + 每笔明细，原子写：临时文件 + 改名）
- 汇总：`$DSH_HOME/logs/dsmon-cost-daily.csv`（按日，Excel 友好，表头 ASCII）
- 保留策略：明细保留 120 天、每会话最多 4000 笔、最多 200 个会话（超出即裁剪并在页面说明）；
- **历史回填**：本进程第一次请求 `/dsmon/api/cost` 时启动一次，经 `ctx.sessionQuery`
  按最新优先顺序**逐个**读取已存档会话（最多 60 个，每次调用之间让出 150 ms），
  完成后"今日 / 近 7 日 / 累计"才是全量。状态条在回填期间显示`回填中 d/t`。
  宿主没有 `sessionQuery` 时如实标注`历史回填不可用`，只统计本进程活跃过的会话。
- **fork 不重复计费**：子会话日志若包含父会话前缀，按 `inheritedEventCount`（fork 切点）
  跳过继承部分，避免同一笔调用被父子会话各记一次。

## API（宿主半区，同源 `/dsmon`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsmon/health` | 存活检查 |
| GET | `/dsmon/api/snapshot` | 系统/性能/进程树/磁盘快照（3 s 节流） |
| GET | `/dsmon/api/threads?pid=` | 指定进程线程明细（最多 400 条） |
| GET | `/dsmon/api/cost` | 台账总览：价目表、当前时段、今日/近 7 日/累计、按日、按模型、按会话、回填状态 |
| GET | `/dsmon/api/cost?sessionId=` | 同上，并附该会话的逐笔明细汇总（金额、高峰/空闲、按日、按模型、最近 12 笔） |

只读接口；台账写入只发生在宿主内部（会话事件 + 回填），不接受客户端提交。

## 文件布局

```text
dsmon/
├── package.json        # dsh.bundle.patch + dsh.client(platform web) 元数据
├── cordis.patch.yml    # 组合树插入行：id/name = dsmon
├── lib/
│   ├── index.js        # host 半区：/dsmon API、采样器、计价模型、费用台账、历史回填
│   └── client.js       # browser 半区：ModuleLoader 经典脚本（无构建步骤）
└── README.md
```

- Host 半区零第三方依赖（Node 内置 + PowerShell/CIM）；Client 半区只 `require("react")`。
- 客户端只保留一份**窗口判定**的纯函数（消费宿主下发的 `peakWindows` / `holidays` /
  `epochs`），用于每秒跳动倒计时；金额一律来自宿主。

## 安装 / 更新 / 移除

```powershell
# 1) 包放入 profile 的 node_modules
Copy-Item -Recurse -Force dsmon "$env:DSH_HOME\profiles\web\node_modules\dsmon"

# 2) 在 profiles/web/package.json 的 dsh.profile.bundles 追加 "dsmon"

# 3) 验证组合树包含该行
node "$env:DSH_HOME\dsh-015\node_modules\@deepseek-ai\dsh\lib\bin.js" --profile web --dump-config
#    … - id: dsmon / name: dsmon …

# 4) 重启 dsh web（按既定流程：脱树重启器 restart-dsh-web-safe.ps1），浏览器硬刷新
#    Settings → "DeepSeek 监控"
```

移除：从 bundles 列表删除 `"dsmon"` 并删除 `profiles/web/node_modules/dsmon`，重启即可。
注意：`pnpm install` 可能清理未登记的 node_modules 目录，届时重跑第 1 步。

## 验证

宿主半区（离线，假 Cordis 上下文 + 真实会话日志 + 真实 HTTP handler）：

```powershell
node test-host-cost.mjs "$env:DSH_HOME\sessions\<workspace>\<session>\session.v3.jsonl.zstd"
# 22 项：路由/订阅、回填、逐笔计价（高峰 ¥10 / 空闲 ¥5）、幂等、落盘、CSV、
#        自定义价目表、404/405、历史回填与 fork 切点
```

客户端半区（无浏览器：迷你 React hooks + 假 fetch + 真实渲染）：

```powershell
node smoke-client.mjs
# 16 项：注册、样式、baseline 依赖、占位/离线/回填状态、
#        高峰/周末/节假日三种时段文案、未定价模型、监控页表格与说明
```

在线验证：

- `/plugins/dsmon/client.js` 返回 200 且含 `window.__ModuleLoader__.load`；
- `/dsmon/api/snapshot`、`/dsmon/api/cost`、`/dsmon/health` 返回预期 JSON；
- 页面：输入框下方出现彩色时段条与`已记账`金额；设置内"DeepSeek 监控"页首屏是费用台账；
- 控制台无 slot/加载报错。

## 已知限制

- 台账只覆盖**能被会话日志记录**的 token 花费。不走持久会话的模型调用（如果有）与
  非 token 类支出（例如外部搜索 API）不在其中，因此台账金额可能低于平台账单总额。
- 峰谷判定用调用**发起时刻**；一次恰好跨过切换点的长响应会整体归到发起时的时段。
- 单价来自内置价目表；官方调价后需更新内置表或放一份 `dsmon-prices.json`。
  价目表只内置到 2026 年（节假日同理），跨年请补。
- 历史回填每个进程最多 60 个会话（最新优先），更早的会话只在被打开时进入台账。
- Windows 采样经 PowerShell/CIM，首次全量进程枚举可能消耗数十毫秒；页面 3 秒节流重采样。
- 非 Windows 主机降级为 Node 系统信息（进程树采样不可用，页面显示告警而不崩溃）。
