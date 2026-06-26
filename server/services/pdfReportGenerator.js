const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

class PDFReportGenerator {
  constructor() {
    this.reportsDir = path.join(__dirname, '../../reports');
    this.ensureReportsDirectory();
  }

  ensureReportsDirectory() {
    if (!fs.existsSync(this.reportsDir)) {
      fs.mkdirSync(this.reportsDir, { recursive: true });
    }
  }

  ensureBatchDirectory(batchId) {
    if (!batchId) {
      // If no batch, use a default "unassigned" folder
      const unassignedDir = path.join(this.reportsDir, 'unassigned');
      if (!fs.existsSync(unassignedDir)) {
        fs.mkdirSync(unassignedDir, { recursive: true });
      }
      return unassignedDir;
    }
    
    const batchDir = path.join(this.reportsDir, `batch-${batchId}`);
    if (!fs.existsSync(batchDir)) {
      fs.mkdirSync(batchDir, { recursive: true });
    }
    return batchDir;
  }

  generateAssignmentReport(markingResult, assignment, rubric) {
    if ((rubric.rubric_type || '') === 'mark_sheet') {
      return this.generateMarkSheetReport(markingResult, assignment, rubric);
    }
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ margin: 50 });
        const fileName = `assignment_report_${markingResult.id}_${Date.now()}.pdf`;
        
        // Organize reports by batch folder
        const batchId = assignment.batch_id || null;
        const batchDir = this.ensureBatchDirectory(batchId);
        const filePath = path.join(batchDir, fileName);
        
        // Pipe the PDF to a file
        const stream = fs.createWriteStream(filePath);
        doc.pipe(stream);

        // Header
        this.addHeader(doc, assignment, rubric, markingResult);
        
        // Student Information
        this.addStudentInfo(doc, markingResult);
        
        // Score Summary
        this.addScoreSummary(doc, markingResult, rubric);
        
        // Detailed Criteria Scores
        this.addDetailedScores(doc, markingResult, rubric);
        
        // Overall Feedback
        this.addOverallFeedback(doc, markingResult);
        
        // Language Errors
        this.addLanguageErrors(doc, markingResult);

        // Finalize the PDF
        doc.end();

        stream.on('finish', () => {
          resolve({
            fileName,
            filePath,
            size: fs.statSync(filePath).size
          });
        });

        stream.on('error', (error) => {
          reject(error);
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  addHeader(doc, assignment, rubric, markingResult) {
    // Title
    doc.fontSize(20)
       .font('Helvetica-Bold')
       .text('Assignment Marking Report', { align: 'center' });
    
    doc.moveDown(0.5);
    
    // Assignment details
    doc.fontSize(14)
       .font('Helvetica-Bold')
       .text('Assignment Details:', { underline: true });
    
    doc.fontSize(12)
       .font('Helvetica')
       .text(`Assignment: ${assignment.filename}`, { indent: 20 })
       .text(`Rubric: ${rubric.name}`, { indent: 20 })
       .text(`Total Points: ${rubric.total_points}`, { indent: 20 })
       .text(`Marked Date: ${new Date(markingResult.marked_at).toLocaleDateString()}`, { indent: 20 });
    
    doc.moveDown(1);
  }

  addStudentInfo(doc, markingResult) {
    doc.fontSize(14)
       .font('Helvetica-Bold')
       .text('Student Information:', { underline: true });
    
    doc.fontSize(12)
       .font('Helvetica')
       .text(`Student Name: ${markingResult.student_name || 'Not specified'}`, { indent: 20 });
    
    doc.moveDown(1);
  }

  addScoreSummary(doc, markingResult, rubric) {
    const percentage = ((markingResult.total_score / rubric.total_points) * 100).toFixed(1);
    
    doc.fontSize(14)
       .font('Helvetica-Bold')
       .text('Score Summary:', { underline: true });
    
    doc.fontSize(12)
       .font('Helvetica')
       .text(`Total Score: ${markingResult.total_score} / ${rubric.total_points}`, { indent: 20 })
       .text(`Percentage: ${percentage}%`, { indent: 20 });
    
    // Grade based on percentage
    let grade = 'F';
    if (percentage >= 90) grade = 'A+';
    else if (percentage >= 85) grade = 'A';
    else if (percentage >= 80) grade = 'A-';
    else if (percentage >= 75) grade = 'B+';
    else if (percentage >= 70) grade = 'B';
    else if (percentage >= 65) grade = 'B-';
    else if (percentage >= 60) grade = 'C+';
    else if (percentage >= 55) grade = 'C';
    else if (percentage >= 50) grade = 'C-';
    else if (percentage >= 45) grade = 'D+';
    else if (percentage >= 40) grade = 'D';
    else if (percentage >= 35) grade = 'D-';
    
    doc.text(`Grade: ${grade}`, { indent: 20 });
    
    doc.moveDown(1);
  }

  addDetailedScores(doc, markingResult, rubric) {
    const isMemo = (rubric.rubric_type || '').toLowerCase() === 'answer_key';
    const sectionTitle = isMemo ? 'Scores by question' : 'Detailed criteria scores';
    doc.fontSize(14)
       .font('Helvetica-Bold')
       .text(sectionTitle + ':', { underline: true });
    
    doc.moveDown(0.5);
    
    // Parse scores if it's a string
    const scores = typeof markingResult.scores === 'string' 
      ? JSON.parse(markingResult.scores) 
      : markingResult.scores;
    
    (scores || []).forEach((score, index) => {
      // Question/criterion name
      doc.fontSize(12)
         .font('Helvetica-Bold')
         .text(`${index + 1}. ${score.criterion_name}`, { indent: 20 });
      
      // Points
      doc.fontSize(11)
         .font('Helvetica')
         .text(`   Score: ${score.points_awarded} / ${score.max_points} points`, { indent: 40 });
      
      // Feedback
      if (score.feedback && score.feedback.trim()) {
        doc.text(`   Feedback: ${score.feedback}`, { indent: 40 });
      }
      
      doc.moveDown(0.3);
    });
    
    doc.moveDown(1);
  }

  addOverallFeedback(doc, markingResult) {
    if (markingResult.feedback && markingResult.feedback.trim()) {
      doc.fontSize(14)
         .font('Helvetica-Bold')
         .text('Overall Feedback:', { underline: true });
      
      doc.fontSize(12)
         .font('Helvetica')
         .text(markingResult.feedback, { indent: 20, align: 'justify' });
      
      doc.moveDown(1);
    }
  }

  addLanguageErrors(doc, markingResult) {
    // Parse language_errors if it's a string
    let languageErrors = markingResult.language_errors;
    if (typeof languageErrors === 'string') {
      try {
        languageErrors = JSON.parse(languageErrors);
      } catch (e) {
        languageErrors = [];
      }
    }
    
    if (languageErrors && Array.isArray(languageErrors) && languageErrors.length > 0) {
      doc.fontSize(14)
         .font('Helvetica-Bold')
         .text(`Language Errors (${languageErrors.length})`, { underline: true });
      
      doc.moveDown(0.5);
      
      languageErrors.forEach((error, index) => {
        // Error type label with different colors
        const typeColors = {
          grammar: '#F59E0B',      // orange
          spelling: '#EF4444',      // red
          reference: '#8B5CF6',     // purple
          punctuation: '#EC4899',   // pink
          style: '#6366F1'          // indigo
        };
        
        const color = typeColors[error.error_type] || '#6B7280';
        
        doc.fontSize(11)
           .font('Helvetica-Bold')
           .fillColor(color)
           .text(`${index + 1}. ${error.error_type.toUpperCase()}`, { indent: 20 });
        
        doc.fontSize(10)
           .font('Helvetica')
           .fillColor('#000000')
           .text(`Location: ${error.location}`, { indent: 30 });
        
        doc.fontSize(10)
           .font('Helvetica')
           .fillColor('#DC2626') // red for error
           .text(`Error: "${error.error_text}"`, { indent: 30 });
        
        doc.fontSize(10)
           .font('Helvetica')
           .fillColor('#16A34A') // green for correction
           .text(`Correction: "${error.correction}"`, { indent: 30 });
        
        doc.fontSize(9)
           .font('Helvetica-Oblique')
           .fillColor('#6B7280') // gray for explanation
           .text(`${error.explanation}`, { indent: 30 });
        
        // Reset color
        doc.fillColor('#000000');
        doc.moveDown(0.5);
      });
      
      doc.moveDown(1);
    }
  }


  // Render a filled-in mark-sheet table that mirrors the rubric layout.
  // Used automatically when rubric.rubric_type === 'mark_sheet'.
  generateMarkSheetReport(markingResult, assignment, rubric) {
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ margin: 40, size: 'A4' });
        const fileName = `marksheet_${markingResult.id}_${Date.now()}.pdf`;
        const batchDir = this.ensureBatchDirectory(assignment.batch_id || null);
        const filePath = path.join(batchDir, fileName);

        const stream = fs.createWriteStream(filePath);
        doc.pipe(stream);

        // ── Layout constants ──────────────────────────────────────────────
        const L = 40;                         // left margin
        const pageW = doc.page.width - L * 2; // usable width (~515pt on A4)
        const COL = {
          num:      20,
          task:     195,
          max:      48,
          awarded:  62,
          feedback: pageW - 20 - 195 - 48 - 62  // ~190pt
        };
        const ROW_PAD = 5;   // vertical padding inside each cell
        const FONT_BODY = 9;
        const FONT_HEAD = 9;
        const HEADER_BG = '#1e3a5f';
        const ALT_BG    = '#f0f4f8';
        const BORDER    = '#9ca3af';

        // ── Header ────────────────────────────────────────────────────────
        doc.fontSize(14).font('Helvetica-Bold').fillColor('#000000')
           .text(rubric.name || 'Mark Sheet', L, L, { width: pageW, align: 'center' });
        doc.moveDown(0.4);

        doc.fontSize(10).font('Helvetica').fillColor('#333333');
        const studentName = markingResult.student_name || 'Not specified';
        const markedDate  = markingResult.marked_at
          ? new Date(markingResult.marked_at).toLocaleDateString('en-GB')
          : new Date().toLocaleDateString('en-GB');
        doc.text(`Student: ${studentName}    File: ${assignment.filename || '—'}    Date: ${markedDate}`,
                 L, doc.y, { width: pageW });
        doc.moveDown(0.6);

        // ── Helper: measure text height ───────────────────────────────────
        const textHeight = (text, width, fontSize, font) => {
          const saved = { font: doc._font, size: doc._fontSize };
          doc.font(font || 'Helvetica').fontSize(fontSize || FONT_BODY);
          const h = doc.heightOfString(String(text || ''), { width: width - ROW_PAD * 2 });
          doc.font(saved.font).fontSize(saved.size);
          return h;
        };

        // ── Helper: draw one table row ────────────────────────────────────
        const drawRow = (y, cells, isHeader) => {
          // cells: [{ text, width, bold? }]
          const rowH = cells.reduce((max, c) => {
            const h = textHeight(c.text, c.width,
              isHeader ? FONT_HEAD : FONT_BODY,
              isHeader || c.bold ? 'Helvetica-Bold' : 'Helvetica');
            return Math.max(max, h + ROW_PAD * 2);
          }, 18);

          // Background
          if (isHeader) {
            doc.rect(L, y, pageW, rowH).fill(HEADER_BG);
          } else if (cells._alt) {
            doc.rect(L, y, pageW, rowH).fill(ALT_BG);
          }

          // Cell text and borders
          let x = L;
          cells.forEach(c => {
            doc.rect(x, y, c.width, rowH).stroke(BORDER);
            const font  = isHeader || c.bold ? 'Helvetica-Bold' : 'Helvetica';
            const color = isHeader ? '#ffffff' : '#000000';
            doc.font(font).fontSize(isHeader ? FONT_HEAD : FONT_BODY)
               .fillColor(color)
               .text(String(c.text || ''), x + ROW_PAD, y + ROW_PAD,
                     { width: c.width - ROW_PAD * 2, lineBreak: true });
            x += c.width;
          });

          return rowH;
        };

        // ── Column widths as array entries ────────────────────────────────
        const colW = [COL.num, COL.task, COL.max, COL.awarded, COL.feedback];

        // ── Table header ──────────────────────────────────────────────────
        const headerCells = [
          { text: '#',              width: COL.num      },
          { text: 'Task',           width: COL.task     },
          { text: 'Max\nMarks',     width: COL.max      },
          { text: 'Marks\nAwarded', width: COL.awarded  },
          { text: 'Feedback',       width: COL.feedback }
        ];
        let curY = doc.y;
        curY += drawRow(curY, headerCells, true);

        // ── Build score lookup keyed by criterion_name ────────────────────
        const rawScores = typeof markingResult.scores === 'string'
          ? JSON.parse(markingResult.scores)
          : (markingResult.scores || []);
        const scoreMap = {};
        rawScores.forEach(s => { scoreMap[s.criterion_name] = s; });

        // ── Criteria rows ─────────────────────────────────────────────────
        const criteria = rubric.criteria || [];
        criteria.forEach((criterion, idx) => {
          const score    = scoreMap[criterion.name] || {};
          const awarded  = score.points_awarded != null ? String(score.points_awarded) : '—';
          const feedback = score.feedback || '';

          // Page-break check: estimate row height before drawing
          const estFeedbackH = textHeight(feedback,      COL.feedback);
          const estTaskH     = textHeight(criterion.name, COL.task);
          const estH         = Math.max(estTaskH, estFeedbackH) + ROW_PAD * 2 + 4;
          if (curY + estH > doc.page.height - 60) {
            doc.addPage();
            curY = 40;
          }

          const cells = [
            { text: String(idx + 1),       width: COL.num      },
            { text: criterion.name,        width: COL.task, bold: true },
            { text: criterion.max_points,  width: COL.max      },
            { text: awarded,               width: COL.awarded  },
            { text: feedback,              width: COL.feedback }
          ];
          cells._alt = idx % 2 === 1;
          curY += drawRow(curY, cells, false);
        });

        // ── Totals row ────────────────────────────────────────────────────
        const totalAwarded = rawScores.reduce((s, r) => s + (Number(r.points_awarded) || 0), 0);
        const totals = [
          { text: '',           width: COL.num      },
          { text: 'TOTAL',      width: COL.task, bold: true },
          { text: rubric.total_points, width: COL.max },
          { text: totalAwarded, width: COL.awarded   },
          { text: '',           width: COL.feedback  }
        ];
        if (curY + 24 > doc.page.height - 60) { doc.addPage(); curY = 40; }
        curY += drawRow(curY, totals, true);

        // ── Overall feedback ──────────────────────────────────────────────
        const overall = markingResult.feedback || markingResult.overall_feedback;
        if (overall && overall.trim()) {
          curY += 12;
          doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000')
             .text('Overall feedback:', L, curY);
          curY = doc.y + 2;
          doc.font('Helvetica').fontSize(9)
             .text(overall, L, curY, { width: pageW });
        }

        doc.end();
        stream.on('finish', () => resolve({ fileName, filePath, size: fs.statSync(filePath).size }));
        stream.on('error', reject);

      } catch (err) {
        reject(err);
      }
    });
  }

  // Generate a batch report for multiple assignments
  generateBatchReport(markingResults, assignments, rubrics) {
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ margin: 50 });
        
        // Determine batch folder - use the batch_id from the first assignment if all are in the same batch
        const batchIds = assignments.map(a => a.batch_id).filter(id => id !== null);
        const uniqueBatchIds = [...new Set(batchIds)];
        
        // If all assignments are in the same batch, use that batch folder
        // Otherwise, use a combined batch folder or unassigned
        let batchDir;
        if (uniqueBatchIds.length === 1) {
          batchDir = this.ensureBatchDirectory(uniqueBatchIds[0]);
        } else if (uniqueBatchIds.length > 1) {
          // Multiple batches - use a combined folder
          const combinedDir = path.join(this.reportsDir, 'combined-batches');
          if (!fs.existsSync(combinedDir)) {
            fs.mkdirSync(combinedDir, { recursive: true });
          }
          batchDir = combinedDir;
        } else {
          // No batches - use unassigned folder
          batchDir = this.ensureBatchDirectory(null);
        }
        
        const fileName = `batch_report_${Date.now()}.pdf`;
        const filePath = path.join(batchDir, fileName);
        
        const stream = fs.createWriteStream(filePath);
        doc.pipe(stream);

        // Batch header
        doc.fontSize(20)
           .font('Helvetica-Bold')
           .text('Batch Assignment Marking Report', { align: 'center' });
        
        doc.moveDown(0.5);
        
        doc.fontSize(12)
           .font('Helvetica')
           .text(`Report Date: ${new Date().toLocaleDateString()}`, { align: 'center' })
           .text(`Total Assignments: ${markingResults.length}`, { align: 'center' });
        
        doc.moveDown(1);

        // Summary statistics
        this.addBatchSummary(doc, markingResults, rubrics);
        
        // Individual reports
        markingResults.forEach((result, index) => {
          const assignment = assignments.find(a => a.id === result.assignment_id);
          const rubric = rubrics.find(r => r.id === result.rubric_id);
          
          if (assignment && rubric) {
            this.addIndividualReportSummary(doc, result, assignment, rubric, index + 1);
          }
        });

        doc.end();

        stream.on('finish', () => {
          resolve({
            fileName,
            filePath,
            size: fs.statSync(filePath).size
          });
        });

        stream.on('error', (error) => {
          reject(error);
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  addBatchSummary(doc, markingResults, rubrics) {
    const totalAssignments = markingResults.length;
    const totalPossiblePoints = rubrics.reduce((sum, rubric) => sum + rubric.total_points, 0);
    const totalActualPoints = markingResults.reduce((sum, result) => sum + result.total_score, 0);
    const averageScore = totalActualPoints / totalAssignments;
    const averagePercentage = (averageScore / (totalPossiblePoints / totalAssignments)) * 100;

    doc.fontSize(14)
       .font('Helvetica-Bold')
       .text('Batch Summary:', { underline: true });
    
    doc.fontSize(12)
       .font('Helvetica')
       .text(`Total Assignments: ${totalAssignments}`, { indent: 20 })
       .text(`Average Score: ${averageScore.toFixed(2)}`, { indent: 20 })
       .text(`Average Percentage: ${averagePercentage.toFixed(1)}%`, { indent: 20 });
    
    doc.moveDown(1);
  }

  addIndividualReportSummary(doc, result, assignment, rubric, index) {
    const percentage = ((result.total_score / rubric.total_points) * 100).toFixed(1);
    
    doc.fontSize(12)
       .font('Helvetica-Bold')
       .text(`${index}. ${assignment.filename}`, { indent: 20 });
    
    doc.fontSize(11)
       .font('Helvetica')
       .text(`   Student: ${result.student_name || 'Not specified'}`, { indent: 40 })
       .text(`   Score: ${result.total_score} / ${rubric.total_points} (${percentage}%)`, { indent: 40 })
       .text(`   Rubric: ${rubric.name}`, { indent: 40 });
    
    doc.moveDown(0.5);
  }

  // Clean up old reports (optional) - handles batch folders
  cleanupOldReports(maxAge = 7 * 24 * 60 * 60 * 1000) { // 7 days
    try {
      const now = Date.now();
      
      // Recursively clean up files in reports directory and subdirectories
      const cleanupDirectory = (dir) => {
        if (!fs.existsSync(dir)) {
          return;
        }
        
        const items = fs.readdirSync(dir);
        
        items.forEach(item => {
          const itemPath = path.join(dir, item);
          const stats = fs.statSync(itemPath);
          
          if (stats.isDirectory()) {
            // Recursively clean subdirectories
            cleanupDirectory(itemPath);
            
            // Remove empty directories
            try {
              const remainingItems = fs.readdirSync(itemPath);
              if (remainingItems.length === 0) {
                fs.rmdirSync(itemPath);
                console.log(`Removed empty directory: ${itemPath}`);
              }
            } catch (err) {
              // Directory might not be empty or might have been removed
            }
          } else if (item.endsWith('.pdf')) {
            // Clean up old PDF files
            if (now - stats.mtime.getTime() > maxAge) {
              fs.unlinkSync(itemPath);
              console.log(`Cleaned up old report: ${itemPath}`);
            }
          }
        });
      };
      
      cleanupDirectory(this.reportsDir);
    } catch (error) {
      console.error('Error cleaning up old reports:', error);
    }
  }
}

module.exports = PDFReportGenerator;
