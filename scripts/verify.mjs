// scripts/verify.mjs — 严格 UTF-8 校验（PowerShell 读中文不可靠，一律用 Node 核对）
//
// 校验对象：
//   1) scripts/build.mjs 的关键路径与文案（防止重建时退回旧路径/英文说明）
//   2) templates/ 下的 README 模板是否存在
//   3) 源包 packages/dsh-local-kit 与生产安装副本的元数据、README、入口文件是否齐备
//
// 用法：node scripts/verify.mjs
import { readFileSync, existsSync } from "node:fs";

const ROOT = "C:/Users/Administrator/dsh-plugins";
const SCRIPT = `${ROOT}/scripts/build.mjs`;
const SRC = `${ROOT}/packages/dsh-local-kit`;
const TEMPLATE = `${ROOT}/templates/dsh-local-kit.README.md`;
const INST = "C:/Users/Administrator/.dsh/profiles/web/node_modules/dsh-local-kit";

let failures = 0;
const check = (cond, label) => {
  if (!cond) failures += 1;
  console.log(`  ${cond ? "OK  " : "FAIL"} ${label}`);
};

console.log("[scripts/build.mjs]");
const script = readFileSync(SCRIPT, "utf8");
check(script.includes("本地插件四合一"), "含中文说明（重建不会退回英文）");
check(script.includes(`const SRC = "${ROOT}/packages"`), "SRC -> packages/");
check(script.includes(`const OUT = "${ROOT}/packages/dsh-local-kit"`), "OUT -> packages/dsh-local-kit/");
check(script.includes('"templates"'), "README 模板指向 templates/");

console.log("[templates/]");
check(existsSync(TEMPLATE), "dsh-local-kit.README.md 模板存在");

for (const [label, base] of [
  ["源包 packages/dsh-local-kit", SRC],
  ["安装副本（生产 profile）", INST],
]) {
  console.log(`[${label}]`);
  try {
    const j = JSON.parse(readFileSync(base + "/package.json", "utf8"));
    console.log(`    version=${j.version}  deps=${JSON.stringify(j.dependencies || {})}`);
    console.log(`    desc=${j.description}`);
    check((j.files || []).includes("README.md"), "files 含 README.md");
    check(existsSync(base + "/README.md"), "README.md 存在");
    check(existsSync(base + "/lib/client.js"), "lib/client.js 存在");
    check(existsSync(base + "/lib/index.js"), "lib/index.js 存在");
  } catch (e) {
    failures += 1;
    console.log("    FAIL 读取失败:", e.message);
  }
}

console.log("");
console.log(failures === 0 ? "*** 全部通过 ***" : `*** 有 ${failures} 项未通过 ***`);
process.exitCode = failures === 0 ? 0 : 1;
