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
    "待筛选": "status-gray", "简历初筛": "status-gray",
    "待一面": "status-purple", "一面通过": "status-purple",
    "待二面": "status-purple", "二面通过": "status-purple",
    "待三面": "status-purple", "三面通过": "status-purple",
    "待四面": "status-purple", "四面通过": "status-purple",
    "待五面": "status-purple", "五面通过": "status-purple",
    "待发offer": "status-orange", "Offer发放": "status-blue",
    "入职": "status-green", "淘汰": "status-red",
  };
  const cls = map[s] || "status-gray";
  return `<span class="badge ${cls}">${escapeHtml(s)}</span>`;
}

export function offerStatusBadge(status) {
  const s = String(status || "");
  const map = { "待发放": "status-gray", "已发放": "status-purple", "已接受": "status-green", "已拒绝": "status-red", "已撤回": "status-red" };
  return `<span class="badge ${map[s] || "status-gray"}">${escapeHtml(s)}</span>`;
}

export function tagBadge(tag) {
  const colors = { "高潜": "status-green", "紧急": "status-red", "待定": "status-gray", "优秀": "status-purple", "内推优先": "status-blue", "已拒绝其他Offer": "status-red" };
  return `<span class="badge ${colors[tag] || "status-gray"}" style="font-size:11px">${escapeHtml(tag)}</span>`;
}

export function followupBadge(follow) {
  if (!follow || typeof follow !== "object") return "";
  const action = String(follow.nextAction || "").trim();
  const at = String(follow.followAt || "").trim();
  if (!action && !at) return "";
  const now = new Date();
  let overdue = false;
  if (at) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(at);
    if (m) { overdue = new Date(m[1], m[2] - 1, m[3]).getTime() < now.getTime(); }
  }
  const text = [action ? `${action}` : "", at ? `${at}` : "", overdue ? "逾期" : ""].filter(Boolean).join(" · ");
  return `<span class="badge ${overdue ? "status-red" : "status-gray"}">${escapeHtml(text)}</span>`;
}

/**
 * 淡紫色简洁风格 — 左侧导航 + 干净配色
 */
export function renderPage({ title, user, active, contentHtml }) {
  const isAdmin = user?.role === "admin";
  const nav = [
    ["dashboard", "首页", "/", "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"],
    ["jobs", "职位", "/jobs", "M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2m4 6h.01M5 20h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"],
    ["candidates", "人才库", "/candidates", "M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"],
    ["board", "看板", "/candidates/board", "M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"],
    ["schedule", "日程", "/schedule", "M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"],
    ["offers", "Offer", "/offers", "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"],
    ["headhunters", "猎头", "/headhunters", "M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"],
    ...(isAdmin ? [
      ["settings", "设置", "/settings", "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z"],
    ] : []),
  ];

  const navHtml = nav
    .map(([key, label, href, icon]) => {
      const isActive = key === active || (key === "dashboard" && active === "");
      return `<a class="nav-item ${isActive ? "active" : ""}" href="${href}">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${icon}"/></svg>
        <span>${label}</span>
      </a>`;
    })
    .join("");

  const roleBadge = user
    ? (isAdmin
        ? '<span class="badge status-purple" style="font-size:11px">管理员</span>'
        : '<span class="badge status-gray" style="font-size:11px">成员</span>')
    : "";

  const avatarLetter = user?.name ? escapeHtml(user.name.slice(0, 1)) : "U";
  const userHtml = user
    ? `<div class="sidebar-user">
        <div class="avatar">${user.avatar ? '<img src="' + escapeHtml(user.avatar) + '" />' : avatarLetter}</div>
        <div class="user-meta">
          <div class="user-name">${escapeHtml(user.name || "")}</div>
          <div class="user-role">${roleBadge}</div>
        </div>
        <a class="logout-btn" href="/logout" title="退出">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/></svg>
        </a>
      </div>`
    : "";

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} - Machinepulse招聘系统</title>
<style>
:root{
  --bg:#faf9fb;--bg2:#ffffff;--card:#ffffff;--text:#2e2e3a;--muted:#999;
  --border:#eee;--border-light:#f0eef3;
  --primary:#7c5cfc;--primary-light:#f3f0ff;--primary-hover:#6b4ce0;--primary-bg:rgba(124,92,252,.04);
  --green:#52c41a;--green-bg:rgba(82,196,26,.06);--green-border:rgba(82,196,26,.15);
  --red:#f5222d;--red-bg:rgba(245,34,45,.05);--red-border:rgba(245,34,45,.15);
  --orange:#fa8c16;--orange-bg:rgba(250,140,22,.06);--orange-border:rgba(250,140,22,.15);
  --blue:#4e7bf6;--blue-bg:rgba(78,123,246,.06);--blue-border:rgba(78,123,246,.15);
  --purple:#7c5cfc;--purple-bg:rgba(124,92,252,.06);--purple-border:rgba(124,92,252,.12);
  --shadow:0 1px 3px rgba(0,0,0,.04);--shadow2:0 8px 30px rgba(0,0,0,.08);
  --radius:6px;--radius2:10px;--sidebar-w:200px;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--text);font-size:14px;line-height:1.6;display:flex}
a{color:inherit;text-decoration:none}
.muted{color:var(--muted);font-size:13px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px}

/* === 侧边栏 === */
.sidebar{width:var(--sidebar-w);height:100vh;background:#fff;border-right:1px solid var(--border-light);display:flex;flex-direction:column;flex-shrink:0;position:fixed;left:0;top:0;z-index:100}
.sidebar-brand{padding:20px 16px 20px;display:flex;align-items:center;gap:10px}
.brand-logo{width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,#a78bfa,#7c5cfc);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:13px}
.brand-text{font-weight:700;font-size:15px;color:var(--text)}
.brand-sub{font-size:11px;color:var(--muted);font-weight:400}
.sidebar-nav{flex:1;padding:4px 8px;overflow-y:auto}
.nav-item{display:flex;align-items:center;gap:10px;padding:9px 14px;border-radius:8px;color:var(--muted);font-size:13px;font-weight:500;transition:all .15s;margin-bottom:1px}
.nav-item:hover{background:#f7f5fa;color:var(--text)}
.nav-item.active{background:var(--primary-light);color:var(--primary);font-weight:600}
.nav-item svg{flex-shrink:0;opacity:.6}
.nav-item.active svg{opacity:1}
.sidebar-user{padding:14px 16px;border-top:1px solid var(--border-light);display:flex;align-items:center;gap:10px}
.avatar{width:30px;height:30px;border-radius:50%;background:linear-gradient(135deg,#a78bfa,#7c5cfc);color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;overflow:hidden;flex-shrink:0}
.avatar img{width:100%;height:100%;object-fit:cover}
.user-meta{flex:1;min-width:0}
.user-name{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.user-role{margin-top:1px}
.logout-btn{padding:6px;border-radius:6px;color:var(--muted);transition:.15s}
.logout-btn:hover{background:var(--red-bg);color:var(--red)}

/* === 主内容区 === */
.main{flex:1;margin-left:var(--sidebar-w);height:100vh;overflow-y:auto;overflow-x:hidden}
.container{max-width:1400px;padding:24px 28px 40px}
.page-header{display:flex;align-items:center;gap:12px;margin-bottom:20px;flex-wrap:wrap}
.page-title{font-size:18px;font-weight:700;color:var(--text)}
.spacer{flex:1}

/* === 卡片 === */
.card{background:var(--card);border:1px solid var(--border-light);border-radius:var(--radius2);box-shadow:var(--shadow);padding:20px}
.card.compact{padding:16px}
.card-title{font-weight:600;font-size:14px;margin-bottom:12px;display:flex;align-items:center;gap:8px}
.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.divider{height:1px;background:var(--border-light);margin:14px 0}

/* === Grid === */
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.grid5{display:grid;grid-template-columns:repeat(5,1fr);gap:12px}
@media(max-width:1100px){.grid,.grid3{grid-template-columns:1fr}.grid4,.grid5{grid-template-columns:repeat(2,1fr)}}

/* === 按钮 === */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--border);background:#fff;border-radius:var(--radius);padding:6px 14px;cursor:pointer;transition:all .15s;font-weight:500;font-size:13px;color:var(--text);white-space:nowrap}
.btn:hover{border-color:var(--primary);color:var(--primary);background:var(--primary-bg)}
.btn.primary{background:var(--primary);border-color:var(--primary);color:#fff}
.btn.primary:hover{background:var(--primary-hover)}
.btn.danger{background:var(--red-bg);border-color:var(--red-border);color:var(--red)}
.btn.danger:hover{background:var(--red);color:#fff}
.btn.sm{padding:4px 10px;font-size:12px;border-radius:5px}
.btn.ghost{border-color:transparent;background:transparent;color:var(--muted)}
.btn.ghost:hover{background:var(--primary-bg);color:var(--primary)}

/* === 表单 === */
.field{margin-bottom:14px}
label{display:block;font-size:13px;color:var(--muted);margin-bottom:5px;font-weight:500}
input,select,textarea{width:100%;padding:8px 12px;border-radius:var(--radius);border:1px solid var(--border);outline:none;background:#fff;transition:all .15s;font-size:13px;color:var(--text)}
input:focus,select:focus,textarea:focus{border-color:var(--primary);box-shadow:0 0 0 2px rgba(124,92,252,.1)}
input::placeholder,textarea::placeholder{color:#ccc}

/* === 表格 === */
table{width:100%;border-collapse:collapse}
th{font-size:12px;color:var(--muted);text-align:left;padding:8px 12px;border-bottom:1px solid var(--border-light);font-weight:600;white-space:nowrap}
td{padding:10px 12px;border-bottom:1px solid var(--border-light);font-size:13px;vertical-align:middle}
tr:hover td{background:var(--primary-bg)}
tr:last-child td{border-bottom:none}

/* === 徽章 === */
.badge{display:inline-flex;align-items:center;gap:4px;border-radius:4px;padding:2px 8px;font-size:12px;font-weight:500;white-space:nowrap;line-height:20px}
.status-gray{background:#f4f4f5;color:#8c8c8c}
.status-purple{background:var(--purple-bg);color:var(--purple);border:1px solid var(--purple-border)}
.status-blue{background:var(--blue-bg);color:var(--blue);border:1px solid var(--blue-border)}
.status-green{background:var(--green-bg);color:#389e0d;border:1px solid var(--green-border)}
.status-red{background:var(--red-bg);color:var(--red);border:1px solid var(--red-border)}
.status-orange{background:var(--orange-bg);color:#d46b08;border:1px solid var(--orange-border)}

/* === 统计卡片 === */
.stat-card{text-align:left;padding:16px 20px}
.stat-number{font-size:26px;font-weight:700;color:var(--text);line-height:1.2}
.stat-label{font-size:13px;color:var(--muted);margin-top:4px}

/* === 工具栏 === */
.toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 16px;background:#fff;border:1px solid var(--border-light);border-radius:var(--radius2);margin-bottom:14px}
.toolbar .ctl{display:flex;align-items:center;gap:6px;padding:0}
.toolbar .ctl label{margin:0;font-size:12px;color:var(--muted);white-space:nowrap}
.toolbar .ctl input,.toolbar .ctl select{border:1px solid var(--border);border-radius:var(--radius);padding:6px 10px;font-size:13px}
.toolbar .ctl input{min-width:200px}
.toolbar .ctl select{min-width:130px}

/* === 分段选择器 === */
.seg{display:flex;gap:2px;background:#f4f3f6;border-radius:var(--radius);padding:3px}
.seg a,.seg button{padding:5px 12px;border-radius:5px;font-weight:500;font-size:13px;border:none;background:transparent;color:var(--muted);cursor:pointer;transition:all .15s;white-space:nowrap}
.seg a:hover,.seg button:hover{color:var(--text)}
.seg a.active,.seg button.active{background:#fff;color:var(--text);box-shadow:0 1px 3px rgba(0,0,0,.06);font-weight:600}

/* === Pill === */
.pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:6px;background:#f7f6f9;font-size:13px}
.pill .muted{font-size:12px}
.pill b{font-weight:600}

/* === 进度条 === */
.bar{height:5px;border-radius:999px;background:#f0eef3;overflow:hidden;margin-top:4px}
.bar-fill{height:100%;border-radius:999px;transition:width .3s ease}
.bar-blue{background:var(--blue)}
.bar-green{background:var(--green)}
.bar-red{background:var(--red)}
.bar-orange{background:var(--orange)}
.bar-purple{background:linear-gradient(90deg,#a78bfa,#7c5cfc)}

/* === 看板 === */
.kanban{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;overflow-x:auto;padding-bottom:10px;height:calc(100vh - 200px)}
@media(max-width:1200px){.kanban{grid-template-columns:repeat(6,210px)}}
.kanban-status{grid-template-columns:repeat(16,190px)!important}
@media(max-width:1200px){.kanban-status{grid-template-columns:repeat(16,170px)!important}}
.col{border:1px solid var(--border-light);border-radius:var(--radius2);background:#faf9fb;min-height:300px;display:flex;flex-direction:column;height:fit-content;max-height:100%}
.colhead{padding:12px 14px 10px;border-bottom:1px solid var(--border-light);display:flex;align-items:center;gap:8px;background:#fff;border-radius:var(--radius2) var(--radius2) 0 0}
.coltitle{font-weight:700;font-size:13px;color:var(--text);display:flex;align-items:center;gap:6px}
.colcount{margin-left:auto;font-size:12px;color:var(--muted);background:#f4f3f6;padding:2px 10px;border-radius:10px;font-weight:600}
.colbody{padding:8px;display:flex;flex-direction:column;gap:6px;overflow-y:auto;flex:1}
.carditem{border:1px solid var(--border-light);border-radius:var(--radius);background:#fff;padding:10px 12px;cursor:pointer;transition:all .15s}
.carditem:hover{border-color:#c4b5fd;box-shadow:0 2px 10px rgba(124,92,252,.08);transform:translateY(-1px)}
.cardtitle{font-weight:600;font-size:13px;display:flex;align-items:center;gap:8px;margin-bottom:5px}
.card-avatar{width:22px;height:22px;border-radius:50%;color:#fff;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0}
.card-meta{font-size:12px;color:var(--muted);max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cardsub{display:flex;gap:6px;flex-wrap:wrap;align-items:center}

/* === 抽屉 === */
.drawerMask{position:fixed;inset:0;background:rgba(0,0,0,.2);display:none;z-index:200;backdrop-filter:blur(1px)}
.drawer{position:fixed;right:0;top:0;height:100%;width:min(560px,96vw);background:#fff;border-left:1px solid var(--border-light);box-shadow:var(--shadow2);transform:translateX(102%);transition:transform .2s ease;z-index:210;display:flex;flex-direction:column}
.drawer.open{transform:translateX(0)}
.drawerMask.open{display:block}
.drawerHeader{padding:16px 20px;border-bottom:1px solid var(--border-light);display:flex;align-items:center;gap:12px}
.drawerTitle{font-weight:700;font-size:16px}
.drawerBody{padding:16px 20px;overflow-y:auto;flex:1}
.drawerClose{margin-left:auto;width:28px;height:28px;border-radius:6px;border:1px solid var(--border-light);background:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:14px;transition:.15s}
.drawerClose:hover{background:var(--red-bg);color:var(--red)}

/* === Tabs === */
.tabs{display:flex;gap:0;border-bottom:1px solid var(--border-light);margin-bottom:16px}
.tab{padding:10px 16px;font-weight:500;font-size:13px;color:var(--muted);cursor:pointer;border:none;background:transparent;border-bottom:2px solid transparent;transition:all .15s;white-space:nowrap}
.tab:hover{color:var(--text)}
.tab.active{color:var(--primary);border-bottom-color:var(--primary);font-weight:600}
.tabpanels{margin-top:0}
.tabpanel{display:none}
.tabpanel.active{display:block}

/* === 时间线 === */
.timeline{position:relative;padding-left:18px}
.timeline:before{content:'';position:absolute;left:5px;top:8px;bottom:8px;width:2px;background:var(--border-light);border-radius:999px}
.titem{position:relative;padding:10px 14px;border:1px solid var(--border-light);border-radius:var(--radius);background:#fff;margin-bottom:8px}
.titem:before{content:'';position:absolute;left:-16px;top:14px;width:7px;height:7px;border-radius:50%;background:var(--primary);box-shadow:0 0 0 3px var(--primary-light)}
.tmeta{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:4px}
.tmeta b{font-weight:600;font-size:13px}
.tmsg{color:#666;font-size:13px;line-height:1.6}

/* === 日历 === */
.cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:1px;background:var(--border-light);border:1px solid var(--border-light);border-radius:var(--radius)}
.cal-head{text-align:center;font-weight:600;font-size:12px;color:var(--muted);padding:8px 0;background:#faf9fb}
.cal-cell{min-height:90px;padding:6px 8px;background:#fff;font-size:12px}
.cal-cell.empty{background:#faf9fb}
.cal-cell.today{background:var(--primary-bg)}
.cal-day{font-weight:600;font-size:13px;margin-bottom:4px;color:var(--text)}
.cal-cell.today .cal-day{color:var(--primary)}
.cal-dot{display:block;padding:2px 4px;margin-bottom:2px;border-radius:4px;background:var(--purple-bg);color:var(--purple);font-size:11px;font-weight:600;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cal-dot:hover{background:var(--primary-light)}

/* === 周视图 === */
.wk-grid{display:grid;grid-template-columns:60px repeat(7,1fr);gap:0;border:1px solid var(--border-light);border-radius:var(--radius);overflow:hidden;min-width:700px}
.wk-corner{background:#faf9fb;border-bottom:1px solid var(--border-light);border-right:1px solid var(--border-light);padding:8px}
.wk-head{text-align:center;padding:10px 4px;background:#faf9fb;border-bottom:1px solid var(--border-light);border-right:1px solid var(--border-light)}
.wk-head:last-child{border-right:none}
.wk-head.wk-today{background:var(--primary-bg)}
.wk-dayname{font-size:12px;color:var(--muted);font-weight:600}
.wk-daynum{font-size:18px;font-weight:700;color:var(--text);margin-top:2px}
.wk-today-num{color:var(--primary);background:var(--primary-light);border-radius:50%;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center}
.wk-time{font-size:11px;color:var(--muted);text-align:right;padding:4px 8px;border-right:1px solid var(--border-light);border-bottom:1px solid var(--border-light);background:#faf9fb;min-height:56px;display:flex;align-items:flex-start;justify-content:flex-end}
.wk-cell{border-right:1px solid var(--border-light);border-bottom:1px solid var(--border-light);padding:2px 4px;min-height:56px;background:#fff;transition:background .1s}
.wk-cell:last-child{border-right:none}
.wk-cell:hover{background:var(--primary-bg)}
.wk-cell-today{background:rgba(124,92,252,.02)}
.wk-event{display:block;padding:4px 6px;border-radius:4px;margin-bottom:2px;font-size:11px;text-decoration:none;color:var(--text);transition:all .12s;cursor:pointer}
.wk-event:hover{transform:scale(1.02);box-shadow:0 2px 8px rgba(0,0,0,.08)}
.wk-ev-time{font-size:10px;font-weight:700;color:var(--muted)}
.wk-ev-name{font-weight:700;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wk-ev-meta{font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* === 流水线摘要 === */
.pipeline-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:center}
.pipeline-stage{display:flex;align-items:center;gap:6px;padding:6px 14px;border-radius:var(--radius);background:transparent}
.pipeline-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.pipeline-info{min-width:0;text-align:center}
.pipeline-name{font-size:12px;color:var(--muted);font-weight:500}
.pipeline-num{font-size:16px;font-weight:700;color:var(--text);line-height:1.3}
.pipeline-arrow{color:#d0d0d0;font-size:16px;font-weight:300;padding:0 2px}

/* === 面评汇总 === */
.review-summary{padding:20px}
.rv-round-row{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:var(--radius);background:#f7f6f9;margin-bottom:6px}

/* === 提醒卡片 === */
.reminder-card{border-left:3px solid var(--primary)}
.remind-section{margin-bottom:10px}
.remind-title{font-weight:600;font-size:14px;margin-bottom:8px;display:flex;align-items:center;gap:8px}
.remind-item{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:var(--radius);margin-bottom:4px;background:#f7f6f9;border:1px solid var(--border-light);font-size:13px}
.remind-time{font-weight:700;font-size:13px;color:var(--primary);min-width:45px}

/* === 候选人资料卡 === */
.profile-card{padding:24px}
.profile-header{display:flex;gap:20px;align-items:flex-start}
.profile-avatar{width:56px;height:56px;border-radius:50%;color:#fff;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;flex-shrink:0}
.profile-info{flex:1;min-width:0}
.profile-name{font-size:18px;font-weight:700;display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px}
.profile-meta{display:flex;gap:16px;flex-wrap:wrap;color:var(--muted);font-size:13px}
.profile-meta span{display:flex;align-items:center;gap:4px}

/* === 进度条 === */
.progress-bar{display:flex;align-items:center;gap:0;margin-top:16px;padding:0 16px}
.progress-step{display:flex;flex-direction:column;align-items:center;gap:4px;min-width:60px}
.step-dot{width:26px;height:26px;border-radius:50%;background:#f0eef3;color:var(--muted);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;border:2px solid var(--border-light)}
.progress-step.active .step-dot{background:var(--primary);color:#fff;border-color:var(--primary)}
.progress-step.done .step-dot{background:var(--green);color:#fff;border-color:var(--green)}
.step-label{font-size:11px;color:var(--muted);text-align:center;white-space:nowrap}
.progress-step.active .step-label{color:var(--primary);font-weight:600}
.progress-step.done .step-label{color:var(--green)}
.step-line{flex:1;height:2px;background:var(--border-light);min-width:20px}
.progress-step.done+.step-line{background:var(--green)}

/* === 批量操作栏 === */
.batch-bar{display:flex;align-items:center;gap:10px;padding:10px 16px;background:var(--primary-light);border:1px solid var(--purple-border);border-radius:var(--radius);margin-bottom:12px}
.batch-bar span:first-child{font-weight:600;font-size:13px;color:var(--primary);min-width:80px}

/* === 对比 === */
.comparison-section{margin-top:12px}
.comparison-section table{width:100%;font-size:12px;border-collapse:collapse}
.comparison-section th,.comparison-section td{padding:8px;text-align:center;border-bottom:1px solid var(--border-light)}
.comparison-section th{background:#faf9fb;font-weight:600;font-size:11px}

/* === 空状态 === */
.empty-state{text-align:center;padding:40px 20px;color:var(--muted)}

/* === 响应式 === */
@media(max-width:768px){
  .sidebar{width:56px}.sidebar .brand-text,.sidebar .brand-sub,.sidebar .nav-item span,.sidebar .user-meta,.sidebar .logout-btn{display:none}
  .sidebar .nav-item{justify-content:center;padding:10px}
  .main{margin-left:56px}
  .container{padding:12px}
}

/* === 滚动条 === */
::-webkit-scrollbar{width:5px;height:5px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:#ddd;border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:#bbb}
</style>
</head>
<body>
  <div class="sidebar">
    <div class="sidebar-brand">
      <div class="brand-logo">M</div>
      <div>
        <div class="brand-text">Machinepulse招聘系统</div>
        <div class="brand-sub">Machinepulse Recruit</div>
      </div>
    </div>
    <div class="sidebar-nav">${navHtml}</div>
    ${userHtml}
  </div>
  <div class="main">
    <div class="container">
      ${contentHtml}
    </div>
  </div>
</body>
</html>`;
}
