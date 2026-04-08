import { Router } from "express";
import { requireLogin } from "../auth.mjs";
import { loadTables, toBjTime } from "../db.mjs";
import { renderPage, escapeHtml } from "../ui.mjs";
import { STATUS_COLS, STATUS_SET, PIPELINE_STAGES } from "../constants.mjs";
import { getVisibleJobIds, filterCandidatesByPermission } from "../helpers.mjs";

const router = Router();

router.get("/", requireLogin, async (req, res) => {
  const d = await loadTables("candidates", "jobs", "interviews", "interviewSchedules", "offers", "events");
  const isAdmin = req.user?.role === "admin";
  const visibleJobIds = getVisibleJobIds(req.user, d.jobs);
  const candidates = filterCandidatesByPermission(d.candidates, visibleJobIds);
  const visibleJobs = visibleJobIds === null ? d.jobs : d.jobs.filter((j) => visibleJobIds.has(j.id));

  const total = candidates.length;
  const totalJobs = visibleJobs.length;
  const openJobs = visibleJobs.filter((j) => j.state === "open").length;

  const byStatus = {};
  for (const s of STATUS_COLS.map((x) => x.key)) byStatus[s] = 0;
  for (const c of candidates) {
    const s = STATUS_SET.has(c.status) ? c.status : "待筛选";
    byStatus[s] = (byStatus[s] || 0) + 1;
  }

  const interviewingCount =
    (byStatus["待一面"] || 0) +
    (byStatus["一面通过"] || 0) +
    (byStatus["待二面"] || 0) +
    (byStatus["二面通过"] || 0) +
    (byStatus["待三面"] || 0) +
    (byStatus["三面通过"] || 0) +
    (byStatus["待四面"] || 0) +
    (byStatus["四面通过"] || 0) +
    (byStatus["待五面"] || 0) +
    (byStatus["五面通过"] || 0);

  const offerCount = (byStatus["待发offer"] || 0) + (byStatus["Offer发放"] || 0);
  const hiredCount = byStatus["入职"] || 0;
  const rejectedCount = byStatus["淘汰"] || 0;

  const jobMap = new Map(d.jobs.map((j) => [j.id, j]));
  function isIntern(c) {
    const job = jobMap.get(c.jobId);
    return job ? job.employmentType === "实习" : false;
  }

  function sourceBarHtml(list, barClass) {
    const map = {};
    for (const c of list) {
      const src = c.source || "未知";
      map[src] = (map[src] || 0) + 1;
    }
    const items = Object.entries(map).sort((a, b) => b[1] - a[1]);
    if (!items.length) return '<div class="muted">暂无数据</div>';
    const max = items[0][1];
    return items
      .map(([name, count]) => {
        const pct = Math.round((count / max) * 100);
        return (
          '<div style="margin-bottom:10px">' +
          '<div class="row"><span>' +
          escapeHtml(name) +
          '</span><span class="spacer"></span><b>' +
          count +
          "</b></div>" +
          '<div class="bar"><div class="bar-fill ' +
          barClass +
          '" style="width:' +
          pct +
          '%"></div></div>' +
          "</div>"
        );
      })
      .join("");
  }

  const hiredSocial = candidates.filter((c) => c.status === "入职" && !isIntern(c));
  const hiredIntern = candidates.filter((c) => c.status === "入职" && isIntern(c));

  const hiredSocialHtml = sourceBarHtml(hiredSocial, "bar-green");
  const hiredInternHtml = sourceBarHtml(hiredIntern, "bar-blue");

  const jobProgressHtml = visibleJobs
    .slice(0, 8)
    .map((j) => {
      const cands = candidates.filter((c) => c.jobId === j.id);
      const hired = cands.filter((c) => c.status === "入职").length;
      const hc = j.headcount || 0;
      const pct = hc > 0 ? Math.min(100, Math.round((hired / hc) * 100)) : 0;
      const barColor = pct >= 100 ? "bar-green" : "bar-blue";
      return (
        '<div style="margin-bottom:14px">' +
        '<div class="row"><span style="font-weight:700">' +
        escapeHtml(j.title || "未命名") +
        '</span><span class="spacer"></span><span class="muted">' +
        hired +
        " / " +
        (hc || "?") +
        "</span></div>" +
        '<div class="bar"><div class="bar-fill ' +
        barColor +
        '" style="width:' +
        pct +
        '%"></div></div>' +
        "</div>"
      );
    })
    .join("");

  const totalOffers = d.offers ? d.offers.length : 0;
  const acceptedOffers = d.offers ? d.offers.filter((o) => o.offerStatus === "已接受").length : 0;
  const pendingOffers = d.offers ? d.offers.filter((o) => o.offerStatus === "待发放" || o.offerStatus === "已发放").length : 0;

  const candIdSet = new Set(candidates.map((c) => c.id));
  const allSchedulesRaw = d.interviewSchedules || [];
  const allSchedules =
    visibleJobIds === null ? allSchedulesRaw : allSchedulesRaw.filter((s) => candIdSet.has(s.candidateId));

  const todayStr = new Date().toISOString().slice(0, 10);

  const allEvents = d.events || [];
  const visibleEvents =
    visibleJobIds === null ? allEvents : allEvents.filter((e) => !e.candidateId || candIdSet.has(e.candidateId));
  const recentEvents = visibleEvents.slice(0, 8);

  const recentHtml = recentEvents.length
    ? recentEvents
        .map((e) => {
          return (
            '<div class="titem">' +
            '<div class="tmeta"><b>' +
            escapeHtml(e.actor || "系统") +
            '</b><span class="badge status-gray" style="font-size:11px">' +
            escapeHtml(e.type || "-") +
            "</span><span class=\"muted\">" +
            escapeHtml(toBjTime(e.createdAt || "").slice(0, 16)) +
            "</span></div>" +
            '<div class="tmsg" style="font-size:13px">' +
            escapeHtml(e.message || "").replaceAll("\n", "<br/>") +
            "</div>" +
            "</div>"
          );
        })
        .join("")
    : '<div class="muted">暂无动态</div>';

  const candMap = new Map(candidates.map((c) => [c.id, c]));
  const todaySchedules = allSchedules
    .filter((s) => (s.scheduledAt || "").slice(0, 10) === todayStr)
    .sort((a, b) => (a.scheduledAt || "").localeCompare(b.scheduledAt || ""));

  const todayDetailHtml = todaySchedules.length
    ? todaySchedules
        .map((s) => {
          const cand = candMap.get(s.candidateId);
          const time = (s.scheduledAt || "").slice(11, 16) || "时间待定";
          const candName = cand
            ? '<a href="/candidates/' +
              escapeHtml(cand.id) +
              '" style="color:var(--primary);font-weight:700">' +
              escapeHtml(cand.name || "未命名") +
              "</a>"
            : "未知候选人";
          return (
            '<div class="remind-item">' +
            '<span class="remind-time">' +
            time +
            "</span>" +
            candName +
            '<span class="muted" style="font-size:12px">第' +
            (s.round || 1) +
            '轮</span>' +
            '<span class="muted" style="font-size:12px">' +
            escapeHtml(s.interviewers || "-") +
            "</span>" +
            "</div>"
          );
        })
        .join("")
    : '<div class="muted" style="font-size:13px">今日无面试安排</div>';

  const reviewSet = new Set((d.interviews || []).map((rv) => rv.candidateId + ":" + rv.round));
  const pastSchedules = allSchedules.filter((s) => {
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

  const pendingReviewHtml = pendingReviewItems.length
    ? pendingReviewItems
        .slice(0, 8)
        .map(({ schedule: s, cand }) => {
          return (
            '<div class="remind-item">' +
            '<span class="badge status-orange" style="font-size:11px">待面评</span>' +
            '<a href="/candidates/' +
            escapeHtml(cand.id) +
            '" style="color:var(--primary);font-weight:700">' +
            escapeHtml(cand.name || "未命名") +
            "</a>" +
            '<span class="muted" style="font-size:12px">第' +
            (s.round || 1) +
            "轮 · " +
            escapeHtml((s.scheduledAt || "").slice(0, 10)) +
            "</span>" +
            "</div>"
          );
        })
        .join("")
    : '<div class="muted" style="font-size:13px">暂无待面评记录</div>';

  const remindCardHtml =
    '<div class="card reminder-card">' +
    '<div style="font-weight:900;margin-bottom:12px">📋 面试提醒</div>' +
    '<div class="remind-section">' +
    '<div class="remind-title">今日面试 <span class="badge status-blue" style="font-size:11px">' +
    todaySchedules.length +
    "</span></div>" +
    todayDetailHtml +
    "</div>" +
    '<div class="divider"></div>' +
    '<div class="remind-section">' +
    '<div class="remind-title">待面评 <span class="badge status-orange" style="font-size:11px">' +
    pendingReviewItems.length +
    "</span></div>" +
    pendingReviewHtml +
    "</div>" +
    "</div>";

  const funnelHtml = PIPELINE_STAGES.map((stage) => {
    const count = stage.statuses.reduce((sum, s) => sum + (byStatus[s] || 0), 0);
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    return (
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;padding:8px 12px;border-radius:var(--radius);background:#f7f8fa">' +
      '<span style="font-size:16px;min-width:24px">' +
      stage.icon +
      "</span>" +
      '<span style="font-weight:600;min-width:70px;font-size:13px">' +
      escapeHtml(stage.name) +
      "</span>" +
      '<span style="min-width:30px;text-align:right;font-weight:900;font-size:16px">' +
      count +
      "</span>" +
      '<div class="bar" style="flex:1;margin:0"><div class="bar-fill" style="width:' +
      pct +
      "%;background:" +
      stage.color +
      '"></div></div>' +
      '<span class="muted" style="min-width:32px;text-align:right">' +
      pct +
      "%</span>" +
      "</div>"
    );
  }).join("");

  const greeting = new Date().getHours() < 12 ? "上午好" : new Date().getHours() < 18 ? "下午好" : "晚上好";

  const heroHtml =
    '<div class="card" style="padding:0;overflow:hidden">' +
    '<div style="background:linear-gradient(90deg,#7c5cfc 0%,#8b5cf6 55%,#d946ef 100%);padding:24px 24px 20px;color:#fff">' +
    '<div class="row" style="align-items:flex-start">' +
    "<div>" +
    '<div style="font-size:13px;opacity:.86">Machinepulse Recruiting</div>' +
    '<div style="font-size:34px;font-weight:900;line-height:1.1;margin-top:6px">Machinepulse 招聘总览</div>' +
    '<div style="margin-top:10px;font-size:13px;opacity:.9">' +
    greeting +
    "，" +
    escapeHtml(req.user?.name || "同学") +
    "。当前共有 " +
    total +
    " 名候选人在流程中，今日有 " +
    todaySchedules.length +
    " 场面试待进行，" +
    pendingReviewItems.length +
    " 份面评待处理。</div>" +
    "</div>" +
    '<span class="spacer"></span>' +
    "</div>" +
    "</div>" +
    "</div>";

  res.send(
    renderPage({
      title: "招聘概览",
      user: req.user,
      active: "",
      contentHtml:
        heroHtml +
        '<div style="height:14px"></div>' +

        '<div class="grid4">' +
        '<div class="card stat-card"><div class="stat-number">' +
        total +
        '</div><div class="stat-label">候选人总数</div></div>' +
        '<div class="card stat-card"><div class="stat-number" style="color:var(--primary)">' +
        interviewingCount +
        '</div><div class="stat-label">面试中</div></div>' +
        '<div class="card stat-card"><div class="stat-number" style="color:var(--orange)">' +
        offerCount +
        '</div><div class="stat-label">Offer阶段</div></div>' +
        '<div class="card stat-card"><div class="stat-number" style="color:var(--green)">' +
        hiredCount +
        '</div><div class="stat-label">已入职</div></div>' +
        "</div>" +

        '<div style="height:14px"></div>' +
        remindCardHtml +

        '<div style="height:14px"></div>' +
        '<div class="grid">' +
        "<div>" +
        '<div class="card"><div style="font-weight:900;margin-bottom:14px;font-size:15px">📊 招聘漏斗</div>' +
        funnelHtml +
        "</div>" +
        '<div style="height:14px"></div>' +
        '<div class="card"><div style="font-weight:900;margin-bottom:14px;font-size:15px">📈 岗位招聘进度</div>' +
        (jobProgressHtml || '<div class="muted">暂无岗位</div>') +
        "</div>" +
        "</div>" +

        "<div>" +
        (isAdmin
          ? '<div class="card"><div style="font-weight:900;margin-bottom:14px;font-size:15px">📋 数据总览</div>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
            '<div class="pill"><span class="muted">总职位</span><b>' +
            totalJobs +
            "</b></div>" +
            '<div class="pill"><span class="muted">开放中</span><b>' +
            openJobs +
            "</b></div>" +
            '<div class="pill"><span class="muted">Offer总数</span><b>' +
            totalOffers +
            "</b></div>" +
            '<div class="pill"><span class="muted">已接受</span><b>' +
            acceptedOffers +
            "</b></div>" +
            '<div class="pill"><span class="muted">待处理Offer</span><b>' +
            pendingOffers +
            "</b></div>" +
            '<div class="pill"><span class="muted">淘汰</span><b>' +
            rejectedCount +
            "</b></div>" +
            "</div></div>" +
            '<div style="height:14px"></div>' +
            '<div class="card"><div style="font-weight:900;margin-bottom:14px;font-size:15px">🏢 社招入职来源统计 <span class="badge status-green" style="font-size:11px">' +
            hiredSocial.length +
            '人</span></div>' +
            hiredSocialHtml +
            "</div>" +
            '<div style="height:14px"></div>' +
            '<div class="card"><div style="font-weight:900;margin-bottom:14px;font-size:15px">🎓 实习生入职来源统计 <span class="badge status-blue" style="font-size:11px">' +
            hiredIntern.length +
            '人</span></div>' +
            hiredInternHtml +
            "</div>" +
            '<div style="height:14px"></div>'
          : "") +
        '<div class="card"><div style="font-weight:900;margin-bottom:14px;font-size:15px">🕐 最近动态</div><div class="timeline">' +
        recentHtml +
        "</div></div>" +
        "</div>" +
        "</div>",
    })
  );
});

export default router;