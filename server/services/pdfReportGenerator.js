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
