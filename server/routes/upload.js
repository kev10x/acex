const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const yauzl = require('yauzl');
const { query } = require('../database/connection');
const {
  extractTextFromDocument,
  getSupportedDocumentLabel,
  isSupportedDocument
} = require('../services/documentExtractService');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const rowsOf = (result) => (Array.isArray(result) ? result : (result?.rows || []));

const resolveBatchId = async (batchIdRaw, userId) => {
  if (!batchIdRaw) return null;
  const parsed = Number(batchIdRaw);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error('Invalid batch_id');
  const batch = rowsOf(await query('SELECT id FROM batches WHERE id = ? AND user_id = ?', [parsed, userId]))[0];
  if (!batch) throw new Error('Batch not found');
  return parsed;
};

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

// Configure multer for assignment uploads
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
  if (isSupportedDocument(file.originalname, file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only PDF or DOCX Word documents are allowed'), false);
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

// Upload single assignment document
router.post('/single', requireAuth, upload.single('pdf'), async (req, res) => {
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
      return res.status(400).json({ error: 'No assignment file uploaded' });
    }

    // Validate file type
    if (!isSupportedDocument(req.file.originalname, req.file.mimetype)) {
      // Delete the uploaded file if it's not supported
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(400).json({ error: 'Only PDF or DOCX Word documents are allowed' });
    }

    const batchId = await resolveBatchId(req.body?.batch_id, req.user.id);
    const assignment = {
      filename: req.file.originalname,
      file_path: req.file.path,
      file_size: req.file.size,
      status: 'uploaded',
      batch_id: batchId
    };

    console.log('Saving assignment to database:', assignment);

    const documentLabel = getSupportedDocumentLabel(req.file.originalname, req.file.mimetype);

    // Extract text from the document and store it
    let extractedText = null;
    try {
      console.log(`Extracting text from ${documentLabel}...`);
      extractedText = await extractTextFromDocument(req.file.path, req.file.originalname, req.file.mimetype);
      if (extractedText && extractedText.trim().length > 0) {
        console.log(`✅ Extracted ${extractedText.length} characters of text`);
      } else {
        console.log(`⚠️  No text extracted from ${documentLabel}`);
      }
    } catch (error) {
      console.warn(`⚠️  Error extracting text from ${documentLabel} (continuing anyway):`, error.message);
      // Continue even if extraction fails - text can be extracted later
    }

    const result = await query(
      'INSERT INTO assignments (filename, file_path, file_size, status, extracted_text, user_id, batch_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [assignment.filename, assignment.file_path, assignment.file_size, assignment.status, extractedText, req.user.id, assignment.batch_id]
    );
    
    // Get the last inserted ID
    const insertedId = result.lastID || result.rows?.[0]?.id;
    const assignmentWithId = {
      id: insertedId,
      filename: assignment.filename,
      file_path: assignment.file_path,
      file_size: assignment.file_size,
      status: assignment.status,
      batch_id: assignment.batch_id,
      uploaded_at: new Date().toISOString()
    };

    console.log('Assignment saved successfully:', assignmentWithId);

    res.json({
      success: true,
      assignment: assignmentWithId,
      message: `${documentLabel} uploaded successfully`
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
      error: 'Failed to upload assignment document',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Upload multiple assignment documents
router.post('/multiple', requireAuth, upload.array('pdfs', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No assignment files uploaded' });
    }

    const batchId = await resolveBatchId(req.body?.batch_id, req.user.id);
    const assignments = [];
    
    for (const file of req.files) {
      const assignment = {
        filename: file.originalname,
        file_path: file.path,
        file_size: file.size,
        status: 'uploaded',
        batch_id: batchId
      };

      const documentLabel = getSupportedDocumentLabel(file.originalname, file.mimetype);

      // Extract text from the document and store it
      let extractedText = null;
      try {
        extractedText = await extractTextFromDocument(file.path, file.originalname, file.mimetype);
        if (!extractedText || extractedText.trim().length === 0) {
          extractedText = null;
        }
      } catch (error) {
        console.warn(`⚠️  Error extracting text from ${file.originalname}:`, error.message);
        // Continue even if extraction fails
      }

      const result = await query(
        'INSERT INTO assignments (filename, file_path, file_size, status, extracted_text, user_id, batch_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [assignment.filename, assignment.file_path, assignment.file_size, assignment.status, extractedText, req.user.id, assignment.batch_id]
      );

      // Get the last inserted ID
      const insertedId = result.lastID || result.rows?.[0]?.id;
      const assignmentWithId = {
        id: insertedId,
        filename: assignment.filename,
        file_path: assignment.file_path,
        file_size: assignment.file_size,
        status: assignment.status,
        batch_id: assignment.batch_id,
        uploaded_at: new Date().toISOString()
      };

      assignments.push(assignmentWithId);
    }

    res.json({
      success: true,
      assignments,
      count: assignments.length,
      message: `${assignments.length} assignment document(s) uploaded successfully`
    });
  } catch (error) {
    console.error('Multiple upload error:', error);
    res.status(500).json({ error: 'Failed to upload assignment documents' });
  }
});

// Upload ZIP of assignment documents
router.post('/zip', requireAuth, uploadZip.single('zip'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No ZIP file uploaded' });
    }

    const batchId = await resolveBatchId(req.body?.batch_id, req.user.id);
    const zipPath = req.file.path;
    const extractedAssignments = [];

    // Helper to insert assignment row
    const insertAssignment = async (filename, filePath, fileSize) => {
      // Extract text from the document and store it
      let extractedText = null;
      try {
        extractedText = await extractTextFromDocument(filePath, filename);
        if (!extractedText || extractedText.trim().length === 0) {
          extractedText = null;
        }
      } catch (error) {
        console.warn(`⚠️  Error extracting text from ${filename}:`, error.message);
        // Continue even if extraction fails
      }
      
      const result = await query(
        'INSERT INTO assignments (filename, file_path, file_size, status, extracted_text, user_id, batch_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [filename, filePath, fileSize, 'uploaded', extractedText, req.user.id, batchId]
      );
      const insertedId = result.lastID || result.rows?.[0]?.id;
      extractedAssignments.push({
        id: insertedId,
        filename,
        file_path: filePath,
        file_size: fileSize,
        status: 'uploaded',
        batch_id: batchId,
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

          // Only process supported assignment documents
          const lower = entry.fileName.toLowerCase();
          if (!isSupportedDocument(lower)) {
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
      return res.status(400).json({ error: 'No PDF or DOCX files found in ZIP' });
    }

    res.json({
      success: true,
      count: extractedAssignments.length,
      assignments: extractedAssignments,
      message: `Extracted ${extractedAssignments.length} assignment document(s) from ZIP`
    });
  } catch (error) {
    console.error('ZIP upload error:', error);
    res.status(500).json({ error: 'Failed to process ZIP file', details: process.env.NODE_ENV === 'development' ? error.message : undefined });
  }
});

// Get all uploaded assignments
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, filename, file_size, uploaded_at, status, batch_id, processing_job_id
       FROM assignments
       WHERE user_id = ?
       ORDER BY uploaded_at DESC`,
      [req.user.id]
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
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get file path before deleting
    const assignmentResult = await query(
      'SELECT file_path FROM assignments WHERE id = ? AND user_id = ?',
      [id, req.user.id]
    );

    if (assignmentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    // Delete from database
    await query('DELETE FROM assignments WHERE id = ? AND user_id = ?', [id, req.user.id]);

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
