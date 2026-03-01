import fs from "fs";
import path from "path";
import crypto from "crypto";
import { supabaseEnabled, getSupabaseAdmin } from "./supabase.mjs";

const isServerless = !!process.env.VERCEL;
const DATA_PATH = path.join(process.cwd(), "data.json");

// ===== 通用工具 =====
export function nowIso() {
  // 返回北京时间 ISO 格式（不带Z后缀）
  const d = new Date(Date.now() + 8 * 3600000);
  return d.toISOString().replace("Z", "").slice(0, 19);
}

// 将任意时间字符串转为北京时间显示格式 yyyy-MM-ddTHH:mm
export function toBjTime(str) {
  if (!str) return "";
  // 已经是北京时间格式（不含Z和+00:00）
  if (!/[Zz]|\+00:00$/.test(str)) return str;
  // UTC 时间，转为北京时间
  const d = new Date(str);
  if (isNaN(d.getTime())) return str;
  const bj = new Date(d.getTime() + 8 * 3600000);
  return bj.toISOString().replace("Z", "").slice(0, 19);
}

export function rid(prefix = "id") {
  const rnd = crypto.randomBytes(8).toString("hex");
  return `${prefix}_${Date.now()}_${rnd}`;
}

// ===== 数据结构兜底 =====
export function ensureDataShape(d) {
  if (!d || typeof d !== "object") d = {};
  if (!Array.isArray(d.jobs)) d.jobs = [];
  if (!Array.isArray(d.candidates)) d.candidates = [];
  if (!Array.isArray(d.sources))
    d.sources = ["官网投递", "内推", "Boss直聘", "猎头", "飞书表单", "手动录入"];
  if (!Array.isArray(d.interviews)) d.interviews = [];
  if (!Array.isArray(d.interviewSchedules)) d.interviewSchedules = [];
  if (!Array.isArray(d.resumeFiles)) d.resumeFiles = [];
  if (!Array.isArray(d.events)) d.events = [];
  if (!Array.isArray(d.offers)) d.offers = [];
  if (!Array.isArray(d.tags)) d.tags = ["高潜", "紧急", "待定", "优秀", "内推优先", "已拒绝其他Offer"];
  if (!Array.isArray(d.users)) d.users = [];
  if (!Array.isArray(d.headhunters)) d.headhunters = [];
  return d;
}

// ===== 本地读写 =====
export function loadDataLocal() {
  if (isServerless) return ensureDataShape({});
  try {
    const raw = fs.readFileSync(DATA_PATH, "utf-8");
    const d = ensureDataShape(JSON.parse(raw));
    // 修复本地存储简历 URL 为空的问题
    for (const rf of d.resumeFiles) {
      if (!rf.url && rf.filename && (rf.storage === "local" || !rf.storage)) {
        rf.url = "/uploads/" + encodeURIComponent(rf.filename);
      }
    }
    return d;
  } catch {
    const init = ensureDataShape({});
    try { fs.writeFileSync(DATA_PATH, JSON.stringify(init, null, 2), "utf-8"); } catch {}
    return init;
  }
}

export function saveDataLocal(d) {
  if (isServerless) return;
  fs.writeFileSync(DATA_PATH, JSON.stringify(ensureDataShape(d), null, 2), "utf-8");
}

// ===== Supabase 映射 =====
function candToRow(c) {
  const follow = c.follow || {};
  return {
    id: c.id,
    name: c.name ?? null,
    phone: c.phone ?? null,
    email: c.email ?? null,
    job_id: c.jobId ?? null,
    job_title: c.jobTitle ?? null,
    source: c.source ?? null,
    note: c.note ?? null,
    status: c.status ?? null,
    tags: c.tags ? JSON.stringify(c.tags) : null,
    follow_next_action: follow.nextAction ?? null,
    follow_at: follow.followAt ?? null,
    follow_note: follow.note ?? null,
    headhunter_id: c.headhunterId ?? null,
    created_at: c.createdAt ?? null,
    updated_at: c.updatedAt ?? null,
  };
}
function candFromRow(r) {
  let tags = [];
  try { tags = r.tags ? JSON.parse(r.tags) : []; } catch { tags = []; }
  return {
    id: r.id,
    name: r.name ?? "",
    phone: r.phone ?? "",
    email: r.email ?? "",
    jobId: r.job_id ?? "",
    jobTitle: r.job_title ?? "",
    source: r.source ?? "",
    note: r.note ?? "",
    status: r.status ?? "待筛选",
    tags: Array.isArray(tags) ? tags : [],
    follow: {
      nextAction: r.follow_next_action ?? "待联系",
      followAt: r.follow_at ?? "",
      note: r.follow_note ?? "",
    },
    headhunterId: r.headhunter_id ?? "",
    createdAt: r.created_at ?? nowIso(),
    updatedAt: r.updated_at ?? r.created_at ?? nowIso(),
  };
}

function jobToRow(j) {
  return {
    id: j.id,
    title: j.title ?? null,
    department: j.department ?? null,
    location: j.location ?? null,
    owner: j.owner ?? null,
    owner_open_id: j.ownerOpenId ?? null,
    headcount: j.headcount ?? null,
    level: j.level ?? null,
    state: j.state ?? null,
    category: j.category ?? null,
    jd: j.jd ?? null,
    created_at: j.createdAt ?? null,
    updated_at: j.updatedAt ?? null,
  };
}
function jobFromRow(r) {
  return {
    id: r.id,
    title: r.title ?? "",
    department: r.department ?? "",
    location: r.location ?? "",
    owner: r.owner ?? "",
    ownerOpenId: r.owner_open_id ?? "",
    headcount: r.headcount ?? null,
    level: r.level ?? "",
    state: r.state ?? "open",
    category: r.category ?? "",
    jd: r.jd ?? "",
    createdAt: r.created_at ?? nowIso(),
    updatedAt: r.updated_at ?? r.created_at ?? nowIso(),
  };
}

function interviewToRow(x) {
  return {
    id: x.id,
    candidate_id: x.candidateId ?? null,
    round: x.round ?? null,
    status: x.status ?? null,
    rating: x.rating ?? null,
    interviewer: x.interviewer ?? null,
    dimensions: x.dimensions ? JSON.stringify(x.dimensions) : null,
    pros: x.pros ?? null,
    cons: x.cons ?? null,
    focus_next: x.focusNext ?? null,
    note: x.note ?? null,
    created_at: x.createdAt ?? null,
  };
}
function interviewFromRow(r) {
  let dims = {};
  if (r.dimensions) {
    try { dims = typeof r.dimensions === "string" ? JSON.parse(r.dimensions) : r.dimensions; } catch { dims = {}; }
  }
  return {
    id: r.id,
    candidateId: r.candidate_id ?? "",
    round: r.round ?? 1,
    status: r.status ?? "",
    rating: r.rating ?? "",
    interviewer: r.interviewer ?? "",
    dimensions: dims,
    pros: r.pros ?? "",
    cons: r.cons ?? "",
    focusNext: r.focus_next ?? "",
    note: r.note ?? "",
    createdAt: r.created_at ?? nowIso(),
  };
}

function scheduleToRow(x) {
  return {
    id: x.id,
    candidate_id: x.candidateId ?? null,
    round: x.round ?? null,
    scheduled_at: x.scheduledAt ?? null,
    interviewers: x.interviewers ?? null,
    link: x.link ?? null,
    location: x.location ?? null,
    review_token: x.reviewToken ?? null,
    meeting_no: x.meetingNo ?? null,
    recording_url: x.recordingUrl ?? null,
    review_reminder_sent: x.reviewReminderSent ? true : false,
    created_at: x.createdAt ?? null,
    updated_at: x.updatedAt ?? null,
  };
}
function scheduleFromRow(r) {
  return {
    id: r.id,
    candidateId: r.candidate_id ?? "",
    round: r.round ?? 1,
    scheduledAt: r.scheduled_at ?? "",
    interviewers: r.interviewers ?? "",
    link: r.link ?? "",
    location: r.location ?? "",
    reviewToken: r.review_token ?? "",
    meetingNo: r.meeting_no ?? "",
    recordingUrl: r.recording_url ?? "",
    reviewReminderSent: !!r.review_reminder_sent,
    createdAt: r.created_at ?? nowIso(),
    updatedAt: r.updated_at ?? r.created_at ?? nowIso(),
  };
}

function resumeToRow(x) {
  return {
    id: x.id,
    candidate_id: x.candidateId ?? null,
    filename: x.filename ?? null,
    original_name: x.originalName ?? null,
    content_type: x.contentType ?? null,
    size: x.size ?? null,
    uploaded_at: x.uploadedAt ?? null,
    url: x.url ?? null,
  };
}
function resumeFromRow(r) {
  return {
    id: r.id,
    candidateId: r.candidate_id ?? "",
    filename: r.filename ?? "",
    originalName: r.original_name ?? "",
    contentType: r.content_type ?? "",
    size: r.size ?? 0,
    uploadedAt: r.uploaded_at ?? nowIso(),
    url: r.url ?? "",
    storage: r.storage ?? "local",
    bucket: r.bucket ?? "",
  };
}

function eventToRow(e) {
  return {
    id: e.id,
    candidate_id: e.candidateId ?? null,
    type: e.type ?? null,
    message: e.message ?? null,
    actor: e.actor ?? null,
    created_at: e.createdAt ?? null,
  };
}
function eventFromRow(r) {
  return {
    id: r.id,
    candidateId: r.candidate_id ?? "",
    type: r.type ?? "",
    message: r.message ?? "",
    actor: r.actor ?? "系统",
    createdAt: r.created_at ?? nowIso(),
  };
}

function hunterToRow(h) {
  return {
    id: h.id,
    name: h.name ?? null,
    company: h.company ?? null,
    api_key: h.apiKey ?? null,
    enabled: h.enabled !== false,
    created_at: h.createdAt ?? null,
  };
}
function hunterFromRow(r) {
  return {
    id: r.id,
    name: r.name ?? "",
    company: r.company ?? "",
    apiKey: r.api_key ?? "",
    enabled: r.enabled !== false,
    createdAt: r.created_at ?? nowIso(),
  };
}

function offerToRow(o) {
  return {
    id: o.id,
    candidate_id: o.candidateId ?? null,
    job_id: o.jobId ?? null,
    salary: o.salary ?? null,
    salary_note: o.salaryNote ?? null,
    start_date: o.startDate ?? null,
    offer_status: o.offerStatus ?? null,
    note: o.note ?? null,
    created_at: o.createdAt ?? null,
    updated_at: o.updatedAt ?? null,
  };
}
function offerFromRow(r) {
  return {
    id: r.id,
    candidateId: r.candidate_id ?? "",
    jobId: r.job_id ?? "",
    salary: r.salary ?? "",
    salaryNote: r.salary_note ?? "",
    startDate: r.start_date ?? "",
    offerStatus: r.offer_status ?? "待发放",
    note: r.note ?? "",
    createdAt: r.created_at ?? nowIso(),
    updatedAt: r.updated_at ?? r.created_at ?? nowIso(),
  };
}

function userToRow(u) {
  return {
    id: u.id,
    open_id: u.openId ?? null,
    union_id: u.unionId ?? null,
    name: u.name ?? null,
    avatar: u.avatar ?? null,
    department: u.department ?? null,
    job_title: u.jobTitle ?? null,
    provider: u.provider ?? null,
    role: u.role ?? "member",
    created_at: u.createdAt ?? null,
  };
}
function userFromRow(r) {
  return {
    id: r.id,
    openId: r.open_id ?? "",
    unionId: r.union_id ?? "",
    name: r.name ?? "",
    avatar: r.avatar ?? "",
    department: r.department ?? "",
    jobTitle: r.job_title ?? "",
    provider: r.provider ?? "feishu",
    role: r.role ?? "member",
    createdAt: r.created_at ?? nowIso(),
  };
}

async function sbSelectAll(admin, table) {
  const { data, error } = await admin.from(table).select("*");
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function upsertWithRetry(admin, table, rows, minimalKeys = []) {
  if (!rows.length) return;
  let current = rows;
  const dropped = [];
  // 最多尝试 6 次（去掉最多 5 个缺失列）
  for (let attempt = 0; attempt < 6; attempt++) {
    const { error } = await admin.from(table).upsert(current, { onConflict: "id" });
    if (!error) return;
    // 检查是否是缺列错误（Supabase 可能用单引号或双引号）
    const colMatch = error.message?.match(/(?:column ["']([^"']+)["'] of relation|the '([^']+)' column of)/);
    if (colMatch) {
      const badCol = colMatch[1] || colMatch[2];
      dropped.push(badCol);
      console.warn("[upsert] " + table + " 缺列 '" + badCol + "'，去掉后重试 (attempt " + (attempt + 1) + ")");
      current = current.map(r => { const o = { ...r }; delete o[badCol]; return o; });
      continue;
    }
    // 非缺列错误，用 minimalKeys fallback
    if (minimalKeys.length) {
      console.warn("[upsert] " + table + " 非缺列错误：" + error.message + "，fallback minimalKeys");
      const slim = rows.map((r) => { const o = {}; for (const k of minimalKeys) { if (r[k] !== undefined && !dropped.includes(k)) o[k] = r[k]; } return o; });
      const r2 = await admin.from(table).upsert(slim, { onConflict: "id" });
      if (r2.error) throw r2.error;
      return;
    }
    throw error;
  }
  console.warn("[upsert] " + table + " 重试次数用完，dropped:", dropped.join(","));
}

// ===== 对外 API：loadData / saveData =====
export async function loadData() {
  if (!supabaseEnabled) return loadDataLocal();

  try {
    const admin = getSupabaseAdmin();

    const [jobs, candidates, interviews, interviewSchedules, resumeFiles, events] = await Promise.all([
      sbSelectAll(admin, "jobs"),
      sbSelectAll(admin, "candidates"),
      sbSelectAll(admin, "interviews"),
      sbSelectAll(admin, "interview_schedules"),
      sbSelectAll(admin, "resume_files"),
      sbSelectAll(admin, "events"),
    ]);

    let offers = [];
    try { offers = await sbSelectAll(admin, "offers"); } catch {}
    let users = [];
    try { users = await sbSelectAll(admin, "users"); } catch {}
    let headhunters = [];
    try { headhunters = await sbSelectAll(admin, "headhunters"); } catch {}

    const d = ensureDataShape({
      jobs: jobs.map(jobFromRow),
      candidates: candidates.map(candFromRow),
      interviews: interviews.map(interviewFromRow),
      interviewSchedules: interviewSchedules.map(scheduleFromRow),
      resumeFiles: resumeFiles.map(resumeFromRow),
      events: events.map(eventFromRow),
      offers: offers.map(offerFromRow),
      users: users.map(userFromRow),
      headhunters: headhunters.map(hunterFromRow),
    });

    if (isServerless) {
      d.sources = Array.from(new Set([...d.sources, ...d.candidates.map((c) => c.source).filter(Boolean)]));
      d.tags = Array.from(new Set([...d.tags, ...d.candidates.flatMap((c) => c.tags || []).filter(Boolean)]));
      // Serverless 环境也尝试合并本地数据（补充 Supabase 中可能缺失的字段）
      try {
        const local = loadDataLocal();
        // 合并本地 headhunters（不覆盖，补充 Supabase 中没有的）
        const hIds = new Set(d.headhunters.map(h => h.id));
        for (const lh of (local.headhunters || [])) {
          if (!hIds.has(lh.id)) d.headhunters.push(lh);
        }
        // 合并本地 candidates 的 headhunterId
        const localCandMap = new Map((local.candidates || []).map(c => [c.id, c]));
        for (const c of d.candidates) {
          const lc = localCandMap.get(c.id);
          if (lc && lc.headhunterId && !c.headhunterId) c.headhunterId = lc.headhunterId;
        }
        // 合并本地 users 的 role
        const localUserMap = new Map((local.users || []).map(u => [u.id, u]));
        for (const u of d.users) {
          const lu = localUserMap.get(u.id);
          if (lu && lu.role && lu.role !== "member" && (!u.role || u.role === "member")) u.role = lu.role;
        }
        // 合并本地 jobs 的 ownerOpenId
        const localJobMap = new Map((local.jobs || []).map(j => [j.id, j]));
        for (const j of d.jobs) {
          const lj = localJobMap.get(j.id);
          if (lj && lj.ownerOpenId && !j.ownerOpenId) j.ownerOpenId = lj.ownerOpenId;
          if (lj && lj.owner && !j.owner) j.owner = lj.owner;
        }
      } catch {}
      return ensureDataShape(d);
    }

    // 合并本地数据
    const local = loadDataLocal();
    d.sources = Array.from(new Set([...(local.sources || []), ...d.candidates.map((c) => c.source).filter(Boolean)]));
    d.tags = Array.from(new Set([...(local.tags || []), ...d.candidates.flatMap((c) => c.tags || []).filter(Boolean)]));

    // 合并本地 resumeFiles
    const sbResumeMap = new Map(d.resumeFiles.map((r) => [r.id, r]));
    for (const lr of (local.resumeFiles || [])) {
      const sbr = sbResumeMap.get(lr.id);
      if (!sbr) {
        d.resumeFiles.push(lr);
      } else if (lr.url && !sbr.url) {
        const idx = d.resumeFiles.indexOf(sbr);
        if (idx > -1) d.resumeFiles[idx] = lr;
      }
    }

    // 修复简历 URL
    for (const rf of d.resumeFiles) {
      if (!rf.url && rf.filename && rf.storage === "local") {
        rf.url = "/uploads/" + encodeURIComponent(rf.filename);
      }
    }

    // 合并其他本地数据
    const merge = (arr, localArr, key = "id") => {
      const ids = new Set(arr.map((x) => x[key]));
      for (const item of (localArr || [])) {
        if (!ids.has(item[key])) arr.push(item);
      }
    };
    merge(d.offers, local.offers);
    merge(d.events, local.events);
    merge(d.interviews, local.interviews);
    merge(d.interviewSchedules, local.interviewSchedules);
    merge(d.candidates, local.candidates);
    merge(d.users, local.users);
    // 猎头：合并 Supabase 和本地（如果 Supabase 没有 headhunters 表，d.headhunters 为空）
    merge(d.headhunters, local.headhunters);

    // 合并本地 candidates 的 headhunterId 字段（Supabase 表没有此列）
    const localCandMap = new Map((local.candidates || []).map(c => [c.id, c]));
    for (const c of d.candidates) {
      const lc = localCandMap.get(c.id);
      if (lc && lc.headhunterId && !c.headhunterId) {
        c.headhunterId = lc.headhunterId;
      }
    }

    // 合并本地 users 的 role 字段（Supabase 表可能没有 role 列）
    const localUserMap = new Map((local.users || []).map(u => [u.id, u]));
    for (const u of d.users) {
      const lu = localUserMap.get(u.id);
      if (lu && lu.role && lu.role !== "member" && (!u.role || u.role === "member")) {
        u.role = lu.role;
      }
    }

    // 合并本地 interviewSchedules 的 reviewReminderSent（Supabase 表可能没有此列）
    const localSchedMap = new Map((local.interviewSchedules || []).map(s => [s.id, s]));
    for (const sc of d.interviewSchedules) {
      const ls = localSchedMap.get(sc.id);
      if (ls && ls.reviewReminderSent) sc.reviewReminderSent = true;
    }

    return ensureDataShape(d);
  } catch (e) {
    console.warn("[WARN] loadData from supabase failed, fallback to local:", String(e?.message || e));
    return loadDataLocal();
  }
}

export async function saveData(d) {
  const shaped = ensureDataShape(d);

  try {
    saveDataLocal(shaped);
  } catch (e) {
    console.warn("[WARN] saveDataLocal failed:", String(e?.message || e));
  }

  if (!supabaseEnabled) return;

  try {
    const admin = getSupabaseAdmin();

    const results = await Promise.allSettled([
      upsertWithRetry(admin, "jobs", shaped.jobs.map(jobToRow), ["id", "title"]),
      upsertWithRetry(admin, "candidates", shaped.candidates.map(candToRow), ["id", "name", "phone", "job_id", "job_title", "source"]),
      upsertWithRetry(admin, "interviews", shaped.interviews.map(interviewToRow), ["id", "candidate_id", "round", "status", "rating", "interviewer", "note", "created_at"]),
      upsertWithRetry(admin, "interview_schedules", shaped.interviewSchedules.map(scheduleToRow), ["id", "candidate_id", "round", "scheduled_at", "interviewers", "link", "location", "created_at", "updated_at"]),
      upsertWithRetry(admin, "resume_files", shaped.resumeFiles.map(resumeToRow), ["id", "candidate_id", "filename", "url", "original_name", "content_type", "size", "uploaded_at"]),
      upsertWithRetry(admin, "events", shaped.events.map(eventToRow), ["id", "candidate_id", "type"]),
    ]);
    const tableNames = ["jobs", "candidates", "interviews", "interview_schedules", "resume_files", "events"];
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "rejected") {
        console.warn("[WARN] saveData upsert " + tableNames[i] + " failed:", String(results[i].reason?.message || results[i].reason));
      }
    }

    try {
      if (shaped.offers.length) {
        await upsertWithRetry(admin, "offers", shaped.offers.map(offerToRow), ["id", "candidate_id"]);
      }
    } catch {}

    try {
      if (shaped.users.length) {
        await upsertWithRetry(admin, "users", shaped.users.map(userToRow), ["id", "open_id", "name"]);
      }
    } catch {}

    try {
      if (shaped.headhunters.length) {
        await upsertWithRetry(admin, "headhunters", shaped.headhunters.map(hunterToRow), ["id", "name"]);
      }
    } catch {}
  } catch (e) {
    console.warn("[WARN] saveData to supabase failed:", String(e?.message || e));
  }
}

// ===== 删除辅助 =====
export async function deleteFromSupabase(table, id) {
  if (!supabaseEnabled) return;
  try {
    const admin = getSupabaseAdmin();
    await admin.from(table).delete().eq("id", id);
  } catch (e) {
    console.warn(`[WARN] deleteFromSupabase(${table}, ${id}) failed:`, String(e?.message || e));
  }
}

export async function deleteCandidateRelated(candidateId) {
  if (!supabaseEnabled) return;
  try {
    const admin = getSupabaseAdmin();
    await Promise.all([
      admin.from("interviews").delete().eq("candidate_id", candidateId),
      admin.from("interview_schedules").delete().eq("candidate_id", candidateId),
      admin.from("resume_files").delete().eq("candidate_id", candidateId),
      admin.from("events").delete().eq("candidate_id", candidateId),
      admin.from("candidates").delete().eq("id", candidateId),
    ]);
    try { await admin.from("offers").delete().eq("candidate_id", candidateId); } catch {}
  } catch (e) {
    console.warn("[WARN] deleteCandidateRelated failed:", String(e?.message || e));
  }
}