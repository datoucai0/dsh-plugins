// _verify-kit.mjs - 严格 UTF-8 校验（PowerShell 读中文不可靠，一律用 Node 核对）
import { readFileSync, existsSync } from "node:fs";

const SCRIPT = "C:/Users/Administrator/dsh-plugins/build-local-kit.mjs";
const INST = "C:/Users/Administrator/.dsh/profiles/web/node_modules/dsh-local-kit";
const SRC = "C:/Users/Administrator/dsh-plugins/dsh-local-kit";

const script = readFileSync(SCRIPT, "utf8");
console.log("[build-local-kit.mjs]");
console.log("  含中文说明        :", script.includes("本地插件四合一"));
console.log("  SRC 指向新 ASCII  :", script.includes('const SRC = "C:/Users/Administrator/dsh-plugins"'));
console.log("  README 模板逻辑   :", script.includes("dsh-local-kit.README.md"));
console.log("  files 含 README   :", script.includes('"README.md"'));

for (const [label, base] of [["源目录", SRC], ["安装副本", INST]]) {
  console.log(`[${label}] ${base}`);
  try {
    const j = JSON.parse(readFileSync(base + "/package.json", "utf8"));
    console.log("  version:", j.version);
    console.log("  desc   :", j.description);
    console.log("  files  :", (j.files || []).join(", "));
    console.log("  deps   :", JSON.stringify(j.dependencies || {}));
  } catch (e) {
    console.log("  package.json 读取失败:", e.message);
  }
  console.log("  含 README:", existsSync(base + "/README.md"));
}
