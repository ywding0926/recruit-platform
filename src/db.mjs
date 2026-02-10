import fs from "fs";
import path from "path";
import crypto from "crypto";
import { supabaseEnabled, getSupabaseAdmin } from "./supabase.mjs";

// Vercel serverless 环境检测：无持久文件系统，跳过本地 JSON 读写
const isServerless = !!process.env.VERCEL;

const DATA_PATH = path.join(process.cwd(), "data.json");

// ===== 通用工具 =====
export function nowIso() {
  return new Date().toISOString();
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
  return d;
}

// ===== 本地读写（serverless 下返回空数据）=====
export function loadDataLocal() {
  if (isServerless) return ensureDataShape({});
  try {
    const raw = fs.readFileSync(DATA_PATH, "utf-8");
    return ensureDataShape(JSON.parse(raw));
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

// ===== Supabase 映射（camelCase <-> snake_case）=====
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
    pros: x.pros ?? null,
    cons: x.cons ?? null,
    focus_next: x.focusNext ?? null,
    note: x.note ?? null,
    created_at: x.createdAt ?? null,
  };
}
function interviewFromRow(r) {
  return {
    id: r.id,
    candidateId: r.candidate_id ?? "",
    round: r.round ?? 1,
    status: r.status ?? "",
    rating: r.rating ?? "",
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
    storage: x.storage ?? null,
    bucket: x.bucket ?? null,
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
    role: u.role ?? "interviewer",
    department: u.department ?? null,
    job_title: u.jobTitle ?? null,
    provider: u.provider ?? null,
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
    role: r.role ?? "interviewer",
    department: r.department ?? "",
    jobTitle: r.job_title ?? "",
    provider: r.provider ?? "feishu",
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

  let { error } = await admin.from(table).upsert(rows, { onConflict: "id" });

  if (error && minimalKeys.length) {
    const slim = rows.map((r) => {
      const o = {};
      for (const k of minimalKeys) o[k] = r[k];
      return o;
    });
    const r2 = await admin.from(table).upsert(slim, { onConflict: "id" });
    if (r2.error) throw r2.error;
  } else if (error) {
    throw error;
  }
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

    // offers / users 表可能不存在，容错处理
    let offers = [];
    try { offers = await sbSelectAll(admin, "offers"); } catch { /* 表不存在时忽略 */ }
    let users = [];
    try { users = await sbSelectAll(admin, "users"); } catch { /* 表不存在时忽略 */ }

    const d = ensureDataShape({
      jobs: jobs.map(jobFromRow),
      candidates: candidates.map(candFromRow),
      interviews: interviews.map(interviewFromRow),
      interviewSchedules: interviewSchedules.map(scheduleFromRow),
      resumeFiles: resumeFiles.map(resumeFromRow),
      events: events.map(eventFromRow),
      offers: offers.map(offerFromRow),
      users: users.map(userFromRow),
    });

    // serverless 环境下不读取本地文件，直接从 Supabase 数据中提取 sources/tags
    if (isServerless) {
      d.sources = Array.from(
        new Set([...d.sources, ...d.candidates.map((c) => c.source).filter(Boolean)])
      );
      d.tags = Array.from(
        new Set([...d.tags, ...d.candidates.flatMap((c) => c.tags || []).filter(Boolean)])
      );
      return ensureDataShape(d);
    }

    // 非 serverless：合并本地数据
    const local = loadDataLocal();
    d.sources = Array.from(
      new Set([...(local.sources || []), ...d.candidates.map((c) => c.source).filter(Boolean)])
    );
    d.tags = Array.from(
      new Set([...(local.tags || []), ...d.candidates.flatMap((c) => c.tags || []).filter(Boolean)])
    );

    // 合并本地 resumeFiles（防止 Supabase upsert 失败或字段丢失导致简历不显示）
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

    // 合并本地 offers
    const sbOfferIds = new Set(d.offers.map((o) => o.id));
    for (const lo of (local.offers || [])) {
      if (!sbOfferIds.has(lo.id)) {
        d.offers.push(lo);
      }
    }

    // 合并本地 events
    const sbEventIds = new Set(d.events.map((e) => e.id));
    for (const le of (local.events || [])) {
      if (!sbEventIds.has(le.id)) {
        d.events.push(le);
      }
    }

    // 合并本地 interviews
    const sbIntIds = new Set(d.interviews.map((x) => x.id));
    for (const li of (local.interviews || [])) {
      if (!sbIntIds.has(li.id)) {
        d.interviews.push(li);
      }
    }

    // 合并本地 interviewSchedules
    const sbScIds = new Set(d.interviewSchedules.map((x) => x.id));
    for (const ls of (local.interviewSchedules || [])) {
      if (!sbScIds.has(ls.id)) {
        d.interviewSchedules.push(ls);
      }
    }

    // 合并本地 candidates
    const sbCandIds = new Set(d.candidates.map((x) => x.id));
    for (const lc of (local.candidates || [])) {
      if (!sbCandIds.has(lc.id)) {
        d.candidates.push(lc);
      }
    }

    // 合并本地 users
    const sbUserIds = new Set(d.users.map((x) => x.id));
    for (const lu of (local.users || [])) {
      if (!sbUserIds.has(lu.id)) {
        d.users.push(lu);
      }
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

    await Promise.all([
      upsertWithRetry(admin, "jobs", shaped.jobs.map(jobToRow), ["id", "title"]),
      upsertWithRetry(admin, "candidates", shaped.candidates.map(candToRow), [
        "id",
        "name",
        "phone",
        "job_id",
        "job_title",
        "source",
      ]),
      upsertWithRetry(admin, "interviews", shaped.interviews.map(interviewToRow), ["id", "candidate_id", "round"]),
      upsertWithRetry(admin, "interview_schedules", shaped.interviewSchedules.map(scheduleToRow), [
        "id",
        "candidate_id",
        "round",
      ]),
      upsertWithRetry(admin, "resume_files", shaped.resumeFiles.map(resumeToRow), ["id", "candidate_id", "filename", "url", "original_name", "content_type", "size", "storage", "bucket", "uploaded_at"]),
      upsertWithRetry(admin, "events", shaped.events.map(eventToRow), ["id", "candidate_id", "type"]),
    ]);

    // offers 表可能不存在
    try {
      if (shaped.offers.length) {
        await upsertWithRetry(admin, "offers", shaped.offers.map(offerToRow), ["id", "candidate_id"]);
      }
    } catch { /* 忽略 */ }

    // users 表可能不存在
    try {
      if (shaped.users.length) {
        await upsertWithRetry(admin, "users", shaped.users.map(userToRow), ["id", "open_id", "name", "role"]);
      }
    } catch { /* 忽略 */ }
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
    // offers 可能不存在
    try { await admin.from("offers").delete().eq("candidate_id", candidateId); } catch {}
  } catch (e) {
    console.warn("[WARN] deleteCandidateRelated failed:", String(e?.message || e));
  }
}
