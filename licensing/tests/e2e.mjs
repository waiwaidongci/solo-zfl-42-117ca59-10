// 真实 Chromium 走查：独占冲突 / 双页并发 / 续期 / 阶梯计提+保底 / 退货冲减 / 终止 / 批量回滚 / 刷新一致
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";

const PORT = 4319;
const BASE = `http://localhost:${PORT}`;
const DATA_FILE = "/tmp/licensing-e2e-data.json";
let serverProc;

function startServer() {
  return new Promise((resolve, reject) => {
    const p = spawn("node", ["licensing/server.js"], {
      cwd: new URL("../../", import.meta.url).pathname,
      env: { ...process.env, PORT: String(PORT), DATA_FILE },
      stdio: ["ignore", "pipe", "pipe"],
    });
    p.stdout.on("data", d => String(d).includes("已启动") && resolve(p));
    p.stderr.on("data", d => process.stderr.write(`[srv] ${d}`));
    p.on("exit", code => reject(new Error("server exited " + code)));
  });
}
async function stopServer() {
  if (serverProc) { serverProc.kill("SIGTERM"); await new Promise(r => serverProc.on("exit", r)); serverProc = null; }
}

let passed = 0;
function check(name, cond, extra = "") {
  if (!cond) throw new Error(`断言失败：${name} ${extra}`);
  passed++;
  console.log(`  ✔ ${name}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function toastText(page, needle, kind) {
  await page.waitForFunction(
    ({ needle, kind }) => [...document.querySelectorAll(".toast .msg")]
      .some(m => (!kind || m.classList.contains(kind)) && m.textContent.includes(needle)),
    { needle, kind }, { timeout: 5000 });
}
async function fillLicenseForm(page, v) {
  const f = page.locator("#licenseForm");
  await f.locator("select[name=motifId]").selectOption(v.motifId);
  await f.locator("input[name=licensee]").fill(v.licensee);
  await f.locator("select[name=exclusive]").selectOption(v.exclusive ? "true" : "false");
  await f.locator("input[name=guarantee]").fill(String(v.guarantee ?? 0));
  await f.locator("input[name=startDate]").fill(v.startDate);
  await f.locator("input[name=endDate]").fill(v.endDate);
  await f.locator("input[name=regions]").fill(v.regions);
  await f.locator("input[name=categories]").fill(v.categories);
}
async function stateOf(page) {
  return page.evaluate(async () => (await fetch("/api/state")).json());
}

const browser = await chromium.launch();
let page;
try {
  rmSync(DATA_FILE, { force: true });
  serverProc = await startServer();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  await page.goto(BASE);
  await page.click("#tabLic");
  await page.waitForSelector("#licApp:not([hidden])");
  console.log("① 独占冲突（同一纹样 × 地区 × 品类 × 期间，任一为独占即拒）");
  await fillLicenseForm(page, {
    motifId: "M1", licensee: "冲突商家-福州某行", exclusive: true, guarantee: 0,
    startDate: "2026-06-01", endDate: "2026-08-31", regions: "福建", categories: "摆件",
  });
  await page.click('#licenseForm button[type=submit]');
  await toastText(page, "独占冲突", "err");
  let s = await stateOf(page);
  check("冲突授权未落库（仍只有种子 2 条）", s.licenses.length === 2);
  check("授权台账仍无「冲突商家」", !s.licenses.some(l => l.licensee.includes("冲突商家")));

  console.log("② 两个页面同时提交同一独占范围：恰好一成一败");
  const page2 = await browser.newPage();
  await page2.goto(BASE); await page2.click("#tabLic"); await page2.waitForSelector("#licApp:not([hidden])");
  await fillLicenseForm(page, {
    motifId: "M3", licensee: "并发页面甲", exclusive: true, guarantee: 0,
    startDate: "2026-07-01", endDate: "2026-09-30", regions: "浙江", categories: "首饰",
  });
  await fillLicenseForm(page2, {
    motifId: "M3", licensee: "并发页面乙", exclusive: true, guarantee: 0,
    startDate: "2026-07-01", endDate: "2026-09-30", regions: "浙江", categories: "首饰",
  });
  await Promise.all([
    page.evaluate(() => document.querySelector("#licenseForm").requestSubmit()),
    page2.evaluate(() => document.querySelector("#licenseForm").requestSubmit()),
  ]);
  await Promise.all([
    toastText(page, "授权 L5 已创建").catch(() => toastText(page, "独占冲突")),
    toastText(page2, "独占冲突", "err").catch(() => toastText(page2, "授权 L5 已创建")),
  ]);
  await sleep(300);
  s = await stateOf(page);
  const winners = s.licenses.filter(l => l.licensee.startsWith("并发页面"));
  check("并发后仅生成 1 条授权", winners.length === 1, `实际 ${winners.length} 条`);
  check("胜出方为页面甲或乙之一（无重叠授权）", ["并发页面甲", "并发页面乙"].includes(winners[0].licensee));
  const winnerId = winners[0].id;
  const loserToastOk = await page.evaluate(() => [...document.querySelectorAll(".toast .msg")].some(m => m.textContent.includes("独占冲突")))
    || await page2.evaluate(() => [...document.querySelectorAll(".toast .msg")].some(m => m.textContent.includes("独占冲突")));
  check("其中一个页面收到独占冲突提示", loserToastOk);
  await page2.close();

  console.log("③ 续期（历史保留）");
  await page.click(`.lic-card:has-text("L1")`);
  await page.click("button:has-text('续期')");
  await page.waitForSelector("#licDialog:not([hidden])");
  await page.fill('#licDialog input[name=endDate]', "2027-12-31");
  await page.fill('#licDialog input[name=note]', "年度续约走查");
  await page.click("#licDialogOk");
  await page.waitForSelector("#licDialog[hidden], #licDialog:not(.\\:modal)", { state: "hidden" }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector("#licDialog").open);
  await toastText(page, "续期成功");
  s = await stateOf(page);
  const l1 = s.licenses.find(l => l.id === "L1");
  check("到期日延长到 2027-12-31", l1.effectiveEnd === "2027-12-31");
  check("续期事件已追加（create + renewal）", l1.versions.some(v => v.type === "renewal" && v.note === "年度续约走查"));
  check("设立事件仍保留", l1.versions[0].type === "create");
  check("历史区展示续期记录", await page.locator(".history").innerText().then(t => t.includes("续期") && t.includes("2027-12-31")));

  console.log("④ 阶梯费率计提 + 最低保底抵扣");
  await page.click("button:has-text('上报销量')");
  await page.waitForFunction(() => document.querySelector("#licDialog").open);
  await page.fill('#licDialog input[name=period]', "2026-02");
  await page.fill('#licDialog input[name=amount]', "60000");
  await page.fill('#licDialog input[name=units]', "120");
  await page.fill('#licDialog input[name=idempotencyKey]', "S-E2E-02");
  await page.click("#licDialogOk");
  await page.waitForFunction(() => !document.querySelector("#licDialog").open);
  await toastText(page, "¥4,700.00"); // 10000*5% + 40000*8% + 10000*10%
  s = await stateOf(page);
  const feb = s.royalties.L1.rows.find(r => r.period === "2026-02");
  check("2026-02 销售 60000 阶梯计提 4700", feb.earnedRoyalty === 4700, `实际 ${feb.earnedRoyalty}`);
  check("2026-02 无需保底抵扣", feb.guaranteeOffset === 0 && feb.payable === 4700);
  const jan = s.royalties.L1.rows.find(r => r.period === "2026-01");
  check("2026-01 计提 400，月保底 1000，抵扣 600", jan.earnedRoyalty === 400 && jan.guaranteeOffset === 600 && jan.payable === 1000);
  const emptyMonth = s.royalties.L1.rows.find(r => r.period === "2026-04");
  check("无销售月份按保底 1000 计提", emptyMonth.payable === 1000 && emptyMonth.guaranteeOffset === 1000);
  // 重复上报（相同凭证号）
  await page.click("button:has-text('上报销量')");
  await page.waitForFunction(() => document.querySelector("#licDialog").open);
  await page.fill('#licDialog input[name=period]', "2026-02");
  await page.fill('#licDialog input[name=amount]', "60000");
  await page.fill('#licDialog input[name=idempotencyKey]', "S-E2E-02");
  await page.click("#licDialogOk");
  await toastText(page, "凭证号重复");
  s = await stateOf(page);
  check("重复上报未产生第二条流水", s.reports.filter(r => r.idempotencyKey === "S-E2E-02").length === 1);
  check("重复上报金额未二次计提", s.royalties.L1.rows.find(r => r.period === "2026-02").sales === 60000);

  console.log("⑤ 退货按原授权原账期逐期冲减；重复/跨授权拒绝");
  await page.click("button:has-text('退货冲减')");
  await page.waitForFunction(() => document.querySelector("#licDialog").open);
  await page.selectOption('#licDialog select[name=originalReportId]', "R1"); // 种子 2026-01 销售 8000
  await page.fill('#licDialog input[name=amount]', "3000");
  await page.fill('#licDialog input[name=returnId]', "RT-E2E-1");
  await page.click("#licDialogOk");
  await page.waitForFunction(() => !document.querySelector("#licDialog").open);
  await toastText(page, "冲减");
  s = await stateOf(page);
  const jan2 = s.royalties.L1.rows.find(r => r.period === "2026-01");
  check("退货计入原账期 2026-01（销售 8000 / 退 3000 / 净 5000）", jan2.sales === 8000 && jan2.returns === 3000 && jan2.net === 5000);
  check("版税由 400 冲到 250（冲回 150），保底下应付仍为 1000", jan2.earnedRoyalty === 250 && jan2.payable === 1000);
  const ret = s.reports.find(r => r.kind === "return");
  check("退货流水记录原销售与冲回额", ret.originPeriod === "2026-01" && ret.originalReportId === "R1" && ret.reversal === 150);
  // 重复退货单号 → 拒绝（浏览器内 fetch 直连 API，等价于页面提交被服务端拒绝）
  const dup = await page.evaluate(async () => {
    const r = await fetch("/api/reports/return", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ licenseId: "L1", returnId: "RT-E2E-1", originalReportId: "R1", amount: 1 }) });
    return { status: r.status, body: await r.json() };
  });
  check("重复退货单号被拒绝 409", dup.status === 409 && dup.body.error.code === "DUPLICATE_RETURN");
  // 跨授权上报 → 拒绝
  const cross = await page.evaluate(async () => {
    const r = await fetch("/api/reports/return", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ licenseId: "L2", returnId: "RT-X", originalReportId: "R1", amount: 100 }) });
    return { status: r.status, body: await r.json() };
  });
  check("跨授权退货被拒绝 409", cross.status === 409 && cross.body.error.code === "CROSS_LICENSE_RETURN");
  // 超额退货 → 拒绝
  const over = await page.evaluate(async () => {
    const r = await fetch("/api/reports/return", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ licenseId: "L1", returnId: "RT-OVER", originalReportId: "R1", amount: 999999 }) });
    return { status: r.status, body: await r.json() };
  });
  check("退货超过同期销售被拒绝 409", over.status === 409 && over.body.error.code === "RETURN_EXCEEDS_SALES");
  s = await stateOf(page);
  check("被拒退货均未落库", s.reports.filter(r => r.kind === "return").length === 1);

  console.log("⑥ 终止授权（历史保留、终止后续期入口禁用）");
  await page.click(`.lic-card:has-text("${winnerId}")`);
  await page.click("button:has-text('终止')");
  await page.waitForFunction(() => document.querySelector("#licDialog").open);
  await page.fill('#licDialog input[name=date]', "2026-08-15");
  await page.fill('#licDialog input[name=reason]', "商家调整品类");
  await page.click("#licDialogOk");
  await page.waitForFunction(() => !document.querySelector("#licDialog").open);
  await toastText(page, "授权已终止");
  s = await stateOf(page);
  const win = s.licenses.find(l => l.id === winnerId);
  check("状态为 terminated 且记录终止日/原因", win.status === "terminated" && win.terminateDate === "2026-08-15");
  check("终止事件已留痕", win.versions.some(v => v.type === "terminate" && v.note === "商家调整品类"));
  check("续期/终止/变更按钮已禁用", await page.locator("#licenseDetail button:has-text('续期')").isDisabled());
  const renewAfterTerm = await page.evaluate(async id => {
    const r = await fetch(`/api/licenses/${id}/renew`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endDate: "2028-01-01" }) });
    return r.status;
  }, winnerId);
  check("终止后续期 API 同样拒绝 409", renewAfterTerm === 409);

  console.log("⑦ 批量导入：任一条失败整批回滚 + 明细");
  await page.click("#batchSample");
  await page.click("#batchBtn");
  await page.waitForSelector("#batchResult .errbox");
  const errBox = await page.locator("#batchResult .errbox").innerText();
  check("提示整批回滚", errBox.includes("整批回滚"));
  check("给出第 2 条失败明细与冲突对象", errBox.includes("第 2 条") && errBox.includes("EXCLUSIVE_OVERLAP") && errBox.includes("L1"));
  const beforeCount = (await stateOf(page)).licenses.length;
  check("第 1 条（本可成功）也未写入", !(await stateOf(page)).licenses.some(l => l.licensee.includes("杭州文玩阁")));
  // 修正后整批成功
  await page.fill("#batchInput", JSON.stringify([
    { motifId: "M2", licensee: "批量-北京礼业", exclusive: false, regions: ["北京"], categories: ["摆件"], startDate: "2026-05-01", endDate: "2027-04-30", guarantee: 0 },
    { motifId: "M3", licensee: "批量-苏州玉作", exclusive: false, regions: ["江苏"], categories: ["挂件"], startDate: "2026-05-01", endDate: "2027-04-30", guarantee: 0 },
  ]));
  await page.click("#batchBtn");
  await page.waitForSelector("#batchResult .badge.act");
  s = await stateOf(page);
  check("整批成功写入 2 条", s.licenses.length === beforeCount + 2 && s.licenses.some(l => l.licensee === "批量-北京礼业") && s.licenses.some(l => l.licensee === "批量-苏州玉作"));

  console.log("⑧ 刷新后结果一致（页面刷新 + 服务重启后再读）");
  const totalsBefore = JSON.stringify((await stateOf(page)).royalties.L1.total);
  const histBefore = (await stateOf(page)).licenses.find(l => l.id === "L1").versions.length;
  await page.screenshot({ path: "/tmp/licensing-detail.png", fullPage: false });
  await page.reload();
  await page.click("#tabLic");
  await page.waitForSelector("#licApp:not([hidden])");
  await page.click(`.lic-card:has-text("L1")`);
  let s2 = await stateOf(page);
  check("刷新后计提合计一致", JSON.stringify(s2.royalties.L1.total) === totalsBefore);
  check("刷新后续期/设立历史条数一致", s2.licenses.find(l => l.id === "L1").versions.length === histBefore);
  check("刷新后退货流水仍在", s2.reports.filter(r => r.kind === "return").length === 1);
  check("页面表格累计应付与接口一致", await page.locator("table.roy tfoot td:last-child").innerText().then(t => t === `¥${s2.royalties.L1.total.payable.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`));
  // 重启服务（验证原子落盘）
  await stopServer();
  await sleep(300);
  serverProc = await startServer();
  await page.reload();
  s2 = await stateOf(page);
  check("服务重启后数据仍一致", JSON.stringify(s2.royalties.L1.total) === totalsBefore && s2.licenses.length === beforeCount + 2);

  check("全程无前端脚本错误", errors.length === 0, errors.join("; "));
  console.log(`\n全部通过：${passed} 项断言`);
} catch (e) {
  console.error("\n走查失败：", e.message);
  try { await page.screenshot({ path: "/tmp/licensing-fail.png", fullPage: true }); } catch {}
  process.exitCode = 1;
} finally {
  await browser.close();
  await stopServer();
}
