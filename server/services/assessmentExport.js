/**
 * Export assessments to Moodle XML and SCORM 1.2 (with answer keys included).
 */

const archiver = require('archiver');

function escapeXml(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Safe for use inside CDATA: only split ]]> so the CDATA block stays valid. */
function cdataSafe(text) {
  if (text == null) return '';
  return String(text).replace(/\]\]>/g, ']]]]><![CDATA[>');
}

function getCorrectIndex(q) {
  const ca = q.correct_answer;
  if (ca == null) return 0;
  const s = String(ca).toUpperCase().trim();
  if (/^[A-Z]$/.test(s)) return s.charCodeAt(0) - 65;
  const n = parseInt(s, 10);
  if (!Number.isNaN(n) && n >= 1) return n - 1;
  return 0;
}

/**
 * Build Moodle question bank XML (includes correct answers for MCQ, short answer, matching).
 * @param {object} assessment - { title, instructions, questions: [{ number, type, question, points, options?, correct_answer?, left_column?, right_column?, correct_pairings? }] }
 * @returns {string} XML string
 */
function buildMoodleXml(assessment) {
  const questions = assessment.questions || [];
  const title = assessment.title || 'Exported Assessment';
  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<quiz>',
    `  <question type="category"><category><text>$$course$/top/${escapeXml(title)}</text></category></question>`
  ];

  for (const q of questions) {
    const type = (q.type || 'essay').replace(/-/g, '_');
    const qNum = q.number != null ? q.number : parts.length;
    const name = `Q${qNum}`;
    const questionText = (q.question || '').trim() || 'Question';

    if (type === 'multiple_choice' || type === 'mcq') {
      const options = Array.isArray(q.options) ? q.options : [];
      const correctIndex = getCorrectIndex(q);
      parts.push('  <question type="multichoice">');
      parts.push(`    <name><text>${escapeXml(name)}</text></name>`);
      parts.push('    <questiontext format="html">');
      parts.push(`      <text><![CDATA[<p>${cdataSafe(questionText)}</p>]]></text>`);
      parts.push('    </questiontext>');
      parts.push('    <single>true</single>');
      parts.push('    <shuffleanswers>1</shuffleanswers>');
      parts.push('    <answernumbering>abc</answernumbering>');
      options.forEach((opt, i) => {
        const fraction = i === correctIndex ? '100' : '0';
        const text = String(opt).trim() || `Option ${i + 1}`;
        parts.push(`    <answer fraction="${fraction}">`);
        parts.push(`      <text><![CDATA[${cdataSafe(text)}]]></text>`);
        parts.push('    </answer>');
      });
      parts.push('  </question>');
      continue;
    }

    if (type === 'short_answer') {
      const correct = q.correct_answer != null ? String(q.correct_answer).trim() : '';
      parts.push('  <question type="shortanswer">');
      parts.push(`    <name><text>${escapeXml(name)}</text></name>`);
      parts.push('    <questiontext format="html">');
      parts.push(`      <text><![CDATA[<p>${cdataSafe(questionText)}</p>]]></text>`);
      parts.push('    </questiontext>');
      parts.push('    <answer fraction="100">');
      parts.push(`      <text><![CDATA[${cdataSafe(correct)}]]></text>`);
      parts.push('    </answer>');
      parts.push('  </question>');
      continue;
    }

    if (type === 'mix_and_match' && Array.isArray(q.left_column) && Array.isArray(q.right_column)) {
      const left = q.left_column;
      const right = q.right_column;
      const pairings = Array.isArray(q.correct_pairings) ? q.correct_pairings : [];
      const pairingMap = new Map();
      pairings.forEach((p) => {
        let li = typeof p === 'object' && p != null && (p.left_index != null || p.left != null)
          ? (p.left_index ?? p.left)
          : p;
        let ri = typeof p === 'object' && p != null && (p.right_index != null || p.right != null)
          ? (p.right_index ?? p.right)
          : p;
        li = Number(li);
        ri = Number(ri);
        if (!Number.isNaN(li) && !Number.isNaN(ri)) {
          const leftIdx = li >= 1 ? li - 1 : li;
          const rightIdx = ri >= 1 ? ri - 1 : ri;
          pairingMap.set(leftIdx, rightIdx);
        }
      });
      parts.push('  <question type="match">');
      parts.push(`    <name><text>${escapeXml(name)}</text></name>`);
      parts.push('    <questiontext format="html">');
      parts.push(`      <text><![CDATA[<p>${cdataSafe(questionText)}</p>]]></text>`);
      parts.push('    </questiontext>');
      left.forEach((leftItem, i) => {
        const rightIdx = pairingMap.has(i) ? pairingMap.get(i) : 0;
        const rightItem = right[rightIdx] != null ? right[rightIdx] : '';
        parts.push('    <subquestion>');
        parts.push(`      <text><![CDATA[${cdataSafe(String(leftItem))}]]></text>`);
        parts.push('      <answer>');
        parts.push(`        <text><![CDATA[${cdataSafe(String(rightItem))}]]></text>`);
        parts.push('      </answer>');
        parts.push('    </subquestion>');
      });
      parts.push('  </question>');
      continue;
    }

    if (type === 'essay' || type === 'problem') {
      parts.push('  <question type="essay">');
      parts.push(`    <name><text>${escapeXml(name)}</text></name>`);
      parts.push('    <questiontext format="html">');
      parts.push(`      <text><![CDATA[<p>${cdataSafe(questionText)}</p>]]></text>`);
      parts.push('    </questiontext>');
      parts.push('    <responseformat>editor</responseformat>');
      parts.push('    <responserequired>1</responserequired>');
      parts.push('  </question>');
      continue;
    }

    // fallback: essay
    parts.push('  <question type="essay">');
    parts.push(`    <name><text>${escapeXml(name)}</text></name>`);
    parts.push('    <questiontext format="html">');
    parts.push(`      <text><![CDATA[<p>${cdataSafe(questionText)}</p>]]></text>`);
    parts.push('    </questiontext>');
    parts.push('  </question>');
  }

  parts.push('</quiz>');
  return parts.join('\n');
}

/**
 * Build SCORM 1.2 package as a buffer (ZIP). Includes index.html (quiz for learners), answers.html (answer key), imsmanifest.xml.
 * @param {object} assessment - same as buildMoodleXml
 * @returns {Promise<Buffer>}
 */
function buildScormPackage(assessment) {
  return new Promise((resolve, reject) => {
    const questions = assessment.questions || [];
    const title = assessment.title || 'Assessment';
    const instructions = assessment.instructions || '';

    const manifestId = 'markmate_scorm_' + Date.now();
    const orgId = 'org1';
    const resId = 'resource1';
    const resAnswersId = 'resource_answers';

    const imsmanifest = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="${escapeXml(manifestId)}" version="1.2"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd http://www.imsglobal.org/xsd/imsmd_rootv1p2p1 imsmd_rootv1p2p1.xsd http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="${orgId}">
    <organization identifier="${orgId}">
      <title>${escapeXml(title)}</title>
      <item identifier="item1" identifierref="${resId}">
        <title>${escapeXml(title)}</title>
      </item>
      <item identifier="item_answers" identifierref="${resAnswersId}">
        <title>Answer key (instructor)</title>
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="${resId}" type="webcontent" adlcp:scormType="sco" href="index.html">
      <file href="index.html"/>
    </resource>
    <resource identifier="${resAnswersId}" type="webcontent" adlcp:scormType="asset" href="answers.html">
      <file href="answers.html"/>
    </resource>
  </resources>
</manifest>
`;

    let indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>${escapeXml(title)}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; }
    h1 { color: #333; }
    .instructions { background: #f5f5f5; padding: 1rem; border-radius: 8px; margin-bottom: 1.5rem; }
    .q { margin-bottom: 1.5rem; padding: 1rem; border: 1px solid #e0e0e0; border-radius: 8px; }
    .q-num { font-weight: bold; color: #555; }
    .opt { margin: 0.4rem 0 0 1rem; }
    .match-cols { display: flex; gap: 2rem; margin-top: 0.5rem; }
  </style>
</head>
<body>
  <h1>${escapeXml(title)}</h1>
  <div class="instructions">${escapeXml(instructions).replace(/\n/g, '<br/>')}</div>
  <form id="quiz">
`;

    questions.forEach((q) => {
      const qNum = q.number != null ? q.number : 0;
      const type = (q.type || 'short_answer').replace(/-/g, '_');
      const t = type === 'mcq' ? 'multiple_choice' : type;
      indexHtml += `    <div class="q"><span class="q-num">Question ${qNum}</span> (${(q.points || 0)} pts)<br/>`;
      indexHtml += `<p>${escapeXml(q.question || '').replace(/\n/g, '<br/>')}</p>`;
      if ((t === 'multiple_choice') && Array.isArray(q.options) && q.options.length > 0) {
        q.options.forEach((opt, i) => {
          const letter = String.fromCharCode(65 + i);
          indexHtml += `<div class="opt"><input type="radio" name="q${qNum}" value="${letter}" id="q${qNum}_${i}"/><label for="q${qNum}_${i}">${escapeXml(opt)}</label></div>`;
        });
      } else if (t === 'mix_and_match' && q.left_column && q.right_column) {
        indexHtml += '<div class="match-cols"><div><strong>Column A</strong><ol>';
        (q.left_column || []).forEach((item) => { indexHtml += `<li>${escapeXml(item)}</li>`; });
        indexHtml += '</ol></div><div><strong>Column B</strong><ol>';
        (q.right_column || []).forEach((item) => { indexHtml += `<li>${escapeXml(item)}</li>`; });
        indexHtml += '</ol></div></div><p>Match each item in A to the correct item in B.</p>';
      } else {
        indexHtml += `<textarea name="q${qNum}" rows="4" style="width:100%;"></textarea>`;
      }
      indexHtml += '</div>';
    });

    indexHtml += `
  </form>
</body>
</html>
`;

    let answersHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>Answer key - ${escapeXml(title)}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; }
    h1 { color: #333; }
    .q { margin-bottom: 1rem; }
    .correct { background: #e8f5e9; padding: 0.2rem 0.5rem; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Answer key – ${escapeXml(title)}</h1>
  <p><strong>For instructor use only. This resource contains correct answers.</strong></p>
  <ol>
`;

    questions.forEach((q) => {
      answersHtml += `    <li class="q"><strong>Q${q.number != null ? q.number : ''}</strong> `;
      if (q.correct_answer !== undefined && q.correct_answer !== null) {
        answersHtml += `<span class="correct">${escapeXml(String(q.correct_answer))}</span>`;
        if (Array.isArray(q.options)) {
          const idx = getCorrectIndex(q);
          const opt = q.options[idx];
          if (opt) answersHtml += ` — ${escapeXml(opt)}`;
        }
      } else if (q.correct_pairings && Array.isArray(q.correct_pairings) && q.left_column && q.right_column) {
        const left = q.left_column;
        const right = q.right_column;
        const pairings = q.correct_pairings.map((p) => {
          const li = typeof p === 'object' && p != null ? (p.left_index ?? p.left) : p;
          const ri = typeof p === 'object' && p != null ? (p.right_index ?? p.right) : p;
          const l = left[li];
          const r = right[ri];
          return l != null && r != null ? `${escapeXml(l)} → ${escapeXml(r)}` : '';
        }).filter(Boolean);
        answersHtml += `<span class="correct">${pairings.join('; ')}</span>`;
      } else {
        answersHtml += '<em>Open-ended (essay/short answer – no single key)</em>';
      }
      answersHtml += '</li>';
    });

    answersHtml += `
  </ol>
</body>
</html>
`;

    const buffers = [];
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('data', (chunk) => buffers.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(buffers)));
    archive.on('error', reject);

    archive.append(imsmanifest, { name: 'imsmanifest.xml' });
    archive.append(indexHtml, { name: 'index.html' });
    archive.append(answersHtml, { name: 'answers.html' });
    archive.finalize();
  });
}

module.exports = {
  buildMoodleXml,
  buildScormPackage,
};
