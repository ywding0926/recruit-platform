import { Router } from "express";
import { requireLogin, requireAdmin } from "../auth.mjs";
import { loadData, toBjTime } from "../db.mjs";
import { renderPage, escapeHtml, statusBadge } from "../ui.mjs";
import { OFFER_STAGE_STATUSES } from "../constants.mjs";

const router = Router();

router.get("/offers", requireLogin, requireAdmin, async (req, res) => {
  const d = await loadData();
  const statusFilter = String(req.query.status || "").trim();

  const jobMap = new Map(d.jobs.map((j) => [j.id, j]));

  // 取出所有处于"面试通过"阶段的候选人
  const candidates = d.candidates.filter((c) => OFFER_STAGE_STATUSES.has(c.status));

  // 构建 offer map
  const offerMap = new Map((d.offers || []).map((o) => [o.candidateId, o]));

  // 状态过滤
  const filtered = statusFilter
    ? candidates.filter((c) => c.status === statusFilter)
    : candidates;

  // 排序：待发offer → Offer发放 → 入职 → 拒offer
  const STATUS_ORDER = { "待发offer": 0, "Offer发放": 1, "入职": 2, "拒offer": 3 };
  filtered.sort((a, b) => {
    const oa = STATUS_ORDER[a.status] ?? 9;
    const ob = STATUS_ORDER[b.status] ?? 9;
    if (oa !== ob) return oa - ob;
    return (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || "");
  });

  const rows = filtered.map((c) => {
    const job = jobMap.get(c.jobId);
    const offer = offerMap.get(c.id);
    return '<tr>' +
      '<td><a class="btn sm" href="/candidates/' + escapeHtml(c.id) + '">' + escapeHtml(c.name || "未命名") + '</a></td>' +
      '<td>' + escapeHtml(c.jobTitle || job?.title || "-") + '</td>' +
      '<td>' + statusBadge(c.status) + '</td>' +
      '<td>' + escapeHtml(offer?.salary || "-") + '</td>' +
      '<td>' + escapeHtml(offer?.startDate || "-") + '</td>' +
      '<td class="muted">' + escapeHtml(toBjTime(c.updatedAt || c.createdAt || "").slice(0, 16)) + '</td>' +
      '</tr>';
  }).join("");

  // 统计
  const stats = { total: candidates.length, pending: 0, sent: 0, hired: 0, rejected: 0 };
  candidates.forEach((c) => {
    if (c.status === "待发offer") stats.pending++;
    else if (c.status === "Offer发放") stats.sent++;
    else if (c.status === "入职") stats.hired++;
    else if (c.status === "拒offer") stats.rejected++;
  });

  // 状态过滤标签
  const tabs = [
    { key: "", label: "全部", count: stats.total },
    { key: "待发offer", label: "待发offer", count: stats.pending },
    { key: "Offer发放", label: "Offer发放", count: stats.sent },
    { key: "入职", label: "已入职", count: stats.hired },
    { key: "拒offer", label: "拒offer", count: stats.rejected },
  ];
  const tabsHtml = tabs.map((t) =>
    '<a href="/offers' + (t.key ? '?status=' + encodeURIComponent(t.key) : '') + '" class="' + (statusFilter === t.key ? 'active' : '') + '">' +
    escapeHtml(t.label) + (t.count > 0 ? ' <span class="badge status-gray" style="font-size:11px">' + t.count + '</span>' : '') +
    '</a>'
  ).join("");

  res.send(
    renderPage({
      title: "面试通过",
      user: req.user,
      active: "offers",
      contentHtml:
        '<div class="row"><div style="font-weight:900;font-size:18px">面试通过</div></div>' +
        '<div class="divider"></div>' +
        '<div class="row" style="margin-bottom:14px">' +
          '<span class="pill"><span class="muted">待发offer</span><b>' + stats.pending + '</b></span>' +
          '<span class="pill"><span class="muted">Offer发放</span><b>' + stats.sent + '</b></span>' +
          '<span class="pill"><span class="muted">已入职</span><b>' + stats.hired + '</b></span>' +
          '<span class="pill"><span class="muted">拒offer</span><b>' + stats.rejected + '</b></span>' +
        '</div>' +
        '<div class="seg" style="margin-bottom:12px">' + tabsHtml + '</div>' +
        '<div class="card"><table><thead><tr>' +
          '<th>候选人</th><th>岗位</th><th>状态</th><th>薪资</th><th>入职日期</th><th>更新时间</th>' +
        '</tr></thead><tbody>' + (rows || '<tr><td colspan="6" class="muted" style="text-align:center;padding:24px">暂无候选人</td></tr>') + '</tbody></table></div>',
    })
  );
});

export default router;
