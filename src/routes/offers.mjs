import { Router } from "express";
import { requireLogin } from "../auth.mjs";
import { loadTables, toBjTime } from "../db.mjs";
import { renderPage, escapeHtml, offerStatusBadge } from "../ui.mjs";

const router = Router();

router.get("/offers", requireLogin, async (req, res) => {
  const d = await loadTables("offers", "candidates");
  const offers = d.offers || [];
  const candMap = new Map(d.candidates.map((c) => [c.id, c]));

  const rows = offers.map((o) => {
    const c = candMap.get(o.candidateId);
    return '<tr><td>' + (c ? '<a class="btn sm" href="/candidates/' + escapeHtml(c.id) + '">' + escapeHtml(c.name || "未命名") + '</a>' : escapeHtml(o.candidateId)) + '</td><td>' + escapeHtml(c?.jobTitle || "-") + '</td><td>' + escapeHtml(o.salary || "-") + '</td><td>' + escapeHtml(o.startDate || "-") + '</td><td>' + offerStatusBadge(o.offerStatus) + '</td><td class="muted">' + escapeHtml(toBjTime(o.updatedAt || o.createdAt || "").slice(0, 16)) + '</td></tr>';
  }).join("");

  const stats = { total: offers.length, pending: 0, sent: 0, accepted: 0, rejected: 0 };
  offers.forEach((o) => {
    if (o.offerStatus === "待发放") stats.pending++;
    else if (o.offerStatus === "已发放") stats.sent++;
    else if (o.offerStatus === "已接受") stats.accepted++;
    else if (o.offerStatus === "已拒绝" || o.offerStatus === "已撤回") stats.rejected++;
  });

  res.send(
    renderPage({
      title: "Offer管理",
      user: req.user,
      active: "offers",
      contentHtml: '<div class="row"><div style="font-weight:900;font-size:18px">Offer管理</div></div><div class="divider"></div>' +
        '<div class="row" style="margin-bottom:14px"><span class="pill"><span class="muted">总Offer</span><b>' + stats.total + '</b></span><span class="pill"><span class="muted">待发放</span><b>' + stats.pending + '</b></span><span class="pill"><span class="muted">已发放</span><b>' + stats.sent + '</b></span><span class="pill"><span class="muted">已接受</span><b>' + stats.accepted + '</b></span><span class="pill"><span class="muted">已拒绝/撤回</span><b>' + stats.rejected + '</b></span></div>' +
        '<div class="card"><table><thead><tr><th>候选人</th><th>岗位</th><th>薪资</th><th>入职日期</th><th>状态</th><th>更新时间</th></tr></thead><tbody>' + (rows || "") + '</tbody></table>' + (rows ? "" : '<div class="muted">暂无Offer记录，可在候选人详情页创建Offer</div>') + '</div>',
    })
  );
});

export default router;
