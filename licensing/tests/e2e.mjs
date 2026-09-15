// 真实 Chromium 走查：时钟注入、独占冲突、双页并发、续期、阶梯+保底、条款分段、
// 退货冲减、终止、月末边界、v1 迁移、批量回滚、刷新/重启一致、原授权流程与工坊看板回归。
// 运行：node licensing/tests/e2e.mjs  （任意 cwd、路径可含空格）
import { existsSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, loadPlaywright, tempFile } from "./helpers.mjs";

const playwright = await loadPlaywright();
if (!playwright) {
  console.log("SKIP: 未安装 Playwright（npm i -D playwright && npx playwright install chromium）");
  process.exit(0);
}
const { chromium } = playwright;

// 沙箱环境若把 Chromium 依赖库解在 ~/.local/pwlibs，则自动补进 LD_LIBRARY_PATH
function browserEnv() {
  const extra = [
    join(homedir(), ".local/pwlibs/usr/lib/aarch64-linux-gnu"),
    join(homedir(), ".local/pwlibs/usr/lib/x86_64-linux-gnu"),
    join(homedir(), ".local/pwlibs/lib/aarch64-linux-gnu"),
    join(homedir(), ".local/pwlibs/lib/x86_64-linux-gnu"),
  ].filter(existsSync);
  return { ...process.env, LD_LIBRARY_PATH: [...extra, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") };
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
    { needle, kind }, { timeout: 6000 });
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
const stateOf = page => page.evaluate(async () => (await fetch("/api/state")).json());
async function waitDialogClosed(page) { await page.waitForFunction(() => !document.querySelector("#licDialog").open); }
async function waitDialogOpen(page) { await page.waitForFunction(() => document.querySelector("#licDialog").open); }

function v1File() {
  const { dir, file } = tempFile("lic-v1e2e-");
  writeFileSync(file, JSON.stringify({
    seq: 9,
    motifs: [{ id: "M1", name: "旧纹样", author: "老作者", style: "", registeredAt: "2025-01-01", note: "" }],
    licenses: [{
      id: "L1", motifId: "M1", licensee: "旧被授权方", exclusive: true,
      regions: ["福建"], categories: ["摆件"],
      startDate: "2026-01-01", endDate: "2026-12-31",
      tiers: [{ upTo: 5000, rate: 0.06 }, { upTo: null, rate: 0.09 }],
      guarantee: 6000, status: "active", terminateDate: null, terminateReason: null,
      createdAt: "2025-12-01",
      versions: [{ type: "create", at: "2025-12-01T00:00:00.000Z", endDate: "2026-12-31", note: "首次授权", snapshot: null }],
    }],
    reports: [{ id: "R1", kind: "sale", licenseId: "L1", period: "2026-01", amount: 5000, units: 10, idempotencyKey: "OLD-1", at: "2026-02-01T00:00:00.000Z" }],
  }));
  return file;
}

const browser = await chromium.launch({ env: browserEnv() });
let page;
try {
  // ========== A. v1 迁移 + 真实/注入账期 ==========
  console.log("⓪ v1 数据迁移（浏览器中旧流水不丢、既往不重算）");
  const v1 = v1File();
  let srv = await startServer({ now: "2026-09-15", dataFile: v1 });
  page = await browser.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  await page.goto(srv.base);
  await page.click("#tabLic");
  await page.waitForSelector("#licApp:not([hidden])");
  await page.click(".lic-card:has-text('L1')");
  await page.waitForSelector("text=数据迁移");
  check("历史区显示迁移事件", await page.locator(".history").innerText().then(t => t.includes("数据迁移") && t.includes("不重算")));
  let s = await stateOf(page);
  check("旧上报保留", s.reports.length === 1 && s.reports[0].idempotencyKey === "OLD-1");
  check("旧账期按旧费率 5000×6%=300、保底500", s.royalties.L1.rows.find(r => r.period === "2026-01").earnedRoyalty === 300);
  check("页面账期基准日显示注入日期 2026-09-15", (await page.locator("#licToday").innerText()).includes("2026-09-15"));
  await srv.stop();

  // ========== 主流程：全新种子数据（显式临时文件，跨重启保留） ==========
  const main = tempFile("lic-main-");
  srv = await startServer({ now: "2026-09-15", dataFile: main.file });
  await page.goto(srv.base);
  await page.click("#tabLic");
  await page.waitForSelector("#licApp:not([hidden])");

  console.log("① 独占冲突");
  await fillLicenseForm(page, {
    motifId: "M1", licensee: "冲突商家", exclusive: true, guarantee: 0,
    startDate: "2026-06-01", endDate: "2026-08-31", regions: "福建", categories: "摆件",
  });
  await page.click('#licenseForm button[type=submit]');
  await toastText(page, "独占冲突", "err");
  s = await stateOf(page);
  check("冲突授权未落库", s.licenses.length === 2);

  console.log("② 两个页面同时提交同一独占范围：恰好一成一败");
  const page2 = await browser.newPage();
  await page2.goto(srv.base); await page2.click("#tabLic"); await page2.waitForSelector("#licApp:not([hidden])");
  await fillLicenseForm(page, { motifId: "M3", licensee: "并发页面甲", exclusive: true, guarantee: 0, startDate: "2026-07-01", endDate: "2026-09-30", regions: "浙江", categories: "首饰" });
  await fillLicenseForm(page2, { motifId: "M3", licensee: "并发页面乙", exclusive: true, guarantee: 0, startDate: "2026-07-01", endDate: "2026-09-30", regions: "浙江", categories: "首饰" });
  await Promise.all([
    page.evaluate(() => document.querySelector("#licenseForm").requestSubmit()),
    page2.evaluate(() => document.querySelector("#licenseForm").requestSubmit()),
  ]);
  await Promise.all([
    toastText(page, "授权 L5 已创建").catch(() => toastText(page, "独占冲突")),
    toastText(page2, "独占冲突", "err").catch(() => toastText(page2, "授权 L5 已创建")),
  ]);
  await sleep(200);
  s = await stateOf(page);
  const winners = s.licenses.filter(l => l.licensee.startsWith("并发页面"));
  check("并发后仅 1 条授权", winners.length === 1);
  const winnerId = winners[0].id;
  await page2.close();

  console.log("③ 续期（历史保留）");
  await page.click(`.lic-card:has-text("L1")`);
  await page.click("button:has-text('续期')"); await waitDialogOpen(page);
  await page.fill('#licDialog input[name=endDate]', "2027-12-31");
  await page.fill('#licDialog input[name=note]', "年度续约走查");
  await page.click("#licDialogOk"); await waitDialogClosed(page);
  await toastText(page, "续期成功");
  s = await stateOf(page);
  check("到期延至 2027-12-31", s.licenses.find(l => l.id === "L1").effectiveEnd === "2027-12-31");
  check("续期事件与设立事件并存", (() => { const vs = s.licenses.find(l => l.id === "L1").versions; return vs[0].type === "create" && vs.some(v => v.type === "renewal" && v.note === "年度续约走查"); })());

  console.log("④ 阶梯计提 + 保底 + 幂等");
  await page.click("button:has-text('上报销量')"); await waitDialogOpen(page);
  await page.fill('#licDialog input[name=period]', "2026-02");
  await page.fill('#licDialog input[name=amount]', "60000");
  await page.fill('#licDialog input[name=units]', "120");
  await page.fill('#licDialog input[name=idempotencyKey]', "S-E2E-02");
  await page.click("#licDialogOk"); await waitDialogClosed(page);
  await toastText(page, "¥4,700.00");
  s = await stateOf(page);
  check("2 月阶梯 4700", s.royalties.L1.rows.find(r => r.period === "2026-02").earnedRoyalty === 4700);
  check("1 月保底抵扣 600、应付 1000", (() => { const j = s.royalties.L1.rows.find(r => r.period === "2026-01"); return j.guaranteeOffset === 600 && j.payable === 1000; })());
  await page.click("button:has-text('上报销量')"); await waitDialogOpen(page);
  await page.fill('#licDialog input[name=period]', "2026-02");
  await page.fill('#licDialog input[name=amount]', "60000");
  await page.fill('#licDialog input[name=idempotencyKey]', "S-E2E-02");
  await page.click("#licDialogOk");
  await toastText(page, "凭证号重复");
  s = await stateOf(page);
  check("重复上报不二次计提", s.reports.filter(r => r.idempotencyKey === "S-E2E-02").length === 1);

  console.log("④b 未来账期在页面上被服务端拒绝（账期失真修复）");
  // L1 已续期到 2027 年，用“下个月”验证：不依赖固定时钟，始终是未来账期
  const futureMonth = (() => { const [y, m] = "2026-09".split("-").map(Number); const t = y * 12 + (m - 1) + 1; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`; })();
  const fut = await page.evaluate(async fm => {
    const r = await fetch("/api/reports/sales", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ licenseId: "L1", period: fm, amount: 1, idempotencyKey: "F" }) });
    return { status: r.status, code: (await r.json()).error.code };
  }, futureMonth);
  check(`未来账期 ${futureMonth} 400/FUTURE_PERIOD`, fut.status === 400 && fut.code === "FUTURE_PERIOD");

  console.log("⑤ 退货原账期冲减；重复/跨授权/超额拒绝");
  await page.click("button:has-text('退货冲减')"); await waitDialogOpen(page);
  await page.selectOption('#licDialog select[name=originalReportId]', "R1");
  await page.fill('#licDialog input[name=amount]', "3000");
  await page.fill('#licDialog input[name=returnId]', "RT-E2E-1");
  await page.click("#licDialogOk"); await waitDialogClosed(page);
  await toastText(page, "冲减");
  s = await stateOf(page);
  const jan = s.royalties.L1.rows.find(r => r.period === "2026-01");
  check("退货回原账期：净 5000、计提 250、保底应付 1000", jan.returns === 3000 && jan.earnedRoyalty === 250 && jan.payable === 1000);
  const codes = await page.evaluate(async () => {
    const call = b => fetch("/api/reports/return", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(async r => ({ s: r.status, c: (await r.json()).error.code }));
    return {
      dup: await call({ licenseId: "L1", returnId: "RT-E2E-1", originalReportId: "R1", amount: 1 }),
      cross: await call({ licenseId: "L2", returnId: "RT-X", originalReportId: "R1", amount: 1 }),
      over: await call({ licenseId: "L1", returnId: "RT-O", originalReportId: "R1", amount: 999999 }),
    };
  });
  check("重复退货 409", codes.dup.s === 409 && codes.dup.c === "DUPLICATE_RETURN");
  check("跨授权退货 409", codes.cross.s === 409 && codes.cross.c === "CROSS_LICENSE_RETURN");
  check("超额退货 409", codes.over.s === 409 && codes.over.c === "RETURN_EXCEEDS_SALES");

  console.log("⑥ 月末终止（当月可报、次月拒绝、区间释放）");
  await page.click(`.lic-card:has-text("${winnerId}")`);
  await page.click("button:has-text('终止')"); await waitDialogOpen(page);
  await page.fill('#licDialog input[name=date]', "2026-08-31");
  await page.fill('#licDialog input[name=reason]', "月末终止走查");
  await page.click("#licDialogOk"); await waitDialogClosed(page);
  await toastText(page, "授权已终止");
  s = await stateOf(page);
  check("终止于月末 2026-08-31", s.licenses.find(l => l.id === winnerId).terminateDate === "2026-08-31");
  const termChecks = await page.evaluate(async id => {
    const call = (path, b) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(async r => ({ s: r.status, c: (await r.json()).error?.code }));
    return {
      aug: await call("/api/reports/sales", { licenseId: id, period: "2026-08", amount: 100, idempotencyKey: "AUG" }),
      sep: await call("/api/reports/sales", { licenseId: id, period: "2026-09", amount: 100, idempotencyKey: "SEP" }),
    };
  }, winnerId);
  check("终止当月销售 201", termChecks.aug.s === 201);
  check("终止次月销售 400", termChecks.sep.s === 400 && termChecks.sep.c === "PERIOD_OUT_OF_TERM");
  const take = await page.evaluate(async () => {
    const r = await fetch("/api/licenses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ motifId: "M3", licensee: "终止后接手", exclusive: true, regions: ["浙江"], categories: ["首饰"], startDate: "2026-09-01", endDate: "2026-12-31", guarantee: 0 }) });
    return r.status;
  });
  check("终止后区间释放，9 月起他人可独占", take === 201);

  console.log("⑦ 批量导入回滚与明细");
  await page.click("#batchSample");
  await page.click("#batchBtn");
  await page.waitForSelector("#batchResult .errbox");
  const errBox = await page.locator("#batchResult .errbox").innerText();
  check("提示整批回滚 + 第 2 条明细", errBox.includes("整批回滚") && errBox.includes("第 2 条") && errBox.includes("L1"));
  const beforeCount = (await stateOf(page)).licenses.length;
  check("第 1 条也未写入", !(await stateOf(page)).licenses.some(l => l.licensee.includes("杭州文玩阁")));

  console.log("⑧ 条款分段：页面排期 → 时钟推进 → 新旧账期各用各条款");
  await page.click(`.lic-card:has-text("L1")`);
  await page.click("button:has-text('变更')"); await waitDialogOpen(page);
  await page.fill('#licDialog input[name=guarantee]', "24000");
  await page.fill('#licDialog input[name=tierText]', "10000:0.07, *:0.12");
  await page.click("#licDialogOk"); await waitDialogClosed(page);
  await toastText(page, "新条款自");
  s = await stateOf(page);
  const l1 = s.licenses.find(l => l.id === "L1");
  // 今天 9/15，前端默认下一起账月 = 2026-10
  check("已排定 2026-10 分段，当前条款镜像更新", l1.terms.some(t => t.fromMonth === "2026-10" && t.guarantee === 24000));
  check("既往 9 月账期仍按旧条款（floor 1000）", s.royalties.L1.rows.find(r => r.period === "2026-09").guaranteeFloor === 1000);
  const dataFile = srv.dataFile;
  await srv.stop();
  srv = await startServer({ now: "2026-11-20", dataFile });
  await page.goto(srv.base); await page.click("#tabLic"); await page.waitForSelector("#licApp:not([hidden])");
  await page.click(`.lic-card:has-text("L1")`);
  await page.click("button:has-text('上报销量')"); await waitDialogOpen(page);
  await page.fill('#licDialog input[name=period]', "2026-10");
  await page.fill('#licDialog input[name=amount]', "60000");
  await page.fill('#licDialog input[name=idempotencyKey]', "OCT");
  await page.click("#licDialogOk"); await waitDialogClosed(page);
  await toastText(page, "¥6,700.00"); // 新费率 10000*7%+50000*12%
  s = await stateOf(page);
  const oct = s.royalties.L1.rows.find(r => r.period === "2026-10");
  const sepRow = s.royalties.L1.rows.find(r => r.period === "2026-09");
  check("10 月用新条款：floor 2000、费率分段标记", oct.guaranteeFloor === 2000 && oct.termFrom === "2026-10");
  check("9 月旧账期不重算：floor 仍 1000", sepRow.guaranteeFloor === 1000);
  check("页面 10 月行显示「条款 2026-10」标记", await page.locator("table.roy").innerText().then(t => t.includes("条款 2026-10")));
  // 11 月无销售按新保底
  check("11 月无销售按新保底 2000", s.royalties.L1.rows.find(r => r.period === "2026-11").payable === 2000);

  console.log("⑨ 跨年续期后次年账期（时钟再推进到 2027-02）");
  await srv.stop();
  srv = await startServer({ now: "2027-02-05", dataFile });
  await page.goto(srv.base); await page.click("#tabLic");
  await page.click(`.lic-card:has-text("L1")`);
  await page.click("button:has-text('上报销量')"); await waitDialogOpen(page);
  await page.fill('#licDialog input[name=period]', "2027-01");
  await page.fill('#licDialog input[name=amount]', "30000");
  await page.fill('#licDialog input[name=idempotencyKey]', "JAN27");
  await page.click("#licDialogOk"); await waitDialogClosed(page);
  await toastText(page, "¥3,100.00");
  s = await stateOf(page);
  const periods = s.royalties.L1.rows.map(r => r.period);
  check("计提表连续跨年到 2027-02", periods[0] === "2026-01" && periods.at(-1) === "2027-02");
  check("次年 1 月按新条款计提 3100（10000*7%+20000*12%）", s.royalties.L1.rows.find(r => r.period === "2027-01").earnedRoyalty === 3100);

  console.log("⑩ 刷新与重启一致");
  const totalsBefore = JSON.stringify((await stateOf(page)).royalties.L1.total);
  await page.reload();
  await page.click("#tabLic"); await page.click(`.lic-card:has-text("L1")`);
  check("刷新后合计一致", JSON.stringify((await stateOf(page)).royalties.L1.total) === totalsBefore);
  await srv.stop();
  srv = await startServer({ now: "2027-02-05", dataFile });
  await page.goto(srv.base);
  check("重启后合计一致", JSON.stringify((await stateOf(page)).royalties.L1.total) === totalsBefore);

  console.log("⑪ 工坊看板（原功能）回归");
  await page.goto(srv.base);
  check("看板 4 列", await page.locator("#board .col").count() === 4);
  check("种子作品 3 张卡", await page.locator("#board .item").count() === 3);
  await page.fill('#workForm input[name=base]', '脱胎漆瓶');
  await page.fill('#workForm input[name=theme]', '宝相花');
  await page.evaluate(() => document.querySelector("#workForm").requestSubmit());
  await page.waitForFunction(() => [...document.querySelectorAll("#board .item b")].some(e => e.textContent === "宝相花"));
  await page.click("#tabLic"); await page.waitForSelector("#licApp:not([hidden])");
  await page.click("#tabWork");
  check("切回看板新增卡片仍在", await page.locator("#board .item").count() === 4);

  check("全程无前端脚本错误", errors.length === 0, errors.join("; "));
  console.log(`\n全部通过：${passed} 项断言`);
  await page.screenshot({ path: join(tmpdir(), "licensing-e2e-final.png"), fullPage: false });
  await srv.stop();
} catch (e) {
  console.error("\n走查失败：", e.message);
  try { await page?.screenshot({ path: "/tmp/licensing-e2e-fail.png", fullPage: true }); } catch {}
  process.exitCode = 1;
} finally {
  await browser.close();
}
