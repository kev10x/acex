const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

/**
 * Enhanced PDF text extraction with OCR fallback for handwritten/scanned content
 * This service attempts regular text extraction first, then falls back to OCR if needed
 */

// Check if text extraction was successful (has substantial content)
const isTextExtractionSuccessful = (text) => {
  if (!text || text.trim().length === 0) return false;
  // Check if we got meaningful text (more than just a few characters)
  const cleanedText = text.trim().replace(/\s+/g, ' ');
  return cleanedText.length > 50; // At least 50 characters suggests real content
};

/**
 * Extract text from PDF using standard method (pdf-parse)
 */
const extractTextStandard = async (filePath) => {
  try {
    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(dataBuffer);
    return data.text || '';
  } catch (error) {
    console.error('Standard PDF extraction error:', error);
    return '';
  }
};

/**
 * Extract text using OCR (requires additional setup)
 * This is a placeholder - you'll need to install and configure OCR libraries
 */
const extractTextOCR = async (filePath) => {
  // TODO: Implement OCR extraction
  // Options:
  // 1. Tesseract.js (requires tesseract.js and language data)
  // 2. pdf2pic + tesseract (convert PDF to images, then OCR)
  // 3. OpenAI Vision API (send images to GPT-4 Vision)
  
  console.warn('OCR extraction not yet implemented. Please install OCR dependencies.');
  throw new Error('OCR extraction not available. Please install tesseract.js or use OpenAI Vision API.');
};

/**
 * Main extraction function with fallback logic
 */
const extractTextFromPDF = async (filePath, options = {}) => {
  const { 
    useOCR = false, 
    useVisionAPI = true, // Default to true for automatic fallback
    forceOCR = false 
  } = options;

  try {
    // If force OCR is enabled, skip standard extraction
    if (!forceOCR) {
      // First, try standard text extraction
      console.log('📄 Attempting standard text extraction...');
      let text = await extractTextStandard(filePath);
      
      if (isTextExtractionSuccessful(text)) {
        console.log('✅ Standard extraction successful');
        return text;
      }
      
      console.log('⚠️ Standard extraction returned insufficient text. Text length:', text?.length || 0);
    }

    // If standard extraction failed or returned minimal text, try Vision API
    if (useVisionAPI && (process.env.ENABLE_VISION_API !== 'false')) {
      console.log('📸 Standard extraction insufficient. Attempting Vision API (handwritten/scanned text support)...');
      
      try {
        const visionText = await extractTextWithVisionAPI(filePath);
        if (visionText && visionText.trim().length > 0) {
          return visionText;
        }
        // If Vision API returned empty text, fall through to error
        throw new Error('Vision API returned empty text');
      } catch (visionError) {
        console.error('❌ Vision API extraction failed:', visionError.message);
        console.error('Full error details:', visionError);
        
        // If Vision API fails and OCR is enabled, try OCR
        if (useOCR) {
          console.log('📸 Attempting Tesseract OCR as fallback...');
          try {
            return await extractTextOCR(filePath);
          } catch (ocrError) {
            console.error('❌ OCR fallback also failed:', ocrError.message);
          }
        }
        
        // Provide helpful error message with troubleshooting
        let imageMagickStatus = 'Unknown';
        try {
          const { spawnSync } = require('child_process');
          const result = spawnSync('magick', ['-version'], { shell: true, timeout: 5000 });
          imageMagickStatus = result.error ? 'NOT INSTALLED' : 'INSTALLED';
        } catch (e) {
          imageMagickStatus = 'CHECK FAILED';
        }
        
        const helpfulError = new Error(
          `Vision API extraction failed: ${visionError.message}\n\n` +
          `Troubleshooting:\n` +
          `1. ImageMagick status: ${imageMagickStatus}\n` +
          `2. Verify OpenAI API key is set and valid\n` +
          `3. Check if PDF has extractable content\n` +
          `4. Review server logs for detailed page-by-page errors`
        );
        throw helpfulError;
      }
    } else if (useOCR) {
      // Use Tesseract OCR
      console.log('📸 Attempting Tesseract OCR...');
      return await extractTextOCR(filePath);
    }

    // If no OCR options enabled and standard extraction failed
    const standardText = await extractTextStandard(filePath);
    if (!standardText || standardText.trim().length === 0) {
      throw new Error(
        'No text could be extracted from the PDF. ' +
        'This appears to be a scanned image or handwritten document. ' +
        'Vision API extraction is enabled but failed. Please check your OpenAI API key and ensure ENABLE_VISION_API is set correctly.'
      );
    }

    return standardText;
  } catch (error) {
    console.error('❌ PDF text extraction error:', error);
    throw error;
  }
};

/**
 * Extract text using OpenAI Vision API (GPT-4 Vision)
 * This can handle handwritten text in images
 */
const extractTextWithVisionAPI = async (filePath) => {
  try {
    const OpenAI = require('openai');
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    // Convert PDF pages to images
    const pdf2pic = require('pdf2pic');
    const { fromPath } = pdf2pic;
    
    // Create temp directory if it doesn't exist
    const tempDir = path.join(__dirname, '../uploads/temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Get number of pages first
    const pdfData = await pdfParse(fs.readFileSync(filePath));
    const numPages = pdfData.numpages || 1;

    console.log(`📸 Converting ${numPages} PDF page(s) to images for OCR...`);

    // Check if ImageMagick or GraphicsMagick is available
    let magickAvailable = false;
    try {
      const { spawnSync } = require('child_process');
      // Try ImageMagick first (magick command)
      let checkResult = spawnSync('magick', ['-version'], { shell: true, timeout: 3000 });
      if (!checkResult.error) {
        magickAvailable = true;
        console.log('✅ ImageMagick is available');
      } else {
        // Try GraphicsMagick (gm command)
        checkResult = spawnSync('gm', ['version'], { shell: true, timeout: 3000 });
        if (!checkResult.error) {
          magickAvailable = true;
          console.log('✅ GraphicsMagick is available');
        }
      }
    } catch (magickError) {
      console.warn('⚠️ Could not verify ImageMagick/GraphicsMagick installation');
    }

    if (!magickAvailable) {
      console.warn('⚠️ ImageMagick/GraphicsMagick not found. Attempting PDF conversion anyway...');
      console.warn('⚠️ If conversion fails, please install ImageMagick: https://imagemagick.org/script/download.php');
    }

    const convert = fromPath(filePath, {
      density: 300,
      saveFilename: 'ocr_temp',
      savePath: tempDir,
      format: 'png',
      width: 2000,
      height: 2000
    });

    // Process all pages and combine text
    const allTexts = [];
    const pageErrors = [];
    
    for (let pageNum = 1; pageNum <= Math.min(numPages, 10); pageNum++) { // Limit to 10 pages for cost control
      try {
        console.log(`📄 Processing page ${pageNum}/${numPages}...`);
        
        // Convert PDF page to image
        let result;
        try {
          // Try default response first (pdf2pic typically returns { path: string } or { name: string })
          result = await convert(pageNum);
        } catch (convertError) {
          // If default fails, try with buffer response
          try {
            console.log(`⚠️ Default conversion failed, trying buffer response...`);
            result = await convert(pageNum, { responseType: 'buffer' });
          } catch (bufferError) {
            console.error(`❌ Failed to convert page ${pageNum} to image:`, convertError.message);
            console.error('Conversion error details:', convertError);
            console.error('Buffer conversion error:', bufferError.message);
            pageErrors.push(`Page ${pageNum}: Conversion failed - ${convertError.message}`);
            
            // If ImageMagick error, provide helpful message
            if (convertError.message && (
              convertError.message.includes('magick') || 
              convertError.message.includes('ImageMagick') ||
              convertError.message.includes('GraphicsMagick') ||
              convertError.message.includes('gm')
            )) {
              pageErrors.push(`Page ${pageNum}: ImageMagick/GraphicsMagick may not be installed or configured correctly`);
            }
            continue;
          }
        }
        
        // Log detailed result information
        console.log(`📸 Conversion result type for page ${pageNum}:`, typeof result);
        console.log(`📸 Conversion result is null/undefined:`, result == null);
        if (result) {
          if (typeof result === 'object') {
            console.log(`📸 Conversion result keys:`, Object.keys(result));
            console.log(`📸 Conversion result stringified (first 500 chars):`, JSON.stringify(result).substring(0, 500));
          } else {
            console.log(`📸 Conversion result value:`, result);
          }
        }

        // Handle different result formats from pdf2pic
        let imageBuffer = null;
        let imagePath = null;
        
        // Check if result is a buffer (direct image data)
        if (Buffer.isBuffer(result)) {
          imageBuffer = result;
          console.log(`✅ Received image buffer (${imageBuffer.length} bytes)`);
        } else if (result === null || result === undefined) {
          console.warn(`⚠️ Conversion returned null/undefined for page ${pageNum}`);
          pageErrors.push(`Page ${pageNum}: Conversion returned null/undefined`);
          continue;
        } else if (typeof result === 'string') {
          // Result is a file path
          imagePath = result;
          console.log(`✅ Received image path: ${imagePath}`);
        } else if (result && typeof result === 'object') {
          // Handle object responses
          if (result.path) {
            imagePath = result.path;
            console.log(`✅ Found path in result: ${imagePath}`);
          } else if (result.name) {
            imagePath = result.name;
            console.log(`✅ Found name in result: ${imagePath}`);
          } else if (result.filePath) {
            imagePath = result.filePath;
            console.log(`✅ Found filePath in result: ${imagePath}`);
          } else if (result.buffer && Buffer.isBuffer(result.buffer)) {
            imageBuffer = result.buffer;
            console.log(`✅ Found buffer in result (${imageBuffer.length} bytes)`);
          } else if (result.data && Buffer.isBuffer(result.data)) {
            imageBuffer = result.data;
            console.log(`✅ Found data buffer in result (${imageBuffer.length} bytes)`);
          } else if (result.base64) {
            // If base64 is returned directly, use it
            imageBuffer = Buffer.from(result.base64, 'base64');
            console.log(`✅ Found base64 in result, converted to buffer (${imageBuffer.length} bytes)`);
          } else if (result.image) {
            // Some libraries return image as a property
            if (Buffer.isBuffer(result.image)) {
              imageBuffer = result.image;
              console.log(`✅ Found image buffer in result (${imageBuffer.length} bytes)`);
            } else if (typeof result.image === 'string') {
              imagePath = result.image;
              console.log(`✅ Found image path in result: ${imagePath}`);
            }
          } else {
            // Try to find any buffer-like property
            const bufferKeys = Object.keys(result).filter(key => Buffer.isBuffer(result[key]));
            if (bufferKeys.length > 0) {
              imageBuffer = result[bufferKeys[0]];
              console.log(`✅ Found buffer in property '${bufferKeys[0]}' (${imageBuffer.length} bytes)`);
            } else {
              // Try to find any string property that might be a path
              const pathKeys = Object.keys(result).filter(key => 
                typeof result[key] === 'string' && 
                (result[key].includes('/') || result[key].includes('\\') || result[key].endsWith('.png'))
              );
              if (pathKeys.length > 0) {
                imagePath = result[pathKeys[0]];
                console.log(`✅ Found potential path in property '${pathKeys[0]}': ${imagePath}`);
              } else {
                console.warn(`⚠️ Unexpected result format for page ${pageNum}. Full result:`, JSON.stringify(result, null, 2));
                pageErrors.push(`Page ${pageNum}: Unexpected conversion result format - ${typeof result}`);
                continue;
              }
            }
          }
        } else {
          console.warn(`⚠️ Unexpected result type for page ${pageNum}: ${typeof result}`);
          pageErrors.push(`Page ${pageNum}: Unexpected conversion result type - ${typeof result}`);
          continue;
        }

        // If we have a buffer, use it directly
        if (imageBuffer) {
          const base64Image = imageBuffer.toString('base64');
          console.log(`📤 Sending page ${pageNum} to Vision API (${Math.round(base64Image.length / 1024)}KB base64)...`);
          
          try {
            const response = await openai.chat.completions.create({
              model: 'gpt-4o',
              messages: [
                {
                  role: 'user',
                  content: [
                    {
                      type: 'text',
                      text: 'Extract all text from this image. Preserve the structure and formatting as much as possible. Include all handwritten text, typed text, and any annotations. If there are multiple questions or sections, maintain that structure. Return only the extracted text without additional commentary. If the image contains no text, return "NO_TEXT_FOUND".'
                    },
                    {
                      type: 'image_url',
                      image_url: {
                        url: `data:image/png;base64,${base64Image}`
                      }
                    }
                  ]
                }
              ],
              max_tokens: 4000
            });

            const pageText = response?.choices?.[0]?.message?.content;
            
            if (pageText && pageText.trim().length > 0 && pageText.trim().toUpperCase() !== 'NO_TEXT_FOUND') {
              console.log(`✅ Extracted ${pageText.length} characters from page ${pageNum}`);
              allTexts.push(`--- Page ${pageNum} ---\n${pageText}`);
            } else {
              console.warn(`⚠️ Vision API returned no text for page ${pageNum}`);
              pageErrors.push(`Page ${pageNum}: No text found in image`);
            }
          } catch (apiError) {
            console.error(`❌ Vision API error for page ${pageNum}:`, apiError.message);
            pageErrors.push(`Page ${pageNum}: Vision API error - ${apiError.message}`);
          }
          continue;
        }

        if (!imagePath) {
          console.warn(`⚠️ No image path returned for page ${pageNum}`);
          pageErrors.push(`Page ${pageNum}: No image path returned`);
          continue;
        }

        // Check if file exists (handle both absolute and relative paths)
        const fullImagePath = path.isAbsolute(imagePath) ? imagePath : path.join(tempDir, imagePath);
        if (!fs.existsSync(fullImagePath)) {
          console.warn(`⚠️ Image file does not exist: ${fullImagePath}`);
          pageErrors.push(`Page ${pageNum}: Image file not found`);
          continue;
        }

        console.log(`✅ Image created: ${fullImagePath} (${fs.statSync(fullImagePath).size} bytes)`);

        // Read image as base64
        let fileImageBuffer;
        try {
          fileImageBuffer = fs.readFileSync(fullImagePath);
          if (!fileImageBuffer || fileImageBuffer.length === 0) {
            throw new Error('Image file is empty');
          }
        } catch (readError) {
          console.error(`❌ Failed to read image file:`, readError.message);
          pageErrors.push(`Page ${pageNum}: Failed to read image - ${readError.message}`);
          continue;
        }

        const base64Image = fileImageBuffer.toString('base64');
        console.log(`📤 Sending page ${pageNum} to Vision API (${Math.round(base64Image.length / 1024)}KB base64)...`);

        // Use OpenAI Vision API
        let response;
        try {
          response = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: 'Extract all text from this image. Preserve the structure and formatting as much as possible. Include all handwritten text, typed text, and any annotations. If there are multiple questions or sections, maintain that structure. Return only the extracted text without additional commentary. If the image contains no text, return "NO_TEXT_FOUND".'
                  },
                  {
                    type: 'image_url',
                    image_url: {
                      url: `data:image/png;base64,${base64Image}`
                    }
                  }
                ]
              }
            ],
            max_tokens: 4000
          });
        } catch (apiError) {
          console.error(`❌ Vision API error for page ${pageNum}:`, apiError.message);
          pageErrors.push(`Page ${pageNum}: Vision API error - ${apiError.message}`);
          // Clean up image before continuing
          if (fs.existsSync(fullImagePath)) {
            fs.unlinkSync(fullImagePath);
          }
          continue;
        }

        const pageText = response?.choices?.[0]?.message?.content;
        
        if (!pageText) {
          console.warn(`⚠️ Vision API returned no content for page ${pageNum}`);
          pageErrors.push(`Page ${pageNum}: No content returned from Vision API`);
        } else if (pageText.trim().toUpperCase() === 'NO_TEXT_FOUND') {
          console.warn(`⚠️ Vision API detected no text in page ${pageNum}`);
          pageErrors.push(`Page ${pageNum}: Vision API detected no text`);
        } else if (pageText.trim().length > 0) {
          console.log(`✅ Extracted ${pageText.length} characters from page ${pageNum}`);
          allTexts.push(`--- Page ${pageNum} ---\n${pageText}`);
        } else {
          console.warn(`⚠️ Vision API returned empty text for page ${pageNum}`);
          pageErrors.push(`Page ${pageNum}: Empty text returned`);
        }

        // Clean up temp image
        try {
          if (fs.existsSync(fullImagePath)) {
            fs.unlinkSync(fullImagePath);
          }
        } catch (cleanupError) {
          console.warn(`⚠️ Failed to cleanup image file: ${cleanupError.message}`);
        }

      } catch (pageError) {
        console.error(`❌ Unexpected error processing page ${pageNum}:`, pageError.message);
        console.error('Stack trace:', pageError.stack);
        pageErrors.push(`Page ${pageNum}: ${pageError.message}`);
        // Continue with other pages
      }
    }

    // Provide detailed error information
    if (allTexts.length === 0) {
      const errorDetails = pageErrors.length > 0 
        ? `\nPage errors:\n${pageErrors.join('\n')}`
        : '\nNo specific page errors logged, but no text was extracted.';
      throw new Error(`No text could be extracted from any pages using Vision API.${errorDetails}\n\nPossible causes:\n1. PDF conversion to image failed (check ImageMagick installation)\n2. Vision API returned no text\n3. Images are empty or corrupted\n4. API key issues or rate limits`);
    }

    const extractedText = allTexts.join('\n\n');
    console.log(`✅ Vision API extraction successful (${allTexts.length} page(s))`);
    return extractedText;

  } catch (error) {
    console.error('❌ Vision API extraction error:', error);
    throw new Error('Failed to extract text using Vision API: ' + error.message);
  }
};

module.exports = {
  extractTextFromPDF,
  extractTextStandard,
  extractTextOCR,
  extractTextWithVisionAPI,
  isTextExtractionSuccessful
};

