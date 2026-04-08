import { Router } from "express";
import { loadData } from "../db.mjs";
import { renderPage } from "../ui.mjs";
import { requireLogin, requireAdmin } from "../auth.mjs";

const router = Router();

// ── 工具函数 ──────────────────────────────────────────
function pct(a, b) { return b > 0 ? Math.round(a / b * 100) : 0; }

// 把 ISO 日期字符串截取到 YYYY-MM-DD
function toDate(iso) { return iso ? iso.slice(0, 10) : ""; }

// 把日期归到最近一个周一（周一为起始）
function startOfWeek(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  const day = d.getDay(); // 0=Sun
  const diff = (day === 0) ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

// 格式化周标签 MM/DD
function weekLabel(isoDate) {
  if (!isoDate) return "";
  const [, m, d] = isoDate.split("-");
  return `${m}/${d}`;
}

// 候选人状态分类到漏斗阶段
const SCREEN_STATUSES  = new Set(["待筛选", "简历初筛"]);
const INTERVIEW_STATUSES = new Set([
  "待一面","一面通过","一面不通过",
  "待二面","二面通过","二面不通过",
  "待三面","三面通过","三面不通过",
  "待四面","四面通过","四面不通过",
  "待五面","五面通过","五面不通过",
  "面试不通过","面试Pending",
]);
const OFFER_STATUSES = new Set(["待发offer", "Offer发放", "拒offer"]);
const HIRED_STATUSES = new Set(["入职"]);
const REJECTED_STATUSES = new Set(["淘汰"]);

function funnelStage(status) {
  if (HIRED_STATUSES.has(status)) return "hired";
  if (OFFER_STATUSES.has(status)) return "offer";
  if (INTERVIEW_STATUSES.has(status)) return "interview";
  if (REJECTED_STATUSES.has(status)) return "rejected";
  return "screen"; // 待筛选 / 初筛
}

// SOURCE_COLORS 与 preview 页保持一致
const SOURCE_COLORS = {
  "Boss直聘":  "#3b9de8",
  "内推":      "#f5960a",
  "猎头":      "#9b72f5",
  "官网投递":  "#2eb87a",
  "飞书表单":  "#2bbfbf",
  "手动录入":  "#8c93a3",
};
const DEFAULT_COLORS = ["#3b9de8","#9b72f5","#f5960a","#2eb87a","#2bbfbf","#8c93a3","#f05a5a","#5b6af5"];

function srcColor(name, idx) {
  return SOURCE_COLORS[name] || DEFAULT_COLORS[idx % DEFAULT_COLORS.length];
}

// ── 路由 ─────────────────────────────────────────────
router.get("/analytics", requireLogin, requireAdmin, async (req, res) => {
  const d = await loadData();
  const allCands = d.candidates || [];

  // ============================================================
  // 顶部概览数字
  // ============================================================
  const totalCands = allCands.length;
  const hiredCands = allCands.filter(c => HIRED_STATUSES.has(c.status));
  const hiredCount = hiredCands.length;
  const hireRate   = pct(hiredCount, totalCands);

  // Offer 数量（Offer已发 + 已接受）
  const offerCount     = allCands.filter(c => c.status === "Offer发放").length;
  const offerAccepted  = hiredCount; // 入职 = 接受 offer 后
  const offerAcceptRate = pct(offerAccepted, offerCount + offerAccepted || 1);

  // 平均招聘周期（从 createdAt 到入职的天数）
  let avgDays = 0;
  if (hiredCands.length > 0) {
    const sum = hiredCands.reduce((s, c) => {
      const created = new Date(c.createdAt || c.updatedAt);
      const updated = new Date(c.updatedAt);
      const diff = (updated - created) / 86400000;
      return s + (isNaN(diff) ? 0 : diff);
    }, 0);
    avgDays = (sum / hiredCands.length).toFixed(1);
  }

  // ============================================================
  // Tab1: 渠道来源统计
  // ============================================================
  const sourceMap = {}; // { sourceName: { deliver, screen, interview, offer, hired } }
  allCands.forEach(c => {
    const src = c.source || "手动录入";
    if (!sourceMap[src]) sourceMap[src] = { deliver: 0, screen: 0, interview: 0, offer: 0, hired: 0 };
    sourceMap[src].deliver++;
    const stage = funnelStage(c.status);
    if (stage === "screen")    sourceMap[src].screen++;
    if (stage === "interview") { sourceMap[src].screen++; sourceMap[src].interview++; }
    if (stage === "offer")     { sourceMap[src].screen++; sourceMap[src].interview++; sourceMap[src].offer++; }
    if (stage === "hired")     { sourceMap[src].screen++; sourceMap[src].interview++; sourceMap[src].offer++; sourceMap[src].hired++; }
    if (stage === "rejected")  sourceMap[src].screen++;
  });

  // 按投递量排序
  const sourceSorted = Object.entries(sourceMap)
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.deliver - a.deliver);

  const maxDeliver = sourceSorted[0]?.deliver || 1;

  // 渠道投递量条形图 HTML
  const sourceBarRows = sourceSorted.map((s, i) => {
    const barW = Math.round(s.deliver / maxDeliver * 100);
    const color = srcColor(s.name, i);
    return `<div class="source-row">
      <div class="source-meta">
        <span class="source-name">${s.name}</span>
        <span class="source-count">${s.deliver}</span>
        <span class="source-pct">${Math.round(s.deliver / maxDeliver * 100)}%</span>
      </div>
      <div class="source-bar-wrap">
        <div class="source-bar-inner" style="width:${barW}%;background:${color};height:8px;border-radius:999px"></div>
      </div>
    </div>`;
  }).join("");

  // 渠道转化率表格数据（JSON 传给前端渲染）
  const convChannelsJson = JSON.stringify(sourceSorted.map((s, i) => ({
    name: s.name,
    color: srcColor(s.name, i),
    deliver: s.deliver,
    screen: s.screen,
    interview: s.interview,
    offer: s.offer,
    hired: s.hired,
  })));

  // ============================================================
  // Tab1: 各渠道周投递趋势（折线图数据）
  // ============================================================
  // 收集最近8周
  const now = new Date();
  const weekStarts = [];
  for (let i = 7; i >= 0; i--) {
    const d2 = new Date(now);
    d2.setDate(d2.getDate() - i * 7);
    weekStarts.push(startOfWeek(d2.toISOString().slice(0, 10)));
  }
  // 去重、排序
  const weekSet = [...new Set(weekStarts)].sort().slice(-8);

  // 每个来源 × 每周投递量
  const trendSources = sourceSorted.slice(0, 6); // 最多显示6条
  const trendData = trendSources.map((s, i) => {
    const weekCounts = weekSet.map(wk => {
      const wkEnd = new Date(wk);
      wkEnd.setDate(wkEnd.getDate() + 7);
      return allCands.filter(c => {
        const src = c.source || "手动录入";
        if (src !== s.name) return false;
        const date = toDate(c.createdAt);
        return date >= wk && date < wkEnd.toISOString().slice(0, 10);
      }).length;
    });
    return { name: s.name, color: srcColor(s.name, i), data: weekCounts };
  });
  const trendWeekLabels = weekSet.map(weekLabel);
  const trendMax = Math.max(1, ...trendData.flatMap(t => t.data));

  const trendJson    = JSON.stringify(trendData);
  const trendWeekJson = JSON.stringify(trendWeekLabels);

  // ============================================================
  // Tab2: 入职来源分析（按候选人状态=入职）
  // ============================================================
  // 判断是否实习：岗位名含「实习」或「intern」
  const isIntern = (c) => {
    const t = (c.jobTitle || "").toLowerCase();
    return t.includes("实习") || t.includes("intern");
  };

  const socialHired = hiredCands.filter(c => !isIntern(c));
  const internHired = hiredCands.filter(c => isIntern(c));

  function buildHiredSources(cands) {
    const map = {};
    cands.forEach(c => {
      const src = c.source || "手动录入";
      if (!map[src]) map[src] = { name: src, people: [], extraLabel: null };
      if (src === "猎头" && !map[src].extraLabel) map[src].extraLabel = "供应商";
      if (src === "内推" && !map[src].extraLabel) map[src].extraLabel = "内推人";
      map[src].people.push({
        name: c.name || "—",
        job:  c.jobTitle || "—",
        date: toDate(c.updatedAt || c.createdAt),
        extra: src === "猎头"
          ? (c.vendorName || c.headhunterId || "—")
          : src === "内推"
          ? (c.referrer || "—")
          : null,
      });
    });
    return Object.entries(map)
      .map(([, v]) => v)
      .sort((a, b) => b.people.length - a.people.length);
  }

  const socialSourcesJson = JSON.stringify(
    buildHiredSources(socialHired).map((s, i) => ({ ...s, color: srcColor(s.name, i) }))
  );
  const internSourcesJson = JSON.stringify(
    buildHiredSources(internHired).map((s, i) => ({ ...s, color: srcColor(s.name, i) }))
  );

  // ============================================================
  // Tab3: 每周新增 by 岗位（堆叠柱状图）
  // ============================================================
  // 取所有岗位，按总候选人数排序，取前6
  const jobMap = {};
  allCands.forEach(c => {
    const j = c.jobTitle || c.jobId || "未知岗位";
    jobMap[j] = (jobMap[j] || 0) + 1;
  });
  const topJobs = Object.entries(jobMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name]) => name);
  const jobColors = ["#3b9de8","#9b72f5","#f5960a","#2eb87a","#2bbfbf","#f05a5a"];

  const weeklyData = weekSet.map(wk => {
    const wkEnd = new Date(wk);
    wkEnd.setDate(wkEnd.getDate() + 7);
    const wkEndStr = wkEnd.toISOString().slice(0, 10);
    const data = topJobs.map(job =>
      allCands.filter(c => {
        const date = toDate(c.createdAt);
        return (c.jobTitle === job || c.jobId === job) && date >= wk && date < wkEndStr;
      }).length
    );
    return { label: weekLabel(wk), data };
  });

  const weeklyJson     = JSON.stringify(weeklyData);
  const topJobsJson    = JSON.stringify(topJobs);
  const jobColorsJson  = JSON.stringify(jobColors.slice(0, topJobs.length));

  // ============================================================
  // Tab4: 漏斗分析 by 岗位（只显示岗位列表中存在的岗位，按候选人数排序）
  // ============================================================
  const validJobTitles = new Set((d.jobs || []).map(j => j.title).filter(Boolean));
  const allFunnelJobTitles = Object.entries(jobMap)
    .filter(([name]) => validJobTitles.has(name))
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);

  const funnelJobs = allFunnelJobTitles.map(jobTitle => {
    const cands = allCands.filter(c => c.jobTitle === jobTitle || c.jobId === jobTitle);
    const total = cands.length;
    const screen    = cands.filter(c => ["screen","interview","offer","hired","rejected"].includes(funnelStage(c.status))).length;
    const interview = cands.filter(c => ["interview","offer","hired"].includes(funnelStage(c.status))).length;
    const offer     = cands.filter(c => ["offer","hired"].includes(funnelStage(c.status))).length;
    const hired2    = cands.filter(c => funnelStage(c.status) === "hired").length;
    const rejected  = cands.filter(c => funnelStage(c.status) === "rejected").length;
    // 招聘需求
    const job = (d.jobs || []).find(j => j.title === jobTitle || j.id === jobTitle);
    const headcount = job?.headcount || job?.hc || 0;
    return { title: jobTitle, dept: job?.department || "", headcount, total, screen, interview, offer, hired: hired2, rejected };
  });

  const funnelJobsJson = JSON.stringify(funnelJobs);

  // ============================================================
  // Tab5: 猎头来源分析
  // ============================================================
  const hunterCands = allCands.filter(c => c.source === "猎头");
  const hunterHired = hunterCands.filter(c => HIRED_STATUSES.has(c.status));
  const vendorTotals = {};
  hunterCands.forEach(c => {
    const v = c.vendorName || c.headhunterId || "未知供应商";
    if (!vendorTotals[v]) vendorTotals[v] = { name: v, total: 0, interview: 0, hired: 0, cands: [] };
    vendorTotals[v].total++;
    if (["interview","offer","hired"].includes(funnelStage(c.status))) vendorTotals[v].interview++;
    if (HIRED_STATUSES.has(c.status)) vendorTotals[v].hired++;
    vendorTotals[v].cands.push(c);
  });

  const vendorList = Object.values(vendorTotals).sort((a, b) => b.total - a.total);
  const vendorColors = ["#3b9de8","#9b72f5","#f5960a","#2eb87a","#2bbfbf","#f05a5a"];
  const vendorsJson = JSON.stringify(vendorList.map((v, i) => ({ ...v, color: vendorColors[i % vendorColors.length] })));

  // 猎头 × 岗位矩阵
  const matrixJobs = [...new Set(hunterCands.map(c => c.jobTitle || c.jobId || "未知"))].slice(0, 6);
  const matrixJson = JSON.stringify({ vendors: vendorList.map(v => v.name), jobs: matrixJobs,
    cells: vendorList.map(v => matrixJobs.map(job => ({
      total: v.cands.filter(c => (c.jobTitle || c.jobId) === job).length,
      hired: v.cands.filter(c => (c.jobTitle || c.jobId) === job && HIRED_STATUSES.has(c.status)).length,
    })))
  });

  // 猎头概览数字
  const hhTotal   = hunterCands.length;
  const hhHired   = hunterHired.length;
  const hhRate    = pct(hhHired, hhTotal);
  const hhVendors = vendorList.length;

  // ============================================================
  // 渲染页面（使用主系统 renderPage，共享侧边栏/配色）
  // ============================================================
  const contentHtml = `
<style>
/* === 数据分析专用样式 === */
.seg{display:flex;gap:2px;background:#f4f3f6;border-radius:var(--radius);padding:3px}
.seg button{padding:5px 12px;border-radius:5px;font-weight:500;font-size:12px;border:none;background:transparent;color:var(--muted);cursor:pointer;transition:all .15s}
.seg button.active{background:#fff;color:var(--text);box-shadow:0 1px 3px rgba(0,0,0,.06);font-weight:600}
.stat-card{text-align:left;padding:16px 20px}
.stat-number{font-size:26px;font-weight:700;color:var(--text);line-height:1.2}
.stat-sub{font-size:12px;color:var(--muted);margin-top:3px}
.stat-label{font-size:13px;color:var(--muted);margin-top:4px}
.stat-trend{font-size:12px;font-weight:600;padding:1px 6px;border-radius:4px;margin-left:6px}
.trend-up{background:var(--green-bg);color:#1f9960}
.trend-down{background:var(--red-bg);color:var(--red)}
.tabs{display:flex;gap:0;border-bottom:1px solid var(--border-light);margin-bottom:20px}
.tab{padding:10px 18px;font-weight:500;font-size:13px;color:var(--muted);cursor:pointer;border:none;background:transparent;border-bottom:2px solid transparent;transition:all .15s;white-space:nowrap}
.tab:hover{color:var(--text)}
.tab.active{color:var(--primary);border-bottom-color:var(--primary);font-weight:600}
.tabpanel{display:none}.tabpanel.active{display:block}
.source-row{margin-bottom:12px;cursor:pointer;border-radius:var(--radius);padding:4px 6px;margin:0 -6px 0 -6px;transition:background .15s}
.source-row:hover{background:var(--primary-bg)}
.source-meta{display:flex;align-items:center;margin-bottom:4px}
.source-name{font-size:13px;font-weight:500;flex:1}
.source-count{font-size:13px;font-weight:700;color:var(--text);margin-right:8px}
.source-pct{font-size:12px;color:var(--muted);min-width:36px;text-align:right}
.source-bar-wrap{height:8px;border-radius:999px;background:#f0eef3;overflow:hidden}
.source-bar-inner{height:100%;border-radius:999px}
.conv-table{width:100%;border-collapse:collapse}
.conv-table th{font-size:12px;color:var(--muted);text-align:left;padding:8px 10px;border-bottom:1px solid var(--border-light);font-weight:600;background:#faf9fb}
.conv-table td{padding:9px 10px;border-bottom:1px solid var(--border-light);font-size:13px;vertical-align:middle}
.conv-table tr:last-child td{border-bottom:none}
.conv-table tr:hover td{background:var(--primary-bg)}
.weekly-chart-wrap{width:100%;overflow-x:auto;padding-bottom:4px}
.weekly-chart{display:flex;align-items:flex-end;gap:6px;padding:24px 0 0;min-width:480px}
.week-col{flex:1;display:flex;flex-direction:column;align-items:center;min-width:0}
.week-total{font-size:12px;font-weight:700;color:var(--text);margin-bottom:4px;line-height:1}
.week-bars{width:100%;display:flex;flex-direction:column;gap:1px;border-radius:4px 4px 0 0;overflow:hidden}
.week-seg{width:100%;transition:height .3s}
.week-label{font-size:11px;color:var(--muted);margin-top:6px;white-space:nowrap;text-align:center;line-height:1.4}
.chart-legend{display:flex;gap:12px;flex-wrap:wrap;margin-top:14px;padding-top:14px;border-top:1px solid var(--border-light)}
.legend-item{display:flex;align-items:center;gap:5px;font-size:12px;color:var(--muted)}
.legend-dot{width:10px;height:10px;border-radius:3px;flex-shrink:0}
.funnel-job{border:1px solid var(--border-light);border-radius:var(--radius2);margin-bottom:10px;overflow:hidden}
.funnel-head{padding:12px 16px;display:flex;align-items:center;gap:10px;cursor:pointer;background:#fff;transition:background .15s}
.funnel-head:hover{background:var(--primary-bg)}
.funnel-title{font-weight:600;font-size:14px;flex:1}
.funnel-summary{display:flex;gap:16px}
.funnel-summary-item{font-size:12px;color:var(--muted);text-align:center}
.funnel-summary-item b{display:block;font-size:14px;font-weight:700;color:var(--text)}
.funnel-body{display:none;padding:16px;border-top:1px solid var(--border-light);background:#faf9fb}
.funnel-body.open{display:block}
.funnel-stage{display:flex;align-items:center;gap:12px;margin-bottom:10px}
.funnel-stage-name{width:90px;font-size:12px;color:var(--muted);flex-shrink:0;text-align:right}
.funnel-stage-bar{flex:1;height:22px;border-radius:4px;background:#f0eef3;overflow:hidden;position:relative}
.funnel-stage-fill{height:100%;border-radius:4px;display:flex;align-items:center;justify-content:flex-end;padding-right:8px;transition:width .4s ease}
.funnel-stage-val{font-size:12px;font-weight:700;color:#fff;position:relative;z-index:1}
.funnel-stage-pct{width:44px;font-size:12px;color:var(--muted);flex-shrink:0;text-align:right}
.icon-chip{width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:14px}
.chip-purple{background:var(--purple-bg)}.chip-blue{background:var(--blue-bg)}.chip-green{background:var(--green-bg)}.chip-orange{background:var(--orange-bg)}
td.num{font-weight:700;font-family:ui-monospace,monospace;text-align:right}
th.num{text-align:right}
</style>

<div class="page-header">
  <div class="page-title">数据分析</div>
  <span class="spacer"></span>
  <div class="seg" id="rangeSegs">
    <button onclick="setRange(this,'all')" class="active">全部</button>
    <button onclick="setRange(this,'6m')">近6月</button>
    <button onclick="setRange(this,'3m')">近3月</button>
    <button onclick="setRange(this,'4w')">近4周</button>
  </div>
</div>

<!-- 顶部概览 -->
<div class="grid4" style="margin-bottom:14px">
  <div class="card stat-card">
    <div class="stat-number">${totalCands}</div>
    <div class="stat-label">总投递人数</div>
    <div class="stat-sub">所有候选人</div>
  </div>
  <div class="card stat-card">
    <div class="stat-number">${hiredCount}</div>
    <div class="stat-label">已入职</div>
    <div class="stat-sub">入职率 ${hireRate}%</div>
  </div>
  <div class="card stat-card">
    <div class="stat-number">${offerCount}</div>
    <div class="stat-label">Offer 发放中</div>
    <div class="stat-sub">入职转化率 ${offerAcceptRate}%</div>
  </div>
  <div class="card stat-card">
    <div class="stat-number">${avgDays}天</div>
    <div class="stat-label">平均招聘周期</div>
    <div class="stat-sub">从创建到入职</div>
  </div>
</div>

<!-- Tabs -->
<div class="tabs">
  <button class="tab active" onclick="switchTab(this,'tab-source')">人选来源分析</button>
  <button class="tab" onclick="switchTab(this,'tab-hired-source')">入职来源分析</button>
  <button class="tab" onclick="switchTab(this,'tab-weekly')">每周新增 by 岗位</button>
  <button class="tab" onclick="switchTab(this,'tab-funnel')">漏斗分析 by 岗位</button>
  <button class="tab" onclick="switchTab(this,'tab-headhunter')">猎头来源分析</button>
</div>

<!-- Tab1: 人选来源分析 -->
<div id="tab-source" class="tabpanel active">
  <div class="grid">
    <div class="card">
      <div class="card-title">
        <div class="icon-chip chip-purple">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9b72f5" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>
        </div>
        各渠道投递量
        <span class="muted" style="margin-left:auto">共 ${totalCands} 人</span>
      </div>
      ${sourceBarRows}
      <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border-light)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <span style="font-size:13px;font-weight:600;color:var(--text)">各渠道周投递趋势</span>
          <div id="trendLegend" style="display:flex;gap:10px;flex-wrap:wrap"></div>
        </div>
        <div style="position:relative;width:100%;height:130px">
          <svg id="trendSvg" width="100%" height="130" style="overflow:visible"></svg>
        </div>
        <div id="trendXLabels" style="display:flex;justify-content:space-between;margin-top:4px;padding:0 4px"></div>
      </div>
    </div>
    <div class="card">
      <div class="card-title">
        <div class="icon-chip chip-green">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2eb87a" stroke-width="2"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>
        </div>
        渠道转化率对比
      </div>
      <div id="convTableWrap"></div>
      <div style="margin-top:12px;padding:10px 12px;background:var(--primary-bg);border-radius:var(--radius);font-size:12px;color:var(--muted)">
        💡 猎头和内推渠道通常入职率更高，建议加大内推激励政策
      </div>
    </div>
  </div>
</div>

<!-- Tab2: 入职来源分析 -->
<div id="tab-hired-source" class="tabpanel">
  <div class="grid">
    <div class="card" id="card-social"></div>
    <div class="card" id="card-intern"></div>
  </div>
</div>

<!-- Tab3: 每周新增 by 岗位 -->
<div id="tab-weekly" class="tabpanel">
  <div class="card">
    <div class="card-title">
      <div class="icon-chip chip-blue">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
      </div>
      每周新增人选趋势（按岗位堆叠）
      <span class="muted" style="margin-left:auto">近8周</span>
    </div>
    <div class="weekly-chart-wrap"><div class="weekly-chart" id="weeklyChart"></div></div>
    <div class="chart-legend" id="weeklyLegend"></div>
    <div style="margin-top:20px">
      <div class="card-title" style="margin-bottom:10px;font-size:13px;color:var(--muted)">明细数据</div>
      <div style="overflow-x:auto"><table><thead><tr id="weeklyTableHead"></tr></thead><tbody id="weeklyTableBody"></tbody></table></div>
    </div>
  </div>
</div>

<!-- Tab4: 漏斗分析 -->
<div id="tab-funnel" class="tabpanel">
  <div class="card" style="margin-bottom:14px;padding:14px 20px">
    <div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap">
      <div style="font-size:13px;color:var(--muted);font-weight:500">阶段说明：</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <span class="badge status-gray">筛选</span>
        <span style="color:var(--muted);font-size:11px">──→</span>
        <span class="badge status-purple">面试</span>
        <span style="color:var(--muted);font-size:11px">──→</span>
        <span class="badge status-orange">Offer</span>
        <span style="color:var(--muted);font-size:11px">──→</span>
        <span class="badge status-green">入职</span>
        <span style="font-size:11px;color:var(--muted);margin-left:4px">· 四阶段转化漏斗，箭头旁显示该步骤转化率</span>
      </div>
    </div>
  </div>
  <div id="funnelList"></div>
</div>

<!-- Tab5: 猎头来源分析 -->
<div id="tab-headhunter" class="tabpanel">
  <div class="card" style="margin-bottom:14px;padding:12px 20px;background:linear-gradient(135deg,#fff9f0,#fff);border-color:var(--orange-border)">
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--orange)" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      <span style="font-size:13px;color:var(--text);font-weight:500">如何识别猎头来源？</span>
      <span style="font-size:12px;color:var(--muted)">新建候选人时选择来源 <b style="color:var(--orange)">猎头</b>，并选择「供应商」，系统将自动归因统计。</span>
      <div style="display:flex;gap:6px;margin-left:auto">
        <span class="badge status-orange">来源：猎头</span>
        <span style="color:var(--muted);font-size:12px;align-self:center">+</span>
        <span class="badge status-gray">供应商：XXX猎头</span>
      </div>
    </div>
  </div>
  <div class="grid4" style="margin-bottom:14px">
    <div class="card stat-card"><div class="stat-number">${hhTotal}</div><div class="stat-label">猎头推荐总量</div><div class="stat-sub">占全渠道 ${pct(hhTotal, totalCands)}%</div></div>
    <div class="card stat-card"><div class="stat-number">${hhHired}</div><div class="stat-label">猎头渠道入职</div><div class="stat-sub">入职率 ${hhRate}%</div></div>
    <div class="card stat-card"><div class="stat-number">${hhVendors}家</div><div class="stat-label">合作猎头供应商</div><div class="stat-sub">均有推荐记录</div></div>
    <div class="card stat-card"><div class="stat-number">—</div><div class="stat-label">猎头平均推进周期</div><div class="stat-sub">暂无足够数据</div></div>
  </div>
  <div style="margin-bottom:14px">
    <div class="card">
      <div class="card-title">
        <div class="icon-chip chip-orange">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--orange)" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>
        </div>
        供应商推荐量排行
        <span class="muted" style="margin-left:auto">共 ${hhTotal} 人</span>
      </div>
      <div id="vendorBars"></div>
      <div class="divider"></div>
      <div style="font-size:12px;font-weight:600;color:var(--muted);margin-bottom:10px">供应商转化率对比</div>
      <div id="vendorConvTable"></div>
    </div>
  </div>
  <div class="card">
    <div class="card-title">
      <div class="icon-chip chip-purple">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9b72f5" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
      </div>
      岗位 × 供应商 推荐量矩阵
      <span class="muted" style="margin-left:auto;font-size:12px">单元格 = 推荐数 / 入职数</span>
    </div>
    <div id="vendorMatrix" style="overflow-x:auto"></div>
    <div style="margin-top:10px;font-size:12px;color:var(--muted)">格式：<b style="color:var(--text)">推荐数</b> / <span class="muted">入职数</span></div>
  </div>
</div>

<script>
// ── 数据注入 ──
var CONV_CHANNELS = ${convChannelsJson};
var TREND_DATA    = ${trendJson};
var TREND_WEEKS   = ${trendWeekJson};
var TREND_MAX     = ${trendMax};
var WEEKLY_DATA   = ${weeklyJson};
var TOP_JOBS      = ${topJobsJson};
var JOB_COLORS    = ${jobColorsJson};
var FUNNEL_JOBS   = ${funnelJobsJson};
var SOCIAL_SOURCES = ${socialSourcesJson};
var INTERN_SOURCES = ${internSourcesJson};
var VENDORS       = ${vendorsJson};
var VENDOR_MATRIX = ${matrixJson};

// ── Tab 切换 ──
function switchTab(btn, id) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tabpanel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById(id).classList.add('active');
}
function setRange(btn, range) {
  document.querySelectorAll('.seg button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

// ── Tab1: 折线趋势图 ──
(function renderTrendChart() {
  var svg = document.getElementById('trendSvg');
  var legend = document.getElementById('trendLegend');
  var xLabels = document.getElementById('trendXLabels');
  if (!svg || !TREND_DATA.length) return;
  var W = svg.parentElement.clientWidth || 400;
  var H = 120, padL = 4, padR = 4, padT = 10, padB = 4;
  var n = TREND_WEEKS.length;
  var xStep = (W - padL - padR) / Math.max(1, n - 1);
  var xPos = function(i) { return padL + i * xStep; };
  var yPos = function(v) { return padT + (1 - v / TREND_MAX) * (H - padT - padB); };
  var gridSvg = '';
  [0,2,4,6,8,10].forEach(function(v) {
    if (v > TREND_MAX) return;
    var y = yPos(v);
    gridSvg += '<line x1="'+padL+'" y1="'+y+'" x2="'+(W-padR)+'" y2="'+y+'" stroke="#f0eef3" stroke-width="1"/>';
    gridSvg += '<text x="0" y="'+(y+4)+'" font-size="9" fill="#ccc">'+v+'</text>';
  });
  var linesSvg = '';
  TREND_DATA.forEach(function(ch) {
    var pts = ch.data.map(function(v,i){return xPos(i)+','+yPos(v)}).join(' ');
    linesSvg += '<polyline points="'+pts+'" fill="none" stroke="'+ch.color+'" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" opacity="0.85"/>';
    ch.data.forEach(function(v,i) {
      linesSvg += '<circle cx="'+xPos(i)+'" cy="'+yPos(v)+'" r="3" fill="'+ch.color+'" stroke="#fff" stroke-width="1.5"><title>'+ch.name+' '+TREND_WEEKS[i]+': '+v+'人</title></circle>';
    });
  });
  svg.setAttribute('viewBox','0 0 '+W+' '+H);
  svg.innerHTML = gridSvg + linesSvg;
  legend.innerHTML = TREND_DATA.map(function(ch) {
    return '<span style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--muted)"><span style="width:16px;height:2px;background:'+ch.color+';border-radius:1px;display:inline-block"></span>'+ch.name+'</span>';
  }).join('');
  xLabels.innerHTML = TREND_WEEKS.map(function(w) {
    return '<span style="font-size:10px;color:var(--muted);flex:1;text-align:center">'+w+'</span>';
  }).join('');
})();

// ── Tab1: 渠道转化率表格 ──
(function() {
  function pct(a,b){return b>0?Math.round(a/b*100):0;}
  function rateColor(r){return r>=50?'#2eb87a':r>=20?'#f5960a':'#f05a5a';}
  function hiredBadge(r){return r>=20?'status-green':r>=10?'status-blue':r>0?'status-gray':'status-red';}
  var wrap = document.getElementById('convTableWrap');
  if (!wrap || !CONV_CHANNELS.length) { wrap && (wrap.innerHTML='<div class="muted" style="padding:20px;text-align:center">暂无数据</div>'); return; }
  var html = '<table class="conv-table"><thead><tr><th style="min-width:72px">渠道</th><th class="num">投递</th><th class="num" style="color:#8c93a3">筛选</th><th class="num" style="color:var(--purple)">面试</th><th class="num" style="color:var(--orange)">Offer</th><th class="num" style="color:var(--green)">入职</th><th class="num" style="color:var(--green)">入职率</th></tr></thead><tbody>';
  CONV_CHANNELS.forEach(function(c) {
    var rS=pct(c.screen,c.deliver), rI=pct(c.interview,c.deliver), rO=pct(c.offer,c.deliver), rH=pct(c.hired,c.deliver);
    function cell(val,rate,color){return '<td class="num"><div style="font-weight:700">'+val+'</div><div style="font-size:10px;color:'+(color||rateColor(rate))+';margin-top:1px">'+rate+'%</div></td>';}
    html+='<tr><td>'+c.name+'</td><td class="num"><div style="font-weight:700">'+c.deliver+'</div></td>'+cell(c.screen,rS,'#8c93a3')+cell(c.interview,rI,'var(--purple)')+cell(c.offer,rO,'var(--orange)')+cell(c.hired,rH,'var(--green)')+'<td class="num"><span class="badge '+hiredBadge(rH)+'">'+rH+'%</span></td></tr>';
  });
  html += '</tbody></table><div style="margin-top:8px;font-size:11px;color:var(--muted)">各阶段数字下方 % = 该阶段人数 ÷ 总投递量</div>';
  wrap.innerHTML = html;
})();

// ── Tab2: 入职来源展开名单 ──
(function(){
  function buildCard(containerId, title, icon, sources, tip) {
    if (!sources || !sources.length) {
      document.getElementById(containerId).innerHTML = '<div class="muted" style="padding:40px;text-align:center">暂无入职数据</div>'; return;
    }
    var total = sources.reduce(function(s,c){return s+c.people.length;},0);
    var maxN = sources[0].people.length || 1;
    var colorBar = sources.map(function(s){return '<div style="flex:'+s.people.length+';background:'+s.color+'"></div>';}).join('');
    var legend = sources.map(function(s){return '<span style="display:inline-flex;align-items:center;gap:5px;font-size:13px"><span style="width:10px;height:10px;border-radius:3px;background:'+s.color+';display:inline-block"></span>'+s.name+' <b style="margin-left:2px">'+s.people.length+'人</b><span style="color:var(--muted)">('+Math.round(s.people.length/total*100)+'%)</span></span>';}).join('');
    var rows = sources.map(function(s) {
      var pct2=Math.round(s.people.length/total*100);
      var barW=Math.round(s.people.length/maxN*100);
      var hasExtra=!!s.extraLabel;
      var thStyle='padding:6px 10px;font-size:11px;color:var(--muted);text-align:left;font-weight:600;border-bottom:1px solid var(--border-light)';
      var peopleRows=s.people.map(function(p){return '<tr><td style="padding:6px 10px;font-size:12px;color:var(--text);font-weight:500">'+p.name+'</td><td style="padding:6px 10px;font-size:12px;color:var(--muted)">'+p.job+'</td><td style="padding:6px 10px;font-size:12px;color:var(--muted)">'+p.date+'</td>'+(hasExtra?'<td style="padding:6px 10px;font-size:12px"><span style="display:inline-flex;align-items:center;gap:4px;background:'+s.color+'14;color:'+s.color+';border-radius:4px;padding:1px 7px;font-size:11px;font-weight:600">'+(p.extra||'—')+'</span></td>':'')+'</tr>';}).join('');
      return '<div class="source-row" onclick="toggleSourceDetail(this)"><div class="source-meta" style="display:flex;align-items:center;gap:8px"><span class="source-name" style="flex:1">'+s.name+'</span><span class="source-count" style="font-weight:700">'+s.people.length+'人</span><span class="source-pct" style="color:var(--muted);font-size:12px;min-width:32px;text-align:right">'+pct2+'%</span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2" style="flex-shrink:0;transition:transform .2s" class="chevron"><path d="M6 9l6 6 6-6"/></svg></div><div class="source-bar-wrap" style="margin-top:6px"><div class="source-bar-inner" style="width:'+barW+'%;background:'+s.color+';height:8px;border-radius:999px"></div></div><div class="source-detail" style="display:none;margin-top:10px;border-radius:var(--radius);overflow:hidden;border:1px solid var(--border-light)"><table style="width:100%;border-collapse:collapse"><thead><tr style="background:#faf9fb"><th style="'+thStyle+'">姓名</th><th style="'+thStyle+'">岗位</th><th style="'+thStyle+'">入职日期</th>'+(hasExtra?'<th style="'+thStyle+';color:'+s.color+'">'+s.extraLabel+'</th>':'')+'</tr></thead><tbody>'+peopleRows+'</tbody></table></div></div>';
    }).join('<div class="divider" style="margin:4px 0"></div>');
    var tipHtml=tip?'<div style="margin-top:14px;padding:10px 12px;background:var(--orange-bg);border-radius:var(--radius);font-size:12px;color:var(--muted);border:1px solid var(--orange-border)">'+tip+'</div>':'';
    document.getElementById(containerId).innerHTML='<div class="card-title"><div class="icon-chip '+(containerId==='card-social'?'chip-blue':'chip-orange')+'">'+icon+'</div>'+title+'<span class="muted" style="margin-left:auto">共 '+total+' 人入职</span></div><div style="display:flex;gap:6px;height:14px;border-radius:999px;overflow:hidden;margin-bottom:12px">'+colorBar+'</div><div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:14px">'+legend+'</div><div class="divider" style="margin-bottom:8px"></div>'+rows+tipHtml;
  }
  buildCard('card-social','社招入职来源','<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" stroke-width="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',SOCIAL_SOURCES,null);
  buildCard('card-intern','实习生入职来源','<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--orange)" stroke-width="2"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/></svg>',INTERN_SOURCES,null);
  window.toggleSourceDetail=function(row){var d2=row.querySelector('.source-detail'),ch=row.querySelector('.chevron'),isOpen=d2.style.display!=='none';d2.style.display=isOpen?'none':'block';ch.style.transform=isOpen?'':'rotate(180deg)';};
})();

// ── Tab3: 每周新增堆叠柱图 ──
(function(){
  var chart=document.getElementById('weeklyChart');
  var legend=document.getElementById('weeklyLegend');
  var tbody=document.getElementById('weeklyTableBody');
  var thead=document.getElementById('weeklyTableHead');
  if (!chart||!WEEKLY_DATA.length) return;
  var maxTotal=Math.max(1,...WEEKLY_DATA.map(function(w){return w.data.reduce(function(a,b){return a+b;},0);}));
  var chartH=160;
  WEEKLY_DATA.forEach(function(w){
    var total=w.data.reduce(function(a,b){return a+b;},0);
    var colH=Math.max(4,Math.round((total/maxTotal)*chartH));
    var col=document.createElement('div');col.className='week-col';
    var totalEl=document.createElement('div');totalEl.className='week-total';totalEl.textContent=total;col.appendChild(totalEl);
    var barsDiv=document.createElement('div');barsDiv.className='week-bars';barsDiv.style.height=colH+'px';barsDiv.style.display='flex';barsDiv.style.flexDirection='column';
    w.data.forEach(function(v,i){if(!v)return;var seg=document.createElement('div');seg.className='week-seg';seg.style.cssText='flex:'+v+';background:'+JOB_COLORS[i]+';min-height:2px';seg.title=(TOP_JOBS[i]||'')+': '+v+'人';barsDiv.appendChild(seg);});
    col.appendChild(barsDiv);
    var labelEl=document.createElement('div');labelEl.className='week-label';labelEl.textContent=w.label;col.appendChild(labelEl);
    chart.appendChild(col);
  });
  TOP_JOBS.forEach(function(j,i){legend.innerHTML+='<div class="legend-item"><span class="legend-dot" style="background:'+JOB_COLORS[i]+'"></span>'+j+'</div>';});
  // 表头
  thead.innerHTML='<th>周次</th>'+TOP_JOBS.map(function(j){return '<th class="num">'+j+'</th>';}).join('')+'<th class="num" style="color:var(--text)">合计</th>';
  // 明细行
  WEEKLY_DATA.forEach(function(w){var total=w.data.reduce(function(a,b){return a+b;},0);tbody.innerHTML+='<tr><td style="white-space:nowrap;color:var(--muted);font-size:12px">'+w.label+'</td>'+w.data.map(function(v){return '<td class="num">'+v+'</td>';}).join('')+'<td class="num" style="color:var(--primary);font-weight:700">'+total+'</td></tr>';});
  // 合计行
  var colTotals=TOP_JOBS.map(function(_,i){return WEEKLY_DATA.reduce(function(s,w){return s+w.data[i];},0);});
  var grandTotal=colTotals.reduce(function(a,b){return a+b;},0);
  tbody.innerHTML+='<tr style="background:var(--primary-bg);font-weight:700"><td style="font-size:12px;color:var(--text)">合计</td>'+colTotals.map(function(v){return '<td class="num" style="color:var(--primary)">'+v+'</td>';}).join('')+'<td class="num" style="color:var(--primary)">'+grandTotal+'</td></tr>';
})();

// ── Tab4: 漏斗 ──
(function(){
  var list=document.getElementById('funnelList');
  if(!list) return;
  if(!FUNNEL_JOBS.length){list.innerHTML='<div class="muted" style="padding:40px;text-align:center">暂无岗位数据</div>';return;}
  FUNNEL_JOBS.forEach(function(job,idx){
    if (!job.total) return;
    var hcPct=job.headcount>0?Math.min(100,Math.round(job.hired/job.headcount*100)):0;
    var convRate=Math.round(job.hired/job.total*100);
    var stages=[
      {name:'筛选',count:job.screen,   color:'#8c93a3',prev:job.total},
      {name:'面试',count:job.interview,color:'#9b72f5',prev:job.screen},
      {name:'Offer',count:job.offer,  color:'#f5960a',prev:job.interview},
      {name:'入职',count:job.hired,   color:'#2eb87a',prev:job.offer},
    ];
    var stagesHtml=stages.map(function(s,i){
      var pctOfTotal=Math.round(s.count/job.total*100);
      var barW=Math.max(3,pctOfTotal);
      var stepRate=s.prev>0?Math.round(s.count/s.prev*100):0;
      var stepColor=stepRate>=60?'#2eb87a':stepRate>=30?'#f5960a':'#f05a5a';
      var arrowHtml=i>0?'<div style="text-align:right;font-size:10px;color:'+stepColor+';margin-bottom:2px;padding-right:2px">↓ '+stepRate+'% 转化</div>':'';
      return arrowHtml+'<div class="funnel-stage"><div class="funnel-stage-name">'+s.name+'</div><div class="funnel-stage-bar"><div class="funnel-stage-fill" style="width:'+barW+'%;background:'+s.color+'">'+(s.count>0?'<span class="funnel-stage-val">'+s.count+'</span>':'')+'</div></div><div class="funnel-stage-pct" style="color:'+s.color+';font-weight:600">'+pctOfTotal+'%</div></div>';
    }).join('');
    var el=document.createElement('div');el.className='funnel-job';
    el.innerHTML='<div class="funnel-head" onclick="toggleFunnel(this)"><div style="width:28px;height:28px;border-radius:8px;background:var(--primary-light);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--primary);flex-shrink:0">'+(idx+1)+'</div><div class="funnel-title">'+job.title+(job.dept?'<span class="muted" style="font-size:12px;font-weight:400"> '+job.dept+'</span>':'')+'</div><div class="funnel-summary"><div class="funnel-summary-item"><b>'+job.total+'</b>投递</div><div class="funnel-summary-item"><b style="color:var(--green)">'+job.hired+'</b>'+(job.headcount?'<span style="color:var(--muted)">/'+job.headcount+'</span>':'')+'入职</div><div class="funnel-summary-item"><b style="color:'+(convRate>=15?'#2eb87a':convRate>=8?'#f5960a':'#f05a5a')+'">'+convRate+'%</b>转化</div></div><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2" style="flex-shrink:0;transition:transform .2s" class="chevron"><path d="M6 9l6 6 6-6"/></svg></div><div class="funnel-body'+(idx===0?' open':'')+'">'+ stagesHtml+'<div style="margin-top:12px;display:flex;gap:14px;font-size:12px;color:var(--muted);flex-wrap:wrap;padding-top:10px;border-top:1px solid var(--border-light)"><span>淘汰：<b style="color:var(--red)">'+job.rejected+'</b>人</span><span>·</span><span>筛选率：<b style="color:#8c93a3">'+(job.total>0?Math.round(job.screen/job.total*100):0)+'%</b></span><span>·</span><span>面试转化：<b style="color:var(--purple)">'+(job.screen>0?Math.round(job.interview/job.screen*100):0)+'%</b></span><span>·</span><span>Offer率：<b style="color:var(--orange)">'+(job.interview>0?Math.round(job.offer/job.interview*100):0)+'%</b></span><span>·</span><span>Offer接受：<b style="color:var(--green)">'+(job.offer>0?Math.round(job.hired/job.offer*100):0)+'%</b></span></div></div>';
    list.appendChild(el);
  });
  window.toggleFunnel=function(head){var body=head.nextElementSibling;var ch=head.querySelector('.chevron');var isOpen=body.classList.contains('open');body.classList.toggle('open',!isOpen);ch.style.transform=isOpen?'':'rotate(180deg)';};
})();

// ── Tab5: 猎头分析 ──
(function(){
  // 供应商条形图
  var vendorBars=document.getElementById('vendorBars');
  if (vendorBars && VENDORS.length) {
    var maxV=VENDORS[0].total||1;
    vendorBars.innerHTML=VENDORS.map(function(v){return '<div class="source-row"><div class="source-meta"><span class="source-name" style="display:flex;align-items:center;gap:5px"><span style="width:8px;height:8px;border-radius:2px;background:'+v.color+';flex-shrink:0"></span>'+v.name+'</span><span class="source-count">'+v.total+'</span><span class="source-pct">'+Math.round(v.total/maxV*100)+'%</span></div><div class="source-bar-wrap"><div class="source-bar-inner" style="width:'+Math.round(v.total/maxV*100)+'%;background:'+v.color+';height:8px;border-radius:999px"></div></div></div>';}).join('');
  }
  // 供应商转化率表
  var convTable=document.getElementById('vendorConvTable');
  if (convTable && VENDORS.length) {
    function hiredBadge2(r){return r>=30?'status-green':r>=15?'status-blue':r>0?'status-gray':'status-red';}
    convTable.innerHTML='<table class="conv-table"><thead><tr><th>供应商</th><th class="num">推荐</th><th class="num">面试</th><th class="num">入职</th><th class="num" style="color:var(--green)">入职率</th></tr></thead><tbody>'+VENDORS.map(function(v){var r=v.total>0?Math.round(v.hired/v.total*100):0;return '<tr><td><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:'+v.color+';margin-right:6px"></span>'+v.name+'</td><td class="num">'+v.total+'</td><td class="num">'+v.interview+'</td><td class="num">'+v.hired+'</td><td class="num"><span class="badge '+hiredBadge2(r)+'">'+r+'%</span></td></tr>';}).join('')+'</tbody></table>';
  }
  // 矩阵
  var matrix=document.getElementById('vendorMatrix');
  if (matrix && VENDOR_MATRIX.vendors.length && VENDOR_MATRIX.jobs.length) {
    var vendorColors2=["#3b9de8","#9b72f5","#f5960a","#2eb87a","#2bbfbf","#f05a5a"];
    var html='<table><thead><tr><th style="min-width:120px">岗位</th>'+VENDOR_MATRIX.vendors.map(function(v,i){return '<th class="num" style="min-width:80px"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:'+vendorColors2[i%vendorColors2.length]+';margin-right:4px"></span>'+v+'</th>';}).join('')+'<th class="num" style="min-width:60px;color:var(--text)">合计</th></tr></thead><tbody>';
    VENDOR_MATRIX.jobs.forEach(function(job) {
      var rowTotal=0;
      var cells=VENDOR_MATRIX.vendors.map(function(v,vi){var cell=VENDOR_MATRIX.cells[vi]&&VENDOR_MATRIX.cells[vi][VENDOR_MATRIX.jobs.indexOf(job)]||{total:0,hired:0};rowTotal+=cell.total;return '<td class="num"><b>'+cell.total+'</b><span class="muted" style="font-size:11px">/'+cell.hired+'</span></td>';}).join('');
      html+='<tr><td style="font-weight:600">'+job+'</td>'+cells+'<td class="num" style="color:var(--primary);font-weight:700">'+rowTotal+'</td></tr>';
    });
    // 合计行
    var colTotals=VENDOR_MATRIX.vendors.map(function(_,vi){return VENDOR_MATRIX.jobs.reduce(function(s,_,ji){var c=VENDOR_MATRIX.cells[vi]&&VENDOR_MATRIX.cells[vi][ji]||{total:0};return s+c.total;},0);});
    var grand=colTotals.reduce(function(a,b){return a+b;},0);
    html+='<tr style="background:var(--primary-bg);font-weight:700"><td style="font-size:12px">合计</td>'+colTotals.map(function(v){return '<td class="num" style="color:var(--primary)">'+v+'</td>';}).join('')+'<td class="num" style="color:var(--primary)">'+grand+'</td></tr>';
    html+='</tbody></table>';
    matrix.innerHTML=html;
  } else if (matrix) {
    matrix.innerHTML='<div class="muted" style="padding:30px;text-align:center">暂无猎头候选人数据，请在新建候选人时选择「猎头」来源并选择供应商</div>';
  }
})();
</script>`;

  res.send(renderPage({ title: "数据分析", user: req.user, active: "analytics", contentHtml }));
});

export default router;
