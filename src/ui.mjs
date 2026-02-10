export function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function statusBadge(status) {
  const s = String(status || "待筛选");
  const map = {
    "待筛选": ["待筛选", "gray"],
    "待一面": ["待一面", "purple"],
    "一面通过": ["一面通过", "purple"],
    "二面通过": ["二面通过", "purple"],
    "三面通过": ["三面通过", "purple"],
    "四面通过": ["四面通过", "purple"],
    "五面通过": ["五面通过", "purple"],
    "Offer发放": ["Offer发放", "purple"],
    "入职": ["入职", "green"],
    "淘汰": ["淘汰", "red"],
  };
  const [label, cls] = map[s] || [s, "gray"];
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
}

export function offerStatusBadge(status) {
  const s = String(status || "");
  const map = {
    "待发放": ["待发放", "gray"],
    "已发放": ["已发放", "purple"],
    "已接受": ["已接受", "green"],
    "已拒绝": ["已拒绝", "red"],
    "已撤回": ["已撤回", "red"],
  };
  const [label, cls] = map[s] || [s, "gray"];
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
}

export function tagBadge(tag) {
  const colors = {
    "高潜": "green",
    "紧急": "red",
    "待定": "gray",
    "优秀": "purple",
    "内推优先": "purple",
    "已拒绝其他Offer": "red",
  };
  const cls = colors[tag] || "gray";
  return `<span class="badge ${cls}" style="font-size:11px;padding:4px 8px">${escapeHtml(tag)}</span>`;
}

export function followupBadge(follow) {
  if (!follow || typeof follow !== "object") return "";
  const action = String(follow.nextAction || "").trim();
  const at = String(follow.followAt || "").trim();
  if (!action && !at) return "";
  const now = new Date();
  let overdue = false;
  let atText = "";
  if (at) {
    const m = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/.exec(at);
    if (m) {
      const d = new Date(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        Number(m[4]),
        Number(m[5]),
        0,
        0
      );
      overdue = d.getTime() < now.getTime();
      atText = at;
    } else {
      atText = at;
    }
  }
  const cls = overdue ? "red" : "gray";
  const text = [
    action ? `下一步：${action}` : "",
    atText ? `跟进：${atText}` : "",
    overdue ? "（已逾期）" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<span class="badge ${cls}">${escapeHtml(text)}</span>`;
}

export function renderPage({ title, user, active, contentHtml }) {
  const role = user?.role || "interviewer";

  const nav = [
    ["dashboard", "概览", "/", ["admin", "hr", "interviewer"]],
    ["jobs", "职位管理", "/jobs", ["admin", "hr"]],
    ["candidates_list", "全部候选人", "/candidates", ["admin", "hr"]],
    ["candidates_board", "候选人看板", "/candidates/board", ["admin", "hr"]],
    ["schedule", "面试日程", "/schedule", ["admin", "hr", "interviewer"]],
    ["offers", "Offer管理", "/offers", ["admin", "hr"]],
    ["users", "用户管理", "/users", ["admin"]],
    ["settings", "设置", "/settings", ["admin", "hr"]],
  ];

  const navHtml = nav
    .filter(([, , , roles]) => roles.includes(role))
    .map(([key, label, href]) => {
      const cls = key === active ? "navitem active" : "navitem";
      return `<a class="${cls}" href="${href}">${label}</a>`;
    })
    .join("");

  const roleLabels = { admin: "管理员", hr: "HR", interviewer: "面试官" };
  const userHtml = user
    ? `<div class="user">
        <span class="badge purple" style="font-size:11px;padding:4px 8px">${escapeHtml(roleLabels[role] || role)}</span>
        <span class="muted">${escapeHtml(user.name || "")}</span>
        <a class="btn" href="/logout">退出</a>
      </div>`
    : "";

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root{
    --bg:#faf7ff;
    --bg2:#ffffff;
    --card:#ffffff;
    --text:#111827;
    --muted:#6b7280;
    --border:#ede9fe;
    --primary:#8b5cf6;
    --primary2:#a78bfa;
    --green:#16a34a;
    --red:#ef4444;
    --orange:#f59e0b;
    --blue:#3b82f6;
    --shadow: 0 10px 30px rgba(17,24,39,.08);
    --shadow2: 0 16px 50px rgba(17,24,39,.12);
    --radius: 18px;
    --radius2: 14px;
  }
  *{box-sizing:border-box}
  html,body{height:100%}
  body{
    margin:0;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
    background: radial-gradient(1000px 600px at 20% 0%, rgba(167,139,250,.20), transparent 50%),
                radial-gradient(900px 500px at 80% 10%, rgba(139,92,246,.16), transparent 50%),
                linear-gradient(180deg, var(--bg), var(--bg2));
    color:var(--text);
  }
  a{color:inherit;text-decoration:none}
  .muted{color:var(--muted);font-size:13px}
  .mono{font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono","Courier New", monospace}

  .topbar{
    position:sticky; top:0; z-index:50;
    background:rgba(255,255,255,.72);
    backdrop-filter: blur(12px);
    border-bottom:1px solid rgba(237,233,254,.8);
  }
  .wrap{
    max-width:1200px;margin:0 auto;
    padding:14px 18px;
    display:flex;align-items:center;justify-content:space-between;gap:12px
  }
  .brand{display:flex;align-items:center;gap:10px;font-weight:800;letter-spacing:.2px}
  .dot{width:10px;height:10px;border-radius:999px;background:var(--primary);box-shadow:0 0 0 6px rgba(139,92,246,.12)}
  .nav{display:flex;gap:8px;flex-wrap:wrap}
  .navitem{
    padding:9px 12px;border-radius:999px;
    border:1px solid transparent;
    color:var(--muted);
    transition:.15s ease;
  }
  .navitem:hover{border-color:rgba(139,92,246,.22);background:#fff}
  .navitem.active{background:rgba(139,92,246,.12);border-color:rgba(139,92,246,.28);color:var(--text)}
  .user{display:flex;align-items:center;gap:10px}

  .container{max-width:1200px;margin:0 auto;padding:18px}
  .grid{display:grid;grid-template-columns: 1.4fr .6fr;gap:14px}
  .grid3{display:grid;grid-template-columns: repeat(3, 1fr);gap:14px}
  .grid4{display:grid;grid-template-columns: repeat(4, 1fr);gap:14px}
  @media (max-width: 960px){ .grid{grid-template-columns:1fr} .grid3{grid-template-columns:1fr} .grid4{grid-template-columns:repeat(2,1fr)} }

  .card{
    background:var(--card);
    border:1px solid rgba(237,233,254,.9);
    border-radius:var(--radius);
    box-shadow:var(--shadow);
    padding:16px;
  }
  .card.soft{
    background:rgba(255,255,255,.75);
    border-color:rgba(237,233,254,.65);
  }
  .row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .spacer{flex:1}
  .divider{height:1px;background:rgba(237,233,254,.9);margin:12px 0}

  .btn{
    display:inline-flex;align-items:center;justify-content:center;gap:8px;
    border:1px solid rgba(237,233,254,.95);
    background:#fff;
    border-radius:12px;
    padding:9px 12px;
    cursor:pointer;
    transition:.15s ease;
    font-weight:600;
  }
  .btn:hover{border-color:rgba(139,92,246,.35);transform:translateY(-1px)}
  .btn:active{transform:translateY(0)}
  .btn.primary{
    background:linear-gradient(180deg,var(--primary2),var(--primary));
    border-color:rgba(139,92,246,.30);
    color:#fff;
    box-shadow:0 12px 30px rgba(139,92,246,.18);
  }
  .btn.danger{
    background:rgba(239,68,68,.12);
    border-color:rgba(239,68,68,.22);
    color:#7f1d1d;
  }
  .btn.sm{padding:6px 10px;font-size:12px;border-radius:10px}

  .field{margin-bottom:12px}
  label{display:block;font-size:13px;color:var(--muted);margin-bottom:6px}
  input,select,textarea{
    width:100%;
    padding:10px 12px;
    border-radius:12px;
    border:1px solid rgba(237,233,254,.95);
    outline:none;
    background:rgba(255,255,255,.95);
    transition:.15s ease;
  }
  input:focus,select:focus,textarea:focus{
    border-color:rgba(139,92,246,.55);
    box-shadow:0 0 0 5px rgba(139,92,246,.10);
  }

  table{width:100%;border-collapse:separate;border-spacing:0 10px}
  th{font-size:12px;color:var(--muted);text-align:left;padding:0 10px}
  td{
    background:#fff;
    border:1px solid rgba(237,233,254,.95);
    padding:10px;
    border-left:none;border-right:none;
    vertical-align:top;
  }
  tr td:first-child{border-left:1px solid rgba(237,233,254,.95);border-top-left-radius:12px;border-bottom-left-radius:12px}
  tr td:last-child{border-right:1px solid rgba(237,233,254,.95);border-top-right-radius:12px;border-bottom-right-radius:12px}

  .badge{
    display:inline-flex;align-items:center;gap:6px;
    border-radius:999px;padding:6px 10px;font-size:12px;
    border:1px solid rgba(237,233,254,.95);
    background:#fff;
    white-space:nowrap;
  }
  .badge.gray{background:#f8fafc;color:#334155}
  .badge.purple{background:rgba(139,92,246,.12);border-color:rgba(139,92,246,.22);color:#4c1d95}
  .badge.green{background:rgba(22,163,74,.12);border-color:rgba(22,163,74,.22);color:#065f46}
  .badge.red{background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.22);color:#7f1d1d}
  .badge.orange{background:rgba(245,158,11,.12);border-color:rgba(245,158,11,.22);color:#78350f}
  .badge.blue{background:rgba(59,130,246,.12);border-color:rgba(59,130,246,.22);color:#1e3a5f}

  .toolbar{
    display:flex;align-items:center;gap:10px;flex-wrap:wrap;
    padding:10px;
    border:1px solid rgba(237,233,254,.95);
    border-radius:var(--radius2);
    background:rgba(255,255,255,.72);
  }
  .toolbar .ctl{
    display:flex;align-items:center;gap:8px;
    padding:8px 10px;border:1px solid rgba(237,233,254,.95);
    border-radius:12px;background:#fff;
  }
  .toolbar .ctl label{margin:0;font-size:12px;color:var(--muted)}
  .toolbar .ctl input,.toolbar .ctl select{border:none; padding:0; outline:none; background:transparent; width:auto}
  .toolbar .ctl input{min-width:220px}
  .toolbar .ctl select{min-width:140px}

  .kanban{
    display:grid;
    grid-template-columns: repeat(10, minmax(230px, 1fr));
    gap:12px;
    overflow:auto;
    padding-bottom:6px;
  }
  @media (max-width: 1200px){
    .kanban{grid-template-columns: repeat(10, 280px)}
  }
  .col{
    border:1px solid rgba(237,233,254,.95);
    border-radius:var(--radius);
    background:rgba(255,255,255,.70);
    box-shadow: var(--shadow);
    min-height: 360px;
    display:flex;
    flex-direction:column;
  }
  .colhead{
    padding:12px 12px 10px 12px;
    border-bottom:1px solid rgba(237,233,254,.9);
    display:flex;align-items:center;gap:8px;
  }
  .coltitle{font-weight:900}
  .colcount{margin-left:auto}
  .colbody{padding:10px; display:flex; flex-direction:column; gap:10px}
  .carditem{
    border:1px solid rgba(237,233,254,.95);
    border-radius:16px;
    background:#fff;
    padding:12px;
    cursor:pointer;
    transition:.12s ease;
  }
  .carditem:hover{
    transform: translateY(-1px);
    border-color: rgba(139,92,246,.32);
    box-shadow: 0 12px 26px rgba(17,24,39,.08);
  }
  .cardtitle{font-weight:900;display:flex;align-items:center;gap:8px}
  .cardsub{margin-top:6px;display:flex;gap:8px;flex-wrap:wrap}

  .drawerMask{
    position:fixed; inset:0;
    background:rgba(17,24,39,.35);
    backdrop-filter: blur(2px);
    display:none;
    z-index:100;
  }
  .drawer{
    position:fixed;
    right:0; top:0;
    height:100%;
    width:min(560px, 96vw);
    background:rgba(255,255,255,.92);
    border-left:1px solid rgba(237,233,254,.95);
    box-shadow: var(--shadow2);
    transform: translateX(102%);
    transition: .18s ease;
    z-index:110;
    display:flex;
    flex-direction:column;
  }
  .drawer.open{ transform: translateX(0); }
  .drawerMask.open{ display:block; }
  .drawerHeader{
    padding:14px 16px;
    border-bottom:1px solid rgba(237,233,254,.9);
    display:flex; align-items:center; gap:10px;
    background:rgba(255,255,255,.75);
    backdrop-filter: blur(10px);
  }
  .drawerTitle{font-weight:900;font-size:16px}
  .drawerBody{padding:14px 16px; overflow:auto; flex:1}
  .drawerClose{
    margin-left:auto;
    width:38px;height:38px;
    border-radius:12px;
    border:1px solid rgba(237,233,254,.95);
    background:#fff;
    cursor:pointer;
    font-weight:900;
  }

  .tabs{display:flex;gap:8px;flex-wrap:wrap}
  .tab{
    padding:9px 12px;
    border-radius:999px;
    border:1px solid rgba(237,233,254,.95);
    background:#fff;
    cursor:pointer;
    font-weight:700;
    transition:.12s ease;
  }
  .tab:hover{border-color:rgba(139,92,246,.35);transform:translateY(-1px)}
  .tab.active{
    background:rgba(139,92,246,.12);
    border-color:rgba(139,92,246,.28);
    color:#4c1d95;
  }
  .tabpanels{margin-top:12px}
  .tabpanel{display:none}
  .tabpanel.active{display:block}

  .pill{
    display:inline-flex;align-items:center;gap:8px;
    padding:8px 10px;border-radius:14px;
    border:1px solid rgba(237,233,254,.95);
    background:#fff;
  }
  .shadowless{box-shadow:none}

  .timeline{
    position:relative;
    padding-left:14px;
  }
  .timeline:before{
    content:'';
    position:absolute;
    left:6px; top:6px; bottom:6px;
    width:2px;
    background:rgba(139,92,246,.18);
    border-radius:999px;
  }
  .titem{
    position:relative;
    padding:10px 10px 10px 14px;
    border:1px solid rgba(237,233,254,.95);
    border-radius:14px;
    background:#fff;
    margin-bottom:10px;
  }
  .titem:before{
    content:'';
    position:absolute;
    left:-3px; top:14px;
    width:10px;height:10px;border-radius:999px;
    background:rgba(139,92,246,.85);
    box-shadow:0 0 0 6px rgba(139,92,246,.10);
  }
  .tmeta{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .tmeta b{font-weight:900}
  .tmsg{margin-top:8px;color:#111827}

  .seg{
    display:flex;gap:8px;flex-wrap:wrap;
    padding:10px;
    border:1px solid rgba(237,233,254,.95);
    border-radius:var(--radius2);
    background:rgba(255,255,255,.72);
  }
  .seg a{
    padding:9px 12px;border-radius:999px;
    border:1px solid rgba(237,233,254,.95);
    background:#fff;
    font-weight:800;
  }
  .seg a.active{
    background:rgba(139,92,246,.12);
    border-color:rgba(139,92,246,.28);
    color:#4c1d95;
  }

  .stat-number{font-size:28px;font-weight:900;color:var(--primary);line-height:1}
  .stat-label{font-size:13px;color:var(--muted);margin-top:4px}
  .stat-card{text-align:center;padding:20px 12px}

  .bar{height:8px;border-radius:999px;background:rgba(237,233,254,.9);overflow:hidden;margin-top:4px}
  .bar-fill{height:100%;border-radius:999px;transition:.3s ease}
  .bar-purple{background:linear-gradient(90deg,var(--primary2),var(--primary))}
  .bar-green{background:var(--green)}
  .bar-red{background:var(--red)}
  .bar-orange{background:var(--orange)}
  .bar-blue{background:var(--blue)}

  .confirm-mask{position:fixed;inset:0;background:rgba(17,24,39,.35);display:flex;align-items:center;justify-content:center;z-index:200}
  .confirm-box{background:#fff;border-radius:var(--radius);padding:24px;max-width:400px;width:90%;box-shadow:var(--shadow2);text-align:center}
  .confirm-box .confirm-title{font-weight:900;font-size:16px;margin-bottom:12px}
  .confirm-box .confirm-actions{display:flex;gap:10px;justify-content:center;margin-top:16px}

  .cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px}
  .cal-head{text-align:center;font-weight:900;font-size:12px;color:var(--muted);padding:6px 0}
  .cal-cell{min-height:80px;border:1px solid rgba(237,233,254,.7);border-radius:8px;padding:4px 6px;background:#fff;font-size:12px}
  .cal-cell.empty{border:none;background:transparent}
  .cal-cell.today{background:rgba(139,92,246,.06);border-color:rgba(139,92,246,.3)}
  .cal-day{font-weight:900;font-size:13px;margin-bottom:4px;color:#374151}
  .cal-cell.today .cal-day{color:var(--primary)}
  .cal-dot{display:block;padding:2px 4px;margin-bottom:2px;border-radius:4px;background:rgba(139,92,246,.1);color:#4c1d95;font-size:11px;font-weight:700;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cal-dot:hover{background:rgba(139,92,246,.22)}
  .cal-more{display:block;font-size:10px;color:var(--muted);font-weight:700}
</style>
</head>
<body>
  <div class="topbar">
    <div class="wrap">
      <div class="brand"><span class="dot"></span>Recruit Platform</div>
      <div class="nav">${navHtml}</div>
      ${userHtml}
    </div>
  </div>

  <div class="container">
    ${contentHtml}
  </div>
</body>
</html>`;
}
