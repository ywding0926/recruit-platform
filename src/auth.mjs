import cookieSession from "cookie-session";
import { feishuEnabled, getFeishuAuthUrl, getFeishuUserByCode } from "./feishu.mjs";
import { loadData, saveData, rid, nowIso } from "./db.mjs";
import { supabaseEnabled, getSupabaseAdmin } from "./supabase.mjs";

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

    // 飞书已启用时直接跳转飞书授权
    if (feishuEnabled() && req.query.direct !== "0") {
      return res.redirect("/auth/feishu");
    }

    res.send(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 - Machinepulse招聘系统</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;background:#faf9fb;min-height:100vh;display:flex;align-items:center;justify-content:center}
.login-box{width:100%;max-width:400px;padding:40px;background:#fff;border-radius:16px;border:1px solid #e8e9eb;box-shadow:0 4px 24px rgba(0,0,0,.06)}
.logo{display:flex;align-items:center;gap:12px;margin-bottom:8px}
.logo-icon{width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#7c5cfc,#6b4ce0);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:18px}
.logo-text{font-size:20px;font-weight:700;color:#1f2329}
.logo-sub{font-size:12px;color:#8f959e;font-weight:400}
.desc{color:#8f959e;font-size:13px;margin-bottom:24px}
.btn-feishu{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:12px 20px;border-radius:8px;background:linear-gradient(135deg,#7c5cfc,#6b4ce0);color:#fff;text-decoration:none;font-weight:600;font-size:15px;box-shadow:0 2px 12px rgba(124,92,252,.3);transition:all .15s;border:none;cursor:pointer}
.btn-feishu:hover{background:linear-gradient(135deg,#6b4ce0,#5a3dcf);box-shadow:0 4px 16px rgba(124,92,252,.4)}
.footer{text-align:center;margin-top:24px;color:#c9cdd4;font-size:11px}
</style>
</head>
<body>
  <div class="login-box">
    <div class="logo">
      <div class="logo-icon">M</div>
      <div>
        <div class="logo-text">Machinepulse招聘系统</div>
        <div class="logo-sub">Machinepulse Recruit</div>
      </div>
    </div>
    <p class="desc">使用飞书账号登录招聘系统</p>
    <a href="/auth/feishu" class="btn-feishu">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
      飞书账号登录
    </a>
    <div class="footer">Machinepulse Recruit v2.3</div>
  </div>
</body>
</html>`);
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

      console.log("[Feishu CB] feishuUser openId:", feishuUser.openId, "name:", feishuUser.name);
      console.log("[Feishu CB] users count:", d.users.length);
      const admins = d.users.filter(u => u.role === "admin");
      console.log("[Feishu CB] admin users:", admins.map(u => `${u.name}(openId=${u.openId},id=${u.id})`).join("; ") || "无");

      let existing = d.users.find(u => u.openId && u.openId === feishuUser.openId);
      console.log("[Feishu CB] openId match:", existing ? `${existing.name}(role=${existing.role})` : "无");

      if (!existing) {
        existing = d.users.find(u => u.name === feishuUser.name && u.provider === "feishu");
        console.log("[Feishu CB] name+provider match:", existing ? `${existing.name}(role=${existing.role})` : "无");
      }

      if (!existing) {
        const byName = d.users.filter(u => u.name === feishuUser.name);
        existing = byName.find(u => u.role === "admin") || byName[0];
        console.log("[Feishu CB] name match:", existing ? `${existing.name}(role=${existing.role})` : "无");
      }

      if (existing) {
        existing.openId = feishuUser.openId;
        existing.unionId = feishuUser.unionId || existing.unionId || "";
        existing.name = feishuUser.name;
        existing.avatar = feishuUser.avatar;
        existing.provider = "feishu";
      } else {
        existing = {
          id: rid("usr"), openId: feishuUser.openId, unionId: feishuUser.unionId || "",
          name: feishuUser.name, avatar: feishuUser.avatar,
          department: "", jobTitle: "", provider: "feishu", role: "member", createdAt: nowIso(),
        };
        d.users.push(existing);
      }

      if (supabaseEnabled) {
        try {
          const sb = getSupabaseAdmin();
          const { data: rows, error: err1 } = await sb.from("users").select("role").eq("open_id", feishuUser.openId).limit(1);
          console.log("[Feishu CB] Supabase query by open_id:", JSON.stringify(rows), "err:", err1?.message || "无");
          if (rows && rows[0] && rows[0].role) {
            existing.role = rows[0].role;
          } else {
            const { data: rows2, error: err2 } = await sb.from("users").select("role").eq("name", feishuUser.name).limit(1);
            console.log("[Feishu CB] Supabase query by name:", JSON.stringify(rows2), "err:", err2?.message || "无");
            if (rows2 && rows2[0] && rows2[0].role) {
              existing.role = rows2[0].role;
            }
          }
        } catch (e2) {
          console.warn("[Feishu CB] direct role query failed:", e2.message);
        }
      }

      await saveData(d);

      const finalRole = existing.role || "member";
      console.log("[Feishu Login] FINAL:", existing.name, "role:", finalRole, "id:", existing.id, "openId:", existing.openId);
      req.session.user = {
        id: existing.id, name: existing.name, avatar: existing.avatar,
        openId: existing.openId, unionId: existing.unionId, role: finalRole, provider: "feishu",
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
    <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,"PingFang SC",sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#faf9fb}
    .box{text-align:center;padding:40px;border-radius:16px;background:#fff;border:1px solid #e8e9eb;box-shadow:0 4px 24px rgba(0,0,0,.06)}
    .box h2{margin:0 0 8px;color:#1f2329;font-size:18px}.box p{color:#8f959e;margin:0 0 20px;font-size:14px}
    a{display:inline-block;padding:8px 20px;border-radius:8px;background:#7c5cfc;color:#fff;text-decoration:none;font-weight:600;font-size:14px}</style></head>
    <body><div class="box"><h2>权限不足</h2><p>该操作需要管理员权限，请联系管理员。</p><a href="/">返回首页</a></div></body></html>`
  );
}
