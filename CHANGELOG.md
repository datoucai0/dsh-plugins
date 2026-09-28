# 变更记录

## 2026-09-29

### 结构调整（本工程标准化）
- 工程重构为标准布局：`packages/`（5 个包）、`scripts/`（构建+校验）、`templates/`（README 模板）、`docs/`（文档）。
- 搬迁前做过全量快照（141 个文件 / 884,103 字节 / 含 SHA256）：
  `C:\Users\Administrator\.dsh\changes\2026-09-29-D-inventory-before.txt`
- 基线提交（可用 `git reset --hard <hash>` 回到搬迁前布局）：
  `C:\Users\Administrator\.dsh\changes\2026-09-29-D-baseline-commit.txt`
- `build-local-kit.mjs` → `scripts/build.mjs`；`_verify-kit.mjs` → `scripts/verify.mjs`；
  `dsh-local-kit.README.md` → `templates/dsh-local-kit.README.md`。
- 同步修正：构建脚本的 `SRC`/`OUT`/README 模板路径；profile 依赖路径改为 `packages/dsh-local-kit`。

### dsh-local-kit v1.0.0
- 由 `dsmon` + `dsh-message-preview` + `dsh-drag-and-drop` + `dsh-file-mentions` 合并为一个 bundle。
- 中文简介（插件管理可见）；新增 `README.md`。
- 构建脚本增强（依赖保留解析 + `conversation.chat.turnTail` LIST slot 兼容补丁）——
  该增强由外部（OpenClaw）提供，本工程只做增量、不覆盖其逻辑。
- 依赖：`@deepseek-ai/schemastery@3.18.4`、`zod@3.25.76`（4 个源插件卸载后仍需保留）。
