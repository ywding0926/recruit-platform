import { Router } from "express";
import { loadData, saveData, nowIso, rid } from "../db.mjs";
import { upload } from "../upload.mjs";
import { pushEvent, findDuplicate, notifyHrNewCandidate, saveResumeSupabaseOrLocal } from "../helpers.mjs";

const router = Router();

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
router.post("/open-api/candidates", requireApiKey, async (req, res) => {
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
router.post("/open-api/resume", requireApiKey, upload.single("resume"), async (req, res) => {
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
router.get("/open-api/jobs", requireApiKey, async (req, res) => {
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

export default router;
