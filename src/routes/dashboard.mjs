import { Router } from "express";
import { requireLogin } from "../auth.mjs";
import { loadTables, toBjTime } from "../db.mjs";
import { renderPage, escapeHtml } from "../ui.mjs";
import { STATUS_COLS, STATUS_SET, PIPELINE_STAGES } from "../constants.mjs";

const router = Router();

router.get("/", requireLogin, async (req, res) => {
  const d = await loadTables("candidates", "jobs", "interviews", "interviewSchedules");
  const total = d.candidates.length;
  const totalJobs = d.jobs.length;
  const openJobs = d.jobs.filter((j) => j.state === "open").length;

  const byStatus = {};
  for (const s of STATUS_COLS.map((x) => x.key)) byStatus[s] = 0;
  for (const c of d.candidates) {
    const s = STATUS_SET.has(c.status) ? c.status : "待筛选";
    byStatus[s] = (byStatus[s] || 0) + 1;
  }

  const interviewingCount = byStatus["待一面"] + byStatus["一面通过"] + byStatus["二面通过"] + byStatus["三面通过"] + byStatus["四面通过"] + byStatus["五面通过"];
  const offerCount = byStatus["Offer发放"];
  const hiredCount = byStatus["入职"];
  const rejectedCount = byStatus["淘汰"];

  // 来源分析
  const bySource = {};
  for (const c of d.candidates) {
    const src = c.source || "未知";
    bySource[src] = (bySource[src] || 0) + 1;
  }
  const sourceItems = Object.entries(bySource).sort((a, b) => b[1] - a[1]);
  const sourceBarMax = sourceItems.length ? sourceItems[0][1] : 1;
  const sourceHtml = sourceItems.map(([name, count]) => {
    const pct = Math.round((count / sourceBarMax) * 100);
    return '<div style="margin-bottom:10px"><div class="row"><span>' + escapeHtml(name) + '</span><span class="spacer"></span><b>' + count + '</b></div><div class="bar"><div class="bar-fill bar-blue" style="width:' + pct + '%"></div></div></div>';
  }).join("");

  // 岗位招聘进度
  const jobProgressHtml = d.jobs.slice(0, 8).map((j) => {
    const cands = d.candidates.filter((c) => c.jobId === j.id);
    const hired = cands.filter((c) => c.status === "入职").length;
    const hc = j.headcount || 0;
    const pct = hc > 0 ? Math.min(100, Math.round((hired / hc) * 100)) : 0;
    const barColor = pct >= 100 ? "bar-green" : "bar-blue";
    return '<div style="margin-bottom:10px"><div class="row"><span style="font-weight:700">' + escapeHtml(j.title || "未命名") + '</span><span class="spacer"></span><span class="muted">' + hired + ' / ' + (hc || "?") + '</span></div><div class="bar"><div class="bar-fill ' + barColor + '" style="width:' + pct + '%"></div></div></div>';
  }).join("");

  // Offer 统计
  const totalOffers = d.offers ? d.offers.length : 0;
  const acceptedOffers = d.offers ? d.offers.filter((o) => o.offerStatus === "已接受").length : 0;
  const pendingOffers = d.offers ? d.offers.filter((o) => o.offerStatus === "待发放" || o.offerStatus === "已发放").length : 0;

  // 面试安排统计
  const allSchedules = d.interviewSchedules || [];
  const todayStr = new Date().toISOString().slice(0, 10);
  const thisWeekEnd = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const todayInterviews = allSchedules.filter(s => (s.scheduledAt || "").slice(0, 10) === todayStr).length;
  const weekInterviews = allSchedules.filter(s => {
    const dt = (s.scheduledAt || "").slice(0, 10);
    return dt >= todayStr && dt <= thisWeekEnd;
  }).length;
  const totalInterviews = allSchedules.length;

  // 转化率
  const convOfferRate = total > 0 ? Math.round(((byStatus["Offer发放"] || 0) + hiredCount) / total * 100) : 0;
  const convHireRate = total > 0 ? Math.round(hiredCount / total * 100) : 0;

  // 最近动态
  const recentEvents = (d.events || []).slice(0, 8);
  const recentHtml = recentEvents.length ? recentEvents.map((e) => {
    return '<div class="titem"><div class="tmeta"><b>' + escapeHtml(e.actor || "系统") + '</b><span class="badge status-gray" style="font-size:11px">' + escapeHtml(e.type || "-") + '</span><span class="muted">' + escapeHtml(toBjTime(e.createdAt || "").slice(0, 16)) + '</span></div><div class="tmsg" style="font-size:13px">' + escapeHtml(e.message || "").replaceAll("\n", "<br/>") + '</div></div>';
  }).join("") : '<div class="muted">暂无动态</div>';

  // 今日面试详情列表
  const candMap = new Map(d.candidates.map(c => [c.id, c]));
  const todaySchedules = allSchedules.filter(s => (s.scheduledAt || "").slice(0, 10) === todayStr)
    .sort((a, b) => (a.scheduledAt || "").localeCompare(b.scheduledAt || ""));
  const todayDetailHtml = todaySchedules.length ? todaySchedules.map(s => {
    const cand = candMap.get(s.candidateId);
    const time = (s.scheduledAt || "").slice(11, 16) || "时间待定";
    const candName = cand ? '<a href="/candidates/' + escapeHtml(cand.id) + '" style="color:var(--primary);font-weight:700">' + escapeHtml(cand.name || "未命名") + '</a>' : '未知候选人';
    return '<div class="remind-item"><span class="remind-time">' + time + '</span>' + candName + '<span class="muted" style="font-size:12px">第' + (s.round || 1) + '轮</span><span class="muted" style="font-size:12px">' + escapeHtml(s.interviewers || "-") + '</span></div>';
  }).join("") : '<div class="muted" style="font-size:13px">今日无面试安排</div>';

  // 待面评提醒：已过面试时间但还未提交面评的记录（用 Set 避免 N*M 扫描）
  const reviewSet = new Set((d.interviews || []).map(rv => rv.candidateId + ":" + rv.round));
  const pastSchedules = allSchedules.filter(s => {
    const dt = (s.scheduledAt || "").slice(0, 10);
    return dt && dt <= todayStr;
  });
  const pendingReviewItems = [];
  for (const s of pastSchedules) {
    if (!reviewSet.has(s.candidateId + ":" + s.round)) {
      const cand = candMap.get(s.candidateId);
      if (cand) pendingReviewItems.push({ schedule: s, cand });
    }
  }
  const pendingReviewHtml = pendingReviewItems.length ? pendingReviewItems.slice(0, 8).map(({ schedule: s, cand }) => {
    return '<div class="remind-item"><span class="badge status-orange" style="font-size:11px">待面评</span><a href="/candidates/' + escapeHtml(cand.id) + '" style="color:var(--primary);font-weight:700">' + escapeHtml(cand.name || "未命名") + '</a><span class="muted" style="font-size:12px">第' + (s.round || 1) + '轮 · ' + escapeHtml((s.scheduledAt || "").slice(0, 10)) + '</span></div>';
  }).join("") : '<div class="muted" style="font-size:13px">暂无待面评记录</div>';

  // 面试提醒卡片
  const remindCardHtml = '<div class="card reminder-card"><div style="font-weight:900;margin-bottom:12px">📋 面试提醒</div>' +
    '<div class="remind-section"><div class="remind-title">今日面试 <span class="badge status-blue" style="font-size:11px">' + todaySchedules.length + '</span></div>' + todayDetailHtml + '</div>' +
    '<div class="divider"></div>' +
    '<div class="remind-section"><div class="remind-title">待面评 <span class="badge status-orange" style="font-size:11px">' + pendingReviewItems.length + '</span></div>' + pendingReviewHtml + '</div>' +
    '</div>';

  // 流水线阶段漏斗（精简版）
  const funnelHtml = PIPELINE_STAGES.map((stage) => {
    const count = stage.statuses.reduce((sum, s) => sum + (byStatus[s] || 0), 0);
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    return '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;padding:8px 12px;border-radius:var(--radius);background:#f7f8fa"><span style="font-size:16px;min-width:24px">' + stage.icon + '</span><span style="font-weight:600;min-width:70px;font-size:13px">' + escapeHtml(stage.name) + '</span><span style="min-width:30px;text-align:right;font-weight:900;font-size:16px">' + count + '</span><div class="bar" style="flex:1;margin:0"><div class="bar-fill" style="width:' + pct + '%;background:' + stage.color + '"></div></div><span class="muted" style="min-width:32px;text-align:right">' + pct + '%</span></div>';
  }).join("");

  // 欢迎信息
  const greeting = new Date().getHours() < 12 ? "上午好" : new Date().getHours() < 18 ? "下午好" : "晚上好";

  res.send(
    renderPage({
      title: "招聘概览",
      user: req.user,
      active: "",
      contentHtml: '<div class="row"><div><div style="font-weight:900;font-size:20px">招聘概览</div><div class="muted" style="margin-top:4px">' + greeting + '，' + escapeHtml(req.user?.name || "用户") + '！当前共有 ' + total + ' 名候选人在流程中</div></div><span class="spacer"></span><a class="btn" href="/candidates">人才库</a><a class="btn primary" href="/candidates/board">候选人看板</a></div><div style="height:16px"></div>' +
        // 核心数据卡片
        '<div class="grid4">' +
        '<div class="card stat-card"><div class="stat-number">' + total + '</div><div class="stat-label">候选人总数</div></div>' +
        '<div class="card stat-card"><div class="stat-number" style="color:var(--primary)">' + interviewingCount + '</div><div class="stat-label">面试中</div></div>' +
        '<div class="card stat-card"><div class="stat-number" style="color:var(--orange)">' + offerCount + '</div><div class="stat-label">Offer阶段</div></div>' +
        '<div class="card stat-card"><div class="stat-number" style="color:var(--green)">' + hiredCount + '</div><div class="stat-label">已入职</div></div>' +
        '</div><div style="height:14px"></div>' +
        '<div class="grid4">' +
        '<div class="card stat-card"><div class="stat-number" style="color:var(--primary)">' + todayInterviews + '</div><div class="stat-label">今日面试</div></div>' +
        '<div class="card stat-card"><div class="stat-number" style="color:var(--primary)">' + weekInterviews + '</div><div class="stat-label">本周面试</div></div>' +
        '<div class="card stat-card"><div class="stat-number" style="color:var(--primary)">' + convOfferRate + '%</div><div class="stat-label">Offer转化率</div></div>' +
        '<div class="card stat-card"><div class="stat-number" style="color:var(--primary)">' + convHireRate + '%</div><div class="stat-label">入职转化率</div></div>' +
        '</div><div style="height:14px"></div>' +
        // 面试提醒
        remindCardHtml +
        '<div style="height:14px"></div>' +
        // 两栏布局：漏斗 + 数据
        '<div class="grid">' +
        '<div>' +
        '<div class="card"><div style="font-weight:900;margin-bottom:14px;font-size:15px">📊 招聘漏斗</div>' + funnelHtml + '</div>' +
        '<div style="height:14px"></div>' +
        '<div class="card"><div style="font-weight:900;margin-bottom:14px;font-size:15px">📈 岗位招聘进度</div>' + (jobProgressHtml || '<div class="muted">暂无岗位</div>') + '</div>' +
        '</div>' +
        '<div>' +
        '<div class="card"><div style="font-weight:900;margin-bottom:14px;font-size:15px">📋 数据总览</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
        '<div class="pill"><span class="muted">总职位</span><b>' + totalJobs + '</b></div>' +
        '<div class="pill"><span class="muted">开放中</span><b>' + openJobs + '</b></div>' +
        '<div class="pill"><span class="muted">Offer总数</span><b>' + totalOffers + '</b></div>' +
        '<div class="pill"><span class="muted">已接受</span><b>' + acceptedOffers + '</b></div>' +
        '<div class="pill"><span class="muted">待处理Offer</span><b>' + pendingOffers + '</b></div>' +
        '<div class="pill"><span class="muted">淘汰</span><b>' + rejectedCount + '</b></div>' +
        '</div></div>' +
        '<div style="height:14px"></div>' +
        '<div class="card"><div style="font-weight:900;margin-bottom:14px;font-size:15px">🔍 来源分析</div>' + (sourceHtml || '<div class="muted">暂无数据</div>') + '</div>' +
        '<div style="height:14px"></div>' +
        '<div class="card"><div style="font-weight:900;margin-bottom:14px;font-size:15px">🕐 最近动态</div><div class="timeline">' + recentHtml + '</div></div>' +
        '</div></div>',
    })
  );
});

export default router;
