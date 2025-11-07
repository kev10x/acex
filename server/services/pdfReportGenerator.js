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

  generateAssignmentReport(markingResult, assignment, rubric) {
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ margin: 50 });
        const fileName = `assignment_report_${markingResult.id}_${Date.now()}.pdf`;
        const filePath = path.join(this.reportsDir, fileName);
        
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
    doc.fontSize(14)
       .font('Helvetica-Bold')
       .text('Detailed Criteria Scores:', { underline: true });
    
    doc.moveDown(0.5);
    
    // Parse scores if it's a string
    const scores = typeof markingResult.scores === 'string' 
      ? JSON.parse(markingResult.scores) 
      : markingResult.scores;
    
    scores.forEach((score, index) => {
      // Criterion name
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


  // Generate a batch report for multiple assignments
  generateBatchReport(markingResults, assignments, rubrics) {
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ margin: 50 });
        const fileName = `batch_report_${Date.now()}.pdf`;
        const filePath = path.join(this.reportsDir, fileName);
        
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

  // Clean up old reports (optional)
  cleanupOldReports(maxAge = 7 * 24 * 60 * 60 * 1000) { // 7 days
    try {
      const files = fs.readdirSync(this.reportsDir);
      const now = Date.now();
      
      files.forEach(file => {
        const filePath = path.join(this.reportsDir, file);
        const stats = fs.statSync(filePath);
        
        if (now - stats.mtime.getTime() > maxAge) {
          fs.unlinkSync(filePath);
          console.log(`Cleaned up old report: ${file}`);
        }
      });
    } catch (error) {
      console.error('Error cleaning up old reports:', error);
    }
  }
}

module.exports = PDFReportGenerator;
