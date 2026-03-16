import { Router } from "express";
import { requireLogin, requireAdmin } from "../auth.mjs";
import { loadData, saveData, nowIso, rid, deleteFromSupabase } from "../db.mjs";
import { renderPage, escapeHtml } from "../ui.mjs";
import { EMPLOYMENT_TYPES } from "../constants.mjs";
import { getVisibleJobIds, jobFunnelStats } from "../helpers.mjs";

const router = Router();

// 优先级配置：值、显示、颜色
const JOB_PRIORITIES = ["P00", "P0", "P1", "P1.5", "P2"];
const PRIORITY_COLORS = { "P00": "#dc2626", "P0": "#f97316", "P1": "#eab308", "P1.5": "#22c55e", "P2": "#6b7280" };
const PRIORITY_ORDER = { "P00": 0, "P0": 1, "P1": 2, "P1.5": 3, "P2": 4, "": 99 };
const STATE_ORDER = { "open": 0, "paused": 1, "closed": 2 };

router.get("/jobs", requireLogin, async (req, res) => {
  const d = await loadData();
  const catFilter = String(req.query.category || "").trim();
  const etFilter = String(req.query.et || "").trim();

  const visibleJobIds = getVisibleJobIds(req.user, d.jobs);
  let permJobs = visibleJobIds === null ? d.jobs : d.jobs.filter(j => visibleJobIds.has(j.id));
  if (etFilter) permJobs = permJobs.filter(j => (j.employmentType || "社招") === etFilter);
  let filteredJobs = catFilter ? permJobs.filter((j) => j.category === catFilter) : permJobs;
  // 排序：先按状态（开放>暂停>关闭），再按优先级
  filteredJobs = filteredJobs.slice().sort((a, b) => {
    const stateA = STATE_ORDER[a.state] ?? 2;
    const stateB = STATE_ORDER[b.state] ?? 2;
    if (stateA !== stateB) return stateA - stateB;
    return (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99);
  });

  // 招聘类型筛选 tab（社招/实习）
  const etQs = catFilter ? "&category=" + encodeURIComponent(catFilter) : "";
  const etTabs = '<a class="' + (!etFilter ? "active" : "") + '" href="/jobs?' + etQs.replace(/^&/, "") + '">全部</a>' +
    EMPLOYMENT_TYPES.map((t) => '<a class="' + (etFilter === t ? "active" : "") + '" href="/jobs?et=' + encodeURIComponent(t) + etQs + '">' + escapeHtml(t) + '</a>').join("");

  // 职位分类筛选 tab
  const jobCategories = d.categories || [];
  const catQs = etFilter ? "&et=" + encodeURIComponent(etFilter) : "";
  const catTabs = ['<a class="' + (!catFilter ? "active" : "") + '" href="/jobs?' + catQs.replace(/^&/, "") + '">全部</a>'].concat(
    jobCategories.map((c) => '<a class="' + (catFilter === c ? "active" : "") + '" href="/jobs?category=' + encodeURIComponent(c) + catQs + '">' + escapeHtml(c) + '</a>')
  ).join("");

  const rows = filteredJobs
    .map((j) => {
      const title = escapeHtml(j.title || "未命名岗位");
      const id = escapeHtml(j.id);
      const hc = escapeHtml(String(j.headcount ?? "-"));
      const loc = escapeHtml(j.location || "-");
      const et = (j.employmentType || "社招");
      const etBadge = et === "实习" ? '<span class="badge status-green" style="font-size:11px">实习</span>' : '<span class="badge status-orange" style="font-size:11px">社招</span>';
      const catBadge = j.category ? '<span class="badge status-blue" style="font-size:11px">' + escapeHtml(j.category) + '</span>' : '';
      const prioColor = PRIORITY_COLORS[j.priority] || "#9ca3af";
      const prioBadge = j.priority ? '<span style="display:inline-block;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:700;color:#fff;background:' + prioColor + '">' + escapeHtml(j.priority) + '</span>' : '';
      const st = jobFunnelStats(d, j.id);
      const stateBadge = j.state === "open" ? '<span class="badge status-green">开放</span>' : j.state === "paused" ? '<span class="badge status-orange">暂停</span>' : '<span class="badge status-gray">关闭</span>';
      const funnel =
        '<span class="pill"><span class="muted">总</span><b>' + st.total + '</b></span>' +
        '<span class="pill"><span class="muted">面试中</span><b>' + st["面试中"] + '</b></span>' +
        '<span class="pill"><span class="muted">入职</span><b>' + st["入职"] + '</b></span>';

      return '<tr><td><a class="btn sm" href="/jobs/' + id + '">' + title + '</a> ' + prioBadge + '</td><td>' + etBadge + ' ' + catBadge + '</td><td>' + loc + '</td><td>' + hc + '</td><td>' + stateBadge + '</td><td style="min-width:260px">' + funnel + '</td><td><a class="btn sm" href="/jobs/' + id + '">编辑</a> <a class="btn sm" href="/candidates?jobId=' + id + '">候选人</a></td></tr>';
    })
    .join("");

  const isAdmin = req.user?.role === "admin";
  res.send(
    renderPage({
      title: "职位管理",
      user: req.user,
      active: "jobs",
      contentHtml: '<div class="row"><div style="font-weight:900;font-size:18px">职位管理</div><span class="spacer"></span>' + (isAdmin ? '<a class="btn primary" href="/jobs/new">创建职位</a>' : '') + '</div><div class="divider"></div>' +
        '<div style="display:flex;gap:12px;align-items:center;margin-bottom:8px"><span style="font-size:13px;font-weight:600;color:#8f959e">类型</span><div class="seg">' + etTabs + '</div></div>' +
        '<div style="display:flex;gap:12px;align-items:center"><span style="font-size:13px;font-weight:600;color:#8f959e">分类</span><div class="seg">' + catTabs + '</div></div><div style="height:12px"></div>' +
        '<div class="card"><table><thead><tr><th>职位</th><th>类型</th><th>地点</th><th>HC</th><th>状态</th><th>招聘数据</th><th>操作</th></tr></thead><tbody>' + (rows || "") + '</tbody></table>' + (rows ? "" : '<div class="muted">暂无职位，先创建一个吧。</div>') + '</div>',
    })
  );
});

router.get("/jobs/new", requireLogin, requireAdmin, async (req, res) => {
  const d = await loadData();
  const catOpts = (d.categories || []).map((c) => '<option value="' + escapeHtml(c) + '">' + escapeHtml(c) + '</option>').join("");
  const etOpts = EMPLOYMENT_TYPES.map((t) => '<option value="' + escapeHtml(t) + '">' + escapeHtml(t) + '</option>').join("");
  const prioOpts = JOB_PRIORITIES.map((p) => '<option value="' + escapeHtml(p) + '">' + escapeHtml(p) + '</option>').join("");
  res.send(
    renderPage({
      title: "创建职位",
      user: req.user,
      active: "jobs",
      contentHtml: '<div class="card" style="max-width:820px;margin:0 auto;"><div style="font-weight:900;font-size:18px">创建职位</div><div class="divider"></div><form method="POST" action="/jobs/new" id="jobForm"><div class="grid"><div class="card compact"><div class="field"><label>岗位名称</label><input name="title" required placeholder="例如：行业运营" /></div><div class="field"><label>英文岗位名称</label><input name="titleEn" placeholder="用于匹配官网岗位，例如：Industry Operations" /></div><div class="field"><label>地点</label><input name="location" placeholder="例如：上海" /></div><div class="field"><label>负责人（可添加多个）</label><input type="hidden" name="ownersJson" id="ownersJson" value="[]" /><div style="position:relative"><input id="ownerSearch" placeholder="搜索飞书用户..." autocomplete="off" /><div id="ownerDropdown" style="display:none;position:absolute;top:100%;left:0;right:0;background:#fff;border:1px solid #e5e7eb;border-radius:8px;max-height:200px;overflow-y:auto;z-index:50;box-shadow:0 4px 16px rgba(0,0,0,.1)"></div></div><div id="ownerSelected" style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px"></div></div></div><div class="card compact"><div class="field"><label>HC（招聘人数）</label><input name="headcount" type="number" min="0" placeholder="例如：2" /></div><div class="field"><label>优先级</label><select name="priority"><option value="">请选择</option>' + prioOpts + '</select></div><div class="field"><label>招聘类型</label><select name="employmentType"><option value="社招">社招</option>' + etOpts + '</select></div><div class="field"><label>职位分类</label><select name="category"><option value="">请选择</option>' + catOpts + '</select></div><div class="field"><label>岗位状态</label><select name="state"><option value="open">开放</option><option value="paused">暂停</option><option value="closed">关闭</option></select></div></div></div><div class="divider"></div><div class="field"><label>JD 描述</label><textarea name="jd" rows="8" placeholder="写清职责、要求、加分项"></textarea></div><div class="row"><button class="btn primary" type="submit">创建职位</button><a class="btn" href="/jobs">返回</a></div></form></div>' +
        '<script>' +
        'var _ownerTimer=null;var _owners=[];' +
        'function addOwner(u){if(_owners.some(function(o){return o.openId===u.openId&&o.name===u.name}))return;_owners.push({name:u.name,openId:u.openId});document.getElementById("ownerSearch").value="";document.getElementById("ownerDropdown").style.display="none";renderOwnerTags()}' +
        'function removeOwner(idx){_owners.splice(idx,1);renderOwnerTags()}' +
        'function renderOwnerTags(){document.getElementById("ownersJson").value=JSON.stringify(_owners);var html=_owners.map(function(o,i){return \'<span style="display:inline-flex;align-items:center;gap:6px;background:#f3f0ff;border:1px solid #e0d4fc;border-radius:6px;padding:4px 10px;font-size:13px"><b>\'+o.name+\'</b><span onclick="removeOwner(\'+i+\')" style="cursor:pointer;color:#999;margin-left:4px">✕</span></span>\'}).join("");document.getElementById("ownerSelected").innerHTML=html}' +
        'function renderOwnerDropdown(list){if(!list.length){document.getElementById("ownerDropdown").innerHTML=\'<div style="padding:12px;color:#9ca3af;font-size:13px">未找到用户</div>\';document.getElementById("ownerDropdown").style.display="block";return}document.getElementById("ownerDropdown").innerHTML=list.map(function(u){return \'<div onclick=\\x27addOwner(\'+JSON.stringify(u).replace(/\'/g,"\\\\x27")+\')\\x27 style="padding:8px 12px;cursor:pointer;display:flex;align-items:center;gap:8px;border-bottom:1px solid #f3f4f6" onmouseover="this.style.background=\\x27#f9fafb\\x27" onmouseout="this.style.background=\\x27#fff\\x27"><span style="font-weight:600;font-size:13px">\'+u.name+\'</span><span style="font-size:11px;color:#9ca3af">\'+(u.department||"")+\' \'+(u.jobTitle||"")+\'</span></div>\'}).join("");document.getElementById("ownerDropdown").style.display="block"}' +
        'document.getElementById("ownerSearch").addEventListener("input",function(){var q=this.value.trim();clearTimeout(_ownerTimer);if(!q){document.getElementById("ownerDropdown").style.display="none";return}document.getElementById("ownerDropdown").innerHTML=\'<div style="padding:12px;color:#9ca3af;font-size:13px">搜索中...</div>\';document.getElementById("ownerDropdown").style.display="block";_ownerTimer=setTimeout(async function(){try{var r=await fetch("/api/feishu/search-users?q="+encodeURIComponent(q));if(r.ok){var list=await r.json();renderOwnerDropdown(list)}else{document.getElementById("ownerDropdown").style.display="none"}}catch(e){document.getElementById("ownerDropdown").style.display="none"}},300)});' +
        'document.addEventListener("click",function(e){if(!e.target.closest("#ownerSearch")&&!e.target.closest("#ownerDropdown"))document.getElementById("ownerDropdown").style.display="none"});' +
        '</script>',
    })
  );
});

router.post("/jobs/new", requireLogin, requireAdmin, async (req, res) => {
  const d = await loadData();
  let owners = [];
  try { owners = JSON.parse(req.body.ownersJson || "[]"); } catch(e) {}
  if (!Array.isArray(owners)) owners = [];
  owners = owners.filter(o => o && o.name).map(o => ({ name: String(o.name), openId: String(o.openId || "") }));
  const job = {
    id: rid("job"),
    title: String(req.body.title || "").trim(),
    titleEn: String(req.body.titleEn || "").trim(),
    location: String(req.body.location || "").trim(),
    owner: owners.length > 0 ? owners.map(o => o.name).join(", ") : "",
    ownerOpenId: owners.length > 0 ? owners.map(o => o.openId).join(", ") : "",
    owners,
    headcount: req.body.headcount === "" ? null : Number(req.body.headcount || 0),
    priority: String(req.body.priority || "").trim(),
    category: String(req.body.category || "").trim(),
    employmentType: String(req.body.employmentType || "社招").trim(),
    state: String(req.body.state || "open"),
    jd: String(req.body.jd || "").trim(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  d.jobs.unshift(job);
  await saveData(d);
  res.redirect(303, "/jobs/" + job.id);
});

router.get("/jobs/:id", requireLogin, async (req, res) => {
  const d = await loadData();
  const job = d.jobs.find((x) => x.id === req.params.id);
  if (!job) {
    return res.send(renderPage({ title: "岗位不存在", user: req.user, active: "jobs", contentHtml: '<div class="card"><div style="font-weight:900">岗位不存在</div><div class="divider"></div><a class="btn" href="/jobs">返回</a></div>' }));
  }
  // 权限检查：member 只能查看自己负责的岗位
  const visibleJobIds = getVisibleJobIds(req.user, d.jobs);
  if (visibleJobIds !== null && !visibleJobIds.has(job.id)) {
    return res.send(renderPage({ title: "无权限", user: req.user, active: "jobs", contentHtml: '<div class="card"><div style="font-weight:900">无权限查看该岗位</div><div class="muted">该岗位不在您的负责范围内</div><div class="divider"></div><a class="btn" href="/jobs">返回</a></div>' }));
  }

  const catOpts = (d.categories || []).map((c) => '<option value="' + escapeHtml(c) + '" ' + (job.category === c ? "selected" : "") + '>' + escapeHtml(c) + '</option>').join("");
  const etOpts2 = EMPLOYMENT_TYPES.map((t) => '<option value="' + escapeHtml(t) + '" ' + ((job.employmentType || "社招") === t ? "selected" : "") + '>' + escapeHtml(t) + '</option>').join("");
  const prioOpts2 = JOB_PRIORITIES.map((p) => '<option value="' + escapeHtml(p) + '" ' + (job.priority === p ? "selected" : "") + '>' + escapeHtml(p) + '</option>').join("");
  const st = jobFunnelStats(d, job.id);
  const funnel = '<span class="pill"><span class="muted">总</span><b>' + st.total + '</b></span><span class="pill"><span class="muted">待筛选</span><b>' + st["待筛选"] + '</b></span><span class="pill"><span class="muted">面试中</span><b>' + st["面试中"] + '</b></span><span class="pill"><span class="muted">Offer</span><b>' + st["Offer发放"] + '</b></span><span class="pill"><span class="muted">入职</span><b>' + st["入职"] + '</b></span><span class="pill"><span class="muted">淘汰</span><b>' + st["淘汰"] + '</b></span>';

  const isAdmin = req.user?.role === "admin";
  const deleteBtn = isAdmin
    ? '<form method="POST" action="/jobs/' + escapeHtml(job.id) + '/delete" style="display:inline" onsubmit="return confirm(\'确定删除此职位？\')"><button class="btn danger sm" type="submit">删除职位</button></form>'
    : '';

  // 构建已有负责人列表：优先用 owners 数组，否则兼容旧的单负责人
  const existingOwners = (Array.isArray(job.owners) && job.owners.length > 0)
    ? job.owners
    : (job.owner ? [{ name: job.owner, openId: job.ownerOpenId || "" }] : []);
  const ownersInitJson = JSON.stringify(existingOwners).replace(/"/g, '&quot;');

  const jobBodyHtml = '<div class="card" style="max-width:980px;margin:0 auto;"><div class="muted">填写 & 修改岗位信息</div><div class="divider"></div><form method="POST" action="/jobs/' + escapeHtml(job.id) + '" id="jobForm"><div class="grid"><div class="card compact"><div class="field"><label>岗位名称</label><input name="title" value="' + escapeHtml(job.title || "") + '" /></div><div class="field"><label>英文岗位名称</label><input name="titleEn" value="' + escapeHtml(job.titleEn || "") + '" placeholder="用于匹配官网岗位" /></div><div class="field"><label>地点</label><input name="location" value="' + escapeHtml(job.location || "") + '" /></div><div class="field"><label>负责人（可添加多个）</label><input type="hidden" name="ownersJson" id="ownersJson" value="' + ownersInitJson + '" /><div style="position:relative"><input id="ownerSearch" placeholder="搜索飞书用户..." autocomplete="off" /><div id="ownerDropdown" style="display:none;position:absolute;top:100%;left:0;right:0;background:#fff;border:1px solid #e5e7eb;border-radius:8px;max-height:200px;overflow-y:auto;z-index:50;box-shadow:0 4px 16px rgba(0,0,0,.1)"></div></div><div id="ownerSelected" style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px"></div></div></div><div class="card compact"><div class="field"><label>HC（招聘人数）</label><input name="headcount" type="number" min="0" value="' + escapeHtml(job.headcount ?? "") + '" /></div><div class="field"><label>优先级</label><select name="priority"><option value="">请选择</option>' + prioOpts2 + '</select></div><div class="field"><label>招聘类型</label><select name="employmentType">' + etOpts2 + '</select></div><div class="field"><label>职位分类</label><select name="category"><option value="">请选择</option>' + catOpts + '</select></div><div class="field"><label>岗位状态</label><select name="state"><option value="open" ' + (job.state === "open" ? "selected" : "") + '>开放</option><option value="paused" ' + (job.state === "paused" ? "selected" : "") + '>暂停</option><option value="closed" ' + (job.state === "closed" ? "selected" : "") + '>关闭</option></select></div></div></div><div class="divider"></div><div class="field"><label>JD 描述</label><textarea name="jd" rows="10">' + escapeHtml(job.jd || "") + '</textarea></div><div class="row"><button class="btn primary" type="submit">保存岗位信息</button><a class="btn" href="/jobs">返回列表</a></div></form></div>' +
    '<script>' +
    'var _ownerTimer=null;var _owners=JSON.parse(document.getElementById("ownersJson").value||"[]");renderOwnerTags();' +
    'function addOwner(u){if(_owners.some(function(o){return o.openId===u.openId&&o.name===u.name}))return;_owners.push({name:u.name,openId:u.openId});document.getElementById("ownerSearch").value="";document.getElementById("ownerDropdown").style.display="none";renderOwnerTags()}' +
    'function removeOwner(idx){_owners.splice(idx,1);renderOwnerTags()}' +
    'function renderOwnerTags(){document.getElementById("ownersJson").value=JSON.stringify(_owners);var html=_owners.map(function(o,i){return \'<span style="display:inline-flex;align-items:center;gap:6px;background:#f3f0ff;border:1px solid #e0d4fc;border-radius:6px;padding:4px 10px;font-size:13px"><b>\'+o.name+\'</b><span onclick="removeOwner(\'+i+\')" style="cursor:pointer;color:#999;margin-left:4px">✕</span></span>\'}).join("");document.getElementById("ownerSelected").innerHTML=html}' +
    'function renderOwnerDropdown(list){if(!list.length){document.getElementById("ownerDropdown").innerHTML=\'<div style="padding:12px;color:#9ca3af;font-size:13px">未找到用户</div>\';document.getElementById("ownerDropdown").style.display="block";return}document.getElementById("ownerDropdown").innerHTML=list.map(function(u){return \'<div onclick=\\x27addOwner(\'+JSON.stringify(u).replace(/\'/g,"\\\\x27")+\')\\x27 style="padding:8px 12px;cursor:pointer;display:flex;align-items:center;gap:8px;border-bottom:1px solid #f3f4f6" onmouseover="this.style.background=\\x27#f9fafb\\x27" onmouseout="this.style.background=\\x27#fff\\x27"><span style="font-weight:600;font-size:13px">\'+u.name+\'</span><span style="font-size:11px;color:#9ca3af">\'+(u.department||"")+\' \'+(u.jobTitle||"")+\'</span></div>\'}).join("");document.getElementById("ownerDropdown").style.display="block"}' +
    'document.getElementById("ownerSearch").addEventListener("input",function(){var q=this.value.trim();clearTimeout(_ownerTimer);if(!q){document.getElementById("ownerDropdown").style.display="none";return}document.getElementById("ownerDropdown").innerHTML=\'<div style="padding:12px;color:#9ca3af;font-size:13px">搜索中...</div>\';document.getElementById("ownerDropdown").style.display="block";_ownerTimer=setTimeout(async function(){try{var r=await fetch("/api/feishu/search-users?q="+encodeURIComponent(q));if(r.ok){var list=await r.json();renderOwnerDropdown(list)}else{document.getElementById("ownerDropdown").style.display="none"}}catch(e){document.getElementById("ownerDropdown").style.display="none"}},300)});' +
    'document.addEventListener("click",function(e){if(!e.target.closest("#ownerSearch")&&!e.target.closest("#ownerDropdown"))document.getElementById("ownerDropdown").style.display="none"});' +
    '</script>';

  res.send(
    renderPage({
      title: job.title || "岗位详情",
      user: req.user,
      active: "jobs",
      contentHtml: '<div class="row"><div style="font-weight:900;font-size:18px">' + escapeHtml(job.title || "岗位详情") + '</div><span class="spacer"></span><a class="btn" href="/candidates?jobId=' + escapeHtml(job.id) + '">该岗位候选人</a>' + deleteBtn + '</div><div class="divider"></div>' +
        '<div class="card"><div class="row"><div style="font-weight:900">招聘数据</div><span class="spacer"></span>' + funnel + '</div></div><div style="height:12px"></div>' +
        jobBodyHtml,
    })
  );
});

router.post("/jobs/:id", requireLogin, requireAdmin, async (req, res) => {
  const d = await loadData();
  const job = d.jobs.find((x) => x.id === req.params.id);
  if (!job) return res.redirect(303, "/jobs");
  let owners = [];
  try { owners = JSON.parse(req.body.ownersJson || "[]"); } catch(e) {}
  if (!Array.isArray(owners)) owners = [];
  owners = owners.filter(o => o && o.name).map(o => ({ name: String(o.name), openId: String(o.openId || "") }));
  job.title = String(req.body.title || "").trim();
  job.titleEn = String(req.body.titleEn || "").trim();
  job.location = String(req.body.location || "").trim();
  job.owner = owners.length > 0 ? owners.map(o => o.name).join(", ") : "";
  job.ownerOpenId = owners.length > 0 ? owners.map(o => o.openId).join(", ") : "";
  job.owners = owners;
  job.headcount = req.body.headcount === "" ? null : Number(req.body.headcount || 0);
  job.priority = String(req.body.priority || "").trim();
  job.category = String(req.body.category || "").trim();
  job.employmentType = String(req.body.employmentType || "社招").trim();
  job.state = String(req.body.state || "open");
  job.jd = String(req.body.jd || "").trim();
  job.updatedAt = nowIso();
  await saveData(d);
  res.redirect(303, "/jobs/" + job.id);
});

// 删除职位
router.post("/jobs/:id/delete", requireLogin, requireAdmin, async (req, res) => {
  const d = await loadData();
  const idx = d.jobs.findIndex((x) => x.id === req.params.id);
  if (idx > -1) {
    d.jobs.splice(idx, 1);
    await deleteFromSupabase("jobs", req.params.id);
    await saveData(d);
  }
  res.redirect(303, "/jobs");
});

export default router;
