import { renderPage, escapeHtml } from "../ui.mjs";

export function registerErrorHandler(app) {
  app.use((err, req, res, _next) => {
    console.error("[ERROR]", req.method, req.url, err?.message || err);
    if (res.headersSent) return;
    res.status(500).send(
      renderPage({
        title: "服务器错误",
        user: req.user || null,
        active: "",
        contentHtml: '<div class="card" style="max-width:600px;margin:40px auto;text-align:center">' +
          '<h2 style="color:var(--red)">服务器内部错误</h2>' +
          '<p class="muted">' + escapeHtml(String(err?.message || "未知错误")) + '</p>' +
          '<a class="btn primary" href="/candidates">返回首页</a></div>',
      })
    );
  });
}
