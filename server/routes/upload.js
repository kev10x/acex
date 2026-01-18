const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const yauzl = require('yauzl');
const { query } = require('../database/connection');
const { extractTextFromPDF } = require('../services/pdfOCR');

const router = express.Router();

// Test endpoint
router.get('/test', (req, res) => {
  res.json({ 
    message: 'Upload endpoint is working',
    uploadDir: uploadDir,
    maxFileSize: process.env.MAX_FILE_SIZE || '10MB',
    timestamp: new Date().toISOString()
  });
});

// Health check for upload service
router.get('/health', (req, res) => {
  try {
    const uploadDirExists = fs.existsSync(uploadDir);
    const uploadDirWritable = uploadDirExists && fs.accessSync ? (() => {
      try {
        fs.accessSync(uploadDir, fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    })() : uploadDirExists;
    
    res.json({
      status: 'ok',
      uploadDir: uploadDir,
      uploadDirExists: uploadDirExists,
      uploadDirWritable: uploadDirWritable,
      maxFileSize: process.env.MAX_FILE_SIZE || '10MB',
      maxZipSize: process.env.MAX_ZIP_SIZE || '100MB'
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message
    });
  }
});

// Ensure uploads directory exists
const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure multer for PDF uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const fileFilter = (req, file, cb) => {
  if (file.mimetype === 'application/pdf') {
    cb(null, true);
  } else {
    cb(new Error('Only PDF files are allowed'), false);
  }
};

// Separate filter for ZIP uploads
const zipFileFilter = (req, file, cb) => {
  const isZip =
    file.mimetype === 'application/zip' ||
    file.mimetype === 'application/x-zip-compressed' ||
    file.originalname.toLowerCase().endsWith('.zip');
  if (isZip) {
    cb(null, true);
  } else {
    cb(new Error('Only ZIP files are allowed'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024 // 10MB default
  }
});

// Uploader for ZIP files (allow larger by default: 100MB)
const uploadZip = multer({
  storage,
  fileFilter: zipFileFilter,
  limits: {
    fileSize: parseInt(process.env.MAX_ZIP_SIZE) || 100 * 1024 * 1024
  }
});

// Upload single PDF
router.post('/single', upload.single('pdf'), async (req, res) => {
  try {
    console.log('Upload request received:', {
      hasFile: !!req.file,
      body: req.body,
      fileInfo: req.file ? {
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
        path: req.file.path
      } : null
    });

    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file uploaded' });
    }

    // Validate file type
    if (req.file.mimetype !== 'application/pdf') {
      // Delete the uploaded file if it's not a PDF
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(400).json({ error: 'Only PDF files are allowed' });
    }

    const assignment = {
      filename: req.file.originalname,
      file_path: req.file.path,
      file_size: req.file.size,
      status: 'uploaded'
    };

    console.log('Saving assignment to database:', assignment);

    // Extract text from PDF and store it
    let extractedText = null;
    try {
      console.log('Extracting text from PDF...');
      extractedText = await extractTextFromPDF(req.file.path);
      if (extractedText && extractedText.trim().length > 0) {
        console.log(`✅ Extracted ${extractedText.length} characters of text`);
      } else {
        console.log('⚠️  No text extracted from PDF');
      }
    } catch (error) {
      console.warn('⚠️  Error extracting text from PDF (continuing anyway):', error.message);
      // Continue even if extraction fails - text can be extracted later
    }

    const result = await query(
      'INSERT INTO assignments (filename, file_path, file_size, status, extracted_text) VALUES (?, ?, ?, ?, ?)',
      [assignment.filename, assignment.file_path, assignment.file_size, assignment.status, extractedText]
    );
    
    // For SQLite, we need to get the last inserted ID separately
    const insertedId = result.lastID || result.rows?.[0]?.id;
    const assignmentWithId = {
      id: insertedId,
      filename: assignment.filename,
      file_path: assignment.file_path,
      file_size: assignment.file_size,
      status: assignment.status,
      uploaded_at: new Date().toISOString()
    };

    console.log('Assignment saved successfully:', assignmentWithId);

    res.json({
      success: true,
      assignment: assignmentWithId,
      message: 'PDF uploaded successfully'
    });
  } catch (error) {
    console.error('Upload error:', error);
    
    // Clean up uploaded file if there was an error
    if (req.file && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (cleanupError) {
        console.error('Error cleaning up file:', cleanupError);
      }
    }
    
    res.status(500).json({ 
      error: 'Failed to upload PDF',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Upload multiple PDFs
router.post('/multiple', upload.array('pdfs', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No PDF files uploaded' });
    }

    const assignments = [];
    
    for (const file of req.files) {
      const assignment = {
        filename: file.originalname,
        file_path: file.path,
        file_size: file.size,
        status: 'uploaded'
      };

      // Extract text from PDF and store it
      let extractedText = null;
      try {
        extractedText = await extractTextFromPDF(file.path);
        if (!extractedText || extractedText.trim().length === 0) {
          extractedText = null;
        }
      } catch (error) {
        console.warn(`⚠️  Error extracting text from ${file.originalname}:`, error.message);
        // Continue even if extraction fails
      }

      const result = await query(
        'INSERT INTO assignments (filename, file_path, file_size, status, extracted_text) VALUES (?, ?, ?, ?, ?)',
        [assignment.filename, assignment.file_path, assignment.file_size, assignment.status, extractedText]
      );

      // For SQLite, we need to get the last inserted ID separately
      const insertedId = result.lastID || result.rows?.[0]?.id;
      const assignmentWithId = {
        id: insertedId,
        filename: assignment.filename,
        file_path: assignment.file_path,
        file_size: assignment.file_size,
        status: assignment.status,
        uploaded_at: new Date().toISOString()
      };

      assignments.push(assignmentWithId);
    }

    res.json({
      success: true,
      assignments,
      count: assignments.length,
      message: `${assignments.length} PDF(s) uploaded successfully`
    });
  } catch (error) {
    console.error('Multiple upload error:', error);
    res.status(500).json({ error: 'Failed to upload PDFs' });
  }
});

// Upload ZIP of PDFs
router.post('/zip', uploadZip.single('zip'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No ZIP file uploaded' });
    }

    const zipPath = req.file.path;
    const extractedAssignments = [];

    // Helper to insert assignment row
    const insertAssignment = async (filename, filePath, fileSize) => {
      // Extract text from PDF and store it
      let extractedText = null;
      try {
        extractedText = await extractTextFromPDF(filePath);
        if (!extractedText || extractedText.trim().length === 0) {
          extractedText = null;
        }
      } catch (error) {
        console.warn(`⚠️  Error extracting text from ${filename}:`, error.message);
        // Continue even if extraction fails
      }
      
      const result = await query(
        'INSERT INTO assignments (filename, file_path, file_size, status, extracted_text) VALUES (?, ?, ?, ?, ?)',
        [filename, filePath, fileSize, 'uploaded', extractedText]
      );
      const insertedId = result.lastID || result.rows?.[0]?.id;
      extractedAssignments.push({
        id: insertedId,
        filename,
        file_path: filePath,
        file_size: fileSize,
        status: 'uploaded',
        uploaded_at: new Date().toISOString()
      });
    };

    // Process ZIP
    const processZip = () => new Promise((resolve, reject) => {
      yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
        if (err) return reject(err);

        zipfile.readEntry();

        zipfile.on('entry', (entry) => {
          // Skip directories
          if (/\/$/.test(entry.fileName)) {
            zipfile.readEntry();
            return;
          }

          // Only process PDFs
          const lower = entry.fileName.toLowerCase();
          if (!lower.endsWith('.pdf')) {
            zipfile.readEntry();
            return;
          }

          // Create unique name in uploads dir
          const baseName = path.basename(entry.fileName);
          const uniqueName = `${uuidv4()}-${baseName}`;
          const outPath = path.join(uploadDir, uniqueName);

          // Ensure parent dir exists
          fs.mkdirSync(path.dirname(outPath), { recursive: true });

          zipfile.openReadStream(entry, (err2, readStream) => {
            if (err2) return reject(err2);
            const writeStream = fs.createWriteStream(outPath);
            let totalBytes = 0;
            readStream.on('data', (chunk) => { totalBytes += chunk.length; });
            readStream.pipe(writeStream);
            writeStream.on('close', async () => {
              try {
                await insertAssignment(baseName, outPath, totalBytes);
                zipfile.readEntry();
              } catch (e) {
                reject(e);
              }
            });
            writeStream.on('error', reject);
          });
        });

        zipfile.on('end', () => resolve());
        zipfile.on('error', reject);
      });
    });

    await processZip();

    // Clean up uploaded ZIP
    try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch {}

    if (extractedAssignments.length === 0) {
      return res.status(400).json({ error: 'No PDFs found in ZIP' });
    }

    res.json({
      success: true,
      count: extractedAssignments.length,
      assignments: extractedAssignments,
      message: `Extracted ${extractedAssignments.length} PDF(s) from ZIP`
    });
  } catch (error) {
    console.error('ZIP upload error:', error);
    res.status(500).json({ error: 'Failed to process ZIP file', details: process.env.NODE_ENV === 'development' ? error.message : undefined });
  }
});

// Get all uploaded assignments
router.get('/', async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM assignments ORDER BY uploaded_at DESC'
    );
    
    // Handle different database result formats
    const assignments = Array.isArray(result) ? result : (result.rows || []);
    
    res.json({
      success: true,
      assignments
    });
  } catch (error) {
    console.error('Get assignments error:', error);
    res.status(500).json({ error: 'Failed to fetch assignments' });
  }
});

// Delete assignment
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get file path before deleting
    const assignmentResult = await query(
      'SELECT file_path FROM assignments WHERE id = ?',
      [id]
    );

    if (assignmentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    // Delete from database
    await query('DELETE FROM assignments WHERE id = ?', [id]);

    // Delete file from filesystem
    const filePath = assignmentResult.rows[0].file_path;
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    res.json({
      success: true,
      message: 'Assignment deleted successfully'
    });
  } catch (error) {
    console.error('Delete assignment error:', error);
    res.status(500).json({ error: 'Failed to delete assignment' });
  }
});

module.exports = router;
