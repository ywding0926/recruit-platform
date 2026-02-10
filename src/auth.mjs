import cookieSession from "cookie-session";
import { feishuEnabled, getFeishuAuthUrl, getFeishuUserByCode } from "./feishu.mjs";
import { loadData, saveData, rid, nowIso } from "./db.mjs";

export function sessionMiddleware() {
  return cookieSession({
    name: "rp.sid",
    keys: [(process.env.SESSION_SECRET || "dev_secret_change_me")],
    maxAge: 7 * 24 * 3600 * 1000,
    sameSite: "lax",
    secure: false,
    httpOnly: true,
  });
}

// 角色常量
export const ROLES = {
  ADMIN: "admin",
  HR: "hr",
  INTERVIEWER: "interviewer",
};

export const ROLE_LABELS = {
  admin: "管理员",
  hr: "HR",
  interviewer: "面试官",
};

// 登录页面渲染 + 飞书 OAuth 路由
export function registerAuthRoutes(app, renderPage) {
  app.get("/login", (req, res) => {
    if (req.session?.user) return res.redirect("/candidates");

    const feishuBtn = feishuEnabled()
      ? `<div class="divider"></div>
         <a href="/auth/feishu" class="btn" style="display:block;text-align:center;background:#3370ff;color:#fff;text-decoration:none;">
           飞书登录
         </a>`
      : "";

    res.send(
      renderPage({
        title: "登录",
        user: null,
        active: "",
        contentHtml: `
        <div class="card" style="max-width:560px;margin:30px auto;">
          <div style="font-weight:900;font-size:18px">登录 Recruit Platform</div>
          <div class="muted">（MVP：先用姓名登录，或使用飞书授权登录）</div>
          <div class="divider"></div>
          <form method="POST" action="/login">
            <div class="field">
              <label>你的姓名</label>
              <input name="name" placeholder="例如：丁彦文" required />
            </div>
            <button class="btn primary" type="submit">进入系统</button>
          </form>
          ${feishuBtn}
        </div>
      `,
      })
    );
  });

  app.post("/login", async (req, res) => {
    const name = String(req.body?.name || "").trim();
    if (!name) return res.redirect("/login");
    // 开发模式登录：检查是否已有用户记录
    const d = await loadData();
    let existing = d.users.find(u => u.name === name && u.provider === "dev");
    if (!existing) {
      // 首个用户自动成为管理员
      const role = d.users.length === 0 ? ROLES.ADMIN : ROLES.INTERVIEWER;
      existing = {
        id: rid("usr"),
        openId: "",
        unionId: "",
        name,
        avatar: "",
        role,
        department: "",
        jobTitle: "",
        provider: "dev",
        createdAt: nowIso(),
      };
      d.users.push(existing);
      await saveData(d);
    }
    req.session.user = { id: existing.id, name: existing.name, role: existing.role, provider: "dev" };
    res.redirect("/candidates");
  });

  // 飞书 OAuth：跳转到飞书授权页
  app.get("/auth/feishu", (req, res) => {
    if (!feishuEnabled()) return res.redirect("/login");
    const url = getFeishuAuthUrl("login");
    res.redirect(url);
  });

  // 飞书 OAuth：回调 — 自动注册/更新用户
  app.get("/auth/feishu/callback", async (req, res) => {
    try {
      const code = req.query.code;
      if (!code) return res.redirect("/login");
      const feishuUser = await getFeishuUserByCode(code);

      // 查找或创建用户
      const d = await loadData();
      let existing = d.users.find(u => u.openId === feishuUser.openId);
      if (existing) {
        // 更新姓名和头像
        existing.name = feishuUser.name;
        existing.avatar = feishuUser.avatar;
      } else {
        // 首个用户自动成为管理员
        const role = d.users.length === 0 ? ROLES.ADMIN : ROLES.INTERVIEWER;
        existing = {
          id: rid("usr"),
          openId: feishuUser.openId,
          unionId: feishuUser.unionId || "",
          name: feishuUser.name,
          avatar: feishuUser.avatar,
          role,
          department: "",
          jobTitle: "",
          provider: "feishu",
          createdAt: nowIso(),
        };
        d.users.push(existing);
      }
      // 管理员白名单：指定 openId 强制设为管理员
      const ADMIN_OPEN_IDS = ["ou_9e192ed89ed068cc3edc68e10ab05a23"];
      if (ADMIN_OPEN_IDS.includes(feishuUser.openId) && existing.role !== ROLES.ADMIN) {
        existing.role = ROLES.ADMIN;
      }
      await saveData(d);

      req.session.user = {
        id: existing.id,
        name: existing.name,
        avatar: existing.avatar,
        openId: existing.openId,
        unionId: existing.unionId,
        role: existing.role,
        provider: "feishu",
      };
      res.redirect("/candidates");
    } catch (e) {
      console.error("[Feishu OAuth] 失败:", e.message);
      res.redirect("/login");
    }
  });

  // 提升为管理员（仅限已登录用户，更新数据库+session）
  app.get("/admin/promote", async (req, res) => {
    if (!req.session?.user) return res.redirect("/login");
    const d = await loadData();
    const u = d.users.find(x => x.id === req.session.user.id);
    if (u) {
      u.role = ROLES.ADMIN;
      await saveData(d);
      req.session.user = { ...req.session.user, role: ROLES.ADMIN };
    }
    res.redirect("/");
  });

  app.get("/logout", (req, res) => {
    req.session = null;
    res.redirect("/login");
  });
}

// 登录保护中间件
export function requireLogin(req, res, next) {
  if (req.session?.user) {
    req.user = req.session.user;
    return next();
  }
  return res.redirect("/login");
}

// 角色权限中间件：requireRole(["admin"]) 或 requireRole(["admin", "hr"])
export function requireRole(roles) {
  return (req, res, next) => {
    if (!req.session?.user) return res.redirect("/login");
    req.user = req.session.user;
    const userRole = req.user.role || ROLES.INTERVIEWER;
    if (roles.includes(userRole)) return next();
    return res.status(403).send(`
      <div style="text-align:center;padding:60px;font-family:sans-serif;">
        <h2>无权限访问</h2>
        <p>你的角色是「${ROLE_LABELS[userRole] || userRole}」，此页面需要「${roles.map(r => ROLE_LABELS[r] || r).join(" / ")}」权限。</p>
        <a href="/candidates" style="color:#8b5cf6;">返回首页</a>
      </div>
    `);
  };
}
