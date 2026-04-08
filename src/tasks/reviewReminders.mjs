import { loadData, saveData } from "../db.mjs";
import { feishuEnabled, sendFeishuMessage, createFeishuTask } from "../feishu.mjs";

async function checkReviewReminders() {
  try {
    if (!feishuEnabled()) return;
    const d = await loadData();
    const now = Date.now();
    let changed = false;

    // 预构建索引，避免 N+1 线性扫描
    const reviewSet = new Set((d.interviews || []).filter(rv => rv.rating).map(rv => rv.candidateId + ":" + rv.round));
    const candMap = new Map(d.candidates.map(c => [c.id, c]));
    const jobMap = new Map(d.jobs.map(j => [j.id, j]));
    const userByName = new Map();
    for (const u of (d.users || [])) {
      if (u.name && u.openId) userByName.set(u.name, u);
    }

    for (const sc of (d.interviewSchedules || [])) {
      // 跳过已发送提醒的、无面试时间的
      if (sc.reviewReminderSent || !sc.scheduledAt) continue;

      // 历史面试（今天零点之前开始的）直接标记已发送，不触发提醒
      // 这样即使 Supabase 缺少 review_reminder_sent 列，也不会对历史数据重复发送
      const todayStartMs = new Date(new Date().toLocaleDateString("en-CA") + "T00:00:00+08:00").getTime();
      const schedStartMs = new Date(
        /[Zz]|[+-]\d{2}:?\d{2}$/.test(String(sc.scheduledAt))
          ? sc.scheduledAt
          : sc.scheduledAt + "+08:00"
      ).getTime();
      if (!isNaN(schedStartMs) && schedStartMs < todayStartMs) {
        sc.reviewReminderSent = true;
        changed = true;
        continue;
      }

      // 解析面试结束时间：优先用 endAt，没有则用 scheduledAt + 1小时（默认面试时长）
      const endAtStr = sc.endAt || sc.scheduledAt;
      const startTime = new Date(endAtStr).getTime();
      const endTime = sc.endAt ? startTime : startTime + 45 * 60 * 1000; // 无 endAt 则加45分钟
      if (isNaN(endTime) || now < endTime) continue;

      // 检查该轮次是否已有面评
      if (reviewSet.has(sc.candidateId + ":" + sc.round)) {
        sc.reviewReminderSent = true;
        changed = true;
        continue;
      }

      // 找候选人和岗位信息
      const candidate = candMap.get(sc.candidateId);
      if (!candidate) continue;
      const job = jobMap.get(candidate.jobId);

      // 解析面试官姓名列表，找到对应 openId
      const interviewerNames = (sc.interviewers || "").split(/[\/;,、]/).map(n => n.trim()).filter(Boolean);
      const interviewerUsers = [];
      for (const name of interviewerNames) {
        const usr = userByName.get(name);
        if (usr) interviewerUsers.push(usr);
      }

      // HR（岗位负责人）openId 作为任务关注人（支持多人）
      let hrOpenIds = [];
      if (Array.isArray(job?.owners) && job.owners.length > 0) {
        hrOpenIds = job.owners.map(o => o.openId).filter(Boolean);
      } else if (job?.ownerOpenId) {
        hrOpenIds = job.ownerOpenId.split(",").map(id => id.trim()).filter(Boolean);
      }
      const hrName = job?.owner || "";

      // 面评链接
      const reviewUrl = sc.reviewToken
        ? `${process.env.BASE_URL || "https://recruit-platform-sable.vercel.app"}/review/${sc.reviewToken}`
        : "";

      // 获取候选人最新简历链接
      const resumeFiles = (d.resumeFiles || [])
        .filter(r => r.candidateId === candidate.id && r.url)
        .sort((a, b) => (b.uploadedAt || "").localeCompare(a.uploadedAt || ""));
      const latestResume = resumeFiles[0] || null;
      const resumeUrl = latestResume?.url || "";

      // 给每个面试官发消息 + 创建任务
      for (const usr of interviewerUsers) {
        const msgContent = `**面评提醒** 📝\n\n` +
          `候选人：**${candidate.name}**\n` +
          `岗位：${job?.title || candidate.jobTitle || "-"}\n` +
          `面试轮次：第${sc.round}轮\n` +
          `面试时间：${sc.scheduledAt}\n\n` +
          `面试时间已到，请填写本轮面评。`;

        // 操作按钮：面评链接 + 简历附件
        const actions = [];
        if (reviewUrl) {
          actions.push({ tag: "button", text: { tag: "plain_text", content: "📝 填写面评" }, url: reviewUrl + "?lk_jump_to_browser=true", type: "primary" });
        }
        if (resumeUrl) {
          actions.push({ tag: "button", text: { tag: "plain_text", content: "📄 查看简历" }, url: resumeUrl + (resumeUrl.includes("?") ? "&" : "?") + "lk_jump_to_browser=true", type: "default" });
        }
        const extraElements = actions.length > 0 ? [{ tag: "action", actions }] : [];

        await sendFeishuMessage(usr.openId, msgContent, "面评提醒", extraElements);

        // 创建飞书任务：面试官为负责人，HR为关注人
        const followerIds = hrOpenIds.length > 0 ? hrOpenIds : [];
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
          (hrOpenIds.length ? ` HR关注人:${hrName}(${hrOpenIds.join(",")})` : ""));
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

export { checkReviewReminders };
