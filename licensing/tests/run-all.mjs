#!/usr/bin/env node
// 一键测试入口：可在任意 cwd、含空格路径下直接运行
//   node licensing/tests/run-all.mjs
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;

function run(name, args) {
  console.log(`\n========== ${name} ==========`);
  const r = spawnSync(NODE, args, { stdio: "inherit", cwd: join(HERE, "..") });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run("接口与规则测试（node:test）", ["--test", join(HERE, "api.test.mjs")]);
run("真实浏览器走查（Chromium）", [join(HERE, "e2e.mjs")]);
console.log("\n全部测试通过 ✔");
