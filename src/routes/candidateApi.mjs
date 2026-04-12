import { Router } from "express";
import { requireLogin } from "../auth.mjs";
import { loadData, saveData, upsertRow, saveAppConfigKey, nowIso, rid, deleteFromSupabase } from "../db.mjs";
import { STATUS_SET, INTERVIEW_ROUNDS, INTERVIEW_RATING } from "../constants.mjs";
import { getVisibleJobIds, pushEvent, refreshResumeUrlIfNeeded } from "../helpers.mjs";
import { feishuEnabled, sendFeishuMessage, sendFeishuGroupMessage, createFeishuCalendarEvent, updateFeishuCalendarEvent, deleteFeishuCalendarEvent } from "../feishu.mjs";

const router = Router();

router.get("/api/candidates/:id", requireLogin, async (req, res) => {
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

router.post("/api/candidates/:id", requireLogin, async (req, res) => {
  const d = await loadData();
  const c = d.candidates.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "not_found" });
  { const vj = getVisibleJobIds(req.user, d.jobs); if (vj !== null && !vj.has(c.jobId)) return res.status(403).json({ error: "no_permission" }); }

  const before = { ...c };
  const name = String(req.body.name ?? "").trim();
  const phone = String(req.body.phone ?? "").trim();
  const email = String(req.body.email ?? "").trim();
  const source = String(req.body.source ?? "").trim();
  const referrer = String(req.body.referrer ?? "").trim();
  const referrerId = String(req.body.referrerId ?? "").trim();
  const vendorId = String(req.body.vendorId ?? "").trim();
  const note = String(req.body.note ?? "").trim();

  if (name) c.name = name;
  c.phone = phone;
  c.email = email;
  c.source = source;
  c.referrer = referrer;
  c.referrerId = referrerId;
  c.vendorId = vendorId;
  // 猎头来源：更新供应商显示名称
  if (source === "猎头" && vendorId) {
    const h = (d.headhunters || []).find(x => x.id === vendorId);
    c.vendorName = h ? (h.company ? h.company + (h.name ? " · " + h.name : "") : h.name) : vendorId;
  }
  c.note = note;
  if (Array.isArray(req.body.tags)) c.tags = req.body.tags.filter(Boolean);
  c.updatedAt = nowIso();

  let sourcesChanged = false;
  if (source && !d.sources.includes(source)) {
    d.sources.push(source);
    sourcesChanged = true;
  }

  const changes = [];
  if (before.name !== c.name) changes.push("姓名：" + (before.name || "-") + " -> " + (c.name || "-"));
  if (before.phone !== c.phone) changes.push("手机：" + (before.phone || "-") + " -> " + (c.phone || "-"));
  if (before.email !== c.email) changes.push("邮箱：" + (before.email || "-") + " -> " + (c.email || "-"));
  if (before.source !== c.source) changes.push("来源：" + (before.source || "-") + " -> " + (c.source || "-"));
  if (before.note !== c.note && c.note) changes.push("备注已更新");

  let newEvent = null;
  if (changes.length) {
    pushEvent(d, { candidateId: c.id, type: "编辑", message: changes.join("\n"), actor: req.user?.name || "系统" });
    newEvent = d.events[d.events.length - 1];
  }
  // 只更新变化的表，比 saveData 全量快 5-10 倍
  const saves = [upsertRow("candidates", c)];
  if (newEvent) saves.push(upsertRow("events", newEvent));
  if (sourcesChanged) saves.push(saveAppConfigKey("sources", d.sources));
  await Promise.all(saves);
  res.json({ ok: true });
});

router.post("/api/candidates/:id/status", requireLogin, async (req, res) => {
  const d = await loadData();
  const c = d.candidates.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "not_found" });
  { const vj = getVisibleJobIds(req.user, d.jobs); if (vj !== null && !vj.has(c.jobId)) return res.status(403).json({ error: "no_permission" }); }

  const old = c.status || "待筛选";
  const status = String(req.body.status || "待筛选");
  c.status = STATUS_SET.has(status) ? status : "待筛选";
  c.updatedAt = nowIso();

  pushEvent(d, { candidateId: c.id, type: "状态流转", message: "状态：" + old + " -> " + c.status, actor: req.user?.name || "系统" });
  const statusEvent = d.events[d.events.length - 1];
  await Promise.all([
    upsertRow("candidates", c),
    upsertRow("events", statusEvent),
  ]);

  if (feishuEnabled() && req.user?.openId) {
    sendFeishuMessage(req.user.openId,
      `**候选人**：${c.name}\n**状态变更**：${old} → ${c.status}\n**操作人**：${req.user?.name || "系统"}`,
      "候选人状态变更"
    ).catch(() => {});
  }

  res.json({ ok: true });
});

// 更换候选人岗位
router.post("/api/candidates/:id/job", requireLogin, async (req, res) => {
  const d = await loadData();
  const c = d.candidates.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "not_found" });

  const newJobId = String(req.body.jobId || "").trim();
  if (!newJobId) return res.status(400).json({ error: "请选择岗位" });

  const newJob = d.jobs.find((j) => j.id === newJobId);
  if (!newJob) return res.status(400).json({ error: "岗位不存在" });

  const oldJobTitle = c.jobTitle || c.jobId || "未关联岗位";
  const newJobTitle = newJob.title || newJobId;

  if (c.jobId === newJobId) {
    return res.json({ ok: true, message: "岗位未变化" });
  }

  c.jobId = newJobId;
  c.jobTitle = newJobTitle;
  c.updatedAt = nowIso();

  pushEvent(d, {
    candidateId: c.id,
    type: "岗位变更",
    message: "岗位：" + oldJobTitle + " -> " + newJobTitle,
    actor: req.user?.name || "系统"
  });
  const jobEvent = d.events[d.events.length - 1];
  await Promise.all([
    upsertRow("candidates", c),
    upsertRow("events", jobEvent),
  ]);
  res.json({ ok: true, newJobTitle });
});

router.post("/api/candidates/:id/follow", requireLogin, async (req, res) => {
  const d = await loadData();
  const c = d.candidates.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "not_found" });

  const nextAction = String(req.body.nextAction || "").trim();
  const followAt = String(req.body.followAt || "").trim();
  const note = String(req.body.note || "").trim();
  c.follow = { nextAction, followAt, note };
  c.updatedAt = nowIso();

  pushEvent(d, { candidateId: c.id, type: "跟进", message: "下一步：" + (nextAction || "-") + "\n跟进时间：" + (followAt || "-") + "\n" + (note || ""), actor: req.user?.name || "系统" });
  const followEvent = d.events[d.events.length - 1];
  await Promise.all([
    upsertRow("candidates", c),
    upsertRow("events", followEvent),
  ]);
  res.json({ ok: true });
});

router.post("/api/candidates/:id/notify", requireLogin, async (req, res) => {
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

router.post("/api/candidates/:id/schedule", requireLogin, async (req, res) => {
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
  const prevMeetingUrl = idx > -1 ? (d.interviewSchedules[idx].meetingUrl || d.interviewSchedules[idx].link || "") : "";
  const item = {
    id: idx > -1 ? d.interviewSchedules[idx].id : rid("sc"),
    candidateId: c.id,
    round,
    scheduledAt,
    interviewers,
    link: link || prevMeetingUrl,  // 前端未传 link 时保留已有会议链接
    location,
    reviewToken,
    meetingNo: idx > -1 ? (d.interviewSchedules[idx].meetingNo || "") : "",
    recordingUrl: idx > -1 ? (d.interviewSchedules[idx].recordingUrl || "") : "",
    calendarEventId: idx > -1 ? (d.interviewSchedules[idx].calendarEventId || "") : "",
    meetingUrl: idx > -1 ? (d.interviewSchedules[idx].meetingUrl || "") : "",
    createdAt: idx > -1 ? d.interviewSchedules[idx].createdAt : nowIso(),
    updatedAt: nowIso(),
  };
  // 判断飞书日历同步策略
  const prevSchedule = idx > -1 ? d.interviewSchedules[idx] : null;
  // 只要用户主动提交保存，就视为需要同步（编辑时必须先删旧日历再建新的）
  const scheduleChanged = true;
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
  const shouldSyncCalendar = feishuEnabled() && scheduledAt && req.body.syncCalendar === "on";

  if (shouldSyncCalendar) {
    try {
      const localStr = scheduledAt.replace(" ", "T");
      const hasTimezone = /[Zz]|[+-]\d{2}:?\d{2}$/.test(localStr);
      const startDt = hasTimezone ? new Date(localStr) : new Date(localStr + "+08:00");
      const endDt = new Date(startDt.getTime() + 60 * 60 * 1000);
      const calSummary = `面试：${c.name} - ${c.jobTitle || "未知岗位"} - 第${round}轮`;
      const calDesc = `候选人：${c.name}\n职位：${c.jobTitle || "-"}\n轮次：第${round}轮\n面试官：${interviewers || "-"}\n${link ? "链接：" + link : ""}${location ? "\n地点：" + location : ""}`;

      const scIdx = d.interviewSchedules.findIndex(x => x.candidateId === c.id && x.round === round);

      if (alreadyHasCalendar && item.calendarEventId) {
        // 已有日历事件 → 直接 PATCH 更新时间和信息，不删除不新建
        console.log("[Schedule] 更新飞书日历事件:", item.calendarEventId);
        const updateResult = await updateFeishuCalendarEvent({
          calendarEventId: item.calendarEventId,
          summary: calSummary,
          description: calDesc,
          startTime: startDt.toISOString(),
          endTime: endDt.toISOString(),
          attendeeOpenIds,
        });
        console.log("[Schedule] 日历更新结果:", JSON.stringify({ code: updateResult?.code }));
        calendarSynced = true;
        if (scIdx > -1) await saveData(d);
      } else {
        // 没有旧日历事件 → 新建，同时上传简历附件
        const resumeFiles = (d.resumeFiles || [])
          .filter(r => r.candidateId === c.id && r.url)
          .sort((a, b) => (b.uploadedAt || "").localeCompare(a.uploadedAt || ""));
        const latestResume = resumeFiles[0] || null;
        const resumeAttachments = latestResume
          ? [{ url: latestResume.url, name: latestResume.originalName || latestResume.filename || "resume.pdf" }]
          : [];

        console.log("[Schedule] 新建飞书日历事件, attendees:", attendeeOpenIds.length);
        const calResult = await createFeishuCalendarEvent({
          summary: calSummary,
          description: calDesc,
          startTime: startDt.toISOString(),
          endTime: endDt.toISOString(),
          attendeeOpenIds,
          resumeAttachments,
          hostOpenId: req.user?.openId || "",
        });
        console.log("[Schedule] 日历新建结果:", JSON.stringify({ code: calResult?.code, eventId: calResult?.eventId, meetingUrl: calResult?.meetingUrl }));
        calendarSynced = true;

        if (scIdx > -1) {
          if (calResult?.eventId) d.interviewSchedules[scIdx].calendarEventId = calResult.eventId;
          if (calResult?.meetingUrl) {
            meetingUrl = calResult.meetingUrl;
            d.interviewSchedules[scIdx].link = meetingUrl;
            d.interviewSchedules[scIdx].meetingUrl = meetingUrl;
            const mNoMatch = meetingUrl.match(/\/j\/(\d+)/);
            if (mNoMatch) d.interviewSchedules[scIdx].meetingNo = mNoMatch[1];
          }
          await saveData(d);
        }
      }
    } catch (e) {
      console.error("[Feishu Calendar] 异常:", e.message);
    }
  }

  // 发送飞书消息通知面试官
  const notifyPromises = [];
  const latestSc = d.interviewSchedules.find(x => x.candidateId === c.id && x.round === round);
  const locationInfo = meetingUrl ? `飞书会议：${meetingUrl}` : (location || link || "-");
  const reviewLink = latestSc?.reviewToken ? `${req.protocol}://${req.get("host")}/review/${latestSc.reviewToken}?lk_jump_to_browser=true` : "";
  const candidateUrl = `${req.protocol}://${req.get("host")}/candidates/${c.id}?lk_jump_to_browser=true`;
  const notifyButtons = { tag: "action", actions: [{ tag: "button", text: { tag: "plain_text", content: "📋 查看候选人详情" }, url: candidateUrl, type: "primary" }, ...(reviewLink ? [{ tag: "button", text: { tag: "plain_text", content: "📝 填写面评" }, url: reviewLink, type: "default" }] : [])] };
  const msgContent = `**候选人**：${c.name}\n**职位**：${c.jobTitle || "-"}\n**轮次**：第${round}轮\n**时间**：${scheduledAt}\n**地点/会议**：${locationInfo}`;
  if (feishuEnabled() && scheduledAt && attendeeOpenIds.length > 0) {
    for (const oid of attendeeOpenIds) {
      notifyPromises.push(sendFeishuMessage(oid, msgContent, "面试安排通知", [notifyButtons]).catch(() => {}));
    }
  } else if (feishuEnabled() && scheduledAt && interviewers) {
    const interviewerNames = interviewers.split(/[\/;,、]/).map(n => n.trim()).filter(Boolean);
    for (const name of interviewerNames) {
      const usr = d.users.find(u => u.name === name && u.openId);
      if (usr) notifyPromises.push(sendFeishuMessage(usr.openId, msgContent, "面试安排通知", [notifyButtons]).catch(() => {}));
    }
  }
  if (notifyPromises.length > 0) await Promise.all(notifyPromises);

  res.json({ ok: true, calendarSynced });
});

router.delete("/api/candidates/:id/schedule/:scheduleId", requireLogin, async (req, res) => {
  const d = await loadData();
  const c = d.candidates.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "not_found" });
  { const vj = getVisibleJobIds(req.user, d.jobs); if (vj !== null && !vj.has(c.jobId)) return res.status(403).json({ error: "no_permission" }); }

  const idx = d.interviewSchedules.findIndex(x => x.id === req.params.scheduleId && x.candidateId === c.id);
  if (idx === -1) return res.status(404).json({ error: "schedule_not_found" });

  const sc = d.interviewSchedules[idx];
  const calendarEventId = sc.calendarEventId || "";

  // 删除系统记录
  d.interviewSchedules.splice(idx, 1);
  pushEvent(d, { candidateId: c.id, type: "删除面试", message: "删除第" + sc.round + "轮面试安排", actor: req.user?.name || "系统" });
  await saveData(d);

  // 同步删除飞书日历事件
  let calendarDeleted = false;
  if (calendarEventId && feishuEnabled()) {
    try {
      const delResult = await deleteFeishuCalendarEvent({ calendarEventId });
      calendarDeleted = delResult?.code === 0;
      console.log("[Schedule] 飞书日历事件删除结果:", JSON.stringify({ code: delResult?.code, calendarEventId }));
    } catch (e) {
      console.error("[Schedule] 飞书日历删除异常:", e.message);
    }
  }

  res.json({ ok: true, calendarDeleted });
});

router.post("/api/candidates/:id/reviews", requireLogin, async (req, res) => {
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
    id: (idx > -1 && d.interviews[idx].id) ? d.interviews[idx].id : rid("rv"),
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
  const old = c.status || "待筛选";

  if (rating === "Pending") {
    // 评级为 Pending（待定）时不触发自动状态流转
    autoFlowMsg = "评级为 Pending（待定），候选人状态保持不变。";
  } else if (conclusion === "通过") {
    const passStatusMap = { 1: "一面通过", 2: "二面通过", 3: "三面通过", 4: "四面通过", 5: "待发offer" };
    const passStatus = passStatusMap[round] || "待发offer";
    c.status = passStatus;
    autoFlowMsg = "面试结论通过，已自动流转到「" + passStatus + "」。";
  } else if (conclusion === "不通过") {
    const failStatusMap = { 1: "一面不通过", 2: "二面不通过", 3: "三面不通过", 4: "四面不通过", 5: "五面不通过" };
    const failStatus = failStatusMap[round] || "面试不通过";
    c.status = failStatus;
    autoFlowMsg = "面试结论不通过，状态已更新为「" + failStatus + "」。";
  } else if (conclusion === "Pending") {
    c.status = "面试Pending";
    autoFlowMsg = "面试结论待定，状态已更新为「面试Pending」。";
  }
  c.updatedAt = nowIso();

  pushEvent(d, { candidateId: c.id, type: "面评", message: "第" + round + "轮（" + interviewer + "）：结论=" + conclusion + "，评级=" + (rating || "-") + "\nPros：" + (pros || "-") + "\nCons：" + (cons || "-"), actor: req.user?.name || "系统" });
  if (old !== c.status) {
    pushEvent(d, { candidateId: c.id, type: "状态同步", message: "因面评更新，状态：" + old + " -> " + c.status, actor: "系统" });
  }
  if (!c.follow) c.follow = {};
  if (rating !== "Pending") {
    if (conclusion === "通过") {
      if (c.status === "待发offer") {
        c.follow.nextAction = "准备Offer";
      } else {
        c.follow.nextAction = "安排下一轮面试";
        c.follow.followAt = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
      }
    } else if (conclusion === "不通过") {
      c.follow.nextAction = "已结束";
      c.follow.note = (c.follow.note ? c.follow.note + "\n" : "") + "第" + round + "轮面试不通过";
    }
  }
  await saveData(d);

  // 面评完成后通知管理员 + HR 群聊
  try {
    const baseUrl = process.env.BASE_URL || "https://recruit-platform-sable.vercel.app";
    const candidateUrl = baseUrl + "/candidates/" + c.id + "?lk_jump_to_browser=true";
    const job = d.jobs.find(j => j.id === c.jobId);
    const admins = (d.users || []).filter(u => u.role === "admin" && u.openId);
    const notifyMsg = `**面评已提交** ✅\n\n` +
      `**候选人**：${c.name}\n` +
      `**岗位**：${job?.title || c.jobTitle || "-"}\n` +
      `**轮次**：第${round}轮\n` +
      `**面试官**：${interviewer}\n` +
      `**面试结论**：${conclusion || "-"}\n` +
      `**评级**：${rating}`;
    const notifyBtn = { tag: "action", actions: [{ tag: "button", text: { tag: "plain_text", content: "📋 查看候选人详情" }, url: candidateUrl, type: "primary" }] };

    // 通知各管理员（一对一）
    console.log("[ReviewNotify] 内部面评通知: 候选人=" + c.name + " admins=" + admins.length + " (" + admins.map(a => a.name).join(",") + ")");
    for (const admin of admins) {
      await sendFeishuMessage(admin.openId, notifyMsg, "面评完成通知", [notifyBtn]);
      console.log("[ReviewNotify] 已通知 " + admin.name + "(" + admin.openId + ")");
    }

    // 发送群聊通知（HRteam 群）
    const hrGroupChatId = d.settings?.hrGroupChatId || "";
    if (hrGroupChatId) {
      const groupMsg = `「**${c.name}**」的「**第${round}轮**」面试面评填写完成\n**面试官**：${interviewer}\n**面试结论**：${conclusion || "-"}，**评级**：${rating}`;
      await sendFeishuGroupMessage(hrGroupChatId, groupMsg, "面评完成通知", [notifyBtn]);
      console.log("[ReviewNotify] 已通知 HR 群聊 chatId=" + hrGroupChatId);
    }
  } catch (notifyErr) {
    console.warn("[ReviewNotify] 通知失败:", notifyErr.message);
  }

  res.json({ ok: true, autoFlowMsg });
});

// ====== 面评编辑 ======
router.post("/api/candidates/:id/reviews/:reviewId", requireLogin, async (req, res) => {
  const d = await loadData();
  const c = d.candidates.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "not_found" });
  { const vj = getVisibleJobIds(req.user, d.jobs); if (vj !== null && !vj.has(c.jobId)) return res.status(403).json({ error: "no_permission" }); }

  const reviewIdx = d.interviews.findIndex((x) => x.id === req.params.reviewId && x.candidateId === c.id);
  if (reviewIdx === -1) return res.status(404).json({ error: "review_not_found" });

  const existing = d.interviews[reviewIdx];
  const round = Number(req.body.round || existing.round);
  const conclusion = String(req.body.conclusion || existing.conclusion || "通过");
  const rating = String(req.body.rating || existing.rating || "");
  const interviewer = String(req.body.interviewer || existing.interviewer || "").trim();
  var pros = String(req.body.pros !== undefined ? req.body.pros : existing.pros || "");
  var cons = String(req.body.cons !== undefined ? req.body.cons : existing.cons || "");
  var focusNext = String(req.body.focusNext !== undefined ? req.body.focusNext : existing.focusNext || "");

  if (rating && !INTERVIEW_RATING.includes(rating)) return res.status(400).send("invalid_rating");

  d.interviews[reviewIdx] = {
    ...existing,
    round,
    conclusion,
    rating,
    interviewer,
    pros,
    cons,
    focusNext,
    updatedAt: nowIso(),
  };

  let autoFlowMsg = "";
  const old = c.status || "待筛选";

  if (rating === "Pending") {
    // 评级为 Pending（待定）时不触发自动状态流转
    autoFlowMsg = "评级为 Pending（待定），候选人状态保持不变。";
  } else if (conclusion === "通过") {
    const passStatusMap = { 1: "一面通过", 2: "二面通过", 3: "三面通过", 4: "四面通过", 5: "待发offer" };
    const passStatus = passStatusMap[round] || "待发offer";
    c.status = passStatus;
    autoFlowMsg = "面试结论通过，已自动流转到「" + passStatus + "」。";
  } else if (conclusion === "不通过") {
    c.status = "面试不通过";
    autoFlowMsg = "面试结论不通过，状态已更新为「面试不通过」。";
  } else if (conclusion === "Pending") {
    c.status = "面试Pending";
    autoFlowMsg = "面试结论待定，状态已更新为「面试Pending」。";
  }
  c.updatedAt = nowIso();
  if (old !== c.status) {
    pushEvent(d, { candidateId: c.id, type: "状态同步", message: "因面评修改，状态：" + old + " -> " + c.status, actor: "系统" });
  }
  pushEvent(d, { candidateId: c.id, type: "面评修改", message: "第" + round + "轮（" + interviewer + "）：结论=" + conclusion + "，评级=" + (rating || "-"), actor: req.user?.name || "系统" });

  await saveData(d);
  res.json({ ok: true, autoFlowMsg });
});

// ====== 面评删除 ======
router.delete("/api/candidates/:id/reviews/:reviewId", requireLogin, async (req, res) => {
  const d = await loadData();
  const c = d.candidates.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "not_found" });
  { const vj = getVisibleJobIds(req.user, d.jobs); if (vj !== null && !vj.has(c.jobId)) return res.status(403).json({ error: "no_permission" }); }

  const reviewIdx = d.interviews.findIndex((x) => x.id === req.params.reviewId && x.candidateId === c.id);
  if (reviewIdx === -1) return res.status(404).json({ error: "review_not_found" });

  const rv = d.interviews[reviewIdx];
  d.interviews.splice(reviewIdx, 1);
  pushEvent(d, { candidateId: c.id, type: "面评删除", message: "第" + rv.round + "轮（" + (rv.interviewer || "-") + "）面评已删除", actor: req.user?.name || "系统" });
  await saveData(d);
  // Supabase 用 upsert 不会删除已有记录，需显式删除
  await deleteFromSupabase("interviews", rv.id);
  res.json({ ok: true });
});

// ====== 候选人备注 ======

router.get("/api/candidates/:id/notes", requireLogin, async (req, res) => {
  const d = await loadData();
  const c = d.candidates.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "not_found" });

  const vj = getVisibleJobIds(req.user, d.jobs);
  if (vj !== null && !vj.has(c.jobId)) return res.status(403).json({ error: "no_permission" });

  const uid = req.user.openId || req.user.id;
  const notes = (d.notes || [])
    .filter(n => n.candidateId === c.id)
    .filter(n => {
      if (n.visibility === "public") return true;
      if (n.authorId === uid) return true;
      if (Array.isArray(n.mentionedUserIds) && n.mentionedUserIds.includes(uid)) return true;
      return false;
    })
    .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));

  res.json(notes);
});

router.post("/api/candidates/:id/notes", requireLogin, async (req, res) => {
  const d = await loadData();
  const c = d.candidates.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "not_found" });

  const vj = getVisibleJobIds(req.user, d.jobs);
  if (vj !== null && !vj.has(c.jobId)) return res.status(403).json({ error: "no_permission" });

  const content = String(req.body.content || "").trim();
  if (!content) return res.status(400).json({ error: "内容不能为空" });

  const visibility = req.body.visibility === "private" ? "private" : "public";
  const mentionedUserIds = Array.isArray(req.body.mentionedUserIds)
    ? req.body.mentionedUserIds.filter(Boolean)
    : [];

  const note = {
    id: rid("note"),
    candidateId: c.id,
    authorId: req.user.openId || req.user.id,
    authorName: req.user.name || "",
    authorAvatar: req.user.avatar || "",
    content,
    visibility,
    mentionedUserIds,
    createdAt: nowIso(),
  };

  if (!Array.isArray(d.notes)) d.notes = [];
  d.notes.push(note);

  pushEvent(d, {
    candidateId: c.id,
    type: "备注",
    message: (visibility === "private" ? "[私密] " : "") + content.slice(0, 50) + (content.length > 50 ? "..." : ""),
    actor: req.user.name || "系统",
  });

  await saveData(d);
  res.json({ ok: true, note });
});

router.delete("/api/candidates/:id/notes/:noteId", requireLogin, async (req, res) => {
  const d = await loadData();
  const c = d.candidates.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "not_found" });

  const vj = getVisibleJobIds(req.user, d.jobs);
  if (vj !== null && !vj.has(c.jobId)) return res.status(403).json({ error: "no_permission" });

  if (!Array.isArray(d.notes)) return res.status(404).json({ error: "note_not_found" });

  const idx = d.notes.findIndex(n => n.id === req.params.noteId);
  if (idx === -1) return res.status(404).json({ error: "note_not_found" });

  const note = d.notes[idx];
  const uid = req.user.openId || req.user.id;
  if (note.authorId !== uid) return res.status(403).json({ error: "只能删除自己的备注" });

  d.notes.splice(idx, 1);
  await saveData(d);
  res.json({ ok: true });
});

export default router;
