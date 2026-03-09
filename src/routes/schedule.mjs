import { Router } from "express";
import { requireLogin } from "../auth.mjs";
import { loadTables } from "../db.mjs";
import { renderPage, escapeHtml } from "../ui.mjs";
import { feishuEnabled, searchFeishuUsers, getAllFeishuEmployees } from "../feishu.mjs";

const router = Router();

router.get("/schedule", requireLogin, async (req, res) => {
  const d = await loadTables("interviewSchedules", "candidates", "jobs", "interviews", "users");
  const schedules = (d.interviewSchedules || [])
    .filter(s => s.scheduledAt)
    .sort((a, b) => (a.scheduledAt > b.scheduledAt ? 1 : -1));

  const upcoming = schedules.filter(s => new Date(s.scheduledAt.replace(" ", "T")) >= new Date());
  const past = schedules.filter(s => new Date(s.scheduledAt.replace(" ", "T")) < new Date());

  // ====== 周视图 ======
  const view = req.query.view || "week";
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  // 计算当前周的起止日期
  let weekOffset = Number(req.query.week || 0);
  const baseDate = new Date(today);
  baseDate.setDate(baseDate.getDate() + weekOffset * 7);
  const dayOfWeek = baseDate.getDay(); // 0=Sun
  const weekStart = new Date(baseDate);
  weekStart.setDate(weekStart.getDate() - dayOfWeek + 1); // Mon
  const weekDays = [];
  const dayNames = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  for (let i = 0; i < 7; i++) {
    const dt = new Date(weekStart);
    dt.setDate(dt.getDate() + i);
    weekDays.push({ date: dt, str: dt.toISOString().slice(0, 10), label: dayNames[i], day: dt.getDate(), month: dt.getMonth() + 1 });
  }
  const weekLabel = `${weekDays[0].month}月${weekDays[0].day}日 - ${weekDays[6].month}月${weekDays[6].day}日`;

  // 按日期分组面试（用 Map 避免 N+1 线性扫描）
  const candMap = new Map(d.candidates.map(c => [c.id, c]));
  const reviewSet = new Set((d.interviews || []).map(x => x.candidateId + ":" + x.round));
  const schedulesByDate = {};
  for (const s of schedules) {
    const dt = (s.scheduledAt || "").slice(0, 10);
    if (!dt) continue;
    if (!schedulesByDate[dt]) schedulesByDate[dt] = [];
    const c = candMap.get(s.candidateId);
    const hasReview = reviewSet.has(s.candidateId + ":" + s.round);
    schedulesByDate[dt].push({ ...s, candName: c?.name || "未知", candId: c?.id, jobTitle: c?.jobTitle || "", hasReview });
  }

  // 时间轴：8:00 - 20:00
  const hours = [];
  for (let h = 8; h <= 20; h++) hours.push(h);

  // 生成周视图 HTML
  const weekHeaderCells = weekDays.map(wd => {
    const isToday = wd.str === todayStr;
    return `<div class="wk-head${isToday ? ' wk-today' : ''}"><div class="wk-dayname">${wd.label}</div><div class="wk-daynum${isToday ? ' wk-today-num' : ''}">${wd.day}</div></div>`;
  }).join("");

  // 生成时间格和事件块
  let weekBodyHtml = '';
  for (const h of hours) {
    const timeLabel = `${String(h).padStart(2, "0")}:00`;
    weekBodyHtml += `<div class="wk-time">${timeLabel}</div>`;
    for (const wd of weekDays) {
      const daySchedules = (schedulesByDate[wd.str] || []).filter(s => {
        const sh = parseInt((s.scheduledAt || "").slice(11, 13) || "99", 10);
        return sh === h;
      });
      const eventsHtml = daySchedules.map(s => {
        const time = (s.scheduledAt || "").slice(11, 16) || "";
        const colors = ["#3370ff", "#3b82f6", "#10b981", "#ff7d00", "#f54a45"];
        const color = colors[(s.round - 1) % colors.length];
        return `<a href="/candidates/${escapeHtml(s.candId || "")}" class="wk-event" style="border-left:3px solid ${color};background:${color}11" title="${escapeHtml(s.candName)} 第${s.round}轮 ${time}\n面试官：${escapeHtml(s.interviewers || "-")}">
          <div class="wk-ev-time">${time}</div>
          <div class="wk-ev-name">${escapeHtml(s.candName)}</div>
          <div class="wk-ev-meta">第${s.round}轮 · ${escapeHtml((s.interviewers || "").split(/[\/,]/).map(n => n.trim().slice(0, 2)).filter(Boolean).join("、") || "-")}</div>
        </a>`;
      }).join("");
      const isToday = wd.str === todayStr;
      weekBodyHtml += `<div class="wk-cell${isToday ? ' wk-cell-today' : ''}">${eventsHtml}</div>`;
    }
  }

  const weekViewHtml = `
    <div class="card" style="margin-bottom:14px;overflow-x:auto">
      <div class="row" style="margin-bottom:12px">
        <a class="btn sm" href="/schedule?view=week&week=${weekOffset - 1}">&larr;</a>
        <div style="font-weight:900;font-size:16px;margin:0 12px">${weekLabel}</div>
        <a class="btn sm" href="/schedule?view=week&week=${weekOffset + 1}">&rarr;</a>
        <span class="spacer"></span>
        <a class="btn sm" href="/schedule?view=week&week=0">本周</a>
      </div>
      <div class="wk-grid">
        <div class="wk-corner"></div>
        ${weekHeaderCells}
        ${weekBodyHtml}
      </div>
    </div>`;

  // ====== 月视图 ======
  const calMonth = req.query.month || today.toISOString().slice(0, 7);
  const [calY, calM] = calMonth.split("-").map(Number);
  const firstDay = new Date(calY, calM - 1, 1);
  const lastDay = new Date(calY, calM, 0);
  const startDow = firstDay.getDay();
  const totalDays = lastDay.getDate();

  let calCells = '';
  for (let i = 0; i < startDow; i++) calCells += '<div class="cal-cell empty"></div>';
  for (let day = 1; day <= totalDays; day++) {
    const dateStr = `${calY}-${String(calM).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const items = schedulesByDate[dateStr] || [];
    const isToday = dateStr === todayStr;
    const dots = items.slice(0, 3).map(s => {
      const timeStr = (s.scheduledAt || "").slice(11, 16) || "";
      return `<a href="/candidates/${escapeHtml(s.candId || "")}" class="cal-dot" title="${escapeHtml(s.candName)} 第${s.round}轮 ${escapeHtml(s.scheduledAt?.slice(11) || "")}">${timeStr ? '<span style="font-size:10px;opacity:.7">' + timeStr + '</span> ' : ''}${escapeHtml(s.candName?.slice(0, 3) || "")}</a>`;
    }).join("");
    const more = items.length > 3 ? `<span class="cal-more">+${items.length - 3}</span>` : "";
    calCells += `<div class="cal-cell${isToday ? ' today' : ''}"><div class="cal-day">${day}</div>${dots}${more}</div>`;
  }

  const prevMonth = calM === 1 ? `${calY - 1}-12` : `${calY}-${String(calM - 1).padStart(2, "0")}`;
  const nextMonth = calM === 12 ? `${calY + 1}-01` : `${calY}-${String(calM + 1).padStart(2, "0")}`;
  const monthViewHtml = `
    <div class="card" style="margin-bottom:14px">
      <div class="row" style="margin-bottom:12px">
        <a class="btn sm" href="/schedule?view=month&month=${prevMonth}">&larr;</a>
        <div style="font-weight:900;font-size:16px;margin:0 12px">${calY}年${calM}月</div>
        <a class="btn sm" href="/schedule?view=month&month=${nextMonth}">&rarr;</a>
        <span class="spacer"></span>
        <a class="btn sm" href="/schedule?view=month">本月</a>
      </div>
      <div class="cal-grid">
        <div class="cal-head">日</div><div class="cal-head">一</div><div class="cal-head">二</div><div class="cal-head">三</div><div class="cal-head">四</div><div class="cal-head">五</div><div class="cal-head">六</div>
        ${calCells}
      </div>
    </div>`;

  // 面试官头像 map (日程页面)
  const calAvatarMap = {};
  d.users.forEach(u => { if (u.name) calAvatarMap[u.name] = { avatar: u.avatar || "" }; });
  function calIvAvatars(ivStr) {
    if (!ivStr || ivStr === "-") return '-';
    const names = ivStr.split(/[\/,]/).map(n => n.trim()).filter(Boolean);
    const colors = ["#7c5cfc","#3370ff","#f5222d","#fa8c16","#52c41a","#4e7bf6"];
    return names.map(n => {
      const u = calAvatarMap[n];
      const ci = n.charCodeAt(0) % colors.length;
      const av = u && u.avatar
        ? `<img src="${escapeHtml(u.avatar)}" style="width:20px;height:20px;border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:3px">`
        : `<span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:${colors[ci]};color:#fff;font-size:9px;font-weight:700;vertical-align:middle;margin-right:3px">${escapeHtml(n.slice(0, 1))}</span>`;
      return av + `<span style="vertical-align:middle">${escapeHtml(n)}</span>`;
    }).join('<span style="margin:0 4px;color:#ccc">|</span>');
  }

  // ====== 列表视图 ======
  const renderScheduleRow = (s) => {
    const c = candMap.get(s.candidateId);
    const candName = c ? escapeHtml(c.name) : "未知候选人";
    const jobTitle = c ? escapeHtml(c.jobTitle || "-") : "-";
    const review = reviewSet.has(s.candidateId + ":" + s.round) ? (d.interviews || []).find(x => x.candidateId === s.candidateId && x.round === s.round) : null;
    const reviewBadge = review ? `<span class="badge status-green">${escapeHtml(review.rating || "已评")}</span>` : '<span class="badge status-gray">待评</span>';
    const statusBadge = c ? `<span class="badge">${escapeHtml(c.status || "待筛选")}</span>` : "";
    return `<tr>
      <td><strong>${candName}</strong><br><span class="muted">${jobTitle}</span></td>
      <td>第${s.round}轮</td>
      <td>${escapeHtml(s.scheduledAt)}</td>
      <td>${calIvAvatars(s.interviewers)}</td>
      <td>${escapeHtml(s.location || s.link || "-")}</td>
      <td>${statusBadge} ${reviewBadge}</td>
      <td>${c ? `<a href="/candidates/${c.id}" class="btn sm">详情</a>` : ""}</td>
    </tr>`;
  };

  const weekActive = view === "week" ? "active" : "";
  const monthActive = view === "month" ? "active" : "";
  const listActive = view === "list" ? "active" : "";

  let mainContent = '';
  if (view === "week") mainContent = weekViewHtml;
  else if (view === "month") mainContent = monthViewHtml;

  res.send(renderPage({
    title: "面试日程",
    user: req.user,
    active: "schedule",
    contentHtml: `
      <div class="row" style="margin-bottom:14px">
        <div style="font-weight:900;font-size:18px">面试日程</div>
        <span class="muted" style="margin-left:12px">${upcoming.length} 场待进行 / ${past.length} 场已完成</span>
        <span class="spacer"></span>
        <div class="seg" style="margin:0">
          <a class="${weekActive}" href="/schedule?view=week">周视图</a>
          <a class="${monthActive}" href="/schedule?view=month">月视图</a>
          <a class="${listActive}" href="/schedule?view=list">列表</a>
        </div>
      </div>
      ${mainContent}
      ${view === "list" || view === "week" ? `<div class="card">
        <div style="font-weight:700;margin-bottom:8px">即将进行的面试</div>
        <table>
          <thead><tr><th>候选人</th><th>轮次</th><th>时间</th><th>面试官</th><th>地点/链接</th><th>状态</th><th></th></tr></thead>
          <tbody>${upcoming.map(renderScheduleRow).join("") || '<tr><td colspan="7" class="muted">暂无待进行的面试</td></tr>'}</tbody>
        </table>
        <div class="divider"></div>
        <div style="font-weight:700;margin-bottom:8px">已完成的面试</div>
        <table>
          <thead><tr><th>候选人</th><th>轮次</th><th>时间</th><th>面试官</th><th>地点/链接</th><th>状态</th><th></th></tr></thead>
          <tbody>${past.map(renderScheduleRow).join("") || '<tr><td colspan="7" class="muted">暂无已完成的面试</td></tr>'}</tbody>
        </table>
      </div>` : ''}
    `,
  }));
});

// ====== API: 获取面试官列表（通讯录用户） ======
router.get("/api/interviewers", requireLogin, async (req, res) => {
  const d = await loadTables("interviewSchedules", "candidates", "jobs", "interviews", "users");
  const interviewers = d.users
    .filter(u => u.name && u.openId)
    .map(u => ({ id: u.id, name: u.name, openId: u.openId, avatar: u.avatar || "", department: u.department || "", jobTitle: u.jobTitle || "" }));
  res.json(interviewers);
});

// ====== API: 搜索飞书通讯录用户 ======
router.get("/api/feishu/search-users", requireLogin, async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json([]);
  if (!feishuEnabled()) {
    // 飞书未启用，回退到本地用户列表
    const d = await loadTables("interviewSchedules", "candidates", "jobs", "interviews", "users");
    const results = d.users.filter(u => u.name && u.openId && u.name.includes(q)).map(u => ({ name: u.name, openId: u.openId, avatar: u.avatar || "", department: u.department || "", jobTitle: u.jobTitle || "" }));
    return res.json(results);
  }
  // 优先用搜索API
  const results = await searchFeishuUsers(q);
  if (results !== null) return res.json(results);
  // 搜索API不可用，回退：全量获取+本地过滤
  try {
    const all = await getAllFeishuEmployees();
    const filtered = all.filter(u => u.name && (u.name.includes(q) || (u.jobTitle || "").includes(q))).slice(0, 20).map(u => ({ name: u.name, openId: u.openId, avatar: u.avatar || "", department: "", jobTitle: u.jobTitle || "" }));
    res.json(filtered);
  } catch (e) {
    console.error("[搜索用户] 异常:", e.message);
    res.json([]);
  }
});

export default router;
