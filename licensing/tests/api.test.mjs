// 接口与规则测试：node --test tests/api.test.mjs
// 不依赖固定端口/主机路径，每个用例独立临时数据文件，时钟按需注入。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { startServer, tempFile } from "./helpers.mjs";

const live = new Set();
async function boot(opts) {
  const h = await startServer(opts);
  live.add(h);
  return h;
}
afterEach(async () => {
  for (const h of live) { await h.stop().catch(() => {}); }
  live.clear();
});

function v1DataFile() {
  const dir = mkdtempSync(join(tmpdir(), "lic-v1-"));
  const file = join(dir, "v1.json");
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
    reports: [
      { id: "R1", kind: "sale", licenseId: "L1", period: "2026-01", amount: 5000, units: 10, idempotencyKey: "OLD-1", at: "2026-02-01T00:00:00.000Z" },
      { id: "R2", kind: "sale", licenseId: "L1", period: "2026-03", amount: 20000, units: 40, idempotencyKey: "OLD-2", at: "2026-04-01T00:00:00.000Z" },
    ],
  }));
  return file;
}

test("真实时钟与注入时钟：/api/clock", async () => {
  const real = await boot();
  const realToday = new Date();
  const pad = n => String(n).padStart(2, "0");
  const expected = `${realToday.getFullYear()}-${pad(realToday.getMonth() + 1)}-${pad(realToday.getDate())}`;
  let { body } = await real.api("GET", "/api/clock");
  assert.equal(body.today, expected, "未注入时应返回真实本地日期");
  assert.equal(body.injected, false);

  const inj = await boot({ now: "2026-03-31" });
  ({ body } = await inj.api("GET", "/api/clock"));
  assert.equal(body.today, "2026-03-31");
  assert.equal(body.injected, true);
});

test("种子数据为 schema v2，计提表止于当前月、不预提未来", async () => {
  const t = await boot({ now: "2026-09-15" });
  const s = await t.state();
  assert.equal(s.schemaVersion, 2);
  const periods = s.royalties.L1.rows.map(r => r.period);
  assert.equal(periods[0], "2026-01");
  assert.equal(periods.at(-1), "2026-09");
  assert.ok(!periods.includes("2026-10"));
});

test("v1 数据迁移：补条款、加 migration 事件、上报原样；二次启动幂等", async () => {
  const file = v1DataFile();
  const before = JSON.parse(readFileSync(file, "utf8"));
  let t = await boot({ now: "2026-09-15", dataFile: file });
  let s = await t.state();
  assert.equal(s.schemaVersion, 2);
  const l = s.licenses.find(x => x.id === "L1");
  assert.deepEqual(l.terms, [{ fromMonth: "2026-01", tiers: before.licenses[0].tiers, guarantee: 6000 }]);
  assert.equal(l.versions.filter(v => v.type === "migration").length, 1);
  assert.deepEqual(
    s.reports.map(({ id, kind, period, amount, idempotencyKey }) => ({ id, kind, period, amount, idempotencyKey })),
    before.reports.map(({ id, kind, period, amount, idempotencyKey }) => ({ id, kind, period, amount, idempotencyKey })),
  );
  const jan = s.royalties.L1.rows.find(r => r.period === "2026-01");
  assert.equal(jan.earnedRoyalty, 300); // 5000*6%
  await t.stop(); live.delete(t);

  t = await boot({ now: "2026-09-15", dataFile: file });
  s = await t.state();
  assert.equal(s.licenses[0].versions.filter(v => v.type === "migration").length, 1);
  assert.equal(s.reports.length, 2, "二次启动不得重复迁移或丢失流水");
});

test("未来账期销售与未来终止日拒绝；终止当月允许、次月拒绝", async () => {
  const t = await boot({ now: "2026-09-15" });
  let r = await t.api("POST", "/api/reports/sales", { licenseId: "L1", period: "2026-10", amount: 1, idempotencyKey: "F1" });
  assert.equal(r.status, 400); assert.equal(r.body.error.code, "FUTURE_PERIOD");
  r = await t.api("POST", "/api/licenses/L1/terminate", { date: "2026-10-01", reason: "x" });
  assert.equal(r.status, 400); assert.equal(r.body.error.code, "FUTURE_TERMINATION");

  r = await t.api("POST", "/api/licenses/L2/terminate", { date: "2026-08-31", reason: "月末终止" });
  assert.equal(r.status, 200);
  r = await t.api("POST", "/api/reports/sales", { licenseId: "L2", period: "2026-08", amount: 1000, idempotencyKey: "AUG" });
  assert.equal(r.status, 201);
  r = await t.api("POST", "/api/reports/sales", { licenseId: "L2", period: "2026-09", amount: 1000, idempotencyKey: "SEP" });
  assert.equal(r.body.error.code, "PERIOD_OUT_OF_TERM");
});

test("月末终止释放后续区间：次月起他人可独占，终止区间仍阻挡重叠", async () => {
  const t = await boot({ now: "2026-09-15" });
  await t.api("POST", "/api/licenses/L2/terminate", { date: "2026-06-30", reason: "r" });
  const ok = await t.api("POST", "/api/licenses", {
    motifId: "M2", licensee: "接手方", exclusive: true, regions: ["福建"], categories: ["挂件"],
    startDate: "2026-07-01", endDate: "2026-12-31", guarantee: 0,
  });
  assert.equal(ok.status, 201);
  const bad = await t.api("POST", "/api/licenses", {
    motifId: "M2", licensee: "重叠方", exclusive: true, regions: ["广东"], categories: ["首饰"],
    startDate: "2026-03-01", endDate: "2026-06-30", guarantee: 0,
  });
  assert.equal(bad.status, 409);
  assert.equal(bad.body.error.code, "EXCLUSIVE_OVERLAP");
});

test("阶梯费率超额累进：5%/8%/10% 对 60000 计提 4700", async () => {
  const t = await boot({ now: "2026-09-15" });
  const r = await t.api("POST", "/api/reports/sales", { licenseId: "L1", period: "2026-02", amount: 60000, units: 1, idempotencyKey: "K" });
  assert.equal(r.body.royalty.fee, 4700);
});

test("保底逐月抵扣：无销售月付月保底 1000，销售高时不重复补", async () => {
  const t = await boot({ now: "2026-09-15" });
  await t.api("POST", "/api/reports/sales", { licenseId: "L1", period: "2026-02", amount: 60000, idempotencyKey: "K" });
  const s = await t.state();
  const rows = Object.fromEntries(s.royalties.L1.rows.map(r => [r.period, r]));
  assert.equal(rows["2026-01"].payable, 1000);
  assert.equal(rows["2026-01"].guaranteeOffset, 600);
  assert.equal(rows["2026-02"].payable, 4700);
  assert.equal(rows["2026-02"].guaranteeOffset, 0);
  assert.equal(rows["2026-04"].payable, 1000);
  assert.equal(rows["2026-04"].guaranteeOffset, 1000);
});

test("条款分段：先排未来月份；时钟推进后新旧账期各用各的费率/保底，既往不重算", async () => {
  const { dir, file } = tempFile();
  let t = await boot({ now: "2026-06-15", dataFile: file });
  const r = await t.api("POST", "/api/licenses/L1/change", {
    reason: "年度调价",
    patch: { guarantee: 24000, tiers: [{ upTo: 10000, rate: 0.07 }, { upTo: null, rate: 0.12 }], effectiveFromMonth: "2026-10" },
  });
  assert.equal(r.status, 200);
  const earlier = await t.api("POST", "/api/licenses/L1/change", { patch: { guarantee: 1 }, effectiveFromMonth: "2026-08" });
  assert.equal(earlier.body.error.code, "TERM_ORDER");
  const retro = await t.api("POST", "/api/licenses/L1/change", { patch: { guarantee: 1 }, effectiveFromMonth: "2026-06" });
  assert.equal(retro.body.error.code, "RETROACTIVE_TERM");
  await t.stop(); live.delete(t);

  t = await boot({ now: "2026-11-20", dataFile: file });
  await t.api("POST", "/api/reports/sales", { licenseId: "L1", period: "2026-09", amount: 60000, idempotencyKey: "SEP" });
  const octSale = await t.api("POST", "/api/reports/sales", { licenseId: "L1", period: "2026-10", amount: 60000, idempotencyKey: "OCT" });
  const ret = await t.api("POST", "/api/reports/return", { licenseId: "L1", returnId: "RT1", originalReportId: octSale.body.report.id, amount: 20000 });
  assert.equal(ret.body.reversal, 2400); // 新费率：6700 - 4300
  const s = await t.state();
  const rows = Object.fromEntries(s.royalties.L1.rows.map(x => [x.period, x]));
  assert.equal(rows["2026-09"].termFrom, "2026-01");
  assert.equal(rows["2026-09"].earnedRoyalty, 4700);
  assert.equal(rows["2026-09"].guaranteeFloor, 1000);
  assert.equal(rows["2026-10"].termFrom, "2026-10");
  assert.equal(rows["2026-10"].sales, 60000);
  assert.equal(rows["2026-10"].returns, 20000);
  assert.equal(rows["2026-10"].earnedRoyalty, 4300);
  assert.equal(rows["2026-10"].guaranteeFloor, 2000);
  assert.equal(rows["2026-11"].payable, 2000);
});

test("跨年续期：时钟推进后次年账期可报、计提连续", async () => {
  const { dir, file } = tempFile();
  let t = await boot({ now: "2026-12-20", dataFile: file });
  const rn = await t.api("POST", "/api/licenses/L1/renew", { endDate: "2027-12-31", note: "跨年续约" });
  assert.equal(rn.status, 200);
  const fut = await t.api("POST", "/api/reports/sales", { licenseId: "L1", period: "2027-01", amount: 1, idempotencyKey: "F" });
  assert.equal(fut.body.error.code, "FUTURE_PERIOD");
  await t.stop(); live.delete(t);

  t = await boot({ now: "2027-02-05", dataFile: file });
  const jan = await t.api("POST", "/api/reports/sales", { licenseId: "L1", period: "2027-01", amount: 30000, idempotencyKey: "JAN" });
  assert.equal(jan.status, 201);
  const s = await t.state();
  const periods = s.royalties.L1.rows.map(r => r.period);
  assert.equal(periods[0], "2026-01");
  assert.equal(periods.at(-1), "2027-02");
  assert.equal(s.royalties.L1.rows.find(r => r.period === "2027-01").earnedRoyalty, 2100);
});

test("退货：原账期冲减、重复单号/跨授权/超额全部拒绝", async () => {
  const t = await boot({ now: "2026-09-15" });
  const sale = await t.api("POST", "/api/reports/sales", { licenseId: "L1", period: "2026-02", amount: 10000, idempotencyKey: "S1" });
  const ret = await t.api("POST", "/api/reports/return", { licenseId: "L1", returnId: "RT1", originalReportId: sale.body.report.id, amount: 4000 });
  assert.equal(ret.status, 201);
  assert.equal(ret.body.report.originPeriod, "2026-02");
  assert.equal(ret.body.reversal, 200); // 10000*5%=500 → 6000*5%=300
  const dup = await t.api("POST", "/api/reports/return", { licenseId: "L1", returnId: "RT1", originalReportId: sale.body.report.id, amount: 1 });
  assert.equal(dup.body.error.code, "DUPLICATE_RETURN");
  const cross = await t.api("POST", "/api/reports/return", { licenseId: "L2", returnId: "RTX", originalReportId: sale.body.report.id, amount: 1 });
  assert.equal(cross.body.error.code, "CROSS_LICENSE_RETURN");
  const over = await t.api("POST", "/api/reports/return", { licenseId: "L1", returnId: "RT2", originalReportId: sale.body.report.id, amount: 999999 });
  assert.equal(over.body.error.code, "RETURN_EXCEEDS_SALES");
  const s = await t.state();
  assert.equal(s.reports.filter(r => r.kind === "return").length, 1);
});

test("销售幂等：同凭证号同内容返回原记录；不同内容占用凭证号拒绝", async () => {
  const t = await boot({ now: "2026-09-15" });
  const a = await t.api("POST", "/api/reports/sales", { licenseId: "L1", period: "2026-02", amount: 100, idempotencyKey: "K1" });
  const b = await t.api("POST", "/api/reports/sales", { licenseId: "L1", period: "2026-02", amount: 100, idempotencyKey: "K1" });
  assert.equal(a.body.report.id, b.body.report.id);
  assert.equal(b.body.duplicated, true);
  const c = await t.api("POST", "/api/reports/sales", { licenseId: "L1", period: "2026-02", amount: 11, idempotencyKey: "K1" });
  assert.equal(c.body.error.code, "DUPLICATE_KEY");
});

test("并发独占：两个同范围请求同时提交恰好一成一败", async () => {
  const t = await boot({ now: "2026-09-15" });
  const body = {
    motifId: "M3", licensee: "并发", exclusive: true, regions: ["浙江"], categories: ["首饰"],
    startDate: "2026-07-01", endDate: "2026-09-30", guarantee: 0,
  };
  const results = await Promise.all([
    t.api("POST", "/api/licenses", { ...body, licensee: "并发甲" }),
    t.api("POST", "/api/licenses", { ...body, licensee: "并发乙" }),
  ]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  const s = await t.state();
  assert.equal(s.licenses.filter(l => l.licensee.startsWith("并发")).length, 1);
});

test("批量导入：任一条失败整批回滚并返回逐条明细", async () => {
  const t = await boot({ now: "2026-09-15" });
  const before = (await t.state()).licenses.length;
  const r = await t.api("POST", "/api/batch/licenses", { items: [
    { motifId: "M3", licensee: "批甲", exclusive: false, regions: ["江苏"], categories: ["挂件"], startDate: "2026-03-01", endDate: "2026-12-31", guarantee: 0 },
    { motifId: "M1", licensee: "批乙冲突", exclusive: true, regions: ["福建"], categories: ["摆件"], startDate: "2026-05-01", endDate: "2026-07-31", guarantee: 0 },
  ] });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, "BATCH_ROLLED_BACK");
  assert.deepEqual(r.body.error.details.failures.map(f => f.index), [1]);
  assert.equal(r.body.error.details.failures[0].code, "EXCLUSIVE_OVERLAP");
  const s = await t.state();
  assert.equal(s.licenses.length, before);
  assert.ok(!s.licenses.some(l => l.licensee === "批甲"));
});

test("刷新/重启一致：落盘后重启进程数据不变", async () => {
  const { dir, file } = tempFile();
  let t = await boot({ now: "2026-09-15", dataFile: file });
  await t.api("POST", "/api/reports/sales", { licenseId: "L1", period: "2026-02", amount: 60000, idempotencyKey: "K" });
  const before = JSON.stringify((await t.state()).royalties.L1.total);
  await t.stop(); live.delete(t);
  t = await boot({ now: "2026-09-15", dataFile: file });
  assert.equal(JSON.stringify((await t.state()).royalties.L1.total), before);
});

test("非法日期：2026-02-29（平年）拒绝，账期格式校验", async () => {
  const t = await boot({ now: "2026-09-15" });
  const r = await t.api("POST", "/api/licenses", {
    motifId: "M3", licensee: "x", exclusive: false, regions: ["a"], categories: ["b"],
    startDate: "2026-02-29", endDate: "2026-12-31", guarantee: 0,
  });
  assert.equal(r.body.error.code, "INVALID_DATE");
  const bad = await t.api("POST", "/api/reports/sales", { licenseId: "L1", period: "2026/02", amount: 1, idempotencyKey: "X" });
  assert.equal(bad.body.error.code, "INVALID_PERIOD");
});
