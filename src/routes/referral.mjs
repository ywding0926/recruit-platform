import { Router } from "express";
import { requireLogin } from "../auth.mjs";
import { loadData, saveData, nowIso, rid } from "../db.mjs";
import { renderPage, escapeHtml, statusBadge } from "../ui.mjs";
import { findDuplicate, pushEvent, notifyHrNewCandidate, saveResumeSupabaseOrLocal } from "../helpers.mjs";
import { upload } from "../upload.mjs";

const router = Router();
const EMAIL_FULLTIME = "ahr@machinepulse.ai";
const EMAIL_INTERN = "intern@machinepulse.ai";

/* ========== GET /referral — 内推页面 ========== */
router.get("/referral", requireLogin, async (req, res) => {
  const d = await loadData();
  const user = req.user;

  // 在招岗位
  const openJobs = d.jobs.filter(j => j.state !== "closed");
  const jobOpts = openJobs.map(j =>
    '<option value="' + escapeHtml(j.id) + '">' + escapeHtml(j.title) +
    (j.department ? " (" + escapeHtml(j.department) + ")" : "") + "</option>"
  ).join("");

  // 我的内推记录
  const myReferrals = d.candidates
    .filter(c => c.referrerId === user.id)
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  const historyRows = myReferrals.map(c => {
    const m = (c.source || "").match(/推荐码:([^)]+)/);
    const code = m ? m[1] : "-";
    return "<tr>" +
      '<td style="font-weight:600">' + escapeHtml(c.name) + "</td>" +
      "<td>" + escapeHtml(c.jobTitle || "-") + "</td>" +
      '<td><code style="font-size:12px;background:#f5f5f5;padding:2px 6px;border-radius:4px">' + escapeHtml(code) + "</code></td>" +
      "<td>" + statusBadge(c.status) + "</td>" +
      '<td class="muted">' + escapeHtml(c.createdAt ? c.createdAt.slice(0, 10) : "-") + "</td>" +
      "</tr>";
  }).join("");

  const avatarHtml = user.avatar
    ? '<img src="' + escapeHtml(user.avatar) + '" style="width:36px;height:36px;border-radius:50%" />'
    : '<div style="width:36px;height:36px;border-radius:50%;background:var(--primary);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700">' + escapeHtml((user.name || "U").slice(0, 1)) + "</div>";

  const contentHtml =
    '<div class="row"><div><div style="font-weight:900;font-size:20px">内推候选人</div>' +
    '<div class="muted" style="margin-top:4px">推荐优秀人才，助力团队发展</div></div><span class="spacer"></span>' +
    '<a class="btn" href="/referral/public" target="_blank" style="margin-right:8px">打开公开内推页</a>' +
    '<button class="btn primary" onclick="copyTxt(location.origin+\'/referral/public\')">复制内推链接</button></div>' +
    '<div style="height:16px"></div>' +

    '<div class="grid">' +

    /* ---- 左列：内推表单 ---- */
    '<div><div class="card">' +
    '<div style="font-weight:900;font-size:16px;margin-bottom:4px">提交内推</div>' +
    '<div class="muted" style="margin-bottom:12px">推荐人信息将自动从登录账号获取</div>' +

    // 推荐人信息
    '<div style="background:#f0ebff;border:1px solid #d4c5fc;border-radius:8px;padding:12px 14px;margin-bottom:16px;display:flex;align-items:center;gap:10px">' +
    avatarHtml +
    '<div><div style="font-weight:700">' + escapeHtml(user.name || "") + '</div><div class="muted" style="font-size:12px">推荐人（自动获取）</div></div>' +
    "</div>" +

    '<form id="referralForm">' +
    '<div style="margin-bottom:12px"><label style="font-weight:600;display:block;margin-bottom:4px">内推码 <span style="color:red">*</span></label>' +
    '<input id="rfCode" required placeholder="工号、姓名或自定义标识" style="width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:6px" />' +
    '<div class="muted" style="font-size:12px;margin-top:2px">此编码将标记在候选人来源中，便于追踪</div></div>' +

    '<div style="font-weight:700;margin:16px 0 8px;font-size:14px">被推荐人信息</div>' +

    '<div style="margin-bottom:12px"><label style="font-weight:600;display:block;margin-bottom:4px">姓名 <span style="color:red">*</span></label>' +
    '<input id="rfName" required placeholder="候选人姓名" style="width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:6px" /></div>' +

    '<div style="margin-bottom:12px"><label style="font-weight:600;display:block;margin-bottom:4px">手机号</label>' +
    '<input id="rfPhone" placeholder="选填，用于查重" style="width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:6px" /></div>' +

    '<div style="margin-bottom:12px"><label style="font-weight:600;display:block;margin-bottom:4px">邮箱</label>' +
    '<input id="rfEmail" type="email" placeholder="选填" style="width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:6px" /></div>' +

    '<div style="margin-bottom:12px"><label style="font-weight:600;display:block;margin-bottom:4px">推荐岗位 <span style="color:red">*</span></label>' +
    '<select id="rfJobId" required style="width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:6px"><option value="">请选择岗位</option>' + jobOpts + "</select></div>" +

    '<div style="margin-bottom:12px"><label style="font-weight:600;display:block;margin-bottom:4px">简历附件</label>' +
    '<input id="rfResume" type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx" style="width:100%" />' +
    '<div class="muted" style="font-size:12px;margin-top:2px">支持 PDF / Word / 图片格式</div></div>' +

    '<div style="margin-bottom:12px"><label style="font-weight:600;display:block;margin-bottom:4px">推荐理由 / 备注</label>' +
    '<textarea id="rfNote" rows="4" placeholder="请简要说明推荐理由、候选人亮点等" style="width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:6px;resize:vertical"></textarea></div>' +

    '<div style="border-top:1px solid #eee;margin:16px 0"></div>' +
    '<button class="btn primary" type="submit" id="rfSubmitBtn" style="width:100%">提交内推</button>' +
    "</form></div></div>" +

    /* ---- 右列：邮件说明 + 须知 ---- */
    "<div>" +
    '<div class="card" style="border-left:3px solid var(--primary)">' +
    '<div style="font-weight:900;font-size:16px;margin-bottom:4px">📧 邮件投递简历</div>' +
    '<div class="muted" style="margin-bottom:12px">如候选人希望通过邮件投递简历，请告知对应邮箱地址：</div>' +
    '<div style="background:#f0ebff;border:1px solid #d4c5fc;border-radius:8px;padding:14px;margin-bottom:10px">' +
    '<div style="display:flex;justify-content:space-between;align-items:center"><div><div style="font-size:12px;color:#666;margin-bottom:2px">全职岗位</div>' +
    '<div style="font-size:15px;font-weight:700;color:var(--primary)" id="emailFull">' + escapeHtml(EMAIL_FULLTIME) + '</div></div>' +
    '<button class="btn" style="font-size:11px;padding:4px 10px" onclick="copyTxt(\'' + EMAIL_FULLTIME + '\')">复制</button></div></div>' +
    '<div style="background:#f0ebff;border:1px solid #d4c5fc;border-radius:8px;padding:14px">' +
    '<div style="display:flex;justify-content:space-between;align-items:center"><div><div style="font-size:12px;color:#666;margin-bottom:2px">实习岗位</div>' +
    '<div style="font-size:15px;font-weight:700;color:var(--primary)" id="emailIntern">' + escapeHtml(EMAIL_INTERN) + '</div></div>' +
    '<button class="btn" style="font-size:11px;padding:4px 10px" onclick="copyTxt(\'' + EMAIL_INTERN + '\')">复制</button></div></div>' +
    '<div class="muted" style="margin-top:12px;line-height:1.8;font-size:13px">' +
    "<b>邮件格式建议：</b><br/>" +
    "标题：内推-[你的内推码]-[候选人姓名]-[岗位名称]<br/>" +
    "附件：候选人简历（PDF格式）<br/>" +
    "正文：候选人基本信息和推荐理由<br/><br/>" +
    "HR 收到邮件后会手动录入系统。</div></div>" +

    '<div class="card" style="margin-top:14px">' +
    '<div style="font-weight:700;margin-bottom:8px">📋 内推须知</div>' +
    '<div class="muted" style="line-height:1.8;font-size:13px">' +
    "1. 请确保候选人知晓并同意被推荐<br/>" +
    "2. 内推码将用于追踪推荐记录和奖励归属<br/>" +
    "3. 提交后 HR 会收到飞书通知<br/>" +
    "4. 你可以在下方查看内推进度</div></div>" +
    "</div>" +

    "</div>" + // end grid

    /* ---- 内推记录 ---- */
    '<div style="height:20px"></div>' +
    '<div class="card">' +
    '<div class="row"><div style="font-weight:900;font-size:16px">我的内推记录</div><span class="spacer"></span>' +
    '<span class="muted">' + myReferrals.length + " 条记录</span></div>" +
    '<div style="border-top:1px solid #eee;margin:12px 0"></div>' +
    (myReferrals.length > 0
      ? '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse"><thead><tr style="text-align:left;border-bottom:2px solid #eee">' +
        '<th style="padding:8px 10px">候选人</th><th style="padding:8px 10px">推荐岗位</th>' +
        '<th style="padding:8px 10px">内推码</th><th style="padding:8px 10px">状态</th>' +
        '<th style="padding:8px 10px">提交时间</th></tr></thead><tbody>' +
        historyRows.replace(/<td/g, '<td style="padding:8px 10px;border-bottom:1px solid #f0f0f0"') +
        "</tbody></table></div>"
      : '<div style="text-align:center;padding:32px 0;color:#999">暂无内推记录，提交你的第一个内推吧</div>') +
    "</div>";

  const scriptHtml =
    "<script>" +
    "function copyTxt(t){navigator.clipboard.writeText(t).then(function(){alert('已复制：'+t)}).catch(function(){prompt('请手动复制：',t)})}" +

    "document.getElementById('referralForm').onsubmit=async function(e){" +
    "e.preventDefault();" +
    "var btn=document.getElementById('rfSubmitBtn');" +
    "btn.textContent='提交中...';btn.disabled=true;" +
    "try{" +
    "var payload={referralCode:document.getElementById('rfCode').value.trim()," +
    "name:document.getElementById('rfName').value.trim()," +
    "phone:document.getElementById('rfPhone').value.trim()," +
    "email:document.getElementById('rfEmail').value.trim()," +
    "jobId:document.getElementById('rfJobId').value," +
    "note:document.getElementById('rfNote').value.trim()};" +

    "var r=await fetch('/referral/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});" +
    "var data=await r.json();" +

    "if(r.status===409&&data.duplicate){" +
    "alert('候选人疑似重复！\\n\\n已有候选人：'+data.duplicate.name+'\\n手机：'+(data.duplicate.phone||'-')+'\\n岗位：'+(data.duplicate.jobTitle||'-')+'\\n状态：'+(data.duplicate.status||'-')+'\\n\\n如确认不是同一人，请修改手机号后重试。');" +
    "btn.textContent='提交内推';btn.disabled=false;return}" +

    "if(!r.ok)throw new Error(data.error||'提交失败');" +
    "var candidateId=data.candidateId;" +

    // 上传简历
    "var fileInput=document.getElementById('rfResume');" +
    "var file=fileInput&&fileInput.files[0];" +
    "if(file){" +
    "btn.textContent='上传简历中...';" +
    "try{" +
    "var signRes=await fetch('/api/resume/upload-url',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({candidateId:candidateId,fileName:file.name,contentType:file.type||'application/octet-stream'})});" +
    "var signData=await signRes.json();" +
    "if(signRes.ok&&signData.signedUrl){" +
    "var upRes=await fetch(signData.signedUrl,{method:'PUT',headers:{'Content-Type':file.type||'application/octet-stream'},body:file});" +
    "if(upRes.ok){await fetch('/api/candidates/'+candidateId+'/resume-meta',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({objectName:signData.objectName,originalName:file.name,contentType:file.type||'',size:file.size,bucket:signData.bucket})})}}" +
    "else{var fd=new FormData();fd.append('candidateId',candidateId);fd.append('resume',file);await fetch('/referral/resume',{method:'POST',body:fd})}" +
    "}catch(ue){console.warn('简历上传失败:',ue)}}" +

    "alert('内推提交成功！HR 已收到通知。');location.reload();" +
    "}catch(err){alert(err.message);btn.textContent='提交内推';btn.disabled=false}" +
    "};" +
    "</script>";

  res.send(renderPage({
    title: "内推",
    user: req.user,
    active: "referral",
    contentHtml: contentHtml + scriptHtml,
  }));
});

/* ========== POST /referral/submit — 提交内推 ========== */
router.post("/referral/submit", requireLogin, async (req, res) => {
  try {
    const d = await loadData();
    const user = req.user;

    const referralCode = String(req.body.referralCode || "").trim();
    const name = String(req.body.name || "").trim();
    const phone = String(req.body.phone || "").trim();
    const email = String(req.body.email || "").trim();
    const jobId = String(req.body.jobId || "").trim();
    const note = String(req.body.note || "").trim();

    if (!referralCode) return res.status(400).json({ error: "请填写内推码" });
    if (!name) return res.status(400).json({ error: "请填写候选人姓名" });
    if (!jobId) return res.status(400).json({ error: "请选择推荐岗位" });

    const job = d.jobs.find(j => j.id === jobId);
    if (!job) return res.status(400).json({ error: "岗位不存在" });

    // 查重
    const dup = findDuplicate(d.candidates, name, phone);
    if (dup) {
      return res.status(409).json({
        error: "候选人疑似重复",
        duplicate: { id: dup.id, name: dup.name, phone: dup.phone, jobTitle: dup.jobTitle || "-", status: dup.status },
      });
    }

    const source = "内推(推荐码:" + referralCode + ")";
    const fullNote = [note ? "推荐理由：" + note : "", "内推人：" + (user.name || "-")].filter(Boolean).join("\n");

    const c = {
      id: rid("c"),
      name, phone, email, jobId,
      jobTitle: job.title,
      source,
      note: fullNote,
      tags: [],
      status: "待筛选",
      follow: { nextAction: "待联系", followAt: "", note: "" },
      referrerId: user.id,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    d.candidates.unshift(c);

    if (c.source && !d.sources.includes(c.source)) d.sources.push(c.source);

    pushEvent(d, {
      candidateId: c.id,
      type: "创建",
      message: "内推：" + (user.name || "-") + " 推荐候选人 " + c.name + "（岗位：" + c.jobTitle + "，推荐码：" + referralCode + "）",
      actor: user.name || "内推",
    });

    await saveData(d);
    await notifyHrNewCandidate(d, c, job).catch(e => console.warn("[Referral] 通知HR失败:", e.message));

    console.log("[Referral] 新内推:", c.name, "by", user.name, "code:" + referralCode, "job:" + c.jobTitle);
    res.json({ ok: true, candidateId: c.id });
  } catch (e) {
    console.error("[Referral] error:", e.message);
    res.status(500).json({ error: String(e?.message || "提交失败") });
  }
});

/* ========== POST /referral/resume — 简历上传降级 ========== */
router.post("/referral/resume", requireLogin, upload.single("resume"), async (req, res) => {
  try {
    const d = await loadData();
    const candidateId = String(req.body.candidateId || "").trim();
    if (!candidateId) return res.status(400).json({ error: "缺少 candidateId" });

    const c = d.candidates.find(x => x.id === candidateId);
    if (!c) return res.status(404).json({ error: "候选人不存在" });

    if (c.referrerId !== req.user.id && req.user.role !== "admin") {
      return res.status(403).json({ error: "无权操作" });
    }

    const file = req.file;
    if (!file || !file.buffer || !file.buffer.length) {
      return res.status(400).json({ error: "请选择简历文件" });
    }

    await saveResumeSupabaseOrLocal(d, c.id, file, "内推:" + (req.user.name || ""));
    await saveData(d);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || "上传失败") });
  }
});

/* ========== 公开内推页面（独立布局，无需登录） ========== */

function publicPage({ title, contentHtml }) {
  return '<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + escapeHtml(title) + ' - MachinePulse</title>' +
    '<style>' +
    '*{box-sizing:border-box;margin:0;padding:0}' +
    'body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;background:#faf9fb;color:#1f2329;line-height:1.6}' +
    '.header{background:#fff;border-bottom:1px solid #e8e9eb;padding:14px 24px;display:flex;align-items:center;gap:10px;position:sticky;top:0;z-index:100}' +
    '.logo{width:32px;height:32px;background:#7c5cfc;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:16px}' +
    '.header-title{font-weight:700;font-size:15px}' +
    '.header-sub{font-size:12px;color:#8f959e}' +
    '.body{max-width:640px;margin:0 auto;padding:32px 20px}' +
    '.card{background:#fff;border:1px solid #e8e9eb;border-radius:12px;padding:24px;margin-bottom:16px}' +
    '.field{margin-bottom:16px}' +
    '.field label{display:block;font-size:13px;font-weight:600;color:#646a73;margin-bottom:4px}' +
    '.field input,.field select,.field textarea{width:100%;padding:10px 12px;border:1px solid #e8e9eb;border-radius:8px;font-size:14px;color:#1f2329;background:#fff}' +
    '.field textarea{min-height:80px;resize:vertical}' +
    '.muted{color:#8f959e;font-size:13px}' +
    '.btn{display:inline-flex;align-items:center;justify-content:center;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;border:none;background:#7c5cfc;color:#fff;width:100%;transition:all .15s}' +
    '.btn:hover{background:#6b4ce0}' +
    '.btn:disabled{opacity:.6;cursor:not-allowed}' +
    '.email-box{background:#f0ebff;border:1px solid #d4c5fc;border-radius:8px;padding:12px 14px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center}' +
    '.email-label{font-size:12px;color:#666;margin-bottom:1px}' +
    '.email-addr{font-size:14px;font-weight:700;color:#7c5cfc}' +
    '.copy-btn{padding:4px 10px;border:1px solid #d4c5fc;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;background:#fff;color:#7c5cfc}' +
    '.copy-btn:hover{background:#f0ebff}' +
    '.divider{height:1px;background:#e8e9eb;margin:20px 0}' +
    '.success{text-align:center;padding:48px 20px}' +
    '.success-icon{font-size:48px;margin-bottom:12px}' +
    '.success-title{font-size:20px;font-weight:700;margin-bottom:8px}' +
    '</style></head><body>' +
    '<div class="header"><div class="logo">M</div><div><div class="header-title">MachinePulse</div><div class="header-sub">内部员工内推通道</div></div></div>' +
    '<div class="body">' + contentHtml + '</div>' +
    '</body></html>';
}

/* GET /referral/public — 公开内推表单 */
router.get("/referral/public", async (req, res) => {
  const d = await loadData();
  const openJobs = d.jobs.filter(j => j.state !== "closed");
  const jobOpts = openJobs.map(j =>
    '<option value="' + escapeHtml(j.id) + '">' + escapeHtml(j.title) +
    (j.department ? " (" + escapeHtml(j.department) + ")" : "") + "</option>"
  ).join("");

  const contentHtml =
    '<div class="card">' +
    '<div style="text-align:center;margin-bottom:20px"><div style="font-size:22px;font-weight:900">内推候选人</div>' +
    '<div class="muted" style="margin-top:4px">推荐优秀人才，助力团队发展</div></div>' +

    '<form id="referralForm">' +
    '<div class="field"><label>推荐人姓名 <span style="color:red">*</span></label>' +
    '<input id="rfReferrer" required placeholder="你的姓名" /></div>' +

    '<div class="field"><label>内推码 <span style="color:red">*</span></label>' +
    '<input id="rfCode" required placeholder="工号、姓名或自定义标识" />' +
    '<div class="muted" style="margin-top:2px">用于追踪推荐记录</div></div>' +

    '<div class="divider"></div>' +
    '<div style="font-weight:700;margin-bottom:12px;font-size:15px">被推荐人信息</div>' +

    '<div class="field"><label>候选人姓名 <span style="color:red">*</span></label>' +
    '<input id="rfName" required placeholder="被推荐人姓名" /></div>' +

    '<div class="field"><label>手机号</label>' +
    '<input id="rfPhone" placeholder="选填" /></div>' +

    '<div class="field"><label>邮箱</label>' +
    '<input id="rfEmail" type="email" placeholder="选填" /></div>' +

    '<div class="field"><label>推荐岗位 <span style="color:red">*</span></label>' +
    '<select id="rfJobId" required><option value="">请选择岗位</option>' + jobOpts + '</select></div>' +

    '<div class="field"><label>简历附件</label>' +
    '<input id="rfResume" type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx" />' +
    '<div class="muted" style="margin-top:2px">支持 PDF / Word / 图片格式</div></div>' +

    '<div class="field"><label>推荐理由 / 备注</label>' +
    '<textarea id="rfNote" placeholder="请简要说明推荐理由、候选人亮点等"></textarea></div>' +

    '<button class="btn" type="submit" id="rfSubmitBtn">提交内推</button>' +
    '</form></div>' +

    // 邮件投递说明
    '<div class="card">' +
    '<div style="font-weight:700;margin-bottom:10px;font-size:15px">📧 邮件投递简历</div>' +
    '<div class="muted" style="margin-bottom:10px">候选人也可直接发送简历到对应邮箱：</div>' +
    '<div class="email-box"><div><div class="email-label">全职岗位</div><div class="email-addr">' + escapeHtml(EMAIL_FULLTIME) + '</div></div>' +
    '<button class="copy-btn" onclick="copyTxt(\'' + EMAIL_FULLTIME + '\')">复制</button></div>' +
    '<div class="email-box"><div><div class="email-label">实习岗位</div><div class="email-addr">' + escapeHtml(EMAIL_INTERN) + '</div></div>' +
    '<button class="copy-btn" onclick="copyTxt(\'' + EMAIL_INTERN + '\')">复制</button></div>' +
    '<div class="muted" style="margin-top:10px;line-height:1.7">' +
    '邮件标题格式：内推-[内推码]-[候选人姓名]-[岗位]<br/>附件请附上简历 PDF</div></div>' +

    // JS
    '<script>' +
    'function copyTxt(t){navigator.clipboard.writeText(t).then(function(){alert("已复制："+t)}).catch(function(){prompt("请手动复制：",t)})}' +

    'document.getElementById("referralForm").onsubmit=async function(e){' +
    'e.preventDefault();' +
    'var btn=document.getElementById("rfSubmitBtn");' +
    'btn.textContent="提交中...";btn.disabled=true;' +
    'try{' +
    'var payload={referrerName:document.getElementById("rfReferrer").value.trim(),' +
    'referralCode:document.getElementById("rfCode").value.trim(),' +
    'name:document.getElementById("rfName").value.trim(),' +
    'phone:document.getElementById("rfPhone").value.trim(),' +
    'email:document.getElementById("rfEmail").value.trim(),' +
    'jobId:document.getElementById("rfJobId").value,' +
    'note:document.getElementById("rfNote").value.trim()};' +

    'var r=await fetch("/referral/public/submit",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});' +
    'var data=await r.json();' +

    'if(r.status===409&&data.duplicate){' +
    'alert("候选人疑似重复！\\n\\n已有候选人："+data.duplicate.name+"\\n如确认不同人请修改手机号后重试。");' +
    'btn.textContent="提交内推";btn.disabled=false;return}' +

    'if(!r.ok)throw new Error(data.error||"提交失败");' +
    'var candidateId=data.candidateId;' +

    // 上传简历
    'var fileInput=document.getElementById("rfResume");' +
    'var file=fileInput&&fileInput.files[0];' +
    'if(file){btn.textContent="上传简历中...";' +
    'try{var fd=new FormData();fd.append("candidateId",candidateId);fd.append("resume",file);' +
    'await fetch("/referral/public/resume",{method:"POST",body:fd})}catch(ue){console.warn("简历上传失败",ue)}}' +

    // 成功页面
    'document.querySelector(".body").innerHTML=' +
    '\'<div class="card success"><div class="success-icon">✅</div>' +
    '<div class="success-title">内推提交成功！</div>' +
    '<div class="muted" style="margin-bottom:20px">HR 已收到飞书通知，感谢你的推荐</div>' +
    '<a href="/referral/public" style="color:#7c5cfc;font-weight:600;text-decoration:none">继续推荐 →</a></div>\';' +

    '}catch(err){alert(err.message);btn.textContent="提交内推";btn.disabled=false}' +
    '};' +
    '</script>';

  res.send(publicPage({ title: "内推", contentHtml }));
});

/* POST /referral/public/submit — 公开内推提交（无需登录） */
router.post("/referral/public/submit", async (req, res) => {
  try {
    const d = await loadData();

    const referrerName = String(req.body.referrerName || "").trim();
    const referralCode = String(req.body.referralCode || "").trim();
    const name = String(req.body.name || "").trim();
    const phone = String(req.body.phone || "").trim();
    const email = String(req.body.email || "").trim();
    const jobId = String(req.body.jobId || "").trim();
    const note = String(req.body.note || "").trim();

    if (!referrerName) return res.status(400).json({ error: "请填写推荐人姓名" });
    if (!referralCode) return res.status(400).json({ error: "请填写内推码" });
    if (!name) return res.status(400).json({ error: "请填写候选人姓名" });
    if (!jobId) return res.status(400).json({ error: "请选择推荐岗位" });

    const job = d.jobs.find(j => j.id === jobId);
    if (!job) return res.status(400).json({ error: "岗位不存在" });

    const dup = findDuplicate(d.candidates, name, phone);
    if (dup) {
      return res.status(409).json({
        error: "候选人疑似重复",
        duplicate: { name: dup.name },
      });
    }

    const source = "内推(推荐码:" + referralCode + ")";
    const fullNote = [note ? "推荐理由：" + note : "", "内推人：" + referrerName + "（公开渠道）"].filter(Boolean).join("\n");

    const c = {
      id: rid("c"),
      name, phone, email, jobId,
      jobTitle: job.title,
      source,
      note: fullNote,
      tags: [],
      status: "待筛选",
      follow: { nextAction: "待联系", followAt: "", note: "" },
      referrerId: "",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    d.candidates.unshift(c);

    if (c.source && !d.sources.includes(c.source)) d.sources.push(c.source);

    pushEvent(d, {
      candidateId: c.id,
      type: "创建",
      message: "内推（公开渠道）：" + referrerName + " 推荐候选人 " + c.name + "（岗位：" + c.jobTitle + "，推荐码：" + referralCode + "）",
      actor: referrerName,
    });

    await saveData(d);
    await notifyHrNewCandidate(d, c, job).catch(e => console.warn("[Referral-Public] 通知HR失败:", e.message));

    console.log("[Referral-Public] 新内推:", c.name, "by", referrerName, "code:" + referralCode, "job:" + c.jobTitle);
    res.json({ ok: true, candidateId: c.id });
  } catch (e) {
    console.error("[Referral-Public] error:", e.message);
    res.status(500).json({ error: String(e?.message || "提交失败") });
  }
});

/* POST /referral/public/resume — 公开内推简历上传（无需登录） */
router.post("/referral/public/resume", upload.single("resume"), async (req, res) => {
  try {
    const d = await loadData();
    const candidateId = String(req.body.candidateId || "").trim();
    if (!candidateId) return res.status(400).json({ error: "缺少 candidateId" });

    const c = d.candidates.find(x => x.id === candidateId);
    if (!c) return res.status(404).json({ error: "候选人不存在" });

    const file = req.file;
    if (!file || !file.buffer || !file.buffer.length) {
      return res.status(400).json({ error: "请选择简历文件" });
    }

    await saveResumeSupabaseOrLocal(d, c.id, file, "内推(公开)");
    await saveData(d);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || "上传失败") });
  }
});

export default router;
