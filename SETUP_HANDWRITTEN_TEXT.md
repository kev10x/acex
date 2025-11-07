# Handwritten Text Support Setup

## ✅ Implementation Complete

Handwritten text support has been implemented using OpenAI Vision API (GPT-4o). The system will now automatically detect when standard text extraction fails and fall back to Vision API for handwritten/scanned documents.

## How It Works

1. **Standard Extraction First**: Tries to extract text using `pdf-parse` (fast, free)
2. **Automatic Fallback**: If standard extraction returns insufficient text (< 50 characters), automatically uses Vision API
3. **Multi-page Support**: Processes all pages (up to 10 pages for cost control)
4. **Handwritten Text**: Vision API can read both typed and handwritten text

## Installation

The required package has been added to `package.json`:

```bash
npm install
```

This will install:
- `pdf2pic` - Converts PDF pages to images for Vision API processing

## Configuration

### Environment Variables

Add to your `.env` file (optional):

```env
# Enable/disable Vision API (default: enabled)
ENABLE_VISION_API=true

# OpenAI API Key (required if using Vision API)
OPENAI_API_KEY=your_api_key_here
```

**Note**: If `ENABLE_VISION_API` is set to `false`, the system will only use standard extraction and won't attempt OCR for handwritten text.

## Usage

No changes needed! The system automatically:

1. ✅ Tries standard extraction first
2. ✅ Falls back to Vision API if needed
3. ✅ Works for both typed and handwritten PDFs

## Cost Information

**OpenAI Vision API (GPT-4o):**
- Approximately $0.01-0.03 per page
- Cost depends on image resolution
- Only charged when standard extraction fails

**Example costs:**
- 1-page handwritten assignment: ~$0.02
- 5-page handwritten exam: ~$0.10
- 10-page handwritten treatise: ~$0.20

## Testing

To test handwritten text support:

1. Upload a scanned PDF or handwritten document
2. The system will automatically:
   - Try standard extraction first
   - If that fails, use Vision API
   - Extract all text including handwritten content

## Limitations

- **Cost**: Vision API charges per page processed
- **Page Limit**: Currently limited to 10 pages per document (can be adjusted)
- **Speed**: Vision API extraction is slower than standard extraction (a few seconds per page)
- **Quality**: Handwriting recognition quality depends on:
  - Image quality/resolution
  - Handwriting clarity
  - Document scan quality

## Troubleshooting

### Vision API not working?

1. Check your OpenAI API key is set in `.env`
2. Verify `ENABLE_VISION_API` is not set to `false`
3. Check console logs for error messages
4. Ensure you have sufficient OpenAI API credits

### pdf2pic installation issues?

On Windows, `pdf2pic` requires GraphicsMagick or ImageMagick:

```bash
# Install ImageMagick (recommended)
# Download from: https://imagemagick.org/script/download.php
# Or use chocolatey:
choco install imagemagick
```

On macOS:
```bash
brew install imagemagick
```

On Linux:
```bash
sudo apt-get install imagemagick
```

## What's Supported Now

✅ **Typed text in PDFs** - Standard extraction  
✅ **Handwritten text** - Vision API extraction  
✅ **Scanned PDFs** - Vision API extraction  
✅ **Mixed documents** - Automatic detection and fallback  
✅ **Multi-page documents** - Processes all pages (up to 10)

## Next Steps

The system is ready to use! Just install dependencies and upload a handwritten PDF to test.





