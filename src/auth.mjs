import cookieSession from "cookie-session";

// Session 中间件：使用 cookie-session，数据存在客户端 cookie 中
// 兼容 serverless（Vercel）和本地开发
export function sessionMiddleware() {
  return cookieSession({
    name: "rp.sid",
    keys: [(process.env.SESSION_SECRET || "dev_secret_change_me")],
    maxAge: 7 * 24 * 3600 * 1000,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
  });
}

// 登录页面渲染
export function registerAuthRoutes(app, renderPage) {
  app.get("/login", (req, res) => {
    if (req.session?.user) return res.redirect("/candidates");

    res.send(
      renderPage({
        title: "登录",
        user: null,
        active: "",
        contentHtml: `
        <div class="card" style="max-width:560px;margin:30px auto;">
          <div style="font-weight:900;font-size:18px">登录 Recruit Platform</div>
          <div class="muted">（MVP：先用姓名登录，后续再接飞书授权登录）</div>
          <div class="divider"></div>
          <form method="POST" action="/login">
            <div class="field">
              <label>你的姓名</label>
              <input name="name" placeholder="例如：丁彦文" required />
            </div>
            <button class="btn primary" type="submit">进入系统</button>
          </form>
        </div>
      `,
      })
    );
  });

  app.post("/login", (req, res) => {
    const name = String(req.body?.name || "").trim();
    if (!name) return res.redirect("/login");
    req.session.user = { id: "dev_" + Date.now(), name, provider: "dev" };
    res.redirect("/candidates");
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