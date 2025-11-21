# Handwritten Text Support

## Current Status

**The system does NOT currently support handwritten text extraction.**

The application uses `pdf-parse`, which only extracts text from PDFs that have text layers (typed/selectable text). Handwritten content in scanned PDFs or image-based PDFs requires OCR (Optical Character Recognition).

## What Works Now

✅ **Typed text in PDFs** - Works perfectly  
✅ **PDFs with text layers** - Fully supported  
❌ **Scanned PDFs** - Not supported  
❌ **Handwritten text** - Not supported  
❌ **Image-based PDFs** - Not supported  

## Adding Handwritten Text Support

To add handwritten text support, you have several options:

### Option 1: OpenAI Vision API (Recommended)

**Pros:**
- Excellent accuracy for handwritten text
- No additional dependencies to install
- Works well with various handwriting styles
- Already using OpenAI API

**Cons:**
- Costs per image processed
- Requires API key

**Setup:**
1. Install `pdf2pic`:
   ```bash
   npm install pdf2pic
   ```

2. The code in `server/services/pdfOCR.js` includes a `extractTextWithVisionAPI` function that uses GPT-4 Vision

3. Update `extractTextFromPDF` calls to use Vision API:
   ```javascript
   const text = await extractTextFromPDF(filePath, { useVisionAPI: true });
   ```

### Option 2: Tesseract.js OCR

**Pros:**
- Free and open source
- Can run locally
- Good for typed text in images

**Cons:**
- Requires Tesseract installation
- Less accurate for handwritten text
- Needs language data files

**Setup:**
1. Install Tesseract.js:
   ```bash
   npm install tesseract.js pdf2pic
   ```

2. Install system Tesseract (varies by OS):
   - Windows: Download from GitHub
   - macOS: `brew install tesseract`
   - Linux: `apt-get install tesseract-ocr`

3. Implement OCR in `server/services/pdfOCR.js`

### Option 3: Cloud OCR Services

**Options:**
- Google Cloud Vision API
- Azure Computer Vision
- AWS Textract

**Pros:**
- Very accurate
- Good handwriting recognition
- Managed service

**Cons:**
- Requires cloud account setup
- Additional costs
- More complex integration

## Implementation Steps

1. **Choose an OCR method** (recommend OpenAI Vision API)

2. **Install dependencies:**
   ```bash
   npm install pdf2pic
   # For Tesseract: npm install tesseract.js
   ```

3. **Update PDF extraction functions:**
   - Modify `extractTextFromPDF` in `server/routes/mark.js`
   - Modify `extractTextFromPDF` in `server/routes/rubric-generator.js`
   - Use the new `pdfOCR.js` service

4. **Add configuration:**
   ```env
   # .env file
   ENABLE_OCR=true
   USE_VISION_API=true
   ```

5. **Update extraction calls:**
   ```javascript
   const { extractTextFromPDF } = require('../services/pdfOCR');
   const text = await extractTextFromPDF(filePath, { 
     useVisionAPI: true 
   });
   ```

## Testing Handwritten Text

1. Upload a scanned PDF with handwritten content
2. The system should automatically detect if standard extraction fails
3. Fall back to OCR/Vision API if enabled
4. Process the extracted text normally

## Cost Considerations

**OpenAI Vision API:**
- ~$0.01-0.03 per image (depends on resolution)
- GPT-4o is more cost-effective than GPT-4 Vision

**Tesseract.js:**
- Free (local processing)
- Uses system resources

## Recommendations

For best results with handwritten text:
1. **Use OpenAI Vision API** (GPT-4o) - Best accuracy
2. **Process each page separately** - Better results than multi-page images
3. **Add error handling** - Fallback to manual marking if OCR fails
4. **Consider batch processing** - For multiple handwritten submissions

## Next Steps

1. Review `server/services/pdfOCR.js` (already created)
2. Install `pdf2pic` package
3. Update extraction functions to use the new service
4. Test with handwritten PDF samples
5. Add user option to enable/disable OCR









