#!/usr/bin/env node
/**
 * 升级后自检 / post-update probe（1.1.83 版，不依赖 lib/compat.js）
 *
 * 用法：
 *   node scripts/post-update.mjs                   # 只读：解包（必要时）+ 打印每条补丁状态
 *   node scripts/post-update.mjs --apply           # 没有硬失败时直接打完补丁
 *   node scripts/post-update.mjs --apply --force   # 有硬失败也照打（不建议）
 *   node scripts/post-update.mjs --surface cli     # 非桌面安装时指定 surface
 *
 * 退出码：
 *   0 = 没有硬失败（pending 允许存在：那是还没打的）
 *   1 = 有硬失败（文件在，但原文对不上，需要补 needle）
 *   2 = 连包树都找不到
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] || "" : "";
};

// core 在模块初始化时按 DSH_SURFACE 选树，必须先设再 import。
if (!process.env.DSH_SURFACE) process.env.DSH_SURFACE = value("--surface") || "desktop";

// node 里没有 resourcesPath，core 靠它才认得出官方密封包；先按安装目录补上。
const installDir = value("--install-dir") || process.env.DSH_INSTALL_DIR || "";
if (installDir && !process.resourcesPath) {
  try {
    Object.defineProperty(process, "resourcesPath", {
      value: join(installDir, "resources"),
      configurable: true,
    });
  } catch {
    /* 老 node 上不可写就退回 findAiBase 的猜测 */
  }
}

/** 直接按安装目录算插件根，绕开 exe 猜测。 */
function aiBaseFromInstall(dir) {
  if (!dir) return "";
  for (const rel of [
    ["resources", "app", "dsh", "node_modules", "@deepseek-ai"],
    ["resources", "app", "node_modules", "@deepseek-ai"],
  ]) {
    const base = join(dir, ...rel);
    if (existsSync(join(base, "dsh-base", "package.json"))) return base;
  }
  return "";
}

const core = await import("../lib/core.js");

let aiBase = value("--ai-base") || aiBaseFromInstall(installDir) || core.findAiBase() || "";

if (!aiBase) {
  console.log("=== 解包 / unpack ===");
  console.log("  没找到可打的包树（官方壳通常把代码封在 app.asar 里），开始解开……");
  try {
    const opened = await core.openSealedDesktopHost({ upgrade: true });
    aiBase = opened.aiBase || "";
    console.log(`  已解包 → ${aiBase}`);
    if (opened.appDir) console.log(`  解出目录 ${opened.appDir}`);
  } catch (e) {
    console.error(`  解包失败：${e && e.message ? e.message : e}`);
    process.exit(2);
  }
}

if (!aiBase) {
  console.error("找不到插件根（…/node_modules/@deepseek-ai）。用 --ai-base 指定。");
  process.exit(2);
}

function versionOf(base) {
  try {
    const pkg = JSON.parse(readFileSync(join(base, "dsh-base", "package.json"), "utf8"));
    return String(pkg.version || "");
  } catch {
    return "";
  }
}

console.log("=== 客户端 / client ===");
console.log(`  surface: ${process.env.DSH_SURFACE}`);
console.log(`  dsh-base: ${versionOf(aiBase) || "?"}`);
console.log(`  插件根 / root: ${aiBase}`);
console.log(`  补丁总数 / patches: ${core.ALL_PATCHES.length}`);

if (flag("--apply")) {
  console.log("\n=== 应用补丁 / apply ===");
  const { made, errors } = await core.backupAll(aiBase);
  for (const b of made) console.log(`  备份 / backup → ${b}`);
  for (const [p, e] of errors || []) console.log(`  备份失败 ${p}: ${e}`);
  const report = await core.applyPatches(aiBase);
  const summary = core.summarizeApplyReport(report);
  for (const row of report) {
    if (row.status === "applied" || row.status === "already") continue;
    console.log(`  · [#${String(row.patch_id).padEnd(2)}] ${String(row.name).padEnd(36)} ${row.status}`);
  }
  console.log(
    `  应用 / applied: ${summary.applied}, 已有 / already: ${summary.already}, 不适用 / na-or-skipped: ${summary.soft.length}, 失败 / failed: ${summary.failed.length}`,
  );
}

console.log("\n=== 状态 / status ===");
const status = await core.patchStatus(aiBase);
const byId = new Map(core.ALL_PATCHES.map((p) => [p.id, p]));
const groups = new Map();
for (const [id, s] of Object.entries(status)) {
  if (!groups.has(s)) groups.set(s, []);
  groups.get(s).push(Number(id));
}
const order = ["applied", "already", "pending", "skipped", "na", "missing_file"];
for (const key of order) {
  const ids = groups.get(key);
  if (!ids || ids.length === 0) continue;
  console.log(`  ${key.padEnd(12)} ${String(ids.length).padStart(3)}  ${ids.sort((a, b) => a - b).join(", ")}`);
}

const pending = groups.get("pending") || [];
const hardFail = (groups.get("missing_file") || []).filter((id) => {
  const p = byId.get(id);
  return p && !p.optional && !p.softSettle;
});

console.log("");
const applying = flag("--apply");
if (pending.length) {
  console.log(
    applying
      ? `[FAIL] 打完还有 ${pending.length} 条待应用 #${pending.sort((a, b) => a - b).join(", #")}`
      : `[INFO] ${pending.length} 条待应用 #${pending.sort((a, b) => a - b).join(", #")}（未打补丁的树上属于正常）`,
  );
}
if (hardFail.length) {
  console.log(`[FAIL] 有硬失败 #${hardFail.sort((a, b) => a - b).join(", #")}（文件在，但原文对不上，需要补 needle）`);
  console.log("       把这些编号发回给我，我按新版形态补上。");
}
if (hardFail.length === 0 && pending.length === 0) {
  console.log(applying ? "[OK] 补丁已全部写入。启动客户端发一条消息验证。" : "[OK] 没有待应用，也没有硬失败。");
  process.exit(0);
}
if (hardFail.length === 0 && !applying) {
  console.log(pending.length ? "[OK] 没有硬失败（pending 加 --apply 即可打）。" : "[OK] 没有硬失败，可以打补丁（加 --apply）。");
  process.exit(0);
}
process.exit(1);
