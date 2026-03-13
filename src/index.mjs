import "dotenv/config";

// 设置系统时区为北京时间
process.env.TZ = "Asia/Shanghai";

import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { renderPage } from "./ui.mjs";
import { loadData } from "./db.mjs";
import { sessionMiddleware, registerAuthRoutes, requireLogin } from "./auth.mjs";

// ====== 路由 ======
import dashboardRouter from "./routes/dashboard.mjs";
import jobsRouter from "./routes/jobs.mjs";
import candidatesRouter from "./routes/candidates.mjs";
import candidateApiRouter from "./routes/candidateApi.mjs";
import offersRouter from "./routes/offers.mjs";
import settingsRouter from "./routes/settings.mjs";
import scheduleRouter from "./routes/schedule.mjs";
import reviewRouter from "./routes/review.mjs";
import resumeApiRouter from "./routes/resumeApi.mjs";
import openApiRouter from "./routes/openApi.mjs";
import headhuntersRouter from "./routes/headhunters.mjs";
import portalRouter from "./routes/portal.mjs";
import referralRouter from "./routes/referral.mjs";
import { registerErrorHandler } from "./routes/errorHandler.mjs";

// ====== 定时任务 ======
import { checkReviewReminders } from "./tasks/reviewReminders.mjs";
import careersSyncRouter, { syncCareersApplications } from "./tasks/careersSync.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set("trust proxy", 1);
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "10mb" }));

// ====== Session 中间件 ======
app.use(sessionMiddleware());

// ====== uploads（回退用，serverless 环境下跳过）=====
const isServerless = !!process.env.VERCEL;
const UPLOADS_DIR = path.join(process.cwd(), "uploads");
if (!isServerless) {
  try {
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  } catch {}
  app.use("/uploads", express.static(UPLOADS_DIR));
}

// ====== 注册登录/登出路由（来自 auth.mjs）======
registerAuthRoutes(app, renderPage);

// ====== 临时调试接口 ======
app.get("/debug/session", requireLogin, async (req, res) => {
  const d = await loadData();
  const sessionUser = req.session.user;
  const matchedUser = d.users.find(u => u.openId && u.openId === sessionUser.openId)
    || d.users.find(u => u.name === sessionUser.name);
  res.json({
    session: sessionUser,
    matchedUser: matchedUser || null,
    allUsers: d.users.map(u => ({ id: u.id, name: u.name, openId: u.openId, role: u.role, provider: u.provider })),
  });
});

// ====== 挂载路由（顺序与原文件一致）======
app.use(dashboardRouter);
app.use(jobsRouter);
app.use(candidatesRouter);
app.use(candidateApiRouter);
app.use(offersRouter);
app.use(settingsRouter);
app.use(scheduleRouter);
app.use(reviewRouter);
app.use(resumeApiRouter);
app.use(openApiRouter);
app.use(headhuntersRouter);
app.use(portalRouter);
app.use(referralRouter);
app.use(careersSyncRouter);

// ====== 全局错误处理 ======
registerErrorHandler(app);

// ====== 启动（本地开发时 listen，Vercel 上由 api/index.mjs 导出）======
if (!isServerless) {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, "0.0.0.0", () => {
    console.log("[OK] Web: http://localhost:" + port);
    console.log("[OK] 人才库: http://localhost:" + port + "/candidates");
    console.log("[OK] 看板: http://localhost:" + port + "/candidates/board");
    console.log("[OK] Offer管理: http://localhost:" + port + "/offers");

    // 启动面评提醒定时检查（每30分钟检查一次）
    setInterval(checkReviewReminders, 30 * 60 * 1000);
    // 启动后延迟1分钟执行首次检查
    setTimeout(checkReviewReminders, 60 * 1000);
    console.log("[OK] 面评提醒: 每30分钟检查一次（首次检查1分钟后）");

    // 官网投递自动同步（每15分钟一次）
    setInterval(syncCareersApplications, 15 * 60 * 1000);
    setTimeout(syncCareersApplications, 2 * 60 * 1000);
    console.log("[OK] 官网投递同步: 每15分钟自动同步（首次2分钟后）");
  });
}

export default app;
