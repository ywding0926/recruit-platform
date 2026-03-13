const fs = require('fs');
const path = require('path');
const { marked } = require('marked');

// Configure marked for clean rendering
marked.setOptions({
  gfm: true,
  breaks: false,
});

const docsDir = __dirname;

// Read the two markdown files
const hrMd = fs.readFileSync(path.join(docsDir, 'HR管理员使用手册.md'), 'utf-8');
const interviewerMd = fs.readFileSync(path.join(docsDir, '面试官成员使用手册.md'), 'utf-8');

// Convert markdown to HTML
const hrHtml = marked.parse(hrMd);
const interviewerHtml = marked.parse(interviewerMd);

const finalHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MachinePulse 招聘管理系统 — 使用手册</title>
<style>
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  html { font-size: 16px; scroll-behavior: smooth; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    background: #f5f3ff;
    color: #1e1b4b;
    line-height: 1.7;
    min-height: 100vh;
  }
  .site-header {
    background: linear-gradient(135deg, #7c3aed 0%, #6d28d9 50%, #5b21b6 100%);
    color: #fff;
    padding: 2.5rem 1rem 1.5rem;
    text-align: center;
    box-shadow: 0 4px 24px rgba(124, 58, 237, 0.25);
    position: relative;
    overflow: hidden;
  }
  .site-header::before {
    content: '';
    position: absolute;
    top: -50%; left: -10%; width: 120%; height: 200%;
    background: radial-gradient(circle at 30% 40%, rgba(255,255,255,0.08) 0%, transparent 60%);
    pointer-events: none;
  }
  .site-header h1 { font-size: 1.75rem; font-weight: 700; letter-spacing: 0.02em; position: relative; }
  .site-header p  { margin-top: 0.4rem; font-size: 0.95rem; opacity: 0.85; position: relative; }

  .tab-bar {
    display: flex; justify-content: center; gap: 0;
    background: #ede9fe; border-bottom: 2px solid #ddd6fe;
    position: sticky; top: 0; z-index: 100;
  }
  .tab-btn {
    flex: 0 1 280px; padding: 0.9rem 1.5rem; font-size: 0.95rem; font-weight: 600;
    cursor: pointer; border: none; background: transparent; color: #6d28d9;
    transition: all 0.2s ease; position: relative; letter-spacing: 0.01em;
  }
  .tab-btn:hover { background: #ddd6fe; }
  .tab-btn.active { color: #fff; background: #7c3aed; }
  .tab-btn.active::after {
    content: ''; position: absolute; bottom: -2px; left: 0; right: 0;
    height: 3px; background: #7c3aed;
  }

  .content-wrapper { max-width: 900px; margin: 2rem auto; padding: 0 1.25rem 4rem; }
  .tab-panel {
    display: none; background: #fff; border-radius: 12px;
    box-shadow: 0 1px 4px rgba(124,58,237,0.06), 0 8px 32px rgba(124,58,237,0.07);
    padding: 2.5rem 2.5rem 3rem; animation: fadeIn 0.3s ease;
  }
  .tab-panel.active { display: block; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }

  .md-body h1 {
    font-size: 1.75rem; font-weight: 700; color: #5b21b6;
    margin: 2rem 0 1rem; padding-bottom: 0.5rem; border-bottom: 2px solid #ede9fe;
  }
  .md-body h1:first-child { margin-top: 0; }
  .md-body h2 {
    font-size: 1.4rem; font-weight: 700; color: #6d28d9;
    margin: 2rem 0 0.75rem; padding-bottom: 0.35rem; border-bottom: 1px solid #ede9fe;
  }
  .md-body h3 { font-size: 1.15rem; font-weight: 600; color: #7c3aed; margin: 1.5rem 0 0.5rem; }
  .md-body h4 { font-size: 1.05rem; font-weight: 600; color: #1e1b4b; margin: 1.2rem 0 0.4rem; }
  .md-body p  { margin: 0.6rem 0; }
  .md-body a  { color: #7c3aed; text-decoration: underline; text-underline-offset: 2px; }
  .md-body a:hover { color: #5b21b6; }
  .md-body strong { font-weight: 600; color: #1e1b4b; }

  .md-body ul, .md-body ol { margin: 0.5rem 0 0.5rem 1.5rem; }
  .md-body li { margin: 0.25rem 0; }
  .md-body li > ul, .md-body li > ol { margin: 0.15rem 0 0.15rem 1.2rem; }

  .md-body blockquote {
    margin: 1rem 0; padding: 0.75rem 1.25rem;
    border-left: 4px solid #7c3aed; background: #f5f3ff;
    border-radius: 0 8px 8px 0; color: #4c1d95;
  }
  .md-body blockquote p { margin: 0.3rem 0; }

  .md-body table { width: 100%; border-collapse: collapse; margin: 1rem 0; font-size: 0.92rem; }
  .md-body th, .md-body td { padding: 0.6rem 0.9rem; border: 1px solid #ddd6fe; text-align: left; vertical-align: top; }
  .md-body th { background: #7c3aed; color: #fff; font-weight: 600; white-space: nowrap; }
  .md-body tr:nth-child(even) td { background: #faf5ff; }
  .md-body tr:hover td { background: #ede9fe; }

  .md-body code {
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    font-size: 0.88em; background: #ede9fe; color: #5b21b6; padding: 0.15em 0.4em; border-radius: 4px;
  }
  .md-body pre {
    margin: 1rem 0; background: #1e1b4b; color: #e9d5ff;
    padding: 1.2rem 1.4rem; border-radius: 8px; overflow-x: auto; line-height: 1.5;
  }
  .md-body pre code { background: none; color: inherit; padding: 0; font-size: 0.88rem; }

  .md-body hr { border: none; border-top: 2px solid #ede9fe; margin: 2rem 0; }
  .md-body img { max-width: 100%; height: auto; border-radius: 8px; margin: 1rem 0; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }

  @media (max-width: 640px) {
    .site-header h1 { font-size: 1.3rem; }
    .tab-btn { font-size: 0.82rem; padding: 0.7rem 0.8rem; flex: 1; }
    .tab-panel { padding: 1.5rem 1rem 2rem; }
    .content-wrapper { padding: 0 0.5rem 3rem; margin-top: 1rem; }
    .md-body h1 { font-size: 1.4rem; }
    .md-body h2 { font-size: 1.2rem; }
    .md-body table { font-size: 0.82rem; }
    .md-body th, .md-body td { padding: 0.4rem 0.6rem; }
  }

  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track { background: #f5f3ff; }
  ::-webkit-scrollbar-thumb { background: #c4b5fd; border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: #7c3aed; }

  @media print {
    .site-header { background: #7c3aed !important; -webkit-print-color-adjust: exact; }
    .tab-bar { display: none; }
    .tab-panel { display: block !important; box-shadow: none; break-inside: avoid; }
    .tab-panel + .tab-panel { margin-top: 2rem; }
  }
</style>
</head>
<body>
<header class="site-header">
  <h1>MachinePulse 招聘管理系统 &mdash; 使用手册</h1>
  <p>Recruitment Management Platform &middot; User Guide</p>
</header>
<nav class="tab-bar">
  <button class="tab-btn active" data-tab="hr" onclick="switchTab('hr')">HR / 管理员使用手册</button>
  <button class="tab-btn" data-tab="interviewer" onclick="switchTab('interviewer')">面试官 / 成员使用手册</button>
</nav>
<main class="content-wrapper">
  <div id="panel-hr" class="tab-panel active">
    <div class="md-body">
${hrHtml}
    </div>
  </div>
  <div id="panel-interviewer" class="tab-panel">
    <div class="md-body">
${interviewerHtml}
    </div>
  </div>
</main>
<script>
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(function(btn) {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tab);
  });
  document.querySelectorAll('.tab-panel').forEach(function(panel) {
    panel.classList.toggle('active', panel.id === 'panel-' + tab);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
</script>
</body>
</html>`;

fs.writeFileSync(path.join(docsDir, 'index.html'), finalHtml, 'utf-8');
console.log('index.html generated successfully (' + finalHtml.length + ' bytes)');
