import cookieSession from "cookie-session";
import { feishuEnabled, getFeishuAuthUrl, getFeishuUserByCode } from "./feishu.mjs";
import { loadData, saveData, rid, nowIso } from "./db.mjs";

export function sessionMiddleware() {
  const isProd = ["production", "prod"].includes(String(process.env.NODE_ENV || "").toLowerCase());
  const isVercel = !!process.env.VERCEL;

  return cookieSession({
    name: "rp.sid",
    keys: [process.env.SESSION_SECRET || "dev_secret_change_me"],
    maxAge: 7 * 24 * 3600 * 1000,
    sameSite: "lax",
    // ✅ 线上 https 下必须 secure=true，否则飞书回调后可能丢 session
    secure: isProd || isVercel,
    httpOnly: true,
  });
}

// 为了兼容 index.mjs 的 import（它会 import ROLES/ROLE_LABELS/requireRole），这里保留空实现
export const ROLES = { USER: "user" };
export const ROLE_LABELS = { user: "用户" };

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

  // ✅ 开发模式：姓名登录（不写角色）
  app.post("/login", async (req, res) => {
    const name = String(req.body?.name || "").trim();
    if (!name) return res.redirect("/login");

    const d = await loadData();
    let existing = d.users.find((u) => u.name === name && u.provider === "dev");
    if (!existing) {
      existing = {
        id: rid("usr"),
        openId: "",
        unionId: "",
        name,
        avatar: "",
        role: "", // ✅ 不使用角色
        department: "",
        jobTitle: "",
        provider: "dev",
        createdAt: nowIso(),
      };
      d.users.push(existing);
      await saveData(d);
    }

    req.session.user = {
      id: existing.id,
      name: existing.name,
      avatar: existing.avatar,
      openId: existing.openId,
      unionId: existing.unionId,
      role: "", // ✅ 不使用角色
      provider: existing.provider,
    };
    res.redirect("/candidates");
  });

  // 飞书 OAuth：跳转授权页
  app.get("/auth/feishu", (req, res) => {
    if (!feishuEnabled()) return res.redirect("/login");
    res.redirect(getFeishuAuthUrl("login"));
  });

  // 飞书 OAuth：回调（不写角色）
  app.get("/auth/feishu/callback", async (req, res) => {
    try {
      const code = req.query.code;
      if (!code) return res.redirect("/login");

      const feishuUser = await getFeishuUserByCode(code);
      const d = await loadData();

      let existing = d.users.find((u) => u.openId === feishuUser.openId);
      if (existing) {
        existing.name = feishuUser.name;
        existing.avatar = feishuUser.avatar;
        existing.unionId = feishuUser.unionId || existing.unionId || "";
        existing.role = ""; // ✅ 不使用角色
      } else {
        existing = {
          id: rid("usr"),
          openId: feishuUser.openId,
          unionId: feishuUser.unionId || "",
          name: feishuUser.name,
          avatar: feishuUser.avatar,
          role: "", // ✅ 不使用角色
          department: "",
          jobTitle: "",
          provider: "feishu",
          createdAt: nowIso(),
        };
        d.users.push(existing);
      }

      await saveData(d);

      req.session.user = {
        id: existing.id,
        name: existing.name,
        avatar: existing.avatar,
        openId: existing.openId,
        unionId: existing.unionId,
        role: "",
        provider: "feishu",
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

// ✅ 不做任何角色校验：永远放行
export function requireRole(_roles) {
  return (_req, _res, next) => next();
}
