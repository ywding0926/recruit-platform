import { Router } from "express";
import { loadData, saveData, nowIso, rid, toBjTime } from "../db.mjs";
import { renderPage, escapeHtml } from "../ui.mjs";
import { sendFeishuMessage, sendFeishuGroupMessage, getFeishuMeetingRecording } from "../feishu.mjs";
import { INTERVIEW_RATING, INTERVIEW_RATING_LABEL, STATUS_SET } from "../constants.mjs";
import { pushEvent } from "../helpers.mjs";

const router = Router();

// 公开页面：面试官通过 token 直接填写面评（无需登录）
router.get("/review/:token", async (req, res) => {
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

  const rtOpts = INTERVIEW_RATING.map(x => '<option value="' + x + '" ' + (existingReview?.rating === x ? 'selected' : '') + '>' + (INTERVIEW_RATING_LABEL[x] || x) + '</option>').join("");

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
      '<div class="field"><label>综合评级 <span class="muted" style="font-size:12px">S=不可错过 A=强推荐 B+=优选录用 B=可录用 B-=谨慎录用 C=不录用</span></label><select id="rvRating" required><option value="">请选择</option>' + rtOpts + '</select></div>' +
      '<div class="field"><label>面试结论</label><select id="rvConclusion"><option value="通过"' + (existingReview?.conclusion === '通过' ? ' selected' : '') + '>通过</option><option value="不通过"' + (existingReview?.conclusion === '不通过' ? ' selected' : '') + '>不通过</option><option value="Pending"' + (existingReview?.conclusion === 'Pending' ? ' selected' : '') + '>Pending</option></select></div>' +
      '<div class="divider"></div>' +
      '<div class="field"><label>Pros（优势和亮点）</label><textarea id="rvPros" rows="4" placeholder="候选人的优势、能力亮点、让你印象深刻的地方">' + escapeHtml(existingReview?.pros || '') + '</textarea></div>' +
      '<div class="field"><label>Cons（不足和风险）</label><textarea id="rvCons" rows="4" placeholder="候选人的不足、潜在风险、需要关注的地方">' + escapeHtml(existingReview?.cons || '') + '</textarea></div>' +
      '<div class="field"><label>下一轮考察点</label><textarea id="rvFocusNext" rows="3" placeholder="如果进入下一轮，建议重点考察的方向">' + escapeHtml(existingReview?.focusNext || '') + '</textarea></div>' +
      '<button class="btn primary" type="submit" id="submitBtn" style="width:100%;margin-top:8px">提交面评</button>' +
    '</form></div>' +
    '<script>' +
    'var _rvSubmitting=false;' +
    'document.getElementById("reviewForm").onsubmit=async function(e){e.preventDefault();' +
    'if(_rvSubmitting)return;' +
    'var rating=document.getElementById("rvRating").value;if(!rating){alert("请选择评级");return}' +
    'var interviewer=document.getElementById("rvInterviewer").value.trim();if(!interviewer){alert("请填写面试官姓名");return}' +
    'var pros=document.getElementById("rvPros").value.trim();var cons=document.getElementById("rvCons").value.trim();' +
    'if(!pros&&!cons){alert("Pros和Cons至少填写一项");return}' +
    '_rvSubmitting=true;var btn=document.getElementById("submitBtn");btn.textContent="提交中...";btn.disabled=true;' +
    'try{var r=await fetch("/api/review/' + escapeHtml(req.params.token) + '",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({rating:rating,conclusion:document.getElementById("rvConclusion").value,interviewer:interviewer,pros:pros,cons:cons,focusNext:document.getElementById("rvFocusNext").value})});' +
    'var data=await r.json();if(r.ok){if(data.autoFlowMsg)alert(data.autoFlowMsg);alert("面评已提交，感谢！");location.reload()}else{alert(data.error||"提交失败");btn.textContent="提交面评";btn.disabled=false;_rvSubmitting=false}}catch(err){alert("提交失败："+err.message);btn.textContent="提交面评";btn.disabled=false;_rvSubmitting=false}};' +
    'async function refreshRecording(){var btn=document.getElementById("refreshRecBtn");if(!btn)return;btn.textContent="查询中...";btn.disabled=true;' +
    'try{var r=await fetch("/api/review/' + escapeHtml(req.params.token) + '/recording");var d=await r.json();if(d.recordingUrl){alert("找到录制链接！");location.reload()}else{alert("录制尚未就绪，会议结束后通常需要几分钟。请稍后再试。");btn.textContent="🔄 刷新会议录制链接";btn.disabled=false}}catch(e){alert("查询失败");btn.textContent="🔄 刷新会议录制链接";btn.disabled=false}}' +
    '</script>';

  res.send(renderPage({ title: "面试反馈 - " + c.name, user: null, active: "", contentHtml: html }));
});

// 公开 API：通过 token 提交面评（无需登录）
router.post("/api/review/:token", async (req, res) => {
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

  // 自动状态流转逻辑（基于面试结论，评级为 Pending 时不触发流转）
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

  pushEvent(d, { candidateId: c.id, type: "面评", message: "第" + round + "轮（" + interviewer + "，外部面评）：结论=" + conclusion + "，评级=" + (rating || "-") + "\nPros：" + (pros || "-") + "\nCons：" + (cons || "-"), actor: interviewer });
  if (old !== c.status) {
    pushEvent(d, { candidateId: c.id, type: "状态同步", message: "因面评更新，状态：" + old + " -> " + c.status, actor: "系统" });
  }
  if (!c.follow) c.follow = {};
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
  await saveData(d);

  // 面评完成后通知管理员
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
    console.log("[ReviewNotify] 外部面评通知: 候选人=" + c.name + " admins=" + admins.length + " (" + admins.map(a => a.name).join(",") + ")");
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

// 公开 API：刷新会议录制链接
router.get("/api/review/:token/recording", async (req, res) => {
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

export default router;
