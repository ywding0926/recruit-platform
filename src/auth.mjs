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
        department: "", jobTitle: "", provider: "dev", createdAt: nowIso(),
      };
      d.users.push(existing);
      await saveData(d);
    }
    req.session.user = { id: existing.id, name: existing.name, provider: "dev" };
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
          department: "", jobTitle: "", provider: "feishu", createdAt: nowIso(),
        };
        d.users.push(existing);
      }
      await saveData(d);
      req.session.user = {
        id: existing.id, name: existing.name, avatar: existing.avatar,
        openId: existing.openId, unionId: existing.unionId, provider: "feishu",
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