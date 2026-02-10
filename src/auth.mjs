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

export function registerAuthRoutes(app, renderPage) {
  app.get("/login", (req, res) => {
    if (req.session?.user) return res.redirect("/candidates");

    const feishuBtn = feishuEnabled()
      ? `<div class="divider"></div>
         <a href="/auth/feishu" class="btn" style="display:block;text-align:center;background:#3370ff;color:#fff;text-decoration:none;">飞书登录</a>`
      : "";

    res.send(
      renderPage({
        title: "登录",
        user: null,
        active: "",
        contentHtml: `
        <div class="card" style="max-width:560px;margin:30px auto;">
          <div style="font-weight:900;font-size:18px">登录 Recruit Platform</div>
          <div class="muted">输入姓名快速登录，或使用飞书授权</div>
          <div class="divider"></div>
          <form method="POST" action="/login">
            <div class="field">
              <label>你的姓名</label>
              <input name="name" placeholder="例如：张三" required />
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
    const d = await loadData();
    let existing = d.users.find(u => u.name === name && u.provider === "dev");
    if (!existing) {
      existing = {
        id: rid("usr"), openId: "", unionId: "", name, avatar: "",
        department: "", jobTitle: "", provider: "dev", role: "member", createdAt: nowIso(),
      };
      d.users.push(existing);
      await saveData(d);
    }
    req.session.user = { id: existing.id, name: existing.name, role: existing.role || "member", provider: "dev" };
    res.redirect("/candidates");
  });

  app.get("/auth/feishu", (req, res) => {
    if (!feishuEnabled()) return res.redirect("/login");
    res.redirect(getFeishuAuthUrl("login"));
  });

  app.get("/auth/feishu/callback", async (req, res) => {
    try {
      const code = req.query.code;
      if (!code) return res.redirect("/login");
      const feishuUser = await getFeishuUserByCode(code);
      const d = await loadData();
      let existing = d.users.find(u => u.openId === feishuUser.openId);
      if (existing) {
        existing.name = feishuUser.name;
        existing.avatar = feishuUser.avatar;
      } else {
        existing = {
          id: rid("usr"), openId: feishuUser.openId, unionId: feishuUser.unionId || "",
          name: feishuUser.name, avatar: feishuUser.avatar,
          department: "", jobTitle: "", provider: "feishu", role: "member", createdAt: nowIso(),
        };
        d.users.push(existing);
      }
      await saveData(d);
      req.session.user = {
        id: existing.id, name: existing.name, avatar: existing.avatar,
        openId: existing.openId, unionId: existing.unionId, role: existing.role || "member", provider: "feishu",
      };
      res.redirect("/candidates");
    } catch (e) {
      console.error("[Feishu OAuth] 失败:", e.message);
      res.redirect("/login");
    }
  });

  app.get("/logout", (req, res) => {
    req.session = null;
    res.redirect("/login");
  });
}

export function requireLogin(req, res, next) {
  if (req.session?.user) {
    req.user = req.session.user;
    return next();
  }
  return res.redirect("/login");
}

export function requireAdmin(req, res, next) {
  if (req.user?.role === "admin") {
    return next();
  }
  const isApi = req.path.startsWith("/api/");
  if (isApi) {
    return res.status(403).json({ error: "权限不足，需要管理员权限" });
  }
  return res.status(403).send(
    `<!doctype html><html><head><meta charset="utf-8"><title>权限不足</title>
    <style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC",sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#faf7ff}
    .box{text-align:center;padding:40px;border-radius:18px;background:#fff;border:1px solid rgba(237,233,254,.9);box-shadow:0 10px 30px rgba(17,24,39,.08)}
    .box h2{margin:0 0 8px;color:#111827}.box p{color:#6b7280;margin:0 0 16px}
    a{display:inline-block;padding:9px 16px;border-radius:12px;background:linear-gradient(180deg,#a78bfa,#8b5cf6);color:#fff;text-decoration:none;font-weight:600}</style></head>
    <body><div class="box"><h2>权限不足</h2><p>该操作需要管理员权限，请联系管理员。</p><a href="/">返回首页</a></div></body></html>`
  );
}
