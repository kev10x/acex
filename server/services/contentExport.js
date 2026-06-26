/**
 * Content SCORM export (1.2): lesson pages + knowledge checkpoint + basic SCORM runtime reporting.
 */

const archiver = require('archiver');

function escapeHtml(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildContentScormPackage(content) {
  return new Promise((resolve, reject) => {
    const title = String(content?.title || 'Course Content');
    const instructions = String(content?.instructions || '');
    const sections = Array.isArray(content?.sections) ? content.sections : [];
    const quizQuestions = Array.isArray(content?.quiz?.questions) ? content.quiz.questions : [];
    const theme = content?.theme || {};

    const manifestId = `acexen_content_scorm_${Date.now()}`;
    const imsmanifest = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="${escapeHtml(manifestId)}" version="1.2"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd http://www.imsglobal.org/xsd/imsmd_rootv1p2p1 imsmd_rootv1p2p1.xsd http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="org1">
    <organization identifier="org1">
      <title>${escapeHtml(title)}</title>
      <item identifier="item1" identifierref="resource1"><title>${escapeHtml(title)}</title></item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="resource1" type="webcontent" adlcp:scormType="sco" href="index.html">
      <file href="index.html"/>
    </resource>
  </resources>
</manifest>`;

    const sectionsHtml = sections.map((sec, idx) => {
      const heading = escapeHtml(sec?.heading || sec?.title || `Section ${idx + 1}`);
      const support = sec?.support ? `<p><strong>${escapeHtml(sec.support)}</strong></p>` : '';
      const body = escapeHtml(sec?.body || '').replace(/\n/g, '<br/>');
      const visuals = Array.isArray(sec?.visuals) ? sec.visuals : [];
      const visualsHtml = visuals.length
        ? `<div class="vis-grid">${visuals.map((v) => `<figure class="vis">${v?.image_url ? `<img src="${escapeHtml(v.image_url)}" alt="${escapeHtml(v.alt_text || v.title || 'Visual')}"/>` : ''}<figcaption>${escapeHtml(v?.title || '')}</figcaption></figure>`).join('')}</div>`
        : '';
      return `<section class="card"><h2>${heading}</h2>${support}<p>${body}</p>${visualsHtml}</section>`;
    }).join('');

    const checkpointHtml = quizQuestions.map((q, qi) => {
      const num = q?.number || qi + 1;
      const opts = Array.isArray(q?.options) ? q.options : [];
      const optionsHtml = opts.map((opt, oi) => {
        const letter = String.fromCharCode(65 + oi);
        return `<label style="display:block;margin-top:6px;"><input type="radio" name="q_${num}" value="${letter}"/> ${escapeHtml(opt)}</label>`;
      }).join('');
      return `<div class="q" data-qnum="${num}" data-answer="${escapeHtml(String(q?.correct_answer || '').toUpperCase())}"><div><strong>${num}. ${escapeHtml(q?.question || '')}</strong></div>${optionsHtml}</div>`;
    }).join('');

    const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --bg: ${escapeHtml(theme.bg_color || '#F8FAFC')};
      --surface: ${escapeHtml(theme.surface_color || '#FFFFFF')};
      --heading: ${escapeHtml(theme.heading_color || '#0F766E')};
      --text: ${escapeHtml(theme.text_color || '#0F172A')};
      --accent: ${escapeHtml(theme.accent_color || '#14B8A6')};
      --font: ${escapeHtml(theme.font_family || "'Segoe UI', sans-serif")};
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: var(--font); background: var(--bg); color: var(--text); }
    .container { max-width: 980px; margin: 0 auto; padding: 24px 16px 64px; }
    .hero { background: linear-gradient(135deg, var(--accent), var(--heading)); color: white; border-radius: 16px; padding: 20px; }
    .card { background: var(--surface); border: 1px solid #E5E7EB; border-radius: 14px; padding: 16px; margin-top: 14px; box-shadow: 0 6px 16px rgba(15,23,42,.06); }
    h1, h2, h3 { margin: 0 0 8px; color: var(--heading); }
    .hero h1 { color: #fff; }
    .vis-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }
    .vis img { width: 100%; height: 160px; object-fit: cover; border-radius: 10px; display: block; }
    .progress { margin-top: 12px; font-size: 14px; }
    .q { margin-bottom: 14px; padding: 12px; border: 1px solid #E5E7EB; border-radius: 10px; }
    .btn { background: var(--accent); color: #fff; border: none; padding: 10px 14px; border-radius: 8px; cursor: pointer; }
    @media (max-width: 760px) { .vis-grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="container">
    <div class="hero">
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(instructions).replace(/\n/g, '<br/>')}</p>
      <div class="progress">Progress: <span id="progressPct">0</span>%</div>
    </div>

    ${sectionsHtml}

    <div class="card" id="checkpointCard">
      <h2>Knowledge Checkpoint</h2>
      <div id="checkpoint">${checkpointHtml || '<p>No checkpoint questions configured.</p>'}</div>
      <button id="submitCheckpoint" class="btn" type="button">Submit Checkpoint</button>
      <p id="checkpointResult"></p>
    </div>
  </div>

  <script>
    (function(){
      var sectionCount = ${sections.length};
      var questionCount = ${quizQuestions.length};
      var apiHandle = null;

      function scormFindApi(win) {
        var tries = 0;
        while (win && !win.API && tries < 8) { tries += 1; win = win.parent; }
        return win ? win.API : null;
      }
      function scormInit() {
        apiHandle = scormFindApi(window);
        if (apiHandle && apiHandle.LMSInitialize) { try { apiHandle.LMSInitialize(''); } catch (_) {} }
      }
      function scormSet(name, val) {
        if (!apiHandle || !apiHandle.LMSSetValue) return;
        try { apiHandle.LMSSetValue(name, String(val)); } catch (_) {}
      }
      function scormCommit() {
        if (!apiHandle || !apiHandle.LMSCommit) return;
        try { apiHandle.LMSCommit(''); } catch (_) {}
      }
      function scormFinish() {
        if (!apiHandle || !apiHandle.LMSFinish) return;
        try { apiHandle.LMSFinish(''); } catch (_) {}
      }

      function updateProgress(score, completed) {
        var pct = completed ? 100 : (sectionCount > 0 ? Math.round((sectionCount / (sectionCount + 1)) * 100) : 0);
        document.getElementById('progressPct').textContent = String(pct);
        scormSet('cmi.core.lesson_location', 'section-' + Math.max(0, sectionCount - 1));
        scormSet('cmi.core.score.raw', Number(score || 0));
        scormSet('cmi.core.score.max', 100);
        scormSet('cmi.core.score.min', 0);
        scormSet('cmi.core.lesson_status', completed ? 'completed' : 'incomplete');
        scormCommit();
      }

      function gradeCheckpoint() {
        if (!questionCount) {
          updateProgress(100, true);
          document.getElementById('checkpointResult').textContent = 'No checkpoint questions configured.';
          return;
        }
        var boxes = document.querySelectorAll('.q[data-qnum]');
        var correct = 0;
        boxes.forEach(function(box){
          var qnum = box.getAttribute('data-qnum');
          var expected = (box.getAttribute('data-answer') || '').toUpperCase();
          var selected = document.querySelector('input[name="q_' + qnum + '"]:checked');
          var got = selected ? String(selected.value || '').toUpperCase() : '';
          if (expected && expected === got) correct += 1;
        });
        var score = Math.round((correct / questionCount) * 100);
        updateProgress(score, true);
        document.getElementById('checkpointResult').textContent = 'Checkpoint score: ' + score + '% (' + correct + '/' + questionCount + ')';
      }

      var btn = document.getElementById('submitCheckpoint');
      if (btn) btn.addEventListener('click', gradeCheckpoint);
      window.addEventListener('beforeunload', function(){ scormFinish(); });

      scormInit();
      updateProgress(0, false);
    })();
  </script>
</body>
</html>`;

    const buffers = [];
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('data', (chunk) => buffers.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(buffers)));
    archive.on('error', reject);

    archive.append(imsmanifest, { name: 'imsmanifest.xml' });
    archive.append(indexHtml, { name: 'index.html' });
    archive.finalize();
  });
}

module.exports = {
  buildContentScormPackage,
};
