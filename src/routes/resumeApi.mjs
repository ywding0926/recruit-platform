import { Router } from "express";
import { requireLogin } from "../auth.mjs";
import { loadData, saveData, nowIso, rid } from "../db.mjs";
import { getSupabaseAdmin, getBucketName, getSignedUrlExpiresIn } from "../supabase.mjs";
import { feishuEnabled, sendFeishuMessage, createApprovalInstance } from "../feishu.mjs";
import { upload } from "../upload.mjs";
import { pushEvent, safeExtFromName, saveResumeSupabaseOrLocal } from "../helpers.mjs";
import { escapeHtml } from "../ui.mjs";

const router = Router();

// ====== 简历直传 Supabase Storage（前端直连，绕过 Vercel 大小限制）======

// 1. 获取上传签名 URL — 前端拿到后直接 PUT 到 Supabase Storage
router.post("/api/resume/upload-url", requireLogin, async (req, res) => {
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
router.post("/api/candidates/:id/resume-meta", requireLogin, async (req, res) => {
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

// 实时获取简历的新 signed URL（解决过期问题）
router.get("/api/candidates/:id/resume-url", requireLogin, async (req, res) => {
  try {
    const d = await loadData();
    const c = d.candidates.find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: "candidate_not_found" });

    var resume = d.resumeFiles
      .filter((r) => r.candidateId === c.id && r.url)
      .sort((a, b) => (b.uploadedAt || "").localeCompare(a.uploadedAt || ""))[0];

    if (!resume) return res.json({ ok: true, resume: null });

    // 如果文件在 supabase 存储中，实时生成新的 signed URL
    // 兼容 storage 字段可能是 "local" 但实际 URL 指向 supabase 的历史数据
    const isSupabaseResume = resume.filename && (resume.storage === "supabase" || (resume.url && resume.url.includes("supabase.co")));
    if (isSupabaseResume) {
      const supabase = getSupabaseAdmin();
      const bucket = resume.bucket || getBucketName();
      if (supabase && bucket) {
        const { data: signed, error: signErr } = await supabase.storage
          .from(bucket)
          .createSignedUrl(resume.filename, getSignedUrlExpiresIn());
        if (!signErr && signed?.signedUrl) {
          resume = { ...resume, url: signed.signedUrl };
        }
      }
    }

    res.json({ ok: true, resume });
  } catch (e) {
    console.error("[Resume] resume-url error:", e.message);
    res.status(500).json({ error: String(e?.message || "unknown") });
  }
});

// 兼容旧版：通过服务端中转上传（本地开发用）
router.post("/api/candidates/:id/resume", requireLogin, upload.single("resume"), async (req, res) => {
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
router.post("/api/candidates/:id/offer", requireLogin, async (req, res) => {
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

export default router;
