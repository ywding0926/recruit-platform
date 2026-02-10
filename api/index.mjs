let app;
let importError = null;

try {
  const mod = await import("../src/index.mjs");
  app = mod.default;
} catch (e) {
  importError = e;
  console.error("[FATAL] Failed to import src/index.mjs:", e.message, e.stack);
}

export default function handler(req, res) {
  if (importError) {
    res.status(500).json({
      error: "Module import failed",
      message: String(importError.message || importError),
      stack: String(importError.stack || "").split("\n").slice(0, 8),
    });
    return;
  }
  if (!app) {
    res.status(500).json({ error: "App not initialized" });
    return;
  }
  return app(req, res);
}