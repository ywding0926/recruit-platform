import { Router } from "express";
import { requireLogin, requireAdmin } from "../auth.mjs";
import { loadData, saveData, nowIso, rid, toBjTime, deleteCandidateRelated } from "../db.mjs";
import { renderPage, escapeHtml, statusBadge, followupBadge, tagBadge, offerStatusBadge } from "../ui.mjs";
import { STATUS_COLS, STATUS_SET, INTERVIEW_ROUNDS, INTERVIEW_STATUS, INTERVIEW_RATING, INTERVIEW_RATING_LABEL, OFFER_STATUSES, PIPELINE_STAGES, OFFER_STAGE_STATUSES } from "../constants.mjs";
import { getVisibleJobIds, filterCandidatesByPermission, findDuplicate, pushEvent, notifyHrNewCandidate, saveResumeSupabaseOrLocal, refreshResumeUrlIfNeeded, toolbarHtml, cardQuickBtns } from "../helpers.mjs";
import { upload } from "../upload.mjs";
import { feishuEnabled } from "../feishu.mjs";

const router = Router();

// ====== 看板辅助函数 ======
function kanbanStatusHtml({ grouped, countsByCol, resumeMap }) {
  const cols = STATUS_COLS.map((col) => {
    const items = (grouped[col.key] || [])
      .map((c) => {
        const title = escapeHtml(c.name || "未命名");
        const jobTitle = escapeHtml(c.jobTitle || c.jobId || "-");
        const rm = resumeMap ? resumeMap.get(c.id) : null;
        const hasResume = rm && rm.url;
        const follow = followupBadge(c.follow);
        const tagsHtml = (c.tags || []).map((t) => tagBadge(t)).join(" ");
        return '<div class="carditem" onclick="window.open(\'/candidates/' + escapeHtml(c.id) + '\',\'_blank\')">' +
          '<div class="cardtitle"><span>' + title + '</span>' + (hasResume ? '<span class="badge status-blue" style="font-size:10px;padding:2px 6px">📎</span>' : '') + '</div>' +
          '<div class="cardsub">' + jobTitle + ' ' + statusBadge(c.status) + '</div>' +
          (follow ? '<div style="margin-top:6px">' + follow + '</div>' : '') +
          (tagsHtml ? '<div style="margin-top:4px">' + tagsHtml + '</div>' : '') +
          cardQuickBtns(c.id, c.status) +
          '</div>';
      })
      .join("");
    const cnt = countsByCol[col.key] || 0;
    return '<div class="col"><div class="colhead"><div class="coltitle">' + escapeHtml(col.name) + '</div><div class="colcount">' + cnt + '</div></div><div class="colbody">' + (items || '<div class="muted" style="text-align:center;padding:20px 0">暂无</div>') + '</div></div>';
  }).join("");

  return '<div class="card compact"><div class="row"><div style="font-weight:900;font-size:16px">候选人看板</div><span class="muted">（点击卡片打开右侧抽屉快速查看）</span><span class="spacer"></span><div class="seg" style="display:inline-flex"><button onclick="setBoardView(\'pipeline\')">流水线</button><button class="active" onclick="setBoardView(\'status\')">按状态</button></div></div><div class="divider"></div><div class="kanban kanban-status">' + cols + '</div></div>' +
    '<div id="drawerMask" class="drawerMask" onclick="closeDrawer()"></div>' +
    '<div id="drawer" class="drawer">' +
    '<div class="drawerHeader"><div><div id="drawerTitle" class="drawerTitle">候选人详情</div><div id="drawerSub" class="muted mono"></div></div><button class="drawerClose" onclick="closeDrawer()">&#10005;</button></div>' +
    '<div class="drawerBody">' +
    '<div class="tabs">' +
    '<button class="tab active" data-tab="info" onclick="switchTab(\'info\')">信息</button>' +
    '<button class="tab" data-tab="schedule" onclick="switchTab(\'schedule\')">面试安排</button>' +
    '<button class="tab" data-tab="resume" onclick="switchTab(\'resume\')">简历</button>' +
    '<button class="tab" data-tab="review" onclick="switchTab(\'review\')">面评</button>' +
    '<button class="tab" data-tab="activity" onclick="switchTab(\'activity\')">动态</button>' +
    '</div>' +
    '<div class="tabpanels">' +
    '<div class="tabpanel active" id="panel-info"><div class="card compact" style="padding:12px"><div class="row"><span class="pill"><span class="muted">状态</span><b id="cStatus"></b></span><span class="pill"><span class="muted">岗位</span><b id="cJob"></b></span><span class="pill"><span class="muted">来源</span><b id="cSource"></b></span><span class="spacer"></span><a class="btn" id="fullOpenBtn">打开完整详情</a></div><div class="divider"></div><div class="field"><label>状态流转</label><div class="row"><select id="statusSelect" style="max-width:220px"></select><button class="btn primary" onclick="updateStatus()">更新状态</button></div></div><div class="divider"></div><div style="font-weight:900;margin-bottom:8px">编辑候选人信息</div><div class="field"><label>姓名</label><input id="editName" /></div><div class="field"><label>手机</label><input id="editPhone" /></div><div class="field"><label>邮箱</label><input id="editEmail" /></div><div class="field"><label>来源</label><input id="editSource" /></div><div class="field"><label>推荐人</label><input id="editReferrer" placeholder="内推人姓名（选填）" /></div><div class="field"><label>备注</label><textarea id="editNote" rows="3"></textarea></div><button class="btn" onclick="saveCandidate()">保存信息</button></div></div>' +
    '<div class="tabpanel" id="panel-schedule"><div class="card compact" style="padding:12px"><div class="row"><div style="font-weight:900">面试安排</div></div><div class="divider"></div><div class="row" style="gap:10px"><div class="field" style="min-width:120px"><label>轮次</label><select id="scRound"></select></div><div class="field" style="min-width:220px"><label>面试时间</label><input id="scAt" type="datetime-local" /></div></div><div class="field"><label>面试官</label><input id="scInterviewers" list="board-interviewer-list" placeholder="张三 / 李四" /></div><div class="field"><label>会议链接</label><input id="scLink" /></div><div class="field"><label>地点/形式</label><input id="scLocation" /></div><div class="field"><label>同步状态</label><select id="scSyncStatus"></select></div>' +
    '<button class="btn primary" onclick="saveSchedule()">保存面试安排</button><div class="divider"></div><div style="font-weight:900;margin-bottom:8px">已安排</div><div id="scheduleList" class="muted">暂无</div></div></div>' +
    '<div class="tabpanel" id="panel-resume"><div class="card compact" style="padding:12px"><div class="row"><div style="font-weight:900">简历</div><span class="spacer"></span><a class="btn" id="resumeOpenBtn" target="_blank" rel="noreferrer">新窗口打开</a></div><div class="divider"></div><form id="resumeUploadForm" enctype="multipart/form-data"><div class="row"><input type="file" name="resume" accept=".pdf,.png,.jpg,.jpeg,.webp" /><button class="btn primary" type="submit">上传</button></div></form><div class="divider"></div><div id="resumeArea" class="muted">暂无简历</div></div></div>' +
    '<div class="tabpanel" id="panel-review"><div class="card compact" style="padding:12px"><div class="row"><div style="font-weight:900">面试评价</div></div><div class="divider"></div><div class="row" style="gap:10px"><div class="field" style="min-width:120px"><label>轮次</label><select id="rvRound"></select></div><div class="field" style="min-width:160px"><label>面试结论</label><select id="rvConclusion"></select></div><div class="field" style="min-width:120px"><label>评级</label><select id="rvRating"></select></div></div><div class="field"><label>Pros</label><textarea id="rvPros" rows="3"></textarea></div><div class="field"><label>Cons</label><textarea id="rvCons" rows="3"></textarea></div><div class="field"><label>下一轮考察点</label><textarea id="rvFocusNext" rows="3"></textarea></div><button class="btn primary" onclick="addReview()">新增/更新面评</button><div class="divider"></div><div id="reviewList" class="muted">暂无面评</div></div></div>' +
    '<div class="tabpanel" id="panel-activity"><div class="card compact" style="padding:12px"><div style="font-weight:900">动态</div><div class="divider"></div><div id="activityList" class="muted">暂无动态</div></div></div>' +
    '</div></div></div>' +
    '<script>' +
    'var CURRENT_ID=null;' +
    'function switchTab(t){document.querySelectorAll(".tab").forEach(function(e){e.classList.toggle("active",e.dataset.tab===t)});document.querySelectorAll(".tabpanel").forEach(function(p){p.classList.remove("active")});document.getElementById("panel-"+t).classList.add("active")}' +
    'function openDrawer(){document.getElementById("drawerMask").classList.add("open");document.getElementById("drawer").classList.add("open")}' +
    'function closeDrawer(){document.getElementById("drawerMask").classList.remove("open");document.getElementById("drawer").classList.remove("open");CURRENT_ID=null}' +
    'async function openCandidate(id){CURRENT_ID=id;openDrawer();switchTab("info");await loadCandidate(id)}' +
    'function fillStatusSelect(current){var sel=document.getElementById("statusSelect");sel.innerHTML=' + JSON.stringify(STATUS_COLS) + '.map(function(s){return \'<option value="\'+s.key+\'" \'+(s.key===current?"selected":"")+\'>\'+s.name+\'</option>\'}).join("")}' +
    'function fillScheduleSelects(){var r=document.getElementById("scRound");r.innerHTML=' + JSON.stringify(INTERVIEW_ROUNDS) + '.map(function(x){return \'<option value="\'+x+\'">第\'+x+\'轮</option>\'}).join("");var st=document.getElementById("scSyncStatus");st.innerHTML=["（不同步）"].concat(' + JSON.stringify(INTERVIEW_STATUS) + ').map(function(x){return \'<option value="\'+x+\'">\'+x+\'</option>\'}).join("")}fillScheduleSelects();' +
    'var RATING_LABEL=' + JSON.stringify(INTERVIEW_RATING_LABEL) + ';function fillReviewSelects(){var r=document.getElementById("rvRound");r.innerHTML=' + JSON.stringify(INTERVIEW_ROUNDS) + '.map(function(x){return \'<option value="\'+x+\'">第\'+x+\'轮</option>\'}).join("");var st=document.getElementById("rvConclusion");st.innerHTML=["通过","不通过","Pending"].map(function(x){return \'<option value="\'+x+\'">\'+x+\'</option>\'}).join("");var ra=document.getElementById("rvRating");ra.innerHTML=' + JSON.stringify(INTERVIEW_RATING) + '.map(function(x){return \'<option value="\'+x+\'">\'+( RATING_LABEL[x]||x)+\'</option>\'}).join("")}fillReviewSelects();' +
    'function esc(s){return String(s||"").replace(/</g,"&lt;").replace(/>/g,"&gt;")}' +
    'function nl2br(s){return esc(s).replace(/\\n/g,"<br/>")}' +
    'var _boardInterviewers=[];fetch("/api/interviewers").then(function(r){return r.json()}).then(function(d){_boardInterviewers=d||[]}).catch(function(){});' +
    'function boardIvAvatar(name,sz){sz=sz||20;var iv=_boardInterviewers.find(function(u){return u.name===name});var colors=["#7c5cfc","#3370ff","#f5222d","#fa8c16","#52c41a","#4e7bf6"];var ci=name.charCodeAt(0)%colors.length;if(iv&&iv.avatar)return \'<img src="\'+iv.avatar+\'" style="width:\'+sz+\'px;height:\'+sz+\'px;border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:3px">\';return \'<span style="display:inline-flex;align-items:center;justify-content:center;width:\'+sz+\'px;height:\'+sz+\'px;border-radius:50%;background:\'+colors[ci]+\';color:#fff;font-size:\'+(sz*0.45)+\'px;font-weight:700;vertical-align:middle;margin-right:3px">\'+esc(name.slice(0,1))+\'</span>\'}' +
    'function renderIvLine(ivStr){if(!ivStr||ivStr==="-")return \'<span class="muted">-</span>\';var names=ivStr.split(/[\\/,]/).map(function(n){return n.trim()}).filter(Boolean);return names.map(function(n){return boardIvAvatar(n,20)+\'<span style="vertical-align:middle">\'+esc(n)+\'</span>\'}).join(\'<span style="margin:0 4px;color:#ccc">|</span>\')}' +
    'function renderResumeInline(resume){var area=document.getElementById("resumeArea");var btn=document.getElementById("resumeOpenBtn");if(!resume||!resume.url){area.innerHTML=\'<div class="muted">暂无简历</div>\';btn.style.display="none";return}btn.style.display="inline-flex";btn.href=resume.url;var lower=(resume.originalName||resume.filename||"").toLowerCase();if(lower.endsWith(".pdf")){area.innerHTML=\'<iframe src="\'+resume.url+\'" style="width:100%;height:70vh;border:1px solid rgba(237,233,254,.95);border-radius:14px;background:#fff"></iframe>\'}else if(lower.endsWith(".png")||lower.endsWith(".jpg")||lower.endsWith(".jpeg")||lower.endsWith(".webp")){area.innerHTML=\'<img src="\'+resume.url+\'" style="max-width:100%;border-radius:14px" />\'}else{area.innerHTML=\'<div class="muted">不支持内嵌预览</div>\'}}' +
    'function renderSchedules(list){var box=document.getElementById("scheduleList");if(!list||!list.length){box.innerHTML=\'<div class="muted">暂无</div>\';return}box.innerHTML=list.map(function(x){return \'<div class="card compact" style="padding:12px;border-radius:14px;margin-bottom:10px"><div class="row"><b>第\'+x.round+\'轮</b><span class="pill"><span class="muted">时间</span><b>\'+esc(x.scheduledAt||"-")+\'</b></span><span class="spacer"></span><span class="muted">\'+esc(x.updatedAt||x.createdAt||"")+\'</span></div><div class="divider"></div><div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap"><span class="muted">面试官：</span>\'+renderIvLine(x.interviewers)+\'</div><div class="muted">地点：\'+esc(x.location||"-")+\'</div></div>\'}).join("")}' +
    'function renderReviews(list){var box=document.getElementById("reviewList");if(!list||!list.length){box.innerHTML=\'<div class="muted">暂无面评</div>\';return}box.innerHTML=list.map(function(x){return \'<div class="card compact" style="padding:12px;border-radius:14px;margin-bottom:10px"><div class="row"><b>第\'+x.round+\'轮</b><span class="pill"><span class="muted">进度</span><b>\'+esc(x.status||"-")+\'</b></span><span class="pill"><span class="muted">评级</span><b>\'+esc(x.rating||"-")+\'</b></span></div><div class="divider"></div><div style="margin-bottom:6px"><b>Pros</b><div class="muted">\'+nl2br(x.pros||"-")+\'</div></div><div style="margin-bottom:6px"><b>Cons</b><div class="muted">\'+nl2br(x.cons||"-")+\'</div></div><div><b>下一轮考察</b><div class="muted">\'+nl2br(x.focusNext||"-")+\'</div></div></div>\'}).join("")}' +
    'function renderActivity(list){var box=document.getElementById("activityList");if(!list||!list.length){box.innerHTML=\'<div class="muted">暂无</div>\';return}box.innerHTML=\'<div class="timeline">\'+list.map(function(e){return \'<div class="titem"><div class="tmeta"><b>\'+esc(e.actor||"系统")+\'</b><span class="badge status-gray" style="font-size:11px">\'+esc(e.type||"-")+\'</span><span class="muted">\'+esc(e.createdAt||"")+\'</span></div><div class="tmsg">\'+nl2br(e.message||"")+\'</div></div>\'}).join("")+\'</div>\'}' +
    'async function loadCandidate(id){var res=await fetch("/api/candidates/"+encodeURIComponent(id));if(!res.ok){document.getElementById("drawerTitle").textContent="候选人不存在";return}var data=await res.json();document.getElementById("drawerTitle").textContent=data.name||"未命名";document.getElementById("drawerSub").textContent="ID: "+(data.id||"");document.getElementById("cStatus").textContent=data.status||"-";document.getElementById("cJob").textContent=data.jobTitle||data.jobId||"-";document.getElementById("cSource").textContent=data.source||"-";var fromParam=new URLSearchParams(location.search).get("jobId");document.getElementById("fullOpenBtn").href="/candidates/"+encodeURIComponent(data.id)+(fromParam?"?from=job:"+encodeURIComponent(fromParam):"?from=board");fillStatusSelect(data.status||"待筛选");document.getElementById("editName").value=data.name||"";document.getElementById("editPhone").value=data.phone||"";document.getElementById("editEmail").value=data.email||"";document.getElementById("editSource").value=data.source||"";document.getElementById("editReferrer").value=data.referrer||"";document.getElementById("editNote").value=data.note||"";renderSchedules(data.schedules||[]);renderResumeInline(data.resume||null);renderReviews(data.reviews||[]);renderActivity(data.events||[]);var f=document.getElementById("resumeUploadForm");f.onsubmit=async function(e){e.preventDefault();if(!CURRENT_ID)return;var fd=new FormData(f);var r=await fetch("/api/candidates/"+encodeURIComponent(CURRENT_ID)+"/resume",{method:"POST",body:fd});if(r.ok){await loadCandidate(CURRENT_ID);switchTab("resume")}else{alert("上传失败："+await r.text())}}}' +
    'async function updateStatus(){if(!CURRENT_ID)return;var v=document.getElementById("statusSelect").value;var res=await fetch("/api/candidates/"+encodeURIComponent(CURRENT_ID)+"/status",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:v})});if(res.ok)location.reload();else alert("更新失败")}' +
    'async function saveCandidate(){if(!CURRENT_ID)return;var payload={name:document.getElementById("editName").value,phone:document.getElementById("editPhone").value,email:document.getElementById("editEmail").value,source:document.getElementById("editSource").value,referrer:document.getElementById("editReferrer").value,note:document.getElementById("editNote").value};var res=await fetch("/api/candidates/"+encodeURIComponent(CURRENT_ID),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});if(res.ok){await loadCandidate(CURRENT_ID);location.reload()}else alert("保存失败")}' +
    'async function saveSchedule(){if(!CURRENT_ID)return;var sc=document.getElementById("scSyncCalendar");var payload={round:Number(document.getElementById("scRound").value),scheduledAt:document.getElementById("scAt").value,interviewers:document.getElementById("scInterviewers").value,link:document.getElementById("scLink").value,location:document.getElementById("scLocation").value,syncStatus:document.getElementById("scSyncStatus").value,syncCalendar:sc&&sc.checked?"on":"off"};var res=await fetch("/api/candidates/"+encodeURIComponent(CURRENT_ID)+"/schedule",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});if(res.ok){await loadCandidate(CURRENT_ID);switchTab("schedule");location.reload()}else alert("保存失败")}' +
    'async function addReview(){if(!CURRENT_ID)return;var payload={round:Number(document.getElementById("rvRound").value),conclusion:document.getElementById("rvConclusion").value,rating:document.getElementById("rvRating").value,pros:document.getElementById("rvPros").value,cons:document.getElementById("rvCons").value,focusNext:document.getElementById("rvFocusNext").value};var res=await fetch("/api/candidates/"+encodeURIComponent(CURRENT_ID)+"/reviews",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});if(res.ok){document.getElementById("rvPros").value="";document.getElementById("rvCons").value="";document.getElementById("rvFocusNext").value="";await loadCandidate(CURRENT_ID);switchTab("review");location.reload()}else alert("保存失败")}' +
    'async function quickStatus(id,newStatus){var btn=event.target;btn.disabled=true;btn.style.opacity="0.5";try{var res=await fetch("/api/candidates/"+encodeURIComponent(id)+"/status",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:newStatus})});if(res.ok)location.reload();else{btn.disabled=false;btn.style.opacity="1";alert("操作失败")}}catch(e){btn.disabled=false;btn.style.opacity="1";alert("网络错误")}}' +
    'function setBoardView(v){if(v==="pipeline")location.href="/candidates/board";else location.href="/candidates/board?view=status"}' +
    '</script>';
}

function kanbanHtml({ grouped, countsByCol, resumeMap }) {
  const cols = PIPELINE_STAGES.map((stage) => {
    const stageCount = stage.statuses.reduce((sum, s) => sum + (countsByCol[s] || 0), 0);
    const stageItems = [];
    stage.statuses.forEach(s => { if (grouped[s]) stageItems.push(...grouped[s]); });

    const items = stageItems
      .map((c) => {
        const title = escapeHtml(c.name || "未命名");
        const jobTitle = escapeHtml(c.jobTitle || c.jobId || "-");
        const rm = resumeMap ? resumeMap.get(c.id) : null;
        const hasResume = rm && rm.url;
        const follow = followupBadge(c.follow);
        const tagsHtml = (c.tags || []).map((t) => tagBadge(t)).join(" ");
        const avatarLetter = escapeHtml((c.name || "?").slice(0, 1));

        return '<div class="carditem" onclick="window.open(\'/candidates/' + escapeHtml(c.id) + '\',\'_blank\')">' +
          '<div class="cardtitle"><div class="card-avatar" style="background:' + stage.color + '">' + avatarLetter + '</div><span>' + title + '</span>' + (hasResume ? '<span class="badge status-blue" style="font-size:10px;padding:2px 6px">📎</span>' : '') + '</div>' +
          '<div class="cardsub">' +
          '<span class="card-meta">' + jobTitle + '</span>' +
          statusBadge(c.status) +
          '</div>' +
          (follow ? '<div style="margin-top:6px">' + follow + '</div>' : '') +
          (tagsHtml ? '<div style="margin-top:4px">' + tagsHtml + '</div>' : '') +
          cardQuickBtns(c.id, c.status) +
          '</div>';
      })
      .join("");

    return '<div class="col"><div class="colhead" style="border-left:3px solid ' + stage.color + '"><div class="coltitle"><span>' + stage.icon + '</span> ' + escapeHtml(stage.name) + '</div><div class="colcount">' + stageCount + '</div></div><div class="colbody">' + (items || '<div class="muted" style="text-align:center;padding:20px 0">暂无候选人</div>') + '</div></div>';
  }).join("");

  return '<div class="card compact"><div class="row"><div style="font-weight:900;font-size:16px">候选人看板</div><span class="muted">（点击卡片打开右侧抽屉快速查看）</span><span class="spacer"></span><div class="seg" style="display:inline-flex"><button class="active" onclick="setBoardView(\'pipeline\')">流水线</button><button onclick="location.href=\'/candidates/board?view=status\'">按状态</button></div></div><div class="divider"></div><div class="kanban">' + cols + '</div></div>' +
    '<div id="drawerMask" class="drawerMask" onclick="closeDrawer()"></div>' +
    '<div id="drawer" class="drawer">' +
    '<div class="drawerHeader"><div><div id="drawerTitle" class="drawerTitle">候选人详情</div><div id="drawerSub" class="muted mono"></div></div><button class="drawerClose" onclick="closeDrawer()">&#10005;</button></div>' +
    '<div class="drawerBody">' +
    '<div class="tabs">' +
    '<button class="tab active" data-tab="info" onclick="switchTab(\'info\')">信息</button>' +
    '<button class="tab" data-tab="schedule" onclick="switchTab(\'schedule\')">面试安排</button>' +
    '<button class="tab" data-tab="resume" onclick="switchTab(\'resume\')">简历</button>' +
    '<button class="tab" data-tab="review" onclick="switchTab(\'review\')">面评</button>' +
    '<button class="tab" data-tab="activity" onclick="switchTab(\'activity\')">动态</button>' +
    '</div>' +
    '<div class="tabpanels">' +
    '<div class="tabpanel active" id="panel-info"><div class="card compact" style="padding:12px"><div class="row"><span class="pill"><span class="muted">状态</span><b id="cStatus"></b></span><span class="pill"><span class="muted">岗位</span><b id="cJob"></b></span><span class="pill"><span class="muted">来源</span><b id="cSource"></b></span><span class="spacer"></span><a class="btn" id="fullOpenBtn">打开完整详情</a></div><div class="divider"></div><div class="field"><label>状态流转</label><div class="row"><select id="statusSelect" style="max-width:220px"></select><button class="btn primary" onclick="updateStatus()">更新状态</button></div></div><div class="divider"></div><div style="font-weight:900;margin-bottom:8px">编辑候选人信息</div><div class="field"><label>姓名</label><input id="editName" /></div><div class="field"><label>手机</label><input id="editPhone" /></div><div class="field"><label>邮箱</label><input id="editEmail" /></div><div class="field"><label>来源</label><input id="editSource" /></div><div class="field"><label>推荐人</label><input id="editReferrer" placeholder="内推人姓名（选填）" /></div><div class="field"><label>备注</label><textarea id="editNote" rows="3"></textarea></div><button class="btn" onclick="saveCandidate()">保存信息</button></div></div>' +
    '<div class="tabpanel" id="panel-schedule"><div class="card compact" style="padding:12px"><div class="row"><div style="font-weight:900">面试安排</div></div><div class="divider"></div><div class="row" style="gap:10px"><div class="field" style="min-width:120px"><label>轮次</label><select id="scRound"></select></div><div class="field" style="min-width:220px"><label>面试时间</label><input id="scAt" type="datetime-local" /></div></div><div class="field"><label>面试官</label><input id="scInterviewers" list="board-interviewer-list" placeholder="张三 / 李四" /></div><div class="field"><label>会议链接</label><input id="scLink" /></div><div class="field"><label>地点/形式</label><input id="scLocation" /></div><div class="field"><label>同步状态</label><select id="scSyncStatus"></select></div>' +
    '<button class="btn primary" onclick="saveSchedule()">保存面试安排</button><div class="divider"></div><div style="font-weight:900;margin-bottom:8px">已安排</div><div id="scheduleList" class="muted">暂无</div></div></div>' +
    '<div class="tabpanel" id="panel-resume"><div class="card compact" style="padding:12px"><div class="row"><div style="font-weight:900">简历</div><span class="spacer"></span><a class="btn" id="resumeOpenBtn" target="_blank" rel="noreferrer">新窗口打开</a></div><div class="divider"></div><form id="resumeUploadForm" enctype="multipart/form-data"><div class="row"><input type="file" name="resume" accept=".pdf,.png,.jpg,.jpeg,.webp" /><button class="btn primary" type="submit">上传</button></div></form><div class="divider"></div><div id="resumeArea" class="muted">暂无简历</div></div></div>' +
    '<div class="tabpanel" id="panel-review"><div class="card compact" style="padding:12px"><div class="row"><div style="font-weight:900">面试评价</div></div><div class="divider"></div><div class="row" style="gap:10px"><div class="field" style="min-width:120px"><label>轮次</label><select id="rvRound"></select></div><div class="field" style="min-width:160px"><label>面试结论</label><select id="rvConclusion"></select></div><div class="field" style="min-width:120px"><label>评级</label><select id="rvRating"></select></div></div><div class="field"><label>Pros</label><textarea id="rvPros" rows="3"></textarea></div><div class="field"><label>Cons</label><textarea id="rvCons" rows="3"></textarea></div><div class="field"><label>下一轮考察点</label><textarea id="rvFocusNext" rows="3"></textarea></div><button class="btn primary" onclick="addReview()">新增/更新面评</button><div class="divider"></div><div id="reviewList" class="muted">暂无面评</div></div></div>' +
    '<div class="tabpanel" id="panel-activity"><div class="card compact" style="padding:12px"><div style="font-weight:900">动态</div><div class="divider"></div><div id="activityList" class="muted">暂无动态</div></div></div>' +
    '</div></div></div>' +
    '<script>' +
    'var CURRENT_ID=null;' +
    'function switchTab(t){document.querySelectorAll(".tab").forEach(function(e){e.classList.toggle("active",e.dataset.tab===t)});document.querySelectorAll(".tabpanel").forEach(function(p){p.classList.remove("active")});document.getElementById("panel-"+t).classList.add("active")}' +
    'function openDrawer(){document.getElementById("drawerMask").classList.add("open");document.getElementById("drawer").classList.add("open")}' +
    'function closeDrawer(){document.getElementById("drawerMask").classList.remove("open");document.getElementById("drawer").classList.remove("open");CURRENT_ID=null}' +
    'async function openCandidate(id){CURRENT_ID=id;openDrawer();switchTab("info");await loadCandidate(id)}' +
    'function fillStatusSelect(current){var sel=document.getElementById("statusSelect");sel.innerHTML=' + JSON.stringify(STATUS_COLS) + '.map(function(s){return \'<option value="\'+s.key+\'" \'+(s.key===current?"selected":"")+\'>\'+s.name+\'</option>\'}).join("")}' +
    'function fillScheduleSelects(){var r=document.getElementById("scRound");r.innerHTML=' + JSON.stringify(INTERVIEW_ROUNDS) + '.map(function(x){return \'<option value="\'+x+\'">第\'+x+\'轮</option>\'}).join("");var st=document.getElementById("scSyncStatus");st.innerHTML=["（不同步）"].concat(' + JSON.stringify(INTERVIEW_STATUS) + ').map(function(x){return \'<option value="\'+x+\'">\'+x+\'</option>\'}).join("")}fillScheduleSelects();' +
    'var RATING_LABEL=' + JSON.stringify(INTERVIEW_RATING_LABEL) + ';function fillReviewSelects(){var r=document.getElementById("rvRound");r.innerHTML=' + JSON.stringify(INTERVIEW_ROUNDS) + '.map(function(x){return \'<option value="\'+x+\'">第\'+x+\'轮</option>\'}).join("");var st=document.getElementById("rvConclusion");st.innerHTML=["通过","不通过","Pending"].map(function(x){return \'<option value="\'+x+\'">\'+x+\'</option>\'}).join("");var ra=document.getElementById("rvRating");ra.innerHTML=' + JSON.stringify(INTERVIEW_RATING) + '.map(function(x){return \'<option value="\'+x+\'">\'+( RATING_LABEL[x]||x)+\'</option>\'}).join("")}fillReviewSelects();' +
    'function esc(s){return String(s||"").replace(/</g,"&lt;").replace(/>/g,"&gt;")}' +
    'function nl2br(s){return esc(s).replace(/\\n/g,"<br/>")}' +
    'var _boardInterviewers=[];fetch("/api/interviewers").then(function(r){return r.json()}).then(function(d){_boardInterviewers=d||[]}).catch(function(){});' +
    'function boardIvAvatar(name,sz){sz=sz||20;var iv=_boardInterviewers.find(function(u){return u.name===name});var colors=["#7c5cfc","#3370ff","#f5222d","#fa8c16","#52c41a","#4e7bf6"];var ci=name.charCodeAt(0)%colors.length;if(iv&&iv.avatar)return \'<img src="\'+iv.avatar+\'" style="width:\'+sz+\'px;height:\'+sz+\'px;border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:3px">\';return \'<span style="display:inline-flex;align-items:center;justify-content:center;width:\'+sz+\'px;height:\'+sz+\'px;border-radius:50%;background:\'+colors[ci]+\';color:#fff;font-size:\'+(sz*0.45)+\'px;font-weight:700;vertical-align:middle;margin-right:3px">\'+esc(name.slice(0,1))+\'</span>\'}' +
    'function renderIvLine(ivStr){if(!ivStr||ivStr==="-")return \'<span class="muted">-</span>\';var names=ivStr.split(/[\\/,]/).map(function(n){return n.trim()}).filter(Boolean);return names.map(function(n){return boardIvAvatar(n,20)+\'<span style="vertical-align:middle">\'+esc(n)+\'</span>\'}).join(\'<span style="margin:0 4px;color:#ccc">|</span>\')}' +
    'function renderResumeInline(resume){var area=document.getElementById("resumeArea");var btn=document.getElementById("resumeOpenBtn");if(!resume||!resume.url){area.innerHTML=\'<div class="muted">暂无简历</div>\';btn.style.display="none";return}btn.style.display="inline-flex";btn.href=resume.url;var lower=(resume.originalName||resume.filename||"").toLowerCase();if(lower.endsWith(".pdf")){area.innerHTML=\'<iframe src="\'+resume.url+\'" style="width:100%;height:70vh;border:1px solid rgba(237,233,254,.95);border-radius:14px;background:#fff"></iframe>\'}else if(lower.endsWith(".png")||lower.endsWith(".jpg")||lower.endsWith(".jpeg")||lower.endsWith(".webp")){area.innerHTML=\'<img src="\'+resume.url+\'" style="max-width:100%;border-radius:14px" />\'}else{area.innerHTML=\'<div class="muted">不支持内嵌预览</div>\'}}' +
    'function renderSchedules(list){var box=document.getElementById("scheduleList");if(!list||!list.length){box.innerHTML=\'<div class="muted">暂无</div>\';return}box.innerHTML=list.map(function(x){return \'<div class="card compact" style="padding:12px;border-radius:14px;margin-bottom:10px"><div class="row"><b>第\'+x.round+\'轮</b><span class="pill"><span class="muted">时间</span><b>\'+esc(x.scheduledAt||"-")+\'</b></span><span class="spacer"></span><span class="muted">\'+esc(x.updatedAt||x.createdAt||"")+\'</span></div><div class="divider"></div><div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap"><span class="muted">面试官：</span>\'+renderIvLine(x.interviewers)+\'</div><div class="muted">地点：\'+esc(x.location||"-")+\'</div></div>\'}).join("")}' +
    'function renderReviews(list){var box=document.getElementById("reviewList");if(!list||!list.length){box.innerHTML=\'<div class="muted">暂无面评</div>\';return}box.innerHTML=list.map(function(x){return \'<div class="card compact" style="padding:12px;border-radius:14px;margin-bottom:10px"><div class="row"><b>第\'+x.round+\'轮</b><span class="pill"><span class="muted">进度</span><b>\'+esc(x.status||"-")+\'</b></span><span class="pill"><span class="muted">评级</span><b>\'+esc(x.rating||"-")+\'</b></span></div><div class="divider"></div><div style="margin-bottom:6px"><b>Pros</b><div class="muted">\'+nl2br(x.pros||"-")+\'</div></div><div style="margin-bottom:6px"><b>Cons</b><div class="muted">\'+nl2br(x.cons||"-")+\'</div></div><div><b>下一轮考察</b><div class="muted">\'+nl2br(x.focusNext||"-")+\'</div></div></div>\'}).join("")}' +
    'function renderActivity(list){var box=document.getElementById("activityList");if(!list||!list.length){box.innerHTML=\'<div class="muted">暂无</div>\';return}box.innerHTML=\'<div class="timeline">\'+list.map(function(e){return \'<div class="titem"><div class="tmeta"><b>\'+esc(e.actor||"系统")+\'</b><span class="badge status-gray" style="font-size:11px">\'+esc(e.type||"-")+\'</span><span class="muted">\'+esc(e.createdAt||"")+\'</span></div><div class="tmsg">\'+nl2br(e.message||"")+\'</div></div>\'}).join("")+\'</div>\'}' +
    'async function loadCandidate(id){var res=await fetch("/api/candidates/"+encodeURIComponent(id));if(!res.ok){document.getElementById("drawerTitle").textContent="候选人不存在";return}var data=await res.json();document.getElementById("drawerTitle").textContent=data.name||"未命名";document.getElementById("drawerSub").textContent="ID: "+(data.id||"");document.getElementById("cStatus").textContent=data.status||"-";document.getElementById("cJob").textContent=data.jobTitle||data.jobId||"-";document.getElementById("cSource").textContent=data.source||"-";var fromParam=new URLSearchParams(location.search).get("jobId");document.getElementById("fullOpenBtn").href="/candidates/"+encodeURIComponent(data.id)+(fromParam?"?from=job:"+encodeURIComponent(fromParam):"?from=board");fillStatusSelect(data.status||"待筛选");document.getElementById("editName").value=data.name||"";document.getElementById("editPhone").value=data.phone||"";document.getElementById("editEmail").value=data.email||"";document.getElementById("editSource").value=data.source||"";document.getElementById("editReferrer").value=data.referrer||"";document.getElementById("editNote").value=data.note||"";renderSchedules(data.schedules||[]);renderResumeInline(data.resume||null);renderReviews(data.reviews||[]);renderActivity(data.events||[]);var f=document.getElementById("resumeUploadForm");f.onsubmit=async function(e){e.preventDefault();if(!CURRENT_ID)return;var fd=new FormData(f);var r=await fetch("/api/candidates/"+encodeURIComponent(CURRENT_ID)+"/resume",{method:"POST",body:fd});if(r.ok){await loadCandidate(CURRENT_ID);switchTab("resume")}else{alert("上传失败："+await r.text())}}}' +
    'async function updateStatus(){if(!CURRENT_ID)return;var v=document.getElementById("statusSelect").value;var res=await fetch("/api/candidates/"+encodeURIComponent(CURRENT_ID)+"/status",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:v})});if(res.ok)location.reload();else alert("更新失败")}' +
    'async function saveCandidate(){if(!CURRENT_ID)return;var payload={name:document.getElementById("editName").value,phone:document.getElementById("editPhone").value,email:document.getElementById("editEmail").value,source:document.getElementById("editSource").value,referrer:document.getElementById("editReferrer").value,note:document.getElementById("editNote").value};var res=await fetch("/api/candidates/"+encodeURIComponent(CURRENT_ID),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});if(res.ok){await loadCandidate(CURRENT_ID);location.reload()}else alert("保存失败")}' +
    'async function saveSchedule(){if(!CURRENT_ID)return;var sc=document.getElementById("scSyncCalendar");var payload={round:Number(document.getElementById("scRound").value),scheduledAt:document.getElementById("scAt").value,interviewers:document.getElementById("scInterviewers").value,link:document.getElementById("scLink").value,location:document.getElementById("scLocation").value,syncStatus:document.getElementById("scSyncStatus").value,syncCalendar:sc&&sc.checked?"on":"off"};var res=await fetch("/api/candidates/"+encodeURIComponent(CURRENT_ID)+"/schedule",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});if(res.ok){await loadCandidate(CURRENT_ID);switchTab("schedule");location.reload()}else alert("保存失败")}' +
    'async function addReview(){if(!CURRENT_ID)return;var payload={round:Number(document.getElementById("rvRound").value),conclusion:document.getElementById("rvConclusion").value,rating:document.getElementById("rvRating").value,pros:document.getElementById("rvPros").value,cons:document.getElementById("rvCons").value,focusNext:document.getElementById("rvFocusNext").value};var res=await fetch("/api/candidates/"+encodeURIComponent(CURRENT_ID)+"/reviews",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});if(res.ok){document.getElementById("rvPros").value="";document.getElementById("rvCons").value="";document.getElementById("rvFocusNext").value="";await loadCandidate(CURRENT_ID);switchTab("review");location.reload()}else alert("保存失败")}' +
    'async function quickStatus(id,newStatus){var btn=event.target;btn.disabled=true;btn.style.opacity="0.5";try{var res=await fetch("/api/candidates/"+encodeURIComponent(id)+"/status",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:newStatus})});if(res.ok)location.reload();else{btn.disabled=false;btn.style.opacity="1";alert("操作失败")}}catch(e){btn.disabled=false;btn.style.opacity="1";alert("网络错误")}}' +
    'function setBoardView(v){if(v==="pipeline")location.href="/candidates/board";else location.href="/candidates/board?view=status"}' +
    '</script>';
}

function resumeEmbedHtml(resume) {
  if (!resume || !resume.url) return '<div class="muted">暂无简历</div>';
  const lower = (resume.originalName || resume.filename || "").toLowerCase();
  if (lower.endsWith(".pdf")) return '<iframe src="' + escapeHtml(resume.url) + '" style="width:100%;height:75vh;border:1px solid rgba(237,233,254,.95);border-radius:14px;background:#fff"></iframe>';
  if (lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".webp")) return '<img src="' + escapeHtml(resume.url) + '" style="max-width:100%;border-radius:14px" />';
  return '<div class="muted">不支持内嵌预览</div>';
}

router.get("/candidates/new", requireLogin, requireAdmin, async (req, res) => {
  const d = await loadData();
  const jobOpts = d.jobs.map((j) => '<option value="' + escapeHtml(j.id) + '">' + escapeHtml(j.title || j.id) + '</option>').join("");
  const srcOpts = (d.sources || []).map((s) => '<option value="' + escapeHtml(s) + '">' + escapeHtml(s) + '</option>').join("");
  const tagCheckboxes = (d.tags || []).map((t) => '<label style="display:inline-flex;align-items:center;gap:4px;margin-right:12px;cursor:pointer"><input type="checkbox" name="tags" value="' + escapeHtml(t) + '" style="width:auto" /> ' + escapeHtml(t) + '</label>').join("");

  // 猎头供应商列表（启用的）
  const hunters = (d.headhunters || []).filter(h => h.enabled !== false);
  const hunterOptsJson = JSON.stringify(hunters.map(h => ({ id: h.id, label: (h.company ? h.company + (h.name ? ' · ' + h.name : '') : h.name) || h.id })));
  // 内推人列表（从系统用户）
  const usersJson = JSON.stringify((d.users || []).map(u => ({ id: u.id, label: u.name || u.id })));

  res.send(
    renderPage({
      title: "新建候选人",
      user: req.user,
      active: "candidates",
      contentHtml:
        '<div class="card" style="max-width:860px;margin:0 auto;">' +
        '<div style="font-weight:900;font-size:18px">新建候选人</div>' +
        '<div class="divider"></div>' +
        '<form id="newCandForm">' +
        '<div class="grid">' +
        // 左列
        '<div class="card compact">' +
        '<div class="field"><label>姓名 <span style="color:var(--red)">*</span></label><input name="name" id="ncName" required /></div>' +
        '<div class="field"><label>手机</label><input name="phone" id="ncPhone" /></div>' +
        '<div class="field"><label>邮箱</label><input name="email" id="ncEmail" type="email" placeholder="example@company.com" /></div>' +
        '<div class="field"><label>岗位 <span style="color:var(--red)">*</span></label><select name="jobId" id="ncJobId" required>' + (jobOpts || '<option value="">请先创建职位</option>') + '</select></div>' +
        '<div class="field"><label>简历（可选）</label><input type="file" id="ncResume" accept=".pdf,.png,.jpg,.jpeg,.webp" /><div class="muted">支持 PDF / 图片，直传云端，不受大小限制</div></div>' +
        '</div>' +
        // 右列
        '<div class="card compact">' +
        '<div class="field"><label>来源</label><select name="source" id="ncSource">' + srcOpts + '</select></div>' +
        // 猎头供应商选择器（来源=猎头时显示）
        '<div class="field" id="fieldVendor" style="display:none">' +
        '<label>猎头供应商 <span style="color:var(--red)">*</span></label>' +
        '<select id="ncVendor"><option value="">-- 请选择供应商 --</option></select>' +
        '<div class="muted" style="margin-top:4px">如需新增供应商，请前往<a href="/settings" style="color:var(--primary)">设置 → 猎头管理</a></div>' +
        '</div>' +
        // 内推人选择器（来源=内推时显示）
        '<div class="field" id="fieldReferrer" style="display:none">' +
        '<label>内推人 <span style="color:var(--red)">*</span></label>' +
        '<select id="ncReferrerSelect"><option value="">-- 请选择内推人 --</option></select>' +
        '</div>' +
        '<div class="field"><label>标签</label><div id="ncTags">' + (tagCheckboxes || '<span class="muted">暂无标签，可在设置中添加</span>') + '</div></div>' +
        '<div class="field"><label>备注</label><textarea name="note" id="ncNote" rows="4"></textarea></div>' +
        '</div>' +
        '</div>' +
        '<div class="divider"></div>' +
        '<div class="row"><button class="btn primary" type="submit" id="ncSubmitBtn">创建候选人</button><a class="btn" href="/candidates">返回</a></div>' +
        '</form></div>' +
        '<script>' +
        'var NC_HUNTERS=' + hunterOptsJson + ';' +
        'var NC_USERS=' + usersJson + ';' +
        // 来源联动逻辑
        'function ncSourceChange(){' +
        '  var src=document.getElementById("ncSource").value;' +
        '  var fv=document.getElementById("fieldVendor");' +
        '  var fr=document.getElementById("fieldReferrer");' +
        '  fv.style.display=(src==="猎头")?"":"none";' +
        '  fr.style.display=(src==="内推")?"":"none";' +
        '  if(src==="猎头"){' +
        '    var sel=document.getElementById("ncVendor");' +
        '    sel.innerHTML=\'<option value="">-- 请选择供应商 --</option>\'+NC_HUNTERS.map(function(h){return\'<option value="\'+h.id+\'">\'+h.label+\'</option>\'}).join("");' +
        '  }' +
        '  if(src==="内推"){' +
        '    var sel=document.getElementById("ncReferrerSelect");' +
        '    sel.innerHTML=\'<option value="">-- 请选择内推人 --</option>\'+NC_USERS.map(function(u){return\'<option value="\'+u.id+\'">\'+u.label+\'</option>\'}).join("");' +
        '  }' +
        '}' +
        'document.getElementById("ncSource").addEventListener("change",ncSourceChange);' +
        'ncSourceChange();' +
        // 表单提交
        'document.getElementById("newCandForm").onsubmit=async function(e){e.preventDefault();' +
        'var btn=document.getElementById("ncSubmitBtn");btn.textContent="创建中...";btn.disabled=true;' +
        'try{' +
        'var src=document.getElementById("ncSource").value;' +
        'var vendorId="",referrerId="",referrerName="";' +
        'if(src==="猎头"){vendorId=document.getElementById("ncVendor").value;if(!vendorId){alert("请选择猎头供应商");btn.textContent="创建候选人";btn.disabled=false;return}}' +
        'if(src==="内推"){var rsel=document.getElementById("ncReferrerSelect");referrerId=rsel.value;referrerName=rsel.options[rsel.selectedIndex]&&rsel.selectedIndex>0?rsel.options[rsel.selectedIndex].text:"";if(!referrerId){alert("请选择内推人");btn.textContent="创建候选人";btn.disabled=false;return}}' +
        'var tags=[];document.querySelectorAll("#ncTags input[type=checkbox]:checked").forEach(function(cb){tags.push(cb.value)});' +
        'var payload={name:document.getElementById("ncName").value,phone:document.getElementById("ncPhone").value,email:document.getElementById("ncEmail").value,jobId:document.getElementById("ncJobId").value,source:src,vendorId:vendorId,referrerId:referrerId,referrer:referrerName,note:document.getElementById("ncNote").value,tags:tags};' +
        'var r=await fetch("/api/candidates/create",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});' +
        'var data=await r.json();' +
        'if(r.status===409&&data.duplicate){' +
        'var d=data.duplicate;if(confirm("候选人疑似重复！\\n\\n已有候选人："+d.name+"\\n手机："+d.phone+"\\n岗位："+d.jobTitle+"\\n状态："+d.status+"\\n\\n点击【确定】查看已有候选人，点击【取消】返回修改")){location.href="/candidates/"+d.id;return}btn.textContent="创建候选人";btn.disabled=false;return}' +
        'if(!r.ok)throw new Error(data.error||"创建失败");' +
        'var cid=data.candidateId;' +
        'var fileInput=document.getElementById("ncResume");var file=fileInput&&fileInput.files[0];' +
        'if(file){btn.textContent="上传简历中...";' +
        'var signRes=await fetch("/api/resume/upload-url",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({candidateId:cid,fileName:file.name,contentType:file.type||"application/octet-stream"})});' +
        'var signData=await signRes.json();' +
        'if(signRes.ok&&signData.signedUrl){' +
        'var upRes=await fetch(signData.signedUrl,{method:"PUT",headers:{"Content-Type":file.type||"application/octet-stream"},body:file});' +
        'if(upRes.ok){await fetch("/api/candidates/"+cid+"/resume-meta",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({objectName:signData.objectName,originalName:file.name,contentType:file.type||"",size:file.size,bucket:signData.bucket})})}' +
        '}}' +
        'location.href="/candidates/"+cid;' +
        '}catch(err){alert(err.message);btn.textContent="创建候选人";btn.disabled=false}}' +
        '</script>',
    })
  );
});

// API：JSON 创建候选人（前端 JS 调用，不含文件）
router.post("/api/candidates/create", requireLogin, requireAdmin, async (req, res) => {
  try {
    const d = await loadData();
    const name = String(req.body.name || "").trim();
    const phone = String(req.body.phone || "").trim();
    const email = String(req.body.email || "").trim();
    const jobId = String(req.body.jobId || "").trim();
    const source = String(req.body.source || "").trim();
    const referrer = String(req.body.referrer || "").trim();
    const referrerId = String(req.body.referrerId || "").trim();
    const vendorId = String(req.body.vendorId || "").trim();
    const note = String(req.body.note || "").trim();
    let tags = req.body.tags || [];
    if (typeof tags === "string") tags = [tags];
    tags = tags.filter(Boolean);

    if (!name) return res.status(400).json({ error: "姓名不能为空" });
    if (!jobId) return res.status(400).json({ error: "请选择岗位" });

    // 查重：姓名+手机号完全匹配
    const dupCandidate = findDuplicate(d.candidates, name, phone);
    if (dupCandidate) {
      return res.status(409).json({ error: "候选人疑似重复", duplicate: { id: dupCandidate.id, name: dupCandidate.name, phone: dupCandidate.phone, jobTitle: dupCandidate.jobTitle || "-", status: dupCandidate.status } });
    }

    const job = d.jobs.find((x) => x.id === jobId);
    // 猎头来源：补全 vendorName（供应商显示名称）
    let vendorName = "";
    if (source === "猎头" && vendorId) {
      const h = (d.headhunters || []).find(x => x.id === vendorId);
      vendorName = h ? (h.company ? h.company + (h.name ? " · " + h.name : "") : h.name) : vendorId;
    }
    const c = {
      id: rid("c"), name, phone, email, jobId,
      jobTitle: job ? job.title : jobId, source, referrer, referrerId, vendorId, vendorName, note, tags,
      status: "待筛选",
      follow: { nextAction: "待联系", followAt: "", note: "" },
      createdAt: nowIso(), updatedAt: nowIso(),
    };
    d.candidates.unshift(c);
    if (c.source && !d.sources.includes(c.source)) d.sources.push(c.source);
    pushEvent(d, { candidateId: c.id, type: "创建", message: "创建候选人：" + (c.name || "-") + "（岗位：" + (c.jobTitle || "-") + "）", actor: req.user?.name || "系统" });
    await saveData(d);
    await notifyHrNewCandidate(d, c, job).catch(e => console.warn("[Notify] err:", e.message));
    res.json({ ok: true, candidateId: c.id });
  } catch (e) {
    console.error("[Create] error:", e.message);
    res.status(500).json({ error: String(e?.message || "创建失败") });
  }
});

// 兼容旧版：form POST 创建候选人（含文件上传，本地开发用）
router.post("/candidates/new", requireLogin, requireAdmin, upload.single("resume"), async (req, res) => {
  const d = await loadData();
  const name = String(req.body.name || "").trim();
  const phone = String(req.body.phone || "").trim();
  const email = String(req.body.email || "").trim();
  const jobId = String(req.body.jobId || "").trim();
  const source = String(req.body.source || "").trim();
  const note = String(req.body.note || "").trim();
  const file = req.file || null;

  let tags = req.body.tags || [];
  if (typeof tags === "string") tags = [tags];
  tags = tags.filter(Boolean);

  if (!name) return res.redirect(303, "/candidates/new");
  if (!jobId) return res.redirect(303, "/candidates/new");

  // 查重：姓名+手机号完全匹配
  const dupCandidate = findDuplicate(d.candidates, name, phone);
  if (dupCandidate) {
    return res.send(renderPage({
      title: "候选人疑似重复", user: req.user, active: "candidates",
      contentHtml: '<div class="card" style="max-width:600px;margin:0 auto"><div style="font-weight:900;font-size:18px;color:var(--orange,#ff7d00)">候选人疑似重复</div><div class="divider"></div>' +
        '<div class="muted" style="margin-bottom:12px">系统检测到已有相同姓名和手机号的候选人：</div>' +
        '<div class="card compact"><div><b>' + escapeHtml(dupCandidate.name) + '</b></div><div class="muted">手机：' + escapeHtml(dupCandidate.phone || '-') + '</div><div class="muted">岗位：' + escapeHtml(dupCandidate.jobTitle || '-') + '</div><div class="muted">状态：' + escapeHtml(dupCandidate.status || '-') + '</div></div>' +
        '<div class="divider"></div><div class="row"><a class="btn primary" href="/candidates/' + dupCandidate.id + '">查看已有候选人</a><a class="btn" href="/candidates/new">返回重新填写</a></div></div>',
    }));
  }

  const job = d.jobs.find((x) => x.id === jobId);

  const c = {
    id: rid("c"),
    name,
    phone,
    email,
    jobId,
    jobTitle: job ? job.title : jobId,
    source,
    note,
    tags,
    status: "待筛选",
    follow: { nextAction: "待联系", followAt: "", note: "" },
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  d.candidates.unshift(c);
  if (c.source && !d.sources.includes(c.source)) d.sources.push(c.source);

  pushEvent(d, { candidateId: c.id, type: "创建", message: "创建候选人：" + (c.name || "-") + "（岗位：" + (c.jobTitle || "-") + "）", actor: req.user?.name || "系统" });

  if (file && file.buffer && file.buffer.length) {
    try {
      await saveResumeSupabaseOrLocal(d, c.id, file, req.user?.name || "系统");
    } catch (e) {
      pushEvent(d, { candidateId: c.id, type: "简历", message: "简历上传失败（已跳过）：" + String(e?.message || e || ""), actor: "系统" });
    }
  }

  await saveData(d);
  await notifyHrNewCandidate(d, c, job).catch(e => console.warn("[Notify] err:", e.message));
  res.redirect(303, "/candidates/" + c.id);
});

// ====== 批量导入简历 ======
router.get("/candidates/import", requireLogin, requireAdmin, async (req, res) => {
  const d = await loadData();
  // 只显示开放状态的岗位
  const openJobs = d.jobs.filter(j => j.state === "open");
  const jobOptions = openJobs.map(j => {
    const label = escapeHtml(j.title) + (j.employmentType ? " (" + escapeHtml(j.employmentType) + ")" : "");
    return '<option value="' + escapeHtml(j.id) + '">' + label + '</option>';
  }).join("");

  const scriptCode = `
let selectedFiles = [];
let isUploading = false;

function handleFileSelect(files) {
  if (isUploading) return;
  selectedFiles = Array.from(files).map(f => ({ file: f, status: 'pending', progress: 0, error: '' }));
  renderFileList();
}

function removeFile(idx) {
  if (isUploading) return;
  selectedFiles.splice(idx, 1);
  renderFileList();
}

function renderFileList() {
  const list = document.getElementById('fileList');
  const btn = document.getElementById('importBtn');
  if (!selectedFiles.length) {
    list.innerHTML = '';
    btn.disabled = true;
    return;
  }
  btn.disabled = isUploading;

  let html = '<div style="font-weight:700;margin-bottom:12px">已选择 ' + selectedFiles.length + ' 个文件</div>';
  selectedFiles.forEach((item, i) => {
    const f = item.file;
    const sizeStr = (f.size / 1024).toFixed(1) + ' KB';
    let statusHtml = '';
    let progressHtml = '';

    if (item.status === 'pending') {
      statusHtml = '<span onclick="removeFile(' + i + ')" style="cursor:pointer;color:#999" title="移除">&times;</span>';
    } else if (item.status === 'uploading') {
      progressHtml = '<div style="height:4px;background:#e5e7eb;border-radius:2px;margin-top:6px;overflow:hidden"><div style="height:100%;background:#7c5cfc;width:' + item.progress + '%;transition:width 0.3s"></div></div>';
      statusHtml = '<span style="color:#7c5cfc;font-size:12px">' + item.progress + '%</span>';
    } else if (item.status === 'success') {
      statusHtml = '<span style="color:#16a34a">✓</span>';
    } else if (item.status === 'error') {
      statusHtml = '<span style="color:#dc2626" title="' + (item.error || '失败') + '">✗</span>';
      progressHtml = '<div style="color:#dc2626;font-size:12px;margin-top:4px">' + (item.error || '上传失败') + '</div>';
    }

    html += '<div style="padding:8px 0;border-bottom:1px solid #f0f0f0">' +
      '<div class="row"><span style="flex:1;word-break:break-all">' + f.name + '</span>' +
      '<span class="muted" style="margin:0 12px;white-space:nowrap">' + sizeStr + '</span>' +
      statusHtml + '</div>' + progressHtml + '</div>';
  });
  list.innerHTML = html;
}

const dropZone = document.getElementById('dropZone');
dropZone.addEventListener('dragover', e => { e.preventDefault(); if (!isUploading) { dropZone.style.borderColor = '#7c5cfc'; dropZone.style.background = '#f5f3ff'; } });
dropZone.addEventListener('dragleave', e => { e.preventDefault(); dropZone.style.borderColor = '#d1d5db'; dropZone.style.background = '#f9fafb'; });
dropZone.addEventListener('drop', e => { e.preventDefault(); dropZone.style.borderColor = '#d1d5db'; dropZone.style.background = '#f9fafb'; if (!isUploading && e.dataTransfer.files.length) handleFileSelect(e.dataTransfer.files); });

async function uploadSingleFile(item, jobId) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    const formData = new FormData();
    formData.append('jobId', jobId);
    formData.append('resume', item.file);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        item.progress = Math.round((e.loaded / e.total) * 100);
        renderFileList();
      }
    };

    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status === 200 && data.ok) {
          item.status = 'success';
          item.progress = 100;
        } else {
          item.status = 'error';
          item.error = data.error || '上传失败';
        }
      } catch (e) {
        item.status = 'error';
        item.error = '响应解析失败';
      }
      renderFileList();
      resolve();
    };

    xhr.onerror = () => {
      item.status = 'error';
      item.error = '网络错误';
      renderFileList();
      resolve();
    };

    item.status = 'uploading';
    item.progress = 0;
    renderFileList();

    xhr.open('POST', '/candidates/import-single-resume');
    xhr.send(formData);
  });
}

async function startImport() {
  const jobId = document.getElementById('importJobId').value;
  if (!jobId) { alert('请选择目标职位'); return; }
  if (!selectedFiles.length) { alert('请选择简历文件'); return; }

  isUploading = true;
  const btn = document.getElementById('importBtn');
  const result = document.getElementById('importResult');
  btn.disabled = true;
  btn.textContent = '导入中...';
  result.innerHTML = '';

  // 逐个上传
  for (const item of selectedFiles) {
    await uploadSingleFile(item, jobId);
  }

  isUploading = false;
  btn.disabled = false;
  btn.textContent = '开始导入';

  const success = selectedFiles.filter(f => f.status === 'success').length;
  const failed = selectedFiles.filter(f => f.status === 'error').length;

  result.innerHTML = '<div class="card compact" style="background:#f0fdf4;border:1px solid #86efac;margin-top:16px">' +
    '<div style="font-weight:700;color:#16a34a">导入完成</div>' +
    '<div class="row" style="margin-top:8px"><span class="pill"><span class="muted">成功</span><b>' + success + '</b></span>' +
    (failed > 0 ? '<span class="pill"><span class="muted">失败</span><b style="color:var(--red)">' + failed + '</b></span>' : '') +
    '</div></div>' +
    '<div style="margin-top:12px"><a class="btn primary" href="/candidates">查看人才库</a><button class="btn" style="margin-left:8px" onclick="selectedFiles=[];renderFileList();document.getElementById(\\'importResult\\').innerHTML=\\'\\'">继续导入</button></div>';
}
`;

  res.send(
    renderPage({
      title: "批量导入简历",
      user: req.user,
      active: "candidates",
      contentHtml: '<div class="card" style="max-width:820px;margin:0 auto;">' +
        '<div style="font-weight:900;font-size:18px">批量导入简历</div>' +
        '<div class="divider"></div>' +
        '<div class="muted" style="margin-bottom:16px">选择目标职位后，上传多份简历文件。系统会自动为每份简历创建候选人记录。</div>' +
        '<div class="field"><label>目标职位 <span style="color:var(--red)">*</span></label>' +
        '<select id="importJobId" style="max-width:400px" required><option value="">-- 请选择职位 --</option>' + jobOptions + '</select></div>' +
        '<div class="field"><label>上传简历文件</label>' +
        '<div style="border:2px dashed #d1d5db;border-radius:12px;padding:32px;text-align:center;background:#f9fafb;cursor:pointer" id="dropZone" onclick="document.getElementById(\'resumeFiles\').click()">' +
        '<div style="font-size:32px;margin-bottom:8px">📄</div>' +
        '<div style="font-weight:700;margin-bottom:4px">点击选择文件或拖拽到此处</div>' +
        '<div class="muted">支持 PDF、Word、图片等格式，可同时选择多个文件</div>' +
        '<input type="file" id="resumeFiles" multiple accept=".pdf,.doc,.docx,.png,.jpg,.jpeg" style="display:none" onchange="handleFileSelect(this.files)" />' +
        '</div></div>' +
        '<div id="fileList" style="margin-top:12px"></div>' +
        '<div class="divider"></div>' +
        '<div class="row"><button class="btn primary" id="importBtn" onclick="startImport()" disabled>开始导入</button><a class="btn" href="/candidates">返回</a></div>' +
        '<div id="importResult"></div></div>' +
        '<script>' + scriptCode + '</script>',
    })
  );
});

// 单文件简历导入接口（支持进度显示）
router.post("/candidates/import-single-resume", requireLogin, requireAdmin, upload.single("resume"), async (req, res) => {
  try {
    const d = await loadData();
    const file = req.file;
    const jobId = String(req.body.jobId || "").trim();

    if (!jobId) {
      return res.status(400).json({ ok: false, error: "请选择目标职位" });
    }
    const job = d.jobs.find(j => j.id === jobId);
    if (!job) {
      return res.status(400).json({ ok: false, error: "职位不存在" });
    }
    if (!file) {
      return res.status(400).json({ ok: false, error: "请选择简历文件" });
    }

    // 从文件名提取候选人姓名（去掉扩展名和常见后缀）
    let rawName = file.originalname || "未命名";
    rawName = rawName.replace(/\.(pdf|doc|docx|png|jpg|jpeg)$/i, "");
    rawName = rawName.replace(/[-_]?(简历|resume|cv|个人简历)$/i, "").trim();
    rawName = rawName.replace(/^(简历|resume|cv)[-_]?/i, "").trim();
    const name = rawName || "未命名候选人";

    // 创建候选人
    const c = {
      id: rid("c"),
      name,
      phone: "",
      email: "",
      jobId: jobId,
      jobTitle: job.title,
      source: "批量导入",
      note: "从文件「" + (file.originalname || "") + "」导入",
      tags: [],
      status: "待筛选",
      follow: { nextAction: "待联系", followAt: "", note: "" },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    // 保存简历文件（正确的参数顺序：d, candidateId, file, actorName）
    await saveResumeSupabaseOrLocal(d, c.id, file, req.user?.name || "批量导入");

    d.candidates.unshift(c);
    pushEvent(d, { candidateId: c.id, type: "新建", message: "批量导入简历创建候选人", actor: req.user?.name || "系统" });
    await saveData(d);

    // 通知HR
    await notifyHrNewCandidate(d, c, job).catch(e => console.warn("[Notify] err:", e.message));

    res.json({ ok: true, candidateId: c.id, name: c.name });
  } catch (e) {
    console.error("[Import] 单文件导入失败:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ====== 人才库（列表）======
router.get("/candidates", requireLogin, async (req, res) => {
  const d = await loadData();
  const q = String(req.query.q || "").trim().toLowerCase();
  const jobId = String(req.query.jobId || "").trim();
  const source = String(req.query.source || "").trim();
  const status = String(req.query.status || "").trim();

  const visibleJobIds = getVisibleJobIds(req.user, d.jobs);
  const jobMap = new Map(d.jobs.map((j) => [j.id, j]));
  d.candidates.forEach((c) => {
    if (!c.jobTitle && c.jobId && jobMap.get(c.jobId)) c.jobTitle = jobMap.get(c.jobId).title;
    if (!STATUS_SET.has(c.status)) c.status = "待筛选";
    if (!c.follow) c.follow = { nextAction: "", followAt: "", note: "" };
    if (!Array.isArray(c.tags)) c.tags = [];
  });
  const permCandidates = filterCandidatesByPermission(d.candidates, visibleJobIds);

  const filtered = permCandidates.filter((c) => {
    // 面试通过阶段（待发offer/Offer发放/拒offer/入职）的候选人转移到"面试通过"模块，不在人才库显示
    if (OFFER_STAGE_STATUSES.has(c.status)) return false;
    if (jobId && c.jobId !== jobId) return false;
    if (source && String(c.source || "") !== source) return false;
    if (status && c.status !== status) return false;
    if (q) {
      const hay = (c.name || "") + " " + (c.phone || "") + " " + (c.email || "") + " " + (c.note || "") + " " + (c.source || "") + " " + (c.tags || []).join(" ");
      if (!hay.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  // 按状态流程排序：流程越靠后越靠前，淘汰/暂不推进排最后
  const STATUS_PRIORITY = {
    "已入职": 0, "入职": 0,
    "已发Offer": 1, "Offer发放": 1, "待发offer": 2,
    "谈薪中": 3,
    "五面通过": 4, "待五面": 5,
    "四面通过": 6, "待四面": 7,
    "三面通过": 8, "待三面": 9,
    "二面通过": 10, "待二面": 11,
    "一面通过": 12, "待一面": 13,
    "面试中": 14,
    "待跟进": 15,
    "简历初筛": 16, "待筛选": 17,
    "已淘汰": 90, "淘汰": 90, "暂不推进": 91,
    "已录用": 0,
  };
  filtered.sort((a, b) => {
    const pa = STATUS_PRIORITY[a.status] ?? 50;
    const pb = STATUS_PRIORITY[b.status] ?? 50;
    if (pa !== pb) return pa - pb;
    return (b.createdAt || "").localeCompare(a.createdAt || "");
  });

  // 候选人详情页的来源参数（用于返回时回到正确页面）
  const detailFromParam = jobId ? "?from=job:" + encodeURIComponent(jobId) : "";

  // 人才库状态标签不显示"面试通过"阶段的状态（那些候选人在"面试通过"模块中）
  const seg = STATUS_COLS.filter((s) => !OFFER_STAGE_STATUSES.has(s.key)).map((s) => {
    const u = new URL("http://x/candidates");
    if (q) u.searchParams.set("q", q);
    if (jobId) u.searchParams.set("jobId", jobId);
    if (source) u.searchParams.set("source", source);
    if (s.key) u.searchParams.set("status", s.key);
    const href = u.pathname + "?" + u.searchParams.toString();
    const cls = s.key === status ? "active" : "";
    return '<a class="' + cls + '" href="' + href + '">' + escapeHtml(s.name) + '</a>';
  }).join("");

  const allHref = (() => {
    const u = new URL("http://x/candidates");
    if (q) u.searchParams.set("q", q);
    if (jobId) u.searchParams.set("jobId", jobId);
    if (source) u.searchParams.set("source", source);
    return u.pathname + (u.searchParams.toString() ? "?" + u.searchParams.toString() : "");
  })();

  // 构建简历查找 Map（只取有 url 的记录）
  const resumeMap = new Map();
  for (const r of d.resumeFiles) {
    if (!r.url) continue;
    if (!resumeMap.has(r.candidateId) || (r.uploadedAt || "") > (resumeMap.get(r.candidateId).uploadedAt || "")) {
      resumeMap.set(r.candidateId, r);
    }
  }

  const isAdmin = req.user?.role === "admin";
  const rows = filtered
    .map((c) => {
      const follow = followupBadge(c.follow);
      const tagsHtml = (c.tags || []).map((t) => tagBadge(t)).join(" ");
      const rm = resumeMap.get(c.id);
      let resumeDisplayName = rm ? (rm.originalName || rm.filename || "简历") : "";
      // 修复乱码文件名：检测UTF-8被Latin-1误解码的特征（连续Latin Extended字符）
      if (resumeDisplayName && (resumeDisplayName.match(/[\u00c0-\u00ff]/g) || []).length >= 3) {
        resumeDisplayName = (c.name || "候选人") + "_简历";
      }
      const resumeCol = rm && rm.url
        ? '<a class="btn sm" href="' + escapeHtml(rm.url) + '" target="_blank" rel="noreferrer" title="' + escapeHtml(resumeDisplayName) + '">📎 ' + escapeHtml(resumeDisplayName.slice(0, 16)) + '</a>'
        : '<span class="muted">-</span>';
      return '<tr>' +
        '<td style="width:36px"><input type="checkbox" class="batch-check" data-id="' + escapeHtml(c.id) + '" style="width:auto" /></td>' +
        '<td><a class="btn sm" href="/candidates/' + escapeHtml(c.id) + detailFromParam + '" target="_blank">' + escapeHtml(c.name || "未命名") + '</a></td>' +
        '<td>' + escapeHtml(c.phone || "-") + '</td>' +
        '<td class="ov">' + escapeHtml(c.email || "-") + '</td>' +
        '<td class="ov">' + escapeHtml(c.jobTitle || c.jobId || "-") + '</td>' +
        '<td class="ov" style="max-width:80px">' + escapeHtml(c.source || "-") + '</td>' +
        '<td style="white-space:nowrap">' + statusBadge(c.status) + ' ' + follow + '</td>' +
        '<td class="ov" style="max-width:130px">' + resumeCol + '</td>' +
        '<td class="ov" style="max-width:70px">' + tagsHtml + '</td>' +
        '<td class="muted" style="white-space:nowrap;font-size:12px">' + escapeHtml(toBjTime(c.updatedAt || c.createdAt || "").slice(0, 10)) + '</td>' +
        '<td><a class="btn sm" href="/candidates/' + escapeHtml(c.id) + detailFromParam + '">编辑</a></td>' +
        '</tr>';
    })
    .join("");

  res.send(
    renderPage({
      title: "人才库",
      user: req.user,
      active: "candidates",
      contentHtml: '<div class="row"><div style="font-weight:900;font-size:18px">人才库 <span class="muted" style="font-weight:400">（' + filtered.length + '/' + permCandidates.length + '）</span></div><span class="spacer"></span><a class="btn" href="/candidates/board">去看板</a></div><div class="divider"></div>' +
        toolbarHtml({ jobs: visibleJobIds === null ? d.jobs : d.jobs.filter(j => visibleJobIds.has(j.id)), sources: d.sources, q, jobId, source, mode: "list", isAdmin: req.user?.role === "admin" }) +
        '<div style="height:12px"></div>' +
        '<div class="seg"><a class="' + (status ? "" : "active") + '" href="' + allHref + '">全部状态</a>' + seg + '</div>' +
        '<div style="height:12px"></div>' +
        '<div id="batchBar" class="batch-bar" style="display:none"><span id="batchCount">已选 0 人</span><button class="btn sm primary" onclick="batchUpdateStatus()">批量更新状态</button><button class="btn sm" onclick="batchChangeJob()">批量更换岗位</button><button class="btn sm" onclick="batchAddTag()">批量添加标签</button>' + (isAdmin ? '<button class="btn sm danger" onclick="batchDelete()">批量删除</button>' : '') + '<button class="btn sm ghost" onclick="clearBatch()">取消选择</button></div>' +
        '<div class="card" style="overflow-x:auto"><table><thead><tr><th style="width:36px"><input type="checkbox" id="selectAll" style="width:auto" /></th><th>姓名</th><th>手机</th><th>邮箱</th><th>岗位</th><th>来源</th><th>状态 / 跟进</th><th>简历</th><th>标签</th><th>更新时间</th><th>操作</th></tr></thead><tbody>' + (rows || "") + '</tbody></table>' + (rows ? "" : '<div class="muted">暂无候选人</div>') + '</div>' +
        '<script>var sa=document.getElementById("selectAll");if(sa){sa.onchange=function(){document.querySelectorAll(".batch-check").forEach(function(cb){cb.checked=sa.checked});updateBatchBar()}}document.querySelectorAll(".batch-check").forEach(function(cb){cb.onchange=updateBatchBar});function getSelected(){return Array.from(document.querySelectorAll(".batch-check:checked")).map(function(cb){return cb.dataset.id})}function updateBatchBar(){var ids=getSelected();var bar=document.getElementById("batchBar");var cnt=document.getElementById("batchCount");if(ids.length){bar.style.display="flex";cnt.textContent="已选 "+ids.length+" 人"}else{bar.style.display="none"}}function clearBatch(){document.querySelectorAll(".batch-check").forEach(function(cb){cb.checked=false});if(sa)sa.checked=false;updateBatchBar()}async function batchUpdateStatus(){var ids=getSelected();if(!ids.length)return;var st=prompt("请输入新状态（如：待一面、淘汰等）：");if(!st)return;for(var i=0;i<ids.length;i++){await fetch("/api/candidates/"+encodeURIComponent(ids[i])+"/status",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:st})})}location.reload()}async function batchAddTag(){var ids=getSelected();if(!ids.length)return;var tag=prompt("请输入标签名称：");if(!tag)return;for(var i=0;i<ids.length;i++){var r=await fetch("/api/candidates/"+encodeURIComponent(ids[i]));if(r.ok){var data=await r.json();var tags=data.tags||[];if(tags.indexOf(tag)===-1)tags.push(tag);await fetch("/api/candidates/"+encodeURIComponent(ids[i]),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tags:tags})})}}location.reload()}async function batchDelete(){var ids=getSelected();if(!ids.length)return;if(!confirm("确定删除选中的 "+ids.length+" 名候选人？此操作不可撤销！"))return;for(var i=0;i<ids.length;i++){await fetch("/candidates/"+encodeURIComponent(ids[i])+"/delete",{method:"POST"})}location.reload()}var _batchJobs=' + JSON.stringify(d.jobs.filter(j => j.state !== "closed").map(j => ({ id: j.id, title: j.title, state: j.state }))) + ';function batchChangeJob(){var ids=getSelected();if(!ids.length)return;var opts=_batchJobs.map(function(j){return j.title+(j.state==="paused"?" (暂停)":"")}).join("\\n");var selected=prompt("请输入要更换到的岗位名称：\\n\\n可选岗位：\\n"+opts);if(!selected)return;var target=_batchJobs.find(function(j){return j.title===selected||j.title===selected.replace(/ \\(暂停\\)$/,"")});if(!target){alert("未找到匹配的岗位："+selected);return}if(!confirm("确定将选中的 "+ids.length+" 名候选人更换到「"+target.title+"」岗位？"))return;(async function(){for(var i=0;i<ids.length;i++){await fetch("/api/candidates/"+encodeURIComponent(ids[i])+"/job",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jobId:target.id})})}location.reload()})()}</script>',
    })
  );
});

router.get("/candidates/board", requireLogin, async (req, res) => {
  const d = await loadData();
  const q = String(req.query.q || "").trim().toLowerCase();
  const jobId = String(req.query.jobId || "").trim();
  const source = String(req.query.source || "").trim();

  const visibleJobIds = getVisibleJobIds(req.user, d.jobs);
  const jobMap = new Map(d.jobs.map((j) => [j.id, j]));
  d.candidates.forEach((c) => {
    if (!c.jobTitle && c.jobId && jobMap.get(c.jobId)) c.jobTitle = jobMap.get(c.jobId).title;
    if (!STATUS_SET.has(c.status)) c.status = "待筛选";
    if (!c.follow) c.follow = { nextAction: "", followAt: "", note: "" };
    if (!Array.isArray(c.tags)) c.tags = [];
  });
  const permCandidates = filterCandidatesByPermission(d.candidates, visibleJobIds);

  const filtered = permCandidates.filter((c) => {
    if (jobId && c.jobId !== jobId) return false;
    if (source && String(c.source || "") !== source) return false;
    if (q) {
      const hay = (c.name || "") + " " + (c.phone || "") + " " + (c.note || "") + " " + (c.source || "");
      if (!hay.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const grouped = {};
  const countsByCol = {};
  STATUS_COLS.forEach((col) => { grouped[col.key] = []; countsByCol[col.key] = 0; });
  filtered.forEach((c) => { grouped[c.status].push(c); countsByCol[c.status] += 1; });

  // 构建简历 Map 供看板卡片使用（只取有 url 的记录）
  const boardResumeMap = new Map();
  for (const r of d.resumeFiles) {
    if (!r.url) continue;
    if (!boardResumeMap.has(r.candidateId) || (r.uploadedAt || "") > (boardResumeMap.get(r.candidateId).uploadedAt || "")) {
      boardResumeMap.set(r.candidateId, r);
    }
  }

  // 流水线摘要
  const totalFiltered = filtered.length;
  const pipelineSummary = PIPELINE_STAGES.map(stage => {
    const cnt = stage.statuses.reduce((sum, s) => sum + (countsByCol[s] || 0), 0);
    return '<div class="pipeline-stage"><div class="pipeline-dot" style="background:' + stage.color + '"></div><div class="pipeline-info"><div class="pipeline-name">' + escapeHtml(stage.name) + '</div><div class="pipeline-num">' + cnt + '</div></div></div>';
  }).join('<div class="pipeline-arrow">›</div>');

  const viewMode = String(req.query.view || "pipeline").trim();
  const boardContent = viewMode === "status"
    ? kanbanStatusHtml({ grouped, countsByCol, resumeMap: boardResumeMap })
    : kanbanHtml({ grouped, countsByCol, resumeMap: boardResumeMap });

  res.send(
    renderPage({
      title: "候选人看板",
      user: req.user,
      active: "board",
      contentHtml: toolbarHtml({ jobs: visibleJobIds === null ? d.jobs : d.jobs.filter(j => visibleJobIds.has(j.id)), sources: d.sources, q, jobId, source, mode: "board", isAdmin: req.user?.role === "admin" }) +
        '<div class="card compact" style="margin-bottom:12px"><div class="pipeline-bar">' + pipelineSummary + '</div></div>' +
        boardContent +
        '<datalist id="board-interviewer-list">' + d.users.map(u => '<option value="' + escapeHtml(u.name) + '">').join("") + '</datalist>',
    })
  );
});

// ====== 候选人详情页 ======
router.get("/candidates/:id", requireLogin, async (req, res) => {
  const d = await loadData();
  const c = d.candidates.find((x) => x.id === req.params.id);

  // 解析来源参数，用于返回按钮
  const fromParam = req.query.from || "";
  let backUrl = "/candidates";
  let backLabel = "返回列表";
  if (fromParam.startsWith("job:")) {
    const jobId = fromParam.slice(4);
    const job = d.jobs.find((j) => j.id === jobId);
    if (job) {
      backUrl = "/candidates?jobId=" + encodeURIComponent(jobId);
      backLabel = "返回「" + (job.title || "岗位").slice(0, 8) + "」";
    }
  } else if (fromParam === "board") {
    backUrl = "/candidates/board";
    backLabel = "返回看板";
  }

  if (!c) {
    return res.send(renderPage({ title: "候选人不存在", user: req.user, active: "candidates", contentHtml: '<div class="card"><div style="font-weight:900">候选人不存在</div><div class="divider"></div><a class="btn" href="' + backUrl + '">返回</a></div>' }));
  }
  // 权限检查：member 只能查看自己负责岗位下的候选人
  const visibleJobIds = getVisibleJobIds(req.user, d.jobs);
  if (visibleJobIds !== null && !visibleJobIds.has(c.jobId)) {
    return res.send(renderPage({ title: "无权限", user: req.user, active: "candidates", contentHtml: '<div class="card"><div style="font-weight:900">无权限查看该候选人</div><div class="muted">该候选人所属岗位不在您的负责范围内</div><div class="divider"></div><a class="btn" href="' + backUrl + '">返回</a></div>' }));
  }
  if (!STATUS_SET.has(c.status)) c.status = "待筛选";
  if (!c.follow) c.follow = { nextAction: "待联系", followAt: "", note: "" };
  if (!Array.isArray(c.tags)) c.tags = [];

  var resume = d.resumeFiles.filter((r) => r.candidateId === c.id && r.url).sort((a, b) => (b.uploadedAt || "").localeCompare(a.uploadedAt || ""))[0];
  resume = await refreshResumeUrlIfNeeded(resume);

  // 补全历史面评中缺失的 id 字段
  let needSave = false;
  d.interviews.forEach((x) => { if (x.candidateId === c.id && !x.id) { x.id = rid("rv"); needSave = true; } });
  if (needSave) await saveData(d);

  const reviews = d.interviews.filter((x) => x.candidateId === c.id).sort((a, b) => (a.round - b.round) || (b.createdAt || "").localeCompare(a.createdAt || ""));
  const schedules = d.interviewSchedules.filter((x) => x.candidateId === c.id).sort((a, b) => (a.round - b.round));
  const events = d.events.filter((e) => e.candidateId === c.id).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  const offer = (d.offers || []).find((o) => o.candidateId === c.id);

  const statusOptions = STATUS_COLS.map((s) => '<option value="' + escapeHtml(s.key) + '" ' + (c.status === s.key ? "selected" : "") + '>' + escapeHtml(s.name) + '</option>').join("");
  // 来源下拉选项（用于信息编辑）
  const detailSrcOpts = (d.sources || []).map((s) => '<option value="' + escapeHtml(s) + '" ' + (c.source === s ? "selected" : "") + '>' + escapeHtml(s) + '</option>').join("");
  const detailHunterOptsJson = JSON.stringify((d.headhunters || []).filter(h => h.enabled !== false).map(h => ({ id: h.id, label: (h.company ? h.company + (h.name ? ' · ' + h.name : '') : h.name) || h.id })));
  const detailUsersJson = JSON.stringify((d.users || []).map(u => ({ id: u.id, label: u.name || u.id })));
  // 当前猎头供应商名（用于回填）
  const currentVendorId = c.vendorId || "";
  // 当前内推人 id（用于回填）
  const currentReferrerId = c.referrerId || "";
  const roundOpts = INTERVIEW_ROUNDS.map((x) => '<option value="' + x + '">第' + x + '轮</option>').join("");
  const stOpts = INTERVIEW_STATUS.map((x) => '<option value="' + escapeHtml(x) + '">' + escapeHtml(x) + '</option>').join("");
  const rtOpts = INTERVIEW_RATING.map((x) => '<option value="' + x + '">' + (INTERVIEW_RATING_LABEL[x] || x) + '</option>').join("");

  const syncOpts = '<option value="（不同步）">（不同步）</option>' + INTERVIEW_STATUS.map((x) => '<option value="' + escapeHtml(x) + '">' + escapeHtml(x) + '</option>').join("");
  const offerStOpts = OFFER_STATUSES.map((x) => '<option value="' + escapeHtml(x) + '" ' + ((offer && offer.offerStatus === x) ? "selected" : "") + '>' + escapeHtml(x) + '</option>').join("");
  const interviewerDatalist = d.users.map(u => '<option value="' + escapeHtml(u.name) + '">' + escapeHtml(u.name) + '</option>').join("");
  // 岗位下拉选项（开放状态的岗位优先）
  const jobOptions = d.jobs
    .filter(j => j.state !== "closed")
    .sort((a, b) => (a.state === "open" ? 0 : 1) - (b.state === "open" ? 0 : 1))
    .map(j => '<option value="' + escapeHtml(j.id) + '" ' + (c.jobId === j.id ? "selected" : "") + '>' + escapeHtml(j.title) + (j.state === "paused" ? " (暂停)" : "") + '</option>')
    .join("");

  // 面试官头像 map：name -> { avatar, department }
  const uAvatarMap = {};
  d.users.forEach(u => { if (u.name) uAvatarMap[u.name] = { avatar: u.avatar || "", department: u.department || "" }; });
  function renderIvAvatars(ivStr) {
    if (!ivStr || ivStr === "-") return '<span class="muted">-</span>';
    const names = ivStr.split(/[\/,]/).map(n => n.trim()).filter(Boolean);
    return names.map(n => {
      const u = uAvatarMap[n];
      const colors = ["#7c5cfc","#3370ff","#f5222d","#fa8c16","#52c41a","#4e7bf6"];
      const ci = n.charCodeAt(0) % colors.length;
      const avatarEl = u && u.avatar
        ? '<img src="' + escapeHtml(u.avatar) + '" style="width:22px;height:22px;border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:4px">'
        : '<span style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:' + colors[ci] + ';color:#fff;font-size:10px;font-weight:700;vertical-align:middle;margin-right:4px">' + escapeHtml(n.slice(0, 1)) + '</span>';
      return avatarEl + '<span style="vertical-align:middle">' + escapeHtml(n) + '</span>';
    }).join('<span style="margin:0 6px;color:#ccc">|</span>');
  }

  const tagsHtml = (c.tags || []).map((t) => tagBadge(t)).join(" ");

  // ====== 面试评级汇总 ======
  const ratingScore = { S: 5, A: 4, "B+": 3.5, B: 3, "B-": 2, C: 1 };
  let summaryHtml = '';
  if (reviews.length) {
    const roundSummary = reviews.map(rv => {
      const score = ratingScore[rv.rating] || 0;
      const isPending = rv.rating === 'Pending';
      return '<div class="rv-round-row"><span class="badge status-blue" style="min-width:56px;text-align:center">第' + rv.round + '轮</span><span class="badge ' + (isPending ? 'gray' : score >= 3.5 ? 'green' : score >= 2 ? 'gray' : 'red') + '">' + escapeHtml(rv.rating || "-") + '</span>' + (rv.interviewer ? '<span class="muted" style="font-size:12px">' + escapeHtml(rv.interviewer) + '</span>' : '') + '<span class="spacer"></span><span class="muted" style="font-size:11px">' + escapeHtml(toBjTime(rv.createdAt || "").slice(0, 10)) + '</span></div>';
    }).join("");

    summaryHtml = '<div class="card review-summary"><div style="font-weight:900;margin-bottom:8px">面试评级汇总</div><div class="divider"></div>' + roundSummary + '</div>';
  }

  const scheduleHtml = schedules.length ? schedules.map((x) => {
    const roundPassStatus = x.round === 1 ? "一面通过" : x.round === 2 ? "二面通过" : x.round === 3 ? "三面通过" : x.round === 4 ? "四面通过" : "五面通过";
    const reviewLinkBtn = x.reviewToken ? '<a class="btn sm" href="/review/' + escapeHtml(x.reviewToken) + '" target="_blank" style="background:rgba(51,112,255,.08);color:#3370ff">📝 面评链接</a>' : '';
    const recBtn = x.recordingUrl ? '<a class="btn sm" href="' + escapeHtml(x.recordingUrl) + '" target="_blank" style="background:rgba(59,130,246,.08);color:#1d4ed8">🎬 会议录制</a>' : '';
    // 把 scheduledAt 转换为 date 和 time 部分，供编辑时填充
    const scAtRaw = x.scheduledAt || "";
    const scDateVal = scAtRaw.slice(0, 10); // "2026-04-01"
    const scTimeVal = scAtRaw.length >= 16 ? scAtRaw.slice(11, 16) : ""; // "14:00"
    // 安全转义面试官字符串
    const ivEsc = (x.interviewers || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const linkEsc = (x.link || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const locEsc = (x.location || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const hasCalendar = !!(x.calendarEventId);
    return '<div class="card compact" style="padding:12px;border-radius:14px;margin-bottom:10px"><div class="row"><b>第' + x.round + '轮</b><span class="pill"><span class="muted">时间</span><b>' + escapeHtml(toBjTime(x.scheduledAt || "") || "-") + '</b></span>' + (hasCalendar ? '<span class="pill" style="background:rgba(51,112,255,.08);color:#3370ff">📅 飞书日历</span>' : '') + '<span class="spacer"></span><span class="muted">' + escapeHtml(toBjTime(x.updatedAt || x.createdAt || "").slice(0, 16)) + '</span></div><div class="divider"></div><div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap"><span class="muted">面试官：</span>' + renderIvAvatars(x.interviewers) + '</div><div class="muted">地点/形式：' + escapeHtml(x.location || "-") + '</div>' + (x.link ? '<div class="muted">链接：<a class="btn sm" target="_blank" href="' + escapeHtml(x.link) + '">打开</a></div>' : "") + (reviewLinkBtn || recBtn ? '<div class="row" style="gap:6px;margin-top:6px">' + reviewLinkBtn + recBtn + '</div>' : '') + '<div class="divider"></div><div class="row" style="gap:6px"><button class="btn sm" style="background:rgba(22,163,74,.1);color:#16a34a" onclick="quickStatus(\'' + escapeHtml(roundPassStatus) + '\')">✓ 标记通过</button><button class="btn sm" style="background:rgba(239,68,68,.1);color:#ef4444" onclick="quickStatus(\'淘汰\')">✗ 淘汰</button>' + (x.round < 5 ? '<button class="btn sm" onclick="prefillNextRound(' + (x.round + 1) + ')">安排第' + (x.round + 1) + '轮</button>' : '') + '<span class="spacer"></span><button class="btn sm" style="background:rgba(51,112,255,.1);color:#3370ff" onclick="editSchedule(' + x.round + ',\'' + scDateVal + '\',\'' + scTimeVal + '\',\'' + ivEsc + '\',\'' + linkEsc + '\',\'' + locEsc + '\',' + (hasCalendar ? 'true' : 'false') + ')">✏ 编辑</button><button class="btn sm" style="background:rgba(239,68,68,.08);color:#ef4444" onclick="deleteSchedule(\'' + escapeHtml(x.id) + '\',' + x.round + ',' + (hasCalendar ? 'true' : 'false') + ')">🗑 删除</button></div></div>';
  }).join("") : '<div class="muted">暂无面试安排</div>';

  const reviewHtml = reviews.length ? reviews.map((x) => {
    const rvUser = x.interviewer ? uAvatarMap[x.interviewer] : null;
    const rvAvColors = ["#7c5cfc","#3370ff","#f5222d","#fa8c16","#52c41a","#4e7bf6"];
    const rvAvCi = x.interviewer ? x.interviewer.charCodeAt(0) % rvAvColors.length : 0;
    const rvAvatar = x.interviewer ? (rvUser && rvUser.avatar ? '<img src="' + escapeHtml(rvUser.avatar) + '" style="width:18px;height:18px;border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:3px">' : '<span style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;background:' + rvAvColors[rvAvCi] + ';color:#fff;font-size:9px;font-weight:700;vertical-align:middle;margin-right:3px">' + escapeHtml(x.interviewer.slice(0, 1)) + '</span>') : '';
    return '<div class="card compact" style="padding:12px;border-radius:14px;margin-bottom:10px"><div class="row"><b>第' + x.round + '轮</b><span class="pill"><span class="muted">评级</span><b>' + escapeHtml(x.rating || "-") + '</b></span>' + (x.interviewer ? '<span class="pill"><span class="muted">面试官</span>' + rvAvatar + '<b style="vertical-align:middle">' + escapeHtml(x.interviewer) + '</b></span>' : '') + '<span class="spacer"></span><span class="muted">' + escapeHtml(toBjTime(x.createdAt || "").slice(0, 16)) + '</span></div><div class="divider"></div><div style="margin-bottom:6px"><b>Pros</b><div class="muted">' + escapeHtml(x.pros || "-").replaceAll("\n", "<br/>") + '</div></div><div style="margin-bottom:6px"><b>Cons</b><div class="muted">' + escapeHtml(x.cons || "-").replaceAll("\n", "<br/>") + '</div></div><div><b>下一轮考察点</b><div class="muted">' + escapeHtml(x.focusNext || "-").replaceAll("\n", "<br/>") + '</div></div></div>';
  }).join("") : '<div class="muted">暂无面评</div>';

  const eventHtml = events.length ? '<div class="timeline">' + events.map((e) => '<div class="titem"><div class="tmeta"><b>' + escapeHtml(e.actor || "系统") + '</b><span class="pill"><span class="muted">时间</span><b>' + escapeHtml(e.createdAt || "") + '</b></span><span class="pill"><span class="muted">类型</span><b>' + escapeHtml(e.type || "-") + '</b></span></div><div class="tmsg">' + escapeHtml(e.message || "").replaceAll("\n", "<br/>") + '</div></div>').join("") + '</div>' : '<div class="muted">暂无动态</div>';

  const offerHtml = '<div class="card compact" style="padding:12px;border-radius:14px">' + (offer ? '<div class="row"><div style="font-weight:900">当前Offer</div><span class="spacer"></span>' + offerStatusBadge(offer.offerStatus) + '</div><div class="divider"></div><div class="row" style="margin-bottom:8px"><span class="pill"><span class="muted">薪资</span><b>' + escapeHtml(offer.salary || "-") + '</b></span><span class="pill"><span class="muted">入职日期</span><b>' + escapeHtml(offer.startDate || "-") + '</b></span></div><div class="muted">' + escapeHtml(offer.salaryNote || "") + '</div><div class="muted">' + escapeHtml(offer.note || "") + '</div><div class="divider"></div>' : '<div style="font-weight:900;margin-bottom:8px">Offer管理</div>') +
    '<form method="POST" action="/api/candidates/' + encodeURIComponent(c.id) + '/offer"><div class="row" style="gap:10px"><div class="field" style="min-width:160px"><label>薪资（月薪/年薪）</label><input name="salary" value="' + escapeHtml(offer?.salary || "") + '" placeholder="25K*15" /></div><div class="field" style="min-width:160px"><label>入职日期</label><input name="startDate" type="date" value="' + escapeHtml(offer?.startDate || "") + '" /></div><div class="field" style="min-width:140px"><label>Offer状态</label><select name="offerStatus">' + offerStOpts + '</select></div></div><div class="field"><label>薪资备注</label><input name="salaryNote" value="' + escapeHtml(offer?.salaryNote || "") + '" placeholder="如：base+bonus+RSU" /></div><div class="field"><label>Offer备注</label><textarea name="note" rows="2">' + escapeHtml(offer?.note || "") + '</textarea></div><button class="btn primary" type="submit">保存Offer</button></form></div>';

  const cid = encodeURIComponent(c.id);
  const isAdmin = req.user?.role === "admin";

  // 顶部操作栏
  const topActions = (feishuEnabled() ? '<button class="btn sm" onclick="sendNotify()" id="notifyBtn" style="background:rgba(59,130,246,.08);color:#1d4ed8">发送飞书通知</button>' : '') +
    '<a class="btn" href="/candidates/board">去看板</a>' +
    (isAdmin ? '<form method="POST" action="/candidates/' + cid + '/delete" style="display:inline" onsubmit="return confirm(\'确定删除此候选人及所有关联数据？\')"><button class="btn danger sm" type="submit">删除</button></form>' : '');

  // "信息"tab — 所有登录用户可编辑
  const infoPanel = '<div class="tabpanel active" id="panel-info"><div class="divider"></div><div class="grid"><div class="card compact"><div style="font-weight:900;margin-bottom:8px">编辑信息</div><div class="field"><label>姓名</label><input id="editName" value="' + escapeHtml(c.name || "") + '" /></div><div class="field"><label>手机</label><input id="editPhone" value="' + escapeHtml(c.phone || "") + '" /></div><div class="field"><label>邮箱</label><input id="editEmail" value="' + escapeHtml(c.email || "") + '" /></div>' +
    '<div class="field"><label>来源</label><select id="editSource" onchange="editSourceChange()">' + detailSrcOpts + '</select></div>' +
    '<div class="field" id="editFieldVendor" style="display:none"><label>猎头供应商</label><select id="editVendor"><option value="">-- 请选择供应商 --</option></select><div class="muted" style="margin-top:4px">如需新增供应商，请前往<a href="/settings" style="color:var(--primary)">设置 → 猎头管理</a></div></div>' +
    '<div class="field" id="editFieldReferrer" style="display:none"><label>内推人</label><select id="editReferrerSelect"><option value="">-- 请选择内推人 --</option></select></div>' +
    '<div class="field"><label>备注</label><textarea id="editNote" rows="4">' + escapeHtml(c.note || "") + '</textarea></div><button class="btn primary" onclick="saveCandidate()">保存</button></div><div class="card compact"><div style="font-weight:900;margin-bottom:8px">状态流转</div><div class="field"><label>候选人状态</label><select id="statusSelect">' + statusOptions + '</select></div><button class="btn primary" onclick="updateStatus()">更新状态</button><div class="divider" style="margin:16px 0"></div><div style="font-weight:900;margin-bottom:8px">更换岗位</div><div class="field"><label>应聘岗位</label><select id="jobSelect">' + jobOptions + '</select></div><button class="btn primary" onclick="updateJob()">更换岗位</button></div></div></div>';

  // "面试安排"tab — member 只显示已有安排（无新增表单和快捷按钮）
  const scheduleViewHtml = schedules.length ? schedules.map((x) => {
    const reviewLinkBtn = x.reviewToken ? '<a class="btn sm" href="/review/' + escapeHtml(x.reviewToken) + '" target="_blank" style="background:rgba(51,112,255,.08);color:#3370ff">📝 面评链接</a>' : '';
    const recBtn = x.recordingUrl ? '<a class="btn sm" href="' + escapeHtml(x.recordingUrl) + '" target="_blank" style="background:rgba(59,130,246,.08);color:#1d4ed8">🎬 会议录制</a>' : '';
    return '<div class="card compact" style="padding:12px;border-radius:14px;margin-bottom:10px"><div class="row"><b>第' + x.round + '轮</b><span class="pill"><span class="muted">时间</span><b>' + escapeHtml(toBjTime(x.scheduledAt || "") || "-") + '</b></span><span class="spacer"></span><span class="muted">' + escapeHtml(toBjTime(x.updatedAt || x.createdAt || "").slice(0, 16)) + '</span></div><div class="divider"></div><div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap"><span class="muted">面试官：</span>' + renderIvAvatars(x.interviewers) + '</div><div class="muted">地点/形式：' + escapeHtml(x.location || "-") + '</div>' + (x.link ? '<div class="muted">链接：<a class="btn sm" target="_blank" href="' + escapeHtml(x.link) + '">打开</a></div>' : "") + (reviewLinkBtn || recBtn ? '<div class="row" style="gap:6px;margin-top:6px">' + reviewLinkBtn + recBtn + '</div>' : '') + '</div>';
  }).join("") : '<div class="muted">暂无面试安排</div>';

  // "面试安排"tab — 所有登录用户可编辑
  // 时间选择器 — 轮轴滚动样式
  const timePickerWidget = '';
  const schedulePanel = '<div class="tabpanel" id="panel-schedule"><div class="divider"></div><div class="card compact" style="padding:16px;border-radius:14px"><div style="font-weight:900;font-size:15px;margin-bottom:12px">新增/更新面试安排</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:10px">' +
        '<div class="field"><label>轮次</label><select id="scRound">' + roundOpts + '</select></div>' +
        '<div class="field"><label>面试日期</label><input id="scDate" type="date" /></div>' +
        '<div class="field"><label>面试时间</label>' +
          '<div style="display:flex;align-items:center;gap:8px">' +
            '<div style="position:relative;flex:1" id="scStartWrap">' +
              '<div id="scStartBtn" onclick="tpToggle(\'start\')" style="height:34px;border:1.5px solid #e5e7eb;border-radius:8px;background:#fff;font-size:14px;font-weight:600;color:#1f2937;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:border-color .15s">09:00</div>' +
              '<div id="scStartDrop" style="display:none;position:absolute;top:calc(100% + 4px);left:50%;transform:translateX(-50%);width:180px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.12);z-index:1000;overflow:hidden">' +
                '<div id="scStartList" style="max-height:240px;overflow-y:auto;padding:4px 0"></div>' +
              '</div>' +
            '</div>' +
            '<span style="color:#9ca3af;flex-shrink:0">—</span>' +
            '<div style="position:relative;flex:1" id="scEndWrap">' +
              '<div id="scEndBtn" onclick="tpToggle(\'end\')" style="height:34px;border:1.5px solid #e5e7eb;border-radius:8px;background:#fff;font-size:14px;font-weight:600;color:#1f2937;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:border-color .15s">10:00</div>' +
              '<div id="scEndDrop" style="display:none;position:absolute;top:calc(100% + 4px);left:50%;transform:translateX(-50%);width:200px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.12);z-index:1000;overflow:hidden">' +
                '<div id="scEndList" style="max-height:240px;overflow-y:auto;padding:4px 0"></div>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<input id="scAt" type="hidden" /><input id="scEndAt" type="hidden" />' +
      '<div class="field"><label>面试官 <span class="muted" style="font-size:12px">（从通讯录选择，可多选）</span></label>' +
      '<div id="interviewerPicker" style="position:relative">' +
        '<div id="selectedInterviewers" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px"></div>' +
        '<input id="scInterviewerSearch" placeholder="搜索面试官姓名..." autocomplete="off" style="width:100%" />' +
        '<div id="interviewerDropdown" style="display:none;position:absolute;z-index:100;left:0;right:0;top:100%;max-height:200px;overflow-y:auto;background:#fff;border:1px solid #e5e7eb;border-radius:10px;box-shadow:0 4px 12px rgba(0,0,0,.1)"></div>' +
      '</div></div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">' +
        '<div class="field"><label>会议链接</label><input id="scLink" placeholder="可选" /></div>' +
        '<div class="field"><label>地点/形式</label><input id="scLocation" placeholder="如：线上/会议室A" /></div>' +
      '</div>' +
      '<div class="field"><label>同步状态</label><select id="scSyncStatus">' + syncOpts + '</select></div>' +
      '<button class="btn primary" onclick="saveSchedule()" style="width:100%">保存面试安排</button></div><div style="height:12px"></div>' + scheduleHtml + '</div>';

  // "简历"tab — 所有登录用户可上传（简历预览区域由前端动态加载新 URL，避免 signed URL 过期）
  const resumePanel = '<div class="tabpanel" id="panel-resume"><div class="divider"></div><div class="row"><div style="font-weight:900">上传简历</div><span class="spacer"></span><a class="btn" id="resumeNewWindowBtn" href="#" target="_blank" rel="noreferrer" style="display:none">新窗口打开</a></div><div class="divider"></div><form id="resumeUploadForm" enctype="multipart/form-data"><div class="row"><input type="file" name="resume" accept=".pdf,.png,.jpg,.jpeg,.webp" /><button class="btn primary" type="submit">上传</button></div></form><div class="divider"></div><div id="resumePreviewArea"><div class="muted" style="text-align:center;padding:32px 0">加载简历中...</div></div></div>';

  // "面评"tab — 所有角色都可提交面评
  const ratingColorMap = {"S":"#34c724","A":"#3370ff","B+":"#3370ff","B":"#8f959e","B-":"#ff7d00","C":"#f54a45","Pending":"#8f959e"};
  const reviewHtmlEnhanced = reviews.length ? reviews.map((x) => {
    const conclusionColor = x.conclusion === '不通过' ? '#f54a45' : x.conclusion === 'Pending' ? '#8f959e' : '#34c724';
    const conclusionLabel = x.conclusion || '通过';
    const prosEsc = (x.pros || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n");
    const consEsc = (x.cons || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n");
    const focusEsc = (x.focusNext || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n");
    const ivEsc = (x.interviewer || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const ratingEsc = (x.rating || "").replace(/'/g, "\\'");
    const conclusionEsc = conclusionLabel.replace(/'/g, "\\'");
    return '<div class="card compact" style="padding:14px;border-radius:14px;margin-bottom:10px"><div class="row"><b>第' + x.round + '轮</b><span class="pill"><span class="muted">结论</span><b style="color:' + conclusionColor + '">' + escapeHtml(conclusionLabel) + '</b></span><span class="pill"><span class="muted">评级</span><b style="color:' + (ratingColorMap[x.rating] || "#8f959e") + '">' + escapeHtml(x.rating || "-") + '</b></span>' + (x.interviewer ? '<span class="pill"><span class="muted">面试官</span><b>' + escapeHtml(x.interviewer) + '</b></span>' : '') + '<span class="spacer"></span><span class="muted">' + escapeHtml(toBjTime(x.createdAt || "").slice(0, 16)) + '</span><button class="btn sm" onclick="editReview(\'' + escapeHtml(x.id) + '\',' + x.round + ',\'' + ratingEsc + '\',\'' + conclusionEsc + '\',\'' + ivEsc + '\',\'' + prosEsc + '\',\'' + consEsc + '\',\'' + focusEsc + '\')" style="background:rgba(51,112,255,.08);color:#3370ff;margin-left:8px">编辑</button><button class="btn sm" onclick="deleteReview(\'' + escapeHtml(x.id) + '\')" style="background:rgba(239,68,68,.08);color:#ef4444;margin-left:4px">删除</button></div><div class="divider"></div><div style="margin-bottom:6px"><b style="color:var(--green)">✓ Pros</b><div class="muted" style="margin-top:4px">' + escapeHtml(x.pros || "-").replaceAll("\n", "<br/>") + '</div></div><div style="margin-bottom:6px"><b style="color:var(--red)">✗ Cons</b><div class="muted" style="margin-top:4px">' + escapeHtml(x.cons || "-").replaceAll("\n", "<br/>") + '</div></div><div><b style="color:var(--primary)">→ 下一轮考察</b><div class="muted" style="margin-top:4px">' + escapeHtml(x.focusNext || "-").replaceAll("\n", "<br/>") + '</div></div></div>';
  }).join("") : '<div class="muted">暂无面评</div>';

  const reviewPanel = '<div class="tabpanel" id="panel-review"><div class="divider"></div><div class="card compact" style="padding:14px;border-radius:14px"><div class="row"><div style="font-weight:900">新增/更新面评</div></div><div class="divider"></div><div class="row" style="gap:10px"><div class="field" style="min-width:120px"><label>轮次</label><select id="rvRound">' + roundOpts + '</select></div><div class="field" style="min-width:120px"><label>综合评级 <span class="muted" style="font-size:11px">S=不可错过 C=不录用</span></label><select id="rvRating"><option value="">请选择</option>' + rtOpts + '</select></div><div class="field" style="min-width:140px"><label>面试结论</label><select id="rvConclusion"><option value="通过">通过</option><option value="不通过">不通过</option><option value="Pending">Pending</option></select></div></div><div class="field"><label>面试官</label><input id="rvInterviewer" list="interviewer-datalist" placeholder="填写面试官姓名" value="' + escapeHtml(req.user?.name || '') + '" /></div><div class="divider"></div><div class="field"><label>✓ Pros（优势与亮点）</label><textarea id="rvPros" rows="3" placeholder="候选人的优势和亮点"></textarea></div><div class="field"><label>✗ Cons（不足与风险）</label><textarea id="rvCons" rows="3" placeholder="候选人的不足和风险"></textarea></div><div class="field"><label>→ 下一轮考察点</label><textarea id="rvFocusNext" rows="3" placeholder="如果进入下一轮，需要重点考察的方向"></textarea></div><button class="btn primary" onclick="addReview()">提交面评</button></div><div style="height:12px"></div>' + reviewHtmlEnhanced + '</div>';

  // "Offer"tab — 所有登录用户可编辑
  const offerPanel = '<div class="tabpanel" id="panel-offer"><div class="divider"></div>' + offerHtml + '</div>';

  // "备注"tab — 公开备注 + 私密备注（仅自己可见）
  const uid = req.user?.openId || req.user?.id || "";
  const publicNotes = (d.notes || []).filter(n => n.candidateId === c.id && n.visibility === "public").sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  const privateNotes = (d.notes || []).filter(n => n.candidateId === c.id && n.visibility === "private" && n.authorId === uid).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  const renderNoteItems = (notes) => {
    if (!notes.length) return '<div class="muted" style="padding:16px 0;text-align:center;font-size:13px">暂无备注</div>';
    return notes.map(n => {
      const time = toBjTime(n.createdAt || "").slice(0, 16);
      return '<div style="padding:10px 14px;background:#f9fafb;border-radius:10px;margin-bottom:8px;border:1px solid #f0f0f0">' +
        '<div style="display:flex;align-items:center;justify-content:between;margin-bottom:6px">' +
        '<span style="font-weight:600;font-size:13px;color:#374151">' + escapeHtml(n.authorName || "未知") + '</span>' +
        '<span style="margin-left:auto;font-size:11px;color:#9ca3af">' + escapeHtml(time) + '</span>' +
        '<span onclick="deleteNote(\'' + escapeHtml(n.id) + '\')" style="margin-left:8px;cursor:pointer;font-size:12px;color:#d1d5db;padding:2px 6px;border-radius:4px" onmouseover="this.style.color=\'#ef4444\'" onmouseout="this.style.color=\'#d1d5db\'">&times;</span>' +
        '</div>' +
        '<div style="font-size:14px;color:#374151;line-height:1.6;white-space:pre-wrap">' + escapeHtml(n.content) + '</div>' +
        '</div>';
    }).join("");
  };

  const notesPanel = '<div class="tabpanel" id="panel-notes"><div class="divider"></div>' +
    '<div class="grid" style="gap:16px">' +
    // 公开备注
    '<div class="card compact" style="padding:16px;border-radius:14px">' +
    '<div style="display:flex;align-items:center;margin-bottom:12px"><span style="font-weight:900;font-size:15px">📋 公开备注</span><span class="badge gray" style="margin-left:8px;font-size:11px">所有人可见</span></div>' +
    '<div id="publicNotesList">' + renderNoteItems(publicNotes) + '</div>' +
    '<div style="margin-top:10px">' +
    '<textarea id="publicNoteInput" rows="3" placeholder="输入公开备注..." style="width:100%;padding:10px 12px;border:1px solid #e5e7eb;border-radius:10px;font-size:14px;resize:vertical;font-family:inherit;box-sizing:border-box"></textarea>' +
    '<button class="btn primary" onclick="saveNote(\'public\')" style="margin-top:8px;border-radius:10px">添加备注</button>' +
    '</div>' +
    '</div>' +
    // 私密备注
    '<div class="card compact" style="padding:16px;border-radius:14px;background:#faf5ff;border:1px solid #ede9fe">' +
    '<div style="display:flex;align-items:center;margin-bottom:12px"><span style="font-weight:900;font-size:15px">🔒 私密备注</span><span class="badge" style="margin-left:8px;font-size:11px;background:#ede9fe;color:#7c3aed">仅自己可见</span></div>' +
    '<div id="privateNotesList">' + renderNoteItems(privateNotes) + '</div>' +
    '<div style="margin-top:10px">' +
    '<textarea id="privateNoteInput" rows="3" placeholder="输入私密备注（仅自己可见）..." style="width:100%;padding:10px 12px;border:1px solid #ddd6fe;border-radius:10px;font-size:14px;resize:vertical;font-family:inherit;box-sizing:border-box;background:#fff"></textarea>' +
    '<button class="btn" onclick="saveNote(\'private\')" style="margin-top:8px;border-radius:10px;background:#7c3aed;color:#fff">添加私密备注</button>' +
    '</div>' +
    '</div>' +
    '</div>' +
    '</div>';

  // admin 专用 JS 函数
  // 所有登录用户可用的 JS 函数
  const adminScripts =
    // 来源联动数据
    'var EDIT_HUNTERS=' + detailHunterOptsJson + ';' +
    'var EDIT_USERS=' + detailUsersJson + ';' +
    // 来源联动函数（含回填当前值）
    'function editSourceChange(){' +
    '  var src=document.getElementById("editSource").value;' +
    '  var fv=document.getElementById("editFieldVendor");' +
    '  var fr=document.getElementById("editFieldReferrer");' +
    '  fv.style.display=(src==="猎头")?"":"none";' +
    '  fr.style.display=(src==="内推")?"":"none";' +
    '  if(src==="猎头"){' +
    '    var sel=document.getElementById("editVendor");' +
    '    sel.innerHTML=\'<option value="">-- 请选择供应商 --</option>\'+EDIT_HUNTERS.map(function(h){return\'<option value="\'+h.id+\'">\'+h.label+\'</option>\'}).join("");' +
    '    sel.value="' + escapeHtml(currentVendorId) + '";' +
    '  }' +
    '  if(src==="内推"){' +
    '    var sel=document.getElementById("editReferrerSelect");' +
    '    sel.innerHTML=\'<option value="">-- 请选择内推人 --</option>\'+EDIT_USERS.map(function(u){return\'<option value="\'+u.id+\'">\'+u.label+\'</option>\'}).join("");' +
    '    sel.value="' + escapeHtml(currentReferrerId) + '";' +
    '  }' +
    '}' +
    'editSourceChange();' +
    'async function saveCandidate(){' +
    '  var src=document.getElementById("editSource").value;' +
    '  var vendorId="",referrerId="",referrerName="";' +
    '  if(src==="猎头"){vendorId=document.getElementById("editVendor").value}' +
    '  if(src==="内推"){var rsel=document.getElementById("editReferrerSelect");referrerId=rsel.value;referrerName=rsel.selectedIndex>0?rsel.options[rsel.selectedIndex].text:""}' +
    '  var payload={name:document.getElementById("editName").value,phone:document.getElementById("editPhone").value,email:document.getElementById("editEmail").value,source:src,vendorId:vendorId,referrerId:referrerId,referrer:referrerName,note:document.getElementById("editNote").value};' +
    '  var res=await fetch("/api/candidates/' + cid + '",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});' +
    '  if(res.ok)location.reload();else{var d=await res.json().catch(function(){return{}});alert(d.error||"保存失败")}' +
    '}' +
      'async function updateStatus(){var v=document.getElementById("statusSelect").value;var res=await fetch("/api/candidates/' + cid + '/status",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:v})});if(res.ok)location.reload();else{var d=await res.json().catch(function(){return{}});alert(d.error||"更新失败")}}' +
      'async function updateJob(){var v=document.getElementById("jobSelect").value;var res=await fetch("/api/candidates/' + cid + '/job",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jobId:v})});if(res.ok)location.reload();else{var d=await res.json().catch(function(){return{}});alert(d.error||"更换失败")}}' +
      'var _selectedInterviewers=[];' +
      'async function loadInterviewers(){try{var r=await fetch("/api/interviewers");if(r.ok){window._allInterviewers=await r.json()}else{window._allInterviewers=[]}}catch(e){window._allInterviewers=[]}}' +
      'function ivAvatar(iv,sz){sz=sz||24;if(iv.avatar)return \'<img src="\'+iv.avatar+\'" style="width:\'+sz+\'px;height:\'+sz+\'px;border-radius:50%;object-fit:cover;flex-shrink:0">\';var colors=["#7c5cfc","#3370ff","#f5222d","#fa8c16","#52c41a","#4e7bf6"];var ci=iv.name.charCodeAt(0)%colors.length;return \'<span style="width:\'+sz+\'px;height:\'+sz+\'px;border-radius:50%;background:\'+colors[ci]+\';color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:\'+(sz*0.45)+\'px;font-weight:700;flex-shrink:0">\'+iv.name.slice(0,1)+\'</span>\'}' +
      'function renderSelectedInterviewers(){var c=document.getElementById("selectedInterviewers");if(!c)return;c.innerHTML=_selectedInterviewers.map(function(iv){return \'<span style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px 4px 4px;border-radius:20px;background:rgba(51,112,255,.08);color:#3370ff;font-size:13px;font-weight:600">\'+ivAvatar(iv,22)+\'<span>\'+iv.name+\'</span><span onclick="removeInterviewer(\\x27\'+iv.openId+\'\\x27)" style="cursor:pointer;opacity:.6;margin-left:2px;font-size:14px">&times;</span></span>\'}).join("")}' +
      'function removeInterviewer(oid){_selectedInterviewers=_selectedInterviewers.filter(function(x){return x.openId!==oid});renderSelectedInterviewers()}' +
      'function addInterviewer(iv){if(_selectedInterviewers.some(function(x){return x.openId===iv.openId}))return;_selectedInterviewers.push(iv);renderSelectedInterviewers();document.getElementById("scInterviewerSearch").value="";document.getElementById("interviewerDropdown").style.display="none"}' +
      'function initInterviewerPicker(){var inp=document.getElementById("scInterviewerSearch");var dd=document.getElementById("interviewerDropdown");if(!inp||!dd)return;inp.addEventListener("focus",function(){showInterviewerDropdown(inp.value)});inp.addEventListener("input",function(){showInterviewerDropdown(inp.value)});document.addEventListener("click",function(e){if(!document.getElementById("interviewerPicker").contains(e.target)){dd.style.display="none"}})}' +
      'function showInterviewerDropdown(q){var dd=document.getElementById("interviewerDropdown");var all=window._allInterviewers||[];var selectedIds=_selectedInterviewers.map(function(x){return x.openId});var filtered=all.filter(function(iv){return selectedIds.indexOf(iv.openId)===-1&&(!q||iv.name.indexOf(q)>-1||(iv.department||"").indexOf(q)>-1||(iv.jobTitle||"").indexOf(q)>-1)}).slice(0,15);if(!filtered.length){dd.style.display="none";return}dd.innerHTML=filtered.map(function(iv){var meta=((iv.department||"")+(iv.jobTitle?" · "+iv.jobTitle:"")).trim();return \'<div onclick=\\x27addInterviewer(\'+JSON.stringify(iv)+\')\\x27 style="padding:8px 12px;cursor:pointer;display:flex;align-items:center;gap:10px;border-bottom:1px solid #f3f4f6">\'+ivAvatar(iv,32)+\'<div style="min-width:0"><div style="font-weight:600;font-size:13px;color:#1f2937">\'+iv.name+\'</div>\'+(meta?\'<div style="font-size:11px;color:#9ca3af;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">\'+meta+\'</div>\':\'\')+\'</div></div>\'}).join("");dd.style.display="block"}' +
      'loadInterviewers().then(function(){initInterviewerPicker()});' +
      /* ── 下拉时间选择器 ── */
      'var _tpStart=9*60,_tpEnd=10*60,_tpOpen=null;' +
      'var _TP_SLOTS=[];for(var _s=0;_s<24*60;_s+=15)_TP_SLOTS.push(_s);' +
      'function _tpFmt(m){return String(Math.floor(m/60)).padStart(2,"0")+":"+String(m%60).padStart(2,"0")}' +
      'function _tpDur(d){if(d<=0)return"0 分钟";if(d<60)return d+" 分钟";var h=Math.floor(d/60),m=d%60;return m===0?h+" 小时":h+" 小时 "+m+" 分钟"}' +
      'function syncScAt(){var d=document.getElementById("scDate").value;document.getElementById("scAt").value=d?d+"T"+_tpFmt(_tpStart):"";document.getElementById("scEndAt").value=d?d+"T"+_tpFmt(_tpEnd):""}' +
      'document.getElementById("scDate").addEventListener("change",syncScAt);' +
      'function tpRenderList(type){' +
        'var list=document.getElementById(type==="start"?"scStartList":"scEndList");' +
        'list.innerHTML="";' +
        'var slots=type==="start"?_TP_SLOTS:_TP_SLOTS.filter(function(m){return m>_tpStart});' +
        'if(type==="end")slots=[_tpStart].concat(slots);' +
        'slots.forEach(function(m){' +
          'var sel=m===(type==="start"?_tpStart:_tpEnd);' +
          'var el=document.createElement("div");' +
          'el.style.cssText="display:flex;align-items:center;justify-content:space-between;padding:8px 14px;font-size:14px;cursor:pointer;border-radius:0;"+(sel?"background:#eef3ff;color:#3370ff;font-weight:600":"color:#1f2937");' +
          'var lbl=document.createElement("span");lbl.textContent=_tpFmt(m);el.appendChild(lbl);' +
          'if(type==="end"){var dur=document.createElement("span");dur.textContent=_tpDur(m-_tpStart);dur.style.cssText="font-size:12px;color:"+(sel?"#3370ff":"#9ca3af");el.appendChild(dur)}' +
          'el.onmouseenter=function(){if(!sel)this.style.background="#f5f8ff"};' +
          'el.onmouseleave=function(){if(!sel)this.style.background=""};' +
          'el.onclick=function(){if(type==="start"){_tpStart=m;if(_tpEnd<=_tpStart)_tpEnd=Math.min(_tpStart+60,23*60+45);document.getElementById("scStartBtn").textContent=_tpFmt(_tpStart);document.getElementById("scEndBtn").textContent=_tpFmt(_tpEnd)}else{_tpEnd=m;document.getElementById("scEndBtn").textContent=_tpFmt(_tpEnd)}tpClose();syncScAt()};' +
          'list.appendChild(el)});' +
        'var selEl=list.querySelector("[style*=eef3ff]");if(selEl)setTimeout(function(){list.scrollTop=selEl.offsetTop-list.clientHeight/2+selEl.clientHeight/2},16)' +
      '}' +
      'function tpClose(){["start","end"].forEach(function(t){var drop=document.getElementById(t==="start"?"scStartDrop":"scEndDrop");var btn=document.getElementById(t==="start"?"scStartBtn":"scEndBtn");if(drop)drop.style.display="none";if(btn){btn.style.borderColor="#e5e7eb";btn.style.background="#fff";btn.style.color="#1f2937"}});_tpOpen=null}' +
      'function tpToggle(type){if(_tpOpen===type){tpClose();return}tpClose();_tpOpen=type;var drop=document.getElementById(type==="start"?"scStartDrop":"scEndDrop");var btn=document.getElementById(type==="start"?"scStartBtn":"scEndBtn");drop.style.display="block";btn.style.borderColor="#3370ff";btn.style.background="#eef3ff";btn.style.color="#3370ff";tpRenderList(type)}' +
      'document.addEventListener("click",function(e){if(_tpOpen&&!e.target.closest("#scStartWrap")&&!e.target.closest("#scEndWrap"))tpClose()});' +
      'syncScAt();' +
      'var _scheduleSaving=false;async function saveSchedule(){syncScAt();if(_scheduleSaving)return;var atVal=document.getElementById("scAt").value;if(!atVal){alert("请选择面试日期和时间");return}_scheduleSaving=true;var btn=document.querySelector("#panel-schedule .btn.primary");if(btn){btn.textContent="保存中...";btn.disabled=true}var names=_selectedInterviewers.map(function(x){return x.name}).join(" / ");var openIds=_selectedInterviewers.map(function(x){return x.openId});var payload={round:Number(document.getElementById("scRound").value),scheduledAt:document.getElementById("scAt").value,interviewers:names,interviewerOpenIds:openIds,link:document.getElementById("scLink").value,location:document.getElementById("scLocation").value,syncStatus:document.getElementById("scSyncStatus").value,syncCalendar:"on"};try{var res=await fetch("/api/candidates/' + cid + '/schedule",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});if(res.ok){showToast("✓ 面试安排已保存，飞书日历同步中...");setTimeout(function(){location.reload()},1500)}else{var d=await res.json().catch(function(){return{}});alert(d.error||"保存失败");if(btn){btn.textContent="保存面试安排";btn.disabled=false}_scheduleSaving=false}}catch(e){alert("网络错误");if(btn){btn.textContent="保存面试安排";btn.disabled=false}_scheduleSaving=false}}' +
      'function showToast(msg,extraPromise){var t=document.createElement("div");t.style.cssText="position:fixed;top:24px;left:50%;transform:translateX(-50%);background:#16a34a;color:#fff;padding:12px 28px;border-radius:12px;font-size:15px;font-weight:600;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,.15);transition:opacity .3s";t.textContent=msg;document.body.appendChild(t);if(extraPromise){extraPromise.then(function(s){if(s)t.textContent=msg+s})}setTimeout(function(){t.style.opacity="0";setTimeout(function(){t.remove()},300)},2000)}' +
      'var f=document.getElementById("resumeUploadForm");if(f){f.onsubmit=async function(e){e.preventDefault();var fileInput=f.querySelector("input[type=file]");var file=fileInput&&fileInput.files[0];if(!file){alert("请选择文件");return}var btn=f.querySelector("button[type=submit]");if(btn){btn.textContent="上传中...";btn.disabled=true}try{var signRes=await fetch("/api/resume/upload-url",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({candidateId:"' + cid + '",fileName:file.name,contentType:file.type||"application/octet-stream"})});var signData=await signRes.json();if(!signRes.ok||!signData.signedUrl){throw new Error(signData.error||"获取上传地址失败")}var upRes=await fetch(signData.signedUrl,{method:"PUT",headers:{"Content-Type":file.type||"application/octet-stream"},body:file});if(!upRes.ok){throw new Error("文件上传失败("+upRes.status+")")}var metaRes=await fetch("/api/candidates/' + cid + '/resume-meta",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({objectName:signData.objectName,originalName:file.name,contentType:file.type||"",size:file.size,bucket:signData.bucket})});if(!metaRes.ok){var md=await metaRes.json().catch(function(){return{}});throw new Error(md.error||"保存元数据失败")}_resumeLoaded=false;await loadResumePreview();if(btn){btn.textContent="上传";btn.disabled=false}fileInput.value=""}catch(err){alert("上传失败："+err.message);if(btn){btn.textContent="上传";btn.disabled=false}}}}' +
      'async function quickStatus(st){if(!confirm("确认将状态更新为【"+st+"】？"))return;var r=await fetch("/api/candidates/' + cid + '/status",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:st})});if(r.ok)location.reload();else alert("更新失败")}' +
      'function prefillNextRound(n){switchTab("schedule");document.getElementById("scRound").value=n;document.getElementById("scDate").focus()}' +
      // Modal 编辑面试 —— 独立变量避免与新建表单冲突
      'var _mTpStart=9*60,_mTpEnd=10*60,_mSelectedInterviewers=[],_mSaving=false;' +
      'function _mTpFmt(m){return String(Math.floor(m/60)).padStart(2,"0")+":"+String(m%60).padStart(2,"0")}' +
      'function _mSyncAt(){var d=document.getElementById("mScDate").value;document.getElementById("mScAt").value=d?d+"T"+_mTpFmt(_mTpStart):"";document.getElementById("mScEndAt").value=d?d+"T"+_mTpFmt(_mTpEnd):""}' +
      'function _mRenderIvs(){var c=document.getElementById("mSelectedInterviewers");if(!c)return;c.innerHTML=_mSelectedInterviewers.map(function(iv){return\'<span style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px 4px 4px;border-radius:20px;background:rgba(51,112,255,.08);color:#3370ff;font-size:13px;font-weight:600">\'+ivAvatar(iv,22)+\'<span>\'+iv.name+\'</span><span onclick="_mRemoveIv(\\x27\'+iv.openId+\'\\x27,\\x27\'+iv.name+\'\\x27)" style="cursor:pointer;opacity:.6;margin-left:2px;font-size:14px">&times;</span></span>\'}).join("")}' +
      'function _mRemoveIv(oid,name){_mSelectedInterviewers=_mSelectedInterviewers.filter(function(x){return oid?x.openId!==oid:x.name!==name});_mRenderIvs()}' +
      'function _mAddIv(iv){if(_mSelectedInterviewers.some(function(x){return iv.openId?x.openId===iv.openId:x.name===iv.name}))return;_mSelectedInterviewers.push(iv);_mRenderIvs();var inp=document.getElementById("mIvSearch");if(inp)inp.value="";var dd=document.getElementById("mIvDropdown");if(dd)dd.style.display="none"}' +
      'function _mShowIvDrop(q){var dd=document.getElementById("mIvDropdown");if(!dd)return;var all=window._allInterviewers||[];var selIds=_mSelectedInterviewers.map(function(x){return x.openId});var filtered=all.filter(function(iv){return selIds.indexOf(iv.openId)===-1&&(!q||iv.name.indexOf(q)>-1)}).slice(0,10);if(!filtered.length){dd.style.display="none";return}dd.innerHTML=filtered.map(function(iv){return\'<div onclick=\\x27_mAddIv(\'+JSON.stringify(iv)+\')\\x27 style="padding:8px 12px;cursor:pointer;display:flex;align-items:center;gap:8px;border-bottom:1px solid #f3f4f6">\'+ivAvatar(iv,28)+\'<span style="font-size:13px;font-weight:600">\'+iv.name+\'</span></div>\'}).join("");dd.style.display="block"}' +
      // Modal 时间选择器
      'var _mTpOpen=null;' +
      'var _M_TP_SLOTS=(function(){var s=[];for(var h=0;h<24;h++)for(var m=0;m<60;m+=15)s.push(h*60+m);return s})();' +
      'function _mTpToggle(type){if(_mTpOpen===type){_mTpClose();return}_mTpClose();_mTpOpen=type;var drop=document.getElementById(type==="start"?"mScStartDrop":"mScEndDrop");var btn=document.getElementById(type==="start"?"mScStartBtn":"mScEndBtn");if(drop)drop.style.display="block";if(btn){btn.style.borderColor="#3370ff";btn.style.background="#eef3ff";btn.style.color="#3370ff"}_mTpRender(type)}' +
      'function _mTpClose(){["start","end"].forEach(function(t){var drop=document.getElementById(t==="start"?"mScStartDrop":"mScEndDrop");var btn=document.getElementById(t==="start"?"mScStartBtn":"mScEndBtn");if(drop)drop.style.display="none";if(btn){btn.style.borderColor="#e5e7eb";btn.style.background="#fafafa";btn.style.color="#1f2937"}});_mTpOpen=null}' +
      'function _mTpRender(type){var drop=document.getElementById(type==="start"?"mScStartDrop":"mScEndDrop");if(!drop)return;var slots=type==="start"?_M_TP_SLOTS:_M_TP_SLOTS.filter(function(m){return m>_mTpStart});if(type==="end")slots=[_mTpStart].concat(slots);drop.innerHTML="";drop.style.cssText="position:absolute;z-index:9999;background:#fff;border:1.5px solid #e5e7eb;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.12);max-height:220px;overflow-y:auto;min-width:120px;top:calc(100% + 4px);left:0";slots.forEach(function(m){var sel=m===(type==="start"?_mTpStart:_mTpEnd);var el=document.createElement("div");el.style.cssText="padding:8px 16px;cursor:pointer;font-size:14px;font-weight:"+(sel?"700":"400")+";color:"+(sel?"#3370ff":"#1f2937")+";background:"+(sel?"#eef3ff":"#fff");el.textContent=_mTpFmt(m);el.onmouseover=function(){if(!sel)this.style.background="#f5f3ff"};el.onmouseout=function(){if(!sel)this.style.background=sel?"#eef3ff":"#fff"};el.onclick=function(){if(type==="start"){_mTpStart=m;if(_mTpEnd<=_mTpStart)_mTpEnd=Math.min(_mTpStart+60,23*60+45);document.getElementById("mScStartBtn").textContent=_mTpFmt(_mTpStart);document.getElementById("mScEndBtn").textContent=_mTpFmt(_mTpEnd)}else{_mTpEnd=m;document.getElementById("mScEndBtn").textContent=_mTpFmt(_mTpEnd)}_mTpClose();_mSyncAt()};drop.appendChild(el)})}' +
      // 打开 Modal
      'function editSchedule(round,dateVal,timeVal,interviewers,link,location,hasCalendar){' +
        'var modal=document.getElementById("editScheduleModal");if(!modal)return;' +
        'document.getElementById("mScRound").value=round;' +
        'document.getElementById("mScDate").value=dateVal;' +
        'document.getElementById("mScLink").value=link||"";' +
        'document.getElementById("mScLocation").value=location||"";' +
        'document.getElementById("mModalTitle").textContent="✏ 编辑第"+round+"轮面试";' +
        // 时间
        'if(timeVal){var parts=timeVal.split(":");if(parts.length>=2){_mTpStart=Number(parts[0])*60+Number(parts[1]);_mTpEnd=Math.min(_mTpStart+60,23*60+45)}}' +
        'document.getElementById("mScStartBtn").textContent=_mTpFmt(_mTpStart);' +
        'document.getElementById("mScEndBtn").textContent=_mTpFmt(_mTpEnd);' +
        '_mSyncAt();' +
        // 面试官
        '_mSelectedInterviewers=[];' +
        'if(interviewers){var names=interviewers.split(/[\\/,、;]+/).map(function(n){return n.trim()}).filter(Boolean);names.forEach(function(name){var found=(window._allInterviewers||[]).find(function(x){return x.name===name});_mSelectedInterviewers.push(found||{name:name,openId:""})});}' +
        '_mRenderIvs();' +
        // 显示
        'modal.style.display="flex";' +
        'document.body.style.overflow="hidden";' +
      '}' +
      'function closeEditScheduleModal(){var modal=document.getElementById("editScheduleModal");if(modal)modal.style.display="none";document.body.style.overflow="";_mTpClose();_mSaving=false}' +
      // 保存
      'async function saveEditSchedule(){if(_mSaving)return;var atVal=document.getElementById("mScAt").value;if(!atVal){alert("请选择面试日期和时间");return}_mSaving=true;var saveBtn=document.getElementById("mSaveBtn");if(saveBtn){saveBtn.textContent="保存中...";saveBtn.disabled=true}var names=_mSelectedInterviewers.map(function(x){return x.name}).join(" / ");var openIds=_mSelectedInterviewers.map(function(x){return x.openId});var payload={round:Number(document.getElementById("mScRound").value),scheduledAt:atVal,interviewers:names,interviewerOpenIds:openIds,link:document.getElementById("mScLink").value,location:document.getElementById("mScLocation").value,syncStatus:"（不同步）",syncCalendar:"on"};try{var res=await fetch("/api/candidates/' + cid + '/schedule",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});if(res.ok){closeEditScheduleModal();showToast("✓ 面试安排已更新，飞书日历同步中...");setTimeout(function(){location.reload()},1500)}else{var d=await res.json().catch(function(){return{}});alert(d.error||"保存失败");if(saveBtn){saveBtn.textContent="保存更新";saveBtn.disabled=false}_mSaving=false}}catch(e){alert("网络错误");if(saveBtn){saveBtn.textContent="保存更新";saveBtn.disabled=false}_mSaving=false}}' +
      'async function deleteSchedule(scheduleId,round,hasCalendar){' +
        'if(!confirm("确定要删除第"+round+"轮面试安排？"+(hasCalendar?"\\n飞书日历中的日程也将同步删除。":"")))return;' +
        'try{' +
          'var r=await fetch("/api/candidates/' + cid + '/schedule/"+encodeURIComponent(scheduleId),{method:"DELETE"});' +
          'if(r.ok){' +
            'var rd=await r.json().catch(function(){return{}});' +
            'var toast=hasCalendar?(rd.calendarDeleted?"✓ 已删除，飞书日历同步删除":"✓ 已删除（飞书日历删除失败，请手动处理）"):"✓ 已删除第"+round+"轮面试安排";' +
            'showToast(toast);setTimeout(function(){location.reload()},2000)' +
          '}' +
          'else{var d=await r.json().catch(function(){return{}});alert(d.error||"删除失败")}' +
        '}catch(e){alert("网络错误")}' +
      '}' +
      'async function sendNotify(){var btn=document.getElementById("notifyBtn");if(!btn)return;var msg=prompt("飞书通知内容（发给相关面试官）：","请关注候选人 ' + escapeHtml(c.name || "") + ' 的面试安排");if(!msg)return;btn.textContent="发送中...";btn.disabled=true;try{var r=await fetch("/api/candidates/' + cid + '/notify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:msg})});if(r.ok){btn.textContent="已发送";setTimeout(function(){btn.textContent="发送飞书通知";btn.disabled=false},2000)}else{alert("发送失败");btn.textContent="发送飞书通知";btn.disabled=false}}catch(e){alert("发送失败");btn.textContent="发送飞书通知";btn.disabled=false}}' +
      /* ── 备注 Notes 功能 ── */
      'async function saveNote(vis){var inputId=vis==="private"?"privateNoteInput":"publicNoteInput";var ta=document.getElementById(inputId);var content=ta.value.trim();if(!content){alert("请输入备注内容");return}var btn=ta.parentElement.querySelector("button");var origText=btn.textContent;btn.textContent="保存中...";btn.disabled=true;try{var r=await fetch("/api/candidates/' + cid + '/notes",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({content:content,visibility:vis,mentionedUserIds:[]})});if(r.ok){location.reload()}else{var d=await r.json().catch(function(){return{}});alert(d.error||"保存失败")}}catch(e){alert("保存失败")}finally{btn.textContent=origText;btn.disabled=false}}' +
      'async function deleteNote(noteId){if(!confirm("确定删除这条备注？"))return;try{var r=await fetch("/api/candidates/' + cid + '/notes/"+encodeURIComponent(noteId),{method:"DELETE"});if(r.ok){location.reload()}else{alert("删除失败")}}catch(e){alert("删除失败")}}' +
      'var _resumeLoaded=false;' +
      'async function loadResumePreview(){if(_resumeLoaded)return;_resumeLoaded=true;var area=document.getElementById("resumePreviewArea");var btn=document.getElementById("resumeNewWindowBtn");if(!area)return;area.innerHTML=\'<div class="muted" style="text-align:center;padding:32px 0">加载简历中...</div>\';try{var r=await fetch("/api/candidates/' + cid + '/resume-url");if(!r.ok){area.innerHTML=\'<div class="muted">加载失败</div>\';_resumeLoaded=false;return}var d=await r.json();var resume=d.resume;if(!resume||!resume.url){area.innerHTML=\'<div class="muted">暂无简历</div>\';if(btn)btn.style.display="none";return}if(btn){btn.style.display="inline-flex";btn.href=resume.url}var lower=(resume.originalName||resume.filename||"").toLowerCase();if(lower.endsWith(".pdf")){area.innerHTML=\'<iframe src="\'+resume.url+\'" style="width:100%;height:75vh;border:1px solid rgba(237,233,254,.95);border-radius:14px;background:#fff"></iframe>\'}else if(lower.endsWith(".png")||lower.endsWith(".jpg")||lower.endsWith(".jpeg")||lower.endsWith(".webp")){area.innerHTML=\'<img src="\'+resume.url+\'" style="max-width:100%;border-radius:14px" />\'}else{area.innerHTML=\'<div class="muted">不支持内嵌预览</div>\'}}catch(e){area.innerHTML=\'<div class="muted">加载失败</div>\';_resumeLoaded=false}}' +
      '' +
      '';

  // 候选人进度条 — 显示当前所在流水线阶段
  const isRejected = c.status === '淘汰';
  const displayStages = PIPELINE_STAGES.filter(s => s.key !== 'rejected');
  const currentStageIdx = isRejected ? -1 : displayStages.findIndex(stage => stage.statuses.includes(c.status));
  const progressHtml = displayStages.map((stage, idx) => {
    const isCurrent = !isRejected && stage.statuses.includes(c.status);
    const isPast = !isRejected && idx < currentStageIdx && currentStageIdx >= 0;
    const cls = isCurrent ? 'progress-step active' : isPast ? 'progress-step done' : 'progress-step';
    return '<div class="' + cls + '"><div class="step-dot">' + (isPast ? '✓' : (idx + 1)) + '</div><div class="step-label">' + escapeHtml(stage.name) + '</div></div>';
  }).join('<div class="step-line"></div>');

  const avatarLetter = escapeHtml((c.name || "?").slice(0, 1));

  res.send(
    renderPage({
      title: "候选人：" + (c.name || ""),
      user: req.user,
      active: "candidates",
      contentHtml:
        // 顶部操作栏
        '<div class="row" style="margin-bottom:16px"><a class="btn" href="' + escapeHtml(backUrl) + '">← ' + escapeHtml(backLabel) + '</a><span class="spacer"></span>' + topActions + '</div>' +
        // 资料卡片 — Machinepulse招聘系统风格
        '<div class="card profile-card"><div class="profile-header">' +
        '<div class="profile-avatar" style="background:linear-gradient(135deg,#3370ff,#597ef7)">' + avatarLetter + '</div>' +
        '<div class="profile-info"><div class="profile-name">' + escapeHtml(c.name || "未命名") + ' ' + statusBadge(c.status) + ' ' + followupBadge(c.follow) + '</div>' +
        '<div class="profile-meta">' +
        '<span>📋 ' + escapeHtml(c.jobTitle || c.jobId || "未关联岗位") + '</span>' +
        '<span>📱 ' + escapeHtml(c.phone || "未填写") + '</span>' +
        '<span>📧 ' + escapeHtml(c.email || "未填写") + '</span>' +
        '<span>📍 ' + escapeHtml(c.source || "未知来源") + '</span>' +
        (c.vendorName ? '<span>🏢 供应商：' + escapeHtml(c.vendorName) + '</span>' : '') +
        (c.referrer ? '<span>👤 内推人：' + escapeHtml(c.referrer) + '</span>' : '') +
        '</div>' +
        '<div style="margin-top:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
        (resume && resume.url ? '<a class="btn sm" href="' + escapeHtml(resume.url) + '" target="_blank" rel="noreferrer" style="background:rgba(51,112,255,.08)">📎 ' + escapeHtml((resume.originalName || resume.filename || "简历").slice(0, 20)) + '</a>' : '<span class="badge status-gray">暂无简历</span>') +
        (tagsHtml ? ' ' + tagsHtml : '') +
        '</div></div></div>' +
        // 进度条
        '<div class="progress-bar">' + progressHtml + '</div>' +
        '</div>' +
        (summaryHtml ? '<div style="height:14px"></div>' + summaryHtml : '') +
        '<div style="height:14px"></div>' +
        // 标签页
        '<div class="card">' +
        '<div class="tabs"><button class="tab active" data-tab="info" onclick="switchTab(\'info\')">信息</button><button class="tab" data-tab="schedule" onclick="switchTab(\'schedule\')">面试安排</button><button class="tab" data-tab="resume" onclick="switchTab(\'resume\')">简历</button><button class="tab" data-tab="review" onclick="switchTab(\'review\')">面评</button><button class="tab" data-tab="offer" onclick="switchTab(\'offer\')">Offer</button><button class="tab" data-tab="notes" onclick="switchTab(\'notes\')">备注</button><button class="tab" data-tab="activity" onclick="switchTab(\'activity\')">动态</button></div>' +
        '<div class="tabpanels">' +
        infoPanel +
        schedulePanel +
        resumePanel +
        reviewPanel +
        offerPanel +
        notesPanel +
        '<div class="tabpanel" id="panel-activity"><div class="divider"></div>' + eventHtml + '</div>' +
        '</div></div>' +
        '<script>function switchTab(t){document.querySelectorAll(".tab").forEach(function(e){e.classList.toggle("active",e.dataset.tab===t)});document.querySelectorAll(".tabpanel").forEach(function(p){p.classList.remove("active")});document.getElementById("panel-"+t).classList.add("active");if(t==="resume"&&typeof loadResumePreview==="function")loadResumePreview()}' +
        'var _rvSubmitting=false;var _editingReviewId=null;' +
        'async function addReview(){if(_rvSubmitting)return;var rating=document.getElementById("rvRating").value;if(!rating){alert("请选择评级");return}var interviewer=document.getElementById("rvInterviewer").value.trim();if(!interviewer){alert("请填写面试官姓名");return}var pros=document.getElementById("rvPros").value.trim();var cons=document.getElementById("rvCons").value.trim();if(!pros&&!cons){alert("Pros和Cons至少填写一项");return}var btn=document.querySelector("button[onclick=\'addReview()\']");if(btn){btn.textContent="提交中...";btn.disabled=true}_rvSubmitting=true;var payload={round:Number(document.getElementById("rvRound").value),conclusion:document.getElementById("rvConclusion").value,rating:rating,interviewer:interviewer,pros:pros,cons:cons,focusNext:document.getElementById("rvFocusNext").value};var url=_editingReviewId?"/api/candidates/' + cid + '/reviews/"+_editingReviewId:"/api/candidates/' + cid + '/reviews";var res=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});if(res.ok){var data=await res.json();if(data.autoFlowMsg){alert(data.autoFlowMsg)}_editingReviewId=null;location.reload()}else{var d=await res.json().catch(function(){return{}});alert(d.error||"提交失败");if(btn){btn.textContent="提交面评";btn.disabled=false}_rvSubmitting=false}}' +
        'function editReview(id,round,rating,conclusion,interviewer,pros,cons,focusNext){_editingReviewId=id;document.getElementById("rvRound").value=round;document.getElementById("rvRating").value=rating;document.getElementById("rvConclusion").value=conclusion;document.getElementById("rvInterviewer").value=interviewer;document.getElementById("rvPros").value=pros.replace(/\\\\n/g,"\\n");document.getElementById("rvCons").value=cons.replace(/\\\\n/g,"\\n");document.getElementById("rvFocusNext").value=focusNext.replace(/\\\\n/g,"\\n");var btn=document.querySelector("button[onclick=\'addReview()\']");if(btn)btn.textContent="更新面评";switchTab("review");document.getElementById("rvRound").scrollIntoView({behavior:"smooth",block:"center"})}' +
        'async function deleteReview(id){if(!confirm("确定删除这条面评？此操作不可撤销。"))return;try{var res=await fetch("/api/candidates/' + cid + '/reviews/"+encodeURIComponent(id),{method:"DELETE",credentials:"same-origin"});if(res.ok){location.reload()}else{var d=await res.json().catch(function(){return{}});alert("删除失败："+( d.error||res.status))}}catch(e){alert("删除失败："+e.message)}}' +
        adminScripts +
        '</script>' +
        // 编辑面试 Modal
        '<div id="editScheduleModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.4);backdrop-filter:blur(3px);z-index:2000;align-items:center;justify-content:center" onclick="if(event.target===this)closeEditScheduleModal()">' +
          '<div style="background:#fff;border-radius:20px;width:460px;max-width:calc(100vw - 32px);max-height:calc(100vh - 48px);overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.15)">' +
            '<div style="display:flex;align-items:center;justify-content:space-between;padding:18px 20px 14px;border-bottom:1px solid #f0f0f0">' +
              '<div id="mModalTitle" style="font-size:15px;font-weight:700">✏ 编辑面试</div>' +
              '<button onclick="closeEditScheduleModal()" style="width:28px;height:28px;border-radius:50%;border:none;background:#f3f4f6;cursor:pointer;font-size:18px;color:#6b7280;display:flex;align-items:center;justify-content:center;line-height:1">×</button>' +
            '</div>' +
            '<div style="padding:16px 20px;display:flex;flex-direction:column;gap:14px">' +
              '<input type="hidden" id="mScAt"><input type="hidden" id="mScEndAt">' +
              '<div style="display:flex;gap:10px">' +
                '<div style="flex:1;display:flex;flex-direction:column;gap:5px"><label style="font-size:12px;font-weight:600;color:#6b7280">轮次</label><select id="mScRound" style="border:1.5px solid #e5e7eb;border-radius:10px;padding:8px 11px;font-size:14px;background:#fafafa;outline:none"><option value="1">第1轮</option><option value="2">第2轮</option><option value="3">第3轮</option><option value="4">第4轮</option><option value="5">第5轮</option></select></div>' +
                '<div style="flex:1;display:flex;flex-direction:column;gap:5px"><label style="font-size:12px;font-weight:600;color:#6b7280">日期</label><input id="mScDate" type="date" onchange="_mSyncAt()" style="border:1.5px solid #e5e7eb;border-radius:10px;padding:8px 11px;font-size:14px;background:#fafafa;outline:none;width:100%"></div>' +
              '</div>' +
              '<div style="display:flex;flex-direction:column;gap:5px">' +
                '<label style="font-size:12px;font-weight:600;color:#6b7280">时间</label>' +
                '<div style="display:flex;gap:8px;align-items:center">' +
                  '<div style="flex:1;position:relative"><div id="mScStartBtn" onclick="_mTpToggle(\'start\')" style="border:1.5px solid #e5e7eb;border-radius:10px;padding:8px 11px;font-size:14px;font-weight:600;background:#fafafa;cursor:pointer;text-align:center;transition:all .15s">09:00</div><div id="mScStartDrop" style="display:none;position:absolute;z-index:9999"></div></div>' +
                  '<span style="color:#9ca3af;font-size:13px;flex-shrink:0">→</span>' +
                  '<div style="flex:1;position:relative"><div id="mScEndBtn" onclick="_mTpToggle(\'end\')" style="border:1.5px solid #e5e7eb;border-radius:10px;padding:8px 11px;font-size:14px;font-weight:600;background:#fafafa;cursor:pointer;text-align:center;transition:all .15s">10:00</div><div id="mScEndDrop" style="display:none;position:absolute;z-index:9999"></div></div>' +
                '</div>' +
              '</div>' +
              '<div style="display:flex;flex-direction:column;gap:5px">' +
                '<label style="font-size:12px;font-weight:600;color:#6b7280">面试官</label>' +
                '<div style="border:1.5px solid #e5e7eb;border-radius:10px;padding:6px 10px;background:#fafafa;min-height:40px">' +
                  '<div id="mSelectedInterviewers" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:4px"></div>' +
                  '<div style="position:relative"><input id="mIvSearch" type="text" placeholder="搜索面试官..." oninput="_mShowIvDrop(this.value)" onfocus="_mShowIvDrop(this.value)" style="border:none;outline:none;background:transparent;font-size:13px;width:100%;padding:2px 0"><div id="mIvDropdown" style="display:none;position:absolute;z-index:9999;background:#fff;border:1.5px solid #e5e7eb;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.1);max-height:200px;overflow-y:auto;top:calc(100% + 4px);left:0;min-width:200px"></div></div>' +
                '</div>' +
              '</div>' +
              '<div style="display:flex;flex-direction:column;gap:5px"><label style="font-size:12px;font-weight:600;color:#6b7280">地点 / 形式</label><input id="mScLocation" type="text" placeholder="如：线上飞书会议 / 北京办公室" style="border:1.5px solid #e5e7eb;border-radius:10px;padding:8px 11px;font-size:14px;background:#fafafa;outline:none"></div>' +
              '<div style="display:flex;flex-direction:column;gap:5px"><label style="font-size:12px;font-weight:600;color:#6b7280">链接</label><input id="mScLink" type="text" placeholder="会议链接（选填）" style="border:1.5px solid #e5e7eb;border-radius:10px;padding:8px 11px;font-size:14px;background:#fafafa;outline:none"></div>' +
            '</div>' +
            '<div style="padding:14px 20px 18px;border-top:1px solid #f0f0f0;display:flex;gap:8px;justify-content:flex-end">' +
              '<button onclick="closeEditScheduleModal()" style="padding:8px 18px;border-radius:10px;border:none;background:#f3f4f6;color:#6b7280;font-size:14px;font-weight:600;cursor:pointer">取消</button>' +
              '<button id="mSaveBtn" onclick="saveEditSchedule()" style="padding:8px 18px;border-radius:10px;border:none;background:#3370ff;color:#fff;font-size:14px;font-weight:600;cursor:pointer">保存更新</button>' +
            '</div>' +
          '</div>' +
        '</div>',
    })
  );
});

// 删除候选人
// 删除候选人
router.post("/candidates/:id/delete", requireLogin, requireAdmin, async (req, res) => {
  try {
    const d = await loadData();
    const idx = d.candidates.findIndex((x) => x.id === req.params.id);
    if (idx > -1) {
      const cid = d.candidates[idx].id;
      d.candidates.splice(idx, 1);
      d.interviews = d.interviews.filter((x) => x.candidateId !== cid);
      d.interviewSchedules = d.interviewSchedules.filter((x) => x.candidateId !== cid);
      d.resumeFiles = d.resumeFiles.filter((x) => x.candidateId !== cid);
      d.events = d.events.filter((x) => x.candidateId !== cid);
      d.offers = (d.offers || []).filter((x) => x.candidateId !== cid);
      await saveData(d);
      try { await deleteCandidateRelated(cid); } catch (e) { console.error("[Delete] Supabase 清理失败:", e.message); }
    }
    res.redirect(303, "/candidates");
  } catch (e) {
    console.error("[Delete] 删除候选人异常:", e.message);
    res.redirect(303, "/candidates");
  }
});

export default router;
