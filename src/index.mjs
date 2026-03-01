import "dotenv/config";

// 设置系统时区为北京时间
process.env.TZ = "Asia/Shanghai";

import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { renderPage, escapeHtml, statusBadge, followupBadge, offerStatusBadge, tagBadge } from "./ui.mjs";
import { getSupabaseAdmin, getBucketName, getSignedUrlExpiresIn, supabaseEnabled } from "./supabase.mjs";
import { loadData, saveData, ensureDataShape, nowIso, rid, deleteFromSupabase, deleteCandidateRelated, toBjTime } from "./db.mjs";
import { sessionMiddleware, registerAuthRoutes, requireLogin, requireAdmin } from "./auth.mjs";
import { feishuEnabled, sendFeishuMessage, createApprovalInstance, getAllFeishuEmployees, searchFeishuUsers, createFeishuCalendarEvent, createFeishuTask, getFeishuMeetingRecording } from "./feishu.mjs";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set("trust proxy", 1);
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "10mb" }));

// ====== Session 中间件 ======
app.use(sessionMiddleware());

// ====== multer（简历上传）======
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ====== uploads（回退用，serverless 环境下跳过）=====
const isServerless = !!process.env.VERCEL;
const UPLOADS_DIR = path.join(process.cwd(), "uploads");
if (!isServerless) {
  try {
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  } catch {}
  app.use("/uploads", express.static(UPLOADS_DIR));
}

// ====== 注册登录/登出路由（来自 auth.mjs）======
registerAuthRoutes(app, renderPage);

// ====== 临时调试接口（排查后删除）======
app.get("/debug/session", requireLogin, async (req, res) => {
  const d = await loadData();
  const sessionUser = req.session.user;
  const matchedUser = d.users.find(u => u.openId && u.openId === sessionUser.openId)
    || d.users.find(u => u.name === sessionUser.name);
  res.json({
    session: sessionUser,
    matchedUser: matchedUser || null,
    allUsers: d.users.map(u => ({ id: u.id, name: u.name, openId: u.openId, role: u.role, provider: u.provider })),
  });
});

// ====== 常量 ======
const STATUS_COLS = [
  { key: "待筛选", name: "待筛选" },
  { key: "简历初筛", name: "简历初筛" },
  { key: "待一面", name: "待一面" },
  { key: "一面通过", name: "一面通过" },
  { key: "待二面", name: "待二面" },
  { key: "二面通过", name: "二面通过" },
  { key: "待三面", name: "待三面" },
  { key: "三面通过", name: "三面通过" },
  { key: "待四面", name: "待四面" },
  { key: "四面通过", name: "四面通过" },
  { key: "待五面", name: "待五面" },
  { key: "五面通过", name: "五面通过" },
  { key: "待发offer", name: "待发offer" },
  { key: "Offer发放", name: "Offer发放" },
  { key: "入职", name: "入职" },
  { key: "淘汰", name: "淘汰" },
];
const STATUS_SET = new Set(STATUS_COLS.map((x) => x.key));
const INTERVIEW_ROUNDS = [1, 2, 3, 4, 5];
const INTERVIEW_RATING = ["S", "A", "B+", "B", "B-", "C"];
const INTERVIEW_STATUS = STATUS_COLS.map((x) => x.key);
const NEXT_ACTIONS = ["待联系", "约一面", "等面试反馈", "安排下一轮面试", "约二面", "约三面", "谈薪", "准备Offer", "发Offer", "等入职", "已结束", "其他"];
const JOB_CATEGORIES = ["技术", "产品", "设计", "运营", "市场", "销售", "人力", "财务", "行政", "其他"];
const OFFER_STATUSES = ["待发放", "已发放", "已接受", "已拒绝", "已撤回"];
// ====== 看板流水线阶段（精简版） ======
const PIPELINE_STAGES = [
  { key: "screening", name: "简历筛选", icon: "📋", color: "#8f959e", statuses: ["待筛选", "简历初筛"] },
  { key: "interview", name: "面试中", icon: "💬", color: "#3370ff", statuses: ["待一面", "一面通过", "待二面", "二面通过", "待三面", "三面通过", "待四面", "四面通过", "待五面", "五面通过"] },
  { key: "offer", name: "待发Offer", icon: "📝", color: "#ff7d00", statuses: ["待发offer"] },
  { key: "offered", name: "Offer已发", icon: "📨", color: "#7b61ff", statuses: ["Offer发放"] },
  { key: "hired", name: "已入职", icon: "✅", color: "#34c724", statuses: ["入职"] },
  { key: "rejected", name: "淘汰", icon: "❌", color: "#f54a45", statuses: ["淘汰"] },
];

function pushEvent(d, { candidateId, type, message, actor }) {
  d.events.unshift({
    id: rid("ev"),
    candidateId,
    type,
    message,
    actor: actor || "系统",
    createdAt: nowIso(),
  });
}

// ====== 新增候选人通知HR ======
async function notifyHrNewCandidate(d, candidate, job) {
  if (!feishuEnabled()) { console.log("[Notify] 飞书未启用，跳过通知"); return; }
  try {
    const baseUrl = process.env.BASE_URL || "https://recruit-platform-sable.vercel.app";
    const candidateUrl = baseUrl + "/candidates/" + candidate.id;

    const msg = `**新候选人投递通知**\n\n` +
      `**候选人**：${candidate.name}\n` +
      `**投递岗位**：${job?.title || candidate.jobTitle || "-"}\n` +
      `**推荐来源**：${candidate.source || "直接投递"}\n` +
      `**联系方式**：${candidate.phone || "-"}\n\n` +
      `[查看候选人详情](${candidateUrl})`;

    // 优先通知岗位负责人，如果没有则通知所有管理员
    let notifyIds = [];
    if (job?.ownerOpenId) {
      notifyIds.push(job.ownerOpenId);
    } else {
      // 岗位未设负责人，通知所有管理员
      const admins = (d.users || []).filter(u => u.role === "admin" && u.openId);
      notifyIds = admins.map(u => u.openId);
      console.log("[Notify] 岗位无负责人，通知管理员:", admins.map(u => u.name).join(","));
    }
    if (!notifyIds.length) { console.log("[Notify] 无可通知对象，跳过"); return; }

    for (const openId of notifyIds) {
      await sendFeishuMessage(openId, msg, "新候选人通知");
      console.log("[Notify] 已通知(" + openId + ") 新候选人: " + candidate.name + " 岗位: " + (job?.title || "-"));
    }
  } catch (e) {
    console.warn("[Notify] 通知HR失败:", e.message);
  }
}

// ====== 权限控制：按岗位负责人过滤 ======
// 返回当前用户可见的岗位 ID Set，admin 返回 null（不过滤）
function getVisibleJobIds(user, jobs) {
  if (!user) return new Set();
  if (user.role === "admin") return null; // null = 不过滤，全部可见
  const openId = user.openId || "";
  const name = user.name || "";
  const ids = new Set();
  for (const j of jobs) {
    if ((openId && j.ownerOpenId === openId) || (!j.ownerOpenId && name && j.owner === name)) {
      ids.add(j.id);
    }
  }
  return ids;
}
function filterCandidatesByPermission(candidates, visibleJobIds) {
  if (visibleJobIds === null) return candidates; // admin
  return candidates.filter(c => visibleJobIds.has(c.jobId));
}

// ====== 候选人查重：姓名+手机号完全匹配 ======
function findDuplicate(candidates, name, phone) {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  const p = (phone || "").trim();
  // 如果有手机号，姓名+手机号同时匹配才算重复；如果没手机号，仅姓名匹配
  if (p) {
    return candidates.find(c => c.name && c.name.trim().toLowerCase() === n && c.phone && c.phone.trim() === p) || null;
  }
  return null; // 没有手机号时不做查重，避免误判
}

function safeExtFromName(name) {
  const base = String(name || "");
  const i = base.lastIndexOf(".");
  if (i === -1) return "";
  const ext = base.slice(i).toLowerCase();
  if (!/^\.[a-z0-9]{1,8}$/.test(ext)) return "";
  return ext;
}

// ====== 简历存储 ======
async function saveResumeSupabaseOrLocal(d, candidateId, file, actorName) {
  const origName = file.originalname || file.filename || "";
  const mimeType = file.mimetype || file.contentType || "";
  const ext = safeExtFromName(origName) || ".pdf";
  const objectName = candidateId + "/" + rid("resume") + ext;

  try {
    const supabase = getSupabaseAdmin();
    const bucket = getBucketName();
    if (!supabase || !bucket) throw new Error("supabase_disabled");

    const { error: upErr } = await supabase.storage.from(bucket).upload(objectName, file.buffer, {
      contentType: mimeType || undefined,
      upsert: false,
    });
    if (upErr) throw new Error(upErr.message || "upload_failed");

    const { data: signed, error: signErr } = await supabase.storage
      .from(bucket)
      .createSignedUrl(objectName, getSignedUrlExpiresIn());

    if (signErr || !signed?.signedUrl) throw new Error(signErr?.message || "signed_url_failed");

    const meta = {
      id: rid("rf"),
      candidateId,
      filename: objectName,
      originalName: origName || objectName,
      contentType: mimeType,
      size: file.buffer.length,
      uploadedAt: nowIso(),
      storage: "supabase",
      bucket,
      url: signed.signedUrl,
    };
    d.resumeFiles.push(meta);
    pushEvent(d, { candidateId, type: "简历", message: "上传简历（Supabase）：" + meta.originalName, actor: actorName || "系统" });
    return meta;
  } catch (e) {
    // serverless 环境下无法写本地文件，直接抛错
    if (isServerless) {
      throw new Error("简历上传失败（Supabase）：" + String(e?.message || e));
    }

    const saveName = rid("resume") + ext;
    const savePath = path.join(UPLOADS_DIR, saveName);
    fs.writeFileSync(savePath, file.buffer);

    const meta = {
      id: rid("rf"),
      candidateId,
      filename: saveName,
      originalName: origName || saveName,
      contentType: mimeType,
      size: file.buffer.length,
      uploadedAt: nowIso(),
      storage: "local",
      url: "/uploads/" + encodeURIComponent(saveName),
      fallbackReason: String(e?.message || e || "unknown"),
    };
    d.resumeFiles.push(meta);
    pushEvent(d, { candidateId, type: "简历", message: "上传简历（本地回退）：" + meta.originalName + "\n原因：" + meta.fallbackReason, actor: actorName || "系统" });
    return meta;
  }
}

async function refreshResumeUrlIfNeeded(resumeMeta) {
  if (!resumeMeta) return null;
  if (resumeMeta.storage !== "supabase") return resumeMeta;
  try {
    const supabase = getSupabaseAdmin();
    const bucket = resumeMeta.bucket || getBucketName();
    if (!supabase || !bucket) return resumeMeta;
    const { data: signed, error: signErr } = await supabase.storage
      .from(bucket)
      .createSignedUrl(resumeMeta.filename, getSignedUrlExpiresIn());
    if (signErr || !signed?.signedUrl) return resumeMeta;
    return { ...resumeMeta, url: signed.signedUrl };
  } catch {
    return resumeMeta;
  }
}

// ====== 工具条 ======
function toolbarHtml({ jobs, sources, q = "", jobId = "", source = "", mode = "list", isAdmin = false }) {
  const jobOpts = ['<option value="">全部岗位</option>']
    .concat(jobs.map((j) => '<option value="' + escapeHtml(j.id) + '" ' + (j.id === jobId ? "selected" : "") + '>' + escapeHtml(j.title || j.id) + '</option>'))
    .join("");
  const srcOpts = ['<option value="">全部来源</option>']
    .concat(sources.map((s) => '<option value="' + escapeHtml(s) + '" ' + (s === source ? "selected" : "") + '>' + escapeHtml(s) + '</option>'))
    .join("");

  const targetPath = mode === "board" ? "/candidates/board" : "/candidates";

  const adminBtns = '<a class="btn" href="/candidates/new">新建候选人</a>' +
      '<a class="btn" href="/candidates/import">批量导入</a>';

  return '<div class="toolbar">' +
    '<div class="ctl"><label>搜索</label><input id="q" value="' + escapeHtml(q) + '" placeholder="姓名 / 手机 / 备注关键词" /></div>' +
    '<div class="ctl"><label>岗位</label><select id="jobId">' + jobOpts + '</select></div>' +
    '<div class="ctl"><label>来源</label><select id="source">' + srcOpts + '</select></div>' +
    '<button class="btn primary" onclick="applyFilters()">筛选</button>' +
    '<span class="spacer"></span>' +
    adminBtns +
    '</div>' +
    '<script>function applyFilters(){var q=document.getElementById("q").value||"";var jobId=document.getElementById("jobId").value||"";var source=document.getElementById("source").value||"";var u=new URL(location.href);u.pathname="' + targetPath + '";if(q)u.searchParams.set("q",q);else u.searchParams.delete("q");if(jobId)u.searchParams.set("jobId",jobId);else u.searchParams.delete("jobId");if(source)u.searchParams.set("source",source);else u.searchParams.delete("source");location.href=u.toString()}</script>';
}

// ====== 概览 Dashboard（增强版）======
app.get("/", requireLogin, async (req, res) => {
  const d = await loadData();
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

  // 待面评提醒：已过面试时间但还未提交面评的记录
  const pastSchedules = allSchedules.filter(s => {
    const dt = (s.scheduledAt || "").slice(0, 10);
    return dt && dt <= todayStr;
  });
  const pendingReviewItems = [];
  for (const s of pastSchedules) {
    const hasReview = d.interviews.some(rv => rv.candidateId === s.candidateId && rv.round === s.round);
    if (!hasReview) {
      const cand = candMap.get(s.candidateId);
      if (cand) pendingReviewItems.push({ schedule: s, cand });
    }
  }
  const pendingReviewHtml = pendingReviewItems.length ? pendingReviewItems.slice(0, 8).map(({ schedule: s, cand }) => {
    return '<div class="remind-item"><span class="badge status-orange" style="font-size:11px">待面评</span><a href="/candidates/' + escapeHtml(cand.id) + '" style="color:var(--primary);font-weight:700">' + escapeHtml(cand.name || "未命名") + '</a><span class="muted" style="font-size:12px">第' + (s.round || 1) + '轮 · ' + escapeHtml((s.scheduledAt || "").slice(0, 10)) + '</span></div>';
  }).join("") : '<div class="muted" style="font-size:13px">暂无待面评记录</div>';

  // 即将逾期的跟进事项
  const overdueFollowItems = d.candidates.filter(c => {
    if (!c.follow || !c.follow.followAt) return false;
    return c.follow.followAt <= todayStr && c.follow.nextAction && c.follow.nextAction !== "已结束";
  }).slice(0, 8);
  const overdueFollowHtml = overdueFollowItems.length ? overdueFollowItems.map(c => {
    return '<div class="remind-item"><span class="badge status-red" style="font-size:11px">逾期</span><a href="/candidates/' + escapeHtml(c.id) + '" style="color:var(--primary);font-weight:700">' + escapeHtml(c.name || "未命名") + '</a><span class="muted" style="font-size:12px">' + escapeHtml(c.follow.nextAction || "") + ' · ' + escapeHtml(c.follow.followAt || "") + '</span></div>';
  }).join("") : '<div class="muted" style="font-size:13px">暂无逾期跟进</div>';

  // 面试提醒卡片
  const remindCardHtml = '<div class="card reminder-card"><div style="font-weight:900;margin-bottom:12px">📋 面试提醒</div>' +
    '<div class="remind-section"><div class="remind-title">今日面试 <span class="badge status-blue" style="font-size:11px">' + todaySchedules.length + '</span></div>' + todayDetailHtml + '</div>' +
    '<div class="divider"></div>' +
    '<div class="remind-section"><div class="remind-title">待面评 <span class="badge status-orange" style="font-size:11px">' + pendingReviewItems.length + '</span></div>' + pendingReviewHtml + '</div>' +
    '<div class="divider"></div>' +
    '<div class="remind-section"><div class="remind-title">逾期跟进 <span class="badge status-red" style="font-size:11px">' + overdueFollowItems.length + '</span></div>' + overdueFollowHtml + '</div>' +
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

// ====== 职位管理 ======
function jobFunnelStats(d, jobId) {
  const list = d.candidates.filter((c) => c.jobId === jobId);
  const stat = { total: list.length, "待筛选": 0, "面试中": 0, "Offer发放": 0, "入职": 0, "淘汰": 0 };
  for (const c of list) {
    const s = STATUS_SET.has(c.status) ? c.status : "待筛选";
    if (s === "待筛选") stat["待筛选"]++;
    else if (s === "Offer发放") stat["Offer发放"]++;
    else if (s === "入职") stat["入职"]++;
    else if (s === "淘汰") stat["淘汰"]++;
    else stat["面试中"]++;
  }
  return stat;
}

app.get("/jobs", requireLogin, async (req, res) => {
  const d = await loadData();
  const catFilter = String(req.query.category || "").trim();

  const visibleJobIds = getVisibleJobIds(req.user, d.jobs);
  const permJobs = visibleJobIds === null ? d.jobs : d.jobs.filter(j => visibleJobIds.has(j.id));
  const filteredJobs = catFilter ? permJobs.filter((j) => j.category === catFilter) : permJobs;

  const catTabs = ['<a class="' + (catFilter ? "" : "active") + '" href="/jobs">全部</a>'].concat(
    JOB_CATEGORIES.map((c) => '<a class="' + (catFilter === c ? "active" : "") + '" href="/jobs?category=' + encodeURIComponent(c) + '">' + escapeHtml(c) + '</a>')
  ).join("");

  const rows = filteredJobs
    .map((j) => {
      const title = escapeHtml(j.title || "未命名岗位");
      const id = escapeHtml(j.id);
      const dept = escapeHtml(j.department || "-");
      const hc = escapeHtml(String(j.headcount ?? "-"));
      const loc = escapeHtml(j.location || "-");
      const cat = j.category ? '<span class="badge status-blue" style="font-size:11px">' + escapeHtml(j.category) + '</span>' : '';
      const st = jobFunnelStats(d, j.id);
      const stateBadge = j.state === "open" ? '<span class="badge status-green">开放</span>' : j.state === "paused" ? '<span class="badge status-orange">暂停</span>' : '<span class="badge status-gray">关闭</span>';
      const funnel =
        '<span class="pill"><span class="muted">总</span><b>' + st.total + '</b></span>' +
        '<span class="pill"><span class="muted">面试中</span><b>' + st["面试中"] + '</b></span>' +
        '<span class="pill"><span class="muted">入职</span><b>' + st["入职"] + '</b></span>';

      return '<tr><td><a class="btn sm" href="/jobs/' + id + '">' + title + '</a> ' + cat + '</td><td>' + dept + '</td><td>' + loc + '</td><td>' + hc + '</td><td>' + stateBadge + '</td><td style="min-width:260px">' + funnel + '</td><td><a class="btn sm" href="/jobs/' + id + '">编辑</a> <a class="btn sm" href="/candidates?jobId=' + id + '">候选人</a></td></tr>';
    })
    .join("");

  res.send(
    renderPage({
      title: "职位管理",
      user: req.user,
      active: "jobs",
      contentHtml: '<div class="row"><div style="font-weight:900;font-size:18px">职位管理</div><span class="spacer"></span><a class="btn primary" href="/jobs/new">创建职位</a></div><div class="divider"></div>' +
        '<div class="seg">' + catTabs + '</div><div style="height:12px"></div>' +
        '<div class="card"><table><thead><tr><th>职位</th><th>部门</th><th>地点</th><th>HC</th><th>状态</th><th>招聘数据</th><th>操作</th></tr></thead><tbody>' + (rows || "") + '</tbody></table>' + (rows ? "" : '<div class="muted">暂无职位，先创建一个吧。</div>') + '</div>',
    })
  );
});

app.get("/jobs/new", requireLogin, async (req, res) => {
  const catOpts = JOB_CATEGORIES.map((c) => '<option value="' + escapeHtml(c) + '">' + escapeHtml(c) + '</option>').join("");
  res.send(
    renderPage({
      title: "创建职位",
      user: req.user,
      active: "jobs",
      contentHtml: '<div class="card" style="max-width:820px;margin:0 auto;"><div style="font-weight:900;font-size:18px">创建职位</div><div class="divider"></div><form method="POST" action="/jobs/new" id="jobForm"><div class="grid"><div class="card compact"><div class="field"><label>岗位名称</label><input name="title" required placeholder="例如：行业运营" /></div><div class="field"><label>部门</label><input name="department" placeholder="例如：电商交易" /></div><div class="field"><label>地点</label><input name="location" placeholder="例如：上海" /></div><div class="field"><label>负责人</label><input type="hidden" name="owner" id="ownerName" /><input type="hidden" name="ownerOpenId" id="ownerOpenId" /><div style="position:relative"><input id="ownerSearch" placeholder="搜索飞书用户..." autocomplete="off" /><div id="ownerDropdown" style="display:none;position:absolute;top:100%;left:0;right:0;background:#fff;border:1px solid #e5e7eb;border-radius:8px;max-height:200px;overflow-y:auto;z-index:50;box-shadow:0 4px 16px rgba(0,0,0,.1)"></div></div><div id="ownerSelected" style="margin-top:6px"></div></div></div><div class="card compact"><div class="field"><label>HC（招聘人数）</label><input name="headcount" type="number" min="0" placeholder="例如：2" /></div><div class="field"><label>职级</label><input name="level" placeholder="例如：P6" /></div><div class="field"><label>职位分类</label><select name="category"><option value="">请选择</option>' + catOpts + '</select></div><div class="field"><label>岗位状态</label><select name="state"><option value="open">开放</option><option value="paused">暂停</option><option value="closed">关闭</option></select></div></div></div><div class="divider"></div><div class="field"><label>JD 描述</label><textarea name="jd" rows="8" placeholder="写清职责、要求、加分项"></textarea></div><div class="row"><button class="btn primary" type="submit">创建职位</button><a class="btn" href="/jobs">返回</a></div></form></div>' +
        '<script>' +
        'var _ownerTimer=null;' +
        'function selectOwner(u){document.getElementById("ownerName").value=u.name;document.getElementById("ownerOpenId").value=u.openId;document.getElementById("ownerSearch").value="";document.getElementById("ownerDropdown").style.display="none";document.getElementById("ownerSelected").innerHTML=\'<span style="display:inline-flex;align-items:center;gap:6px;background:#f3f0ff;border:1px solid #e0d4fc;border-radius:6px;padding:4px 10px;font-size:13px"><b>\'+u.name+\'</b><span style="color:#9ca3af;font-size:11px">\'+(u.department||"")+\'</span><span onclick="clearOwner()" style="cursor:pointer;color:#999;margin-left:4px">✕</span></span>\'}' +
        'function clearOwner(){document.getElementById("ownerName").value="";document.getElementById("ownerOpenId").value="";document.getElementById("ownerSelected").innerHTML=""}' +
        'function renderOwnerDropdown(list){if(!list.length){document.getElementById("ownerDropdown").style.display="none";return}document.getElementById("ownerDropdown").innerHTML=list.map(function(u){return \'<div onclick=\\x27selectOwner(\'+JSON.stringify(u).replace(/\'/g,"\\\\x27")+\')\\x27 style="padding:8px 12px;cursor:pointer;display:flex;align-items:center;gap:8px;border-bottom:1px solid #f3f4f6" onmouseover="this.style.background=\\x27#f9fafb\\x27" onmouseout="this.style.background=\\x27#fff\\x27"><span style="font-weight:600;font-size:13px">\'+u.name+\'</span><span style="font-size:11px;color:#9ca3af">\'+(u.department||"")+\' \'+(u.jobTitle||"")+\'</span></div>\'}).join("");document.getElementById("ownerDropdown").style.display="block"}' +
        'document.getElementById("ownerSearch").addEventListener("input",function(){var q=this.value.trim();clearTimeout(_ownerTimer);if(!q){document.getElementById("ownerDropdown").style.display="none";return}document.getElementById("ownerDropdown").innerHTML=\'<div style="padding:12px;color:#9ca3af;font-size:13px">搜索中...</div>\';document.getElementById("ownerDropdown").style.display="block";_ownerTimer=setTimeout(async function(){try{var r=await fetch("/api/feishu/search-users?q="+encodeURIComponent(q));if(r.ok){var list=await r.json();renderOwnerDropdown(list)}else{document.getElementById("ownerDropdown").style.display="none"}}catch(e){document.getElementById("ownerDropdown").style.display="none"}},300)});' +
        'document.addEventListener("click",function(e){if(!e.target.closest("#ownerSearch")&&!e.target.closest("#ownerDropdown"))document.getElementById("ownerDropdown").style.display="none"});' +
        '</script>',
    })
  );
});

app.post("/jobs/new", requireLogin, async (req, res) => {
  const d = await loadData();
  const job = {
    id: rid("job"),
    title: String(req.body.title || "").trim(),
    department: String(req.body.department || "").trim(),
    location: String(req.body.location || "").trim(),
    owner: String(req.body.owner || "").trim(),
    ownerOpenId: String(req.body.ownerOpenId || "").trim(),
    headcount: req.body.headcount === "" ? null : Number(req.body.headcount || 0),
    level: String(req.body.level || "").trim(),
    category: String(req.body.category || "").trim(),
    state: String(req.body.state || "open"),
    jd: String(req.body.jd || "").trim(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  d.jobs.unshift(job);
  await saveData(d);
  res.redirect(303, "/jobs/" + job.id);
});

app.get("/jobs/:id", requireLogin, async (req, res) => {
  const d = await loadData();
  const job = d.jobs.find((x) => x.id === req.params.id);
  if (!job) {
    return res.send(renderPage({ title: "岗位不存在", user: req.user, active: "jobs", contentHtml: '<div class="card"><div style="font-weight:900">岗位不存在</div><div class="divider"></div><a class="btn" href="/jobs">返回</a></div>' }));
  }
  // 权限检查：member 只能查看自己负责的岗位
  const visibleJobIds = getVisibleJobIds(req.user, d.jobs);
  if (visibleJobIds !== null && !visibleJobIds.has(job.id)) {
    return res.send(renderPage({ title: "无权限", user: req.user, active: "jobs", contentHtml: '<div class="card"><div style="font-weight:900">无权限查看该岗位</div><div class="muted">该岗位不在您的负责范围内</div><div class="divider"></div><a class="btn" href="/jobs">返回</a></div>' }));
  }

  const catOpts = JOB_CATEGORIES.map((c) => '<option value="' + escapeHtml(c) + '" ' + (job.category === c ? "selected" : "") + '>' + escapeHtml(c) + '</option>').join("");
  const st = jobFunnelStats(d, job.id);
  const funnel = '<span class="pill"><span class="muted">总</span><b>' + st.total + '</b></span><span class="pill"><span class="muted">待筛选</span><b>' + st["待筛选"] + '</b></span><span class="pill"><span class="muted">面试中</span><b>' + st["面试中"] + '</b></span><span class="pill"><span class="muted">Offer</span><b>' + st["Offer发放"] + '</b></span><span class="pill"><span class="muted">入职</span><b>' + st["入职"] + '</b></span><span class="pill"><span class="muted">淘汰</span><b>' + st["淘汰"] + '</b></span>';

  const isAdmin = req.user?.role === "admin";
  const deleteBtn = isAdmin
    ? '<form method="POST" action="/jobs/' + escapeHtml(job.id) + '/delete" style="display:inline" onsubmit="return confirm(\'确定删除此职位？\')"><button class="btn danger sm" type="submit">删除职位</button></form>'
    : '';

  const ownerInitJs = (job.owner || job.ownerOpenId) ? 'selectOwner({name:"' + escapeHtml(job.owner || "") + '",openId:"' + escapeHtml(job.ownerOpenId || "") + '",department:""})' : '';
  const jobBodyHtml = '<div class="card" style="max-width:980px;margin:0 auto;"><div class="muted">填写 & 修改岗位信息</div><div class="divider"></div><form method="POST" action="/jobs/' + escapeHtml(job.id) + '" id="jobForm"><div class="grid"><div class="card compact"><div class="field"><label>岗位名称</label><input name="title" value="' + escapeHtml(job.title || "") + '" /></div><div class="field"><label>部门</label><input name="department" value="' + escapeHtml(job.department || "") + '" /></div><div class="field"><label>地点</label><input name="location" value="' + escapeHtml(job.location || "") + '" /></div><div class="field"><label>负责人</label><input type="hidden" name="owner" id="ownerName" /><input type="hidden" name="ownerOpenId" id="ownerOpenId" /><div style="position:relative"><input id="ownerSearch" placeholder="搜索飞书用户..." autocomplete="off" /><div id="ownerDropdown" style="display:none;position:absolute;top:100%;left:0;right:0;background:#fff;border:1px solid #e5e7eb;border-radius:8px;max-height:200px;overflow-y:auto;z-index:50;box-shadow:0 4px 16px rgba(0,0,0,.1)"></div></div><div id="ownerSelected" style="margin-top:6px"></div></div></div><div class="card compact"><div class="field"><label>HC（招聘人数）</label><input name="headcount" type="number" min="0" value="' + escapeHtml(job.headcount ?? "") + '" /></div><div class="field"><label>职级</label><input name="level" value="' + escapeHtml(job.level || "") + '" /></div><div class="field"><label>职位分类</label><select name="category"><option value="">请选择</option>' + catOpts + '</select></div><div class="field"><label>岗位状态</label><select name="state"><option value="open" ' + (job.state === "open" ? "selected" : "") + '>开放</option><option value="paused" ' + (job.state === "paused" ? "selected" : "") + '>暂停</option><option value="closed" ' + (job.state === "closed" ? "selected" : "") + '>关闭</option></select></div></div></div><div class="divider"></div><div class="field"><label>JD 描述</label><textarea name="jd" rows="10">' + escapeHtml(job.jd || "") + '</textarea></div><div class="row"><button class="btn primary" type="submit">保存岗位信息</button><a class="btn" href="/jobs">返回列表</a></div></form></div>' +
    '<script>' +
    'var _ownerTimer=null;' +
    'function selectOwner(u){document.getElementById("ownerName").value=u.name;document.getElementById("ownerOpenId").value=u.openId;document.getElementById("ownerSearch").value="";document.getElementById("ownerDropdown").style.display="none";document.getElementById("ownerSelected").innerHTML=\'<span style="display:inline-flex;align-items:center;gap:6px;background:#f3f0ff;border:1px solid #e0d4fc;border-radius:6px;padding:4px 10px;font-size:13px"><b>\'+u.name+\'</b><span style="color:#9ca3af;font-size:11px">\'+(u.department||"")+\'</span><span onclick="clearOwner()" style="cursor:pointer;color:#999;margin-left:4px">✕</span></span>\'}' +
    'function clearOwner(){document.getElementById("ownerName").value="";document.getElementById("ownerOpenId").value="";document.getElementById("ownerSelected").innerHTML=""}' +
    'function renderOwnerDropdown(list){if(!list.length){document.getElementById("ownerDropdown").innerHTML=\'<div style="padding:12px;color:#9ca3af;font-size:13px">未找到用户</div>\';document.getElementById("ownerDropdown").style.display="block";return}document.getElementById("ownerDropdown").innerHTML=list.map(function(u){return \'<div onclick=\\x27selectOwner(\'+JSON.stringify(u).replace(/\'/g,"\\\\x27")+\')\\x27 style="padding:8px 12px;cursor:pointer;display:flex;align-items:center;gap:8px;border-bottom:1px solid #f3f4f6" onmouseover="this.style.background=\\x27#f9fafb\\x27" onmouseout="this.style.background=\\x27#fff\\x27"><span style="font-weight:600;font-size:13px">\'+u.name+\'</span><span style="font-size:11px;color:#9ca3af">\'+(u.department||"")+\' \'+(u.jobTitle||"")+\'</span></div>\'}).join("");document.getElementById("ownerDropdown").style.display="block"}' +
    'document.getElementById("ownerSearch").addEventListener("input",function(){var q=this.value.trim();clearTimeout(_ownerTimer);if(!q){document.getElementById("ownerDropdown").style.display="none";return}document.getElementById("ownerDropdown").innerHTML=\'<div style="padding:12px;color:#9ca3af;font-size:13px">搜索中...</div>\';document.getElementById("ownerDropdown").style.display="block";_ownerTimer=setTimeout(async function(){try{var r=await fetch("/api/feishu/search-users?q="+encodeURIComponent(q));if(r.ok){var list=await r.json();renderOwnerDropdown(list)}else{document.getElementById("ownerDropdown").style.display="none"}}catch(e){document.getElementById("ownerDropdown").style.display="none"}},300)});' +
    'document.addEventListener("click",function(e){if(!e.target.closest("#ownerSearch")&&!e.target.closest("#ownerDropdown"))document.getElementById("ownerDropdown").style.display="none"});' +
    (ownerInitJs ? ownerInitJs + ';' : '') +
    '</script>';

  res.send(
    renderPage({
      title: job.title || "岗位详情",
      user: req.user,
      active: "jobs",
      contentHtml: '<div class="row"><div style="font-weight:900;font-size:18px">' + escapeHtml(job.title || "岗位详情") + '</div><span class="spacer"></span><a class="btn" href="/candidates?jobId=' + escapeHtml(job.id) + '">该岗位候选人</a>' + deleteBtn + '</div><div class="divider"></div>' +
        '<div class="card"><div class="row"><div style="font-weight:900">招聘数据</div><span class="spacer"></span>' + funnel + '</div></div><div style="height:12px"></div>' +
        jobBodyHtml,
    })
  );
});

app.post("/jobs/:id", requireLogin, async (req, res) => {
  const d = await loadData();
  const job = d.jobs.find((x) => x.id === req.params.id);
  if (!job) return res.redirect(303, "/jobs");
  job.title = String(req.body.title || "").trim();
  job.department = String(req.body.department || "").trim();
  job.location = String(req.body.location || "").trim();
  job.owner = String(req.body.owner || "").trim();
  job.ownerOpenId = String(req.body.ownerOpenId || "").trim();
  job.headcount = req.body.headcount === "" ? null : Number(req.body.headcount || 0);
  job.level = String(req.body.level || "").trim();
  job.category = String(req.body.category || "").trim();
  job.state = String(req.body.state || "open");
  job.jd = String(req.body.jd || "").trim();
  job.updatedAt = nowIso();
  await saveData(d);
  res.redirect(303, "/jobs/" + job.id);
});

// 删除职位
app.post("/jobs/:id/delete", requireLogin, requireAdmin, async (req, res) => {
  const d = await loadData();
  const idx = d.jobs.findIndex((x) => x.id === req.params.id);
  if (idx > -1) {
    d.jobs.splice(idx, 1);
    await deleteFromSupabase("jobs", req.params.id);
    await saveData(d);
  }
  res.redirect(303, "/jobs");
});

// ====== 新建候选人 ======
app.get("/candidates/new", requireLogin, async (req, res) => {
  const d = await loadData();
  const jobOpts = d.jobs.map((j) => '<option value="' + escapeHtml(j.id) + '">' + escapeHtml(j.title || j.id) + '</option>').join("");
  const srcOpts = (d.sources || []).map((s) => '<option value="' + escapeHtml(s) + '">' + escapeHtml(s) + '</option>').join("");
  const tagCheckboxes = (d.tags || []).map((t) => '<label style="display:inline-flex;align-items:center;gap:4px;margin-right:12px;cursor:pointer"><input type="checkbox" name="tags" value="' + escapeHtml(t) + '" style="width:auto" /> ' + escapeHtml(t) + '</label>').join("");

  res.send(
    renderPage({
      title: "新建候选人",
      user: req.user,
      active: "candidates",
      contentHtml: '<div class="card" style="max-width:860px;margin:0 auto;"><div style="font-weight:900;font-size:18px">新建候选人</div><div class="divider"></div><form id="newCandForm"><div class="grid"><div class="card compact"><div class="field"><label>姓名</label><input name="name" id="ncName" required /></div><div class="field"><label>手机</label><input name="phone" id="ncPhone" /></div><div class="field"><label>邮箱</label><input name="email" id="ncEmail" type="email" placeholder="example@company.com" /></div><div class="field"><label>岗位</label><select name="jobId" id="ncJobId" required>' + (jobOpts || '<option value="">请先创建职位</option>') + '</select></div><div class="field"><label>简历（可选）</label><input type="file" id="ncResume" accept=".pdf,.png,.jpg,.jpeg,.webp" /><div class="muted">支持 PDF / 图片，直传云端，不受大小限制</div></div></div><div class="card compact"><div class="field"><label>来源</label><select name="source" id="ncSource">' + srcOpts + '</select></div><div class="field"><label>标签</label><div id="ncTags">' + (tagCheckboxes || '<span class="muted">暂无标签，可在设置中添加</span>') + '</div></div><div class="field"><label>备注</label><textarea name="note" id="ncNote" rows="7"></textarea></div></div></div><div class="divider"></div><div class="row"><button class="btn primary" type="submit" id="ncSubmitBtn">创建候选人</button><a class="btn" href="/candidates">返回</a></div></form></div>' +
        '<script>' +
        'document.getElementById("newCandForm").onsubmit=async function(e){e.preventDefault();' +
        'var btn=document.getElementById("ncSubmitBtn");btn.textContent="创建中...";btn.disabled=true;' +
        'try{' +
        'var tags=[];document.querySelectorAll("#ncTags input[type=checkbox]:checked").forEach(function(cb){tags.push(cb.value)});' +
        'var payload={name:document.getElementById("ncName").value,phone:document.getElementById("ncPhone").value,email:document.getElementById("ncEmail").value,jobId:document.getElementById("ncJobId").value,source:document.getElementById("ncSource").value,note:document.getElementById("ncNote").value,tags:tags};' +
        'var r=await fetch("/api/candidates/create",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});' +
        'var data=await r.json();' +
        'if(r.status===409&&data.duplicate){' +
        'var d=data.duplicate;if(confirm("候选人疑似重复！\\n\\n已有候选人："+d.name+"\\n手机："+d.phone+"\\n岗位："+d.jobTitle+"\\n状态："+d.status+"\\n\\n点击【确定】查看已有候选人，点击【取消】返回修改")){location.href="/candidates/"+d.id;return}btn.textContent="创建候选人";btn.disabled=false;return}' +
        'if(!r.ok)throw new Error(data.error||"创建失败");' +
        'var cid=data.candidateId;' +
        'var fileInput=document.getElementById("ncResume");var file=fileInput&&fileInput.files[0];' +
        'if(file){btn.textContent="上传简历中...";' +
        'var signRes=await fetch("/api/resume/upload-url",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({candidateId:cid,fileName:file.name,contentType:file.type||"application/octet-stream"})});' +
        'var signData=await signRes.json();' +
        'if(signRes.ok&&signData.signedUrl){' +
        'var upRes=await fetch(signData.signedUrl,{method:"PUT",headers:{"Content-Type":file.type||"application/octet-stream"},body:file});' +
        'if(upRes.ok){await fetch("/api/candidates/"+cid+"/resume-meta",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({objectName:signData.objectName,originalName:file.name,contentType:file.type||"",size:file.size,bucket:signData.bucket})})}' +
        '}}' +
        'location.href="/candidates/"+cid;' +
        '}catch(err){alert(err.message);btn.textContent="创建候选人";btn.disabled=false}}' +
        '</script>',
    })
  );
});

// API：JSON 创建候选人（前端 JS 调用，不含文件）
app.post("/api/candidates/create", requireLogin, async (req, res) => {
  try {
    const d = await loadData();
    const name = String(req.body.name || "").trim();
    const phone = String(req.body.phone || "").trim();
    const email = String(req.body.email || "").trim();
    const jobId = String(req.body.jobId || "").trim();
    const source = String(req.body.source || "").trim();
    const note = String(req.body.note || "").trim();
    let tags = req.body.tags || [];
    if (typeof tags === "string") tags = [tags];
    tags = tags.filter(Boolean);

    if (!name) return res.status(400).json({ error: "姓名不能为空" });
    if (!jobId) return res.status(400).json({ error: "请选择岗位" });

    // 查重：姓名+手机号完全匹配
    const dupCandidate = findDuplicate(d.candidates, name, phone);
    if (dupCandidate) {
      return res.status(409).json({ error: "候选人疑似重复", duplicate: { id: dupCandidate.id, name: dupCandidate.name, phone: dupCandidate.phone, jobTitle: dupCandidate.jobTitle || "-", status: dupCandidate.status } });
    }

    const job = d.jobs.find((x) => x.id === jobId);
    const c = {
      id: rid("c"), name, phone, email, jobId,
      jobTitle: job ? job.title : jobId, source, note, tags,
      status: "待筛选",
      follow: { nextAction: "待联系", followAt: "", note: "" },
      createdAt: nowIso(), updatedAt: nowIso(),
    };
    d.candidates.unshift(c);
    if (c.source && !d.sources.includes(c.source)) d.sources.push(c.source);
    pushEvent(d, { candidateId: c.id, type: "创建", message: "创建候选人：" + (c.name || "-") + "（岗位：" + (c.jobTitle || "-") + "）", actor: req.user?.name || "系统" });
    await saveData(d);
    await notifyHrNewCandidate(d, c, job).catch(e => console.warn("[Notify] err:", e.message));
    res.json({ ok: true, candidateId: c.id });
  } catch (e) {
    console.error("[Create] error:", e.message);
    res.status(500).json({ error: String(e?.message || "创建失败") });
  }
});

// 兼容旧版：form POST 创建候选人（含文件上传，本地开发用）
app.post("/candidates/new", requireLogin, upload.single("resume"), async (req, res) => {
  const d = await loadData();
  const name = String(req.body.name || "").trim();
  const phone = String(req.body.phone || "").trim();
  const email = String(req.body.email || "").trim();
  const jobId = String(req.body.jobId || "").trim();
  const source = String(req.body.source || "").trim();
  const note = String(req.body.note || "").trim();
  const file = req.file || null;

  let tags = req.body.tags || [];
  if (typeof tags === "string") tags = [tags];
  tags = tags.filter(Boolean);

  if (!name) return res.redirect(303, "/candidates/new");
  if (!jobId) return res.redirect(303, "/candidates/new");

  // 查重：姓名+手机号完全匹配
  const dupCandidate = findDuplicate(d.candidates, name, phone);
  if (dupCandidate) {
    return res.send(renderPage({
      title: "候选人疑似重复", user: req.user, active: "candidates",
      contentHtml: '<div class="card" style="max-width:600px;margin:0 auto"><div style="font-weight:900;font-size:18px;color:var(--orange,#ff7d00)">候选人疑似重复</div><div class="divider"></div>' +
        '<div class="muted" style="margin-bottom:12px">系统检测到已有相同姓名和手机号的候选人：</div>' +
        '<div class="card compact"><div><b>' + escapeHtml(dupCandidate.name) + '</b></div><div class="muted">手机：' + escapeHtml(dupCandidate.phone || '-') + '</div><div class="muted">岗位：' + escapeHtml(dupCandidate.jobTitle || '-') + '</div><div class="muted">状态：' + escapeHtml(dupCandidate.status || '-') + '</div></div>' +
        '<div class="divider"></div><div class="row"><a class="btn primary" href="/candidates/' + dupCandidate.id + '">查看已有候选人</a><a class="btn" href="/candidates/new">返回重新填写</a></div></div>',
    }));
  }

  const job = d.jobs.find((x) => x.id === jobId);

  const c = {
    id: rid("c"),
    name,
    phone,
    email,
    jobId,
    jobTitle: job ? job.title : jobId,
    source,
    note,
    tags,
    status: "待筛选",
    follow: { nextAction: "待联系", followAt: "", note: "" },
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  d.candidates.unshift(c);
  if (c.source && !d.sources.includes(c.source)) d.sources.push(c.source);

  pushEvent(d, { candidateId: c.id, type: "创建", message: "创建候选人：" + (c.name || "-") + "（岗位：" + (c.jobTitle || "-") + "）", actor: req.user?.name || "系统" });

  if (file && file.buffer && file.buffer.length) {
    try {
      await saveResumeSupabaseOrLocal(d, c.id, file, req.user?.name || "系统");
    } catch (e) {
      pushEvent(d, { candidateId: c.id, type: "简历", message: "简历上传失败（已跳过）：" + String(e?.message || e || ""), actor: "系统" });
    }
  }

  await saveData(d);
  await notifyHrNewCandidate(d, c, job).catch(e => console.warn("[Notify] err:", e.message));
  res.redirect(303, "/candidates/" + c.id);
});

// ====== CSV 批量导入 ======
app.get("/candidates/import", requireLogin, async (req, res) => {
  res.send(
    renderPage({
      title: "批量导入候选人",
      user: req.user,
      active: "candidates",
      contentHtml: '<div class="card" style="max-width:820px;margin:0 auto;"><div style="font-weight:900;font-size:18px">批量导入候选人（CSV）</div><div class="divider"></div>' +
        '<div class="muted" style="margin-bottom:12px">CSV 文件格式要求：第一行为表头，支持字段：<b>姓名, 手机, 邮箱, 岗位ID, 来源, 备注, 标签</b>（标签用分号分隔）</div>' +
        '<div class="card compact" style="margin-bottom:12px"><div style="font-weight:700;margin-bottom:8px">CSV 模板示例</div><pre style="background:#f8fafc;padding:12px;border-radius:12px;overflow:auto;font-size:13px">姓名,手机,邮箱,岗位ID,来源,备注,标签\n张三,13800138000,zhangsan@test.com,job_xxx,Boss直聘,3年经验,高潜;紧急\n李四,13900139000,lisi@test.com,job_xxx,内推,5年经验,优秀</pre></div>' +
        '<form method="POST" action="/candidates/import" enctype="multipart/form-data"><div class="field"><label>选择 CSV 文件</label><input type="file" name="csv" accept=".csv,.txt" required /></div><div class="row"><button class="btn primary" type="submit">开始导入</button><a class="btn" href="/candidates">返回</a></div></form></div>',
    })
  );
});

app.post("/candidates/import", requireLogin, upload.single("csv"), async (req, res) => {
  const d = await loadData();
  const file = req.file;
  if (!file || !file.buffer || !file.buffer.length) {
    return res.send(renderPage({ title: "导入失败", user: req.user, active: "candidates", contentHtml: '<div class="card"><div style="font-weight:900;color:var(--red)">未选择文件</div><div class="divider"></div><a class="btn" href="/candidates/import">返回重试</a></div>' }));
  }

  const text = file.buffer.toString("utf-8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) {
    return res.send(renderPage({ title: "导入失败", user: req.user, active: "candidates", contentHtml: '<div class="card"><div style="font-weight:900;color:var(--red)">CSV文件至少需要表头+1行数据</div><div class="divider"></div><a class="btn" href="/candidates/import">返回重试</a></div>' }));
  }

  const headers = lines[0].split(",").map((h) => h.trim());
  let imported = 0;
  let errors = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim());
    const row = {};
    headers.forEach((h, idx) => { row[h] = cols[idx] || ""; });

    const name = row["姓名"] || row["name"] || "";
    if (!name) { errors.push("第" + (i + 1) + "行：缺少姓名"); continue; }

    const csvPhone = row["手机"] || row["phone"] || "";
    const dup = findDuplicate(d.candidates, name, csvPhone);
    if (dup) { errors.push("第" + (i + 1) + "行：候选人「" + name + "」疑似重复（已有同名同手机号候选人）"); continue; }

    const jobId = row["岗位ID"] || row["jobId"] || "";
    const job = jobId ? d.jobs.find((x) => x.id === jobId) : null;
    const tagStr = row["标签"] || row["tags"] || "";
    const tags = tagStr ? tagStr.split(/[;；]/).map((t) => t.trim()).filter(Boolean) : [];

    const c = {
      id: rid("c"),
      name,
      phone: row["手机"] || row["phone"] || "",
      email: row["邮箱"] || row["email"] || "",
      jobId: jobId,
      jobTitle: job ? job.title : jobId,
      source: row["来源"] || row["source"] || "",
      note: row["备注"] || row["note"] || "",
      tags,
      status: "待筛选",
      follow: { nextAction: "待联系", followAt: "", note: "" },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    d.candidates.unshift(c);
    if (c.source && !d.sources.includes(c.source)) d.sources.push(c.source);
    imported++;
  }

  if (imported > 0) {
    pushEvent(d, { candidateId: "", type: "批量导入", message: "批量导入 " + imported + " 名候选人", actor: req.user?.name || "系统" });
    await saveData(d);
    // 批量导入：逐个通知HR
    const importedCandidates = d.candidates.slice(0, imported);
    for (const ic of importedCandidates) {
      const icJob = ic.jobId ? d.jobs.find(j => j.id === ic.jobId) : null;
      await notifyHrNewCandidate(d, ic, icJob).catch(e => console.warn("[Notify] err:", e.message));
    }
  }

  const errorHtml = errors.length ? '<div class="divider"></div><div style="color:var(--red);font-weight:700">导入警告（' + errors.length + '条）</div>' + errors.map((e) => '<div class="muted">' + escapeHtml(e) + '</div>').join("") : "";

  res.send(
    renderPage({
      title: "导入完成",
      user: req.user,
      active: "candidates",
      contentHtml: '<div class="card" style="max-width:820px;margin:0 auto;"><div style="font-weight:900;font-size:18px;color:var(--green)">导入完成</div><div class="divider"></div><div class="row"><span class="pill"><span class="muted">成功导入</span><b>' + imported + '</b></span><span class="pill"><span class="muted">失败</span><b>' + errors.length + '</b></span></div>' + errorHtml + '<div class="divider"></div><div class="row"><a class="btn primary" href="/candidates">查看人才库</a><a class="btn" href="/candidates/import">继续导入</a></div></div>',
    })
  );
});

// ====== 人才库（列表）======
app.get("/candidates", requireLogin, async (req, res) => {
  const d = await loadData();
  const q = String(req.query.q || "").trim().toLowerCase();
  const jobId = String(req.query.jobId || "").trim();
  const source = String(req.query.source || "").trim();
  const status = String(req.query.status || "").trim();

  const visibleJobIds = getVisibleJobIds(req.user, d.jobs);
  const jobMap = new Map(d.jobs.map((j) => [j.id, j]));
  d.candidates.forEach((c) => {
    if (!c.jobTitle && c.jobId && jobMap.get(c.jobId)) c.jobTitle = jobMap.get(c.jobId).title;
    if (!STATUS_SET.has(c.status)) c.status = "待筛选";
    if (!c.follow) c.follow = { nextAction: "", followAt: "", note: "" };
    if (!Array.isArray(c.tags)) c.tags = [];
  });
  const permCandidates = filterCandidatesByPermission(d.candidates, visibleJobIds);

  const filtered = permCandidates.filter((c) => {
    if (jobId && c.jobId !== jobId) return false;
    if (source && String(c.source || "") !== source) return false;
    if (status && c.status !== status) return false;
    if (q) {
      const hay = (c.name || "") + " " + (c.phone || "") + " " + (c.email || "") + " " + (c.note || "") + " " + (c.source || "") + " " + (c.tags || []).join(" ");
      if (!hay.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  // 按入库时间倒序排列（最新在前）
  filtered.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  const seg = STATUS_COLS.map((s) => {
    const u = new URL("http://x/candidates");
    if (q) u.searchParams.set("q", q);
    if (jobId) u.searchParams.set("jobId", jobId);
    if (source) u.searchParams.set("source", source);
    if (s.key) u.searchParams.set("status", s.key);
    const href = u.pathname + "?" + u.searchParams.toString();
    const cls = s.key === status ? "active" : "";
    return '<a class="' + cls + '" href="' + href + '">' + escapeHtml(s.name) + '</a>';
  }).join("");

  const allHref = (() => {
    const u = new URL("http://x/candidates");
    if (q) u.searchParams.set("q", q);
    if (jobId) u.searchParams.set("jobId", jobId);
    if (source) u.searchParams.set("source", source);
    return u.pathname + (u.searchParams.toString() ? "?" + u.searchParams.toString() : "");
  })();

  // 构建简历查找 Map（只取有 url 的记录）
  const resumeMap = new Map();
  for (const r of d.resumeFiles) {
    if (!r.url) continue;
    if (!resumeMap.has(r.candidateId) || (r.uploadedAt || "") > (resumeMap.get(r.candidateId).uploadedAt || "")) {
      resumeMap.set(r.candidateId, r);
    }
  }

  const isAdmin = req.user?.role === "admin";
  const rows = filtered
    .map((c) => {
      const follow = followupBadge(c.follow);
      const tagsHtml = (c.tags || []).map((t) => tagBadge(t)).join(" ");
      const rm = resumeMap.get(c.id);
      const resumeCol = rm && rm.url
        ? '<a class="btn sm" href="' + escapeHtml(rm.url) + '" target="_blank" rel="noreferrer" title="' + escapeHtml(rm.originalName || rm.filename || "简历") + '">📎 ' + escapeHtml((rm.originalName || rm.filename || "简历").slice(0, 12)) + '</a>'
        : '<span class="muted">-</span>';
      return '<tr>' +
        '<td style="width:36px"><input type="checkbox" class="batch-check" data-id="' + escapeHtml(c.id) + '" style="width:auto" /></td>' +
        '<td><a class="btn sm" href="/candidates/' + escapeHtml(c.id) + '">' + escapeHtml(c.name || "未命名") + '</a></td>' +
        '<td>' + escapeHtml(c.phone || "-") + '</td>' +
        '<td>' + escapeHtml(c.email || "-") + '</td>' +
        '<td>' + escapeHtml(c.jobTitle || c.jobId || "-") + '</td>' +
        '<td>' + escapeHtml(c.source || "-") + '</td>' +
        '<td>' + statusBadge(c.status) + ' ' + follow + '</td>' +
        '<td>' + resumeCol + '</td>' +
        '<td>' + tagsHtml + '</td>' +
        '<td class="muted">' + escapeHtml(toBjTime(c.updatedAt || c.createdAt || "").slice(0, 16)) + '</td>' +
        '<td><a class="btn sm" href="/candidates/' + escapeHtml(c.id) + '">编辑</a></td>' +
        '</tr>';
    })
    .join("");

  res.send(
    renderPage({
      title: "人才库",
      user: req.user,
      active: "candidates",
      contentHtml: '<div class="row"><div style="font-weight:900;font-size:18px">人才库 <span class="muted" style="font-weight:400">（' + filtered.length + '/' + permCandidates.length + '）</span></div><span class="spacer"></span><a class="btn" href="/candidates/board">去看板</a></div><div class="divider"></div>' +
        toolbarHtml({ jobs: visibleJobIds === null ? d.jobs : d.jobs.filter(j => visibleJobIds.has(j.id)), sources: d.sources, q, jobId, source, mode: "list", isAdmin: req.user?.role === "admin" }) +
        '<div style="height:12px"></div>' +
        '<div class="seg"><a class="' + (status ? "" : "active") + '" href="' + allHref + '">全部状态</a>' + seg + '</div>' +
        '<div style="height:12px"></div>' +
        '<div id="batchBar" class="batch-bar" style="display:none"><span id="batchCount">已选 0 人</span><button class="btn sm primary" onclick="batchUpdateStatus()">批量更新状态</button><button class="btn sm" onclick="batchAddTag()">批量添加标签</button>' + (isAdmin ? '<button class="btn sm danger" onclick="batchDelete()">批量删除</button>' : '') + '<button class="btn sm ghost" onclick="clearBatch()">取消选择</button></div>' +
        '<div class="card"><table><thead><tr><th style="width:36px"><input type="checkbox" id="selectAll" style="width:auto" /></th><th>姓名</th><th>手机</th><th>邮箱</th><th>岗位</th><th>来源</th><th>状态 / 跟进</th><th>简历</th><th>标签</th><th>更新时间</th><th>操作</th></tr></thead><tbody>' + (rows || "") + '</tbody></table>' + (rows ? "" : '<div class="muted">暂无候选人</div>') + '</div>' +
        '<script>var sa=document.getElementById("selectAll");if(sa){sa.onchange=function(){document.querySelectorAll(".batch-check").forEach(function(cb){cb.checked=sa.checked});updateBatchBar()}}document.querySelectorAll(".batch-check").forEach(function(cb){cb.onchange=updateBatchBar});function getSelected(){return Array.from(document.querySelectorAll(".batch-check:checked")).map(function(cb){return cb.dataset.id})}function updateBatchBar(){var ids=getSelected();var bar=document.getElementById("batchBar");var cnt=document.getElementById("batchCount");if(ids.length){bar.style.display="flex";cnt.textContent="已选 "+ids.length+" 人"}else{bar.style.display="none"}}function clearBatch(){document.querySelectorAll(".batch-check").forEach(function(cb){cb.checked=false});if(sa)sa.checked=false;updateBatchBar()}async function batchUpdateStatus(){var ids=getSelected();if(!ids.length)return;var st=prompt("请输入新状态（如：待一面、淘汰等）：");if(!st)return;for(var i=0;i<ids.length;i++){await fetch("/api/candidates/"+encodeURIComponent(ids[i])+"/status",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:st})})}location.reload()}async function batchAddTag(){var ids=getSelected();if(!ids.length)return;var tag=prompt("请输入标签名称：");if(!tag)return;for(var i=0;i<ids.length;i++){var r=await fetch("/api/candidates/"+encodeURIComponent(ids[i]));if(r.ok){var data=await r.json();var tags=data.tags||[];if(tags.indexOf(tag)===-1)tags.push(tag);await fetch("/api/candidates/"+encodeURIComponent(ids[i]),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tags:tags})})}}location.reload()}async function batchDelete(){var ids=getSelected();if(!ids.length)return;if(!confirm("确定删除选中的 "+ids.length+" 名候选人？此操作不可撤销！"))return;for(var i=0;i<ids.length;i++){await fetch("/candidates/"+encodeURIComponent(ids[i])+"/delete",{method:"POST"})}location.reload()}</script>',
    })
  );
});

// ====== 看板 ======
function kanbanStatusHtml({ grouped, countsByCol, resumeMap }) {
  const cols = STATUS_COLS.map((col) => {
    const items = (grouped[col.key] || [])
      .map((c) => {
        const title = escapeHtml(c.name || "未命名");
        const jobTitle = escapeHtml(c.jobTitle || c.jobId || "-");
        const rm = resumeMap ? resumeMap.get(c.id) : null;
        const hasResume = rm && rm.url;
        const follow = followupBadge(c.follow);
        const tagsHtml = (c.tags || []).map((t) => tagBadge(t)).join(" ");
        return '<div class="carditem" onclick="openCandidate(\'' + escapeHtml(c.id) + '\')">' +
          '<div class="cardtitle"><span>' + title + '</span>' + (hasResume ? '<span class="badge status-blue" style="font-size:10px;padding:2px 6px">📎</span>' : '') + '</div>' +
          '<div class="cardsub">' + jobTitle + ' ' + statusBadge(c.status) + '</div>' +
          (follow ? '<div style="margin-top:6px">' + follow + '</div>' : '') +
          (tagsHtml ? '<div style="margin-top:4px">' + tagsHtml + '</div>' : '') +
          '</div>';
      })
      .join("");
    const cnt = countsByCol[col.key] || 0;
    return '<div class="col"><div class="colhead"><div class="coltitle">' + escapeHtml(col.name) + '</div><div class="colcount">' + cnt + '</div></div><div class="colbody">' + (items || '<div class="muted" style="text-align:center;padding:20px 0">暂无</div>') + '</div></div>';
  }).join("");

  return '<div class="card compact"><div class="row"><div style="font-weight:900;font-size:16px">候选人看板</div><span class="muted">（点击卡片打开右侧抽屉快速查看）</span><span class="spacer"></span><div class="seg" style="display:inline-flex"><button onclick="setBoardView(\'pipeline\')">流水线</button><button class="active" onclick="setBoardView(\'status\')">按状态</button></div></div><div class="divider"></div><div class="kanban kanban-status">' + cols + '</div></div>' +
    '<div id="drawerMask" class="drawerMask" onclick="closeDrawer()"></div>' +
    '<div id="drawer" class="drawer">' +
    '<div class="drawerHeader"><div><div id="drawerTitle" class="drawerTitle">候选人详情</div><div id="drawerSub" class="muted mono"></div></div><button class="drawerClose" onclick="closeDrawer()">&#10005;</button></div>' +
    '<div class="drawerBody">' +
    '<div class="tabs">' +
    '<button class="tab active" data-tab="info" onclick="switchTab(\'info\')">信息</button>' +
    '<button class="tab" data-tab="follow" onclick="switchTab(\'follow\')">跟进</button>' +
    '<button class="tab" data-tab="schedule" onclick="switchTab(\'schedule\')">面试安排</button>' +
    '<button class="tab" data-tab="resume" onclick="switchTab(\'resume\')">简历</button>' +
    '<button class="tab" data-tab="review" onclick="switchTab(\'review\')">面评</button>' +
    '<button class="tab" data-tab="activity" onclick="switchTab(\'activity\')">动态</button>' +
    '</div>' +
    '<div class="tabpanels">' +
    '<div class="tabpanel active" id="panel-info"><div class="card compact" style="padding:12px"><div class="row"><span class="pill"><span class="muted">状态</span><b id="cStatus"></b></span><span class="pill"><span class="muted">岗位</span><b id="cJob"></b></span><span class="pill"><span class="muted">来源</span><b id="cSource"></b></span><span class="spacer"></span><a class="btn" id="fullOpenBtn">打开完整详情</a></div><div class="divider"></div><div class="field"><label>状态流转</label><div class="row"><select id="statusSelect" style="max-width:220px"></select><button class="btn primary" onclick="updateStatus()">更新状态</button></div></div><div class="divider"></div><div style="font-weight:900;margin-bottom:8px">编辑候选人信息</div><div class="field"><label>姓名</label><input id="editName" /></div><div class="field"><label>手机</label><input id="editPhone" /></div><div class="field"><label>邮箱</label><input id="editEmail" /></div><div class="field"><label>来源</label><input id="editSource" /></div><div class="field"><label>备注</label><textarea id="editNote" rows="3"></textarea></div><button class="btn" onclick="saveCandidate()">保存信息</button></div></div>' +
    '<div class="tabpanel" id="panel-follow"><div class="card compact" style="padding:12px"><div class="row"><div style="font-weight:900">下一步 & 跟进时间</div><span class="muted">（逾期会标红）</span></div><div class="divider"></div><div class="field"><label>下一步动作</label><select id="fuAction"></select></div><div class="field"><label>跟进时间（YYYY-MM-DD HH:MM）</label><input id="fuAt" placeholder="例如：2026-02-08 14:00" /></div><div class="field"><label>跟进备注</label><textarea id="fuNote" rows="3"></textarea></div><button class="btn primary" onclick="saveFollow()">保存跟进</button></div></div>' +
    '<div class="tabpanel" id="panel-schedule"><div class="card compact" style="padding:12px"><div class="row"><div style="font-weight:900">面试安排</div></div><div class="divider"></div><div class="row" style="gap:10px"><div class="field" style="min-width:120px"><label>轮次</label><select id="scRound"></select></div><div class="field" style="min-width:220px"><label>面试时间</label><input id="scAt" type="datetime-local" /></div></div><div class="field"><label>面试官</label><input id="scInterviewers" list="board-interviewer-list" placeholder="张三 / 李四" /></div><div class="field"><label>会议链接</label><input id="scLink" /></div><div class="field"><label>地点/形式</label><input id="scLocation" /></div><div class="field"><label>同步状态</label><select id="scSyncStatus"></select></div><button class="btn primary" onclick="saveSchedule()">保存面试安排</button><div class="divider"></div><div style="font-weight:900;margin-bottom:8px">已安排</div><div id="scheduleList" class="muted">暂无</div></div></div>' +
    '<div class="tabpanel" id="panel-resume"><div class="card compact" style="padding:12px"><div class="row"><div style="font-weight:900">简历</div><span class="spacer"></span><a class="btn" id="resumeOpenBtn" target="_blank" rel="noreferrer">新窗口打开</a></div><div class="divider"></div><form id="resumeUploadForm" enctype="multipart/form-data"><div class="row"><input type="file" name="resume" accept=".pdf,.png,.jpg,.jpeg,.webp" /><button class="btn primary" type="submit">上传</button></div></form><div class="divider"></div><div id="resumeArea" class="muted">暂无简历</div></div></div>' +
    '<div class="tabpanel" id="panel-review"><div class="card compact" style="padding:12px"><div class="row"><div style="font-weight:900">面试评价</div></div><div class="divider"></div><div class="row" style="gap:10px"><div class="field" style="min-width:120px"><label>轮次</label><select id="rvRound"></select></div><div class="field" style="min-width:160px"><label>面试进度</label><select id="rvStatus"></select></div><div class="field" style="min-width:120px"><label>评级</label><select id="rvRating"></select></div></div><div class="field"><label>Pros</label><textarea id="rvPros" rows="3"></textarea></div><div class="field"><label>Cons</label><textarea id="rvCons" rows="3"></textarea></div><div class="field"><label>下一轮考察点</label><textarea id="rvFocusNext" rows="3"></textarea></div><button class="btn primary" onclick="addReview()">新增/更新面评</button><div class="divider"></div><div id="reviewList" class="muted">暂无面评</div></div></div>' +
    '<div class="tabpanel" id="panel-activity"><div class="card compact" style="padding:12px"><div style="font-weight:900">动态</div><div class="divider"></div><div id="activityList" class="muted">暂无动态</div></div></div>' +
    '</div></div></div>' +
    '<script>' +
    'var CURRENT_ID=null;' +
    'function switchTab(t){document.querySelectorAll(".tab").forEach(function(e){e.classList.toggle("active",e.dataset.tab===t)});document.querySelectorAll(".tabpanel").forEach(function(p){p.classList.remove("active")});document.getElementById("panel-"+t).classList.add("active")}' +
    'function openDrawer(){document.getElementById("drawerMask").classList.add("open");document.getElementById("drawer").classList.add("open")}' +
    'function closeDrawer(){document.getElementById("drawerMask").classList.remove("open");document.getElementById("drawer").classList.remove("open");CURRENT_ID=null}' +
    'async function openCandidate(id){CURRENT_ID=id;openDrawer();switchTab("info");await loadCandidate(id)}' +
    'function fillStatusSelect(current){var sel=document.getElementById("statusSelect");sel.innerHTML=' + JSON.stringify(STATUS_COLS) + '.map(function(s){return \'<option value="\'+s.key+\'" \'+(s.key===current?"selected":"")+\'>\'+s.name+\'</option>\'}).join("")}' +
    'function fillFollowOptions(cur){var sel=document.getElementById("fuAction");sel.innerHTML=' + JSON.stringify(NEXT_ACTIONS) + '.map(function(a){return \'<option value="\'+a+\'" \'+(a===cur?"selected":"")+\'>\'+a+\'</option>\'}).join("")}' +
    'function fillScheduleSelects(){var r=document.getElementById("scRound");r.innerHTML=' + JSON.stringify(INTERVIEW_ROUNDS) + '.map(function(x){return \'<option value="\'+x+\'">第\'+x+\'轮</option>\'}).join("");var st=document.getElementById("scSyncStatus");st.innerHTML=["（不同步）"].concat(' + JSON.stringify(INTERVIEW_STATUS) + ').map(function(x){return \'<option value="\'+x+\'">\'+x+\'</option>\'}).join("")}fillScheduleSelects();' +
    'function fillReviewSelects(){var r=document.getElementById("rvRound");r.innerHTML=' + JSON.stringify(INTERVIEW_ROUNDS) + '.map(function(x){return \'<option value="\'+x+\'">第\'+x+\'轮</option>\'}).join("");var st=document.getElementById("rvStatus");st.innerHTML=' + JSON.stringify(INTERVIEW_STATUS) + '.map(function(x){return \'<option value="\'+x+\'">\'+x+\'</option>\'}).join("");var ra=document.getElementById("rvRating");ra.innerHTML=' + JSON.stringify(INTERVIEW_RATING) + '.map(function(x){return \'<option value="\'+x+\'">\'+x+\'</option>\'}).join("")}fillReviewSelects();' +
    'function esc(s){return String(s||"").replace(/</g,"&lt;").replace(/>/g,"&gt;")}' +
    'function nl2br(s){return esc(s).replace(/\\n/g,"<br/>")}' +
    'function renderResumeInline(resume){var area=document.getElementById("resumeArea");var btn=document.getElementById("resumeOpenBtn");if(!resume||!resume.url){area.innerHTML=\'<div class="muted">暂无简历</div>\';btn.style.display="none";return}btn.style.display="inline-flex";btn.href=resume.url;var lower=(resume.originalName||resume.filename||"").toLowerCase();if(lower.endsWith(".pdf")){area.innerHTML=\'<iframe src="\'+resume.url+\'" style="width:100%;height:70vh;border:1px solid rgba(237,233,254,.95);border-radius:14px;background:#fff"></iframe>\'}else if(lower.endsWith(".png")||lower.endsWith(".jpg")||lower.endsWith(".jpeg")||lower.endsWith(".webp")){area.innerHTML=\'<img src="\'+resume.url+\'" style="max-width:100%;border-radius:14px" />\'}else{area.innerHTML=\'<div class="muted">不支持内嵌预览</div>\'}}' +
    'function renderSchedules(list){var box=document.getElementById("scheduleList");if(!list||!list.length){box.innerHTML=\'<div class="muted">暂无</div>\';return}box.innerHTML=list.map(function(x){return \'<div class="card compact" style="padding:12px;border-radius:14px;margin-bottom:10px"><div class="row"><b>第\'+x.round+\'轮</b><span class="pill"><span class="muted">时间</span><b>\'+esc(x.scheduledAt||"-")+\'</b></span><span class="spacer"></span><span class="muted">\'+esc(x.updatedAt||x.createdAt||"")+\'</span></div><div class="divider"></div><div class="muted">面试官：\'+esc(x.interviewers||"-")+\'</div><div class="muted">地点：\'+esc(x.location||"-")+\'</div></div>\'}).join("")}' +
    'function renderReviews(list){var box=document.getElementById("reviewList");if(!list||!list.length){box.innerHTML=\'<div class="muted">暂无面评</div>\';return}box.innerHTML=list.map(function(x){return \'<div class="card compact" style="padding:12px;border-radius:14px;margin-bottom:10px"><div class="row"><b>第\'+x.round+\'轮</b><span class="pill"><span class="muted">进度</span><b>\'+esc(x.status||"-")+\'</b></span><span class="pill"><span class="muted">评级</span><b>\'+esc(x.rating||"-")+\'</b></span></div><div class="divider"></div><div style="margin-bottom:6px"><b>Pros</b><div class="muted">\'+nl2br(x.pros||"-")+\'</div></div><div style="margin-bottom:6px"><b>Cons</b><div class="muted">\'+nl2br(x.cons||"-")+\'</div></div><div><b>下一轮考察</b><div class="muted">\'+nl2br(x.focusNext||"-")+\'</div></div></div>\'}).join("")}' +
    'function renderActivity(list){var box=document.getElementById("activityList");if(!list||!list.length){box.innerHTML=\'<div class="muted">暂无</div>\';return}box.innerHTML=\'<div class="timeline">\'+list.map(function(e){return \'<div class="titem"><div class="tmeta"><b>\'+esc(e.actor||"系统")+\'</b><span class="badge status-gray" style="font-size:11px">\'+esc(e.type||"-")+\'</span><span class="muted">\'+esc(e.createdAt||"")+\'</span></div><div class="tmsg">\'+nl2br(e.message||"")+\'</div></div>\'}).join("")+\'</div>\'}' +
    'async function loadCandidate(id){var res=await fetch("/api/candidates/"+encodeURIComponent(id));if(!res.ok){document.getElementById("drawerTitle").textContent="候选人不存在";return}var data=await res.json();document.getElementById("drawerTitle").textContent=data.name||"未命名";document.getElementById("drawerSub").textContent="ID: "+(data.id||"");document.getElementById("cStatus").textContent=data.status||"-";document.getElementById("cJob").textContent=data.jobTitle||data.jobId||"-";document.getElementById("cSource").textContent=data.source||"-";document.getElementById("fullOpenBtn").href="/candidates/"+encodeURIComponent(data.id);fillStatusSelect(data.status||"待筛选");document.getElementById("editName").value=data.name||"";document.getElementById("editPhone").value=data.phone||"";document.getElementById("editEmail").value=data.email||"";document.getElementById("editSource").value=data.source||"";document.getElementById("editNote").value=data.note||"";fillFollowOptions((data.follow&&data.follow.nextAction)||"待联系");document.getElementById("fuAt").value=(data.follow&&data.follow.followAt)||"";document.getElementById("fuNote").value=(data.follow&&data.follow.note)||"";renderSchedules(data.schedules||[]);renderResumeInline(data.resume||null);renderReviews(data.reviews||[]);renderActivity(data.events||[]);var f=document.getElementById("resumeUploadForm");f.onsubmit=async function(e){e.preventDefault();if(!CURRENT_ID)return;var fd=new FormData(f);var r=await fetch("/api/candidates/"+encodeURIComponent(CURRENT_ID)+"/resume",{method:"POST",body:fd});if(r.ok){await loadCandidate(CURRENT_ID);switchTab("resume")}else{alert("上传失败："+await r.text())}}}' +
    'async function updateStatus(){if(!CURRENT_ID)return;var v=document.getElementById("statusSelect").value;var res=await fetch("/api/candidates/"+encodeURIComponent(CURRENT_ID)+"/status",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:v})});if(res.ok)location.reload();else alert("更新失败")}' +
    'async function saveCandidate(){if(!CURRENT_ID)return;var payload={name:document.getElementById("editName").value,phone:document.getElementById("editPhone").value,email:document.getElementById("editEmail").value,source:document.getElementById("editSource").value,note:document.getElementById("editNote").value};var res=await fetch("/api/candidates/"+encodeURIComponent(CURRENT_ID),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});if(res.ok){await loadCandidate(CURRENT_ID);location.reload()}else alert("保存失败")}' +
    'async function saveFollow(){if(!CURRENT_ID)return;var payload={nextAction:document.getElementById("fuAction").value,followAt:document.getElementById("fuAt").value,note:document.getElementById("fuNote").value};var res=await fetch("/api/candidates/"+encodeURIComponent(CURRENT_ID)+"/follow",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});if(res.ok){await loadCandidate(CURRENT_ID);location.reload()}else alert("保存失败")}' +
    'async function saveSchedule(){if(!CURRENT_ID)return;var payload={round:Number(document.getElementById("scRound").value),scheduledAt:document.getElementById("scAt").value,interviewers:document.getElementById("scInterviewers").value,link:document.getElementById("scLink").value,location:document.getElementById("scLocation").value,syncStatus:document.getElementById("scSyncStatus").value};var res=await fetch("/api/candidates/"+encodeURIComponent(CURRENT_ID)+"/schedule",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});if(res.ok){await loadCandidate(CURRENT_ID);switchTab("schedule");location.reload()}else alert("保存失败")}' +
    'async function addReview(){if(!CURRENT_ID)return;var payload={round:Number(document.getElementById("rvRound").value),status:document.getElementById("rvStatus").value,rating:document.getElementById("rvRating").value,pros:document.getElementById("rvPros").value,cons:document.getElementById("rvCons").value,focusNext:document.getElementById("rvFocusNext").value};var res=await fetch("/api/candidates/"+encodeURIComponent(CURRENT_ID)+"/reviews",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});if(res.ok){document.getElementById("rvPros").value="";document.getElementById("rvCons").value="";document.getElementById("rvFocusNext").value="";await loadCandidate(CURRENT_ID);switchTab("review");location.reload()}else alert("保存失败")}' +
    'function setBoardView(v){if(v==="pipeline")location.href="/candidates/board";else location.href="/candidates/board?view=status"}' +
    '</script>';
}

function kanbanHtml({ grouped, countsByCol, resumeMap }) {
  const cols = PIPELINE_STAGES.map((stage) => {
    const stageCount = stage.statuses.reduce((sum, s) => sum + (countsByCol[s] || 0), 0);
    const stageItems = [];
    stage.statuses.forEach(s => { if (grouped[s]) stageItems.push(...grouped[s]); });

    const items = stageItems
      .map((c) => {
        const title = escapeHtml(c.name || "未命名");
        const jobTitle = escapeHtml(c.jobTitle || c.jobId || "-");
        const rm = resumeMap ? resumeMap.get(c.id) : null;
        const hasResume = rm && rm.url;
        const follow = followupBadge(c.follow);
        const tagsHtml = (c.tags || []).map((t) => tagBadge(t)).join(" ");
        const avatarLetter = escapeHtml((c.name || "?").slice(0, 1));

        return '<div class="carditem" onclick="openCandidate(\'' + escapeHtml(c.id) + '\')">' +
          '<div class="cardtitle"><div class="card-avatar" style="background:' + stage.color + '">' + avatarLetter + '</div><span>' + title + '</span>' + (hasResume ? '<span class="badge status-blue" style="font-size:10px;padding:2px 6px">📎</span>' : '') + '</div>' +
          '<div class="cardsub">' +
          '<span class="card-meta">' + jobTitle + '</span>' +
          statusBadge(c.status) +
          '</div>' +
          (follow ? '<div style="margin-top:6px">' + follow + '</div>' : '') +
          (tagsHtml ? '<div style="margin-top:4px">' + tagsHtml + '</div>' : '') +
          '</div>';
      })
      .join("");

    return '<div class="col"><div class="colhead" style="border-left:3px solid ' + stage.color + '"><div class="coltitle"><span>' + stage.icon + '</span> ' + escapeHtml(stage.name) + '</div><div class="colcount">' + stageCount + '</div></div><div class="colbody">' + (items || '<div class="muted" style="text-align:center;padding:20px 0">暂无候选人</div>') + '</div></div>';
  }).join("");

  return '<div class="card compact"><div class="row"><div style="font-weight:900;font-size:16px">候选人看板</div><span class="muted">（点击卡片打开右侧抽屉快速查看）</span><span class="spacer"></span><div class="seg" style="display:inline-flex"><button class="active" onclick="setBoardView(\'pipeline\')">流水线</button><button onclick="location.href=\'/candidates/board?view=status\'">按状态</button></div></div><div class="divider"></div><div class="kanban">' + cols + '</div></div>' +
    '<div id="drawerMask" class="drawerMask" onclick="closeDrawer()"></div>' +
    '<div id="drawer" class="drawer">' +
    '<div class="drawerHeader"><div><div id="drawerTitle" class="drawerTitle">候选人详情</div><div id="drawerSub" class="muted mono"></div></div><button class="drawerClose" onclick="closeDrawer()">&#10005;</button></div>' +
    '<div class="drawerBody">' +
    '<div class="tabs">' +
    '<button class="tab active" data-tab="info" onclick="switchTab(\'info\')">信息</button>' +
    '<button class="tab" data-tab="follow" onclick="switchTab(\'follow\')">跟进</button>' +
    '<button class="tab" data-tab="schedule" onclick="switchTab(\'schedule\')">面试安排</button>' +
    '<button class="tab" data-tab="resume" onclick="switchTab(\'resume\')">简历</button>' +
    '<button class="tab" data-tab="review" onclick="switchTab(\'review\')">面评</button>' +
    '<button class="tab" data-tab="activity" onclick="switchTab(\'activity\')">动态</button>' +
    '</div>' +
    '<div class="tabpanels">' +
    '<div class="tabpanel active" id="panel-info"><div class="card compact" style="padding:12px"><div class="row"><span class="pill"><span class="muted">状态</span><b id="cStatus"></b></span><span class="pill"><span class="muted">岗位</span><b id="cJob"></b></span><span class="pill"><span class="muted">来源</span><b id="cSource"></b></span><span class="spacer"></span><a class="btn" id="fullOpenBtn">打开完整详情</a></div><div class="divider"></div><div class="field"><label>状态流转</label><div class="row"><select id="statusSelect" style="max-width:220px"></select><button class="btn primary" onclick="updateStatus()">更新状态</button></div></div><div class="divider"></div><div style="font-weight:900;margin-bottom:8px">编辑候选人信息</div><div class="field"><label>姓名</label><input id="editName" /></div><div class="field"><label>手机</label><input id="editPhone" /></div><div class="field"><label>邮箱</label><input id="editEmail" /></div><div class="field"><label>来源</label><input id="editSource" /></div><div class="field"><label>备注</label><textarea id="editNote" rows="3"></textarea></div><button class="btn" onclick="saveCandidate()">保存信息</button></div></div>' +
    '<div class="tabpanel" id="panel-follow"><div class="card compact" style="padding:12px"><div class="row"><div style="font-weight:900">下一步 & 跟进时间</div><span class="muted">（逾期会标红）</span></div><div class="divider"></div><div class="field"><label>下一步动作</label><select id="fuAction"></select></div><div class="field"><label>跟进时间（YYYY-MM-DD HH:MM）</label><input id="fuAt" placeholder="例如：2026-02-08 14:00" /></div><div class="field"><label>跟进备注</label><textarea id="fuNote" rows="3"></textarea></div><button class="btn primary" onclick="saveFollow()">保存跟进</button></div></div>' +
    '<div class="tabpanel" id="panel-schedule"><div class="card compact" style="padding:12px"><div class="row"><div style="font-weight:900">面试安排</div></div><div class="divider"></div><div class="row" style="gap:10px"><div class="field" style="min-width:120px"><label>轮次</label><select id="scRound"></select></div><div class="field" style="min-width:220px"><label>面试时间</label><input id="scAt" type="datetime-local" /></div></div><div class="field"><label>面试官</label><input id="scInterviewers" list="board-interviewer-list" placeholder="张三 / 李四" /></div><div class="field"><label>会议链接</label><input id="scLink" /></div><div class="field"><label>地点/形式</label><input id="scLocation" /></div><div class="field"><label>同步状态</label><select id="scSyncStatus"></select></div><button class="btn primary" onclick="saveSchedule()">保存面试安排</button><div class="divider"></div><div style="font-weight:900;margin-bottom:8px">已安排</div><div id="scheduleList" class="muted">暂无</div></div></div>' +
    '<div class="tabpanel" id="panel-resume"><div class="card compact" style="padding:12px"><div class="row"><div style="font-weight:900">简历</div><span class="spacer"></span><a class="btn" id="resumeOpenBtn" target="_blank" rel="noreferrer">新窗口打开</a></div><div class="divider"></div><form id="resumeUploadForm" enctype="multipart/form-data"><div class="row"><input type="file" name="resume" accept=".pdf,.png,.jpg,.jpeg,.webp" /><button class="btn primary" type="submit">上传</button></div></form><div class="divider"></div><div id="resumeArea" class="muted">暂无简历</div></div></div>' +
    '<div class="tabpanel" id="panel-review"><div class="card compact" style="padding:12px"><div class="row"><div style="font-weight:900">面试评价</div></div><div class="divider"></div><div class="row" style="gap:10px"><div class="field" style="min-width:120px"><label>轮次</label><select id="rvRound"></select></div><div class="field" style="min-width:160px"><label>面试进度</label><select id="rvStatus"></select></div><div class="field" style="min-width:120px"><label>评级</label><select id="rvRating"></select></div></div><div class="field"><label>Pros</label><textarea id="rvPros" rows="3"></textarea></div><div class="field"><label>Cons</label><textarea id="rvCons" rows="3"></textarea></div><div class="field"><label>下一轮考察点</label><textarea id="rvFocusNext" rows="3"></textarea></div><button class="btn primary" onclick="addReview()">新增/更新面评</button><div class="divider"></div><div id="reviewList" class="muted">暂无面评</div></div></div>' +
    '<div class="tabpanel" id="panel-activity"><div class="card compact" style="padding:12px"><div style="font-weight:900">动态</div><div class="divider"></div><div id="activityList" class="muted">暂无动态</div></div></div>' +
    '</div></div></div>' +
    '<script>' +
    'var CURRENT_ID=null;' +
    'function switchTab(t){document.querySelectorAll(".tab").forEach(function(e){e.classList.toggle("active",e.dataset.tab===t)});document.querySelectorAll(".tabpanel").forEach(function(p){p.classList.remove("active")});document.getElementById("panel-"+t).classList.add("active")}' +
    'function openDrawer(){document.getElementById("drawerMask").classList.add("open");document.getElementById("drawer").classList.add("open")}' +
    'function closeDrawer(){document.getElementById("drawerMask").classList.remove("open");document.getElementById("drawer").classList.remove("open");CURRENT_ID=null}' +
    'async function openCandidate(id){CURRENT_ID=id;openDrawer();switchTab("info");await loadCandidate(id)}' +
    'function fillStatusSelect(current){var sel=document.getElementById("statusSelect");sel.innerHTML=' + JSON.stringify(STATUS_COLS) + '.map(function(s){return \'<option value="\'+s.key+\'" \'+(s.key===current?"selected":"")+\'>\'+s.name+\'</option>\'}).join("")}' +
    'function fillFollowOptions(cur){var sel=document.getElementById("fuAction");sel.innerHTML=' + JSON.stringify(NEXT_ACTIONS) + '.map(function(a){return \'<option value="\'+a+\'" \'+(a===cur?"selected":"")+\'>\'+a+\'</option>\'}).join("")}' +
    'function fillScheduleSelects(){var r=document.getElementById("scRound");r.innerHTML=' + JSON.stringify(INTERVIEW_ROUNDS) + '.map(function(x){return \'<option value="\'+x+\'">第\'+x+\'轮</option>\'}).join("");var st=document.getElementById("scSyncStatus");st.innerHTML=["（不同步）"].concat(' + JSON.stringify(INTERVIEW_STATUS) + ').map(function(x){return \'<option value="\'+x+\'">\'+x+\'</option>\'}).join("")}fillScheduleSelects();' +
    'function fillReviewSelects(){var r=document.getElementById("rvRound");r.innerHTML=' + JSON.stringify(INTERVIEW_ROUNDS) + '.map(function(x){return \'<option value="\'+x+\'">第\'+x+\'轮</option>\'}).join("");var st=document.getElementById("rvStatus");st.innerHTML=' + JSON.stringify(INTERVIEW_STATUS) + '.map(function(x){return \'<option value="\'+x+\'">\'+x+\'</option>\'}).join("");var ra=document.getElementById("rvRating");ra.innerHTML=' + JSON.stringify(INTERVIEW_RATING) + '.map(function(x){return \'<option value="\'+x+\'">\'+x+\'</option>\'}).join("")}fillReviewSelects();' +
    'function esc(s){return String(s||"").replace(/</g,"&lt;").replace(/>/g,"&gt;")}' +
    'function nl2br(s){return esc(s).replace(/\\n/g,"<br/>")}' +
    'function renderResumeInline(resume){var area=document.getElementById("resumeArea");var btn=document.getElementById("resumeOpenBtn");if(!resume||!resume.url){area.innerHTML=\'<div class="muted">暂无简历</div>\';btn.style.display="none";return}btn.style.display="inline-flex";btn.href=resume.url;var lower=(resume.originalName||resume.filename||"").toLowerCase();if(lower.endsWith(".pdf")){area.innerHTML=\'<iframe src="\'+resume.url+\'" style="width:100%;height:70vh;border:1px solid rgba(237,233,254,.95);border-radius:14px;background:#fff"></iframe>\'}else if(lower.endsWith(".png")||lower.endsWith(".jpg")||lower.endsWith(".jpeg")||lower.endsWith(".webp")){area.innerHTML=\'<img src="\'+resume.url+\'" style="max-width:100%;border-radius:14px" />\'}else{area.innerHTML=\'<div class="muted">不支持内嵌预览</div>\'}}' +
    'function renderSchedules(list){var box=document.getElementById("scheduleList");if(!list||!list.length){box.innerHTML=\'<div class="muted">暂无</div>\';return}box.innerHTML=list.map(function(x){return \'<div class="card compact" style="padding:12px;border-radius:14px;margin-bottom:10px"><div class="row"><b>第\'+x.round+\'轮</b><span class="pill"><span class="muted">时间</span><b>\'+esc(x.scheduledAt||"-")+\'</b></span><span class="spacer"></span><span class="muted">\'+esc(x.updatedAt||x.createdAt||"")+\'</span></div><div class="divider"></div><div class="muted">面试官：\'+esc(x.interviewers||"-")+\'</div><div class="muted">地点：\'+esc(x.location||"-")+\'</div></div>\'}).join("")}' +
    'function renderReviews(list){var box=document.getElementById("reviewList");if(!list||!list.length){box.innerHTML=\'<div class="muted">暂无面评</div>\';return}box.innerHTML=list.map(function(x){return \'<div class="card compact" style="padding:12px;border-radius:14px;margin-bottom:10px"><div class="row"><b>第\'+x.round+\'轮</b><span class="pill"><span class="muted">进度</span><b>\'+esc(x.status||"-")+\'</b></span><span class="pill"><span class="muted">评级</span><b>\'+esc(x.rating||"-")+\'</b></span></div><div class="divider"></div><div style="margin-bottom:6px"><b>Pros</b><div class="muted">\'+nl2br(x.pros||"-")+\'</div></div><div style="margin-bottom:6px"><b>Cons</b><div class="muted">\'+nl2br(x.cons||"-")+\'</div></div><div><b>下一轮考察</b><div class="muted">\'+nl2br(x.focusNext||"-")+\'</div></div></div>\'}).join("")}' +
    'function renderActivity(list){var box=document.getElementById("activityList");if(!list||!list.length){box.innerHTML=\'<div class="muted">暂无</div>\';return}box.innerHTML=\'<div class="timeline">\'+list.map(function(e){return \'<div class="titem"><div class="tmeta"><b>\'+esc(e.actor||"系统")+\'</b><span class="badge status-gray" style="font-size:11px">\'+esc(e.type||"-")+\'</span><span class="muted">\'+esc(e.createdAt||"")+\'</span></div><div class="tmsg">\'+nl2br(e.message||"")+\'</div></div>\'}).join("")+\'</div>\'}' +
    'async function loadCandidate(id){var res=await fetch("/api/candidates/"+encodeURIComponent(id));if(!res.ok){document.getElementById("drawerTitle").textContent="候选人不存在";return}var data=await res.json();document.getElementById("drawerTitle").textContent=data.name||"未命名";document.getElementById("drawerSub").textContent="ID: "+(data.id||"");document.getElementById("cStatus").textContent=data.status||"-";document.getElementById("cJob").textContent=data.jobTitle||data.jobId||"-";document.getElementById("cSource").textContent=data.source||"-";document.getElementById("fullOpenBtn").href="/candidates/"+encodeURIComponent(data.id);fillStatusSelect(data.status||"待筛选");document.getElementById("editName").value=data.name||"";document.getElementById("editPhone").value=data.phone||"";document.getElementById("editEmail").value=data.email||"";document.getElementById("editSource").value=data.source||"";document.getElementById("editNote").value=data.note||"";fillFollowOptions((data.follow&&data.follow.nextAction)||"待联系");document.getElementById("fuAt").value=(data.follow&&data.follow.followAt)||"";document.getElementById("fuNote").value=(data.follow&&data.follow.note)||"";renderSchedules(data.schedules||[]);renderResumeInline(data.resume||null);renderReviews(data.reviews||[]);renderActivity(data.events||[]);var f=document.getElementById("resumeUploadForm");f.onsubmit=async function(e){e.preventDefault();if(!CURRENT_ID)return;var fd=new FormData(f);var r=await fetch("/api/candidates/"+encodeURIComponent(CURRENT_ID)+"/resume",{method:"POST",body:fd});if(r.ok){await loadCandidate(CURRENT_ID);switchTab("resume")}else{alert("上传失败："+await r.text())}}}' +
    'async function updateStatus(){if(!CURRENT_ID)return;var v=document.getElementById("statusSelect").value;var res=await fetch("/api/candidates/"+encodeURIComponent(CURRENT_ID)+"/status",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:v})});if(res.ok)location.reload();else alert("更新失败")}' +
    'async function saveCandidate(){if(!CURRENT_ID)return;var payload={name:document.getElementById("editName").value,phone:document.getElementById("editPhone").value,email:document.getElementById("editEmail").value,source:document.getElementById("editSource").value,note:document.getElementById("editNote").value};var res=await fetch("/api/candidates/"+encodeURIComponent(CURRENT_ID),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});if(res.ok){await loadCandidate(CURRENT_ID);location.reload()}else alert("保存失败")}' +
    'async function saveFollow(){if(!CURRENT_ID)return;var payload={nextAction:document.getElementById("fuAction").value,followAt:document.getElementById("fuAt").value,note:document.getElementById("fuNote").value};var res=await fetch("/api/candidates/"+encodeURIComponent(CURRENT_ID)+"/follow",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});if(res.ok){await loadCandidate(CURRENT_ID);location.reload()}else alert("保存失败")}' +
    'async function saveSchedule(){if(!CURRENT_ID)return;var payload={round:Number(document.getElementById("scRound").value),scheduledAt:document.getElementById("scAt").value,interviewers:document.getElementById("scInterviewers").value,link:document.getElementById("scLink").value,location:document.getElementById("scLocation").value,syncStatus:document.getElementById("scSyncStatus").value};var res=await fetch("/api/candidates/"+encodeURIComponent(CURRENT_ID)+"/schedule",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});if(res.ok){await loadCandidate(CURRENT_ID);switchTab("schedule");location.reload()}else alert("保存失败")}' +
    'async function addReview(){if(!CURRENT_ID)return;var payload={round:Number(document.getElementById("rvRound").value),status:document.getElementById("rvStatus").value,rating:document.getElementById("rvRating").value,pros:document.getElementById("rvPros").value,cons:document.getElementById("rvCons").value,focusNext:document.getElementById("rvFocusNext").value};var res=await fetch("/api/candidates/"+encodeURIComponent(CURRENT_ID)+"/reviews",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});if(res.ok){document.getElementById("rvPros").value="";document.getElementById("rvCons").value="";document.getElementById("rvFocusNext").value="";await loadCandidate(CURRENT_ID);switchTab("review");location.reload()}else alert("保存失败")}' +
    'function setBoardView(v){if(v==="pipeline")location.href="/candidates/board";else location.href="/candidates/board?view=status"}' +
    '</script>';
}

app.get("/candidates/board", requireLogin, async (req, res) => {
  const d = await loadData();
  const q = String(req.query.q || "").trim().toLowerCase();
  const jobId = String(req.query.jobId || "").trim();
  const source = String(req.query.source || "").trim();

  const visibleJobIds = getVisibleJobIds(req.user, d.jobs);
  const jobMap = new Map(d.jobs.map((j) => [j.id, j]));
  d.candidates.forEach((c) => {
    if (!c.jobTitle && c.jobId && jobMap.get(c.jobId)) c.jobTitle = jobMap.get(c.jobId).title;
    if (!STATUS_SET.has(c.status)) c.status = "待筛选";
    if (!c.follow) c.follow = { nextAction: "", followAt: "", note: "" };
    if (!Array.isArray(c.tags)) c.tags = [];
  });
  const permCandidates = filterCandidatesByPermission(d.candidates, visibleJobIds);

  const filtered = permCandidates.filter((c) => {
    if (jobId && c.jobId !== jobId) return false;
    if (source && String(c.source || "") !== source) return false;
    if (q) {
      const hay = (c.name || "") + " " + (c.phone || "") + " " + (c.note || "") + " " + (c.source || "");
      if (!hay.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const grouped = {};
  const countsByCol = {};
  STATUS_COLS.forEach((col) => { grouped[col.key] = []; countsByCol[col.key] = 0; });
  filtered.forEach((c) => { grouped[c.status].push(c); countsByCol[c.status] += 1; });

  // 构建简历 Map 供看板卡片使用（只取有 url 的记录）
  const boardResumeMap = new Map();
  for (const r of d.resumeFiles) {
    if (!r.url) continue;
    if (!boardResumeMap.has(r.candidateId) || (r.uploadedAt || "") > (boardResumeMap.get(r.candidateId).uploadedAt || "")) {
      boardResumeMap.set(r.candidateId, r);
    }
  }

  // 流水线摘要
  const totalFiltered = filtered.length;
  const pipelineSummary = PIPELINE_STAGES.map(stage => {
    const cnt = stage.statuses.reduce((sum, s) => sum + (countsByCol[s] || 0), 0);
    return '<div class="pipeline-stage"><div class="pipeline-dot" style="background:' + stage.color + '"></div><div class="pipeline-info"><div class="pipeline-name">' + escapeHtml(stage.name) + '</div><div class="pipeline-num">' + cnt + '</div></div></div>';
  }).join('<div class="pipeline-arrow">›</div>');

  const viewMode = String(req.query.view || "pipeline").trim();
  const boardContent = viewMode === "status"
    ? kanbanStatusHtml({ grouped, countsByCol, resumeMap: boardResumeMap })
    : kanbanHtml({ grouped, countsByCol, resumeMap: boardResumeMap });

  res.send(
    renderPage({
      title: "候选人看板",
      user: req.user,
      active: "board",
      contentHtml: toolbarHtml({ jobs: visibleJobIds === null ? d.jobs : d.jobs.filter(j => visibleJobIds.has(j.id)), sources: d.sources, q, jobId, source, mode: "board", isAdmin: req.user?.role === "admin" }) +
        '<div class="card compact" style="margin-bottom:12px"><div class="pipeline-bar">' + pipelineSummary + '</div></div>' +
        boardContent +
        '<datalist id="board-interviewer-list">' + d.users.map(u => '<option value="' + escapeHtml(u.name) + '">').join("") + '</datalist>',
    })
  );
});

// ====== 候选人详情页 ======
function resumeEmbedHtml(resume) {
  if (!resume || !resume.url) return '<div class="muted">暂无简历</div>';
  const lower = (resume.originalName || resume.filename || "").toLowerCase();
  if (lower.endsWith(".pdf")) return '<iframe src="' + escapeHtml(resume.url) + '" style="width:100%;height:75vh;border:1px solid rgba(237,233,254,.95);border-radius:14px;background:#fff"></iframe>';
  if (lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".webp")) return '<img src="' + escapeHtml(resume.url) + '" style="max-width:100%;border-radius:14px" />';
  return '<div class="muted">不支持内嵌预览</div>';
}
app.get("/candidates/:id", requireLogin, async (req, res) => {
  const d = await loadData();
  const c = d.candidates.find((x) => x.id === req.params.id);
  if (!c) {
    return res.send(renderPage({ title: "候选人不存在", user: req.user, active: "candidates", contentHtml: '<div class="card"><div style="font-weight:900">候选人不存在</div><div class="divider"></div><a class="btn" href="/candidates">返回</a></div>' }));
  }
  // 权限检查：member 只能查看自己负责岗位下的候选人
  const visibleJobIds = getVisibleJobIds(req.user, d.jobs);
  if (visibleJobIds !== null && !visibleJobIds.has(c.jobId)) {
    return res.send(renderPage({ title: "无权限", user: req.user, active: "candidates", contentHtml: '<div class="card"><div style="font-weight:900">无权限查看该候选人</div><div class="muted">该候选人所属岗位不在您的负责范围内</div><div class="divider"></div><a class="btn" href="/candidates">返回</a></div>' }));
  }
  if (!STATUS_SET.has(c.status)) c.status = "待筛选";
  if (!c.follow) c.follow = { nextAction: "待联系", followAt: "", note: "" };
  if (!Array.isArray(c.tags)) c.tags = [];

  var resume = d.resumeFiles.filter((r) => r.candidateId === c.id && r.url).sort((a, b) => (b.uploadedAt || "").localeCompare(a.uploadedAt || ""))[0];
  resume = await refreshResumeUrlIfNeeded(resume);

  const reviews = d.interviews.filter((x) => x.candidateId === c.id).sort((a, b) => (a.round - b.round) || (b.createdAt || "").localeCompare(a.createdAt || ""));
  const schedules = d.interviewSchedules.filter((x) => x.candidateId === c.id).sort((a, b) => (a.round - b.round));
  const events = d.events.filter((e) => e.candidateId === c.id).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  const offer = (d.offers || []).find((o) => o.candidateId === c.id);

  const statusOptions = STATUS_COLS.map((s) => '<option value="' + escapeHtml(s.key) + '" ' + (c.status === s.key ? "selected" : "") + '>' + escapeHtml(s.name) + '</option>').join("");
  const roundOpts = INTERVIEW_ROUNDS.map((x) => '<option value="' + x + '">第' + x + '轮</option>').join("");
  const stOpts = INTERVIEW_STATUS.map((x) => '<option value="' + escapeHtml(x) + '">' + escapeHtml(x) + '</option>').join("");
  const rtOpts = INTERVIEW_RATING.map((x) => '<option value="' + x + '">' + x + '</option>').join("");
  const nextOpts = NEXT_ACTIONS.map((x) => '<option value="' + escapeHtml(x) + '" ' + (c.follow.nextAction === x ? "selected" : "") + '>' + escapeHtml(x) + '</option>').join("");
  const syncOpts = '<option value="（不同步）">（不同步）</option>' + INTERVIEW_STATUS.map((x) => '<option value="' + escapeHtml(x) + '">' + escapeHtml(x) + '</option>').join("");
  const offerStOpts = OFFER_STATUSES.map((x) => '<option value="' + escapeHtml(x) + '" ' + ((offer && offer.offerStatus === x) ? "selected" : "") + '>' + escapeHtml(x) + '</option>').join("");
  const interviewerDatalist = d.users.map(u => '<option value="' + escapeHtml(u.name) + '">' + escapeHtml(u.name) + '</option>').join("");

  const tagsHtml = (c.tags || []).map((t) => tagBadge(t)).join(" ");

  // ====== 面试评级汇总 ======
  const ratingScore = { S: 5, A: 4, "B+": 3.5, B: 3, "B-": 2, C: 1 };
  let summaryHtml = '';
  if (reviews.length) {
    const roundSummary = reviews.map(rv => {
      const score = ratingScore[rv.rating] || 0;
      return '<div class="rv-round-row"><span class="badge status-blue" style="min-width:56px;text-align:center">第' + rv.round + '轮</span><span class="badge ' + (score >= 3.5 ? 'green' : score >= 2 ? 'gray' : 'red') + '">' + escapeHtml(rv.rating || "-") + '</span>' + (rv.interviewer ? '<span class="muted" style="font-size:12px">' + escapeHtml(rv.interviewer) + '</span>' : '') + '<span class="spacer"></span><span class="muted" style="font-size:11px">' + escapeHtml(toBjTime(rv.createdAt || "").slice(0, 10)) + '</span></div>';
    }).join("");

    const allScores = reviews.map(rv => ratingScore[rv.rating] || 0).filter(s => s > 0);
    const avgScore = allScores.length ? (allScores.reduce((a, b) => a + b, 0) / allScores.length) : 0;
    const avgRating = avgScore >= 4.5 ? 'S' : avgScore >= 3.5 ? 'A' : avgScore >= 3 ? 'B+' : avgScore >= 2.5 ? 'B' : avgScore >= 1.5 ? 'B-' : avgScore > 0 ? 'C' : '-';

    summaryHtml = '<div class="card review-summary"><div class="row"><div style="font-weight:900">面试评级汇总</div><span class="spacer"></span><span class="badge ' + (avgScore >= 3.5 ? 'green' : avgScore >= 2 ? 'gray' : 'red') + '" style="font-size:14px;padding:6px 14px">综合：' + avgRating + '</span></div><div class="divider"></div>' + roundSummary + '</div>';
  }

  const scheduleHtml = schedules.length ? schedules.map((x) => {
    const roundPassStatus = x.round === 1 ? "一面通过" : x.round === 2 ? "二面通过" : x.round === 3 ? "三面通过" : x.round === 4 ? "四面通过" : "五面通过";
    const reviewLinkBtn = x.reviewToken ? '<a class="btn sm" href="/review/' + escapeHtml(x.reviewToken) + '" target="_blank" style="background:rgba(51,112,255,.08);color:#3370ff">📝 面评链接</a>' : '';
    const recBtn = x.recordingUrl ? '<a class="btn sm" href="' + escapeHtml(x.recordingUrl) + '" target="_blank" style="background:rgba(59,130,246,.08);color:#1d4ed8">🎬 会议录制</a>' : '';
    return '<div class="card compact" style="padding:12px;border-radius:14px;margin-bottom:10px"><div class="row"><b>第' + x.round + '轮</b><span class="pill"><span class="muted">时间</span><b>' + escapeHtml(toBjTime(x.scheduledAt || "") || "-") + '</b></span><span class="spacer"></span><span class="muted">' + escapeHtml(toBjTime(x.updatedAt || x.createdAt || "").slice(0, 16)) + '</span></div><div class="divider"></div><div class="muted">面试官：' + escapeHtml(x.interviewers || "-") + '</div><div class="muted">地点/形式：' + escapeHtml(x.location || "-") + '</div>' + (x.link ? '<div class="muted">链接：<a class="btn sm" target="_blank" href="' + escapeHtml(x.link) + '">打开</a></div>' : "") + (reviewLinkBtn || recBtn ? '<div class="row" style="gap:6px;margin-top:6px">' + reviewLinkBtn + recBtn + '</div>' : '') + '<div class="divider"></div><div class="row" style="gap:6px"><button class="btn sm" style="background:rgba(22,163,74,.1);color:#16a34a" onclick="quickStatus(\'' + escapeHtml(roundPassStatus) + '\')">✓ 标记通过</button><button class="btn sm" style="background:rgba(239,68,68,.1);color:#ef4444" onclick="quickStatus(\'淘汰\')">✗ 淘汰</button>' + (x.round < 5 ? '<button class="btn sm" onclick="prefillNextRound(' + (x.round + 1) + ')">安排第' + (x.round + 1) + '轮</button>' : '') + '</div></div>';
  }).join("") : '<div class="muted">暂无面试安排</div>';

  const reviewHtml = reviews.length ? reviews.map((x) => {
    return '<div class="card compact" style="padding:12px;border-radius:14px;margin-bottom:10px"><div class="row"><b>第' + x.round + '轮</b><span class="pill"><span class="muted">评级</span><b>' + escapeHtml(x.rating || "-") + '</b></span>' + (x.interviewer ? '<span class="pill"><span class="muted">面试官</span><b>' + escapeHtml(x.interviewer) + '</b></span>' : '') + '<span class="spacer"></span><span class="muted">' + escapeHtml(toBjTime(x.createdAt || "").slice(0, 16)) + '</span></div><div class="divider"></div><div style="margin-bottom:6px"><b>Pros</b><div class="muted">' + escapeHtml(x.pros || "-").replaceAll("\n", "<br/>") + '</div></div><div style="margin-bottom:6px"><b>Cons</b><div class="muted">' + escapeHtml(x.cons || "-").replaceAll("\n", "<br/>") + '</div></div><div><b>下一轮考察点</b><div class="muted">' + escapeHtml(x.focusNext || "-").replaceAll("\n", "<br/>") + '</div></div></div>';
  }).join("") : '<div class="muted">暂无面评</div>';

  const eventHtml = events.length ? '<div class="timeline">' + events.map((e) => '<div class="titem"><div class="tmeta"><b>' + escapeHtml(e.actor || "系统") + '</b><span class="pill"><span class="muted">时间</span><b>' + escapeHtml(e.createdAt || "") + '</b></span><span class="pill"><span class="muted">类型</span><b>' + escapeHtml(e.type || "-") + '</b></span></div><div class="tmsg">' + escapeHtml(e.message || "").replaceAll("\n", "<br/>") + '</div></div>').join("") + '</div>' : '<div class="muted">暂无动态</div>';

  const offerHtml = '<div class="card compact" style="padding:12px;border-radius:14px">' + (offer ? '<div class="row"><div style="font-weight:900">当前Offer</div><span class="spacer"></span>' + offerStatusBadge(offer.offerStatus) + '</div><div class="divider"></div><div class="row" style="margin-bottom:8px"><span class="pill"><span class="muted">薪资</span><b>' + escapeHtml(offer.salary || "-") + '</b></span><span class="pill"><span class="muted">入职日期</span><b>' + escapeHtml(offer.startDate || "-") + '</b></span></div><div class="muted">' + escapeHtml(offer.salaryNote || "") + '</div><div class="muted">' + escapeHtml(offer.note || "") + '</div><div class="divider"></div>' : '<div style="font-weight:900;margin-bottom:8px">Offer管理</div>') +
    '<form method="POST" action="/api/candidates/' + encodeURIComponent(c.id) + '/offer"><div class="row" style="gap:10px"><div class="field" style="min-width:160px"><label>薪资（月薪/年薪）</label><input name="salary" value="' + escapeHtml(offer?.salary || "") + '" placeholder="25K*15" /></div><div class="field" style="min-width:160px"><label>入职日期</label><input name="startDate" type="date" value="' + escapeHtml(offer?.startDate || "") + '" /></div><div class="field" style="min-width:140px"><label>Offer状态</label><select name="offerStatus">' + offerStOpts + '</select></div></div><div class="field"><label>薪资备注</label><input name="salaryNote" value="' + escapeHtml(offer?.salaryNote || "") + '" placeholder="如：base+bonus+RSU" /></div><div class="field"><label>Offer备注</label><textarea name="note" rows="2">' + escapeHtml(offer?.note || "") + '</textarea></div><button class="btn primary" type="submit">保存Offer</button></form></div>';

  const cid = encodeURIComponent(c.id);
  const isAdmin = req.user?.role === "admin";

  // 顶部操作栏
  const topActions = (feishuEnabled() ? '<button class="btn sm" onclick="sendNotify()" id="notifyBtn" style="background:rgba(59,130,246,.08);color:#1d4ed8">发送飞书通知</button>' : '') +
    '<a class="btn" href="/candidates">返回列表</a><a class="btn" href="/candidates/board">去看板</a>' +
    (isAdmin ? '<form method="POST" action="/candidates/' + cid + '/delete" style="display:inline" onsubmit="return confirm(\'确定删除此候选人及所有关联数据？\')"><button class="btn danger sm" type="submit">删除</button></form>' : '');

  // "信息"tab — 所有登录用户可编辑
  const infoPanel = '<div class="tabpanel active" id="panel-info"><div class="divider"></div><div class="grid"><div class="card compact"><div style="font-weight:900;margin-bottom:8px">编辑信息</div><div class="field"><label>姓名</label><input id="editName" value="' + escapeHtml(c.name || "") + '" /></div><div class="field"><label>手机</label><input id="editPhone" value="' + escapeHtml(c.phone || "") + '" /></div><div class="field"><label>邮箱</label><input id="editEmail" value="' + escapeHtml(c.email || "") + '" /></div><div class="field"><label>来源</label><input id="editSource" value="' + escapeHtml(c.source || "") + '" /></div><div class="field"><label>备注</label><textarea id="editNote" rows="4">' + escapeHtml(c.note || "") + '</textarea></div><button class="btn primary" onclick="saveCandidate()">保存</button></div><div class="card compact"><div style="font-weight:900;margin-bottom:8px">状态流转</div><div class="field"><label>候选人状态</label><select id="statusSelect">' + statusOptions + '</select></div><button class="btn primary" onclick="updateStatus()">更新状态</button></div></div></div>';

  // "跟进"tab — member 只读
  // "跟进"tab — 所有登录用户可编辑
  const followPanel = '<div class="tabpanel" id="panel-follow"><div class="divider"></div><div class="card compact" style="padding:12px;border-radius:14px"><div class="row"><div style="font-weight:900">下一步 & 跟进时间</div></div><div class="divider"></div><div class="field"><label>下一步动作</label><select id="fuAction">' + nextOpts + '</select></div><div class="field"><label>跟进时间</label><input id="fuAt" value="' + escapeHtml(c.follow.followAt || "") + '" placeholder="2026-02-08 14:00" /></div><div class="field"><label>跟进备注</label><textarea id="fuNote" rows="4">' + escapeHtml(c.follow.note || "") + '</textarea></div><button class="btn primary" onclick="saveFollow()">保存跟进</button></div></div>';

  // "面试安排"tab — member 只显示已有安排（无新增表单和快捷按钮）
  const scheduleViewHtml = schedules.length ? schedules.map((x) => {
    const reviewLinkBtn = x.reviewToken ? '<a class="btn sm" href="/review/' + escapeHtml(x.reviewToken) + '" target="_blank" style="background:rgba(51,112,255,.08);color:#3370ff">📝 面评链接</a>' : '';
    const recBtn = x.recordingUrl ? '<a class="btn sm" href="' + escapeHtml(x.recordingUrl) + '" target="_blank" style="background:rgba(59,130,246,.08);color:#1d4ed8">🎬 会议录制</a>' : '';
    return '<div class="card compact" style="padding:12px;border-radius:14px;margin-bottom:10px"><div class="row"><b>第' + x.round + '轮</b><span class="pill"><span class="muted">时间</span><b>' + escapeHtml(toBjTime(x.scheduledAt || "") || "-") + '</b></span><span class="spacer"></span><span class="muted">' + escapeHtml(toBjTime(x.updatedAt || x.createdAt || "").slice(0, 16)) + '</span></div><div class="divider"></div><div class="muted">面试官：' + escapeHtml(x.interviewers || "-") + '</div><div class="muted">地点/形式：' + escapeHtml(x.location || "-") + '</div>' + (x.link ? '<div class="muted">链接：<a class="btn sm" target="_blank" href="' + escapeHtml(x.link) + '">打开</a></div>' : "") + (reviewLinkBtn || recBtn ? '<div class="row" style="gap:6px;margin-top:6px">' + reviewLinkBtn + recBtn + '</div>' : '') + '</div>';
  }).join("") : '<div class="muted">暂无面试安排</div>';

  // "面试安排"tab — 所有登录用户可编辑
  // 生成时间选项 09:00 ~ 21:00，每30分钟
  const timeOpts = (() => {
    let opts = '<option value="">选择时间</option>';
    for (let h = 9; h <= 21; h++) {
      for (const m of [0, 30]) {
        if (h === 21 && m === 30) break;
        const hh = String(h).padStart(2, "0");
        const mm = String(m).padStart(2, "0");
        opts += '<option value="' + hh + ':' + mm + '">' + hh + ':' + mm + '</option>';
      }
    }
    return opts;
  })();
  const schedulePanel = '<div class="tabpanel" id="panel-schedule"><div class="divider"></div><div class="card compact" style="padding:16px;border-radius:14px"><div style="font-weight:900;font-size:15px;margin-bottom:12px">新增/更新面试安排</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:10px">' +
        '<div class="field"><label>轮次</label><select id="scRound">' + roundOpts + '</select></div>' +
        '<div class="field"><label>面试日期</label><input id="scDate" type="date" /></div>' +
        '<div class="field"><label>面试时间</label><select id="scTime">' + timeOpts + '</select></div>' +
      '</div>' +
      '<input id="scAt" type="hidden" />' +
      '<div class="field"><label>面试官 <span class="muted" style="font-size:12px">（从通讯录选择，可多选）</span></label>' +
      '<div id="interviewerPicker" style="position:relative">' +
        '<div id="selectedInterviewers" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px"></div>' +
        '<input id="scInterviewerSearch" placeholder="搜索面试官姓名..." autocomplete="off" style="width:100%" />' +
        '<div id="interviewerDropdown" style="display:none;position:absolute;z-index:100;left:0;right:0;top:100%;max-height:200px;overflow-y:auto;background:#fff;border:1px solid #e5e7eb;border-radius:10px;box-shadow:0 4px 12px rgba(0,0,0,.1)"></div>' +
      '</div></div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">' +
        '<div class="field"><label>会议链接</label><input id="scLink" placeholder="可选" /></div>' +
        '<div class="field"><label>地点/形式</label><input id="scLocation" placeholder="如：线上/会议室A" /></div>' +
      '</div>' +
      '<div class="field"><label>同步状态</label><select id="scSyncStatus">' + syncOpts + '</select></div>' +
      (feishuEnabled() ? '<div class="field" style="margin-bottom:12px"><label style="display:flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" id="scSyncCalendar" style="width:auto" checked /> 同步到飞书日历（面试官个人日历）</label></div>' : '') +
      '<button class="btn primary" onclick="saveSchedule()" style="width:100%">保存面试安排</button></div><div style="height:12px"></div>' + scheduleHtml + '</div>';

  // "简历"tab — 所有登录用户可上传
  const resumePanel = '<div class="tabpanel" id="panel-resume"><div class="divider"></div><div class="row"><div style="font-weight:900">上传简历</div><span class="spacer"></span>' + (resume?.url ? '<a class="btn" href="' + escapeHtml(resume.url) + '" target="_blank" rel="noreferrer">新窗口打开</a>' : '') + '</div><div class="divider"></div><form id="resumeUploadForm" enctype="multipart/form-data"><div class="row"><input type="file" name="resume" accept=".pdf,.png,.jpg,.jpeg,.webp" /><button class="btn primary" type="submit">上传</button></div></form><div class="divider"></div>' + resumeEmbedHtml(resume) + '</div>';

  // "面评"tab — 所有角色都可提交面评
  const reviewHtmlEnhanced = reviews.length ? reviews.map((x) => {
    const conclusionColor = x.conclusion === '不通过' ? '#f54a45' : '#34c724';
    const conclusionLabel = x.conclusion || '通过';
    return '<div class="card compact" style="padding:14px;border-radius:14px;margin-bottom:10px"><div class="row"><b>第' + x.round + '轮</b><span class="pill"><span class="muted">结论</span><b style="color:' + conclusionColor + '">' + escapeHtml(conclusionLabel) + '</b></span><span class="pill"><span class="muted">评级</span><b style="color:' + ({"S":"#34c724","A":"#3370ff","B+":"#3370ff","B":"#8f959e","B-":"#ff7d00","C":"#f54a45"}[x.rating] || "#8f959e") + '">' + escapeHtml(x.rating || "-") + '</b></span>' + (x.interviewer ? '<span class="pill"><span class="muted">面试官</span><b>' + escapeHtml(x.interviewer) + '</b></span>' : '') + '<span class="spacer"></span><span class="muted">' + escapeHtml(toBjTime(x.createdAt || "").slice(0, 16)) + '</span></div><div class="divider"></div><div style="margin-bottom:6px"><b style="color:var(--green)">✓ Pros</b><div class="muted" style="margin-top:4px">' + escapeHtml(x.pros || "-").replaceAll("\n", "<br/>") + '</div></div><div style="margin-bottom:6px"><b style="color:var(--red)">✗ Cons</b><div class="muted" style="margin-top:4px">' + escapeHtml(x.cons || "-").replaceAll("\n", "<br/>") + '</div></div><div><b style="color:var(--primary)">→ 下一轮考察</b><div class="muted" style="margin-top:4px">' + escapeHtml(x.focusNext || "-").replaceAll("\n", "<br/>") + '</div></div></div>';
  }).join("") : '<div class="muted">暂无面评</div>';

  const reviewPanel = '<div class="tabpanel" id="panel-review"><div class="divider"></div><div class="card compact" style="padding:14px;border-radius:14px"><div class="row"><div style="font-weight:900">新增/更新面评</div></div><div class="divider"></div><div class="row" style="gap:10px"><div class="field" style="min-width:120px"><label>轮次</label><select id="rvRound">' + roundOpts + '</select></div><div class="field" style="min-width:120px"><label>综合评级</label><select id="rvRating">' + rtOpts + '</select></div><div class="field" style="min-width:140px"><label>面试结论</label><select id="rvConclusion"><option value="通过">通过</option><option value="不通过">不通过</option></select></div></div><div class="field"><label>面试官</label><input id="rvInterviewer" list="interviewer-datalist" placeholder="填写面试官姓名" value="' + escapeHtml(req.user?.name || '') + '" /></div><div class="divider"></div><div class="field"><label>✓ Pros（优势与亮点）</label><textarea id="rvPros" rows="3" placeholder="候选人的优势和亮点"></textarea></div><div class="field"><label>✗ Cons（不足与风险）</label><textarea id="rvCons" rows="3" placeholder="候选人的不足和风险"></textarea></div><div class="field"><label>→ 下一轮考察点</label><textarea id="rvFocusNext" rows="3" placeholder="如果进入下一轮，需要重点考察的方向"></textarea></div><button class="btn primary" onclick="addReview()">提交面评</button></div><div style="height:12px"></div>' + reviewHtmlEnhanced + '</div>';

  // "Offer"tab — 所有登录用户可编辑
  const offerPanel = '<div class="tabpanel" id="panel-offer"><div class="divider"></div>' + offerHtml + '</div>';

  // admin 专用 JS 函数
  // 所有登录用户可用的 JS 函数
  const adminScripts = 'async function saveCandidate(){var payload={name:document.getElementById("editName").value,phone:document.getElementById("editPhone").value,email:document.getElementById("editEmail").value,source:document.getElementById("editSource").value,note:document.getElementById("editNote").value};var res=await fetch("/api/candidates/' + cid + '",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});if(res.ok)location.reload();else{var d=await res.json().catch(function(){return{}});alert(d.error||"保存失败")}}' +
      'async function updateStatus(){var v=document.getElementById("statusSelect").value;var res=await fetch("/api/candidates/' + cid + '/status",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:v})});if(res.ok)location.reload();else{var d=await res.json().catch(function(){return{}});alert(d.error||"更新失败")}}' +
      'async function saveFollow(){var payload={nextAction:document.getElementById("fuAction").value,followAt:document.getElementById("fuAt").value,note:document.getElementById("fuNote").value};var res=await fetch("/api/candidates/' + cid + '/follow",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});if(res.ok)location.reload();else{var d=await res.json().catch(function(){return{}});alert(d.error||"保存失败")}}' +
      'var _selectedInterviewers=[];' +
      'async function loadInterviewers(){try{var r=await fetch("/api/interviewers");if(r.ok){window._allInterviewers=await r.json()}else{window._allInterviewers=[]}}catch(e){window._allInterviewers=[]}}' +
      'function renderSelectedInterviewers(){var c=document.getElementById("selectedInterviewers");if(!c)return;c.innerHTML=_selectedInterviewers.map(function(iv){return \'<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:8px;background:rgba(51,112,255,.08);color:#3370ff;font-size:13px;font-weight:600">\'+iv.name+\'<span onclick="removeInterviewer(\\x27\'+iv.openId+\'\\x27)" style="cursor:pointer;opacity:.6;margin-left:2px">&times;</span></span>\'}).join("")}' +
      'function removeInterviewer(oid){_selectedInterviewers=_selectedInterviewers.filter(function(x){return x.openId!==oid});renderSelectedInterviewers()}' +
      'function addInterviewer(iv){if(_selectedInterviewers.some(function(x){return x.openId===iv.openId}))return;_selectedInterviewers.push(iv);renderSelectedInterviewers();document.getElementById("scInterviewerSearch").value="";document.getElementById("interviewerDropdown").style.display="none"}' +
      'function initInterviewerPicker(){var inp=document.getElementById("scInterviewerSearch");var dd=document.getElementById("interviewerDropdown");if(!inp||!dd)return;inp.addEventListener("focus",function(){showInterviewerDropdown(inp.value)});inp.addEventListener("input",function(){showInterviewerDropdown(inp.value)});document.addEventListener("click",function(e){if(!document.getElementById("interviewerPicker").contains(e.target)){dd.style.display="none"}})}' +
      'function showInterviewerDropdown(q){var dd=document.getElementById("interviewerDropdown");var all=window._allInterviewers||[];var selectedIds=_selectedInterviewers.map(function(x){return x.openId});var filtered=all.filter(function(iv){return selectedIds.indexOf(iv.openId)===-1&&(!q||iv.name.indexOf(q)>-1||(iv.department||"").indexOf(q)>-1||(iv.jobTitle||"").indexOf(q)>-1)}).slice(0,15);if(!filtered.length){dd.style.display="none";return}dd.innerHTML=filtered.map(function(iv){return \'<div onclick=\\x27addInterviewer(\'+JSON.stringify(iv)+\')\\x27 style="padding:8px 12px;cursor:pointer;display:flex;align-items:center;gap:8px;border-bottom:1px solid #f3f4f6" onmouseover="this.style.background=\\x27#f9fafb\\x27" onmouseout="this.style.background=\\x27#fff\\x27"><span style="font-weight:600;font-size:13px">\'+iv.name+\'</span><span style="font-size:11px;color:#9ca3af">\'+((iv.department||"")+" "+(iv.jobTitle||"")).trim()+\'</span></div>\'}).join("");dd.style.display="block"}' +
      'loadInterviewers().then(function(){initInterviewerPicker()});' +
      'function syncScAt(){var d=document.getElementById("scDate").value;var t=document.getElementById("scTime").value;document.getElementById("scAt").value=d&&t?d+"T"+t:""}' +
      'document.getElementById("scDate").addEventListener("change",syncScAt);document.getElementById("scTime").addEventListener("change",syncScAt);' +
      'var _scheduleSaving=false;async function saveSchedule(){syncScAt();if(_scheduleSaving)return;var atVal=document.getElementById("scAt").value;if(!atVal){alert("请选择面试日期和时间");return}_scheduleSaving=true;var btn=document.querySelector("#panel-schedule .btn.primary");if(btn){btn.textContent="保存中...";btn.disabled=true}var sc=document.getElementById("scSyncCalendar");var names=_selectedInterviewers.map(function(x){return x.name}).join(" / ");var openIds=_selectedInterviewers.map(function(x){return x.openId});var payload={round:Number(document.getElementById("scRound").value),scheduledAt:document.getElementById("scAt").value,interviewers:names,interviewerOpenIds:openIds,link:document.getElementById("scLink").value,location:document.getElementById("scLocation").value,syncStatus:document.getElementById("scSyncStatus").value,syncCalendar:sc&&sc.checked?"on":"off"};try{var res=await fetch("/api/candidates/' + cid + '/schedule",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});if(res.ok){showToast("✓ 面试安排已保存",res.json().then(function(d){return d.calendarSynced?"，已同步飞书日程":""}).catch(function(){return""}));setTimeout(function(){location.reload()},1500)}else{var d=await res.json().catch(function(){return{}});alert(d.error||"保存失败");if(btn){btn.textContent="保存面试安排";btn.disabled=false}_scheduleSaving=false}}catch(e){alert("网络错误");if(btn){btn.textContent="保存面试安排";btn.disabled=false}_scheduleSaving=false}}' +
      'function showToast(msg,extraPromise){var t=document.createElement("div");t.style.cssText="position:fixed;top:24px;left:50%;transform:translateX(-50%);background:#16a34a;color:#fff;padding:12px 28px;border-radius:12px;font-size:15px;font-weight:600;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,.15);transition:opacity .3s";t.textContent=msg;document.body.appendChild(t);if(extraPromise){extraPromise.then(function(s){if(s)t.textContent=msg+s})}setTimeout(function(){t.style.opacity="0";setTimeout(function(){t.remove()},300)},2000)}' +
      'var f=document.getElementById("resumeUploadForm");if(f){f.onsubmit=async function(e){e.preventDefault();var fileInput=f.querySelector("input[type=file]");var file=fileInput&&fileInput.files[0];if(!file){alert("请选择文件");return}var btn=f.querySelector("button[type=submit]");if(btn){btn.textContent="上传中...";btn.disabled=true}try{var signRes=await fetch("/api/resume/upload-url",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({candidateId:"' + cid + '",fileName:file.name,contentType:file.type||"application/octet-stream"})});var signData=await signRes.json();if(!signRes.ok||!signData.signedUrl){throw new Error(signData.error||"获取上传地址失败")}var upRes=await fetch(signData.signedUrl,{method:"PUT",headers:{"Content-Type":file.type||"application/octet-stream"},body:file});if(!upRes.ok){throw new Error("文件上传失败("+upRes.status+")")}var metaRes=await fetch("/api/candidates/' + cid + '/resume-meta",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({objectName:signData.objectName,originalName:file.name,contentType:file.type||"",size:file.size,bucket:signData.bucket})});if(!metaRes.ok){var md=await metaRes.json().catch(function(){return{}});throw new Error(md.error||"保存元数据失败")}location.reload()}catch(err){alert("上传失败："+err.message);if(btn){btn.textContent="上传";btn.disabled=false}}}}' +
      'async function quickStatus(st){if(!confirm("确认将状态更新为【"+st+"】？"))return;var r=await fetch("/api/candidates/' + cid + '/status",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:st})});if(r.ok)location.reload();else alert("更新失败")}' +
      'function prefillNextRound(n){switchTab("schedule");document.getElementById("scRound").value=n;document.getElementById("scDate").focus()}' +
      'async function sendNotify(){var btn=document.getElementById("notifyBtn");if(!btn)return;var msg=prompt("飞书通知内容（发给相关面试官）：","请关注候选人 ' + escapeHtml(c.name || "") + ' 的面试安排");if(!msg)return;btn.textContent="发送中...";btn.disabled=true;try{var r=await fetch("/api/candidates/' + cid + '/notify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:msg})});if(r.ok){btn.textContent="已发送";setTimeout(function(){btn.textContent="发送飞书通知";btn.disabled=false},2000)}else{alert("发送失败");btn.textContent="发送飞书通知";btn.disabled=false}}catch(e){alert("发送失败");btn.textContent="发送飞书通知";btn.disabled=false}}' +
      '';

  // 候选人进度条 — 显示当前所在流水线阶段
  const isRejected = c.status === '淘汰';
  const displayStages = PIPELINE_STAGES.filter(s => s.key !== 'rejected');
  const currentStageIdx = isRejected ? -1 : displayStages.findIndex(stage => stage.statuses.includes(c.status));
  const progressHtml = displayStages.map((stage, idx) => {
    const isCurrent = !isRejected && stage.statuses.includes(c.status);
    const isPast = !isRejected && idx < currentStageIdx && currentStageIdx >= 0;
    const cls = isCurrent ? 'progress-step active' : isPast ? 'progress-step done' : 'progress-step';
    return '<div class="' + cls + '"><div class="step-dot">' + (isPast ? '✓' : (idx + 1)) + '</div><div class="step-label">' + escapeHtml(stage.name) + '</div></div>';
  }).join('<div class="step-line"></div>');

  const avatarLetter = escapeHtml((c.name || "?").slice(0, 1));

  res.send(
    renderPage({
      title: "候选人：" + (c.name || ""),
      user: req.user,
      active: "candidates",
      contentHtml:
        // 顶部操作栏
        '<div class="row" style="margin-bottom:16px"><a class="btn" href="/candidates">← 返回列表</a><span class="spacer"></span>' + topActions + '</div>' +
        // 资料卡片 — Machinepulse招聘系统风格
        '<div class="card profile-card"><div class="profile-header">' +
        '<div class="profile-avatar" style="background:linear-gradient(135deg,#3370ff,#597ef7)">' + avatarLetter + '</div>' +
        '<div class="profile-info"><div class="profile-name">' + escapeHtml(c.name || "未命名") + ' ' + statusBadge(c.status) + ' ' + followupBadge(c.follow) + '</div>' +
        '<div class="profile-meta">' +
        '<span>📋 ' + escapeHtml(c.jobTitle || c.jobId || "未关联岗位") + '</span>' +
        '<span>📱 ' + escapeHtml(c.phone || "未填写") + '</span>' +
        '<span>📧 ' + escapeHtml(c.email || "未填写") + '</span>' +
        '<span>📍 ' + escapeHtml(c.source || "未知来源") + '</span>' +
        '</div>' +
        '<div style="margin-top:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
        (resume && resume.url ? '<a class="btn sm" href="' + escapeHtml(resume.url) + '" target="_blank" rel="noreferrer" style="background:rgba(51,112,255,.08)">📎 ' + escapeHtml((resume.originalName || resume.filename || "简历").slice(0, 20)) + '</a>' : '<span class="badge status-gray">暂无简历</span>') +
        (tagsHtml ? ' ' + tagsHtml : '') +
        '</div></div></div>' +
        // 进度条
        '<div class="progress-bar">' + progressHtml + '</div>' +
        '</div>' +
        (summaryHtml ? '<div style="height:14px"></div>' + summaryHtml : '') +
        '<div style="height:14px"></div>' +
        // 标签页
        '<div class="card">' +
        '<div class="tabs"><button class="tab active" data-tab="info" onclick="switchTab(\'info\')">信息</button><button class="tab" data-tab="follow" onclick="switchTab(\'follow\')">跟进</button><button class="tab" data-tab="schedule" onclick="switchTab(\'schedule\')">面试安排</button><button class="tab" data-tab="resume" onclick="switchTab(\'resume\')">简历</button><button class="tab" data-tab="review" onclick="switchTab(\'review\')">面评</button><button class="tab" data-tab="offer" onclick="switchTab(\'offer\')">Offer</button><button class="tab" data-tab="activity" onclick="switchTab(\'activity\')">动态</button></div>' +
        '<div class="tabpanels">' +
        infoPanel +
        followPanel +
        schedulePanel +
        resumePanel +
        reviewPanel +
        offerPanel +
        '<div class="tabpanel" id="panel-activity"><div class="divider"></div>' + eventHtml + '</div>' +
        '</div></div>' +
        '<script>function switchTab(t){document.querySelectorAll(".tab").forEach(function(e){e.classList.toggle("active",e.dataset.tab===t)});document.querySelectorAll(".tabpanel").forEach(function(p){p.classList.remove("active")});document.getElementById("panel-"+t).classList.add("active")}' +
        'async function addReview(){var rating=document.getElementById("rvRating").value;if(!rating){alert("请选择评级");return}var interviewer=document.getElementById("rvInterviewer").value.trim();if(!interviewer){alert("请填写面试官姓名");return}var pros=document.getElementById("rvPros").value.trim();var cons=document.getElementById("rvCons").value.trim();if(!pros&&!cons){alert("Pros和Cons至少填写一项");return}var payload={round:Number(document.getElementById("rvRound").value),conclusion:document.getElementById("rvConclusion").value,rating:rating,interviewer:interviewer,pros:pros,cons:cons,focusNext:document.getElementById("rvFocusNext").value};var res=await fetch("/api/candidates/' + cid + '/reviews",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});if(res.ok){var data=await res.json();if(data.autoFlowMsg){alert(data.autoFlowMsg)}location.reload()}else{var d=await res.json().catch(function(){return{}});alert(d.error||"提交失败")}}' +
        adminScripts +
        '</script>',
    })
  );
});

// 删除候选人
app.post("/candidates/:id/delete", requireLogin, requireAdmin, async (req, res) => {
  try {
    const d = await loadData();
    const idx = d.candidates.findIndex((x) => x.id === req.params.id);
    if (idx > -1) {
      const cid = d.candidates[idx].id;
      d.candidates.splice(idx, 1);
      d.interviews = d.interviews.filter((x) => x.candidateId !== cid);
      d.interviewSchedules = d.interviewSchedules.filter((x) => x.candidateId !== cid);
      d.resumeFiles = d.resumeFiles.filter((x) => x.candidateId !== cid);
      d.events = d.events.filter((x) => x.candidateId !== cid);
      d.offers = (d.offers || []).filter((x) => x.candidateId !== cid);
      await saveData(d);
      try { await deleteCandidateRelated(cid); } catch (e) { console.error("[Delete] Supabase 清理失败:", e.message); }
    }
    res.redirect(303, "/candidates");
  } catch (e) {
    console.error("[Delete] 删除候选人异常:", e.message);
    res.redirect(303, "/candidates");
  }
});

// ====== Offer 管理页 ======
app.get("/offers", requireLogin, async (req, res) => {
  const d = await loadData();
  const offers = d.offers || [];
  const candMap = new Map(d.candidates.map((c) => [c.id, c]));

  const rows = offers.map((o) => {
    const c = candMap.get(o.candidateId);
    return '<tr><td>' + (c ? '<a class="btn sm" href="/candidates/' + escapeHtml(c.id) + '">' + escapeHtml(c.name || "未命名") + '</a>' : escapeHtml(o.candidateId)) + '</td><td>' + escapeHtml(c?.jobTitle || "-") + '</td><td>' + escapeHtml(o.salary || "-") + '</td><td>' + escapeHtml(o.startDate || "-") + '</td><td>' + offerStatusBadge(o.offerStatus) + '</td><td class="muted">' + escapeHtml(toBjTime(o.updatedAt || o.createdAt || "").slice(0, 16)) + '</td></tr>';
  }).join("");

  const stats = { total: offers.length, pending: 0, sent: 0, accepted: 0, rejected: 0 };
  offers.forEach((o) => {
    if (o.offerStatus === "待发放") stats.pending++;
    else if (o.offerStatus === "已发放") stats.sent++;
    else if (o.offerStatus === "已接受") stats.accepted++;
    else if (o.offerStatus === "已拒绝" || o.offerStatus === "已撤回") stats.rejected++;
  });

  res.send(
    renderPage({
      title: "Offer管理",
      user: req.user,
      active: "offers",
      contentHtml: '<div class="row"><div style="font-weight:900;font-size:18px">Offer管理</div></div><div class="divider"></div>' +
        '<div class="row" style="margin-bottom:14px"><span class="pill"><span class="muted">总Offer</span><b>' + stats.total + '</b></span><span class="pill"><span class="muted">待发放</span><b>' + stats.pending + '</b></span><span class="pill"><span class="muted">已发放</span><b>' + stats.sent + '</b></span><span class="pill"><span class="muted">已接受</span><b>' + stats.accepted + '</b></span><span class="pill"><span class="muted">已拒绝/撤回</span><b>' + stats.rejected + '</b></span></div>' +
        '<div class="card"><table><thead><tr><th>候选人</th><th>岗位</th><th>薪资</th><th>入职日期</th><th>状态</th><th>更新时间</th></tr></thead><tbody>' + (rows || "") + '</tbody></table>' + (rows ? "" : '<div class="muted">暂无Offer记录，可在候选人详情页创建Offer</div>') + '</div>',
    })
  );
});

// ====== 设置 ======
app.get("/settings", requireLogin, requireAdmin, async (req, res) => {
  const d = await loadData();
  const sourcesHtml = (d.sources || []).map((s) => '<span class="pill">' + escapeHtml(s) + '</span>').join(" ");
  const tagsHtml = (d.tags || []).map((t) => tagBadge(t)).join(" ");

  // 用户管理列表
  const usersHtml = (d.users || []).map((u) => {
    const isCurrentUser = u.id === req.user?.id;
    const roleLabel = u.role === "admin"
      ? '<span class="badge status-blue" style="font-size:11px">管理员</span>'
      : '<span class="badge status-gray" style="font-size:11px">成员</span>';
    const providerLabel = u.provider === "feishu"
      ? '<span class="badge status-blue" style="font-size:11px">飞书</span>'
      : '<span class="badge status-gray" style="font-size:11px">快捷登录</span>';
    const toggleBtn = isCurrentUser
      ? '<span class="muted" style="font-size:12px">当前用户</span>'
      : (u.role === "admin"
          ? '<button class="btn sm" onclick="toggleRole(\'' + escapeHtml(u.id) + '\',\'member\')">降为成员</button>'
          : '<button class="btn sm primary" onclick="toggleRole(\'' + escapeHtml(u.id) + '\',\'admin\')">设为管理员</button>');
    return '<tr><td style="font-weight:700">' + escapeHtml(u.name || "未命名") + '</td><td>' + roleLabel + '</td><td>' + providerLabel + '</td><td class="muted" style="font-size:12px">' + escapeHtml(toBjTime(u.createdAt || "").slice(0, 10)) + '</td><td>' + toggleBtn + '</td></tr>';
  }).join("");

  const userMgmtHtml = '<div class="card" style="margin-top:14px">' +
    '<div style="font-weight:900;font-size:18px">用户管理</div>' +
    '<div class="muted">管理系统用户和角色权限。管理员拥有全部操作权限，成员仅可查看数据和提交面评。</div>' +
    '<div class="divider"></div>' +
    (d.users.length
      ? '<table><thead><tr><th>姓名</th><th>角色</th><th>登录方式</th><th>注册时间</th><th>操作</th></tr></thead><tbody>' + usersHtml + '</tbody></table>'
      : '<div class="muted">暂无用户</div>') +
    '</div>' +
    '<script>function toggleRole(userId,newRole){if(!confirm(newRole==="admin"?"确认将该用户设为管理员？":"确认将该用户降为普通成员？"))return;fetch("/api/users/"+userId+"/role",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({role:newRole})}).then(r=>{if(r.ok)location.reload();else r.json().then(d=>alert(d.error||"操作失败")).catch(()=>alert("操作失败"))}).catch(()=>alert("网络错误"))}</script>';

  res.send(
    renderPage({
      title: "设置",
      user: req.user,
      active: "settings",
      contentHtml: '<div class="card"><div style="font-weight:900;font-size:18px">设置</div><div class="divider"></div>' +
        '<div class="field"><label>当前来源</label><div class="row">' + (sourcesHtml || '<span class="muted">暂无</span>') + '</div></div>' +
        '<form method="POST" action="/settings/sources" class="row"><input name="source" placeholder="新增来源（例如：脉脉/拉勾/校园）" style="max-width:420px" /><button class="btn primary" type="submit">新增来源</button></form>' +
        '<div class="divider"></div>' +
        '<div class="field"><label>候选人标签</label><div class="row">' + (tagsHtml || '<span class="muted">暂无</span>') + '</div></div>' +
        '<form method="POST" action="/settings/tags" class="row"><input name="tag" placeholder="新增标签（例如：高潜/紧急/校招）" style="max-width:420px" /><button class="btn primary" type="submit">新增标签</button></form>' +
        '</div>' +
        userMgmtHtml,
    })
  );
});

app.post("/settings/sources", requireLogin, requireAdmin, async (req, res) => {
  const d = await loadData();
  const s = String(req.body.source || "").trim();
  if (s && !d.sources.includes(s)) d.sources.push(s);
  await saveData(d);
  res.redirect(303, "/settings");
});

app.post("/settings/tags", requireLogin, requireAdmin, async (req, res) => {
  const d = await loadData();
  const t = String(req.body.tag || "").trim();
  if (t && !d.tags.includes(t)) d.tags.push(t);
  await saveData(d);
  res.redirect(303, "/settings");
});

// ====== 从飞书同步通讯录 ======
app.post("/api/users/sync-feishu", requireLogin, requireAdmin, async (req, res) => {
  try {
    const employees = await getAllFeishuEmployees();
    if (!employees.length) return res.redirect(303, "/settings");
    const d = await loadData();
    let added = 0;
    for (const emp of employees) {
      const existing = d.users.find(u => u.openId === emp.openId);
      if (existing) {
        existing.name = emp.name || existing.name;
        existing.avatar = emp.avatar || existing.avatar;
        existing.department = emp.department || existing.department;
        existing.jobTitle = emp.jobTitle || existing.jobTitle;
      } else {
        d.users.push({
          id: rid("usr"),
          openId: emp.openId,
          unionId: emp.unionId || "",
          name: emp.name,
          avatar: emp.avatar,
          department: emp.department || "",
          jobTitle: emp.jobTitle || "",
          provider: "feishu",
          createdAt: nowIso(),
        });
        added++;
      }
    }
    await saveData(d);
    res.redirect(303, "/settings");
  } catch (e) {
    console.error("[Sync] 飞书通讯录同步失败:", e.message);
    res.redirect(303, "/settings");
  }
});

// ====== 用户角色切换 ======
app.post("/api/users/:id/role", requireLogin, requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const newRole = String(req.body?.role || "").trim();
    if (newRole !== "admin" && newRole !== "member") {
      return res.status(400).json({ error: "无效的角色，仅支持 admin 或 member" });
    }
    if (userId === req.user?.id) {
      return res.status(400).json({ error: "不能修改自己的角色" });
    }
    const d = await loadData();
    const targetUser = d.users.find(u => u.id === userId);
    if (!targetUser) {
      return res.status(404).json({ error: "用户不存在" });
    }
    targetUser.role = newRole;
    await saveData(d);
    res.json({ ok: true, userId, role: newRole });
  } catch (e) {
    console.error("[Role] 角色修改失败:", e.message);
    res.status(500).json({ error: "操作失败" });
  }
});

// ====== 面试日程页面 ======
app.get("/schedule", requireLogin, async (req, res) => {
  const d = await loadData();
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

  // 按日期分组面试
  const schedulesByDate = {};
  for (const s of schedules) {
    const dt = (s.scheduledAt || "").slice(0, 10);
    if (!dt) continue;
    if (!schedulesByDate[dt]) schedulesByDate[dt] = [];
    const c = d.candidates.find(x => x.id === s.candidateId);
    const review = d.interviews.find(x => x.candidateId === s.candidateId && x.round === s.round);
    schedulesByDate[dt].push({ ...s, candName: c?.name || "未知", candId: c?.id, jobTitle: c?.jobTitle || "", hasReview: !!review });
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

  // ====== 列表视图 ======
  const renderScheduleRow = (s) => {
    const c = d.candidates.find(x => x.id === s.candidateId);
    const candName = c ? escapeHtml(c.name) : "未知候选人";
    const jobTitle = c ? escapeHtml(c.jobTitle || "-") : "-";
    const review = d.interviews.find(x => x.candidateId === s.candidateId && x.round === s.round);
    const reviewBadge = review ? `<span class="badge status-green">${escapeHtml(review.rating || "已评")}</span>` : '<span class="badge status-gray">待评</span>';
    const statusBadge = c ? `<span class="badge">${escapeHtml(c.status || "待筛选")}</span>` : "";
    return `<tr>
      <td><strong>${candName}</strong><br><span class="muted">${jobTitle}</span></td>
      <td>第${s.round}轮</td>
      <td>${escapeHtml(s.scheduledAt)}</td>
      <td>${escapeHtml(s.interviewers || "-")}</td>
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
app.get("/api/interviewers", requireLogin, async (req, res) => {
  const d = await loadData();
  const interviewers = d.users
    .filter(u => u.name && u.openId)
    .map(u => ({ id: u.id, name: u.name, openId: u.openId, avatar: u.avatar || "", department: u.department || "", jobTitle: u.jobTitle || "" }));
  res.json(interviewers);
});

// ====== API: 搜索飞书通讯录用户 ======
app.get("/api/feishu/search-users", requireLogin, async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json([]);
  if (!feishuEnabled()) {
    // 飞书未启用，回退到本地用户列表
    const d = await loadData();
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

// ====== API 路由 ======
app.get("/api/candidates/:id", requireLogin, async (req, res) => {
  const d = await loadData();
  const c = d.candidates.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "not_found" });
  const visibleJobIds = getVisibleJobIds(req.user, d.jobs);
  if (visibleJobIds !== null && !visibleJobIds.has(c.jobId)) return res.status(403).json({ error: "no_permission" });
  if (!c.follow) c.follow = { nextAction: "待联系", followAt: "", note: "" };
  if (!Array.isArray(c.tags)) c.tags = [];

  var resume = d.resumeFiles.filter((r) => r.candidateId === c.id && r.url).sort((a, b) => (b.uploadedAt || "").localeCompare(a.uploadedAt || ""))[0];
  resume = await refreshResumeUrlIfNeeded(resume);

  const reviews = d.interviews.filter((x) => x.candidateId === c.id).sort((a, b) => (a.round - b.round));
  const schedules = d.interviewSchedules.filter((x) => x.candidateId === c.id).sort((a, b) => (a.round - b.round));
  const events = d.events.filter((e) => e.candidateId === c.id).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  res.json({ ...c, resume: resume || null, reviews, schedules, events });
});

app.post("/api/candidates/:id", requireLogin, async (req, res) => {
  const d = await loadData();
  const c = d.candidates.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "not_found" });
  { const vj = getVisibleJobIds(req.user, d.jobs); if (vj !== null && !vj.has(c.jobId)) return res.status(403).json({ error: "no_permission" }); }

  const before = { ...c };
  const name = String(req.body.name ?? "").trim();
  const phone = String(req.body.phone ?? "").trim();
  const email = String(req.body.email ?? "").trim();
  const source = String(req.body.source ?? "").trim();
  const note = String(req.body.note ?? "").trim();

  if (name) c.name = name;
  c.phone = phone;
  c.email = email;
  c.source = source;
  c.note = note;
  if (Array.isArray(req.body.tags)) c.tags = req.body.tags.filter(Boolean);
  c.updatedAt = nowIso();

  if (source && !d.sources.includes(source)) d.sources.push(source);

  const changes = [];
  if (before.name !== c.name) changes.push("姓名：" + (before.name || "-") + " -> " + (c.name || "-"));
  if (before.phone !== c.phone) changes.push("手机：" + (before.phone || "-") + " -> " + (c.phone || "-"));
  if (before.email !== c.email) changes.push("邮箱：" + (before.email || "-") + " -> " + (c.email || "-"));
  if (before.source !== c.source) changes.push("来源：" + (before.source || "-") + " -> " + (c.source || "-"));
  if (before.note !== c.note && c.note) changes.push("备注已更新");

  if (changes.length) {
    pushEvent(d, { candidateId: c.id, type: "编辑", message: changes.join("\n"), actor: req.user?.name || "系统" });
  }
  await saveData(d);
  res.json({ ok: true });
});

app.post("/api/candidates/:id/status", requireLogin, async (req, res) => {
  const d = await loadData();
  const c = d.candidates.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "not_found" });
  { const vj = getVisibleJobIds(req.user, d.jobs); if (vj !== null && !vj.has(c.jobId)) return res.status(403).json({ error: "no_permission" }); }

  const old = c.status || "待筛选";
  const status = String(req.body.status || "待筛选");
  c.status = STATUS_SET.has(status) ? status : "待筛选";
  c.updatedAt = nowIso();

  pushEvent(d, { candidateId: c.id, type: "状态流转", message: "状态：" + old + " -> " + c.status, actor: req.user?.name || "系统" });
  await saveData(d);

  if (feishuEnabled() && req.user?.openId) {
    sendFeishuMessage(req.user.openId,
      `**候选人**：${c.name}\n**状态变更**：${old} → ${c.status}\n**操作人**：${req.user?.name || "系统"}`,
      "候选人状态变更"
    ).catch(() => {});
  }

  res.json({ ok: true });
});

app.post("/api/candidates/:id/follow", requireLogin, async (req, res) => {
  const d = await loadData();
  const c = d.candidates.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "not_found" });

  const nextAction = String(req.body.nextAction || "").trim();
  const followAt = String(req.body.followAt || "").trim();
  const note = String(req.body.note || "").trim();
  c.follow = { nextAction, followAt, note };
  c.updatedAt = nowIso();

  pushEvent(d, { candidateId: c.id, type: "跟进", message: "下一步：" + (nextAction || "-") + "\n跟进时间：" + (followAt || "-") + "\n" + (note || ""), actor: req.user?.name || "系统" });
  await saveData(d);
  res.json({ ok: true });
});

app.post("/api/candidates/:id/notify", requireLogin, async (req, res) => {
  if (!feishuEnabled()) return res.status(400).json({ error: "feishu_not_enabled" });
  const d = await loadData();
  const c = d.candidates.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "not_found" });

  const message = String(req.body.message || "").trim();
  if (!message) return res.status(400).json({ error: "empty_message" });

  const relatedSchedules = (d.interviewSchedules || []).filter(s => s.candidateId === c.id);
  const interviewerNames = new Set();
  relatedSchedules.forEach(s => {
    (s.interviewers || "").split(/[\/,\s]+/).forEach(n => { if (n.trim()) interviewerNames.add(n.trim()); });
  });

  const candidateUrl = `${req.protocol}://${req.get("host")}/candidates/${c.id}?lk_jump_to_browser=true`;
  const manualNotifyBtn = {
    tag: "action",
    actions: [{ tag: "button", text: { tag: "plain_text", content: "📋 查看候选人详情" }, url: candidateUrl, type: "primary" }],
  };
  const sentTo = [];
  for (const name of interviewerNames) {
    const u = d.users.find(x => x.name === name && x.openId);
    if (u) {
      sendFeishuMessage(u.openId, `**候选人**：${c.name}\n**职位**：${c.jobTitle || "-"}\n**状态**：${c.status || "-"}\n\n${message}`, "招聘提醒", [manualNotifyBtn]).catch(() => {});
      sentTo.push(name);
    }
  }

  if (req.user?.openId) {
    sendFeishuMessage(req.user.openId, `你发送了一条关于候选人「${c.name}」的通知\n\n${message}`, "通知已发送", [manualNotifyBtn]).catch(() => {});
  }

  pushEvent(d, { candidateId: c.id, type: "飞书通知", message: "手动发送通知：" + message + "\n通知对象：" + (sentTo.length ? sentTo.join("、") : "无匹配面试官"), actor: req.user?.name || "系统" });
  await saveData(d);
  res.json({ ok: true, sentTo });
});

app.post("/api/candidates/:id/schedule", requireLogin, async (req, res) => {
  const d = await loadData();
  const c = d.candidates.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).send("candidate_not_found");
  { const vj = getVisibleJobIds(req.user, d.jobs); if (vj !== null && !vj.has(c.jobId)) return res.status(403).json({ error: "no_permission" }); }

  const round = Number(req.body.round || 1);
  if (!INTERVIEW_ROUNDS.includes(round)) return res.status(400).send("invalid_round");

  const scheduledAt = String(req.body.scheduledAt || "").trim();
  const interviewers = String(req.body.interviewers || "").trim();
  const link = String(req.body.link || "").trim();
  const location = String(req.body.location || "").trim();
  const syncStatus = String(req.body.syncStatus || "（不同步）").trim();

  const idx = d.interviewSchedules.findIndex((x) => x.candidateId === c.id && x.round === round);
  // 为每个面试官生成独立 reviewToken（面试官免登录填面评用）
  const existingToken = idx > -1 ? d.interviewSchedules[idx].reviewToken : "";
  const reviewToken = existingToken || rid("rt");
  const item = {
    id: idx > -1 ? d.interviewSchedules[idx].id : rid("sc"),
    candidateId: c.id,
    round,
    scheduledAt,
    interviewers,
    link,
    location,
    reviewToken,
    meetingNo: idx > -1 ? (d.interviewSchedules[idx].meetingNo || "") : "",
    recordingUrl: idx > -1 ? (d.interviewSchedules[idx].recordingUrl || "") : "",
    calendarEventId: idx > -1 ? (d.interviewSchedules[idx].calendarEventId || "") : "",
    createdAt: idx > -1 ? d.interviewSchedules[idx].createdAt : nowIso(),
    updatedAt: nowIso(),
  };
  // 判断是否需要重新创建日历事件：时间或面试官变化时才重新创建
  const prevSchedule = idx > -1 ? d.interviewSchedules[idx] : null;
  const scheduleChanged = !prevSchedule || prevSchedule.scheduledAt !== scheduledAt || prevSchedule.interviewers !== interviewers;
  const alreadyHasCalendar = !!(prevSchedule?.calendarEventId);
  if (idx > -1) d.interviewSchedules[idx] = item;
  else d.interviewSchedules.push(item);

  pushEvent(d, { candidateId: c.id, type: "面试安排", message: "第" + round + "轮\n时间：" + (scheduledAt || "-") + "\n面试官：" + (interviewers || "-"), actor: req.user?.name || "系统" });

  if (syncStatus && syncStatus !== "（不同步）" && STATUS_SET.has(syncStatus)) {
    const old = c.status || "待筛选";
    c.status = syncStatus;
    c.updatedAt = nowIso();
    if (old !== c.status) {
      pushEvent(d, { candidateId: c.id, type: "状态同步", message: "因面试安排同步，状态：" + old + " -> " + c.status, actor: "系统" });
    }
  } else if (syncStatus === "（不同步）" && scheduledAt) {
    const old = c.status || "待筛选";
    const autoFlowRules = [
      { round: 1, from: ["待筛选", "简历初筛"], to: "待一面" },
      { round: 2, from: ["一面通过", "待一面"], to: "待二面" },
      { round: 3, from: ["二面通过", "待二面"], to: "待三面" },
      { round: 4, from: ["三面通过", "待三面"], to: "待四面" },
      { round: 5, from: ["四面通过", "待四面"], to: "待五面" },
    ];
    const rule = autoFlowRules.find(r => r.round === round);
    if (rule && rule.from.includes(old)) {
      c.status = rule.to;
      c.updatedAt = nowIso();
      pushEvent(d, { candidateId: c.id, type: "自动流转", message: "安排第" + round + "轮面试，状态：" + old + " -> " + rule.to, actor: "系统" });
    }
  }
  const followActionMap = { 1: "等面试反馈", 2: "等面试反馈", 3: "等面试反馈", 4: "等面试反馈", 5: "等面试反馈" };
  if (scheduledAt && followActionMap[round]) {
    if (!c.follow) c.follow = {};
    c.follow.nextAction = followActionMap[round];
    c.follow.followAt = scheduledAt.slice(0, 10);
  }
  await saveData(d);

  // 收集面试官 openId（优先用前端传来的 interviewerOpenIds，兜底按姓名匹配）
  const reqOpenIds = Array.isArray(req.body.interviewerOpenIds) ? req.body.interviewerOpenIds.filter(Boolean) : [];
  let attendeeOpenIds = reqOpenIds;
  if (!attendeeOpenIds.length && interviewers) {
    const interviewerNames = interviewers.split(/[\/;,、]/).map(n => n.trim()).filter(Boolean);
    for (const name of interviewerNames) {
      const usr = d.users.find(u => u.name === name && u.openId);
      if (usr) attendeeOpenIds.push(usr.openId);
    }
  }

  // 把当前操作人（HR）也加入日历参与人，确保 HR 能收到日程
  if (req.user?.openId && !attendeeOpenIds.includes(req.user.openId)) {
    attendeeOpenIds.push(req.user.openId);
  }

  console.log("[Schedule] syncCalendar:", req.body.syncCalendar, "feishuEnabled:", feishuEnabled(), "scheduledAt:", scheduledAt, "attendeeOpenIds:", attendeeOpenIds, "interviewers:", interviewers);
  let meetingUrl = "";
  let calendarSynced = false;
  const shouldCreateCalendar = feishuEnabled() && scheduledAt && req.body.syncCalendar === "on" && (scheduleChanged || !alreadyHasCalendar);
  if (shouldCreateCalendar) {
    try {
      // scheduledAt 是用户输入的中国时间（如 "2026-02-12 14:00" 或 "2026-02-12T14:00"）
      // Vercel 服务器运行在 UTC 时区，需要手动按 +8 偏移转换
      const localStr = scheduledAt.replace(" ", "T");
      // 如果输入不含时区后缀，当作 Asia/Shanghai（UTC+8）处理
      const hasTimezone = /[Zz]|[+-]\d{2}:?\d{2}$/.test(localStr);
      const startDt = hasTimezone
        ? new Date(localStr)
        : new Date(localStr + "+08:00");
      const endDt = new Date(startDt.getTime() + 60 * 60 * 1000);
      console.log("[Schedule] 同步飞书日历, attendees:", attendeeOpenIds.length, "人, 用户输入:", scheduledAt, "转换UTC:", startDt.toISOString());
      const calResult = await createFeishuCalendarEvent({
        summary: `面试：${c.name} - ${c.jobTitle || "未知岗位"} - 第${round}轮`,
        description: `候选人：${c.name}\n职位：${c.jobTitle || "-"}\n轮次：第${round}轮\n面试官：${interviewers || "-"}\n${link ? "链接：" + link : ""}${location ? "\n地点：" + location : ""}`,
        startTime: startDt.toISOString(),
        endTime: endDt.toISOString(),
        attendeeOpenIds,
      });
      console.log("[Schedule] 日历同步结果:", JSON.stringify({ code: calResult?.code, eventId: calResult?.eventId, meetingUrl: calResult?.meetingUrl }));
      calendarSynced = true;
      // 保存飞书日历事件ID + 会议链接到日程记录
      const scIdx = d.interviewSchedules.findIndex(x => x.candidateId === c.id && x.round === round);
      if (scIdx > -1) {
        if (calResult?.eventId) {
          d.interviewSchedules[scIdx].calendarEventId = calResult.eventId;
        }
        if (calResult?.meetingUrl) {
          meetingUrl = calResult.meetingUrl;
          d.interviewSchedules[scIdx].link = meetingUrl;
          d.interviewSchedules[scIdx].meetingUrl = meetingUrl;
          // 提取会议号，后续用于查询录制/妙记
          const mNoMatch = meetingUrl.match(/\/j\/(\d+)/);
          if (mNoMatch) d.interviewSchedules[scIdx].meetingNo = mNoMatch[1];
        }
        await saveData(d);
        console.log("[Schedule] 日历事件已保存, eventId:", calResult?.eventId || "-", "meetingUrl:", meetingUrl || "-");
      }
    } catch (e) {
      console.error("[Feishu Calendar] 异常:", e.message);
    }
  }

  // 发送飞书消息通知面试官（含面评链接 + 候选人页面按钮）
  const notifyPromises = [];
  const locationInfo = meetingUrl ? `飞书会议：${meetingUrl}` : (location || link || "-");
  // 构建面评链接 — 取最新的 reviewToken
  const latestSc = d.interviewSchedules.find(x => x.candidateId === c.id && x.round === round);
  const reviewLink = latestSc?.reviewToken ? `${req.protocol}://${req.get("host")}/review/${latestSc.reviewToken}?lk_jump_to_browser=true` : "";
  const reviewLine = reviewLink ? `\n**📝 填写面评**：[点击填写](${reviewLink})` : "";
  // 构建候选人页面链接按钮（加 lk_jump_to_browser=true 让飞书自动用浏览器打开）
  const candidateUrl = `${req.protocol}://${req.get("host")}/candidates/${c.id}?lk_jump_to_browser=true`;
  const notifyButtons = {
    tag: "action",
    actions: [
      { tag: "button", text: { tag: "plain_text", content: "📋 查看候选人详情" }, url: candidateUrl, type: "primary" },
      ...(reviewLink ? [{ tag: "button", text: { tag: "plain_text", content: "📝 填写面评" }, url: reviewLink, type: "default" }] : []),
    ],
  };
  const msgContent = `**候选人**：${c.name}\n**职位**：${c.jobTitle || "-"}\n**轮次**：第${round}轮\n**时间**：${scheduledAt}\n**地点/会议**：${locationInfo}`;
  if (feishuEnabled() && scheduledAt && attendeeOpenIds.length > 0) {
    for (const oid of attendeeOpenIds) {
      notifyPromises.push(
        sendFeishuMessage(oid, msgContent, "面试安排通知", [notifyButtons]).catch(() => {})
      );
    }
  } else if (feishuEnabled() && scheduledAt && interviewers) {
    // 兜底：按姓名匹配发通知
    const interviewerNames = interviewers.split(/[\/;,、]/).map(n => n.trim()).filter(Boolean);
    for (const name of interviewerNames) {
      const usr = d.users.find(u => u.name === name && u.openId);
      if (usr) {
        notifyPromises.push(
          sendFeishuMessage(usr.openId, msgContent, "面试安排通知", [notifyButtons]).catch(() => {})
        );
      }
    }
  }
  if (notifyPromises.length > 0) {
    await Promise.all(notifyPromises);
  }

  const skipReason = (!shouldCreateCalendar && feishuEnabled() && scheduledAt && req.body.syncCalendar === "on") ? "日历事件已存在且时间/面试官未变更，跳过重复创建" : "";
  if (skipReason) console.log("[Schedule]", skipReason);
  res.json({ ok: true, calendarSynced });
});

app.post("/api/candidates/:id/reviews", requireLogin, async (req, res) => {
  const d = await loadData();
  const c = d.candidates.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "not_found" });
  { const vj = getVisibleJobIds(req.user, d.jobs); if (vj !== null && !vj.has(c.jobId)) return res.status(403).json({ error: "no_permission" }); }

  const round = Number(req.body.round || 1);
  const conclusion = String(req.body.conclusion || "通过");
  const rating = String(req.body.rating || "");
  var pros = String(req.body.pros || "");
  var cons = String(req.body.cons || "");
  var focusNext = String(req.body.focusNext || "");
  const interviewer = String(req.body.interviewer || req.user?.name || "");

  const note = String(req.body.note || "");
  if (!pros && !cons && !focusNext && note) pros = note;

  if (!INTERVIEW_ROUNDS.includes(round)) return res.status(400).send("invalid_round");
  if (rating && !INTERVIEW_RATING.includes(rating)) return res.status(400).send("invalid_rating");

  const idx = d.interviews.findIndex((x) => x.candidateId === c.id && x.round === round && (x.interviewer || "") === interviewer);
  const item = {
    id: idx > -1 ? d.interviews[idx].id : rid("rv"),
    candidateId: c.id,
    round,
    conclusion,
    rating,
    interviewer,
    pros,
    cons,
    focusNext,
    note: idx > -1 ? d.interviews[idx].note : "",
    createdAt: nowIso(),
  };
  if (idx > -1) d.interviews[idx] = item;
  else d.interviews.push(item);

  let autoFlowMsg = "";
  const RATING_SCORES = { S: 5, A: 4, "B+": 3.5, B: 3, "B-": 2, C: 1 };
  const ratingScore = RATING_SCORES[rating] || 0;

  const old = c.status || "待筛选";

  if (rating === "B-" || rating === "C") {
    c.status = status;
    autoFlowMsg = "评级为" + rating + "，建议标记该候选人为淘汰状态。";
  } else if (ratingScore >= 3.5) {
    const passStatusMap = { 1: "一面通过", 2: "二面通过", 3: "三面通过", 4: "四面通过", 5: "五面通过" };
    const passStatus = passStatusMap[round];
    if (passStatus && STATUS_SET.has(passStatus)) {
      c.status = passStatus;
      if (round >= 5) {
        c.status = "待发offer";
        autoFlowMsg = "第" + round + "轮面试通过（评级" + rating + "），已自动流转到「待发Offer」。";
      } else {
        autoFlowMsg = "评级" + rating + "，已自动流转到「" + passStatus + "」。";
      }
    } else {
      c.status = status;
    }
  } else {
    c.status = status;
  }
  c.updatedAt = nowIso();

  pushEvent(d, { candidateId: c.id, type: "面评", message: "第" + round + "轮（" + interviewer + "）：进度=" + status + "，评级=" + (rating || "-") + "\nPros：" + (pros || "-") + "\nCons：" + (cons || "-"), actor: req.user?.name || "系统" });
  if (old !== c.status) {
    pushEvent(d, { candidateId: c.id, type: "状态同步", message: "因面评更新，状态：" + old + " -> " + c.status, actor: "系统" });
  }
  if (!c.follow) c.follow = {};
  if (c.status === "淘汰") {
    c.follow.nextAction = "已结束";
    c.follow.note = (c.follow.note ? c.follow.note + "\n" : "") + "第" + round + "轮面试淘汰";
  } else if (c.status.includes("通过")) {
    c.follow.nextAction = "安排下一轮面试";
    c.follow.followAt = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  } else if (c.status === "待发offer") {
    c.follow.nextAction = "准备Offer";
  }
  await saveData(d);
  res.json({ ok: true, autoFlowMsg });
});

// ====== 面试官免登录面评入口 ======

// 公开页面：面试官通过 token 直接填写面评（无需登录）
app.get("/review/:token", async (req, res) => {
  const d = await loadData();
  const sc = d.interviewSchedules.find(x => x.reviewToken === req.params.token);
  if (!sc) {
    return res.send(renderPage({ title: "链接无效", user: null, active: "", contentHtml: '<div class="card"><div style="font-weight:900;font-size:18px;margin-bottom:12px">面评链接无效或已过期</div><div class="muted">请联系 HR 获取新的面评链接。</div></div>' }));
  }
  const c = d.candidates.find(x => x.id === sc.candidateId);
  if (!c) {
    return res.send(renderPage({ title: "候选人不存在", user: null, active: "", contentHtml: '<div class="card"><div style="font-weight:900">候选人不存在</div></div>' }));
  }

  // 检查是否已有面评
  const existingReview = d.interviews.find(x => x.candidateId === c.id && x.round === sc.round && x.interviewer === (sc.interviewers || ""));
  const isSubmitted = !!(existingReview && existingReview.rating);

  // 查看会议录制链接
  const recordingBtn = sc.recordingUrl ? '<a class="btn sm" href="' + escapeHtml(sc.recordingUrl) + '" target="_blank" rel="noreferrer" style="background:rgba(59,130,246,.08);color:#1d4ed8;margin-bottom:12px">🎬 查看会议录制/妙记</a>' : '';
  const meetingBtn = sc.meetingUrl || sc.link ? '<a class="btn sm" href="' + escapeHtml(sc.meetingUrl || sc.link) + '" target="_blank" rel="noreferrer" style="background:rgba(51,112,255,.08);color:#3370ff;margin-bottom:12px">📹 会议链接</a>' : '';

  const rtOpts = INTERVIEW_RATING.map(x => '<option value="' + x + '" ' + (existingReview?.rating === x ? 'selected' : '') + '>' + x + '</option>').join("");

  const html = '<div class="card" style="max-width:640px;margin:24px auto">' +
    '<div style="font-weight:900;font-size:18px;margin-bottom:4px">面试反馈填写</div>' +
    '<div class="muted" style="margin-bottom:16px">面试结束后请及时填写面评，感谢！</div>' +
    '<div class="divider"></div>' +
    '<div class="row" style="margin-bottom:12px;flex-wrap:wrap;gap:8px">' +
      '<span class="pill"><span class="muted">候选人</span><b>' + escapeHtml(c.name) + '</b></span>' +
      '<span class="pill"><span class="muted">岗位</span><b>' + escapeHtml(c.jobTitle || c.jobId || "-") + '</b></span>' +
      '<span class="pill"><span class="muted">轮次</span><b>第' + sc.round + '轮</b></span>' +
      '<span class="pill"><span class="muted">时间</span><b>' + escapeHtml(toBjTime(sc.scheduledAt || "") || "-") + '</b></span>' +
    '</div>' +
    (meetingBtn || recordingBtn ? '<div class="row" style="gap:8px;flex-wrap:wrap">' + meetingBtn + recordingBtn + '</div>' : '') +
    (sc.recordingUrl ? '' : (sc.meetingNo || sc.meetingUrl ? '<div style="margin-bottom:12px"><button class="btn sm" id="refreshRecBtn" onclick="refreshRecording()" style="background:rgba(34,197,94,.08);color:#16a34a">🔄 刷新会议录制链接</button></div>' : '')) +
    (isSubmitted ? '<div class="card compact" style="padding:12px;border-radius:14px;margin-bottom:16px;background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.15)"><div style="font-weight:700;color:#16a34a;margin-bottom:6px">✅ 已提交面评</div><div class="muted">结论：' + escapeHtml(existingReview.conclusion || "通过") + '　评级：' + escapeHtml(existingReview.rating || "-") + '</div><div class="muted">Pros：' + escapeHtml(existingReview.pros || "-") + '</div><div class="muted">Cons：' + escapeHtml(existingReview.cons || "-") + '</div><div class="muted" style="margin-top:8px;font-size:12px">你可以重新填写覆盖之前的面评。</div></div>' : '') +
    '<div class="divider"></div>' +
    '<form id="reviewForm">' +
      '<div class="field"><label>面试官姓名</label><input id="rvInterviewer" value="' + escapeHtml(sc.interviewers || "") + '" placeholder="你的姓名" required /></div>' +
      '<div class="field"><label>综合评级 <span class="muted" style="font-size:12px">S=卓越 A=优秀 B+=良好 B=合格 B-=待提升 C=不通过</span></label><select id="rvRating" required><option value="">请选择</option>' + rtOpts + '</select></div>' +
      '<div class="field"><label>面试结论</label><select id="rvConclusion"><option value="通过"' + (existingReview?.conclusion === '通过' ? ' selected' : '') + '>通过</option><option value="不通过"' + (existingReview?.conclusion === '不通过' ? ' selected' : '') + '>不通过</option></select></div>' +
      '<div class="divider"></div>' +
      '<div class="field"><label>Pros（优势和亮点）</label><textarea id="rvPros" rows="4" placeholder="候选人的优势、能力亮点、让你印象深刻的地方">' + escapeHtml(existingReview?.pros || '') + '</textarea></div>' +
      '<div class="field"><label>Cons（不足和风险）</label><textarea id="rvCons" rows="4" placeholder="候选人的不足、潜在风险、需要关注的地方">' + escapeHtml(existingReview?.cons || '') + '</textarea></div>' +
      '<div class="field"><label>下一轮考察点</label><textarea id="rvFocusNext" rows="3" placeholder="如果进入下一轮，建议重点考察的方向">' + escapeHtml(existingReview?.focusNext || '') + '</textarea></div>' +
      '<button class="btn primary" type="submit" id="submitBtn" style="width:100%;margin-top:8px">提交面评</button>' +
    '</form></div>' +
    '<script>' +
    'document.getElementById("reviewForm").onsubmit=async function(e){e.preventDefault();' +
    'var rating=document.getElementById("rvRating").value;if(!rating){alert("请选择评级");return}' +
    'var interviewer=document.getElementById("rvInterviewer").value.trim();if(!interviewer){alert("请填写面试官姓名");return}' +
    'var pros=document.getElementById("rvPros").value.trim();var cons=document.getElementById("rvCons").value.trim();' +
    'if(!pros&&!cons){alert("Pros和Cons至少填写一项");return}' +
    'var btn=document.getElementById("submitBtn");btn.textContent="提交中...";btn.disabled=true;' +
    'try{var r=await fetch("/api/review/' + escapeHtml(req.params.token) + '",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({rating:rating,conclusion:document.getElementById("rvConclusion").value,interviewer:interviewer,pros:pros,cons:cons,focusNext:document.getElementById("rvFocusNext").value})});' +
    'var data=await r.json();if(r.ok){if(data.autoFlowMsg)alert(data.autoFlowMsg);alert("面评已提交，感谢！");location.reload()}else{alert(data.error||"提交失败");btn.textContent="提交面评";btn.disabled=false}}catch(err){alert("提交失败："+err.message);btn.textContent="提交面评";btn.disabled=false}};' +
    'async function refreshRecording(){var btn=document.getElementById("refreshRecBtn");if(!btn)return;btn.textContent="查询中...";btn.disabled=true;' +
    'try{var r=await fetch("/api/review/' + escapeHtml(req.params.token) + '/recording");var d=await r.json();if(d.recordingUrl){alert("找到录制链接！");location.reload()}else{alert("录制尚未就绪，会议结束后通常需要几分钟。请稍后再试。");btn.textContent="🔄 刷新会议录制链接";btn.disabled=false}}catch(e){alert("查询失败");btn.textContent="🔄 刷新会议录制链接";btn.disabled=false}}' +
    '</script>';

  res.send(renderPage({ title: "面试反馈 - " + c.name, user: null, active: "", contentHtml: html }));
});

// 公开 API：通过 token 提交面评（无需登录）
app.post("/api/review/:token", async (req, res) => {
  const d = await loadData();
  const sc = d.interviewSchedules.find(x => x.reviewToken === req.params.token);
  if (!sc) return res.status(404).json({ error: "无效的面评链接" });

  const c = d.candidates.find(x => x.id === sc.candidateId);
  if (!c) return res.status(404).json({ error: "候选人不存在" });

  const round = sc.round;
  const rating = String(req.body.rating || "");
  const conclusion = String(req.body.conclusion || "通过");
  const interviewer = String(req.body.interviewer || sc.interviewers || "").trim();
  const pros = String(req.body.pros || "");
  const cons = String(req.body.cons || "");
  const focusNext = String(req.body.focusNext || "");

  if (!rating || !INTERVIEW_RATING.includes(rating)) return res.status(400).json({ error: "请选择有效评级" });
  if (!interviewer) return res.status(400).json({ error: "请填写面试官姓名" });

  const idx = d.interviews.findIndex(x => x.candidateId === c.id && x.round === round && (x.interviewer || "") === interviewer);
  const item = {
    id: idx > -1 ? d.interviews[idx].id : rid("rv"),
    candidateId: c.id,
    round,
    conclusion,
    rating,
    interviewer,
    pros,
    cons,
    focusNext,
    note: idx > -1 ? d.interviews[idx].note : "",
    createdAt: nowIso(),
  };
  if (idx > -1) d.interviews[idx] = item;
  else d.interviews.push(item);

  // 自动状态流转逻辑（与内部面评一致）
  let autoFlowMsg = "";
  const RATING_SCORES = { S: 5, A: 4, "B+": 3.5, B: 3, "B-": 2, C: 1 };
  const ratingScore = RATING_SCORES[rating] || 0;
  const old = c.status || "待筛选";

  if (rating === "B-" || rating === "C") {
    autoFlowMsg = "评级为" + rating + "，建议标记该候选人为淘汰状态。";
  } else if (ratingScore >= 3.5) {
    const passStatusMap = { 1: "一面通过", 2: "二面通过", 3: "三面通过", 4: "四面通过", 5: "五面通过" };
    const passStatus = passStatusMap[round];
    if (passStatus && STATUS_SET.has(passStatus)) {
      c.status = passStatus;
      if (round >= 5) {
        c.status = "待发offer";
        autoFlowMsg = "第" + round + "轮面试通过（评级" + rating + "），已自动流转到「待发Offer」。";
      } else {
        autoFlowMsg = "评级" + rating + "，已自动流转到「" + passStatus + "」。";
      }
    }
  }
  c.updatedAt = nowIso();

  pushEvent(d, { candidateId: c.id, type: "面评", message: "第" + round + "轮（" + interviewer + "，外部面评）：评级=" + (rating || "-") + "\nPros：" + (pros || "-") + "\nCons：" + (cons || "-"), actor: interviewer });
  if (old !== c.status) {
    pushEvent(d, { candidateId: c.id, type: "状态同步", message: "因面评更新，状态：" + old + " -> " + c.status, actor: "系统" });
  }
  if (!c.follow) c.follow = {};
  if (c.status === "淘汰") {
    c.follow.nextAction = "已结束";
    c.follow.note = (c.follow.note ? c.follow.note + "\n" : "") + "第" + round + "轮面试淘汰";
  } else if (c.status.includes("通过")) {
    c.follow.nextAction = "安排下一轮面试";
    c.follow.followAt = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  } else if (c.status === "待发offer") {
    c.follow.nextAction = "准备Offer";
  }
  await saveData(d);
  res.json({ ok: true, autoFlowMsg });
});

// 公开 API：刷新会议录制链接
app.get("/api/review/:token/recording", async (req, res) => {
  const d = await loadData();
  const sc = d.interviewSchedules.find(x => x.reviewToken === req.params.token);
  if (!sc) return res.status(404).json({ error: "无效链接" });

  // 如果已有录制链接，直接返回
  if (sc.recordingUrl) return res.json({ recordingUrl: sc.recordingUrl });

  // 尝试从飞书获取
  const meetingUrl = sc.meetingUrl || sc.link || "";
  if (!meetingUrl) return res.json({ recordingUrl: "" });

  const result = await getFeishuMeetingRecording(meetingUrl);
  if (result?.recordingUrl) {
    sc.recordingUrl = result.recordingUrl;
    if (result.meetingNo) sc.meetingNo = result.meetingNo;
    sc.updatedAt = nowIso();
    await saveData(d);
    return res.json({ recordingUrl: result.recordingUrl });
  }
  res.json({ recordingUrl: "", meetingNo: result?.meetingNo || "" });
});

// ====== 简历直传 Supabase Storage（前端直连，绕过 Vercel 大小限制）======

// 1. 获取上传签名 URL — 前端拿到后直接 PUT 到 Supabase Storage
app.post("/api/resume/upload-url", requireLogin, async (req, res) => {
  try {
    const supabase = getSupabaseAdmin();
    const bucket = getBucketName();
    if (!supabase || !bucket) return res.status(500).json({ error: "Supabase Storage 未配置" });

    const candidateId = String(req.body.candidateId || "").trim();
    const fileName = String(req.body.fileName || "").trim();
    const contentType = String(req.body.contentType || "application/octet-stream").trim();
    if (!candidateId || !fileName) return res.status(400).json({ error: "缺少 candidateId 或 fileName" });

    const ext = safeExtFromName(fileName) || ".pdf";
    const objectName = candidateId + "/" + rid("resume") + ext;

    // 生成 signed upload URL（有效期 10 分钟）
    const { data, error } = await supabase.storage
      .from(bucket)
      .createSignedUploadUrl(objectName);

    if (error || !data) {
      console.error("[Resume] createSignedUploadUrl error:", error?.message);
      return res.status(500).json({ error: "生成上传URL失败：" + (error?.message || "unknown") });
    }

    res.json({
      ok: true,
      signedUrl: data.signedUrl,
      token: data.token,
      path: data.path,
      objectName,
      bucket,
      contentType,
    });
  } catch (e) {
    console.error("[Resume] upload-url error:", e.message);
    res.status(500).json({ error: String(e?.message || "unknown") });
  }
});

// 2. 前端上传完成后，保存元数据到数据库
app.post("/api/candidates/:id/resume-meta", requireLogin, async (req, res) => {
  try {
    const d = await loadData();
    const c = d.candidates.find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: "candidate_not_found" });

    const objectName = String(req.body.objectName || "").trim();
    const originalName = String(req.body.originalName || "").trim();
    const contentType = String(req.body.contentType || "").trim();
    const size = Number(req.body.size || 0);
    const bucket = String(req.body.bucket || getBucketName()).trim();

    if (!objectName) return res.status(400).json({ error: "缺少 objectName" });

    // 生成下载用 signed URL
    const supabase = getSupabaseAdmin();
    let downloadUrl = "";
    if (supabase) {
      const { data: signed, error: signErr } = await supabase.storage
        .from(bucket)
        .createSignedUrl(objectName, getSignedUrlExpiresIn());
      if (!signErr && signed?.signedUrl) {
        downloadUrl = signed.signedUrl;
      }
    }

    const meta = {
      id: rid("rf"),
      candidateId: c.id,
      filename: objectName,
      originalName: originalName || objectName,
      contentType,
      size,
      uploadedAt: nowIso(),
      storage: "supabase",
      bucket,
      url: downloadUrl,
    };

    d.resumeFiles.push(meta);
    pushEvent(d, { candidateId: c.id, type: "简历", message: "上传简历：" + meta.originalName, actor: req.user?.name || "系统" });
    c.updatedAt = nowIso();
    await saveData(d);
    res.json({ ok: true, resume: meta });
  } catch (e) {
    console.error("[Resume] save meta error:", e.message);
    res.status(500).json({ error: String(e?.message || "unknown") });
  }
});

// 兼容旧版：通过服务端中转上传（本地开发用）
app.post("/api/candidates/:id/resume", requireLogin, upload.single("resume"), async (req, res) => {
  const d = await loadData();
  const c = d.candidates.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).send("candidate_not_found");

  try {
    const file = req.file;
    if (!file || !file.buffer || !file.buffer.length) return res.status(400).send("no_file");
    const meta = await saveResumeSupabaseOrLocal(d, c.id, file, req.user?.name || "系统");
    c.updatedAt = nowIso();
    await saveData(d);
    res.json({ ok: true, resume: meta });
  } catch (e) {
    res.status(500).send(String(e?.message || "upload_error"));
  }
});

// Offer API
app.post("/api/candidates/:id/offer", requireLogin, async (req, res) => {
  const d = await loadData();
  const c = d.candidates.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).send("candidate_not_found");

  if (!d.offers) d.offers = [];
  const existing = d.offers.find((o) => o.candidateId === c.id);

  const salary = String(req.body.salary || "").trim();
  const salaryNote = String(req.body.salaryNote || "").trim();
  const startDate = String(req.body.startDate || "").trim();
  const offerStatus = String(req.body.offerStatus || "待发放").trim();
  const note = String(req.body.note || "").trim();

  if (existing) {
    existing.salary = salary;
    existing.salaryNote = salaryNote;
    existing.startDate = startDate;
    existing.offerStatus = offerStatus;
    existing.note = note;
    existing.updatedAt = nowIso();
  } else {
    d.offers.push({
      id: rid("offer"),
      candidateId: c.id,
      jobId: c.jobId || "",
      salary,
      salaryNote,
      startDate,
      offerStatus,
      note,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
  }

  pushEvent(d, { candidateId: c.id, type: "Offer", message: "Offer状态：" + offerStatus + "\n薪资：" + (salary || "-") + "\n入职日期：" + (startDate || "-"), actor: req.user?.name || "系统" });

  if (offerStatus === "已接受" && c.status !== "入职") {
    c.status = "Offer发放";
    c.updatedAt = nowIso();
  }

  await saveData(d);

  if (feishuEnabled() && req.user?.openId) {
    sendFeishuMessage(req.user.openId,
      `**候选人**：${c.name}\n**Offer状态**：${offerStatus}\n**薪资**：${salary || "-"}\n**入职日期**：${startDate || "-"}`,
      "Offer 通知"
    ).catch(() => {});

    const approvalCode = process.env.FEISHU_APPROVAL_CODE;
    if (approvalCode && offerStatus === "待审批") {
      createApprovalInstance(approvalCode, req.user.openId, [
        { name: "候选人", value: c.name },
        { name: "职位", value: c.jobTitle || c.jobId || "-" },
        { name: "薪资", value: salary || "-" },
        { name: "入职日期", value: startDate || "-" },
        { name: "备注", value: note || "-" },
      ]).catch(() => {});
    }
  }

  res.redirect(303, "/candidates/" + c.id);
});

// ====== 猎头开放 API：API Key 认证中间件 ======
async function requireApiKey(req, res, next) {
  const apiKey = req.headers["x-api-key"] || req.query.api_key || "";
  if (!apiKey) return res.status(401).json({ error: "缺少 API Key，请在请求头 X-API-Key 中提供" });
  const d = await loadData();
  const hunter = d.headhunters.find(h => h.apiKey === apiKey && h.enabled !== false);
  if (!hunter) return res.status(401).json({ error: "API Key 无效或已禁用" });
  req.headhunter = hunter;
  next();
}

// ====== 猎头开放 API：提交候选人 ======
app.post("/open-api/candidates", requireApiKey, async (req, res) => {
  try {
    const d = await loadData();
    const name = String(req.body.name || "").trim();
    const phone = String(req.body.phone || "").trim();
    const email = String(req.body.email || "").trim();
    const jobId = String(req.body.jobId || "").trim();
    const note = String(req.body.note || "").trim();
    let tags = req.body.tags || [];
    if (typeof tags === "string") tags = [tags];
    tags = tags.filter(Boolean);

    if (!name) return res.status(400).json({ error: "姓名不能为空" });
    if (!jobId) return res.status(400).json({ error: "请提供 jobId（岗位ID）" });

    const job = d.jobs.find(x => x.id === jobId);
    if (!job) return res.status(400).json({ error: "岗位ID无效: " + jobId });

    // 查重
    const dup = findDuplicate(d.candidates, name, phone);
    if (dup) {
      return res.status(409).json({ error: "候选人疑似重复", duplicate: { id: dup.id, name: dup.name, phone: dup.phone, jobTitle: dup.jobTitle || "-", status: dup.status } });
    }

    const c = {
      id: rid("c"), name, phone, email, jobId,
      jobTitle: job.title, source: "猎头：" + req.headhunter.name,
      note, tags,
      status: "待筛选",
      follow: { nextAction: "待联系", followAt: "", note: "" },
      headhunterId: req.headhunter.id,
      createdAt: nowIso(), updatedAt: nowIso(),
    };
    d.candidates.unshift(c);
    pushEvent(d, { candidateId: c.id, type: "创建", message: "猎头「" + req.headhunter.name + "」通过API提交候选人：" + c.name + "（岗位：" + c.jobTitle + "）", actor: "猎头:" + req.headhunter.name });
    await saveData(d);
    await notifyHrNewCandidate(d, c, job).catch(e => console.warn("[Notify] err:", e.message));
    res.json({ ok: true, candidateId: c.id, message: "候选人提交成功" });
  } catch (e) {
    console.error("[OpenAPI] create candidate error:", e.message);
    res.status(500).json({ error: String(e?.message || "提交失败") });
  }
});

// ====== 猎头开放 API：上传简历 ======
app.post("/open-api/resume", requireApiKey, upload.single("resume"), async (req, res) => {
  try {
    const d = await loadData();
    const candidateId = String(req.body.candidateId || "").trim();
    if (!candidateId) return res.status(400).json({ error: "请提供 candidateId" });
    const c = d.candidates.find(x => x.id === candidateId);
    if (!c) return res.status(404).json({ error: "候选人不存在: " + candidateId });

    const file = req.file;
    if (!file || !file.buffer || !file.buffer.length) return res.status(400).json({ error: "请上传简历文件" });

    await saveResumeSupabaseOrLocal(d, c.id, file, "猎头:" + req.headhunter.name);
    pushEvent(d, { candidateId: c.id, type: "简历", message: "猎头「" + req.headhunter.name + "」上传了简历：" + (file.originalname || "resume"), actor: "猎头:" + req.headhunter.name });
    await saveData(d);
    res.json({ ok: true, message: "简历上传成功" });
  } catch (e) {
    console.error("[OpenAPI] upload resume error:", e.message);
    res.status(500).json({ error: String(e?.message || "上传失败") });
  }
});

// ====== 猎头开放 API：查看可用职位列表 ======
app.get("/open-api/jobs", requireApiKey, async (req, res) => {
  try {
    const d = await loadData();
    const jobs = d.jobs.filter(j => j.status !== "已关闭").map(j => ({
      id: j.id, title: j.title, department: j.department || "", location: j.location || "",
      category: j.category || "", headcount: j.headcount || 1, status: j.status || "开放",
    }));
    res.json({ ok: true, jobs });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || "获取失败") });
  }
});

// ====== 猎头管理页面 ======
app.get("/headhunters", requireLogin, async (req, res) => {
  const d = await loadData();
  const hunters = d.headhunters || [];
  const isAdmin = req.user?.role === "admin";

  const tableRows = hunters.map(h => {
    const statusBg = h.enabled !== false ? "#e8f5e9" : "#fce4ec";
    const statusColor = h.enabled !== false ? "#2e7d32" : "#c62828";
    const statusText = h.enabled !== false ? "启用" : "禁用";
    const actionsTd = isAdmin
      ? '<td>' +
        '<button class="btn" style="font-size:12px;padding:4px 10px;margin-right:4px" onclick="toggleHunter(\'' + h.id + '\',' + (h.enabled !== false ? 'false' : 'true') + ')">' + (h.enabled !== false ? '禁用' : '启用') + '</button>' +
        '<button class="btn" style="font-size:12px;padding:4px 10px;color:var(--red,#f54a45)" onclick="if(confirm(\'确定删除猎头 ' + escapeHtml(h.name) + '？\'))deleteHunter(\'' + h.id + '\')">删除</button>' +
        '</td>'
      : '<td>-</td>';
    return '<tr>' +
      '<td>' + escapeHtml(h.name || "") + '</td>' +
      '<td>' + escapeHtml(h.company || "") + '</td>' +
      '<td><code style="font-size:12px;background:#f5f5f5;padding:2px 6px;border-radius:4px;word-break:break-all">' + escapeHtml(h.apiKey || "") + '</code></td>' +
      '<td><span style="background:' + statusBg + ';color:' + statusColor + ';padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600">' + statusText + '</span></td>' +
      '<td>' + escapeHtml(h.createdAt ? toBjTime(h.createdAt).slice(0, 10) : "-") + '</td>' +
      actionsTd + '</tr>';
  }).join("") || '<tr><td colspan="6" style="text-align:center;color:#8f959e;padding:30px">暂无猎头' + (isAdmin ? '，点击右上角按钮添加' : '') + '</td></tr>';

  const addBtn = isAdmin ? '<button class="btn primary" onclick="showAddHunter()">添加猎头</button>' : '';
  const adminModal = isAdmin ?
      '<div id="addHunterModal" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.4);z-index:999;display:none;justify-content:center;align-items:center">' +
      '<div class="card" style="width:420px;max-width:90vw">' +
      '<div style="font-weight:900;font-size:16px;margin-bottom:12px">添加猎头</div>' +
      '<div class="field"><label>姓名</label><input id="hName" required /></div>' +
      '<div class="field"><label>公司</label><input id="hCompany" /></div>' +
      '<div class="divider"></div>' +
      '<div class="row"><button class="btn primary" onclick="saveHunter()">保存</button><button class="btn" onclick="hideAddHunter()">取消</button></div>' +
      '</div></div>' +
      '<script>' +
      'function showAddHunter(){document.getElementById("addHunterModal").style.display="flex"}' +
      'function hideAddHunter(){document.getElementById("addHunterModal").style.display="none"}' +
      'async function saveHunter(){' +
      'var name=document.getElementById("hName").value.trim();' +
      'var company=document.getElementById("hCompany").value.trim();' +
      'if(!name){alert("请填写猎头姓名");return}' +
      'var r=await fetch("/api/headhunters",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:name,company:company})});' +
      'var data=await r.json();if(!r.ok){alert(data.error||"添加失败");return}' +
      'alert("添加成功！\\nAPI Key: "+data.apiKey+"\\n\\n请妥善保管此Key");location.reload()' +
      '}' +
      'async function toggleHunter(id,enabled){' +
      'var r=await fetch("/api/headhunters/"+id,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({enabled:enabled})});' +
      'if(r.ok)location.reload();else{var d=await r.json();alert(d.error||"操作失败")}' +
      '}' +
      'async function deleteHunter(id){' +
      'var r=await fetch("/api/headhunters/"+id+"/delete",{method:"POST"});' +
      'if(r.ok)location.reload();else{var d=await r.json();alert(d.error||"删除失败")}' +
      '}' +
      '</script>'
    : '';

  res.send(renderPage({
    title: "猎头管理", user: req.user, active: "headhunters",
    contentHtml: '<div class="row"><div style="font-weight:900;font-size:18px">猎头管理</div><span class="spacer"></span>' + addBtn + '</div><div class="divider"></div>' +
      '<div class="card compact" style="background:#f0ebff;border-color:#d4c5fc"><div class="row"><div><div style="font-weight:700;color:#7c5cfc">猎头投递门户</div><div class="muted" style="margin-top:2px">将以下链接和 API Key 发送给猎头，猎头可自行登录查看岗位并投递候选人</div></div><span class="spacer"></span><a class="btn primary" href="/portal" target="_blank">打开门户</a></div><div style="margin-top:8px"><code style="font-size:13px;background:#fff;padding:4px 10px;border-radius:6px;border:1px solid #d4c5fc;word-break:break-all">' + escapeHtml(req.protocol + '://' + req.get('host') + '/portal') + '</code></div></div>' +
      '<div class="divider"></div>' +
      '<div class="card compact"><table class="data-table" style="width:100%"><thead><tr><th>姓名</th><th>公司</th><th>API Key</th><th>状态</th><th>创建日期</th><th>操作</th></tr></thead><tbody>' + tableRows + '</tbody></table></div>' +
      '<div class="divider"></div>' +
      '<div class="card compact"><div style="font-weight:700;margin-bottom:8px">猎头开放 API 使用说明（开发者）</div>' +
      '<div class="muted" style="font-size:13px;line-height:1.8">' +
      '<b>1. 查看可用职位</b><br><code>GET /open-api/jobs</code> &nbsp; Header: <code>X-API-Key: {apiKey}</code><br><br>' +
      '<b>2. 提交候选人</b><br><code>POST /open-api/candidates</code> &nbsp; Header: <code>X-API-Key: {apiKey}</code><br>' +
      'Body (JSON): <code>{"name":"姓名","phone":"手机","email":"邮箱","jobId":"职位ID","note":"备注"}</code><br><br>' +
      '<b>3. 上传简历</b><br><code>POST /open-api/resume</code> &nbsp; Header: <code>X-API-Key: {apiKey}</code><br>' +
      'Body (form-data): <code>candidateId</code> + <code>resume</code> (文件)<br>' +
      '</div></div>' +
      adminModal,
  }));
});

// ====== 猎头管理 API ======
app.post("/api/headhunters", requireLogin, requireAdmin, async (req, res) => {
  try {
    const d = await loadData();
    const name = String(req.body.name || "").trim();
    const company = String(req.body.company || "").trim();
    if (!name) return res.status(400).json({ error: "猎头姓名不能为空" });

    const apiKey = "hk_" + crypto.randomBytes(24).toString("hex");
    const hunter = {
      id: rid("hunter"),
      name,
      company,
      apiKey,
      enabled: true,
      createdAt: nowIso(),
    };
    d.headhunters.push(hunter);
    await saveData(d);
    res.json({ ok: true, id: hunter.id, apiKey: hunter.apiKey });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || "添加失败") });
  }
});

app.post("/api/headhunters/:id", requireLogin, requireAdmin, async (req, res) => {
  try {
    const d = await loadData();
    const hunter = d.headhunters.find(h => h.id === req.params.id);
    if (!hunter) return res.status(404).json({ error: "猎头不存在" });
    if (req.body.enabled !== undefined) hunter.enabled = req.body.enabled === true || req.body.enabled === "true";
    if (req.body.name) hunter.name = String(req.body.name).trim();
    if (req.body.company !== undefined) hunter.company = String(req.body.company).trim();
    await saveData(d);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || "更新失败") });
  }
});

app.post("/api/headhunters/:id/delete", requireLogin, requireAdmin, async (req, res) => {
  try {
    const d = await loadData();
    const idx = d.headhunters.findIndex(h => h.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: "猎头不存在" });
    const hunterId = d.headhunters[idx].id;
    d.headhunters.splice(idx, 1);
    await saveData(d);
    try { await deleteFromSupabase("headhunters", hunterId); } catch {}
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || "删除失败") });
  }
});

// ====== 猎头门户：独立页面布局 ======
function portalPage({ title, hunterName, contentHtml }) {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} - Machinepulse招聘系统</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;background:#faf9fb;color:#1f2329;line-height:1.6}
.portal-header{background:#fff;border-bottom:1px solid #e8e9eb;padding:14px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100}
.portal-brand{display:flex;align-items:center;gap:10px}
.portal-logo{width:32px;height:32px;background:#7c5cfc;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:16px}
.portal-title{font-weight:700;font-size:15px;color:#1f2329}
.portal-sub{font-size:12px;color:#8f959e}
.portal-user{display:flex;align-items:center;gap:8px;font-size:13px;color:#646a73}
.portal-user a{color:#7c5cfc;text-decoration:none;font-weight:600}
.portal-body{max-width:960px;margin:0 auto;padding:24px 20px}
.card{background:#fff;border:1px solid #e8e9eb;border-radius:12px;padding:20px;margin-bottom:16px}
.card.compact{padding:16px}
.btn{display:inline-flex;align-items:center;justify-content:center;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;border:1px solid #e8e9eb;background:#fff;color:#1f2329;text-decoration:none;transition:all .15s}
.btn:hover{background:#f5f5f5}
.btn.primary{background:#7c5cfc;color:#fff;border-color:#7c5cfc}
.btn.primary:hover{background:#6b4ce0}
.field{margin-bottom:14px}
.field label{display:block;font-size:13px;font-weight:600;color:#646a73;margin-bottom:4px}
.field input,.field select,.field textarea{width:100%;padding:8px 12px;border:1px solid #e8e9eb;border-radius:8px;font-size:14px;color:#1f2329;background:#fff}
.field textarea{min-height:80px;resize:vertical}
.divider{height:1px;background:#e8e9eb;margin:16px 0}
.muted{color:#8f959e;font-size:13px}
.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.spacer{flex:1}
.job-card{background:#fff;border:1px solid #e8e9eb;border-radius:10px;padding:16px 20px;margin-bottom:10px;cursor:pointer;transition:all .15s;display:flex;align-items:center;justify-content:space-between}
.job-card:hover{border-color:#7c5cfc;box-shadow:0 2px 8px rgba(124,92,252,.12)}
.job-title{font-weight:700;font-size:15px;color:#1f2329}
.job-meta{font-size:12px;color:#8f959e;margin-top:2px}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600}
.badge-green{background:#e8f5e9;color:#2e7d32}
.badge-gray{background:#f0f0f0;color:#646a73}
.badge-purple{background:#f0ebff;color:#7c5cfc}
.success-box{background:#e8f5e9;border:1px solid #c8e6c9;border-radius:10px;padding:20px;text-align:center}
.success-box h3{color:#2e7d32;margin-bottom:8px}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #f0f0f0;font-size:13px}
th{color:#8f959e;font-weight:600;font-size:12px}
@media(max-width:600px){.portal-body{padding:16px 12px}.job-card{flex-direction:column;align-items:flex-start;gap:8px}}
</style></head><body>
<div class="portal-header">
  <div class="portal-brand">
    <div class="portal-logo">M</div>
    <div><div class="portal-title">Machinepulse招聘系统</div><div class="portal-sub">猎头投递门户</div></div>
  </div>
  <div class="portal-user">${hunterName ? '欢迎，' + escapeHtml(hunterName) + ' &nbsp; <a href="/portal/my">我的投递</a> &nbsp; <a href="/portal/logout">退出</a>' : ''}</div>
</div>
<div class="portal-body">${contentHtml}</div>
</body></html>`;
}

// 猎头 session 中间件：从 session 读取猎头信息
function requirePortalLogin(req, res, next) {
  if (req.session?.hunterId) {
    req.hunterId = req.session.hunterId;
    req.hunterName = req.session.hunterName || "";
    return next();
  }
  return res.redirect(303, "/portal");
}

// ====== 猎头门户：登录页 ======
app.get("/portal", (req, res) => {
  if (req.session?.hunterId) return res.redirect("/portal/jobs");
  res.send(portalPage({
    title: "猎头登录",
    hunterName: "",
    contentHtml: '<div class="card" style="max-width:420px;margin:60px auto">' +
      '<div style="font-weight:900;font-size:18px;margin-bottom:4px">猎头投递门户</div>' +
      '<div class="muted" style="margin-bottom:16px">请输入您的 API Key 登录系统</div>' +
      '<form method="POST" action="/portal/login">' +
      '<div class="field"><label>API Key</label><input name="apiKey" placeholder="hk_xxxxxxxx" required /></div>' +
      '<button class="btn primary" type="submit" style="width:100%">登录</button>' +
      '</form></div>',
  }));
});

app.post("/portal/login", async (req, res) => {
  const apiKey = String(req.body.apiKey || "").trim();
  if (!apiKey) return res.redirect(303, "/portal");
  const d = await loadData();
  const hunter = d.headhunters.find(h => h.apiKey === apiKey && h.enabled !== false);
  if (!hunter) {
    return res.send(portalPage({
      title: "登录失败",
      hunterName: "",
      contentHtml: '<div class="card" style="max-width:420px;margin:60px auto">' +
        '<div style="font-weight:900;font-size:18px;margin-bottom:4px">猎头投递门户</div>' +
        '<div style="color:#f54a45;margin-bottom:12px;font-size:14px">API Key 无效或已被禁用，请联系招聘团队获取有效的 API Key。</div>' +
        '<form method="POST" action="/portal/login">' +
        '<div class="field"><label>API Key</label><input name="apiKey" value="' + escapeHtml(apiKey) + '" required /></div>' +
        '<button class="btn primary" type="submit" style="width:100%">重新登录</button>' +
        '</form></div>',
    }));
  }
  req.session.hunterId = hunter.id;
  req.session.hunterName = hunter.name;
  req.session.hunterApiKey = hunter.apiKey;
  res.redirect(303, "/portal/jobs");
});

app.get("/portal/logout", (req, res) => {
  req.session.hunterId = null;
  req.session.hunterName = null;
  req.session.hunterApiKey = null;
  res.redirect("/portal");
});

// ====== 猎头门户：岗位列表 ======
app.get("/portal/jobs", requirePortalLogin, async (req, res) => {
  const d = await loadData();
  const openJobs = d.jobs.filter(j => j.state !== "closed" && j.status !== "已关闭");

  const jobCards = openJobs.map(j => {
    const meta = [j.department, j.location, j.category].filter(Boolean).join(" · ") || "暂无详情";
    return '<a class="job-card" href="/portal/jobs/' + j.id + '/apply">' +
      '<div><div class="job-title">' + escapeHtml(j.title) + '</div><div class="job-meta">' + escapeHtml(meta) + '</div></div>' +
      '<span class="badge badge-green">投递</span></a>';
  }).join("");

  const emptyTip = openJobs.length === 0 ? '<div class="muted" style="text-align:center;padding:40px">暂无开放岗位</div>' : '';

  res.send(portalPage({
    title: "开放岗位",
    hunterName: req.hunterName,
    contentHtml: '<div class="row" style="margin-bottom:16px"><div style="font-weight:900;font-size:18px">开放岗位</div><span class="spacer"></span><span class="muted">' + openJobs.length + ' 个岗位招聘中</span></div>' +
      jobCards + emptyTip,
  }));
});

// ====== 猎头门户：投递页面（填写候选人信息 + 上传简历）======
app.get("/portal/jobs/:jobId/apply", requirePortalLogin, async (req, res) => {
  const d = await loadData();
  const job = d.jobs.find(j => j.id === req.params.jobId);
  if (!job) return res.send(portalPage({ title: "岗位不存在", hunterName: req.hunterName, contentHtml: '<div class="card"><div style="color:#f54a45;font-weight:700">岗位不存在或已关闭</div><div class="divider"></div><a class="btn" href="/portal/jobs">返回岗位列表</a></div>' }));

  const jdHtml = job.jd ? '<div class="card compact"><div style="font-weight:700;margin-bottom:8px">岗位描述</div><div class="muted" style="white-space:pre-wrap;font-size:13px">' + escapeHtml(job.jd) + '</div></div>' : '';

  res.send(portalPage({
    title: "投递 - " + job.title,
    hunterName: req.hunterName,
    contentHtml: '<div class="row" style="margin-bottom:16px"><a class="btn" href="/portal/jobs">&larr; 返回岗位列表</a><span class="spacer"></span></div>' +
      '<div class="card"><div style="font-weight:900;font-size:18px;margin-bottom:4px">投递候选人</div>' +
      '<div class="muted" style="margin-bottom:12px">岗位：<b>' + escapeHtml(job.title) + '</b>' +
      (job.department ? ' · ' + escapeHtml(job.department) : '') +
      (job.location ? ' · ' + escapeHtml(job.location) : '') + '</div>' +
      '<div class="divider"></div>' +
      '<form id="applyForm" enctype="multipart/form-data">' +
      '<div class="field"><label>候选人姓名 *</label><input id="aName" required /></div>' +
      '<div class="field"><label>手机号 *</label><input id="aPhone" required /></div>' +
      '<div class="field"><label>邮箱</label><input id="aEmail" type="email" /></div>' +
      '<div class="field"><label>简历附件</label>' +
      '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
      '<input id="aResume" type="file" accept=".pdf,.doc,.docx,.jpg,.png" />' +
      '<span id="fileStatus" style="font-size:13px;color:#8f959e"></span>' +
      '</div>' +
      '<div id="progressWrap" style="display:none;margin-top:8px">' +
      '<div style="background:#e9e5f5;border-radius:6px;height:8px;overflow:hidden">' +
      '<div id="progressBar" style="width:0%;height:100%;background:#7c5cfc;border-radius:6px;transition:width .2s"></div>' +
      '</div>' +
      '<div id="progressText" style="font-size:12px;color:#8f959e;margin-top:4px">准备上传...</div>' +
      '</div>' +
      '</div>' +
      '<div class="field"><label>推荐理由 / 备注</label><textarea id="aNote" placeholder="请简要说明推荐理由"></textarea></div>' +
      '<div class="divider"></div>' +
      '<button class="btn primary" type="submit" id="submitBtn" style="width:100%">提交候选人</button>' +
      '</form></div>' +
      jdHtml +
      '<script>' +
      'var fileInput=document.getElementById("aResume");' +
      'var fileStatus=document.getElementById("fileStatus");' +
      'fileInput.addEventListener("change",function(){' +
      'if(fileInput.files.length>0){' +
      'var f=fileInput.files[0];var sizeMB=(f.size/1024/1024).toFixed(1);' +
      'fileStatus.textContent="已选择: "+f.name+" ("+sizeMB+"MB)";fileStatus.style.color="#7c5cfc"' +
      '}else{fileStatus.textContent="";fileStatus.style.color="#8f959e"}' +
      '});' +
      'function uploadResume(candidateId,file){' +
      'return new Promise(function(resolve,reject){' +
      'var fd=new FormData();fd.append("candidateId",candidateId);fd.append("resume",file);' +
      'var xhr=new XMLHttpRequest();' +
      'var pw=document.getElementById("progressWrap");var pb=document.getElementById("progressBar");var pt=document.getElementById("progressText");' +
      'pw.style.display="block";pb.style.width="0%";pt.textContent="上传中...";' +
      'xhr.upload.onprogress=function(e){if(e.lengthComputable){var pct=Math.round(e.loaded/e.total*100);pb.style.width=pct+"%";pt.textContent="上传中... "+pct+"%"}};' +
      'xhr.onload=function(){' +
      'if(xhr.status>=200&&xhr.status<300){pb.style.width="100%";pb.style.background="#16a34a";pt.textContent="✓ 上传成功";resolve(true)}' +
      'else{var msg="上传失败";try{msg=JSON.parse(xhr.responseText).error||msg}catch(e){}pb.style.background="#f54a45";pt.textContent="✗ "+msg;reject(new Error(msg))}' +
      '};' +
      'xhr.onerror=function(){pb.style.background="#f54a45";pt.textContent="✗ 网络错误";reject(new Error("网络错误"))};' +
      'xhr.open("POST","/portal/api/resume");xhr.send(fd)' +
      '});}' +
      'document.getElementById("applyForm").addEventListener("submit",async function(e){' +
      'e.preventDefault();var btn=document.getElementById("submitBtn");btn.disabled=true;btn.textContent="提交中...";' +
      'try{' +
      'var r=await fetch("/portal/api/apply",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({' +
      'name:document.getElementById("aName").value.trim(),' +
      'phone:document.getElementById("aPhone").value.trim(),' +
      'email:document.getElementById("aEmail").value.trim(),' +
      'note:document.getElementById("aNote").value.trim(),' +
      'jobId:"' + job.id + '"' +
      '})});' +
      'var data=await r.json();' +
      'if(r.status===409&&data.duplicate){alert("候选人疑似重复！\\n\\n已有候选人："+data.duplicate.name+"\\n手机："+data.duplicate.phone+"\\n岗位："+data.duplicate.jobTitle+"\\n\\n请检查后重新填写");btn.disabled=false;btn.textContent="提交候选人";return}' +
      'if(!r.ok)throw new Error(data.error||"提交失败");' +
      'var candidateId=data.candidateId;' +
      'if(fileInput.files.length>0){' +
      'btn.textContent="简历上传中...";' +
      'try{await uploadResume(candidateId,fileInput.files[0])}catch(uploadErr){alert("候选人已提交，但简历上传失败："+uploadErr.message+"\\n\\n请稍后在投递记录中重新上传。")}' +
      '}' +
      'location.href="/portal/success?name="+encodeURIComponent(document.getElementById("aName").value.trim())+"&job="+encodeURIComponent("' + escapeHtml(job.title) + '");' +
      '}catch(err){alert(err.message);btn.disabled=false;btn.textContent="提交候选人"}' +
      '});' +
      '</script>',
  }));
});

// ====== 猎头门户：提交成功页 ======
app.get("/portal/success", requirePortalLogin, (req, res) => {
  const name = req.query.name || "";
  const job = req.query.job || "";
  res.send(portalPage({
    title: "投递成功",
    hunterName: req.hunterName,
    contentHtml: '<div class="success-box" style="margin-top:40px">' +
      '<h3>投递成功</h3>' +
      '<div class="muted" style="margin-bottom:12px">候选人 <b>' + escapeHtml(name) + '</b> 已成功投递到岗位 <b>' + escapeHtml(job) + '</b></div>' +
      '<div class="row" style="justify-content:center;gap:12px">' +
      '<a class="btn primary" href="/portal/jobs">继续投递</a>' +
      '<a class="btn" href="/portal/my">查看我的投递</a>' +
      '</div></div>',
  }));
});

// ====== 猎头门户：我的投递记录 ======
// 猎头候选人匹配：headhunterId 或 source 包含猎头名
function isHunterCandidate(c, hunterId, hunterName) {
  if (c.headhunterId && c.headhunterId === hunterId) return true;
  if (hunterName && c.source && c.source.includes("猎头：" + hunterName)) return true;
  return false;
}

app.get("/portal/my", requirePortalLogin, async (req, res) => {
  const d = await loadData();
  const hunter = d.headhunters.find(h => h.id === req.hunterId);
  const hunterName = hunter?.name || req.hunterName || "";
  const myCandidates = d.candidates.filter(c => isHunterCandidate(c, req.hunterId, hunterName));

  // 收集所有岗位用于筛选
  const jobTitles = [...new Set(myCandidates.map(c => c.jobTitle || "-").filter(Boolean))].sort();
  const jobFilterHtml = jobTitles.length > 1
    ? '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:16px">' +
      '<span class="muted" style="font-size:13px">筛选岗位：</span>' +
      '<button class="btn sm filter-btn active" data-job="all" onclick="filterJob(\'all\')" style="font-size:12px;padding:4px 12px;border-radius:20px">全部 (' + myCandidates.length + ')</button>' +
      jobTitles.map(jt => {
        const cnt = myCandidates.filter(c => (c.jobTitle || "-") === jt).length;
        return '<button class="btn sm filter-btn" data-job="' + escapeHtml(jt) + '" onclick="filterJob(\'' + escapeHtml(jt).replace(/'/g, "\\'") + '\')" style="font-size:12px;padding:4px 12px;border-radius:20px">' + escapeHtml(jt) + ' (' + cnt + ')</button>';
      }).join("") + '</div>'
    : '';

  // 进度步骤映射
  const stageMap = { "待筛选": 1, "简历筛选": 1, "面试中": 2, "待发Offer": 3, "Offer发放": 4, "入职": 5, "淘汰": -1 };

  const rows = myCandidates.map(c => {
    const stage = stageMap[c.status] || 1;
    const isElim = c.status === "淘汰";
    const isOffer = c.status === "Offer发放" || c.status === "入职";

    // 状态徽章颜色
    let badgeBg = "#f0ebff", badgeColor = "#7c5cfc";
    if (isElim) { badgeBg = "#fce4ec"; badgeColor = "#f54a45"; }
    else if (isOffer) { badgeBg = "#e8f5e9"; badgeColor = "#2e7d32"; }
    else if (c.status === "面试中") { badgeBg = "#e3f2fd"; badgeColor = "#1565c0"; }

    // 简易进度条
    const steps = ["简历筛选", "面试中", "待发Offer", "Offer/入职"];
    const progressHtml = '<div style="display:flex;align-items:center;gap:2px;margin-top:6px">' +
      steps.map((s, i) => {
        const stepNum = i + 1;
        const active = !isElim && stage >= stepNum;
        const bg = active ? "#7c5cfc" : "#e5e5e5";
        return '<div style="height:4px;flex:1;border-radius:2px;background:' + bg + '" title="' + escapeHtml(s) + '"></div>';
      }).join("") + '</div>';

    return '<tr data-job="' + escapeHtml(c.jobTitle || "-") + '">' +
      '<td><a href="/portal/my/' + c.id + '" style="color:#7c5cfc;font-weight:600;text-decoration:none">' + escapeHtml(c.name) + '</a></td>' +
      '<td>' + escapeHtml(c.phone || "-") + '</td>' +
      '<td>' + escapeHtml(c.jobTitle || "-") + '</td>' +
      '<td><span class="badge" style="background:' + badgeBg + ';color:' + badgeColor + ';font-weight:600">' + escapeHtml(c.status || "待筛选") + '</span>' + progressHtml + '</td>' +
      '<td class="muted">' + escapeHtml(c.createdAt ? toBjTime(c.createdAt).slice(0, 10) : "-") + '</td></tr>';
  }).join("") || '<tr id="emptyRow"><td colspan="5" style="text-align:center;color:#8f959e;padding:30px">暂无投递记录</td></tr>';

  const filterScript = '<script>' +
    'function filterJob(job){' +
    'document.querySelectorAll(".filter-btn").forEach(function(b){' +
    'b.classList.toggle("active",b.getAttribute("data-job")===job);' +
    'if(b.classList.contains("active")){b.style.background="#7c5cfc";b.style.color="#fff"}else{b.style.background="";b.style.color=""}' +
    '});' +
    'var rows=document.querySelectorAll("#myTable tbody tr[data-job]");var shown=0;' +
    'rows.forEach(function(r){' +
    'if(job==="all"||r.getAttribute("data-job")===job){r.style.display="";shown++}else{r.style.display="none"}' +
    '});' +
    'var empty=document.getElementById("filterEmpty");' +
    'if(shown===0){if(!empty){var tr=document.createElement("tr");tr.id="filterEmpty";tr.innerHTML=\'<td colspan="5" style="text-align:center;color:#8f959e;padding:30px">该岗位暂无投递记录</td>\';document.querySelector("#myTable tbody").appendChild(tr)}}' +
    'else{if(empty)empty.remove()}' +
    'var cnt=document.getElementById("totalCount");if(cnt)cnt.textContent=job==="all"?' + myCandidates.length + '+\" 位候选人\":shown+\" 位候选人\"' +
    '}' +
    'document.querySelectorAll(".filter-btn.active").forEach(function(b){b.style.background="#7c5cfc";b.style.color="#fff"});' +
    '</script>';

  res.send(portalPage({
    title: "我的投递",
    hunterName: req.hunterName,
    contentHtml: '<div class="row" style="margin-bottom:16px"><div style="font-weight:900;font-size:18px">我的投递记录</div><span class="spacer"></span><span class="muted" style="margin-right:12px" id="totalCount">' + myCandidates.length + ' 位候选人</span><a class="btn primary" href="/portal/jobs">去投递</a></div>' +
      jobFilterHtml +
      '<div class="card compact"><table id="myTable" class="data-table" style="width:100%"><thead><tr><th>候选人</th><th>手机</th><th>岗位</th><th>状态 / 进度</th><th>投递日期</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      filterScript,
  }));
});

// ====== 猎头门户：候选人进度详情 ======
app.get("/portal/my/:id", requirePortalLogin, async (req, res) => {
  const d = await loadData();
  const hunter = d.headhunters.find(h => h.id === req.hunterId);
  const hunterName = hunter?.name || req.hunterName || "";
  const c = d.candidates.find(x => x.id === req.params.id);

  if (!c || !isHunterCandidate(c, req.hunterId, hunterName)) {
    return res.send(portalPage({ title: "无权查看", hunterName: req.hunterName, contentHtml: '<div class="card" style="text-align:center;padding:40px"><div style="font-weight:700;color:#f54a45;margin-bottom:12px">无权查看此候选人</div><a class="btn" href="/portal/my">返回投递记录</a></div>' }));
  }

  // 进度步骤
  const allStages = [
    { key: "待筛选", label: "简历筛选", icon: "📄" },
    { key: "面试中", label: "面试中", icon: "💬" },
    { key: "待发Offer", label: "待发Offer", icon: "📋" },
    { key: "Offer发放", label: "Offer发放", icon: "🎉" },
    { key: "入职", label: "已入职", icon: "✅" },
  ];
  const isElim = c.status === "淘汰";
  const stageIdx = allStages.findIndex(s => s.key === c.status);
  const currentIdx = stageIdx >= 0 ? stageIdx : 0;

  const stepsHtml = '<div style="display:flex;align-items:flex-start;gap:0;margin:24px 0;position:relative">' +
    allStages.map((s, i) => {
      const done = !isElim && i <= currentIdx;
      const isCurrent = !isElim && i === currentIdx;
      const circBg = done ? "#7c5cfc" : "#e5e5e5";
      const circColor = done ? "#fff" : "#999";
      const labelWeight = isCurrent ? "700" : "400";
      const labelColor = isCurrent ? "#7c5cfc" : (done ? "#333" : "#999");
      const bar = i < allStages.length - 1
        ? '<div style="flex:1;height:3px;background:' + (done && !isElim && i < currentIdx ? "#7c5cfc" : "#e5e5e5") + ';align-self:center;margin:0 -2px;border-radius:2px"></div>'
        : '';
      return '<div style="display:flex;flex-direction:column;align-items:center;flex:0 0 auto;min-width:60px">' +
        '<div style="width:32px;height:32px;border-radius:50%;background:' + circBg + ';color:' + circColor + ';display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700">' + (done ? s.icon : (i + 1)) + '</div>' +
        '<div style="font-size:12px;margin-top:4px;color:' + labelColor + ';font-weight:' + labelWeight + '">' + s.label + '</div></div>' + bar;
    }).join("") + '</div>';

  const elimHtml = isElim ? '<div style="background:#fce4ec;color:#f54a45;padding:12px 16px;border-radius:10px;font-weight:600;margin-bottom:16px">该候选人未通过筛选</div>' : '';

  // 面试安排时间线（只显示时间和轮次，不显示面评内容）
  const schedules = d.interviewSchedules.filter(s => s.candidateId === c.id).sort((a, b) => (a.round - b.round));
  let schedHtml = '';
  if (schedules.length) {
    schedHtml = '<div class="divider"></div><div style="font-weight:700;margin-bottom:12px">面试安排</div>' +
      schedules.map(sc => {
        const reviews = d.interviews.filter(rv => rv.candidateId === c.id && rv.round === sc.round && rv.rating);
        const hasReview = reviews.length > 0;
        const statusText = hasReview ? "已完成" : (new Date(sc.scheduledAt) < new Date() ? "待面评" : "待面试");
        const statusBg = hasReview ? "#e8f5e9" : "#fff8e1";
        const statusClr = hasReview ? "#2e7d32" : "#e65100";
        return '<div class="card compact" style="margin-bottom:8px;padding:12px 16px">' +
          '<div class="row" style="flex-wrap:wrap;gap:8px">' +
          '<span style="font-weight:700">第' + sc.round + '轮</span>' +
          '<span class="muted">' + escapeHtml(sc.scheduledAt ? toBjTime(sc.scheduledAt).replace("T", " ").slice(0, 16) : "-") + '</span>' +
          '<span class="spacer"></span>' +
          '<span class="badge" style="background:' + statusBg + ';color:' + statusClr + ';font-weight:600">' + statusText + '</span>' +
          '</div></div>';
      }).join("");
  }

  // 动态记录（只显示基本操作，过滤掉面评相关）
  const events = d.events.filter(e => e.candidateId === c.id && !e.type?.includes("面评")).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  let eventsHtml = '';
  if (events.length) {
    eventsHtml = '<div class="divider"></div><div style="font-weight:700;margin-bottom:12px">动态</div>' +
      events.slice(0, 10).map(ev => {
        return '<div style="padding:6px 0;border-bottom:1px solid #f0f0f0;font-size:13px">' +
          '<span class="muted" style="margin-right:8px">' + escapeHtml(ev.createdAt ? toBjTime(ev.createdAt).slice(0, 10) : "") + '</span>' +
          escapeHtml(ev.message || ev.type || "") + '</div>';
      }).join("");
  }

  res.send(portalPage({
    title: c.name + " - 进度",
    hunterName: req.hunterName,
    contentHtml: '<div class="row" style="margin-bottom:16px"><a class="btn" href="/portal/my">&larr; 返回投递记录</a></div>' +
      '<div class="card">' +
      '<div style="font-weight:900;font-size:18px;margin-bottom:4px">' + escapeHtml(c.name) + '</div>' +
      '<div class="muted" style="margin-bottom:16px">' +
      escapeHtml(c.jobTitle || "-") +
      (c.phone ? ' · ' + escapeHtml(c.phone) : '') +
      ' · 投递于 ' + escapeHtml(c.createdAt ? toBjTime(c.createdAt).slice(0, 10) : "-") + '</div>' +
      elimHtml +
      stepsHtml +
      '<div class="divider"></div>' +
      '<div style="font-weight:700;margin-bottom:8px">当前状态</div>' +
      '<div style="font-size:15px;font-weight:600;color:#7c5cfc;margin-bottom:16px">' + escapeHtml(c.status || "待筛选") + '</div>' +
      schedHtml +
      eventsHtml +
      '</div>',
  }));
});

// ====== 猎头门户 API：提交候选人 ======
app.post("/portal/api/apply", requirePortalLogin, async (req, res) => {
  try {
    const d = await loadData();
    const hunter = d.headhunters.find(h => h.id === req.hunterId);
    if (!hunter) return res.status(401).json({ error: "猎头账号无效" });

    const name = String(req.body.name || "").trim();
    const phone = String(req.body.phone || "").trim();
    const email = String(req.body.email || "").trim();
    const jobId = String(req.body.jobId || "").trim();
    const note = String(req.body.note || "").trim();

    if (!name) return res.status(400).json({ error: "候选人姓名不能为空" });
    if (!phone) return res.status(400).json({ error: "手机号不能为空" });
    if (!jobId) return res.status(400).json({ error: "请选择岗位" });

    const job = d.jobs.find(x => x.id === jobId);
    if (!job) return res.status(400).json({ error: "岗位不存在" });

    const dup = findDuplicate(d.candidates, name, phone);
    if (dup) {
      return res.status(409).json({ error: "候选人疑似重复", duplicate: { id: dup.id, name: dup.name, phone: dup.phone, jobTitle: dup.jobTitle || "-", status: dup.status } });
    }

    const c = {
      id: rid("c"), name, phone, email, jobId,
      jobTitle: job.title, source: "猎头：" + hunter.name,
      note, tags: [],
      status: "待筛选",
      follow: { nextAction: "待联系", followAt: "", note: "" },
      headhunterId: hunter.id,
      createdAt: nowIso(), updatedAt: nowIso(),
    };
    d.candidates.unshift(c);
    pushEvent(d, { candidateId: c.id, type: "创建", message: "猎头「" + hunter.name + "」通过门户投递候选人：" + c.name + "（岗位：" + c.jobTitle + "）", actor: "猎头:" + hunter.name });
    await saveData(d);
    await notifyHrNewCandidate(d, c, job).catch(e => console.warn("[Notify] err:", e.message));
    res.json({ ok: true, candidateId: c.id });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || "提交失败") });
  }
});

// ====== 猎头门户 API：上传简历 ======
app.post("/portal/api/resume", requirePortalLogin, upload.single("resume"), async (req, res) => {
  try {
    const d = await loadData();
    const hunter = d.headhunters.find(h => h.id === req.hunterId);
    if (!hunter) return res.status(401).json({ error: "猎头账号无效" });

    const candidateId = String(req.body.candidateId || "").trim();
    if (!candidateId) return res.status(400).json({ error: "缺少 candidateId" });
    const c = d.candidates.find(x => x.id === candidateId);
    if (!c) return res.status(404).json({ error: "候选人不存在" });
    // 权限检查：headhunterId 匹配，或 source 包含猎头名称（兼容 Supabase 未同步 headhunterId 的情况）
    const isOwner = (c.headhunterId && c.headhunterId === hunter.id) || (c.source && c.source.includes("猎头：" + hunter.name));
    if (!isOwner) return res.status(403).json({ error: "无权操作此候选人" });

    const file = req.file;
    if (!file || !file.buffer || !file.buffer.length) return res.status(400).json({ error: "请选择简历文件" });

    await saveResumeSupabaseOrLocal(d, c.id, file, "猎头:" + hunter.name);
    await saveData(d);
    res.json({ ok: true, message: "简历上传成功" });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || "上传失败") });
  }
});

// ====== 全局错误处理中间件 ======
app.use((err, req, res, _next) => {
  console.error("[ERROR]", req.method, req.url, err?.message || err);
  if (res.headersSent) return;
  res.status(500).send(
    renderPage({
      title: "服务器错误",
      user: req.user || null,
      active: "",
      contentHtml: '<div class="card" style="max-width:600px;margin:40px auto;text-align:center">' +
        '<h2 style="color:var(--red)">服务器内部错误</h2>' +
        '<p class="muted">' + escapeHtml(String(err?.message || "未知错误")) + '</p>' +
        '<a class="btn primary" href="/candidates">返回首页</a></div>',
    })
  );
});

// ====== 面评提醒定时检查 ======
async function checkReviewReminders() {
  try {
    if (!feishuEnabled()) return;
    const d = await loadData();
    const now = Date.now();
    const THREE_HOURS = 3 * 60 * 60 * 1000;
    let changed = false;

    for (const sc of (d.interviewSchedules || [])) {
      // 跳过已发送提醒的、无面试时间的
      if (sc.reviewReminderSent || !sc.scheduledAt) continue;

      // 解析面试时间，判断是否已过3小时
      const schedTime = new Date(sc.scheduledAt).getTime();
      if (isNaN(schedTime) || (now - schedTime) < THREE_HOURS) continue;

      // 检查该轮次是否已有面评
      const hasReview = d.interviews.some(rv =>
        rv.candidateId === sc.candidateId && rv.round === sc.round && rv.rating
      );
      if (hasReview) {
        sc.reviewReminderSent = true;
        changed = true;
        continue;
      }

      // 找候选人和岗位信息
      const candidate = d.candidates.find(c => c.id === sc.candidateId);
      if (!candidate) continue;
      const job = d.jobs.find(j => j.id === candidate.jobId);

      // 解析面试官姓名列表，找到对应 openId
      const interviewerNames = (sc.interviewers || "").split(/[\/;,、]/).map(n => n.trim()).filter(Boolean);
      const interviewerUsers = [];
      for (const name of interviewerNames) {
        const usr = d.users.find(u => u.name === name && u.openId);
        if (usr) interviewerUsers.push(usr);
      }

      // HR（岗位负责人）openId 作为任务关注人
      const hrOpenId = job?.ownerOpenId || "";
      const hrName = job?.owner || "";

      // 面评链接
      const reviewUrl = sc.reviewToken
        ? `${process.env.BASE_URL || "https://recruit-platform-sable.vercel.app"}/review/${sc.reviewToken}`
        : "";

      // 给每个面试官发消息 + 创建任务
      for (const usr of interviewerUsers) {
        const msgContent = `**面评提醒** 📝\n\n` +
          `候选人：**${candidate.name}**\n` +
          `岗位：${job?.title || candidate.jobTitle || "-"}\n` +
          `面试轮次：第${sc.round}轮\n` +
          `面试时间：${sc.scheduledAt}\n\n` +
          `面试已结束超过2小时，请尽快填写面评。` +
          (reviewUrl ? `\n\n[点击填写面评](${reviewUrl})` : "");

        await sendFeishuMessage(usr.openId, msgContent, "面评提醒");

        // 创建飞书任务：面试官为负责人，HR为关注人
        const followerIds = hrOpenId ? [hrOpenId] : [];
        // 截止时间：面试当天 23:59 北京时间（毫秒时间戳）
        const schedRaw = String(sc.scheduledAt || "");
        const hasSchedTz = /[Zz]|[+-]\d{2}:?\d{2}$/.test(schedRaw);
        const schedDate = hasSchedTz ? new Date(schedRaw) : new Date(schedRaw + "+08:00");
        // 构造面试当天 23:59 北京时间
        const bjOffset = 8 * 60 * 60 * 1000;
        const bjMs = schedDate.getTime() + bjOffset;
        const bjDay = new Date(bjMs);
        const dayStart = Date.UTC(bjDay.getUTCFullYear(), bjDay.getUTCMonth(), bjDay.getUTCDate());
        const dueTs = dayStart + 23 * 3600000 + 59 * 60000 - bjOffset; // 23:59 CST -> UTC
        await createFeishuTask({
          title: `填写面评：${candidate.name} 第${sc.round}轮面试`,
          description: `候选人：${candidate.name}\n岗位：${job?.title || "-"}\n面试时间：${sc.scheduledAt}\n${reviewUrl ? "面评链接：" + reviewUrl : ""}`,
          assigneeOpenId: usr.openId,
          followerOpenIds: followerIds,
          dueTimestamp: dueTs,
        });

        console.log(`[ReviewReminder] 已提醒 ${usr.name}(${usr.openId}) 填写面评 - 候选人:${candidate.name} 第${sc.round}轮` +
          (hrOpenId ? ` HR关注人:${hrName}(${hrOpenId})` : ""));
      }

      // 如果找不到面试官 openId，也标记已发送避免重复
      sc.reviewReminderSent = true;
      changed = true;
    }

    if (changed) await saveData(d);
  } catch (e) {
    console.error("[ReviewReminder] 检查失败:", e.message);
  }
}

// ====== 启动（本地开发时 listen，Vercel 上由 api/index.mjs 导出）======
if (!isServerless) {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, "0.0.0.0", () => {
    console.log("[OK] Web: http://localhost:" + port);
    console.log("[OK] 人才库: http://localhost:" + port + "/candidates");
    console.log("[OK] 看板: http://localhost:" + port + "/candidates/board");
    console.log("[OK] Offer管理: http://localhost:" + port + "/offers");

    // 启动面评提醒定时检查（每30分钟检查一次）
    setInterval(checkReviewReminders, 30 * 60 * 1000);
    // 启动后延迟1分钟执行首次检查
    setTimeout(checkReviewReminders, 60 * 1000);
    console.log("[OK] 面评提醒: 每30分钟检查一次（首次检查1分钟后）");
  });
}

export default app;