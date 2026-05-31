const { extractTextFromPDF: extractWithOCR, getPdfPageImages } = require('./documentExtractService');

const extractTextFromPDF = async (filePath) => {
  try {
    return await extractWithOCR(filePath, { useVisionAPI: true, useOCR: false });
  } catch (error) {
    console.error('❌ PDF text extraction error:', error);
    throw error;
  }
};

module.exports = { extractTextFromPDF, getPdfPageImages };
