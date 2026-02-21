const express = require('express');
const path = require('path');
const fs = require('fs');
const PDFReportGenerator = require('../services/pdfReportGenerator');
const { query } = require('../database/connection');

const router = express.Router();
const pdfGenerator = new PDFReportGenerator();

// Generate PDF report for a single marking result
router.get('/pdf/:resultId', async (req, res) => {
  try {
    const { resultId } = req.params;

    // Get marking result with related data (including batch_id)
    const resultQuery = `
      SELECT 
        mr.*,
        a.filename,
        a.file_path,
        a.batch_id,
        r.name as rubric_name,
        r.total_points,
        r.criteria,
        r.rubric_type
      FROM marking_results mr
      JOIN assignments a ON mr.assignment_id = a.id
      JOIN rubrics r ON mr.rubric_id = r.id
      WHERE mr.id = ?
    `;

    const result = await query(resultQuery, [resultId]);

    // Handle different database result formats
    const rows = Array.isArray(result) ? result : (result.rows || []);
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Marking result not found' });
    }

    const markingResult = rows[0];
    
    // Parse criteria if it's a JSON string
    if (typeof markingResult.criteria === 'string') {
      markingResult.criteria = JSON.parse(markingResult.criteria);
    }

    // Generate PDF report (pass batch_id for folder organization)
    const report = await pdfGenerator.generateAssignmentReport(
      markingResult,
      {
        filename: markingResult.filename,
        file_path: markingResult.file_path,
        batch_id: markingResult.batch_id
      },
      {
        name: markingResult.rubric_name,
        total_points: markingResult.total_points,
        criteria: markingResult.criteria,
        rubric_type: markingResult.rubric_type || 'rubric'
      }
    );

    // Send the PDF file
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${report.fileName}"`);
    res.setHeader('Content-Length', report.size);

    const fileStream = fs.createReadStream(report.filePath);
    fileStream.pipe(res);

    // Clean up the file after sending
    fileStream.on('end', () => {
      setTimeout(() => {
        try {
          fs.unlinkSync(report.filePath);
        } catch (error) {
          console.error('Error cleaning up PDF file:', error);
        }
      }, 1000);
    });

  } catch (error) {
    console.error('PDF generation error:', error);
    res.status(500).json({ 
      error: 'Failed to generate PDF report',
      details: error.message
    });
  }
});

// Generate batch PDF report for multiple marking results
router.post('/pdf/batch', async (req, res) => {
  try {
    const { resultIds } = req.body;

    if (!resultIds || !Array.isArray(resultIds) || resultIds.length === 0) {
      return res.status(400).json({ error: 'resultIds array is required' });
    }

    // Get marking results with related data (including batch_id)
    const placeholders = resultIds.map(() => '?').join(',');
    const resultQuery = `
      SELECT 
        mr.*,
        a.filename,
        a.file_path,
        a.batch_id,
        r.name as rubric_name,
        r.total_points,
        r.criteria,
        r.rubric_type
      FROM marking_results mr
      JOIN assignments a ON mr.assignment_id = a.id
      JOIN rubrics r ON mr.rubric_id = r.id
      WHERE mr.id IN (${placeholders})
      ORDER BY mr.marked_at DESC
    `;

    const result = await query(resultQuery, resultIds);

    // Handle different database result formats
    const rows = Array.isArray(result) ? result : (result.rows || []);
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'No marking results found' });
    }

    const markingResults = rows.map(row => {
      if (typeof row.criteria === 'string') {
        row.criteria = JSON.parse(row.criteria);
      }
      return row;
    });

    // Group by assignment and rubric for batch processing
    const assignments = markingResults.map(row => ({
      id: row.assignment_id,
      filename: row.filename,
      file_path: row.file_path,
      batch_id: row.batch_id
    }));

    const rubrics = markingResults.map(row => ({
      id: row.rubric_id,
      name: row.rubric_name,
      total_points: row.total_points,
      criteria: row.criteria,
      rubric_type: row.rubric_type || 'rubric'
    }));

    // Generate batch PDF report
    const report = await pdfGenerator.generateBatchReport(
      markingResults,
      assignments,
      rubrics
    );

    // Send the PDF file
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${report.fileName}"`);
    res.setHeader('Content-Length', report.size);

    const fileStream = fs.createReadStream(report.filePath);
    fileStream.pipe(res);

    // Clean up the file after sending
    fileStream.on('end', () => {
      setTimeout(() => {
        try {
          fs.unlinkSync(report.filePath);
        } catch (error) {
          console.error('Error cleaning up PDF file:', error);
        }
      }, 1000);
    });

  } catch (error) {
    console.error('Batch PDF generation error:', error);
    res.status(500).json({ 
      error: 'Failed to generate batch PDF report',
      details: error.message
    });
  }
});

// Get available reports (for admin purposes) - organized by batch
router.get('/list', async (req, res) => {
  try {
    const reportsDir = path.join(__dirname, '../../reports');
    
    if (!fs.existsSync(reportsDir)) {
      return res.json({ reports: [], batches: {} });
    }

    const reports = [];
    const batches = {};
    
    // Recursively scan reports directory and subdirectories
    const scanDirectory = (dir, relativePath = '') => {
      if (!fs.existsSync(dir)) {
        return;
      }
      
      const items = fs.readdirSync(dir);
      
      items.forEach(item => {
        const itemPath = path.join(dir, item);
        const stats = fs.statSync(itemPath);
        
        if (stats.isDirectory()) {
          // Recursively scan subdirectories
          const subRelativePath = relativePath ? `${relativePath}/${item}` : item;
          scanDirectory(itemPath, subRelativePath);
        } else if (item.endsWith('.pdf')) {
          // Add PDF file to reports list
          const fullRelativePath = relativePath ? `${relativePath}/${item}` : item;
          reports.push({
            fileName: item,
            path: fullRelativePath,
            fullPath: itemPath,
            size: stats.size,
            created: stats.birthtime,
            modified: stats.mtime,
            batch: relativePath || 'root'
          });
          
          // Group by batch
          const batchKey = relativePath || 'root';
          if (!batches[batchKey]) {
            batches[batchKey] = [];
          }
          batches[batchKey].push({
            fileName: item,
            path: fullRelativePath,
            size: stats.size,
            created: stats.birthtime,
            modified: stats.mtime
          });
        }
      });
    };
    
    scanDirectory(reportsDir);
    
    // Sort reports by modified date
    reports.sort((a, b) => new Date(b.modified) - new Date(a.modified));
    
    // Sort reports within each batch
    Object.keys(batches).forEach(batchKey => {
      batches[batchKey].sort((a, b) => new Date(b.modified) - new Date(a.modified));
    });

    res.json({ reports, batches });
  } catch (error) {
    console.error('List reports error:', error);
    res.status(500).json({ 
      error: 'Failed to list reports',
      details: error.message
    });
  }
});

// Clean up old reports
router.post('/cleanup', async (req, res) => {
  try {
    const { maxAge } = req.body; // in days
    const maxAgeMs = (maxAge || 7) * 24 * 60 * 60 * 1000;
    
    pdfGenerator.cleanupOldReports(maxAgeMs);
    
    res.json({ 
      success: true, 
      message: `Cleaned up reports older than ${maxAge || 7} days` 
    });
  } catch (error) {
    console.error('Cleanup error:', error);
    res.status(500).json({ 
      error: 'Failed to cleanup reports',
      details: error.message
    });
  }
});

module.exports = router;
