# dsh-plugins —— 本机 DSH 本地插件工程

本目录是**本机所有自用/本地 DSH 插件的开发工程**（一个 git 仓库）。以后新功能、新插件都在这里开发。

## 目录结构（标准布局）

```
dsh-plugins/                        ← 工程根（git 仓库）
├── README.md                       ← 本文件：总索引
├── CHANGELOG.md                    ← 变更记录
├── .gitignore
├── packages/                       ← 各个插件包（源）
│   ├── dsmon/                      ← 峰谷时段与费用监控
│   ├── dsh-message-preview/        ← 侧边栏消息预览
│   ├── dsh-drag-and-drop/          ← 拖拽文件插入路径
│   ├── dsh-file-mentions/          ← 回复中文件路径可点击
│   └── dsh-local-kit/              ← 【构建产物】4 合 1 合并包（生产在装）
├── scripts/
│   ├── build.mjs                   ← 由 4 个源包生成合并包
│   └── verify.mjs                  ← 严格 UTF-8 校验（路径/文案/元数据/README）
├── templates/
│   └── dsh-local-kit.README.md     ← 合并包 README 模板（重建时自动拷入）
└── docs/
    ├── 00_总览/README.md           ← 结构说明 + 搬迁对照表
    ├── 合并技术契约.md              ← 合并必须遵守的硬约束（改代码前必读）
    └── 新增功能指南.md              ← 以后加新功能的操作步骤
```

## 从 GitHub 安装（公开版）

```powershell
# 1) 克隆
git clone https://github.com/datoucai0/dsh-plugins.git $HOME\dsh-plugins
cd $HOME\dsh-plugins

# 2) 构建四合一包
node scripts/build.mjs

# 3) 装进 DSH（把 <你的用户目录> 换成实际路径）
dsh plugin --profile web add "file:<你的用户目录>/dsh-plugins/packages/dsh-local-kit"
```

也可以只装单个插件（`packages/` 下任选）：

```powershell
dsh plugin --profile web add "file:<你的用户目录>/dsh-plugins/packages/dsmon"
```

## 快速开始

```powershell
# 1) 构建合并包（把 packages/ 下 4 个功能合进 dsh-local-kit）
node scripts/build.mjs

# 2) 校验（路径、中文说明、模板、源包与安装副本元数据）
node scripts/verify.mjs

# 3) 装进 DSH（profile = web）
dsh plugin --profile web remove dsh-local-kit
dsh plugin --profile web add "file:C:/Users/Administrator/dsh-plugins/packages/dsh-local-kit"
```

> ⚠️ 增删插件后必须做**四层核验**：`dependencies` / `dsh.profile.bundles` / `node_modules/<包名>` / `pnpm-lock.yaml`。
> 详见 `C:\Users\Administrator\.dsh\changes\RULES.md`。

## 与 DSH 生产环境的关系

| 项 | 值 |
|---|---|
| 生产 profile | `C:\Users\Administrator\.dsh\profiles\web` |
| 生产依赖 | `dsh-local-kit: file:C:/Users/Administrator/dsh-plugins/packages/dsh-local-kit` |
| 试验 profile | `C:\Users\Administrator\.dsh\profiles\local-kit-test`（端口 3081，用于新功能隔离验证） |
| 生产 GUI | `http://127.0.0.1:3080`（token 见桌面 `DSH-URL.txt`） |

## 铁律（改任何东西之前先读）

见 `C:\Users\Administrator\.dsh\changes\RULES.md`：
1. **改动第一件事 = 存档**（写清改了什么/原值/怎么回滚/怎么验证）；
2. **需重启的改动必须带回滚物，且保留 10 天**；
3. **核验必须到底层**（插件四层；容器配置看容器内实际读到的文件）。

## 源插件仓库来源（外部来源标注）

| 包 | 本地性质 |
|---|---|
| `dsmon` | 本机自研 |
| `dsh-message-preview` | 外部来源（上游 `github.com/asukasec/dsh-message-preview`）本地化 |
| `dsh-drag-and-drop` | 外部来源（上游 `github.com/omdsh-dev/dsh-drag-and-drop`）本地化 |
| `dsh-file-mentions` | 外部来源（上游 `github.com/a903067276-rgb/dsh-file-mentions`）本地化 |

三个外部来源均为宽松许可（MIT / BSD-3-Clause），本地化版本保留原 LICENSE 文件，再分发需保留署名。`dsmon` 为本机自研。

## 许可证

本工程整体以 MIT 发布（见根目录 `LICENSE`）。各包以自身 `LICENSE` 为准：

| 包 | 许可证 |
| --- | --- |
| `dsmon` | MIT |
| `dsh-message-preview` | MIT |
| `dsh-drag-and-drop` | BSD-3-Clause |
| `dsh-file-mentions` | MIT |
| `dsh-local-kit` | MIT（由上述四个包合并生成） |
