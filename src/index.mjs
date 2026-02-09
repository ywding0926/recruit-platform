import "dotenv/config";

import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { renderPage, escapeHtml, statusBadge, followupBadge, offerStatusBadge, tagBadge } from "./ui.mjs";
import { getSupabaseAdmin, getBucketName, getSignedUrlExpiresIn, supabaseEnabled } from "./supabase.mjs";
import { loadData, saveData, ensureDataShape, nowIso, rid, deleteFromSupabase, deleteCandidateRelated } from "./db.mjs";
import { sessionMiddleware, registerAuthRoutes, requireLogin } from "./auth.mjs";
import { feishuEnabled, sendFeishuMessage, createApprovalInstance } from "./feishu.mjs";

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

// ====== 常量 ======
const STATUS_COLS = [
  { key: "待筛选", name: "待筛选" },
  { key: "待一面", name: "待一面" },
  { key: "一面通过", name: "一面通过" },
  { key: "二面通过", name: "二面通过" },
  { key: "三面通过", name: "三面通过" },
  { key: "四面通过", name: "四面通过" },
  { key: "五面通过", name: "五面通过" },
  { key: "Offer发放", name: "Offer发放" },
  { key: "入职", name: "入职" },
  { key: "淘汰", name: "淘汰" },
];
const STATUS_SET = new Set(STATUS_COLS.map((x) => x.key));
const INTERVIEW_ROUNDS = [1, 2, 3, 4, 5];
const INTERVIEW_RATING = ["S", "A", "B+", "B", "B-", "C"];
const INTERVIEW_STATUS = STATUS_COLS.map((x) => x.key);
const NEXT_ACTIONS = ["待联系", "约一面", "等面试反馈", "约二面", "约三面", "谈薪", "发Offer", "等入职", "其他"];
const JOB_CATEGORIES = ["技术", "产品", "设计", "运营", "市场", "销售", "人力", "财务", "行政", "其他"];
const OFFER_STATUSES = ["待发放", "已发放", "已接受", "已拒绝", "已撤回"];

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
function toolbarHtml({ jobs, sources, q = "", jobId = "", source = "", mode = "list" }) {
  const jobOpts = ['<option value="">全部岗位</option>']
    .concat(jobs.map((j) => '<option value="' + escapeHtml(j.id) + '" ' + (j.id === jobId ? "selected" : "") + '>' + escapeHtml(j.title || j.id) + '</option>'))
    .join("");
  const srcOpts = ['<option value="">全部来源</option>']
    .concat(sources.map((s) => '<option value="' + escapeHtml(s) + '" ' + (s === source ? "selected" : "") + '>' + escapeHtml(s) + '</option>'))
    .join("");

  const targetPath = mode === "board" ? "/candidates/board" : "/candidates";

  return '<div class="card soft"><div class="toolbar">' +
    '<div class="ctl"><label>搜索</label><input id="q" value="' + escapeHtml(q) + '" placeholder="姓名 / 手机 / 备注关键词" /></div>' +
    '<div class="ctl"><label>岗位</label><select id="jobId">' + jobOpts + '</select></div>' +
    '<div class="ctl"><label>来源</label><select id="source">' + srcOpts + '</select></div>' +
    '<button class="btn primary" onclick="applyFilters()">筛选</button>' +
    '<span class="spacer"></span>' +
    '<a class="btn" href="/candidates/new">新建候选人</a>' +
    '<a class="btn" href="/candidates/import">批量导入</a>' +
    '<a class="btn" href="/jobs/new">新建职位</a>' +
    '</div></div>' +
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

  const bySource = {};
  for (const c of d.candidates) {
    const src = c.source || "未知";
    bySource[src] = (bySource[src] || 0) + 1;
  }
  const sourceItems = Object.entries(bySource).sort((a, b) => b[1] - a[1]);
  const sourceBarMax = sourceItems.length ? sourceItems[0][1] : 1;
  const sourceHtml = sourceItems.map(([name, count]) => {
    const pct = Math.round((count / sourceBarMax) * 100);
    return '<div style="margin-bottom:10px"><div class="row"><span>' + escapeHtml(name) + '</span><span class="spacer"></span><b>' + count + '</b></div><div class="bar"><div class="bar-fill bar-purple" style="width:' + pct + '%"></div></div></div>';
  }).join("");

  const jobProgressHtml = d.jobs.slice(0, 8).map((j) => {
    const cands = d.candidates.filter((c) => c.jobId === j.id);
    const hired = cands.filter((c) => c.status === "入职").length;
    const hc = j.headcount || 0;
    const pct = hc > 0 ? Math.min(100, Math.round((hired / hc) * 100)) : 0;
    const barColor = pct >= 100 ? "bar-green" : "bar-purple";
    return '<div style="margin-bottom:10px"><div class="row"><span style="font-weight:700">' + escapeHtml(j.title || "未命名") + '</span><span class="spacer"></span><span class="muted">' + hired + ' / ' + (hc || "?") + '</span></div><div class="bar"><div class="bar-fill ' + barColor + '" style="width:' + pct + '%"></div></div></div>';
  }).join("");

  const totalOffers = d.offers ? d.offers.length : 0;
  const acceptedOffers = d.offers ? d.offers.filter((o) => o.offerStatus === "已接受").length : 0;
  const pendingOffers = d.offers ? d.offers.filter((o) => o.offerStatus === "待发放" || o.offerStatus === "已发放").length : 0;

  const recentEvents = (d.events || []).slice(0, 8);
  const recentHtml = recentEvents.length ? recentEvents.map((e) => {
    return '<div class="titem"><div class="tmeta"><b>' + escapeHtml(e.actor || "系统") + '</b><span class="badge gray" style="font-size:11px">' + escapeHtml(e.type || "-") + '</span><span class="muted">' + escapeHtml((e.createdAt || "").slice(0, 16)) + '</span></div><div class="tmsg" style="font-size:13px">' + escapeHtml(e.message || "").replaceAll("\n", "<br/>") + '</div></div>';
  }).join("") : '<div class="muted">暂无动态</div>';

  const funnelHtml = STATUS_COLS.map((s) => {
    const count = byStatus[s.key] || 0;
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    return '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' + statusBadge(s.key) + '<span style="min-width:30px;text-align:right;font-weight:900">' + count + '</span><div class="bar" style="flex:1"><div class="bar-fill bar-purple" style="width:' + pct + '%"></div></div><span class="muted">' + pct + '%</span></div>';
  }).join("");

  res.send(
    renderPage({
      title: "招聘概览",
      user: req.user,
      active: "dashboard",
      contentHtml: '<div class="row"><div style="font-weight:900;font-size:20px">招聘概览</div><span class="spacer"></span><a class="btn" href="/candidates">全部候选人</a><a class="btn primary" href="/candidates/board">候选人看板</a></div><div class="divider"></div>' +
        '<div class="grid4">' +
        '<div class="card stat-card"><div class="stat-number">' + total + '</div><div class="stat-label">候选人总数</div></div>' +
        '<div class="card stat-card"><div class="stat-number" style="color:var(--primary)">' + interviewingCount + '</div><div class="stat-label">面试中</div></div>' +
        '<div class="card stat-card"><div class="stat-number" style="color:var(--orange)">' + offerCount + '</div><div class="stat-label">Offer阶段</div></div>' +
        '<div class="card stat-card"><div class="stat-number" style="color:var(--green)">' + hiredCount + '</div><div class="stat-label">已入职</div></div>' +
        '</div><div style="height:14px"></div>' +
        '<div class="grid">' +
        '<div>' +
        '<div class="card"><div style="font-weight:900;margin-bottom:12px">招聘漏斗</div>' + funnelHtml + '</div>' +
        '<div style="height:14px"></div>' +
        '<div class="card"><div style="font-weight:900;margin-bottom:12px">岗位招聘进度（HC完成率）</div>' + (jobProgressHtml || '<div class="muted">暂无岗位</div>') + '</div>' +
        '</div>' +
        '<div>' +
        '<div class="card"><div class="row"><div style="font-weight:900">数据总览</div></div><div class="divider"></div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
        '<div class="pill"><span class="muted">总职位</span><b>' + totalJobs + '</b></div>' +
        '<div class="pill"><span class="muted">开放中</span><b>' + openJobs + '</b></div>' +
        '<div class="pill"><span class="muted">Offer总数</span><b>' + totalOffers + '</b></div>' +
        '<div class="pill"><span class="muted">已接受</span><b>' + acceptedOffers + '</b></div>' +
        '<div class="pill"><span class="muted">待处理Offer</span><b>' + pendingOffers + '</b></div>' +
        '<div class="pill"><span class="muted">淘汰</span><b>' + rejectedCount + '</b></div>' +
        '</div></div>' +
        '<div style="height:14px"></div>' +
        '<div class="card"><div style="font-weight:900;margin-bottom:12px">来源分析</div>' + (sourceHtml || '<div class="muted">暂无数据</div>') + '</div>' +
        '<div style="height:14px"></div>' +
        '<div class="card"><div style="font-weight:900;margin-bottom:12px">最近动态</div><div class="timeline">' + recentHtml + '</div></div>' +
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

  const filteredJobs = catFilter ? d.jobs.filter((j) => j.category === catFilter) : d.jobs;

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
      const cat = j.category ? '<span class="badge blue" style="font-size:11px">' + escapeHtml(j.category) + '</span>' : '';
      const st = jobFunnelStats(d, j.id);
      const stateBadge = j.state === "open" ? '<span class="badge green">开放</span>' : j.state === "paused" ? '<span class="badge orange">暂停</span>' : '<span class="badge gray">关闭</span>';
      const funnel =
        '<span class="pill"><span class="muted">总</span><b>' + st.total + '</b></span>' +
        '<span class="pill"><span class="muted">面试中</span><b>' + st["面试中"] + '</b></span>' +
        '<span class="pill"><span class="muted">入职</span><b>' + st["入职"] + '</b></span>';

      return '<tr><td><a class="btn sm" href="/jobs/' + id + '">' + title + '</a> ' + cat + '</td><td>' + dept + '</td><td>' + loc + '</td><td>' + hc + '</td><td>' + stateBadge + '</td><td style="min-width:260px">' + funnel + '</td><td><a class="btn sm" href="/candidates?jobId=' + id + '">候选人</a></td></tr>';
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
      contentHtml: '<div class="card" style="max-width:820px;margin:0 auto;"><div style="font-weight:900;font-size:18px">创建职位</div><div class="divider"></div><form method="POST" action="/jobs/new"><div class="grid"><div class="card shadowless"><div class="field"><label>岗位名称</label><input name="title" required placeholder="例如：行业运营" /></div><div class="field"><label>部门</label><input name="department" placeholder="例如：电商交易" /></div><div class="field"><label>地点</label><input name="location" placeholder="例如：上海" /></div><div class="field"><label>负责人</label><input name="owner" placeholder="例如：张三" /></div></div><div class="card shadowless"><div class="field"><label>HC（招聘人数）</label><input name="headcount" type="number" min="0" placeholder="例如：2" /></div><div class="field"><label>职级</label><input name="level" placeholder="例如：P6" /></div><div class="field"><label>职位分类</label><select name="category"><option value="">请选择</option>' + catOpts + '</select></div><div class="field"><label>岗位状态</label><select name="state"><option value="open">开放</option><option value="paused">暂停</option><option value="closed">关闭</option></select></div></div></div><div class="divider"></div><div class="field"><label>JD 描述</label><textarea name="jd" rows="8" placeholder="写清职责、要求、加分项"></textarea></div><div class="row"><button class="btn primary" type="submit">创建职位</button><a class="btn" href="/jobs">返回</a></div></form></div>',
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
  res.redirect("/jobs/" + job.id);
});

app.get("/jobs/:id", requireLogin, async (req, res) => {
  const d = await loadData();
  const job = d.jobs.find((x) => x.id === req.params.id);
  if (!job) {
    return res.send(renderPage({ title: "岗位不存在", user: req.user, active: "jobs", contentHtml: '<div class="card"><div style="font-weight:900">岗位不存在</div><div class="divider"></div><a class="btn" href="/jobs">返回</a></div>' }));
  }

  const catOpts = JOB_CATEGORIES.map((c) => '<option value="' + escapeHtml(c) + '" ' + (job.category === c ? "selected" : "") + '>' + escapeHtml(c) + '</option>').join("");
  const st = jobFunnelStats(d, job.id);
  const funnel = '<span class="pill"><span class="muted">总</span><b>' + st.total + '</b></span><span class="pill"><span class="muted">待筛选</span><b>' + st["待筛选"] + '</b></span><span class="pill"><span class="muted">面试中</span><b>' + st["面试中"] + '</b></span><span class="pill"><span class="muted">Offer</span><b>' + st["Offer发放"] + '</b></span><span class="pill"><span class="muted">入职</span><b>' + st["入职"] + '</b></span><span class="pill"><span class="muted">淘汰</span><b>' + st["淘汰"] + '</b></span>';

  res.send(
    renderPage({
      title: job.title || "岗位详情",
      user: req.user,
      active: "jobs",
      contentHtml: '<div class="row"><div style="font-weight:900;font-size:18px">' + escapeHtml(job.title || "岗位详情") + '</div><span class="spacer"></span><a class="btn" href="/candidates?jobId=' + escapeHtml(job.id) + '">该岗位候选人</a><form method="POST" action="/jobs/' + escapeHtml(job.id) + '/delete" style="display:inline" onsubmit="return confirm(\'确定删除此职位？\')"><button class="btn danger sm" type="submit">删除职位</button></form></div><div class="divider"></div>' +
        '<div class="card"><div class="row"><div style="font-weight:900">招聘数据</div><span class="spacer"></span>' + funnel + '</div></div><div style="height:12px"></div>' +
        '<div class="card" style="max-width:980px;margin:0 auto;"><div class="muted">填写 & 修改岗位信息</div><div class="divider"></div><form method="POST" action="/jobs/' + escapeHtml(job.id) + '"><div class="grid"><div class="card shadowless"><div class="field"><label>岗位名称</label><input name="title" value="' + escapeHtml(job.title || "") + '" /></div><div class="field"><label>部门</label><input name="department" value="' + escapeHtml(job.department || "") + '" /></div><div class="field"><label>地点</label><input name="location" value="' + escapeHtml(job.location || "") + '" /></div><div class="field"><label>负责人</label><input name="owner" value="' + escapeHtml(job.owner || "") + '" /></div></div><div class="card shadowless"><div class="field"><label>HC（招聘人数）</label><input name="headcount" type="number" min="0" value="' + escapeHtml(job.headcount ?? "") + '" /></div><div class="field"><label>职级</label><input name="level" value="' + escapeHtml(job.level || "") + '" /></div><div class="field"><label>职位分类</label><select name="category"><option value="">请选择</option>' + catOpts + '</select></div><div class="field"><label>岗位状态</label><select name="state"><option value="open" ' + (job.state === "open" ? "selected" : "") + '>开放</option><option value="paused" ' + (job.state === "paused" ? "selected" : "") + '>暂停</option><option value="closed" ' + (job.state === "closed" ? "selected" : "") + '>关闭</option></select></div></div></div><div class="divider"></div><div class="field"><label>JD 描述</label><textarea name="jd" rows="10">' + escapeHtml(job.jd || "") + '</textarea></div><div class="row"><button class="btn primary" type="submit">保存岗位信息</button><a class="btn" href="/jobs">返回列表</a></div></form></div>',
    })
  );
});

app.post("/jobs/:id", requireLogin, async (req, res) => {
  const d = await loadData();
  const job = d.jobs.find((x) => x.id === req.params.id);
  if (!job) return res.redirect("/jobs");
  job.title = String(req.body.title || "").trim();
  job.department = String(req.body.department || "").trim();
  job.location = String(req.body.location || "").trim();
  job.owner = String(req.body.owner || "").trim();
  job.headcount = req.body.headcount === "" ? null : Number(req.body.headcount || 0);
  job.level = String(req.body.level || "").trim();
  job.category = String(req.body.category || "").trim();
  job.state = String(req.body.state || "open");
  job.jd = String(req.body.jd || "").trim();
  job.updatedAt = nowIso();
  await saveData(d);
  res.redirect("/jobs/" + job.id);
});

// 删除职位
app.post("/jobs/:id/delete", requireLogin, async (req, res) => {
  const d = await loadData();
  const idx = d.jobs.findIndex((x) => x.id === req.params.id);
  if (idx > -1) {
    d.jobs.splice(idx, 1);
    await deleteFromSupabase("jobs", req.params.id);
    await saveData(d);
  }
  res.redirect("/jobs");
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
      active: "candidates_list",
      contentHtml: '<div class="card" style="max-width:860px;margin:0 auto;"><div style="font-weight:900;font-size:18px">新建候选人</div><div class="divider"></div><form method="POST" action="/candidates/new" enctype="multipart/form-data"><div class="grid"><div class="card shadowless"><div class="field"><label>姓名</label><input name="name" required /></div><div class="field"><label>手机</label><input name="phone" /></div><div class="field"><label>邮箱</label><input name="email" type="email" placeholder="example@company.com" /></div><div class="field"><label>岗位</label><select name="jobId" required>' + (jobOpts || '<option value="">请先创建职位</option>') + '</select></div><div class="field"><label>简历（可选）</label><input type="file" name="resume" accept=".pdf,.png,.jpg,.jpeg,.webp" /><div class="muted">上传后会自动绑定到候选人</div></div></div><div class="card shadowless"><div class="field"><label>来源</label><select name="source">' + srcOpts + '</select></div><div class="field"><label>标签</label><div>' + (tagCheckboxes || '<span class="muted">暂无标签，可在设置中添加</span>') + '</div></div><div class="field"><label>备注</label><textarea name="note" rows="7"></textarea></div></div></div><div class="divider"></div><div class="row"><button class="btn primary" type="submit">创建候选人</button><a class="btn" href="/candidates">返回</a></div></form></div>',
    })
  );
});

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

  if (!name) return res.redirect("/candidates/new");
  if (!jobId) return res.redirect("/candidates/new");

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
  res.redirect("/candidates/" + c.id);
});

// ====== CSV 批量导入 ======
app.get("/candidates/import", requireLogin, async (req, res) => {
  res.send(
    renderPage({
      title: "批量导入候选人",
      user: req.user,
      active: "candidates_list",
      contentHtml: '<div class="card" style="max-width:820px;margin:0 auto;"><div style="font-weight:900;font-size:18px">批量导入候选人（CSV）</div><div class="divider"></div>' +
        '<div class="muted" style="margin-bottom:12px">CSV 文件格式要求：第一行为表头，支持字段：<b>姓名, 手机, 邮箱, 岗位ID, 来源, 备注, 标签</b>（标签用分号分隔）</div>' +
        '<div class="card shadowless" style="margin-bottom:12px"><div style="font-weight:700;margin-bottom:8px">CSV 模板示例</div><pre style="background:#f8fafc;padding:12px;border-radius:12px;overflow:auto;font-size:13px">姓名,手机,邮箱,岗位ID,来源,备注,标签\n张三,13800138000,zhangsan@test.com,job_xxx,Boss直聘,3年经验,高潜;紧急\n李四,13900139000,lisi@test.com,job_xxx,内推,5年经验,优秀</pre></div>' +
        '<form method="POST" action="/candidates/import" enctype="multipart/form-data"><div class="field"><label>选择 CSV 文件</label><input type="file" name="csv" accept=".csv,.txt" required /></div><div class="row"><button class="btn primary" type="submit">开始导入</button><a class="btn" href="/candidates">返回</a></div></form></div>',
    })
  );
});

app.post("/candidates/import", requireLogin, upload.single("csv"), async (req, res) => {
  const d = await loadData();
  const file = req.file;
  if (!file || !file.buffer || !file.buffer.length) {
    return res.send(renderPage({ title: "导入失败", user: req.user, active: "candidates_list", contentHtml: '<div class="card"><div style="font-weight:900;color:var(--red)">未选择文件</div><div class="divider"></div><a class="btn" href="/candidates/import">返回重试</a></div>' }));
  }

  const text = file.buffer.toString("utf-8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) {
    return res.send(renderPage({ title: "导入失败", user: req.user, active: "candidates_list", contentHtml: '<div class="card"><div style="font-weight:900;color:var(--red)">CSV文件至少需要表头+1行数据</div><div class="divider"></div><a class="btn" href="/candidates/import">返回重试</a></div>' }));
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
  }

  const errorHtml = errors.length ? '<div class="divider"></div><div style="color:var(--red);font-weight:700">导入警告（' + errors.length + '条）</div>' + errors.map((e) => '<div class="muted">' + escapeHtml(e) + '</div>').join("") : "";

  res.send(
    renderPage({
      title: "导入完成",
      user: req.user,
      active: "candidates_list",
      contentHtml: '<div class="card" style="max-width:820px;margin:0 auto;"><div style="font-weight:900;font-size:18px;color:var(--green)">导入完成</div><div class="divider"></div><div class="row"><span class="pill"><span class="muted">成功导入</span><b>' + imported + '</b></span><span class="pill"><span class="muted">失败</span><b>' + errors.length + '</b></span></div>' + errorHtml + '<div class="divider"></div><div class="row"><a class="btn primary" href="/candidates">查看全部候选人</a><a class="btn" href="/candidates/import">继续导入</a></div></div>',
    })
  );
});
// ====== 全部候选人（列表）======
app.get("/candidates", requireLogin, async (req, res) => {
  const d = await loadData();
  const q = String(req.query.q || "").trim().toLowerCase();
  const jobId = String(req.query.jobId || "").trim();
  const source = String(req.query.source || "").trim();
  const status = String(req.query.status || "").trim();

  const jobMap = new Map(d.jobs.map((j) => [j.id, j]));
  d.candidates.forEach((c) => {
    if (!c.jobTitle && c.jobId && jobMap.get(c.jobId)) c.jobTitle = jobMap.get(c.jobId).title;
    if (!STATUS_SET.has(c.status)) c.status = "待筛选";
    if (!c.follow) c.follow = { nextAction: "", followAt: "", note: "" };
    if (!Array.isArray(c.tags)) c.tags = [];
  });

  const filtered = d.candidates.filter((c) => {
    if (jobId && c.jobId !== jobId) return false;
    if (source && String(c.source || "") !== source) return false;
    if (status && c.status !== status) return false;
    if (q) {
      const hay = (c.name || "") + " " + (c.phone || "") + " " + (c.email || "") + " " + (c.note || "") + " " + (c.source || "") + " " + (c.tags || []).join(" ");
      if (!hay.toLowerCase().includes(q)) return false;
    }
    return true;
  });

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

  const resumeMap = new Map();
  for (const r of d.resumeFiles) {
    if (!r.url) continue;
    if (!resumeMap.has(r.candidateId) || (r.uploadedAt || "") > (resumeMap.get(r.candidateId).uploadedAt || "")) {
      resumeMap.set(r.candidateId, r);
    }
  }

  const rows = filtered
    .map((c) => {
      const follow = followupBadge(c.follow);
      const tagsHtml = (c.tags || []).map((t) => tagBadge(t)).join(" ");
      const rm = resumeMap.get(c.id);
      const resumeCol = rm && rm.url
        ? '<a class="btn sm" href="' + escapeHtml(rm.url) + '" target="_blank" rel="noreferrer" title="' + escapeHtml(rm.originalName || rm.filename || "简历") + '">📎 ' + escapeHtml((rm.originalName || rm.filename || "简历").slice(0, 12)) + '</a>'
        : '<span class="muted">-</span>';
      return '<tr>' +
        '<td><a class="btn sm" href="/candidates/' + escapeHtml(c.id) + '">' + escapeHtml(c.name || "未命名") + '</a></td>' +
        '<td>' + escapeHtml(c.phone || "-") + '</td>' +
        '<td>' + escapeHtml(c.email || "-") + '</td>' +
        '<td>' + escapeHtml(c.jobTitle || c.jobId || "-") + '</td>' +
        '<td>' + escapeHtml(c.source || "-") + '</td>' +
        '<td>' + statusBadge(c.status) + ' ' + follow + '</td>' +
        '<td>' + resumeCol + '</td>' +
        '<td>' + tagsHtml + '</td>' +
        '<td class="muted">' + escapeHtml((c.updatedAt || c.createdAt || "").slice(0, 16)) + '</td>' +
        '</tr>';
    })
    .join("");

  res.send(
    renderPage({
      title: "全部候选人",
      user: req.user,
      active: "candidates_list",
      contentHtml: '<div class="row"><div style="font-weight:900;font-size:18px">全部候选人 <span class="muted" style="font-weight:400">（' + filtered.length + '/' + d.candidates.length + '）</span></div><span class="spacer"></span><a class="btn" href="/candidates/board">去看板</a></div><div class="divider"></div>' +
        toolbarHtml({ jobs: d.jobs, sources: d.sources, q, jobId, source, mode: "list" }) +
        '<div style="height:12px"></div>' +
        '<div class="seg"><a class="' + (status ? "" : "active") + '" href="' + allHref + '">全部状态</a>' + seg + '</div>' +
        '<div style="height:12px"></div>' +
        '<div class="card"><table><thead><tr><th>姓名</th><th>手机</th><th>邮箱</th><th>岗位</th><th>来源</th><th>状态 / 跟进</th><th>简历</th><th>标签</th><th>更新时间</th></tr></thead><tbody>' + (rows || "") + '</tbody></table>' + (rows ? "" : '<div class="muted">暂无候选人</div>') + '</div>',
    })
  );
});

// ====== 看板 ======
function kanbanHtml({ grouped, countsByCol, resumeMap }) {
  const cols = STATUS_COLS.map((col) => {
    const items = (grouped[col.key] || [])
      .map((c) => {
        const title = escapeHtml(c.name || "未命名");
        const phone = escapeHtml(c.phone || "");
        const jobTitle = escapeHtml(c.jobTitle || c.jobId || "-");
        const src = escapeHtml(c.source || "-");
        const follow = followupBadge(c.follow);
        const tagsHtml = (c.tags || []).map((t) => tagBadge(t)).join(" ");
        const rm = resumeMap ? resumeMap.get(c.id) : null;
        const hasResume = rm && rm.url;

        return '<div class="carditem" onclick="openCandidate(\'' + escapeHtml(c.id) + '\')">' +
          '<div class="cardtitle"><span>' + title + '</span>' + (hasResume ? '<span class="badge purple" style="font-size:11px;padding:3px 7px">📎简历</span>' : '') + statusBadge(c.status) + '</div>' +
          '<div class="cardsub">' +
          '<span class="pill"><span class="muted">岗位</span> <b>' + jobTitle + '</b></span>' +
          '<span class="pill"><span class="muted">来源</span> <b>' + src + '</b></span>' +
          (phone ? '<span class="pill"><span class="muted">手机</span> <b>' + phone + '</b></span>' : '') +
          (follow ? '<span>' + follow + '</span>' : '') +
          (tagsHtml ? '<div>' + tagsHtml + '</div>' : '') +
          '</div></div>';
      })
      .join("");

    return '<div class="col"><div class="colhead"><div class="coltitle">' + escapeHtml(col.name) + '</div><div class="colcount">' + statusBadge(col.key) + ' <span class="muted"> ' + (countsByCol[col.key] || 0) + ' </span></div></div><div class="colbody">' + (items || '<div class="muted">暂无候选人</div>') + '</div></div>';
  }).join("");

  return '<div class="card soft"><div class="row"><div style="font-weight:900;font-size:16px">候选人看板</div><span class="muted">（点击卡片打开右侧抽屉快速查看）</span></div><div class="divider"></div><div class="kanban">' + cols + '</div></div>' +
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
    '<div class="tabpanel active" id="panel-info"><div class="card shadowless" style="padding:12px"><div class="row"><span class="pill"><span class="muted">状态</span><b id="cStatus"></b></span><span class="pill"><span class="muted">岗位</span><b id="cJob"></b></span><span class="pill"><span class="muted">来源</span><b id="cSource"></b></span><span class="spacer"></span><a class="btn" id="fullOpenBtn">打开完整详情</a></div><div class="divider"></div><div class="field"><label>状态流转</label><div class="row"><select id="statusSelect" style="max-width:220px"></select><button class="btn primary" onclick="updateStatus()">更新状态</button></div></div><div class="divider"></div><div style="font-weight:900;margin-bottom:8px">编辑候选人信息</div><div class="field"><label>姓名</label><input id="editName" /></div><div class="field"><label>手机</label><input id="editPhone" /></div><div class="field"><label>邮箱</label><input id="editEmail" /></div><div class="field"><label>来源</label><input id="editSource" /></div><div class="field"><label>备注</label><textarea id="editNote" rows="3"></textarea></div><button class="btn" onclick="saveCandidate()">保存信息</button></div></div>' +
    '<div class="tabpanel" id="panel-follow"><div class="card shadowless" style="padding:12px"><div class="row"><div style="font-weight:900">下一步 & 跟进时间</div><span class="muted">（逾期会标红）</span></div><div class="divider"></div><div class="field"><label>下一步动作</label><select id="fuAction"></select></div><div class="field"><label>跟进时间（YYYY-MM-DD HH:MM）</label><input id="fuAt" placeholder="例如：2026-02-08 14:00" /></div><div class="field"><label>跟进备注</label><textarea id="fuNote" rows="3"></textarea></div><button class="btn primary" onclick="saveFollow()">保存跟进</button></div></div>' +
    '<div class="tabpanel" id="panel-schedule"><div class="card shadowless" style="padding:12px"><div class="row"><div style="font-weight:900">面试安排</div></div><div class="divider"></div><div class="row" style="gap:10px"><div class="field" style="min-width:120px"><label>轮次</label><select id="scRound"></select></div><div class="field" style="min-width:220px"><label>面试时间</label><input id="scAt" placeholder="2026-02-08 19:00" /></div></div><div class="field"><label>面试官</label><input id="scInterviewers" placeholder="张三 / 李四" /></div><div class="field"><label>会议链接</label><input id="scLink" /></div><div class="field"><label>地点/形式</label><input id="scLocation" /></div><div class="field"><label>同步状态</label><select id="scSyncStatus"></select></div><button class="btn primary" onclick="saveSchedule()">保存面试安排</button><div class="divider"></div><div style="font-weight:900;margin-bottom:8px">已安排</div><div id="scheduleList" class="muted">暂无</div></div></div>' +
    '<div class="tabpanel" id="panel-resume"><div class="card shadowless" style="padding:12px"><div class="row"><div style="font-weight:900">简历</div><span class="spacer"></span><a class="btn" id="resumeOpenBtn" target="_blank" rel="noreferrer">新窗口打开</a></div><div class="divider"></div><form id="resumeUploadForm" enctype="multipart/form-data"><div class="row"><input type="file" name="resume" accept=".pdf,.png,.jpg,.jpeg,.webp" /><button class="btn primary" type="submit">上传</button></div></form><div class="divider"></div><div id="resumeArea" class="muted">暂无简历</div></div></div>' +
    '<div class="tabpanel" id="panel-review"><div class="card shadowless" style="padding:12px"><div class="row"><div style="font-weight:900">面试评价</div></div><div class="divider"></div><div class="row" style="gap:10px"><div class="field" style="min-width:120px"><label>轮次</label><select id="rvRound"></select></div><div class="field" style="min-width:160px"><label>面试进度</label><select id="rvStatus"></select></div><div class="field" style="min-width:120px"><label>评级</label><select id="rvRating"></select></div></div><div class="field"><label>Pros</label><textarea id="rvPros" rows="3"></textarea></div><div class="field"><label>Cons</label><textarea id="rvCons" rows="3"></textarea></div><div class="field"><label>下一轮考察点</label><textarea id="rvFocusNext" rows="3"></textarea></div><button class="btn primary" onclick="addReview()">新增/更新面评</button><div class="divider"></div><div id="reviewList" class="muted">暂无面评</div></div></div>' +
    '<div class="tabpanel" id="panel-activity"><div class="card shadowless" style="padding:12px"><div style="font-weight:900">动态</div><div class="divider"></div><div id="activityList" class="muted">暂无动态</div></div></div>' +
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
    'function renderSchedules(list){var box=document.getElementById("scheduleList");if(!list||!list.length){box.innerHTML=\'<div class="muted">暂无</div>\';return}box.innerHTML=list.map(function(x){return \'<div class="card shadowless" style="padding:12px;border-radius:14px;margin-bottom:10px"><div class="row"><b>第\'+x.round+\'轮</b><span class="pill"><span class="muted">时间</span><b>\'+esc(x.scheduledAt||"-")+\'</b></span><span class="spacer"></span><span class="muted">\'+esc(x.updatedAt||x.createdAt||"")+\'</span></div><div class="divider"></div><div class="muted">面试官：\'+esc(x.interviewers||"-")+\'</div><div class="muted">地点：\'+esc(x.location||"-")+\'</div></div>\'}).join("")}' +
    'function renderReviews(list){var box=document.getElementById("reviewList");if(!list||!list.length){box.innerHTML=\'<div class="muted">暂无面评</div>\';return}box.innerHTML=list.map(function(x){return \'<div class="card shadowless" style="padding:12px;border-radius:14px;margin-bottom:10px"><div class="row"><b>第\'+x.round+\'轮</b><span class="pill"><span class="muted">进度</span><b>\'+esc(x.status||"-")+\'</b></span><span class="pill"><span class="muted">评级</span><b>\'+esc(x.rating||"-")+\'</b></span></div><div class="divider"></div><div style="margin-bottom:6px"><b>Pros</b><div class="muted">\'+nl2br(x.pros||"-")+\'</div></div><div style="margin-bottom:6px"><b>Cons</b><div class="muted">\'+nl2br(x.cons||"-")+\'</div></div><div><b>下一轮考察</b><div class="muted">\'+nl2br(x.focusNext||"-")+\'</div></div></div>\'}).join("")}' +
    'function renderActivity(list){var box=document.getElementById("activityList");if(!list||!list.length){box.innerHTML=\'<div class="muted">暂无</div>\';return}box.innerHTML=\'<div class="timeline">\'+list.map(function(e){return \'<div class="titem"><div class="tmeta"><b>\'+esc(e.actor||"系统")+\'</b><span class="badge gray" style="font-size:11px">\'+esc(e.type||"-")+\'</span><span class="muted">\'+esc(e.createdAt||"")+\'</span></div><div class="tmsg">\'+nl2br(e.message||"")+\'</div></div>\'}).join("")+\'</div>\'}' +
    'async function loadCandidate(id){var res=await fetch("/api/candidates/"+encodeURIComponent(id));if(!res.ok){document.getElementById("drawerTitle").textContent="候选人不存在";return}var data=await res.json();document.getElementById("drawerTitle").textContent=data.name||"未命名";document.getElementById("drawerSub").textContent="ID: "+(data.id||"");document.getElementById("cStatus").textContent=data.status||"-";document.getElementById("cJob").textContent=data.jobTitle||data.jobId||"-";document.getElementById("cSource").textContent=data.source||"-";document.getElementById("fullOpenBtn").href="/candidates/"+encodeURIComponent(data.id);fillStatusSelect(data.status||"待筛选");document.getElementById("editName").value=data.name||"";document.getElementById("editPhone").value=data.phone||"";document.getElementById("editEmail").value=data.email||"";document.getElementById("editSource").value=data.source||"";document.getElementById("editNote").value=data.note||"";fillFollowOptions((data.follow&&data.follow.nextAction)||"待联系");document.getElementById("fuAt").value=(data.follow&&data.follow.followAt)||"";document.getElementById("fuNote").value=(data.follow&&data.follow.note)||"";renderSchedules(data.schedules||[]);renderResumeInline(data.resume||null);renderReviews(data.reviews||[]);renderActivity(data.events||[]);var f=document.getElementById("resumeUploadForm");f.onsubmit=async function(e){e.preventDefault();if(!CURRENT_ID)return;var fd=new FormData(f);var r=await fetch("/api/candidates/"+encodeURIComponent(CURRENT_ID)+"/resume",{method:"POST",body:fd});if(r.ok){await loadCandidate(CURRENT_ID);switchTab("resume")}else{alert("上传失败："+await r.text())}}}' +
    'async function updateStatus(){if(!CURRENT_ID)return;var v=document.getElementById("statusSelect").value;var res=await fetch("/api/candidates/"+encodeURIComponent(CURRENT_ID)+"/status",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:v})});if(res.ok)location.reload();else alert("更新失败")}' +
    'async function saveCandidate(){if(!CURRENT_ID)return;var payload={name:document.getElementById("editName").value,phone:document.getElementById("editPhone").value,email:document.getElementById("editEmail").value,source:document.getElementById("editSource").value,note:document.getElementById("editNote").value};var res=await fetch("/api/candidates/"+encodeURIComponent(CURRENT_ID),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});if(res.ok){await loadCandidate(CURRENT_ID);location.reload()}else alert("保存失败")}' +
    'async function saveFollow(){if(!CURRENT_ID)return;var payload={nextAction:document.getElementById("fuAction").value,followAt:document.getElementById("fuAt").value,note:document.getElementById("fuNote").value};var res=await fetch("/api/candidates/"+encodeURIComponent(CURRENT_ID)+"/follow",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});if(res.ok){await loadCandidate(CURRENT_ID);location.reload()}else alert("保存失败")}' +
    'async function saveSchedule(){if(!CURRENT_ID)return;var payload={round:Number(document.getElementById("scRound").value),scheduledAt:document.getElementById("scAt").value,interviewers:document.getElementById("scInterviewers").value,link:document.getElementById("scLink").value,location:document.getElementById("scLocation").value,syncStatus:document.getElementById("scSyncStatus").value};var res=await fetch("/api/candidates/"+encodeURIComponent(CURRENT_ID)+"/schedule",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});if(res.ok){await loadCandidate(CURRENT_ID);switchTab("schedule");location.reload()}else alert("保存失败")}' +
    'async function addReview(){if(!CURRENT_ID)return;var payload={round:Number(document.getElementById("rvRound").value),status:document.getElementById("rvStatus").value,rating:document.getElementById("rvRating").value,pros:document.getElementById("rvPros").value,cons:document.getElementById("rvCons").value,focusNext:document.getElementById("rvFocusNext").value};var res=await fetch("/api/candidates/"+encodeURIComponent(CURRENT_ID)+"/reviews",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});if(res.ok){document.getElementById("rvPros").value="";document.getElementById("rvCons").value="";document.getElementById("rvFocusNext").value="";await loadCandidate(CURRENT_ID);switchTab("review");location.reload()}else alert("保存失败")}' +
    '</script>';
}

app.get("/candidates/board", requireLogin, async (req, res) => {
  const d = await loadData();
  const q = String(req.query.q || "").trim().toLowerCase();
  const jobId = String(req.query.jobId || "").trim();
  const source = String(req.query.source || "").trim();

  const jobMap = new Map(d.jobs.map((j) => [j.id, j]));
  d.candidates.forEach((c) => {
    if (!c.jobTitle && c.jobId && jobMap.get(c.jobId)) c.jobTitle = jobMap.get(c.jobId).title;
    if (!STATUS_SET.has(c.status)) c.status = "待筛选";
    if (!c.follow) c.follow = { nextAction: "", followAt: "", note: "" };
    if (!Array.isArray(c.tags)) c.tags = [];
  });

  const filtered = d.candidates.filter((c) => {
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

  const boardResumeMap = new Map();
  for (const r of d.resumeFiles) {
    if (!r.url) continue;
    if (!boardResumeMap.has(r.candidateId) || (r.uploadedAt || "") > (boardResumeMap.get(r.candidateId).uploadedAt || "")) {
      boardResumeMap.set(r.candidateId, r);
    }
  }

  res.send(
    renderPage({
      title: "候选人看板",
      user: req.user,
      active: "candidates_board",
      contentHtml: toolbarHtml({ jobs: d.jobs, sources: d.sources, q, jobId, source, mode: "board" }) + '<div style="height:12px"></div>' + kanbanHtml({ grouped, countsByCol, resumeMap: boardResumeMap }),
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
    return res.send(renderPage({ title: "候选人不存在", user: req.user, active: "candidates_list", contentHtml: '<div class="card"><div style="font-weight:900">候选人不存在</div><div class="divider"></div><a class="btn" href="/candidates">返回</a></div>' }));
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

  const tagsHtml = (c.tags || []).map((t) => tagBadge(t)).join(" ");

  const scheduleHtml = schedules.length ? schedules.map((x) => '<div class="card shadowless" style="padding:12px;border-radius:14px;margin-bottom:10px"><div class="row"><b>第' + x.round + '轮</b><span class="pill"><span class="muted">时间</span><b>' + escapeHtml(x.scheduledAt || "-") + '</b></span><span class="spacer"></span><span class="muted">' + escapeHtml(x.updatedAt || x.createdAt || "") + '</span></div><div class="divider"></div><div class="muted">面试官：' + escapeHtml(x.interviewers || "-") + '</div><div class="muted">地点：' + escapeHtml(x.location || "-") + '</div>' + (x.link ? '<div class="muted">链接：<a class="btn sm" target="_blank" href="' + escapeHtml(x.link) + '">打开</a></div>' : "") + '</div>').join("") : '<div class="muted">暂无面试安排</div>';

  const reviewHtml = reviews.length ? reviews.map((x) => '<div class="card shadowless" style="padding:12px;border-radius:14px;margin-bottom:10px"><div class="row"><b>第' + x.round + '轮</b><span class="pill"><span class="muted">进度</span><b>' + escapeHtml(x.status || "-") + '</b></span><span class="pill"><span class="muted">评级</span><b>' + escapeHtml(x.rating || "-") + '</b></span><span class="spacer"></span><span class="muted">' + escapeHtml(x.createdAt || "") + '</span></div><div class="divider"></div><div style="margin-bottom:6px"><b>Pros</b><div class="muted">' + escapeHtml(x.pros || "-").replaceAll("\n", "<br/>") + '</div></div><div style="margin-bottom:6px"><b>Cons</b><div class="muted">' + escapeHtml(x.cons || "-").replaceAll("\n", "<br/>") + '</div></div><div><b>下一轮考察点</b><div class="muted">' + escapeHtml(x.focusNext || "-").replaceAll("\n", "<br/>") + '</div></div></div>').join("") : '<div class="muted">暂无面评</div>';

  const eventHtml = events.length ? '<div class="timeline">' + events.map((e) => '<div class="titem"><div class="tmeta"><b>' + escapeHtml(e.actor || "系统") + '</b><span class="pill"><span class="muted">时间</span><b>' + escapeHtml(e.createdAt || "") + '</b></span><span class="pill"><span class="muted">类型</span><b>' + escapeHtml(e.type || "-") + '</b></span></div><div class="tmsg">' + escapeHtml(e.message || "").replaceAll("\n", "<br/>") + '</div></div>').join("") + '</div>' : '<div class="muted">暂无动态</div>';

  const offerHtml = '<div class="card shadowless" style="padding:12px;border-radius:14px">' + (offer ? '<div class="row"><div style="font-weight:900">当前Offer</div><span class="spacer"></span>' + offerStatusBadge(offer.offerStatus) + '</div><div class="divider"></div><div class="row" style="margin-bottom:8px"><span class="pill"><span class="muted">薪资</span><b>' + escapeHtml(offer.salary || "-") + '</b></span><span class="pill"><span class="muted">入职日期</span><b>' + escapeHtml(offer.startDate || "-") + '</b></span></div><div class="muted">' + escapeHtml(offer.salaryNote || "") + '</div><div class="muted">' + escapeHtml(offer.note || "") + '</div><div class="divider"></div>' : '<div style="font-weight:900;margin-bottom:8px">Offer管理</div>') +
    '<form method="POST" action="/api/candidates/' + encodeURIComponent(c.id) + '/offer"><div class="row" style="gap:10px"><div class="field" style="min-width:160px"><label>薪资（月薪/年薪）</label><input name="salary" value="' + escapeHtml(offer?.salary || "") + '" placeholder="25K*15" /></div><div class="field" style="min-width:160px"><label>入职日期</label><input name="startDate" type="date" value="' + escapeHtml(offer?.startDate || "") + '" /></div><div class="field" style="min-width:140px"><label>Offer状态</label><select name="offerStatus">' + offerStOpts + '</select></div></div><div class="field"><label>薪资备注</label><input name="salaryNote" value="' + escapeHtml(offer?.salaryNote || "") + '" placeholder="如：base+bonus+RSU" /></div><div class="field"><label>Offer备注</label><textarea name="note" rows="2">' + escapeHtml(offer?.note || "") + '</textarea></div><button class="btn primary" type="submit">保存Offer</button></form></div>';

  const cid = encodeURIComponent(c.id);

  res.send(
    renderPage({
      title: "候选人：" + (c.name || ""),
      user: req.user,
      active: "candidates_list",
      contentHtml: '<div class="row"><div style="font-weight:900;font-size:18px">候选人详情：' + escapeHtml(c.name || "未命名") + '</div><span class="spacer"></span><a class="btn" href="/candidates">返回列表</a><a class="btn" href="/candidates/board">去看板</a><form method="POST" action="/candidates/' + cid + '/delete" style="display:inline" onsubmit="return confirm(\'确定删除此候选人及所有关联数据？\')"><button class="btn danger sm" type="submit">删除</button></form></div><div class="divider"></div>' +
        '<div class="card"><div class="row"><span class="pill"><span class="muted">ID</span><b class="mono">' + escapeHtml(c.id) + '</b></span><span class="pill"><span class="muted">岗位</span><b>' + escapeHtml(c.jobTitle || c.jobId || "-") + '</b></span><span class="pill"><span class="muted">来源</span><b>' + escapeHtml(c.source || "-") + '</b></span><span class="pill"><span class="muted">手机</span><b>' + escapeHtml(c.phone || "-") + '</b></span><span class="pill"><span class="muted">邮箱</span><b>' + escapeHtml(c.email || "-") + '</b></span><span class="pill"><span class="muted">状态</span><b>' + escapeHtml(c.status || "-") + '</b></span>' + followupBadge(c.follow) + '</div>' +
        '<div style="margin-top:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
        (resume && resume.url ? '<a class="btn sm" href="' + escapeHtml(resume.url) + '" target="_blank" rel="noreferrer" style="background:rgba(139,92,246,.08)">📎 ' + escapeHtml((resume.originalName || resume.filename || "简历").slice(0, 20)) + '</a>' : '<span class="badge gray">暂无简历</span>') +
        (tagsHtml ? ' ' + tagsHtml : '') +
        '</div>' +
        '</div>' +
        '<div style="height:14px"></div>' +
        '<div class="card">' +
        '<div class="tabs"><button class="tab active" data-tab="info" onclick="switchTab(\'info\')">信息</button><button class="tab" data-tab="follow" onclick="switchTab(\'follow\')">跟进</button><button class="tab" data-tab="schedule" onclick="switchTab(\'schedule\')">面试安排</button><button class="tab" data-tab="resume" onclick="switchTab(\'resume\')">简历</button><button class="tab" data-tab="review" onclick="switchTab(\'review\')">面评</button><button class="tab" data-tab="offer" onclick="switchTab(\'offer\')">Offer</button><button class="tab" data-tab="activity" onclick="switchTab(\'activity\')">动态</button></div>' +
        '<div class="tabpanels">' +
        '<div class="tabpanel active" id="panel-info"><div class="divider"></div><div class="grid"><div class="card shadowless"><div style="font-weight:900;margin-bottom:8px">编辑信息</div><div class="field"><label>姓名</label><input id="editName" value="' + escapeHtml(c.name || "") + '" /></div><div class="field"><label>手机</label><input id="editPhone" value="' + escapeHtml(c.phone || "") + '" /></div><div class="field"><label>邮箱</label><input id="editEmail" value="' + escapeHtml(c.email || "") + '" /></div><div class="field"><label>来源</label><input id="editSource" value="' + escapeHtml(c.source || "") + '" /></div><div class="field"><label>备注</label><textarea id="editNote" rows="4">' + escapeHtml(c.note || "") + '</textarea></div><button class="btn primary" onclick="saveCandidate()">保存</button></div><div class="card shadowless"><div style="font-weight:900;margin-bottom:8px">状态流转</div><div class="field"><label>候选人状态</label><select id="statusSelect">' + statusOptions + '</select></div><button class="btn primary" onclick="updateStatus()">更新状态</button></div></div></div>' +
        '<div class="tabpanel" id="panel-follow"><div class="divider"></div><div class="card shadowless" style="padding:12px;border-radius:14px"><div class="row"><div style="font-weight:900">下一步 & 跟进时间</div></div><div class="divider"></div><div class="field"><label>下一步动作</label><select id="fuAction">' + nextOpts + '</select></div><div class="field"><label>跟进时间</label><input id="fuAt" value="' + escapeHtml(c.follow.followAt || "") + '" placeholder="2026-02-08 14:00" /></div><div class="field"><label>跟进备注</label><textarea id="fuNote" rows="4">' + escapeHtml(c.follow.note || "") + '</textarea></div><button class="btn primary" onclick="saveFollow()">保存跟进</button></div></div>' +
        '<div class="tabpanel" id="panel-schedule"><div class="divider"></div><div class="card shadowless" style="padding:12px;border-radius:14px"><div class="row"><div style="font-weight:900">新增/更新面试安排</div></div><div class="divider"></div><div class="row" style="gap:10px"><div class="field" style="min-width:120px"><label>轮次</label><select id="scRound">' + roundOpts + '</select></div><div class="field" style="min-width:220px"><label>面试时间</label><input id="scAt" placeholder="2026-02-08 19:00" /></div></div><div class="field"><label>面试官</label><input id="scInterviewers" placeholder="张三 / 李四" /></div><div class="field"><label>会议链接</label><input id="scLink" /></div><div class="field"><label>地点/形式</label><input id="scLocation" /></div><div class="field"><label>同步状态</label><select id="scSyncStatus">' + syncOpts + '</select></div><button class="btn primary" onclick="saveSchedule()">保存面试安排</button></div><div style="height:12px"></div>' + scheduleHtml + '</div>' +
        '<div class="tabpanel" id="panel-resume"><div class="divider"></div><div class="row"><div style="font-weight:900">上传简历</div><span class="spacer"></span>' + (resume?.url ? '<a class="btn" href="' + escapeHtml(resume.url) + '" target="_blank" rel="noreferrer">新窗口打开</a>' : '') + '</div><div class="divider"></div><form id="resumeUploadForm" enctype="multipart/form-data"><div class="row"><input type="file" name="resume" accept=".pdf,.png,.jpg,.jpeg,.webp" /><button class="btn primary" type="submit">上传</button></div></form><div class="divider"></div>' + resumeEmbedHtml(resume) + '</div>' +
        '<div class="tabpanel" id="panel-review"><div class="divider"></div><div class="card shadowless" style="padding:12px;border-radius:14px"><div class="row"><div style="font-weight:900">新增/更新面评</div></div><div class="divider"></div><div class="row" style="gap:10px"><div class="field" style="min-width:120px"><label>轮次</label><select id="rvRound">' + roundOpts + '</select></div><div class="field" style="min-width:160px"><label>面试进度</label><select id="rvStatus">' + stOpts + '</select></div><div class="field" style="min-width:120px"><label>评级</label><select id="rvRating">' + rtOpts + '</select></div></div><div class="field"><label>Pros</label><textarea id="rvPros" rows="3"></textarea></div><div class="field"><label>Cons</label><textarea id="rvCons" rows="3"></textarea></div><div class="field"><label>下一轮考察点</label><textarea id="rvFocusNext" rows="3"></textarea></div><button class="btn primary" onclick="addReview()">新增/更新面评</button></div><div style="height:12px"></div>' + reviewHtml + '</div>' +
        '<div class="tabpanel" id="panel-offer"><div class="divider"></div>' + offerHtml + '</div>' +
        '<div class="tabpanel" id="panel-activity"><div class="divider"></div>' + eventHtml + '</div>' +
        '</div></div>' +
        '<script>function switchTab(t){document.querySelectorAll(".tab").forEach(function(e){e.classList.toggle("active",e.dataset.tab===t)});document.querySelectorAll(".tabpanel").forEach(function(p){p.classList.remove("active")});document.getElementById("panel-"+t).classList.add("active")}' +
        'async function saveCandidate(){var payload={name:document.getElementById("editName").value,phone:document.getElementById("editPhone").value,email:document.getElementById("editEmail").value,source:document.getElementById("editSource").value,note:document.getElementById("editNote").value};var res=await fetch("/api/candidates/' + cid + '",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});if(res.ok)location.reload();else alert("保存失败")}' +
        'async function updateStatus(){var v=document.getElementById("statusSelect").value;var res=await fetch("/api/candidates/' + cid + '/status",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:v})});if(res.ok)location.reload();else alert("更新失败")}' +
        'async function saveFollow(){var payload={nextAction:document.getElementById("fuAction").value,followAt:document.getElementById("fuAt").value,note:document.getElementById("fuNote").value};var res=await fetch("/api/candidates/' + cid + '/follow",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});if(res.ok)location.reload();else alert("保存失败")}' +
        'async function saveSchedule(){var payload={round:Number(document.getElementById("scRound").value),scheduledAt:document.getElementById("scAt").value,interviewers:document.getElementById("scInterviewers").value,link:document.getElementById("scLink").value,location:document.getElementById("scLocation").value,syncStatus:document.getElementById("scSyncStatus").value};var res=await fetch("/api/candidates/' + cid + '/schedule",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});if(res.ok)location.reload();else alert("保存失败")}' +
        'async function addReview(){var payload={round:Number(document.getElementById("rvRound").value),status:document.getElementById("rvStatus").value,rating:document.getElementById("rvRating").value,pros:document.getElementById("rvPros").value,cons:document.getElementById("rvCons").value,focusNext:document.getElementById("rvFocusNext").value};var res=await fetch("/api/candidates/' + cid + '/reviews",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});if(res.ok)location.reload();else alert("保存失败")}' +
        'var f=document.getElementById("resumeUploadForm");if(f){f.onsubmit=async function(e){e.preventDefault();var fd=new FormData(f);var r=await fetch("/api/candidates/' + cid + '/resume",{method:"POST",body:fd});if(r.ok)location.reload();else alert("上传失败："+await r.text())}}' +
        '</script>',
    })
  );
});
// 删除候选人
app.post("/candidates/:id/delete", requireLogin, async (req, res) => {
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
    await deleteCandidateRelated(cid);
    await saveData(d);
  }
  res.redirect("/candidates");
});

// ====== Offer 管理页 ======
app.get("/offers", requireLogin, async (req, res) => {
  const d = await loadData();
  const offers = d.offers || [];
  const candMap = new Map(d.candidates.map((c) => [c.id, c]));

  const rows = offers.map((o) => {
    const c = candMap.get(o.candidateId);
    return '<tr><td>' + (c ? '<a class="btn sm" href="/candidates/' + escapeHtml(c.id) + '">' + escapeHtml(c.name || "未命名") + '</a>' : escapeHtml(o.candidateId)) + '</td><td>' + escapeHtml(c?.jobTitle || "-") + '</td><td>' + escapeHtml(o.salary || "-") + '</td><td>' + escapeHtml(o.startDate || "-") + '</td><td>' + offerStatusBadge(o.offerStatus) + '</td><td class="muted">' + escapeHtml((o.updatedAt || o.createdAt || "").slice(0, 16)) + '</td></tr>';
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
app.get("/settings", requireLogin, async (req, res) => {
  const d = await loadData();
  const sourcesHtml = (d.sources || []).map((s) => '<span class="pill">' + escapeHtml(s) + '</span>').join(" ");
  const tagsHtml = (d.tags || []).map((t) => tagBadge(t)).join(" ");

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
        '</div>',
    })
  );
});

app.post("/settings/sources", requireLogin, async (req, res) => {
  const d = await loadData();
  const s = String(req.body.source || "").trim();
  if (s && !d.sources.includes(s)) d.sources.push(s);
  await saveData(d);
  res.redirect("/settings");
});

app.post("/settings/tags", requireLogin, async (req, res) => {
  const d = await loadData();
  const t = String(req.body.tag || "").trim();
  if (t && !d.tags.includes(t)) d.tags.push(t);
  await saveData(d);
  res.redirect("/settings");
});

// ====== API 路由 ======
app.get("/api/candidates/:id", requireLogin, async (req, res) => {
  const d = await loadData();
  const c = d.candidates.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "not_found" });
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

  const old = c.status || "待筛选";
  const status = String(req.body.status || "待筛选");
  c.status = STATUS_SET.has(status) ? status : "待筛选";
  c.updatedAt = nowIso();

  pushEvent(d, { candidateId: c.id, type: "状态流转", message: "状态：" + old + " -> " + c.status, actor: req.user?.name || "系统" });
  await saveData(d);
  // 飞书通知：状态变更
  if (feishuEnabled() && req.user?.openId) {
    sendFeishuMessage(req.user.openId,
      `**候选人**：${c.name}\n**状态变更**：${old} → ${c.status}\n**操作人**：${req.user?.name || "系统"}`,
      "候选人状态变更"
    ).catch(() => {});
  }
  // --- 飞书消息通知：候选人状态变更时通知操作者 ---
  if (feishuEnabled() && req.user?.provider === "feishu" && req.user?.openId) {
    const msgContent =
      `**候选人状态变更**\n` +
      `- 候选人：${c.name || "未知"}\n` +
      `- 状态变更：${old} -> ${c.status}\n` +
      `- 操作人：${req.user.name || "系统"}\n` +
      `- 时间：${c.updatedAt}`;
    // 异步发送，不阻塞响应
    sendFeishuMessage(req.user.openId, msgContent).catch((err) => {
      console.warn("[Feishu] 状态变更通知发送失败:", err.message || err);
    });
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

app.post("/api/candidates/:id/schedule", requireLogin, async (req, res) => {
  const d = await loadData();
  const c = d.candidates.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).send("candidate_not_found");

  const round = Number(req.body.round || 1);
  if (!INTERVIEW_ROUNDS.includes(round)) return res.status(400).send("invalid_round");

  const scheduledAt = String(req.body.scheduledAt || "").trim();
  const interviewers = String(req.body.interviewers || "").trim();
  const link = String(req.body.link || "").trim();
  const location = String(req.body.location || "").trim();
  const syncStatus = String(req.body.syncStatus || "（不同步）").trim();

  const idx = d.interviewSchedules.findIndex((x) => x.candidateId === c.id && x.round === round);
  const item = {
    id: idx > -1 ? d.interviewSchedules[idx].id : rid("sc"),
    candidateId: c.id,
    round,
    scheduledAt,
    interviewers,
    link,
    location,
    createdAt: idx > -1 ? d.interviewSchedules[idx].createdAt : nowIso(),
    updatedAt: nowIso(),
  };
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
  }
  await saveData(d);
  res.json({ ok: true });
});

app.post("/api/candidates/:id/reviews", requireLogin, async (req, res) => {
  const d = await loadData();
  const c = d.candidates.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "not_found" });

  const round = Number(req.body.round || 1);
  const status = String(req.body.status || "待一面");
  const rating = String(req.body.rating || "");
  var pros = String(req.body.pros || "");
  var cons = String(req.body.cons || "");
  var focusNext = String(req.body.focusNext || "");

  const note = String(req.body.note || "");
  if (!pros && !cons && !focusNext && note) pros = note;

  if (!INTERVIEW_ROUNDS.includes(round)) return res.status(400).send("invalid_round");
  if (rating && !INTERVIEW_RATING.includes(rating)) return res.status(400).send("invalid_rating");
  if (!STATUS_SET.has(status)) return res.status(400).send("invalid_status");

  const idx = d.interviews.findIndex((x) => x.candidateId === c.id && x.round === round);
  const item = {
    id: idx > -1 ? d.interviews[idx].id : rid("rv"),
    candidateId: c.id,
    round,
    status,
    rating,
    pros,
    cons,
    focusNext,
    note: idx > -1 ? d.interviews[idx].note : "",
    createdAt: nowIso(),
  };
  if (idx > -1) d.interviews[idx] = item;
  else d.interviews.push(item);

  const old = c.status || "待筛选";
  c.status = status;
  c.updatedAt = nowIso();

  pushEvent(d, { candidateId: c.id, type: "面评", message: "第" + round + "轮：进度=" + status + "，评级=" + (rating || "-") + "\nPros：" + (pros || "-") + "\nCons：" + (cons || "-"), actor: req.user?.name || "系统" });
  if (old !== c.status) {
    pushEvent(d, { candidateId: c.id, type: "状态同步", message: "因面评更新，状态：" + old + " -> " + c.status, actor: "系统" });
  }
  await saveData(d);
  res.json({ ok: true });
});

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
  // 飞书通知 + 审批：Offer 事件
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
  // --- 飞书审批流：Offer 已发放时尝试创建审批实例 ---
  if (offerStatus === "已发放" && feishuEnabled() && req.user?.provider === "feishu" && req.user?.openId) {
    const approvalCode = (process.env.FEISHU_APPROVAL_CODE || "").trim();
    if (approvalCode) {
      // 查找关联的职位信息
      const job = d.jobs.find((j) => j.id === c.jobId);
      const formData = [
        { id: "candidate_name", type: "input", value: c.name || "" },
        { id: "job_title", type: "input", value: job?.title || c.jobTitle || "" },
        { id: "salary", type: "input", value: salary || "" },
        { id: "start_date", type: "input", value: startDate || "" },
        { id: "note", type: "textarea", value: note || salaryNote || "" },
      ];
      // 异步创建审批，不阻塞响应
      createApprovalInstance(approvalCode, req.user.openId, formData).catch((err) => {
        console.warn("[Feishu] Offer审批创建失败:", err.message || err);
      });
    } else {
      console.log("[Feishu] Offer已发放，但未配置 FEISHU_APPROVAL_CODE，跳过创建审批");
    }

    // 同时发飞书消息通知操作者
    const msgContent =
      `**Offer 已发放**\n` +
      `- 候选人：${c.name || "未知"}\n` +
      `- 职位：${(d.jobs.find((j) => j.id === c.jobId))?.title || c.jobTitle || "-"}\n` +
      `- 薪资：${salary || "-"}\n` +
      `- 入职日期：${startDate || "-"}\n` +
      `- 操作人：${req.user.name || "系统"}`;
    sendFeishuMessage(req.user.openId, msgContent).catch((err) => {
      console.warn("[Feishu] Offer通知发送失败:", err.message || err);
    });
  }

  res.redirect("/candidates/" + c.id);
});

// ====== 启动（本地开发时 listen，Vercel 上由 api/index.mjs 导出）======
if (!isServerless) {
  const port = Number(process.env.PORT || 3001);
  app.listen(port, "0.0.0.0", () => {
    console.log("[OK] Web: http://localhost:" + port);
    console.log("[OK] 全部候选人: http://localhost:" + port + "/candidates");
    console.log("[OK] 看板: http://localhost:" + port + "/candidates/board");
    console.log("[OK] Offer管理: http://localhost:" + port + "/offers");
  });
}

export default app;