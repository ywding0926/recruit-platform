import path from "path";
import fs from "fs";
import { escapeHtml } from "./ui.mjs";
import { getSupabaseAdmin, getBucketName, getSignedUrlExpiresIn } from "./supabase.mjs";
import { nowIso, rid } from "./db.mjs";
import { feishuEnabled, sendFeishuMessage } from "./feishu.mjs";
import { STATUS_KEYS, STATUS_SET } from "./constants.mjs";

const isServerless = !!process.env.VERCEL;
const UPLOADS_DIR = path.join(process.cwd(), "uploads");

// ====== 卡片快捷操作按钮 ======
export function cardQuickBtns(candidateId, currentStatus) {
  const idx = STATUS_KEYS.indexOf(currentStatus);
  const isTerminal = currentStatus === "入职" || currentStatus === "淘汰";
  const nextStatus = (!isTerminal && idx >= 0 && idx < STATUS_KEYS.length - 2) ? STATUS_KEYS[idx + 1] : null;
  let html = '<div class="card-quick" onclick="event.stopPropagation()">';
  if (nextStatus) {
    html += '<button class="qbtn qbtn-next" title="推进到：' + escapeHtml(nextStatus) + '" onclick="quickStatus(\'' + escapeHtml(candidateId) + '\',\'' + escapeHtml(nextStatus) + '\')">推进 →</button>';
  }
  if (!isTerminal) {
    html += '<button class="qbtn qbtn-reject" title="淘汰" onclick="quickStatus(\'' + escapeHtml(candidateId) + '\',\'淘汰\')">淘汰</button>';
  }
  html += '</div>';
  return isTerminal ? '' : html;
}

// ====== 时间线事件 ======
export function pushEvent(d, { candidateId, type, message, actor }) {
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
export async function notifyHrNewCandidate(d, candidate, job) {
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

    // 优先通知岗位负责人（支持多人），如果没有则通知所有管理员
    let notifyIds = [];
    if (Array.isArray(job?.owners) && job.owners.length > 0) {
      notifyIds = job.owners.map(o => o.openId).filter(Boolean);
    } else if (job?.ownerOpenId) {
      // 兼容旧格式：可能是逗号分隔的多个openId
      notifyIds = job.ownerOpenId.split(",").map(id => id.trim()).filter(Boolean);
    }
    if (!notifyIds.length) {
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
export function getVisibleJobIds(user, jobs) {
  if (!user) return new Set();
  if (user.role === "admin") return null; // null = 不过滤，全部可见
  const openId = user.openId || "";
  const name = user.name || "";
  const ids = new Set();
  for (const j of jobs) {
    // 检查新的 owners 数组
    if (Array.isArray(j.owners) && j.owners.length > 0) {
      if (j.owners.some(o => (openId && o.openId === openId) || (!o.openId && name && o.name === name))) {
        ids.add(j.id);
        continue;
      }
    }
    // 兼容旧的单负责人字段
    if ((openId && j.ownerOpenId === openId) || (!j.ownerOpenId && name && j.owner === name)) {
      ids.add(j.id);
    }
  }
  return ids;
}

export function filterCandidatesByPermission(candidates, visibleJobIds) {
  if (visibleJobIds === null) return candidates; // admin
  return candidates.filter(c => visibleJobIds.has(c.jobId));
}

// ====== 候选人查重：姓名+手机号完全匹配 ======
export function findDuplicate(candidates, name, phone) {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  const p = (phone || "").trim();
  // 如果有手机号，姓名+手机号同时匹配才算重复；如果没手机号，仅姓名匹配
  if (p) {
    return candidates.find(c => c.name && c.name.trim().toLowerCase() === n && c.phone && c.phone.trim() === p) || null;
  }
  return null; // 没有手机号时不做查重，避免误判
}

export function safeExtFromName(name) {
  const base = String(name || "");
  const i = base.lastIndexOf(".");
  if (i === -1) return "";
  const ext = base.slice(i).toLowerCase();
  if (!/^\.[a-z0-9]{1,8}$/.test(ext)) return "";
  return ext;
}

// ====== 简历存储 ======
export async function saveResumeSupabaseOrLocal(d, candidateId, file, actorName) {
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

export async function refreshResumeUrlIfNeeded(resumeMeta) {
  if (!resumeMeta) return null;
  // 兼容 storage 字段可能是 "local" 但实际 URL 指向 supabase 的历史数据
  const isSupabase = resumeMeta.storage === "supabase" || (resumeMeta.url && resumeMeta.url.includes("supabase.co"));
  if (!isSupabase) return resumeMeta;
  try {
    const supabase = getSupabaseAdmin();
    const bucket = resumeMeta.bucket || getBucketName();
    if (!supabase || !bucket) return resumeMeta;
    // 从现有 URL 中提取对象路径（如 resumes/xxx.pdf），比 filename 字段更可靠
    let objectPath = resumeMeta.filename;
    if (resumeMeta.url && resumeMeta.url.includes("supabase.co")) {
      const match = resumeMeta.url.match(/\/object\/(?:sign|public)\/[^/]+\/(.+?)(?:\?|$)/);
      if (match) objectPath = decodeURIComponent(match[1]);
    }
    const { data: signed, error: signErr } = await supabase.storage
      .from(bucket)
      .createSignedUrl(objectPath, getSignedUrlExpiresIn());
    if (signErr || !signed?.signedUrl) return resumeMeta;
    return { ...resumeMeta, url: signed.signedUrl };
  } catch {
    return resumeMeta;
  }
}

// ====== 工具条 ======
export function toolbarHtml({ jobs, sources, q = "", jobId = "", source = "", mode = "list", isAdmin = false }) {
  const jobOpts = ['<option value="">全部岗位</option>']
    .concat(jobs.map((j) => '<option value="' + escapeHtml(j.id) + '" ' + (j.id === jobId ? "selected" : "") + '>' + escapeHtml(j.title || j.id) + '</option>'))
    .join("");
  const srcOpts = ['<option value="">全部来源</option>']
    .concat(sources.map((s) => '<option value="' + escapeHtml(s) + '" ' + (s === source ? "selected" : "") + '>' + escapeHtml(s) + '</option>'))
    .join("");

  const targetPath = mode === "board" ? "/candidates/board" : "/candidates";

  const adminBtns = isAdmin
    ? '<a class="btn" href="/candidates/new">新建候选人</a>' +
      '<a class="btn" href="/candidates/import">批量导入</a>'
    : '';

  return '<div class="toolbar">' +
    '<div class="ctl"><label>搜索</label><input id="q" value="' + escapeHtml(q) + '" placeholder="姓名 / 手机 / 备注关键词" /></div>' +
    '<div class="ctl"><label>岗位</label><select id="jobId" onchange="applyFilters()">' + jobOpts + '</select></div>' +
    '<div class="ctl"><label>来源</label><select id="source" onchange="applyFilters()">' + srcOpts + '</select></div>' +
    '<span class="spacer"></span>' +
    adminBtns +
    '</div>' +
    '<script>function applyFilters(){var q=document.getElementById("q").value||"";var jobId=document.getElementById("jobId").value||"";var source=document.getElementById("source").value||"";var u=new URL(location.href);u.pathname="' + targetPath + '";if(q)u.searchParams.set("q",q);else u.searchParams.delete("q");if(jobId)u.searchParams.set("jobId",jobId);else u.searchParams.delete("jobId");if(source)u.searchParams.set("source",source);else u.searchParams.delete("source");location.href=u.toString()}' +
    'var _searchTimer;document.getElementById("q").addEventListener("input",function(){clearTimeout(_searchTimer);_searchTimer=setTimeout(applyFilters,400)});document.getElementById("q").addEventListener("keydown",function(e){if(e.key==="Enter"){clearTimeout(_searchTimer);applyFilters()}})</script>';
}

// ====== 岗位招聘漏斗统计 ======
export function jobFunnelStats(d, jobId) {
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
