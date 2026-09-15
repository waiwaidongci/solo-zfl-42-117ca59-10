// 漆线雕工坊 · 纹样版权授权与版税计提台 —— 零依赖 Node 服务
// 设计要点：
// 1) 所有写事务的“读当前状态 -> 校验 -> 修改 -> 落盘”全程同步执行，
//    Node 单事件循环内不会交错，从根本上避免两个请求同时提交产生重叠独占授权。
// 2) 落盘采用 临时文件 + rename 原子替换，刷新/重启后结果一致。
// 3) 续期、终止、变更均写入版本事件流，只追加、不改写历史。
// 4) 账期按真实本地日期推进；测试可通过环境变量 LICENSING_NOW=YYYY-MM-DD 注入时钟。
// 5) 保底/阶梯等财务条款变更自指定月份起生效，既往账期一律不重算。
// 6) 数据文件带 schemaVersion，旧版数据加载时迁移，上报流水永不重算或丢失。
import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  existsSync, mkdirSync, readFileSync, renameSync, writeFileSync,
} from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PORT = Number(process.env.PORT || 4217);
const DATA_FILE = process.env.DATA_FILE || join(__dirname, "data", "data.json");
const SCHEMA_VERSION = 2;

// ---------- 时钟（真实本地日期，可注入） ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

function localDateParts(d) {
  return { y: d.getFullYear(), m: d.getMonth() + 1, day: d.getDate() };
}
function dateString(d) {
  const { y, m, day } = localDateParts(d);
  return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function nowLocalDate() {
  // 测试时钟：仅读环境变量，HTTP 头不能改变时钟，避免被外部请求注入
  const injected = process.env.LICENSING_NOW;
  if (injected !== undefined && injected !== "") {
    if (!DATE_RE.test(injected)) {
      console.error(`LICENSING_NOW 格式应为 YYYY-MM-DD，实际：${injected}`);
      process.exit(2);
    }
    return injected;
    }
  return dateString(new Date());
}
function nowIso() {
  // 时间戳沿用注入日期（取当日本地零点转为 ISO），保证演示/测试确定性
  return new Date(`${nowLocalDate()}T00:00:00`).toISOString();
}
function firstDayOfMonth(month) { return `${month}-01`; }
function firstDayOfNextMonth(month) { return addMonths(month, 1); }

// ---------- 日期工具 ----------
function isValidDate(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00`);
  return !Number.isNaN(d.getTime()) && dateString(d) === s;
}
function isValidMonth(s) {
  if (typeof s !== "string" || !MONTH_RE.test(s)) return false;
  return isValidDate(firstDayOfMonth(s));
}
function addDays(s, n) {
  const d = new Date(`${s}T00:00:00`);
  d.setDate(d.getDate() + n);
  return dateString(d);
}
function monthOf(s) { return s.slice(0, 7); }
function addMonths(m, n) {
  const [y, mo] = m.split("-").map(Number);
  const total = y * 12 + (mo - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}
function overlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}
class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status; this.code = code; this.details = details;
  }
}

// ---------- 阶梯版税（纯函数，便于测试） ----------
// tiers: [{ fromMonth, tiers, guarantee }] 按生效月份升序；
// 每个账期只取对应该月生效的一套费率/保底，财务条款变更不追溯既往账期。
function normalizeTiers(input, ctx = "阶梯费率") {
  const list = Array.isArray(input) && input.length
    ? input
    : [
        { upTo: 10000, rate: 0.05 },
        { upTo: 50000, rate: 0.08 },
        { upTo: null, rate: 0.1 },
      ];
  let last = 0;
  return list.map((t, i) => {
    const rate = Number(t?.rate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
      throw new ApiError(400, "INVALID_TIER", `${ctx}第 ${i + 1} 档费率应为 0~1 之间的数字`);
    }
    let upTo = t?.upTo === null || t?.upTo === "" || t?.upTo === undefined ? null : Number(t.upTo);
    if (upTo !== null) {
      if (!Number.isFinite(upTo) || upTo <= last) {
        throw new ApiError(400, "INVALID_TIER", `${ctx}第 ${i +1} 档上限必须递增且为正数（最后一档填 null/空表示无上限）`);
      }
      last = upTo;
    }
    return { upTo, rate: Math.round(rate * 10000) / 10000 };
  });
}
function royaltyOf(amount, tiers) {
  let rest = Math.max(0, amount);
  let base = 0;
  let fee = 0;
  const steps = [];
  for (const t of tiers) {
    if (rest <= 0) break;
    const cap = t.upTo === null ? Infinity : t.upTo;
    const width = cap - base;
    const take = Math.min(rest, width);
    fee += take * t.rate;
    steps.push({ from: base, to: cap === Infinity ? null : cap, amount: round2(take), rate: t.rate });
    rest -= take;
    base = cap;
  }
  return { fee: round2(fee), steps };
}
function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

// 一套财务条款在某个账期月是否生效
function termApplies(term, month) {
  return term.fromMonth <= month;
}
// 取指定账期生效的条款（最近一个 fromMonth <= month 的分段）
function termForMonth(terms, month) {
  let hit = terms[0];
  for (const t of terms) if (termApplies(t, month) && t.fromMonth <= month && (!hit || t.fromMonth >= hit.fromMonth)) hit = t;
  return hit;
}

// ---------- 数据存取（原子落盘）与迁移 ----------
function defaultTiers() {
  return normalizeTiers([
    { upTo: 10000, rate: 0.05 },
    { upTo: 50000, rate: 0.08 },
    { upTo: null, rate: 0.1 },
  ]);
}
function seedData() {
  const t = defaultTiers();
  return {
    schemaVersion: SCHEMA_VERSION,
    seq: 5,
    motifs: [
      { id: "M1", name: "缠枝莲", author: "庄淑敏", style: "缠枝花卉", registeredAt: "2025-03-12", note: "代表作，金粉偏赤" },
      { id: "M2", name: "海水江崖", author: "陈阿月", style: "吉祥瑞兽", registeredAt: "2025-05-08", note: "低浮雕边线" },
      { id: "M3", name: "云雷纹", author: "林启明", style: "几何回纹", registeredAt: "2025-09-01", note: "" },
    ],
    licenses: [
      {
        id: "L1", motifId: "M1", licensee: "厦门鹭艺礼品有限公司", exclusive: true,
        regions: ["福建"], categories: ["摆件"],
        startDate: "2026-01-01", endDate: "2026-12-31",
        tiers: t, guarantee: 12000,
        terms: [{ fromMonth: "2026-01", tiers: t, guarantee: 12000 }],
        status: "active", terminateDate: null, terminateReason: null,
        createdAt: "2025-12-20",
        versions: [{ type: "create", at: "2025-12-20T00:00:00.000Z", endDate: "2026-12-31", note: "首次独占授权", snapshot: null }],
      },
      {
        id: "L2", motifId: "M2", licensee: "泉州海丝文创行", exclusive: false,
        regions: ["福建", "广东"], categories: ["挂件", "首饰"],
        startDate: "2026-02-01", endDate: "2027-01-31",
        tiers: t, guarantee: 0,
        terms: [{ fromMonth: "2026-02", tiers: t, guarantee: 0 }],
        status: "active", terminateDate: null, terminateReason: null,
        createdAt: "2026-01-15",
        versions: [{ type: "create", at: "2026-01-15T00:00:00.000Z", endDate: "2027-01-31", note: "普通（非独占）授权", snapshot: null }],
      },
    ],
    reports: [
      { id: "R1", kind: "sale", licenseId: "L1", period: "2026-01", amount: 8000, units: 40, idempotencyKey: "seed-R1", at: "2026-02-03T00:00:00.000Z" },
    ],
  };
}

let db;
function persist() {
  mkdirSync(dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, JSON.stringify(db, null, 2));
  renameSync(tmp, DATA_FILE); // 同目录 rename 原子替换
}
// 旧版（无 schemaVersion / v1）数据迁移：
// - 上报流水原样保留，绝不重算或删除；
// - 用既有 tiers/guarantee 反推一条从授权起始月生效的条款分段；
// - 版本历史不动，只追加一条 migration 记录。
function migrate(raw) {
  const v = raw.schemaVersion || 1;
  if (v === SCHEMA_VERSION) return raw;
  if (v > SCHEMA_VERSION) throw new Error(`数据文件版本 ${v} 高于本程序支持的 ${SCHEMA_VERSION}，拒绝启动以防数据损坏`);
  for (const l of raw.licenses || []) {
    if (!Array.isArray(l.terms) || !l.terms.length) {
      const tiers = normalizeTiers(l.tiers);
      const guarantee = Number.isFinite(Number(l.guarantee)) ? Number(l.guarantee) : 0;
      l.terms = [{ fromMonth: monthOf(l.startDate), tiers, guarantee }];
    }
    // 顶层 tiers/guarantee 保留为“当前条款”的镜像，供旧前端/排查使用
    const latest = l.terms.reduce((a, b) => (b.fromMonth > a.fromMonth ? b : a));
    l.tiers = latest.tiers;
    l.guarantee = latest.guarantee;
    l.versions = l.versions || [];
    l.versions.push({
      type: "migration",
      at: nowIso(),
      note: `数据迁移 schema v${v} → v${SCHEMA_VERSION}：补全条款分段，历史上报与计提不重算`,
      snapshot: { fromVersion: v, toVersion: SCHEMA_VERSION, termsFromMonth: l.terms[0].fromMonth },
    });
  }
  raw.schemaVersion = SCHEMA_VERSION;
  return raw;
}
function load() {
  if (!existsSync(DATA_FILE)) { db = seedData(); persist(); return; }
  const raw = JSON.parse(readFileSync(DATA_FILE, "utf8"));
  const before = JSON.stringify(raw.reports || []);
  db = migrate(raw);
  if (JSON.stringify(db.reports) !== before) throw new Error("迁移导致上报流水变化，中止启动");
  persist(); // 迁移成功后落盘新版本（幂等：已是 v2 时 migrate 原样返回）
}
function nextId(prefix) {
  const id = `${prefix}${db.seq}`;
  db.seq += 1;
  return id;
}

// ---------- 领域规则 ----------
function getMotif(id) {
  const m = db.motifs.find(x => x.id === id);
  if (!m) throw new ApiError(404, "MOTIF_NOT_FOUND", `纹样 ${id} 不存在`);
  return m;
}
function getLicense(id) {
  const l = db.licenses.find(x => x.id === id);
  if (!l) throw new ApiError(404, "LICENSE_NOT_FOUND", `授权 ${id} 不存在`);
  return l;
}
// 当前有效到期日（取最新续期版本的 endDate）
function effectiveEnd(l) {
  let end = l.endDate;
  for (const v of l.versions) if (v.type === "renewal" && v.endDate > end) end = v.endDate;
  return end;
}
// 冲突检测所用的实际权利区间：终止后截止到终止日当天（销售只能报到终止月）
function conflictInterval(l) {
  const end = l.status === "terminated" ? l.terminateDate : effectiveEnd(l);
  return { start: l.startDate, end };
}
function scopeList(v) {
  if (!Array.isArray(v)) throw new ApiError(400, "INVALID_SCOPE", "可用地区/品类必须是数组");
  const out = [...new Set(v.map(s => String(s).trim()).filter(Boolean))];
  if (!out.length) throw new ApiError(400, "INVALID_SCOPE", "可用地区与品类至少各填一项");
  return out;
}
function findConflictOn(target, candidate, ignoreId = null) {
  for (const l of target.licenses) {
    if (l.id === ignoreId || l.motifId !== candidate.motifId) continue;
    if (!candidate.exclusive && !l.exclusive) continue; // 双方都非独占不冲突
    const regionHit = candidate.regions.some(r => l.regions.includes(r));
    const categoryHit = candidate.categories.some(c => l.categories.includes(c));
    if (!regionHit || !categoryHit) continue;
    const iv = l.status === "terminated"
      ? { start: l.startDate, end: l.terminateDate }
      : { start: l.startDate, end: effectiveEnd(l) };
    if (overlap(candidate.startDate, candidate.endDate, iv.start, iv.end)) return l;
  }
  return null;
}
function validateLicenseInput(body) {
  if (!body || typeof body !== "object") throw new ApiError(400, "BAD_REQUEST", "请求体必须是 JSON 对象");
  const motifId = String(body.motifId || "").trim();
  if (!motifId) throw new ApiError(400, "MOTIF_REQUIRED", "必须选择纹样");
  getMotif(motifId);
  const licensee = String(body.licensee || "").trim();
  if (!licensee) throw new ApiError(400, "LICENSEE_REQUIRED", "必须填写被授权方");
  const exclusive = Boolean(body.exclusive);
  const regions = scopeList(body.regions);
  const categories = scopeList(body.categories);
  const { startDate, endDate } = body;
  if (!isValidDate(startDate)) throw new ApiError(400, "INVALID_DATE", "起始日期格式应为 YYYY-MM-DD");
  if (!isValidDate(endDate)) throw new ApiError(400, "INVALID_DATE", "到期日期格式应为 YYYY-MM-DD");
  if (endDate <= startDate) throw new ApiError(400, "INVALID_RANGE", "到期日期必须晚于起始日期");
  const guarantee = body.guarantee === "" || body.guarantee === undefined ? 0 : Number(body.guarantee);
  if (!Number.isFinite(guarantee) || guarantee < 0) throw new ApiError(400, "INVALID_GUARANTEE", "年保底金额必须是非负数字");
  const tiers = normalizeTiers(body.tiers);
  return { motifId, licensee, exclusive, regions, categories, startDate, endDate, guarantee: round2(guarantee), tiers };
}
function createLicenseOn(target, body) {
  const input = validateLicenseInput(body);
  const hit = findConflictOn(target, input);
  if (hit) {
    throw new ApiError(409, "EXCLUSIVE_OVERLAP",
      `独占冲突：与 ${hit.id}（${hit.licensee}，${hit.startDate}~${conflictInterval(hit).end}，地区 ${hit.regions.join("/")}，品类 ${hit.categories.join("/")}）在同一权利范围与期间重叠`,
      { conflictingLicenseId: hit.id });
  }
  const id = `L${target.seq++}`;
  const lic = {
    id, ...input,
    terms: [{ fromMonth: monthOf(input.startDate), tiers: input.tiers, guarantee: input.guarantee }],
    status: "active", terminateDate: null, terminateReason: null,
    createdAt: nowIso().slice(0, 10),
    versions: [{ type: "create", at: nowIso(), endDate: input.endDate, note: String(body.note || "首次授权"), snapshot: null }],
  };
  target.licenses.push(lic);
  return lic;
}

// ---------- 版税/上报 ----------
function periodRollups(l) {
  const end = effectiveEnd(l);
  // 未到期：只计提到真实当前月（含），未来月份不预提；已终止：截止终止月
  const lastMonth = l.status === "terminated"
    ? monthOf(l.terminateDate)
    : (monthOf(end) < monthOf(nowLocalDate()) ? monthOf(end) : monthOf(nowLocalDate()));
  const months = [];
  for (let m = monthOf(l.startDate); m <= lastMonth; m = addMonths(m, 1)) months.push(m);

  const byPeriod = new Map();
  const ensure = p => {
    if (!byPeriod.has(p)) byPeriod.set(p, { period: p, sales: 0, returns: 0, unitsSales: 0, unitsReturn: 0 });
    return byPeriod.get(p);
  };
  for (const r of db.reports) {
    if (r.licenseId !== l.id) continue;
    if (r.kind === "sale") {
      const row = ensure(r.period);
      row.sales = round2(row.sales + r.amount);
      row.unitsSales += r.units || 0;
    } else if (r.kind === "return") {
      // 退货按原销售期逐期冲减
      const row = ensure(r.originPeriod);
      row.returns = round2(row.returns + r.amount);
      row.unitsReturn += r.units || 0;
    }
  }
  const out = months.map(m => {
    const row = byPeriod.get(m) || { period: m, sales: 0, returns: 0, unitsSales: 0, unitsReturn: 0 };
    const net = round2(row.sales - row.returns);
    const term = termForMonth(l.terms, m);
    const floor = term.guarantee > 0 ? round2(term.guarantee / 12) : 0;
    const earned = royaltyOf(net, term.tiers).fee;
    const payable = round2(Math.max(earned, floor));
    return {
      ...row, net,
      termFrom: term.fromMonth,
      grossRoyalty: royaltyOf(row.sales, term.tiers).fee,
      earnedRoyalty: earned,
      guaranteeFloor: floor,
      guaranteeOffset: round2(payable - earned), // 保底抵扣
      payable,
    };
  });
  const total = out.reduce((acc, r) => ({
    sales: round2(acc.sales + r.sales), returns: round2(acc.returns + r.returns),
    net: round2(acc.net + r.net), earnedRoyalty: round2(acc.earnedRoyalty + r.earnedRoyalty),
    guaranteeOffset: round2(acc.guaranteeOffset + r.guaranteeOffset), payable: round2(acc.payable + r.payable),
  }), { sales: 0, returns: 0, net: 0, earnedRoyalty: 0, guaranteeOffset: 0, payable: 0 });
  const currentTerm = termForMonth(l.terms, monthOf(nowLocalDate()));
  return {
    rows: out, total,
    floor: currentTerm.guarantee > 0 ? round2(currentTerm.guarantee / 12) : 0,
    terms: l.terms,
  };
}

function assertWithinTerm(l, period) {
  const start = monthOf(l.startDate);
  const last = l.status === "terminated" ? monthOf(l.terminateDate) : monthOf(effectiveEnd(l));
  if (period < start || period > last) {
    throw new ApiError(400, "PERIOD_OUT_OF_TERM", `账期 ${period} 不在授权 ${l.id} 的权利期 ${start}~${last} 内`);
  }
}
function assertNotFutureMonth(period, action) {
  const current = monthOf(nowLocalDate());
  if (period > current) {
    throw new ApiError(400, "FUTURE_PERIOD",
      `${action}账期 ${period} 晚于当前账期 ${current}：按真实账期结算，未来账期请在对应月份再报（测试可用 LICENSING_NOW 注入时钟）`);
  }
}
function addSale(body) {
  const l = getLicense(String(body.licenseeId || body.licenseId || "").trim());
  const period = String(body.period || "");
  if (!isValidMonth(period)) throw new ApiError(400, "INVALID_PERIOD", "账期格式应为 YYYY-MM");
  assertWithinTerm(l, period);
  assertNotFutureMonth(period, "销售");
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new ApiError(400, "INVALID_AMOUNT", "回款销售额必须为正数");
  const units = Number(body.units || 0);
  if (!Number.isFinite(units) || units < 0) throw new ApiError(400, "INVALID_UNITS", "件数必须为非负数");
  const key = String(body.idempotencyKey || "").trim();
  if (!key) throw new ApiError(400, "KEY_REQUIRED", "缺少上报凭证号（幂等键）");
  const dup = db.reports.find(r => r.idempotencyKey === key);
  if (dup) {
    if (dup.kind === "sale" && dup.licenseId === l.id && dup.period === period && dup.amount === round2(amount)) {
      return { report: dup, duplicated: true };
    }
    throw new ApiError(409, "DUPLICATE_KEY", `上报凭证号 ${key} 已被其他记录使用，重复上报被拒绝`);
  }
  const report = {
    id: nextId("R"), kind: "sale", licenseId: l.id, period,
    amount: round2(amount), units, idempotencyKey: key, at: nowIso(),
  };
  db.reports.push(report);
  const term = termForMonth(l.terms, period);
  return { report, duplicated: false, royalty: royaltyOf(amount, term.tiers) };
}
function periodSalesOf(l, period) {
  return db.reports
    .filter(r => r.licenseId === l.id && r.kind === "sale" && r.period === period)
    .reduce((s, r) => s + r.amount, 0);
}
function periodReturnsOf(l, period) {
  return db.reports
    .filter(r => r.licenseId === l.id && r.kind === "return" && r.originPeriod === period)
    .reduce((s, r) => s + r.amount, 0);
}
function addReturn(body) {
  const licenseId = String(body.licenseId || "").trim();
  const l = getLicense(licenseId);
  const returnId = String(body.returnId || "").trim();
  if (!returnId) throw new ApiError(400, "RETURN_ID_REQUIRED", "必须填写退货单号");
  if (db.reports.some(r => r.returnId === returnId)) {
    throw new ApiError(409, "DUPLICATE_RETURN", `退货单号 ${returnId} 重复，拒绝重复冲减`);
  }
  const originalId = String(body.originalReportId || "").trim();
  const sale = db.reports.find(r => r.id === originalId);
  if (!sale || sale.kind !== "sale") throw new ApiError(404, "ORIGINAL_SALE_NOT_FOUND", "必须指定原销售上报记录");
  // 跨授权上报：退货必须挂在原销售所属授权下
  if (sale.licenseId !== l.id) {
    throw new ApiError(409, "CROSS_LICENSE_RETURN",
      `跨授权上报被拒绝：原销售 ${sale.id} 属于授权 ${sale.licenseId}，不能记入授权 ${l.id}`);
  }
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new ApiError(400, "INVALID_AMOUNT", "退货金额必须为正数");
  const units = Number(body.units || 0);
  if (!Number.isFinite(units) || units < 0) throw new ApiError(400, "INVALID_UNITS", "件数必须为非负数");
  const period = sale.period; // 按原账期冲减（跨月退货也回到销售发生月）
  const already = periodReturnsOf(l, period);
  const salesTotal = periodSalesOf(l, period);
  if (round2(already + amount) > round2(salesTotal)) {
    throw new ApiError(409, "RETURN_EXCEEDS_SALES",
      `退货超额：${period} 原授权销售合计 ${salesTotal}，已退 ${already}，本次 ${round2(amount)}，不得超过销售额`);
  }
  const term = termForMonth(l.terms, period);
  const before = royaltyOf(round2(salesTotal - already), term.tiers).fee;
  const afterNet = round2(salesTotal - already - amount);
  const after = royaltyOf(afterNet, term.tiers).fee;
  const reversal = round2(before - after);
  const report = {
    id: nextId("R"), kind: "return", licenseId: l.id, period,
    originPeriod: period, originalReportId: sale.id, returnId,
    amount: round2(amount), units, reversal,
    idempotencyKey: `ret-${returnId}`, at: nowIso(),
  };
  db.reports.push(report);
  return { report, reversal };
}

// ---------- HTTP 层 ----------
function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", c => { raw += c; if (raw.length > 2e6) reject(new ApiError(413, "TOO_LARGE", "请求体过大")); });
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new ApiError(400, "BAD_JSON", "JSON 解析失败")); }
    });
    req.on("error", reject);
  });
}
function publicState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    today: nowLocalDate(),
    motifs: db.motifs,
    licenses: db.licenses.map(l => ({ ...l, effectiveEnd: effectiveEnd(l) })),
    reports: db.reports,
    royalties: Object.fromEntries(db.licenses.map(l => [l.id, periodRollups(l)])),
  };
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT || 0}`);
  const p = url.pathname;
  try {
    // 静态页面
    if (req.method === "GET" && (p === "/" || p === "/index.html")) {
      const html = readFileSync(join(ROOT, "index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(html);
    }
    if (req.method !== "GET" && !p.startsWith("/api/")) throw new ApiError(404, "NOT_FOUND", "路径不存在");

    if (req.method === "GET" && p === "/api/state") return send(res, 200, publicState());
    if (req.method === "GET" && p === "/api/clock") {
      return send(res, 200, { today: nowLocalDate(), injected: Boolean(process.env.LICENSING_NOW), schemaVersion: SCHEMA_VERSION });
    }

    if (req.method === "POST" && p === "/api/reset") {
      db = seedData(); persist();
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && p === "/api/motifs") {
      const body = await readBody(req);
      const name = String(body.name || "").trim();
      if (!name) throw new ApiError(400, "NAME_REQUIRED", "纹样名称必填");
      const author = String(body.author || "").trim();
      if (!author) throw new ApiError(400, "AUTHOR_REQUIRED", "作者必填");
      if (db.motifs.some(m => m.name === name)) throw new ApiError(409, "MOTIF_EXISTS", `纹样「${name}」已登记`);
      const motif = {
        id: `M${db.seq++}`, name, author,
        style: String(body.style || "").trim(),
        registeredAt: isValidDate(body.registeredAt) ? body.registeredAt : nowLocalDate(),
        note: String(body.note || "").trim(),
      };
      db.motifs.push(motif); persist();
      return send(res, 201, { ok: true, motif });
    }
    if (req.method === "POST" && p === "/api/licenses") {
      const body = await readBody(req);
      // 以下整体同步执行：校验 + 写入 + 落盘在同一轮事件循环内完成
      const lic = createLicenseOn(db, body);
      persist();
      return send(res, 201, { ok: true, license: lic });
    }
    let m = p.match(/^\/api\/licenses\/([^/]+)\/(renew|terminate|change)$/);
    if (req.method === "POST" && m) {
      const l = getLicense(m[1]);
      const body = await readBody(req);
      const now = nowIso();
      if (m[2] === "renew") {
        if (l.status === "terminated") throw new ApiError(409, "TERMINATED", "已终止授权不能续期，请新建授权");
        const newEnd = String(body.endDate || "");
        if (!isValidDate(newEnd)) throw new ApiError(400, "INVALID_DATE", "续期到期日格式应为 YYYY-MM-DD");
        const cur = effectiveEnd(l);
        if (newEnd <= cur) throw new ApiError(400, "INVALID_RENEWAL", `续期到期日必须晚于当前到期日 ${cur}`);
        l.versions.push({
          type: "renewal", at: now, startDate: addDays(cur, 1), endDate: newEnd,
          note: String(body.note || `续期至 ${newEnd}`), snapshot: null,
        });
        persist();
        return send(res, 200, { ok: true, license: l });
      }
      if (m[2] === "terminate") {
        if (l.status === "terminated") throw new ApiError(409, "TERMINATED", "授权已终止，不能重复终止");
        const date = String(body.date || "");
        if (!isValidDate(date)) throw new ApiError(400, "INVALID_DATE", "终止日期格式应为 YYYY-MM-DD");
        if (date < l.startDate) throw new ApiError(400, "INVALID_DATE", "终止日期不能早于授权起始日");
        if (date > nowLocalDate()) throw new ApiError(400, "FUTURE_TERMINATION",
          `终止日期 ${date} 晚于今天 ${nowLocalDate()}，不能预终止（测试可用 LICENSING_NOW 注入时钟）`);
        l.status = "terminated";
        l.terminateDate = date;
        l.terminateReason = String(body.reason || "").trim();
        l.versions.push({
          type: "terminate", at: now, endDate: effectiveEnd(l), terminateDate: date,
          note: l.terminateReason || "提前终止", snapshot: null,
        });
        persist();
        return send(res, 200, { ok: true, license: l });
      }
      if (m[2] === "change") {
        const patch = body.patch || body;
        const before = {
          exclusive: l.exclusive, regions: l.regions, categories: l.categories,
          tiers: l.tiers, guarantee: l.guarantee, licensee: l.licensee,
          terms: structuredClone(l.terms),
        };
        if (patch.licensee !== undefined) {
          const v = String(patch.licensee).trim();
          if (!v) throw new ApiError(400, "LICENSEE_REQUIRED", "被授权方不能为空");
          l.licensee = v;
        }
        if (patch.exclusive !== undefined) l.exclusive = Boolean(patch.exclusive);
        if (patch.regions !== undefined) l.regions = scopeList(patch.regions);
        if (patch.categories !== undefined) l.categories = scopeList(patch.categories);
        // ---- 财务条款：自未来月份分段生效，既往账期不重算 ----
        let termChanged = false;
        let newGuarantee = l.guarantee;
        let newTiers = l.tiers;
        if (patch.guarantee !== undefined) {
          const g = Number(patch.guarantee);
          if (!Number.isFinite(g) || g < 0) throw new ApiError(400, "INVALID_GUARANTEE", "年保底必须是非负数字");
          newGuarantee = round2(g);
          termChanged = true;
        }
        if (patch.tiers !== undefined) {
          newTiers = normalizeTiers(patch.tiers);
          termChanged = true;
        }
        let fromMonth = null;
        if (termChanged) {
          fromMonth = String(patch.effectiveFromMonth ?? body.effectiveFromMonth ?? firstDayOfNextMonth(monthOf(nowLocalDate()))).slice(0, 7);
          if (!isValidMonth(fromMonth)) throw new ApiError(400, "INVALID_MONTH", "条款生效月份格式应为 YYYY-MM");
          // 先判是否追溯（当月/过去月一律禁止，既往账期不得重算）
          if (fromMonth <= monthOf(nowLocalDate())) {
            throw new ApiError(400, "RETROACTIVE_TERM", `条款只能从未来月份起生效（最早 ${firstDayOfNextMonth(monthOf(nowLocalDate()))}），既往账期不得重算`);
          }
          // 再判排期顺序：新生效月必须晚于已排定的最后一段
          const latestFrom = l.terms.reduce((a, b) => (b.fromMonth > a ? b.fromMonth : a), l.terms[0].fromMonth);
          if (fromMonth <= latestFrom) {
            throw new ApiError(400, "TERM_ORDER", `新生效月份必须晚于已排定的 ${latestFrom}，避免覆盖既有条款分段`);
          }
          l.terms.push({ fromMonth, tiers: newTiers, guarantee: newGuarantee });
          l.terms.sort((a, b) => a.fromMonth.localeCompare(b.fromMonth));
          l.tiers = newTiers;
          l.guarantee = newGuarantee;
        }
        const candidate = {
          motifId: l.motifId, exclusive: l.exclusive, regions: l.regions, categories: l.categories,
          startDate: l.startDate, endDate: conflictInterval(l).end,
        };
        const hit = findConflictOn(db, candidate, l.id);
        if (hit) {
          // 变更本身不能制造新冲突：回滚本次所有字段修改（不落盘）
          l.exclusive = before.exclusive;
          l.regions = before.regions;
          l.categories = before.categories;
          l.tiers = before.tiers;
          l.guarantee = before.guarantee;
          l.licensee = before.licensee;
          l.terms = before.terms;
          throw new ApiError(409, "EXCLUSIVE_OVERLAP",
            `变更被拒绝：新权利范围与 ${hit.id}（${hit.licensee}）冲突`, { conflictingLicenseId: hit.id });
        }
        l.versions.push({
          type: "change", at: now, endDate: effectiveEnd(l),
          note: String(body.reason || "权利要素变更") + (termChanged ? `（财务条款自 ${fromMonth} 起生效，既往不重算）` : ""),
          snapshot: {
            before,
            after: { exclusive: l.exclusive, regions: l.regions, categories: l.categories, tiers: l.tiers, guarantee: l.guarantee, licensee: l.licensee },
            termChange: termChanged ? { fromMonth, tiers: newTiers, guarantee: newGuarantee } : null,
          },
        });
        persist();
        return send(res, 200, { ok: true, license: l });
      }
    }
    if (req.method === "POST" && p === "/api/reports/sales") {
      const body = await readBody(req);
      const result = addSale(body);
      persist();
      return send(res, result.duplicated ? 200 : 201, { ok: true, ...result });
    }
    if (req.method === "POST" && p === "/api/reports/return") {
      const body = await readBody(req);
      const result = addReturn(body);
      persist();
      return send(res, 201, { ok: true, ...result });
    }
    if (req.method === "POST" && p === "/api/batch/licenses") {
      const body = await readBody(req);
      const items = Array.isArray(body?.items) ? body.items : null;
      if (!items || !items.length) throw new ApiError(400, "EMPTY_BATCH", "批量导入至少包含一条记录");
      if (items.length > 200) throw new ApiError(400, "BATCH_TOO_LARGE", "单批最多 200 条");
      // 在副本上模拟整批：任何一条失败都不触碰正式数据
      const sim = structuredClone(db);
      const failures = [];
      for (let i = 0; i < items.length; i++) {
        try {
          createLicenseOn(sim, items[i]);
        } catch (e) {
          failures.push({ index: i, code: e.code, message: e.message, details: e.details || null });
        }
      }
      if (failures.length) {
        throw new ApiError(400, "BATCH_ROLLED_BACK",
          `批量导入失败 ${failures.length}/${items.length} 条，整批已回滚，未写入任何授权`, { failures });
      }
      db = sim;
      persist();
      return send(res, 201, { ok: true, imported: items.length });
    }
    if (req.method === "GET" && p.startsWith("/api/royalties/")) {
      const l = getLicense(p.split("/").pop());
      return send(res, 200, periodRollups(l));
    }
    throw new ApiError(404, "NOT_FOUND", `路径不存在：${p}`);
  } catch (e) {
    if (e instanceof ApiError) return send(res, e.status, { error: { code: e.code, message: e.message, details: e.details } });
    console.error(e);
    return send(res, 500, { error: { code: "INTERNAL", message: "服务器内部错误" } });
  }
});

load();
if (PORT === 0) {
  // 测试入口：端口 0 由系统分配，启动后打印实际端口供测试解析
  server.listen(0, "127.0.0.1", () => {
    const actual = server.address().port;
    console.log(`READY port=${actual} data=${DATA_FILE} today=${nowLocalDate()} injected=${Boolean(process.env.LICENSING_NOW)}`);
    console.log(`漆线雕授权台已启动: http://127.0.0.1:${actual}/`);
  });
} else {
  server.listen(PORT, () => {
    console.log(`READY port=${PORT} data=${DATA_FILE} today=${nowLocalDate()} injected=${Boolean(process.env.LICENSING_NOW)}`);
    console.log(`漆线雕授权台已启动: http://localhost:${PORT}`);
  });
}

export { server, royaltyOf, normalizeTiers, dateString, monthOf, addMonths, isValidDate, isValidMonth };
