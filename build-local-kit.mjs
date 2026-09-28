// build-local-kit.mjs - assemble the merged DSH plugin from the four local plugins.
// Strategy (matches the DSH client contract: registration id MUST equal the package name):
//   host   -> one ESM module that imports and applies the four host halves
//   client -> ONE __ModuleLoader__.load({id:'dsh-local-kit'}) whose factory materializes
//             the four original client bodies inside per-feature IIFEs and merges their
//             plugins into a single {name, inject, apply}.
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";

const SRC = "C:/Users/Administrator/dsh-plugins";
const OUT = "C:/Users/Administrator/dsh-plugins/dsh-local-kit";
const PKG = "dsh-local-kit";

const features = [
  { key: "dsmon", dir: `${SRC}/dsmon` },
  { key: "message-preview", dir: `${SRC}/dsh-message-preview` },
  { key: "drag-and-drop", dir: `${SRC}/dsh-drag-and-drop` },
  { key: "file-mentions", dir: `${SRC}/dsh-file-mentions` },
];

function extractClientBody(src, key) {
  const marker = "factory: (require) =>";
  const mi = src.indexOf(marker);
  if (mi < 0) throw new Error(`${key}: factory marker not found`);
  const braceIdx = src.indexOf("{", mi);
  if (braceIdx < 0) throw new Error(`${key}: factory open brace not found`);
  // Every one of these hand-written bundles ends its factory with
  // `return module.exports;` followed by the factory's closing brace, so anchor
  // on that statement instead of counting braces (no string/comment parsing).
  const ret = src.lastIndexOf("return module.exports;");
  if (ret < 0 || ret < braceIdx) throw new Error(`${key}: final return not found`);
  const close = src.indexOf("}", ret);
  if (close < 0) throw new Error(`${key}: factory close not found`);
  return src.slice(braceIdx + 1, close);
}

// ---- host-half dependency scan --------------------------------------------
// A merged row is installed as a COPY into the profile's node_modules, but the
// copied host halves still import bare packages (e.g. @deepseek-ai/schemastery,
// zod). Those only stay installed while SOME profile plugin depends on them:
// when the kit replaces the four originals, pnpm prunes them and the row dies at
// import with "Cannot find package '@deepseek-ai/schemastery'" -> the web GUI
// reports "Failed to load plugins / dsh-local-kit: failed". Declaring them as
// the kit's OWN dependencies stops that prune. Versions are pinned to what the
// profile already has so pnpm reuses the installed copy (no network needed).
const PROFILE_NM = "C:/Users/Administrator/.dsh/profiles/web/node_modules";
const hostDeps = new Map();
const unresolvedDeps = [];

function bareSpecifiersIn(dir) {
  const found = new Set();
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|mjs|cjs)$/.test(entry.name)) continue;
      const text = readFileSync(full, "utf8");
      for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g)) {
        const spec = m[1];
        if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) continue;
        found.add(spec);
      }
    }
  };
  walk(dir);
  return found;
}

function installedVersion(spec) {
  try {
    const pj = join(PROFILE_NM, ...spec.split("/"), "package.json");
    return JSON.parse(readFileSync(pj, "utf8")).version;
  } catch {
    return null;
  }
}

// ---- reset output ----
if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "lib/features"), { recursive: true });

const injectUnion = new Set();
const hostImports = [];
const clientChunks = [];
const report = [];

for (const f of features) {
  const pj = JSON.parse(readFileSync(join(f.dir, "package.json"), "utf8"));
  for (const dep of pj.dsh?.client?.inject ?? []) injectUnion.add(dep);

  // copy the whole lib/ so relative imports inside a host half keep working
  const srcLib = join(f.dir, "lib");
  const dstLib = join(OUT, "lib/features", f.key, "lib");
  mkdirSync(dirname(dstLib), { recursive: true });
  cpSync(srcLib, dstLib, { recursive: true });

  // Whatever the host half imports must survive the four originals leaving.
  for (const spec of bareSpecifiersIn(dstLib)) {
    const version = installedVersion(spec);
    if (version === null) { if (!unresolvedDeps.includes(spec)) unresolvedDeps.push(spec); continue; }
    hostDeps.set(spec, version);
  }

  const hostFile = join(dstLib, "index.js");
  if (!existsSync(hostFile)) throw new Error(`${f.key}: no lib/index.js after copy`);
  hostImports.push(`import * as ${f.key.replace(/-/g, "_")} from "./features/${f.key}/lib/index.js";`);

  const clientSrc = readFileSync(join(srcLib, "client.js"), "utf8");
  let body = extractClientBody(clientSrc, f.key);

  // Feature-body compatibility patches. dsh 0.1.7 declares
  // conversation.chat.turnTail as a LIST slot: every contribution needs a
  // stable `id` (`select` was the 0.1.2 chain-slot contract). dsh-file-mentions
  // still ships the old shape. Standalone that only failed softly at render
  // time, but a merged row activates LATE (its `inject` is the union of the
  // four), so the slot already exists and slots.inject() runs the callback
  // during activation -> the throw fails the whole plugin.
  if (f.key === "file-mentions") {
    const slotNeedle = 'name: "conversation.chat.turnTail",\n          select:';
    if (!body.includes(slotNeedle)) throw new Error("file-mentions: turnTail registration shape changed");
    body = body.replace(slotNeedle, 'name: "conversation.chat.turnTail",\n          id: "file-mentions-turn-tail",\n          select:');
    const matchedNeedle = "const matched = props.matched;";
    if (!body.includes(matchedNeedle)) throw new Error("file-mentions: turnTail component shape changed");
    body = body.replace(matchedNeedle, "const matched = props.matched ?? (() => { try { const o = props.owner; const d = o && o.turn && o.turn.data ? o.turn.data.get(\"mentionedPaths\") : undefined; return d && Array.isArray(d.paths) ? d.paths : undefined; } catch { return undefined; } })();");
    report.push("file-mentions: turnTail list-slot id + matched fallback applied");
  }
  // sanity: body must be brace-balanced enough to wrap
  clientChunks.push(`\t\t// ---- feature: ${f.key} ----\n\t\tfeatures.push((function () {\n${body}\n\t\t})());\n`);
  report.push(`${f.key}: host=${pj.dsh?.bundle?.patch ? "patch" : "?"} clientBody=${body.length}B clientInject=[${(pj.dsh?.client?.inject ?? []).join(", ")}]`);
}

// ---- merged host half ----
const hostOut = `// ${PKG} - merged host half (generated by build-local-kit.mjs).
// Applies the four local plugins' host halves in one cordis plugin row.
${hostImports.join("\n")}

export const name = ${JSON.stringify(PKG)};
export const inject = ["webServer", "sessions"];

const FEATURES = [${features.map((f) => f.key.replace(/-/g, "_")).join(", ")}];

export function apply(ctx, config) {
  for (const feature of FEATURES) {
    if (typeof feature.apply === "function") feature.apply(ctx, config);
  }
}
`;
writeFileSync(join(OUT, "lib/index.js"), hostOut, "utf8");

// ---- merged client half ----
const clientOut = `/* ${PKG} client half (generated by build-local-kit.mjs).
 * One registration whose id matches the package/graph row, as the client module
 * contract requires; the four original client bodies run inside their own IIFEs
 * and their plugins are merged into a single {name, inject, apply}.
 */
window.__ModuleLoader__.load({
\tid: ${JSON.stringify(PKG)},
\tfactory: (require) => {
\t\tconst features = [];
${clientChunks.join("\n")}
\t\t// Service injects are the union of the features' own cordis injects
\t\t// (e.g. "slots"), NOT the package names -- package edges live in
\t\t// package.json's dsh.client.inject (the boot graph).
\t\tconst inject = [...new Set(features.flatMap((feature) => [].concat((feature && feature.inject) || [])))];
\t\tconst apply = (ctx) => {
\t\t\tfor (const feature of features) {
\t\t\t\tif (feature && typeof feature.apply === "function") feature.apply(ctx);
\t\t\t}
\t\t};
\t\treturn { name: ${JSON.stringify(PKG)}, inject, apply };
\t}
});
`;
writeFileSync(join(OUT, "lib/client.js"), clientOut, "utf8");

// ---- package.json + patch ----
const mergedPkg = {
  name: PKG,
  version: "1.0.0",
  description:
    "本地插件四合一：DeepSeek 峰谷时段与费用监控（含服务器监控页）、侧边栏消息预览、拖拽文件插入原始路径、回复中文件路径可点击。",
  type: "module",
  main: "./lib/index.js",
  exports: { ".": "./lib/index.js", "./client": "./lib/client.js", "./package.json": "./package.json" },
  files: ["lib", "cordis.patch.yml", "README.md"],
  dsh: {
    bundle: { patch: "./cordis.patch.yml" },
    client: { platform: "web", inject: [...injectUnion] },
  },
  dependencies: Object.fromEntries([...hostDeps.entries()].sort()),
  engines: { node: ">=22" },
  license: "MIT",
};
writeFileSync(join(OUT, "package.json"), JSON.stringify(mergedPkg, null, 2) + "\n", "utf8");

// Ship the hand-written README. The template lives OUTSIDE OUT because the reset at
// the top of this script deletes OUT, so keeping the template beside the script keeps
// the docs intact across rebuilds.
const readmeTemplate = join(OUT, "..", "dsh-local-kit.README.md");
if (existsSync(readmeTemplate)) cpSync(readmeTemplate, join(OUT, "README.md"));
else console.log("WARNING: README template missing: " + readmeTemplate);
writeFileSync(
  join(OUT, "cordis.patch.yml"),
  `# ${PKG} bundle patch: one merged row replacing dsmon + message-preview +\n# drag-and-drop + file-mentions (ids the four features used are preserved\n# inside the merged host/client halves).\n- insert:\n    - id: local-kit\n      name: '${PKG}'\n`,
  "utf8",
);

console.log("=== per-feature extraction ===");
for (const r of report) console.log("  " + r);
console.log("=== client inject union ===");
console.log("  " + [...injectUnion].join(", "));
console.log("=== kit dependencies (kept installed after the four leave) ===");
console.log("  " + ([...hostDeps].map(([k, v]) => `${k}@${v}`).join(", ") || "(none)"));
if (unresolvedDeps.length > 0) console.log("  WARNING unresolved (not found in profile node_modules): " + unresolvedDeps.join(", "));
console.log("=== output tree ===");
console.log("  " + OUT);
console.log("  client.js bytes:", readFileSync(join(OUT, "lib/client.js"), "utf8").length);
console.log("  index.js  bytes:", readFileSync(join(OUT, "lib/index.js"), "utf8").length);
