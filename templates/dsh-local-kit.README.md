# dsh-local-kit

**本地插件合集 v1.0.0** —— 把 4 个独立插件合并为**一个** DSH bundle：装一次，4 个功能全都有。

## 包含的功能

| 功能 | 来源插件 | 说明 |
|---|---|---|
| **DeepSeek 峰谷时段与费用监控** | dsmon | 输入框下方的峰谷/费用条（北京时间价窗 + 倒计时 + 本会话花费）；设置页「DeepSeek 监控」含费用台账（今日/7 天/累计、按天按会话）、系统概览、性能与进程线程树、磁盘用量 |
| **侧边栏消息预览** | dsh-message-preview | 列出当前会话已发送的消息与摘要，点击即可让对话跳到那条消息 |
| **拖拽文件插入路径** | dsh-drag-and-drop | 把本地文件拖进网页界面，直接插入文件的**原始路径**（不上传、不复制文件本体） |
| **回复中文件路径可点击** | dsh-file-mentions | 回复里的行内文件路径可直接打开文件/目录（Codex 风格），并提供「已提及文件」列表兜底 |

## 为什么合并

原来 4 个插件 = 4 个 profile 条目 + 4 个目录 + 4 份版本管理；合并后 = **1 个条目 + 1 个目录**，可整体版本化。

## 技术要点（合并时必须遵守的硬约束）

- **客户端注册 id 必须等于包名/图行 id**：`ClientBundleRegistration.id` 的语义是 *"must match the graph row being executed"*。
  因此**不能把 4 个 client 脚本直接拼接**（会注册成非图行 id → UI 不激活）；必须做成
  「以 `dsh-local-kit` 为 id 的**单一注册**，把 4 个功能体各自包进自己的 IIFE」。
- **client 的 `inject` 是 cordis 服务名**（`slots` / `locale` / `sessions`），不是包名；
  包名属于 `package.json` 的 `dsh.client.inject`（boot graph 用）。
- **host 半边**：一个 `apply(ctx)` 依次 apply 4 个功能的 host 半边，`inject` 取并集（`webServer`、`sessions`）。
- **构建方式**：`../build-local-kit.mjs` 从 4 个源插件机械抽取
  —— 复制各自 `lib/` 到 `lib/features/<name>/`，抽取 client 工厂体（锚点：每个文件以 `return module.exports;` 结束），
  生成合并的 `lib/index.js` 与 `lib/client.js`，并写出 `package.json` / `cordis.patch.yml`。

## 版本

| 版本 | 日期 | 内容 |
|---|---|---|
| v1.0.0 | 2026-09-29 | 首次合并；4 个功能行为与原独立插件一致 |

## 安装 / 卸载

```powershell
# 安装（profile 里只需这一条，替代原来的 4 条）
dsh plugin --profile web add "file:C:/Users/Administrator/dsh-plugins/dsh-local-kit"

# 卸载并退回 4 个独立插件（回滚）
dsh plugin --profile web remove dsh-local-kit
dsh plugin --profile web add "file:C:/Users/Administrator/dsh-plugins/dsmon" `
  "file:C:/Users/Administrator/dsh-plugins/dsh-message-preview" `
  "file:C:/Users/Administrator/dsh-plugins/dsh-drag-and-drop" `
  "file:C:/Users/Administrator/dsh-plugins/dsh-file-mentions"
```

> 增删插件后务必做**四层核验**：`dependencies` / `dsh.profile.bundles` / `node_modules/<包名>` / `pnpm-lock.yaml`。
> 详见 `C:\Users\Administrator\.dsh\changes\RULES.md`。

## 来源

合并自 4 个源插件（仍在 `C:\Users\Administrator\dsh-plugins\` 下保留，可单独使用）：
`dsmon`、`dsh-message-preview`、`dsh-drag-and-drop`、`dsh-file-mentions`。
