// 测试公共工具：任意 cwd、含空格路径均可运行；端口 0 自动分配；数据文件放临时目录。
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..");
export const SERVER = join(HERE, "..", "server.js");

export function tempFile(prefix = "licensing-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, file: join(dir, "data.json") };
}

export async function startServer({ now, dataFile } = {}) {
  // 显式传入 dataFile 时目录归调用方管理（重启场景）；自动生成的目录在 stop 时清理
  const autoDir = dataFile ? null : mkdtempSync(join(tmpdir(), "licensing-"));
  const file = dataFile || join(autoDir, "data.json");
  const env = { ...process.env, PORT: "0", DATA_FILE: file };
  if (now) env.LICENSING_NOW = now;
  const proc = spawn(process.execPath, [SERVER], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let base, stderr = "";
  proc.stderr.on("data", d => { stderr += d; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("服务启动超时\n" + stderr));
    }, 10000);
    proc.stdout.on("data", d => {
      const m = String(d).match(/READY port=(\d+)/);
      if (m) {
        base = `http://127.0.0.1:${m[1]}`;
        clearTimeout(timer);
        resolve();
      }
    });
    proc.on("exit", code => {
      clearTimeout(timer);
      reject(new Error(`服务提前退出 code=${code}\n${stderr}`));
    });
  });
  // 静态资源健康检查：仓库结构缺失 index.html 时快速失败，避免浏览器空等到超时
  try {
    const probe = await fetch(base + "/");
    if (!probe.ok) throw new Error(`GET / 状态码 ${probe.status}`);
    const html = await probe.text();
    if (!html.includes("版权授权台")) throw new Error("提供的 index.html 不是本应用（请保持 licensing/ 与 index.html 的相对目录结构）");
  } catch (e) {
    proc.kill("SIGTERM");
    throw new Error(`测试服务已启动但页面不可用：${e.message}`);
  }
  const api = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json };
  };
  const state = async () => (await api("GET", "/api/state")).body;
  const stop = async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGTERM");
      await once(proc, "exit").catch(() => {});
    }
    if (autoDir) rmSync(autoDir, { recursive: true, force: true });
  };
  return { proc, base, api, state, stop, dataFile: file };
}

// 自动探测 Playwright：优先本目录 node_modules，找不到则跳过浏览器用例
export async function loadPlaywright() {
  const candidates = [
    join(HERE, "..", "node_modules", "playwright"),
    "playwright",
  ];
  for (const c of candidates) {
    try { return await import(c); } catch { /* try next */ }
  }
  return null;
}
