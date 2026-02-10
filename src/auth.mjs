import cookieSession from "cookie-session";
import crypto from "crypto";
import { feishuEnabled, getFeishuAuthUrl, getFeishuUserByCode } from "./feishu.mjs";

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

    // 飞书登录按钮：仅当飞书功能启用时显示
    const feishuBtn = feishuEnabled()
      ? `<div class="divider"></div>
         <a href="/auth/feishu" class="btn" style="display:inline-flex;align-items:center;gap:6px;text-decoration:none;background:#2b6cb0;color:#fff;width:100%;justify-content:center;">
           <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M3 3l7.07 5.5L3 21l10.5-7.5L21 21l-7.07-5.5L21 3 10.5 10.5z" fill="#fff"/></svg>
           飞书登录
         </a>`
      : `<div class="muted" style="margin-top:12px;font-size:12px;">飞书登录未启用（缺少 FEISHU_APP_ID / FEISHU_APP_SECRET 环境变量）</div>`;

    res.send(
      renderPage({
        title: "登录",
        user: null,
        active: "",
        contentHtml: `
        <div class="card" style="max-width:560px;margin:30px auto;">
          <div style="font-weight:900;font-size:18px">登录 Recruit Platform</div>
          <div class="muted">选择登录方式</div>
          <div class="divider"></div>
          ${feishuBtn}
          <div class="divider"></div>
          <details style="margin-top:8px;">
            <summary style="cursor:pointer;color:#666;font-size:13px;">使用姓名登录（备选）</summary>
            <form method="POST" action="/login" style="margin-top:10px;">
              <div class="field">
                <label>你的姓名</label>
                <input name="name" placeholder="例如：丁彦文" required />
              </div>
              <button class="btn primary" type="submit">进入系统</button>
            </form>
          </details>
        </div>
      `,
      })
    );
  });

  // 姓名登录（保留作为备选）
  app.post("/login", (req, res) => {
    const name = String(req.body?.name || "").trim();
    if (!name) return res.redirect("/login");
    req.session.user = { id: "dev_" + Date.now(), name, provider: "dev" };
    res.redirect("/candidates");
  });

  // ====== 飞书 OAuth 路由 ======

  // 发起飞书授权：重定向到飞书授权页
  app.get("/auth/feishu", (req, res) => {
    if (!feishuEnabled()) {
      return res.status(400).send("飞书登录未启用，请配置 FEISHU_APP_ID 和 FEISHU_APP_SECRET 环境变量。");
    }

    // 生成随机 state 防 CSRF
    const state = crypto.randomBytes(16).toString("hex");
    // 将 state 存入 session，回调时验证
    req.session.feishuOAuthState = state;

    const authUrl = getFeishuAuthUrl(state);
    res.redirect(authUrl);
  });

  // 飞书 OAuth 回调
  app.get("/auth/feishu/callback", async (req, res) => {
    try {
      const { code, state } = req.query;

      // 校验 state
      const savedState = req.session?.feishuOAuthState;
      if (!state || !savedState || state !== savedState) {
        console.warn("[Auth] Feishu OAuth state mismatch:", { state, savedState });
        return res.status(403).send("授权状态校验失败，请重新登录。<br><a href=\"/login\">返回登录页</a>");
      }

      // 清除已使用的 state
      req.session.feishuOAuthState = null;

      if (!code) {
        return res.status(400).send("飞书授权失败：未返回 code。<br><a href=\"/login\">返回登录页</a>");
      }

      // 用 code 换取用户信息
      const feishuUser = await getFeishuUserByCode(code);

      // 写入 session
      req.session.user = {
        id: feishuUser.openId,
        name: feishuUser.name || "飞书用户",
        provider: "feishu",
        openId: feishuUser.openId,
        avatarUrl: feishuUser.avatarUrl || "",
        email: feishuUser.email || "",
      };

      console.log("[Auth] Feishu login success:", feishuUser.name, feishuUser.openId);
      res.redirect("/candidates");
    } catch (err) {
      console.error("[Auth] Feishu OAuth callback error:", err);
      res.status(500).send(
        "飞书登录失败：" + (err.message || String(err)) + "<br><a href=\"/login\">返回登录页</a>"
      );
    }
  });

  // 登出
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
