import { Router } from "express";
import { requireLogin, requireAdmin } from "../auth.mjs";
import { loadData, saveData, nowIso, rid } from "../db.mjs";
import { findDuplicate, pushEvent, notifyHrNewCandidate, saveResumeSupabaseOrLocal } from "../helpers.mjs";

const router = Router();

const CAREERS_ADMIN_URL = "https://machinepulse-careers-management.vercel.app";
const CAREERS_USERNAME = process.env.CAREERS_USERNAME || "tudou_mp";
const CAREERS_PASSWORD = process.env.CAREERS_PASSWORD || "tudoump2026";


function matchLocalJob(jobs, careersTitle) {
  if (!careersTitle) return null;
  const t = careersTitle.toLowerCase();
  const map = [
    [["ai product manager"], "AI产品经理"],
    [["growth product manager", "plg pm"], "用户增长产品经理"],
    [["overseas paid media", "overseas advertising", "渠道增长"], "海外投放与渠道增长运营"],
    [["overseas influencer", "influencer marketing", "达人营销"], "海外达人营销与内容运营"],
    [["ui/ux design", "ux designer", "ui designer"], "UI/UX设计师"],
    [["legal intern", "法务"], "法务实习生"],
    [["city editor", "overseas social media", "新媒体运营"], "海外新媒体运营（城市主编）"],
    [["senior content", "资深内容"], "资深内容运营"],
    [["agent content", "experience operations"], "Agent 内容与体验运营"],
    [["ai lifestyle architect"], "Agent 内容与体验运营"],
  ];
  for (const [keywords, localTitle] of map) {
    if (keywords.some(k => t.includes(k))) {
      const found = jobs.find(j => j.title === localTitle);
      if (found) return found;
    }
  }
  return null;
}

let _careersSyncRunning = false;
let _lastCareersSyncResult = null;

async function syncCareersApplications() {
  if (_careersSyncRunning) { console.log("[CareersSync] 已在运行中，跳过"); return { skipped: true }; }
  _careersSyncRunning = true;
  const result = { synced: 0, skipped: 0, errors: 0, total: 0, details: [], startedAt: nowIso() };
  try {
    console.log("[CareersSync] 开始同步官网投递...");

    // 1. 登录
    const loginRes = await fetch(CAREERS_ADMIN_URL + "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: CAREERS_USERNAME, password: CAREERS_PASSWORD }),
    });
    if (!loginRes.ok) throw new Error("登录失败: " + loginRes.status);
    const cookies = loginRes.headers.getSetCookie?.() || [];
    const sessionCookie = cookies.find(c => c.startsWith("admin_session="));
    if (!sessionCookie) throw new Error("未获取到session cookie");
    const cookieVal = sessionCookie.split(";")[0]; // admin_session=xxx

    // 2. 拉取官网岗位列表（用于获取 department/location 等信息）
    let careersJobsList = [];
    try {
      const jobsRes = await fetch("https://machinepulse-careers.vercel.app/api/jobs");
      if (jobsRes.ok) careersJobsList = await jobsRes.json();
    } catch (e) { console.log("[CareersSync] 获取官网岗位列表失败，跳过:", e.message); }

    // 3. 拉取所有投递
    const appsRes = await fetch(CAREERS_ADMIN_URL + "/api/admin/applications", {
      headers: { Cookie: cookieVal },
    });
    if (!appsRes.ok) throw new Error("获取投递列表失败: " + appsRes.status);
    const apps = await appsRes.json();
    result.total = apps.length;
    console.log("[CareersSync] 共获取 " + apps.length + " 条投递");

    // 4. 加载本地数据
    const d = await loadData();
    const existingCareersIds = new Set();
    for (const c of d.candidates) {
      if (c.careersAppId) existingCareersIds.add(c.careersAppId);
    }

    // 辅助：按官网岗位title查找或自动创建本地岗位
    const autoCreatedJobs = new Map(); // careersTitle -> localJob
    function findOrCreateJob(careersTitle) {
      if (!careersTitle) return null;
      // 先尝试关键词映射
      const mapped = matchLocalJob(d.jobs, careersTitle);
      if (mapped) return mapped;
      // 再尝试精确匹配（可能之前自动创建过）
      const exact = d.jobs.find(j => j.title === careersTitle);
      if (exact) return exact;
      // 本轮已创建过的
      if (autoCreatedJobs.has(careersTitle)) return autoCreatedJobs.get(careersTitle);
      // 从官网岗位列表查找详情
      const careersJob = careersJobsList.find(cj => cj.title === careersTitle);
      // 部门映射（英文→中文）
      const deptMap = { "Product & Growth": "产品与增长", "Research & Development": "研发", "Administration": "行政" };
      const dept = careersJob ? (deptMap[careersJob.department] || careersJob.department || "") : "";
      const loc = careersJob ? (careersJob.location || "") : "";
      // 自动创建岗位
      const newJob = {
        id: rid("job"),
        title: careersTitle,
        department: dept,
        location: loc,
        owner: "",
        ownerOpenId: "",
        headcount: null,
        level: "",
        category: "官网同步",
        state: "open",
        jd: "",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      d.jobs.unshift(newJob);
      autoCreatedJobs.set(careersTitle, newJob);
      console.log("[CareersSync] 自动创建岗位: " + careersTitle + " (dept:" + dept + " loc:" + loc + ")");
      return newJob;
    }

    let newCount = 0;
    let backfillCount = 0; // 回填jobId的候选人数
    for (const app of apps) {
      // 已同步过的跳过（careersAppId 精确匹配）
      if (existingCareersIds.has(app.id)) { result.skipped++; continue; }

      // 多维度查重：姓名+手机号 / 姓名+email / careersAppId
      let dup = findDuplicate(d.candidates, app.name, app.phone);
      if (!dup && app.email) {
        // 无手机号或手机号不匹配时，用姓名+email匹配
        const nameL = (app.name || "").trim().toLowerCase();
        const emailL = (app.email || "").trim().toLowerCase();
        if (nameL && emailL) {
          dup = d.candidates.find(c =>
            c.name && c.name.trim().toLowerCase() === nameL &&
            c.email && c.email.trim().toLowerCase() === emailL
          ) || null;
        }
      }
      if (dup) {
        // 标记已同步但不重复创建，只记录careersAppId
        if (!dup.careersAppId) { dup.careersAppId = app.id; }
        // 如果已存在候选人没有jobId但官网有岗位信息，补充关联
        if (!dup.jobId && app.jobs?.title) {
          const j = findOrCreateJob(app.jobs.title);
          if (j) { dup.jobId = j.id; dup.jobTitle = j.title; backfillCount++;
            console.log("[CareersSync] 回填岗位: " + dup.name + " -> " + j.title);
          }
        }
        result.skipped++;
        result.details.push({ name: app.name, action: "跳过(重复)", dupId: dup.id });
        continue;
      }

      // 匹配或自动创建岗位
      const careersJobTitle = app.jobs?.title || "";
      const localJob = careersJobTitle ? findOrCreateJob(careersJobTitle) : null;
      const jobId = localJob ? localJob.id : "";
      const jobTitle = localJob ? localJob.title : (careersJobTitle || "未关联岗位");

      // 构建来源
      let source = "官网投递";
      if (app.referral_code) source = "官网投递(推荐码:" + app.referral_code + ")";

      // 创建候选人
      const c = {
        id: rid("c"),
        name: app.name || "未命名",
        phone: app.phone || "",
        email: app.email || "",
        jobId,
        jobTitle,
        source,
        note: [app.wechat ? "微信:" + app.wechat : "", app.notes || ""].filter(Boolean).join("\n"),
        tags: [],
        status: "待筛选",
        follow: { nextAction: "待联系", followAt: "", note: "" },
        careersAppId: app.id, // 官网投递ID，用于去重
        createdAt: app.applied_at || nowIso(),
        updatedAt: nowIso(),
      };
      d.candidates.unshift(c);

      pushEvent(d, {
        candidateId: c.id,
        type: "创建",
        message: "官网投递同步：" + c.name + "（岗位：" + jobTitle + "）",
        actor: "官网同步",
      });

      // 下载简历并存储
      if (app.resume_path) {
        try {
          const resumeInfoRes = await fetch(
            CAREERS_ADMIN_URL + "/api/admin/applications/" + app.id + "/resume?info=1",
            { headers: { Cookie: cookieVal } }
          );
          if (resumeInfoRes.ok) {
            const resumeInfo = await resumeInfoRes.json();
            if (resumeInfo.url) {
              const pdfRes = await fetch(resumeInfo.url);
              if (pdfRes.ok) {
                const buf = Buffer.from(await pdfRes.arrayBuffer());
                const fileName = resumeInfo.fileName || (app.name + ".pdf");
                await saveResumeSupabaseOrLocal(d, c.id, {
                  buffer: buf,
                  originalname: fileName,
                  mimetype: "application/pdf",
                }, "官网同步");
                console.log("[CareersSync] 简历已保存: " + c.name + " -> " + fileName);
              }
            }
          }
        } catch (resumeErr) {
          console.warn("[CareersSync] 简历下载失败(" + c.name + "):", resumeErr.message);
        }
      }

      // 通知HR
      try {
        await notifyHrNewCandidate(d, c, localJob);
      } catch (notifyErr) {
        console.warn("[CareersSync] 通知HR失败:", notifyErr.message);
      }

      newCount++;
      result.synced++;
      result.details.push({ name: c.name, action: "新建", candidateId: c.id, jobTitle });
      console.log("[CareersSync] 新增候选人: " + c.name + " -> " + jobTitle);
    }

    if (newCount > 0 || autoCreatedJobs.size > 0 || backfillCount > 0) {
      await saveData(d);
      console.log("[CareersSync] 同步完成，新增 " + newCount + " 人，新建岗位 " + autoCreatedJobs.size + " 个，回填岗位 " + backfillCount + " 人");
    } else {
      console.log("[CareersSync] 无新增投递");
    }

    result.newJobs = autoCreatedJobs.size;
    result.finishedAt = nowIso();
    _lastCareersSyncResult = result;
    return result;
  } catch (e) {
    console.error("[CareersSync] 同步失败:", e.message);
    result.error = e.message;
    result.finishedAt = nowIso();
    _lastCareersSyncResult = result;
    return result;
  } finally {
    _careersSyncRunning = false;
  }
}

// 手动触发同步
router.post("/api/careers/sync", requireLogin, requireAdmin, async (req, res) => {
  try {
    const result = await syncCareersApplications();
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 查询同步状态
router.get("/api/careers/sync-status", requireLogin, async (req, res) => {
  res.json({ running: _careersSyncRunning, lastResult: _lastCareersSyncResult });
});

// ====== Webhook：官网新投递实时接收 ======
const CAREERS_WEBHOOK_SECRET = process.env.CAREERS_WEBHOOK_SECRET || "mp_webhook_2026";

router.post("/api/careers/webhook", async (req, res) => {
  // 验证 webhook 密钥
  const secret = req.headers["x-webhook-secret"] || req.query.secret;
  if (secret !== CAREERS_WEBHOOK_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const app_data = req.body; // 官网投递数据
  if (!app_data || !app_data.id) {
    return res.status(400).json({ error: "missing application data" });
  }

  console.log("[Webhook] 收到官网新投递: " + (app_data.name || "?") + " (" + app_data.id + ")");

  try {
    const d = await loadData();

    // 1. careersAppId 去重
    if (d.candidates.some(c => c.careersAppId === app_data.id)) {
      console.log("[Webhook] 投递已存在(careersAppId)，跳过: " + app_data.name);
      return res.json({ ok: true, action: "skipped", reason: "duplicate_careers_id" });
    }

    // 2. 姓名+手机号/email 去重
    let dup = findDuplicate(d.candidates, app_data.name, app_data.phone);
    if (!dup && app_data.email) {
      const nameL = (app_data.name || "").trim().toLowerCase();
      const emailL = (app_data.email || "").trim().toLowerCase();
      if (nameL && emailL) {
        dup = d.candidates.find(c =>
          c.name && c.name.trim().toLowerCase() === nameL &&
          c.email && c.email.trim().toLowerCase() === emailL
        ) || null;
      }
    }
    if (dup) {
      if (!dup.careersAppId) { dup.careersAppId = app_data.id; await saveData(d); }
      console.log("[Webhook] 候选人已存在(查重)，跳过: " + app_data.name);
      return res.json({ ok: true, action: "skipped", reason: "duplicate_candidate" });
    }

    // 3. 匹配或自动创建岗位
    const careersJobTitle = app_data.jobs?.title || app_data.job_title || "";
    let localJob = null;
    if (careersJobTitle) {
      localJob = matchLocalJob(d.jobs, careersJobTitle);
      if (!localJob) localJob = d.jobs.find(j => j.title === careersJobTitle);
      if (!localJob) {
        // 获取官网岗位列表获取部门/地点信息
        let careersJobInfo = null;
        try {
          const jobsRes = await fetch("https://machinepulse-careers.vercel.app/api/jobs");
          if (jobsRes.ok) {
            const jobsList = await jobsRes.json();
            careersJobInfo = jobsList.find(j => j.title === careersJobTitle);
          }
        } catch (e) { /* ignore */ }
        const deptMap = { "Product & Growth": "产品与增长", "Research & Development": "研发", "Administration": "行政" };
        const dept = careersJobInfo ? (deptMap[careersJobInfo.department] || careersJobInfo.department || "") : "";
        const loc = careersJobInfo ? (careersJobInfo.location || "") : "";
        localJob = {
          id: rid("job"), title: careersJobTitle, department: dept, location: loc,
          owner: "", ownerOpenId: "", headcount: null, level: "",
          category: "官网同步", state: "open", jd: "",
          createdAt: nowIso(), updatedAt: nowIso(),
        };
        d.jobs.unshift(localJob);
        console.log("[Webhook] 自动创建岗位: " + careersJobTitle);
      }
    }

    // 4. 构建候选人
    let source = "官网投递";
    if (app_data.referral_code) source = "官网投递(推荐码:" + app_data.referral_code + ")";

    const candidate = {
      id: rid("c"),
      name: app_data.name || "未命名",
      phone: app_data.phone || "",
      email: app_data.email || "",
      jobId: localJob ? localJob.id : "",
      jobTitle: localJob ? localJob.title : (careersJobTitle || "未关联岗位"),
      source,
      note: [app_data.wechat ? "微信:" + app_data.wechat : "", app_data.notes || ""].filter(Boolean).join("\n"),
      tags: [],
      status: "待筛选",
      follow: { nextAction: "待联系", followAt: "", note: "" },
      careersAppId: app_data.id,
      createdAt: app_data.applied_at || nowIso(),
      updatedAt: nowIso(),
    };
    d.candidates.unshift(candidate);

    pushEvent(d, {
      candidateId: candidate.id,
      type: "创建",
      message: "官网投递(实时)：" + candidate.name + "（岗位：" + candidate.jobTitle + "）",
      actor: "官网Webhook",
    });

    // 5. 下载简历
    if (app_data.resume_path || app_data.resume_url) {
      try {
        const loginRes = await fetch(CAREERS_ADMIN_URL + "/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: CAREERS_USERNAME, password: CAREERS_PASSWORD }),
        });
        if (loginRes.ok) {
          const cookies = loginRes.headers.getSetCookie?.() || [];
          const sessionCookie = cookies.find(c => c.startsWith("admin_session="));
          if (sessionCookie) {
            const cookieVal = sessionCookie.split(";")[0];
            const resumeInfoRes = await fetch(
              CAREERS_ADMIN_URL + "/api/admin/applications/" + app_data.id + "/resume?info=1",
              { headers: { Cookie: cookieVal } }
            );
            if (resumeInfoRes.ok) {
              const resumeInfo = await resumeInfoRes.json();
              if (resumeInfo.url) {
                const pdfRes = await fetch(resumeInfo.url);
                if (pdfRes.ok) {
                  const buf = Buffer.from(await pdfRes.arrayBuffer());
                  const fileName = resumeInfo.fileName || (app_data.name + ".pdf");
                  await saveResumeSupabaseOrLocal(d, candidate.id, {
                    buffer: buf, originalname: fileName, mimetype: "application/pdf",
                  }, "官网Webhook");
                }
              }
            }
          }
        }
      } catch (resumeErr) {
        console.warn("[Webhook] 简历下载失败:", resumeErr.message);
      }
    }

    await saveData(d);

    // 6. 通知HR
    try {
      await notifyHrNewCandidate(d, candidate, localJob);
    } catch (notifyErr) {
      console.warn("[Webhook] 通知HR失败:", notifyErr.message);
    }

    console.log("[Webhook] 新候选人已创建: " + candidate.name + " -> " + candidate.jobTitle);
    res.json({ ok: true, action: "created", candidateId: candidate.id, name: candidate.name });
  } catch (e) {
    console.error("[Webhook] 处理失败:", e.message);
    res.status(500).json({ error: e.message });
  }
});

export { syncCareersApplications, matchLocalJob };
export default router;
