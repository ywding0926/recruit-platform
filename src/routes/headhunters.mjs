import { Router } from "express";
import crypto from "crypto";
import { requireLogin, requireAdmin } from "../auth.mjs";
import { loadData, loadTables, saveTable, upsertRow, nowIso, rid, toBjTime, deleteFromSupabase } from "../db.mjs";
import { renderPage, escapeHtml } from "../ui.mjs";

const router = Router();

router.get("/headhunters", requireLogin, async (req, res) => {
  const d = await loadTables("headhunters");
  const hunters = d.headhunters || [];
  const isAdmin = req.user?.role === "admin";

  const tableRows = hunters.map(h => {
    const statusBg = h.enabled !== false ? "#e8f5e9" : "#fce4ec";
    const statusColor = h.enabled !== false ? "#2e7d32" : "#c62828";
    const statusText = h.enabled !== false ? "启用" : "禁用";
    const actionsTd = isAdmin
      ? '<td>' +
        '<button class="btn" style="font-size:12px;padding:4px 10px;margin-right:4px" onclick="toggleHunter(\'' + h.id + '\',' + (h.enabled !== false ? 'false' : 'true') + ')">' + (h.enabled !== false ? '禁用' : '启用') + '</button>' +
        '<button class="btn" style="font-size:12px;padding:4px 10px;color:var(--red,#f54a45)" onclick="if(confirm(\'确定删除猎头 ' + escapeHtml(h.name) + '？\'))deleteHunter(\'' + h.id + '\')">删除</button>' +
        '</td>'
      : '<td>-</td>';
    return '<tr>' +
      '<td>' + escapeHtml(h.name || "") + '</td>' +
      '<td>' + escapeHtml(h.company || "") + '</td>' +
      '<td><code style="font-size:12px;background:#f5f5f5;padding:2px 6px;border-radius:4px;word-break:break-all">' + escapeHtml(h.apiKey || "") + '</code></td>' +
      '<td><span style="background:' + statusBg + ';color:' + statusColor + ';padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600">' + statusText + '</span></td>' +
      '<td>' + escapeHtml(h.createdAt ? toBjTime(h.createdAt).slice(0, 10) : "-") + '</td>' +
      actionsTd + '</tr>';
  }).join("") || '<tr><td colspan="6" style="text-align:center;color:#8f959e;padding:30px">暂无猎头' + (isAdmin ? '，点击右上角按钮添加' : '') + '</td></tr>';

  const addBtn = isAdmin ? '<button class="btn primary" onclick="showAddHunter()">添加猎头</button>' : '';
  const adminModal = isAdmin ?
      '<div id="addHunterModal" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.4);z-index:999;display:none;justify-content:center;align-items:center">' +
      '<div class="card" style="width:420px;max-width:90vw">' +
      '<div style="font-weight:900;font-size:16px;margin-bottom:12px">添加猎头</div>' +
      '<div class="field"><label>姓名</label><input id="hName" required /></div>' +
      '<div class="field"><label>公司</label><input id="hCompany" /></div>' +
      '<div class="divider"></div>' +
      '<div class="row"><button class="btn primary" onclick="saveHunter()">保存</button><button class="btn" onclick="hideAddHunter()">取消</button></div>' +
      '</div></div>' +
      '<script>' +
      'function showAddHunter(){document.getElementById("addHunterModal").style.display="flex"}' +
      'function hideAddHunter(){document.getElementById("addHunterModal").style.display="none"}' +
      'async function saveHunter(){' +
      'var name=document.getElementById("hName").value.trim();' +
      'var company=document.getElementById("hCompany").value.trim();' +
      'if(!name){alert("请填写猎头姓名");return}' +
      'var r=await fetch("/api/headhunters",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:name,company:company})});' +
      'var data=await r.json();if(!r.ok){alert(data.error||"添加失败");return}' +
      'alert("添加成功！\\nAPI Key: "+data.apiKey+"\\n\\n请妥善保管此Key");location.reload()' +
      '}' +
      'async function toggleHunter(id,enabled){' +
      'var r=await fetch("/api/headhunters/"+id,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({enabled:enabled})});' +
      'if(r.ok)location.reload();else{var d=await r.json();alert(d.error||"操作失败")}' +
      '}' +
      'async function deleteHunter(id){' +
      'var r=await fetch("/api/headhunters/"+id+"/delete",{method:"POST"});' +
      'if(r.ok)location.reload();else{var d=await r.json();alert(d.error||"删除失败")}' +
      '}' +
      '</script>'
    : '';

  res.send(renderPage({
    title: "猎头管理", user: req.user, active: "headhunters",
    contentHtml: '<div class="row"><div style="font-weight:900;font-size:18px">猎头管理</div><span class="spacer"></span>' + addBtn + '</div><div class="divider"></div>' +
      '<div class="card compact" style="background:#f0ebff;border-color:#d4c5fc"><div class="row"><div><div style="font-weight:700;color:#7c5cfc">猎头投递门户</div><div class="muted" style="margin-top:2px">将以下链接和 API Key 发送给猎头，猎头可自行登录查看岗位并投递候选人</div></div><span class="spacer"></span><a class="btn primary" href="/portal" target="_blank">打开门户</a></div><div style="margin-top:8px"><code style="font-size:13px;background:#fff;padding:4px 10px;border-radius:6px;border:1px solid #d4c5fc;word-break:break-all">' + escapeHtml(req.protocol + '://' + req.get('host') + '/portal') + '</code></div></div>' +
      '<div class="divider"></div>' +
      '<div class="card compact"><table class="data-table" style="width:100%"><thead><tr><th>姓名</th><th>公司</th><th>API Key</th><th>状态</th><th>创建日期</th><th>操作</th></tr></thead><tbody>' + tableRows + '</tbody></table></div>' +
      '<div class="divider"></div>' +
      '<div class="card compact"><div style="font-weight:700;margin-bottom:8px">猎头开放 API 使用说明（开发者）</div>' +
      '<div class="muted" style="font-size:13px;line-height:1.8">' +
      '<b>1. 查看可用职位</b><br><code>GET /open-api/jobs</code> &nbsp; Header: <code>X-API-Key: {apiKey}</code><br><br>' +
      '<b>2. 提交候选人</b><br><code>POST /open-api/candidates</code> &nbsp; Header: <code>X-API-Key: {apiKey}</code><br>' +
      'Body (JSON): <code>{"name":"姓名","phone":"手机","email":"邮箱","jobId":"职位ID","note":"备注"}</code><br><br>' +
      '<b>3. 上传简历</b><br><code>POST /open-api/resume</code> &nbsp; Header: <code>X-API-Key: {apiKey}</code><br>' +
      'Body (form-data): <code>candidateId</code> + <code>resume</code> (文件)<br>' +
      '</div></div>' +
      adminModal,
  }));
});

// ====== 猎头管理 API ======
router.post("/api/headhunters", requireLogin, requireAdmin, async (req, res) => {
  try {
    const d = await loadData();
    const name = String(req.body.name || "").trim();
    const company = String(req.body.company || "").trim();
    if (!name) return res.status(400).json({ error: "猎头姓名不能为空" });

    const apiKey = "hk_" + crypto.randomBytes(24).toString("hex");
    const hunter = {
      id: rid("hunter"),
      name,
      company,
      apiKey,
      enabled: true,
      createdAt: nowIso(),
    };
    d.headhunters.push(hunter);
    await upsertRow("headhunters", hunter);
    res.json({ ok: true, id: hunter.id, apiKey: hunter.apiKey });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || "添加失败") });
  }
});

router.post("/api/headhunters/:id", requireLogin, requireAdmin, async (req, res) => {
  try {
    const d = await loadData();
    const hunter = d.headhunters.find(h => h.id === req.params.id);
    if (!hunter) return res.status(404).json({ error: "猎头不存在" });
    if (req.body.enabled !== undefined) hunter.enabled = req.body.enabled === true || req.body.enabled === "true";
    if (req.body.name) hunter.name = String(req.body.name).trim();
    if (req.body.company !== undefined) hunter.company = String(req.body.company).trim();
    await upsertRow("headhunters", hunter);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || "更新失败") });
  }
});

router.post("/api/headhunters/:id/delete", requireLogin, requireAdmin, async (req, res) => {
  try {
    const d = await loadData();
    const idx = d.headhunters.findIndex(h => h.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: "猎头不存在" });
    const hunterId = d.headhunters[idx].id;
    d.headhunters.splice(idx, 1);
    await saveTable("headhunters", d.headhunters);
    try { await deleteFromSupabase("headhunters", hunterId); } catch {}
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || "删除失败") });
  }
});

export default router;
