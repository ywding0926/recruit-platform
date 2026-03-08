import { Router } from "express";
import { requireLogin } from "../auth.mjs";
import { loadData, saveData, nowIso, rid, toBjTime } from "../db.mjs";
import { escapeHtml } from "../ui.mjs";
import { upload } from "../upload.mjs";
import { findDuplicate, pushEvent, notifyHrNewCandidate, saveResumeSupabaseOrLocal } from "../helpers.mjs";

const router = Router();

function portalPage({ title, hunterName, contentHtml }) {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} - Machinepulse招聘系统</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;background:#faf9fb;color:#1f2329;line-height:1.6}
.portal-header{background:#fff;border-bottom:1px solid #e8e9eb;padding:14px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100}
.portal-brand{display:flex;align-items:center;gap:10px}
.portal-logo{width:32px;height:32px;background:#7c5cfc;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:16px}
.portal-title{font-weight:700;font-size:15px;color:#1f2329}
.portal-sub{font-size:12px;color:#8f959e}
.portal-user{display:flex;align-items:center;gap:8px;font-size:13px;color:#646a73}
.portal-user a{color:#7c5cfc;text-decoration:none;font-weight:600}
.portal-body{max-width:960px;margin:0 auto;padding:24px 20px}
.card{background:#fff;border:1px solid #e8e9eb;border-radius:12px;padding:20px;margin-bottom:16px}
.card.compact{padding:16px}
.btn{display:inline-flex;align-items:center;justify-content:center;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;border:1px solid #e8e9eb;background:#fff;color:#1f2329;text-decoration:none;transition:all .15s}
.btn:hover{background:#f5f5f5}
.btn.primary{background:#7c5cfc;color:#fff;border-color:#7c5cfc}
.btn.primary:hover{background:#6b4ce0}
.field{margin-bottom:14px}
.field label{display:block;font-size:13px;font-weight:600;color:#646a73;margin-bottom:4px}
.field input,.field select,.field textarea{width:100%;padding:8px 12px;border:1px solid #e8e9eb;border-radius:8px;font-size:14px;color:#1f2329;background:#fff}
.field textarea{min-height:80px;resize:vertical}
.divider{height:1px;background:#e8e9eb;margin:16px 0}
.muted{color:#8f959e;font-size:13px}
.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.spacer{flex:1}
.job-card{background:#fff;border:1px solid #e8e9eb;border-radius:10px;padding:16px 20px;margin-bottom:10px;cursor:pointer;transition:all .15s;display:flex;align-items:center;justify-content:space-between}
.job-card:hover{border-color:#7c5cfc;box-shadow:0 2px 8px rgba(124,92,252,.12)}
.job-title{font-weight:700;font-size:15px;color:#1f2329}
.job-meta{font-size:12px;color:#8f959e;margin-top:2px}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600}
.badge-green{background:#e8f5e9;color:#2e7d32}
.badge-gray{background:#f0f0f0;color:#646a73}
.badge-purple{background:#f0ebff;color:#7c5cfc}
.success-box{background:#e8f5e9;border:1px solid #c8e6c9;border-radius:10px;padding:20px;text-align:center}
.success-box h3{color:#2e7d32;margin-bottom:8px}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #f0f0f0;font-size:13px}
th{color:#8f959e;font-weight:600;font-size:12px}
@media(max-width:600px){.portal-body{padding:16px 12px}.job-card{flex-direction:column;align-items:flex-start;gap:8px}}
</style></head><body>
<div class="portal-header">
  <div class="portal-brand">
    <div class="portal-logo">M</div>
    <div><div class="portal-title">Machinepulse招聘系统</div><div class="portal-sub">猎头投递门户</div></div>
  </div>
  <div class="portal-user">${hunterName ? '欢迎，' + escapeHtml(hunterName) + ' &nbsp; <a href="/portal/my">我的投递</a> &nbsp; <a href="/portal/logout">退出</a>' : ''}</div>
</div>
<div class="portal-body">${contentHtml}</div>
</body></html>`;
}

// 猎头 session 中间件：从 session 读取猎头信息
function requirePortalLogin(req, res, next) {
  if (req.session?.hunterId) {
    req.hunterId = req.session.hunterId;
    req.hunterName = req.session.hunterName || "";
    return next();
  }
  return res.redirect(303, "/portal");
}

router.get("/portal", (req, res) => {
  if (req.session?.hunterId) return res.redirect("/portal/jobs");
  res.send(portalPage({
    title: "猎头登录",
    hunterName: "",
    contentHtml: '<div class="card" style="max-width:420px;margin:60px auto">' +
      '<div style="font-weight:900;font-size:18px;margin-bottom:4px">猎头投递门户</div>' +
      '<div class="muted" style="margin-bottom:16px">请输入您的 API Key 登录系统</div>' +
      '<form method="POST" action="/portal/login">' +
      '<div class="field"><label>API Key</label><input name="apiKey" placeholder="hk_xxxxxxxx" required /></div>' +
      '<button class="btn primary" type="submit" style="width:100%">登录</button>' +
      '</form></div>',
  }));
});

router.post("/portal/login", async (req, res) => {
  const apiKey = String(req.body.apiKey || "").trim();
  if (!apiKey) return res.redirect(303, "/portal");
  const d = await loadData();
  const hunter = d.headhunters.find(h => h.apiKey === apiKey && h.enabled !== false);
  if (!hunter) {
    return res.send(portalPage({
      title: "登录失败",
      hunterName: "",
      contentHtml: '<div class="card" style="max-width:420px;margin:60px auto">' +
        '<div style="font-weight:900;font-size:18px;margin-bottom:4px">猎头投递门户</div>' +
        '<div style="color:#f54a45;margin-bottom:12px;font-size:14px">API Key 无效或已被禁用，请联系招聘团队获取有效的 API Key。</div>' +
        '<form method="POST" action="/portal/login">' +
        '<div class="field"><label>API Key</label><input name="apiKey" value="' + escapeHtml(apiKey) + '" required /></div>' +
        '<button class="btn primary" type="submit" style="width:100%">重新登录</button>' +
        '</form></div>',
    }));
  }
  req.session.hunterId = hunter.id;
  req.session.hunterName = hunter.name;
  req.session.hunterApiKey = hunter.apiKey;
  res.redirect(303, "/portal/jobs");
});

router.get("/portal/logout", (req, res) => {
  req.session.hunterId = null;
  req.session.hunterName = null;
  req.session.hunterApiKey = null;
  res.redirect("/portal");
});

// ====== 猎头门户：岗位列表 ======
router.get("/portal/jobs", requirePortalLogin, async (req, res) => {
  const d = await loadData();
  const openJobs = d.jobs.filter(j => j.state !== "closed" && j.status !== "已关闭");

  const jobCards = openJobs.map(j => {
    const meta = [j.department, j.location, j.category].filter(Boolean).join(" · ") || "暂无详情";
    return '<a class="job-card" href="/portal/jobs/' + j.id + '/apply">' +
      '<div><div class="job-title">' + escapeHtml(j.title) + '</div><div class="job-meta">' + escapeHtml(meta) + '</div></div>' +
      '<span class="badge badge-green">投递</span></a>';
  }).join("");

  const emptyTip = openJobs.length === 0 ? '<div class="muted" style="text-align:center;padding:40px">暂无开放岗位</div>' : '';

  res.send(portalPage({
    title: "开放岗位",
    hunterName: req.hunterName,
    contentHtml: '<div class="row" style="margin-bottom:16px"><div style="font-weight:900;font-size:18px">开放岗位</div><span class="spacer"></span><span class="muted">' + openJobs.length + ' 个岗位招聘中</span></div>' +
      jobCards + emptyTip,
  }));
});

// ====== 猎头门户：投递页面（填写候选人信息 + 上传简历）======
router.get("/portal/jobs/:jobId/apply", requirePortalLogin, async (req, res) => {
  const d = await loadData();
  const job = d.jobs.find(j => j.id === req.params.jobId);
  if (!job) return res.send(portalPage({ title: "岗位不存在", hunterName: req.hunterName, contentHtml: '<div class="card"><div style="color:#f54a45;font-weight:700">岗位不存在或已关闭</div><div class="divider"></div><a class="btn" href="/portal/jobs">返回岗位列表</a></div>' }));

  const jdHtml = job.jd ? '<div class="card compact"><div style="font-weight:700;margin-bottom:8px">岗位描述</div><div class="muted" style="white-space:pre-wrap;font-size:13px">' + escapeHtml(job.jd) + '</div></div>' : '';

  res.send(portalPage({
    title: "投递 - " + job.title,
    hunterName: req.hunterName,
    contentHtml: '<div class="row" style="margin-bottom:16px"><a class="btn" href="/portal/jobs">&larr; 返回岗位列表</a><span class="spacer"></span></div>' +
      '<div class="card"><div style="font-weight:900;font-size:18px;margin-bottom:4px">投递候选人</div>' +
      '<div class="muted" style="margin-bottom:12px">岗位：<b>' + escapeHtml(job.title) + '</b>' +
      (job.department ? ' · ' + escapeHtml(job.department) : '') +
      (job.location ? ' · ' + escapeHtml(job.location) : '') + '</div>' +
      '<div class="divider"></div>' +
      '<form id="applyForm" enctype="multipart/form-data">' +
      '<div class="field"><label>候选人姓名 *</label><input id="aName" required /></div>' +
      '<div class="field"><label>手机号 *</label><input id="aPhone" required /></div>' +
      '<div class="field"><label>邮箱</label><input id="aEmail" type="email" /></div>' +
      '<div class="field"><label>简历附件</label>' +
      '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
      '<input id="aResume" type="file" accept=".pdf,.doc,.docx,.jpg,.png" />' +
      '<span id="fileStatus" style="font-size:13px;color:#8f959e"></span>' +
      '</div>' +
      '<div id="progressWrap" style="display:none;margin-top:8px">' +
      '<div style="background:#e9e5f5;border-radius:6px;height:8px;overflow:hidden">' +
      '<div id="progressBar" style="width:0%;height:100%;background:#7c5cfc;border-radius:6px;transition:width .2s"></div>' +
      '</div>' +
      '<div id="progressText" style="font-size:12px;color:#8f959e;margin-top:4px">准备上传...</div>' +
      '</div>' +
      '</div>' +
      '<div class="field"><label>推荐理由 / 备注</label><textarea id="aNote" placeholder="请简要说明推荐理由"></textarea></div>' +
      '<div class="divider"></div>' +
      '<button class="btn primary" type="submit" id="submitBtn" style="width:100%">提交候选人</button>' +
      '</form></div>' +
      jdHtml +
      '<script>' +
      'var fileInput=document.getElementById("aResume");' +
      'var fileStatus=document.getElementById("fileStatus");' +
      'fileInput.addEventListener("change",function(){' +
      'if(fileInput.files.length>0){' +
      'var f=fileInput.files[0];var sizeMB=(f.size/1024/1024).toFixed(1);' +
      'fileStatus.textContent="已选择: "+f.name+" ("+sizeMB+"MB)";fileStatus.style.color="#7c5cfc"' +
      '}else{fileStatus.textContent="";fileStatus.style.color="#8f959e"}' +
      '});' +
      'function uploadResume(candidateId,file){' +
      'return new Promise(function(resolve,reject){' +
      'var fd=new FormData();fd.append("candidateId",candidateId);fd.append("resume",file);' +
      'var xhr=new XMLHttpRequest();' +
      'var pw=document.getElementById("progressWrap");var pb=document.getElementById("progressBar");var pt=document.getElementById("progressText");' +
      'pw.style.display="block";pb.style.width="0%";pt.textContent="上传中...";' +
      'xhr.upload.onprogress=function(e){if(e.lengthComputable){var pct=Math.round(e.loaded/e.total*100);pb.style.width=pct+"%";pt.textContent="上传中... "+pct+"%"}};' +
      'xhr.onload=function(){' +
      'if(xhr.status>=200&&xhr.status<300){pb.style.width="100%";pb.style.background="#16a34a";pt.textContent="✓ 上传成功";resolve(true)}' +
      'else{var msg="上传失败";try{msg=JSON.parse(xhr.responseText).error||msg}catch(e){}pb.style.background="#f54a45";pt.textContent="✗ "+msg;reject(new Error(msg))}' +
      '};' +
      'xhr.onerror=function(){pb.style.background="#f54a45";pt.textContent="✗ 网络错误";reject(new Error("网络错误"))};' +
      'xhr.open("POST","/portal/api/resume");xhr.send(fd)' +
      '});}' +
      'document.getElementById("applyForm").addEventListener("submit",async function(e){' +
      'e.preventDefault();var btn=document.getElementById("submitBtn");btn.disabled=true;btn.textContent="提交中...";' +
      'try{' +
      'var r=await fetch("/portal/api/apply",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({' +
      'name:document.getElementById("aName").value.trim(),' +
      'phone:document.getElementById("aPhone").value.trim(),' +
      'email:document.getElementById("aEmail").value.trim(),' +
      'note:document.getElementById("aNote").value.trim(),' +
      'jobId:"' + job.id + '"' +
      '})});' +
      'var data=await r.json();' +
      'if(r.status===409&&data.duplicate){alert("候选人疑似重复！\\n\\n已有候选人："+data.duplicate.name+"\\n手机："+data.duplicate.phone+"\\n岗位："+data.duplicate.jobTitle+"\\n\\n请检查后重新填写");btn.disabled=false;btn.textContent="提交候选人";return}' +
      'if(!r.ok)throw new Error(data.error||"提交失败");' +
      'var candidateId=data.candidateId;' +
      'if(fileInput.files.length>0){' +
      'btn.textContent="简历上传中...";' +
      'try{await uploadResume(candidateId,fileInput.files[0])}catch(uploadErr){alert("候选人已提交，但简历上传失败："+uploadErr.message+"\\n\\n请稍后在投递记录中重新上传。")}' +
      '}' +
      'location.href="/portal/success?name="+encodeURIComponent(document.getElementById("aName").value.trim())+"&job="+encodeURIComponent("' + escapeHtml(job.title) + '");' +
      '}catch(err){alert(err.message);btn.disabled=false;btn.textContent="提交候选人"}' +
      '});' +
      '</script>',
  }));
});

// ====== 猎头门户：提交成功页 ======
router.get("/portal/success", requirePortalLogin, (req, res) => {
  const name = req.query.name || "";
  const job = req.query.job || "";
  res.send(portalPage({
    title: "投递成功",
    hunterName: req.hunterName,
    contentHtml: '<div class="success-box" style="margin-top:40px">' +
      '<h3>投递成功</h3>' +
      '<div class="muted" style="margin-bottom:12px">候选人 <b>' + escapeHtml(name) + '</b> 已成功投递到岗位 <b>' + escapeHtml(job) + '</b></div>' +
      '<div class="row" style="justify-content:center;gap:12px">' +
      '<a class="btn primary" href="/portal/jobs">继续投递</a>' +
      '<a class="btn" href="/portal/my">查看我的投递</a>' +
      '</div></div>',
  }));
});

// ====== 猎头门户：我的投递记录 ======
// 猎头候选人匹配：headhunterId 或 source 包含猎头名
function isHunterCandidate(c, hunterId, hunterName) {
  if (c.headhunterId && c.headhunterId === hunterId) return true;
  if (hunterName && c.source && c.source.includes("猎头：" + hunterName)) return true;
  return false;
}

router.get("/portal/my", requirePortalLogin, async (req, res) => {
  const d = await loadData();
  const hunter = d.headhunters.find(h => h.id === req.hunterId);
  const hunterName = hunter?.name || req.hunterName || "";
  const myCandidates = d.candidates.filter(c => isHunterCandidate(c, req.hunterId, hunterName));

  // 收集所有岗位用于筛选
  const jobTitles = [...new Set(myCandidates.map(c => c.jobTitle || "-").filter(Boolean))].sort();
  const jobFilterHtml = jobTitles.length > 1
    ? '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:16px">' +
      '<span class="muted" style="font-size:13px">筛选岗位：</span>' +
      '<button class="btn sm filter-btn active" data-job="all" onclick="filterJob(\'all\')" style="font-size:12px;padding:4px 12px;border-radius:20px">全部 (' + myCandidates.length + ')</button>' +
      jobTitles.map(jt => {
        const cnt = myCandidates.filter(c => (c.jobTitle || "-") === jt).length;
        return '<button class="btn sm filter-btn" data-job="' + escapeHtml(jt) + '" onclick="filterJob(\'' + escapeHtml(jt).replace(/'/g, "\\'") + '\')" style="font-size:12px;padding:4px 12px;border-radius:20px">' + escapeHtml(jt) + ' (' + cnt + ')</button>';
      }).join("") + '</div>'
    : '';

  // 进度步骤映射
  const stageMap = { "待筛选": 1, "简历筛选": 1, "面试中": 2, "待发Offer": 3, "Offer发放": 4, "入职": 5, "淘汰": -1 };

  const rows = myCandidates.map(c => {
    const stage = stageMap[c.status] || 1;
    const isElim = c.status === "淘汰";
    const isOffer = c.status === "Offer发放" || c.status === "入职";

    // 状态徽章颜色
    let badgeBg = "#f0ebff", badgeColor = "#7c5cfc";
    if (isElim) { badgeBg = "#fce4ec"; badgeColor = "#f54a45"; }
    else if (isOffer) { badgeBg = "#e8f5e9"; badgeColor = "#2e7d32"; }
    else if (c.status === "面试中") { badgeBg = "#e3f2fd"; badgeColor = "#1565c0"; }

    // 简易进度条
    const steps = ["简历筛选", "面试中", "待发Offer", "Offer/入职"];
    const progressHtml = '<div style="display:flex;align-items:center;gap:2px;margin-top:6px">' +
      steps.map((s, i) => {
        const stepNum = i + 1;
        const active = !isElim && stage >= stepNum;
        const bg = active ? "#7c5cfc" : "#e5e5e5";
        return '<div style="height:4px;flex:1;border-radius:2px;background:' + bg + '" title="' + escapeHtml(s) + '"></div>';
      }).join("") + '</div>';

    return '<tr data-job="' + escapeHtml(c.jobTitle || "-") + '">' +
      '<td><a href="/portal/my/' + c.id + '" style="color:#7c5cfc;font-weight:600;text-decoration:none">' + escapeHtml(c.name) + '</a></td>' +
      '<td>' + escapeHtml(c.phone || "-") + '</td>' +
      '<td>' + escapeHtml(c.jobTitle || "-") + '</td>' +
      '<td><span class="badge" style="background:' + badgeBg + ';color:' + badgeColor + ';font-weight:600">' + escapeHtml(c.status || "待筛选") + '</span>' + progressHtml + '</td>' +
      '<td class="muted">' + escapeHtml(c.createdAt ? toBjTime(c.createdAt).slice(0, 10) : "-") + '</td></tr>';
  }).join("") || '<tr id="emptyRow"><td colspan="5" style="text-align:center;color:#8f959e;padding:30px">暂无投递记录</td></tr>';

  const filterScript = '<script>' +
    'function filterJob(job){' +
    'document.querySelectorAll(".filter-btn").forEach(function(b){' +
    'b.classList.toggle("active",b.getAttribute("data-job")===job);' +
    'if(b.classList.contains("active")){b.style.background="#7c5cfc";b.style.color="#fff"}else{b.style.background="";b.style.color=""}' +
    '});' +
    'var rows=document.querySelectorAll("#myTable tbody tr[data-job]");var shown=0;' +
    'rows.forEach(function(r){' +
    'if(job==="all"||r.getAttribute("data-job")===job){r.style.display="";shown++}else{r.style.display="none"}' +
    '});' +
    'var empty=document.getElementById("filterEmpty");' +
    'if(shown===0){if(!empty){var tr=document.createElement("tr");tr.id="filterEmpty";tr.innerHTML=\'<td colspan="5" style="text-align:center;color:#8f959e;padding:30px">该岗位暂无投递记录</td>\';document.querySelector("#myTable tbody").appendChild(tr)}}' +
    'else{if(empty)empty.remove()}' +
    'var cnt=document.getElementById("totalCount");if(cnt)cnt.textContent=job==="all"?' + myCandidates.length + '+\" 位候选人\":shown+\" 位候选人\"' +
    '}' +
    'document.querySelectorAll(".filter-btn.active").forEach(function(b){b.style.background="#7c5cfc";b.style.color="#fff"});' +
    '</script>';

  res.send(portalPage({
    title: "我的投递",
    hunterName: req.hunterName,
    contentHtml: '<div class="row" style="margin-bottom:16px"><div style="font-weight:900;font-size:18px">我的投递记录</div><span class="spacer"></span><span class="muted" style="margin-right:12px" id="totalCount">' + myCandidates.length + ' 位候选人</span><a class="btn primary" href="/portal/jobs">去投递</a></div>' +
      jobFilterHtml +
      '<div class="card compact"><table id="myTable" class="data-table" style="width:100%"><thead><tr><th>候选人</th><th>手机</th><th>岗位</th><th>状态 / 进度</th><th>投递日期</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      filterScript,
  }));
});

// ====== 猎头门户：候选人进度详情 ======
router.get("/portal/my/:id", requirePortalLogin, async (req, res) => {
  const d = await loadData();
  const hunter = d.headhunters.find(h => h.id === req.hunterId);
  const hunterName = hunter?.name || req.hunterName || "";
  const c = d.candidates.find(x => x.id === req.params.id);

  if (!c || !isHunterCandidate(c, req.hunterId, hunterName)) {
    return res.send(portalPage({ title: "无权查看", hunterName: req.hunterName, contentHtml: '<div class="card" style="text-align:center;padding:40px"><div style="font-weight:700;color:#f54a45;margin-bottom:12px">无权查看此候选人</div><a class="btn" href="/portal/my">返回投递记录</a></div>' }));
  }

  // 进度步骤
  const allStages = [
    { key: "待筛选", label: "简历筛选", icon: "📄" },
    { key: "面试中", label: "面试中", icon: "💬" },
    { key: "待发Offer", label: "待发Offer", icon: "📋" },
    { key: "Offer发放", label: "Offer发放", icon: "🎉" },
    { key: "入职", label: "已入职", icon: "✅" },
  ];
  const isElim = c.status === "淘汰";
  const stageIdx = allStages.findIndex(s => s.key === c.status);
  const currentIdx = stageIdx >= 0 ? stageIdx : 0;

  const stepsHtml = '<div style="display:flex;align-items:flex-start;gap:0;margin:24px 0;position:relative">' +
    allStages.map((s, i) => {
      const done = !isElim && i <= currentIdx;
      const isCurrent = !isElim && i === currentIdx;
      const circBg = done ? "#7c5cfc" : "#e5e5e5";
      const circColor = done ? "#fff" : "#999";
      const labelWeight = isCurrent ? "700" : "400";
      const labelColor = isCurrent ? "#7c5cfc" : (done ? "#333" : "#999");
      const bar = i < allStages.length - 1
        ? '<div style="flex:1;height:3px;background:' + (done && !isElim && i < currentIdx ? "#7c5cfc" : "#e5e5e5") + ';align-self:center;margin:0 -2px;border-radius:2px"></div>'
        : '';
      return '<div style="display:flex;flex-direction:column;align-items:center;flex:0 0 auto;min-width:60px">' +
        '<div style="width:32px;height:32px;border-radius:50%;background:' + circBg + ';color:' + circColor + ';display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700">' + (done ? s.icon : (i + 1)) + '</div>' +
        '<div style="font-size:12px;margin-top:4px;color:' + labelColor + ';font-weight:' + labelWeight + '">' + s.label + '</div></div>' + bar;
    }).join("") + '</div>';

  const elimHtml = isElim ? '<div style="background:#fce4ec;color:#f54a45;padding:12px 16px;border-radius:10px;font-weight:600;margin-bottom:16px">该候选人未通过筛选</div>' : '';

  // 面试安排时间线（只显示时间和轮次，不显示面评内容）
  const schedules = d.interviewSchedules.filter(s => s.candidateId === c.id).sort((a, b) => (a.round - b.round));
  let schedHtml = '';
  if (schedules.length) {
    schedHtml = '<div class="divider"></div><div style="font-weight:700;margin-bottom:12px">面试安排</div>' +
      schedules.map(sc => {
        const reviews = d.interviews.filter(rv => rv.candidateId === c.id && rv.round === sc.round && rv.rating);
        const hasReview = reviews.length > 0;
        const statusText = hasReview ? "已完成" : (new Date(sc.scheduledAt) < new Date() ? "待面评" : "待面试");
        const statusBg = hasReview ? "#e8f5e9" : "#fff8e1";
        const statusClr = hasReview ? "#2e7d32" : "#e65100";
        return '<div class="card compact" style="margin-bottom:8px;padding:12px 16px">' +
          '<div class="row" style="flex-wrap:wrap;gap:8px">' +
          '<span style="font-weight:700">第' + sc.round + '轮</span>' +
          '<span class="muted">' + escapeHtml(sc.scheduledAt ? toBjTime(sc.scheduledAt).replace("T", " ").slice(0, 16) : "-") + '</span>' +
          '<span class="spacer"></span>' +
          '<span class="badge" style="background:' + statusBg + ';color:' + statusClr + ';font-weight:600">' + statusText + '</span>' +
          '</div></div>';
      }).join("");
  }

  // 动态记录（只显示基本操作，过滤掉面评相关）
  const events = d.events.filter(e => e.candidateId === c.id && !e.type?.includes("面评")).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  let eventsHtml = '';
  if (events.length) {
    eventsHtml = '<div class="divider"></div><div style="font-weight:700;margin-bottom:12px">动态</div>' +
      events.slice(0, 10).map(ev => {
        return '<div style="padding:6px 0;border-bottom:1px solid #f0f0f0;font-size:13px">' +
          '<span class="muted" style="margin-right:8px">' + escapeHtml(ev.createdAt ? toBjTime(ev.createdAt).slice(0, 10) : "") + '</span>' +
          escapeHtml(ev.message || ev.type || "") + '</div>';
      }).join("");
  }

  res.send(portalPage({
    title: c.name + " - 进度",
    hunterName: req.hunterName,
    contentHtml: '<div class="row" style="margin-bottom:16px"><a class="btn" href="/portal/my">&larr; 返回投递记录</a></div>' +
      '<div class="card">' +
      '<div style="font-weight:900;font-size:18px;margin-bottom:4px">' + escapeHtml(c.name) + '</div>' +
      '<div class="muted" style="margin-bottom:16px">' +
      escapeHtml(c.jobTitle || "-") +
      (c.phone ? ' · ' + escapeHtml(c.phone) : '') +
      ' · 投递于 ' + escapeHtml(c.createdAt ? toBjTime(c.createdAt).slice(0, 10) : "-") + '</div>' +
      elimHtml +
      stepsHtml +
      '<div class="divider"></div>' +
      '<div style="font-weight:700;margin-bottom:8px">当前状态</div>' +
      '<div style="font-size:15px;font-weight:600;color:#7c5cfc;margin-bottom:16px">' + escapeHtml(c.status || "待筛选") + '</div>' +
      schedHtml +
      eventsHtml +
      '</div>',
  }));
});

// ====== 猎头门户 API：提交候选人 ======
router.post("/portal/api/apply", requirePortalLogin, async (req, res) => {
  try {
    const d = await loadData();
    const hunter = d.headhunters.find(h => h.id === req.hunterId);
    if (!hunter) return res.status(401).json({ error: "猎头账号无效" });

    const name = String(req.body.name || "").trim();
    const phone = String(req.body.phone || "").trim();
    const email = String(req.body.email || "").trim();
    const jobId = String(req.body.jobId || "").trim();
    const note = String(req.body.note || "").trim();

    if (!name) return res.status(400).json({ error: "候选人姓名不能为空" });
    if (!phone) return res.status(400).json({ error: "手机号不能为空" });
    if (!jobId) return res.status(400).json({ error: "请选择岗位" });

    const job = d.jobs.find(x => x.id === jobId);
    if (!job) return res.status(400).json({ error: "岗位不存在" });

    const dup = findDuplicate(d.candidates, name, phone);
    if (dup) {
      return res.status(409).json({ error: "候选人疑似重复", duplicate: { id: dup.id, name: dup.name, phone: dup.phone, jobTitle: dup.jobTitle || "-", status: dup.status } });
    }

    const c = {
      id: rid("c"), name, phone, email, jobId,
      jobTitle: job.title, source: "猎头：" + hunter.name,
      note, tags: [],
      status: "待筛选",
      follow: { nextAction: "待联系", followAt: "", note: "" },
      headhunterId: hunter.id,
      createdAt: nowIso(), updatedAt: nowIso(),
    };
    d.candidates.unshift(c);
    pushEvent(d, { candidateId: c.id, type: "创建", message: "猎头「" + hunter.name + "」通过门户投递候选人：" + c.name + "（岗位：" + c.jobTitle + "）", actor: "猎头:" + hunter.name });
    await saveData(d);
    await notifyHrNewCandidate(d, c, job).catch(e => console.warn("[Notify] err:", e.message));
    res.json({ ok: true, candidateId: c.id });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || "提交失败") });
  }
});

// ====== 猎头门户 API：上传简历 ======
router.post("/portal/api/resume", requirePortalLogin, upload.single("resume"), async (req, res) => {
  try {
    const d = await loadData();
    const hunter = d.headhunters.find(h => h.id === req.hunterId);
    if (!hunter) return res.status(401).json({ error: "猎头账号无效" });

    const candidateId = String(req.body.candidateId || "").trim();
    if (!candidateId) return res.status(400).json({ error: "缺少 candidateId" });
    const c = d.candidates.find(x => x.id === candidateId);
    if (!c) return res.status(404).json({ error: "候选人不存在" });
    // 权限检查：headhunterId 匹配，或 source 包含猎头名称（兼容 Supabase 未同步 headhunterId 的情况）
    const isOwner = (c.headhunterId && c.headhunterId === hunter.id) || (c.source && c.source.includes("猎头：" + hunter.name));
    if (!isOwner) return res.status(403).json({ error: "无权操作此候选人" });

    const file = req.file;
    if (!file || !file.buffer || !file.buffer.length) return res.status(400).json({ error: "请选择简历文件" });

    await saveResumeSupabaseOrLocal(d, c.id, file, "猎头:" + hunter.name);
    await saveData(d);
    res.json({ ok: true, message: "简历上传成功" });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || "上传失败") });
  }
});

export { portalPage, requirePortalLogin };
export default router;
