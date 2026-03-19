import { Router } from "express";
import { requireLogin, requireAdmin } from "../auth.mjs";
import { loadData, saveData, nowIso, rid, toBjTime } from "../db.mjs";
import { renderPage, escapeHtml } from "../ui.mjs";
import { feishuEnabled, getAllFeishuEmployees, searchFeishuUsers, sendFeishuGroupMessage, getFeishuBotChats } from "../feishu.mjs";

const router = Router();

router.get("/settings", requireLogin, requireAdmin, async (req, res) => {
  const d = await loadData();
  const sourcesHtml = (d.sources || []).map((s) => {
    const esc = escapeHtml(s).replace(/'/g, "&#39;");
    return '<span class="pill" style="display:inline-flex;align-items:center;gap:4px">' + escapeHtml(s) + '<span onclick="delSource(\'' + esc + '\')" style="cursor:pointer;color:#999;font-size:14px;line-height:1;margin-left:2px" title="删除">&times;</span></span>';
  }).join(" ");
  const categoriesHtml = (d.categories || []).map((c) => {
    const esc = escapeHtml(c).replace(/'/g, "&#39;");
    return '<span class="pill" style="display:inline-flex;align-items:center;gap:4px">' + escapeHtml(c) + '<span onclick="delCategory(\'' + esc + '\')" style="cursor:pointer;color:#999;font-size:14px;line-height:1;margin-left:2px" title="删除">&times;</span></span>';
  }).join(" ");
  const tagColors = { "高潜": "status-green", "紧急": "status-red", "待定": "status-gray", "优秀": "status-purple", "内推优先": "status-blue", "已拒绝其他Offer": "status-red" };
  const tagsHtml = (d.tags || []).map((t) => {
    const esc = escapeHtml(t).replace(/'/g, "&#39;");
    return '<span class="badge ' + (tagColors[t] || "status-gray") + '" style="display:inline-flex;align-items:center;gap:4px;font-size:11px">' + escapeHtml(t) + '<span onclick="delTag(\'' + esc + '\')" style="cursor:pointer;opacity:0.6;font-size:14px;line-height:1;margin-left:2px" title="删除">&times;</span></span>';
  }).join(" ");

  // 用户管理列表
  const usersHtml = (d.users || []).map((u) => {
    const isCurrentUser = u.id === req.user?.id;
    const roleLabel = u.role === "admin"
      ? '<span class="badge status-blue" style="font-size:11px">管理员</span>'
      : '<span class="badge status-gray" style="font-size:11px">成员</span>';
    const providerLabel = u.provider === "feishu"
      ? '<span class="badge status-blue" style="font-size:11px">飞书</span>'
      : '<span class="badge status-gray" style="font-size:11px">快捷登录</span>';
    const toggleBtn = isCurrentUser
      ? '<span class="muted" style="font-size:12px">当前用户</span>'
      : (u.role === "admin"
          ? '<button class="btn sm" onclick="toggleRole(\'' + escapeHtml(u.id) + '\',\'member\')">降为成员</button>'
          : '<button class="btn sm primary" onclick="toggleRole(\'' + escapeHtml(u.id) + '\',\'admin\')">设为管理员</button>');
    return '<tr><td style="font-weight:700">' + escapeHtml(u.name || "未命名") + '</td><td>' + roleLabel + '</td><td>' + providerLabel + '</td><td class="muted" style="font-size:12px">' + escapeHtml(toBjTime(u.createdAt || "").slice(0, 10)) + '</td><td>' + toggleBtn + '</td></tr>';
  }).join("");

  const userMgmtHtml = '<div class="card" style="margin-top:14px">' +
    '<div style="font-weight:900;font-size:18px">用户管理</div>' +
    '<div class="muted">管理系统用户和角色权限。管理员拥有全部操作权限，成员仅可查看数据和提交面评。</div>' +
    '<div class="divider"></div>' +
    (d.users.length
      ? '<table><thead><tr><th>姓名</th><th>角色</th><th>登录方式</th><th>注册时间</th><th>操作</th></tr></thead><tbody>' + usersHtml + '</tbody></table>'
      : '<div class="muted">暂无用户</div>') +
    '</div>' +
    '<script>function toggleRole(userId,newRole){if(!confirm(newRole==="admin"?"确认将该用户设为管理员？":"确认将该用户降为普通成员？"))return;fetch("/api/users/"+userId+"/role",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({role:newRole})}).then(r=>{if(r.ok)location.reload();else r.json().then(d=>alert(d.error||"操作失败")).catch(()=>alert("操作失败"))}).catch(()=>alert("网络错误"))}' +
    'function delSource(s){if(!confirm("确认删除来源「"+s+"」？"))return;fetch("/api/settings/sources",{method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({source:s})}).then(r=>{if(r.ok)location.reload();else r.json().then(d=>alert(d.error||"删除失败")).catch(()=>alert("删除失败"))}).catch(()=>alert("网络错误"))}' +
    'function delTag(t){if(!confirm("确认删除标签「"+t+"」？"))return;fetch("/api/settings/tags",{method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({tag:t})}).then(r=>{if(r.ok)location.reload();else r.json().then(d=>alert(d.error||"删除失败")).catch(()=>alert("删除失败"))}).catch(()=>alert("网络错误"))}' +
    'function delCategory(c){if(!confirm("确认删除分类「"+c+"」？"))return;fetch("/api/settings/categories",{method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({category:c})}).then(r=>{if(r.ok)location.reload();else r.json().then(d=>alert(d.error||"删除失败")).catch(()=>alert("删除失败"))}).catch(()=>alert("网络错误"))}</script>';

  const hrGroupChatId = d.settings?.hrGroupChatId || "";

  res.send(
    renderPage({
      title: "设置",
      user: req.user,
      active: "settings",
      contentHtml: '<div class="card"><div style="font-weight:900;font-size:18px">设置</div><div class="divider"></div>' +
        '<div class="field"><label>当前来源</label><div class="row">' + (sourcesHtml || '<span class="muted">暂无</span>') + '</div></div>' +
        '<form method="POST" action="/settings/sources" class="row"><input name="source" placeholder="新增来源（例如：脉脉/拉勾/校园）" style="max-width:420px" /><button class="btn primary" type="submit">新增来源</button></form>' +
        '<div class="divider"></div>' +
        '<div class="field"><label>候选人标签</label><div class="row">' + (tagsHtml || '<span class="muted">暂无</span>') + '</div></div>' +
        '<form method="POST" action="/settings/tags" class="row"><input name="tag" placeholder="新增标签（例如：高潜/紧急/校招）" style="max-width:420px" /><button class="btn primary" type="submit">新增标签</button></form>' +
        '<div class="divider"></div>' +
        '<div class="field"><label>职位分类</label><div class="row">' + (categoriesHtml || '<span class="muted">暂无</span>') + '</div></div>' +
        '<form method="POST" action="/settings/categories" class="row"><input name="category" placeholder="新增分类（例如：技术/产品/运营）" style="max-width:420px" /><button class="btn primary" type="submit">新增分类</button></form>' +
        '</div>' +
        userMgmtHtml +
        // 官网投递同步卡片
        '<div class="card" style="margin-top:14px">' +
          '<div style="font-weight:900;font-size:18px">官网投递同步</div>' +
          '<div class="muted">每15分钟自动同步官网新投递到系统，也可手动触发。</div>' +
          '<div class="divider"></div>' +
          '<div id="careersSyncStatus" style="margin-bottom:12px"><span class="muted">加载中...</span></div>' +
          '<button class="btn primary" id="careersSyncBtn" onclick="triggerCareersSync()">立即同步</button>' +
        '</div>' +
        '<script>' +
        'function loadSyncStatus(){' +
          'fetch("/api/careers/sync-status").then(r=>r.json()).then(d=>{' +
            'const el=document.getElementById("careersSyncStatus");' +
            'if(d.running){el.innerHTML=\'<span style="color:#3370ff;font-weight:700">⟳ 同步进行中...</span>\';return}' +
            'if(!d.lastResult){el.innerHTML=\'<span class="muted">尚未执行过同步</span>\';return}' +
            'const r=d.lastResult;' +
            'const t=r.finishedAt||r.startedAt||"";' +
            'let html="<div style=\\"font-size:13px\\">";' +
            'html+="<div style=\\"margin-bottom:4px\\"><b>上次同步：</b>"+t+"</div>";' +
            'html+="<div style=\\"margin-bottom:4px\\"><b>拉取投递：</b>"+(r.total||0)+" 条</div>";' +
            'html+="<div style=\\"margin-bottom:4px\\"><b>新增候选人：</b><span style=\\"color:#52c41a;font-weight:700\\">"+(r.synced||0)+"</span> 人</div>";' +
            'html+="<div style=\\"margin-bottom:4px\\"><b>已存在跳过：</b>"+(r.skipped||0)+" 人</div>";' +
            'if(r.errors&&typeof r.errors==="number"&&r.errors>0){html+="<div style=\\"color:#f5222d;margin-top:4px\\"><b>同步异常：</b>"+r.errors+" 条</div>"}' +
            'html+="</div>";' +
            'el.innerHTML=html;' +
          '}).catch(()=>{document.getElementById("careersSyncStatus").innerHTML=\'<span class="muted">状态加载失败</span>\'})' +
        '}' +
        'function triggerCareersSync(){' +
          'const btn=document.getElementById("careersSyncBtn");' +
          'btn.disabled=true;btn.textContent="同步中...";' +
          'document.getElementById("careersSyncStatus").innerHTML=\'<span style="color:#3370ff;font-weight:700">⟳ 同步进行中...</span>\';' +
          'fetch("/api/careers/sync",{method:"POST"}).then(r=>r.json()).then(d=>{' +
            'btn.disabled=false;btn.textContent="立即同步";' +
            'if(d.ok){loadSyncStatus()}else{alert(d.error||"同步失败")}' +
          '}).catch(()=>{btn.disabled=false;btn.textContent="立即同步";alert("网络错误")})' +
        '}' +
        'loadSyncStatus()' +
        '</script>' +
        // HR 群聊配置卡片
        '<div class="card" style="margin-top:14px">' +
          '<div style="font-weight:900;font-size:18px">HR 群聊通知配置</div>' +
          '<div class="muted" style="margin-top:4px">配置 HRteam 飞书群的 Chat ID，面评完成后机器人将自动发送通知到群里。</div>' +
          '<div class="divider"></div>' +
          '<div class="field">' +
            '<label>群聊 Chat ID</label>' +
            '<div style="display:flex;gap:8px;align-items:center;max-width:560px">' +
              '<input id="hrChatIdInput" value="' + escapeHtml(hrGroupChatId) + '" placeholder="例如：oc_xxxxxxxxxxxxxxxx" style="flex:1" />' +
              '<button class="btn primary" onclick="saveHrChatId()">保存</button>' +
              '<button class="btn" onclick="testHrChatId()">测试发送</button>' +
            '</div>' +
            '<div class="muted" style="margin-top:6px;font-size:12px">不知道 Chat ID？点击下方「查看机器人所在群」获取。</div>' +
          '</div>' +
          '<div id="hrChatIdMsg" style="font-size:13px;margin-top:6px"></div>' +
          '<div style="margin-top:10px">' +
            '<button class="btn" onclick="loadBotChats()">🔍 查看机器人所在群</button>' +
          '</div>' +
          '<div id="botChatsList" style="margin-top:10px"></div>' +
        '</div>' +
        '<script>' +
        'function saveHrChatId(){' +
          'var v=document.getElementById("hrChatIdInput").value.trim();' +
          'var msg=document.getElementById("hrChatIdMsg");' +
          'msg.innerHTML=\'<span style="color:#888">保存中...</span>\';' +
          'fetch("/api/settings/hr-chat-id",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chatId:v})})' +
          '.then(r=>r.json()).then(d=>{' +
            'if(d.ok){msg.innerHTML=\'<span style="color:#52c41a;font-weight:600">✓ 已保存</span>\'}' +
            'else{msg.innerHTML=\'<span style="color:#f5222d">保存失败：\'+(d.error||"未知错误")+\'</span>\'}' +
          '}).catch(()=>{msg.innerHTML=\'<span style="color:#f5222d">网络错误</span>\'})' +
        '}' +
        'function testHrChatId(){' +
          'var v=document.getElementById("hrChatIdInput").value.trim();' +
          'if(!v){alert("请先填写 Chat ID");return}' +
          'var msg=document.getElementById("hrChatIdMsg");' +
          'msg.innerHTML=\'<span style="color:#888">发送测试消息中...</span>\';' +
          'fetch("/api/settings/hr-chat-id/test",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chatId:v})})' +
          '.then(r=>r.json()).then(d=>{' +
            'if(d.ok){msg.innerHTML=\'<span style="color:#52c41a;font-weight:600">✓ 测试消息已发送，请检查群聊</span>\'}' +
            'else{msg.innerHTML=\'<span style="color:#f5222d">发送失败：\'+(d.error||"未知错误")+\'</span>\'}' +
          '}).catch(()=>{msg.innerHTML=\'<span style="color:#f5222d">网络错误</span>\'})' +
        '}' +
        'function loadBotChats(){' +
          'var el=document.getElementById("botChatsList");' +
          'el.innerHTML=\'<span style="color:#888;font-size:13px">加载中...</span>\';' +
          'fetch("/api/settings/bot-chats")' +
          '.then(r=>r.json()).then(function(d){' +
            'if(!d.chats||d.chats.length===0){el.innerHTML=\'<div style="color:#888;font-size:13px">没有找到群，请确认机器人已被拉入群聊。</div>\';return}' +
            'var html=\'<div style="font-size:13px;font-weight:600;margin-bottom:6px;color:#666">机器人所在的群（点击 Chat ID 可自动填入）：</div>\';' +
            'html+=\'<table style="width:100%;font-size:13px;border-collapse:collapse;max-width:600px">\';' +
            'html+=\'<tr><th style="text-align:left;padding:6px 8px;border-bottom:1px solid #eee;color:#999;font-weight:600">群名称</th><th style="text-align:left;padding:6px 8px;border-bottom:1px solid #eee;color:#999;font-weight:600">Chat ID</th><th style="padding:6px 8px;border-bottom:1px solid #eee"></th></tr>\';' +
            'd.chats.forEach(function(c){' +
              'html+=\'<tr><td style="padding:6px 8px;border-bottom:1px solid #f5f5f5">\'+c.name+\'</td>\';' +
              'html+=\'<td style="padding:6px 8px;border-bottom:1px solid #f5f5f5;font-family:monospace;color:#7c5cfc">\'+c.chatId+\'</td>\';' +
              'html+=\'<td style="padding:6px 8px;border-bottom:1px solid #f5f5f5"><button class="btn sm" onclick="document.getElementById(\\\'hrChatIdInput\\\').value=\\\'\'+c.chatId+\'\\\';document.getElementById(\\\'hrChatIdMsg\\\').innerHTML=\\\'\\\'"">使用此群</button></td>\';' +
              'html+=\'</tr>\';' +
            '});' +
            'html+=\'</table>\';' +
            'el.innerHTML=html;' +
          '}).catch(function(){el.innerHTML=\'<span style="color:#f5222d;font-size:13px">加载失败</span>\'})' +
        '}' +
        '</script>',
    })
  );
});

router.post("/settings/sources", requireLogin, requireAdmin, async (req, res) => {
  const d = await loadData();
  const s = String(req.body.source || "").trim();
  if (s && !d.sources.includes(s)) d.sources.push(s);
  await saveData(d);
  res.redirect(303, "/settings");
});

router.post("/settings/tags", requireLogin, requireAdmin, async (req, res) => {
  const d = await loadData();
  const t = String(req.body.tag || "").trim();
  if (t && !d.tags.includes(t)) d.tags.push(t);
  await saveData(d);
  res.redirect(303, "/settings");
});

router.delete("/api/settings/sources", requireLogin, requireAdmin, async (req, res) => {
  const d = await loadData();
  const s = String(req.body.source || "").trim();
  if (!s) return res.status(400).json({ error: "来源不能为空" });
  d.sources = (d.sources || []).filter((x) => x !== s);
  await saveData(d);
  res.json({ ok: true });
});

router.post("/settings/categories", requireLogin, requireAdmin, async (req, res) => {
  const d = await loadData();
  const c = String(req.body.category || "").trim();
  if (c && !d.categories.includes(c)) d.categories.push(c);
  await saveData(d);
  res.redirect(303, "/settings");
});

router.delete("/api/settings/categories", requireLogin, requireAdmin, async (req, res) => {
  const d = await loadData();
  const c = String(req.body.category || "").trim();
  if (!c) return res.status(400).json({ error: "分类不能为空" });
  d.categories = (d.categories || []).filter((x) => x !== c);
  await saveData(d);
  res.json({ ok: true });
});

router.delete("/api/settings/tags", requireLogin, requireAdmin, async (req, res) => {
  const d = await loadData();
  const t = String(req.body.tag || "").trim();
  if (!t) return res.status(400).json({ error: "标签不能为空" });
  d.tags = (d.tags || []).filter((x) => x !== t);
  await saveData(d);
  res.json({ ok: true });
});

// ====== HR 群聊 Chat ID 配置 ======
router.get("/api/settings/bot-chats", requireLogin, requireAdmin, async (req, res) => {
  if (!feishuEnabled()) return res.status(400).json({ error: "飞书未启用" });
  const chats = await getFeishuBotChats();
  res.json({ chats });
});

router.post("/api/settings/hr-chat-id", requireLogin, requireAdmin, async (req, res) => {
  const d = await loadData();
  const chatId = String(req.body.chatId || "").trim();
  if (!d.settings || typeof d.settings !== "object") d.settings = {};
  d.settings.hrGroupChatId = chatId;
  await saveData(d);
  res.json({ ok: true });
});

router.post("/api/settings/hr-chat-id/test", requireLogin, requireAdmin, async (req, res) => {
  if (!feishuEnabled()) return res.status(400).json({ error: "飞书未启用，请先配置 FEISHU_APP_ID 和 FEISHU_APP_SECRET" });
  const chatId = String(req.body.chatId || "").trim();
  if (!chatId) return res.status(400).json({ error: "chatId 不能为空" });
  const result = await sendFeishuGroupMessage(chatId, "这是一条来自 Machinepulse 招聘系统的测试消息，群聊通知配置成功 ✅", "测试通知");
  if (result && result.code === 0) {
    res.json({ ok: true });
  } else {
    res.status(400).json({ error: result?.msg || "发送失败，请检查 Chat ID 是否正确，以及机器人是否已加入该群" });
  }
});

// ====== 从飞书同步通讯录 ======
router.post("/api/users/sync-feishu", requireLogin, requireAdmin, async (req, res) => {
  try {
    const employees = await getAllFeishuEmployees();
    if (!employees.length) return res.redirect(303, "/settings");
    const d = await loadData();
    let added = 0;
    for (const emp of employees) {
      const existing = d.users.find(u => u.openId === emp.openId);
      if (existing) {
        existing.name = emp.name || existing.name;
        existing.avatar = emp.avatar || existing.avatar;
        existing.department = emp.department || existing.department;
        existing.jobTitle = emp.jobTitle || existing.jobTitle;
      } else {
        d.users.push({
          id: rid("usr"),
          openId: emp.openId,
          unionId: emp.unionId || "",
          name: emp.name,
          avatar: emp.avatar,
          department: emp.department || "",
          jobTitle: emp.jobTitle || "",
          provider: "feishu",
          createdAt: nowIso(),
        });
        added++;
      }
    }
    await saveData(d);
    res.redirect(303, "/settings");
  } catch (e) {
    console.error("[Sync] 飞书通讯录同步失败:", e.message);
    res.redirect(303, "/settings");
  }
});

// ====== 用户角色切换 ======
router.post("/api/users/:id/role", requireLogin, requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const newRole = String(req.body?.role || "").trim();
    if (newRole !== "admin" && newRole !== "member") {
      return res.status(400).json({ error: "无效的角色，仅支持 admin 或 member" });
    }
    if (userId === req.user?.id) {
      return res.status(400).json({ error: "不能修改自己的角色" });
    }
    const d = await loadData();
    const targetUser = d.users.find(u => u.id === userId);
    if (!targetUser) {
      return res.status(404).json({ error: "用户不存在" });
    }
    targetUser.role = newRole;
    await saveData(d);
    res.json({ ok: true, userId, role: newRole });
  } catch (e) {
    console.error("[Role] 角色修改失败:", e.message);
    res.status(500).json({ error: "操作失败" });
  }
});

export default router;
