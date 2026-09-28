# 00 总览：结构说明与搬迁对照

## 一、当前结构（2026-09-29 标准化之后）

```
dsh-plugins/
├── README.md / CHANGELOG.md / .gitignore
├── packages/        dsmon, dsh-message-preview, dsh-drag-and-drop, dsh-file-mentions, dsh-local-kit
├── scripts/         build.mjs（生成合并包）, verify.mjs（校验）
├── templates/       dsh-local-kit.README.md（合并包 README 模板）
└── docs/            00_总览/ , 合并技术契约.md , 新增功能指南.md
```

## 二、搬迁对照表（2026-09-29）

| 搬迁前 | 搬迁后 |
|---|---|
| `dsh-plugins/dsmon/` | `dsh-plugins/packages/dsmon/` |
| `dsh-plugins/dsh-message-preview/` | `dsh-plugins/packages/dsh-message-preview/` |
| `dsh-plugins/dsh-drag-and-drop/` | `dsh-plugins/packages/dsh-drag-and-drop/` |
| `dsh-plugins/dsh-file-mentions/` | `dsh-plugins/packages/dsh-file-mentions/` |
| `dsh-plugins/dsh-local-kit/` | `dsh-plugins/packages/dsh-local-kit/` |
| `dsh-plugins/build-local-kit.mjs` | `dsh-plugins/scripts/build.mjs` |
| `dsh-plugins/_verify-kit.mjs` | `dsh-plugins/scripts/verify.mjs` |
| `dsh-plugins/dsh-local-kit.README.md` | `dsh-plugins/templates/dsh-local-kit.README.md` |

> 更早的一次搬迁（2026-09-29 同日）：4 个插件从
> `Documents\实际问题处理\{DSH插件开发\dsmon, plugins-local\*}` 搬到 `C:\Users\Administrator\dsh-plugins\`
> —— 见 `C:\Users\Administrator\.dsh\changes\2026-09-29-C-consolidate-dirs.md`。

## 三、搬迁纪律（本项目沿用既有归档规范）

1. **搬迁前先做全量快照**（文件名 + 字节数 + SHA256）；
2. 搬迁用 `git mv`/`Move-Item`，**不删不覆盖**；
3. 搬完**逐项对账**（文件名 + 字节数 + 哈希）；
4. **同步修正脚本/文档里的路径引用**（本次修正了 `scripts/build.mjs`、`scripts/verify.mjs`、profile 依赖）；
5. **回归验证**：`node scripts/verify.mjs`，并对构建脚本做"重建后产物哈希一致"验证。
