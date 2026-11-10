#!/usr/bin/env node
/**
 * 撤销补丁 #89（历史拒绝清洗）在 dsh-session 里的插入，把 deriveMessages()
 * 还原成官方原句。轻量档：只动一个文件的一处，不动整棵 app 树。
 *
 * 用法：
 *   node scripts/revert-89.mjs --install-dir "D:\DeepSeekHarness-rc2"
 *   node scripts/revert-89.mjs --install-dir "D:\DeepSeekHarness-rc2" --dry-run
 */

import fs from "node:fs";
import path from "node:path";

function value(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : "";
}

const installDir = value("--install-dir") || process.env.DSH_INSTALL_DIR || "";
const dryRun = process.argv.includes("--dry-run");

const CANDIDATES = [
  "resources/app/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js",
  "resources/app/node_modules/@deepseek-ai/dsh-session/lib/index.js",
];

let target = "";
if (installDir) {
  for (const rel of CANDIDATES) {
    const p = path.join(installDir, rel);
    if (fs.existsSync(p)) { target = p; break; }
  }
}
if (!target) {
  console.error("[X] 没找到 dsh-session/lib/index.js。用 --install-dir 指定客户端安装目录。");
  process.exit(2);
}

/** 官方原句 */
const ORIGINAL = [
  "\t\tthis.derivedNodes = nodes.length;",
  "\t\treturn [...this.derived];",
].join("\n");

/** 当前（加固版，try/catch） */
const SCRUB_NEW = [
  "\t\tthis.derivedNodes = nodes.length;",
  "\t\t// [dsh-purge] refusal scrub: 历史拒绝会被上游重放并自我强化",
  "\t\tconst dshPurgeScrub = globalThis.__dshPurgeScrubMessages;",
  "\t\tif (typeof dshPurgeScrub === \"function\") {",
  "\t\t\ttry {",
  "\t\t\t\treturn dshPurgeScrub([...this.derived]);",
  "\t\t\t} catch { /* [dsh-purge] scrub 失败就走原路径，不能因此让会话挂掉 */ }",
  "\t\t}",
  "\t\treturn [...this.derived];",
].join("\n");

/** 第一版（三元表达式，无 try/catch）—— 也要能还原 */
const SCRUB_OLD = [
  "\t\tthis.derivedNodes = nodes.length;",
  "\t\t// [dsh-purge] refusal scrub: 历史拒绝会被上游重放并自我强化",
  "\t\treturn globalThis.__dshPurgeScrubMessages ? globalThis.__dshPurgeScrubMessages([...this.derived]) : [...this.derived];",
].join("\n");

const raw = fs.readFileSync(target, "utf8");

if (raw.includes(SCRUB_NEW)) {
  if (dryRun) { console.log("[DRY] 命中加固版 #89，会还原成官方原句"); process.exit(0); }
  fs.writeFileSync(target, raw.replace(SCRUB_NEW, ORIGINAL), "utf8");
  console.log("[OK] 已撤掉 #89（加固版）→ 官方原句");
  console.log("     文件: " + target);
  process.exit(0);
}

if (raw.includes(SCRUB_OLD)) {
  if (dryRun) { console.log("[DRY] 命中第一版 #89，会还原成官方原句"); process.exit(0); }
  fs.writeFileSync(target, raw.replace(SCRUB_OLD, ORIGINAL), "utf8");
  console.log("[OK] 已撤掉 #89（三元版）→ 官方原句");
  console.log("     文件: " + target);
  process.exit(0);
}

if (raw.includes(ORIGINAL) && !raw.includes("__dshPurgeScrubMessages")) {
  console.log("[=] 这一处已经是官方原句，没有 #89 需要撤。");
  console.log("     文件: " + target);
  process.exit(0);
}

console.error("[X] 找不到 #89 的插入点，也找不到官方原句 —— 这个文件可能被别的工具改过。");
console.error("     文件: " + target);
process.exit(3);
