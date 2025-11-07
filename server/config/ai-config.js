// AI Configuration for MarkMate
// This file contains settings for OpenAI API calls and document processing

module.exports = {
  // Document processing limits
  documentLimits: {
    // Maximum characters to process for different document types
    treatise: 200000,     // For Masters treatises (approximately 50,000 tokens) - increased for large documents
    assignment: 15000,     // For regular assignments (approximately 3,750 tokens)
    report: 25000,         // For research reports (approximately 6,250 tokens)
    question_paper: 30000, // For exam/test papers (approximately 7,500 tokens)
    memo: 50000,          // For memos/answer keys (approximately 12,500 tokens)
    default: 10000         // Default limit (approximately 2,500 tokens)
  },

  // OpenAI API settings
  openai: {
    models: {
      treatise: "gpt-4o",             // Better for large documents and complex JSON
      assignment: "gpt-4o-mini",      // Keep mini for smaller assignments
      question_paper: "gpt-4o",       // Need detailed marking for question papers
      memo: "gpt-4o",                 // Need detailed analysis for memo-based marking
      default: "gpt-4o-mini"
    },
    
    // Token limits for different document types
    maxTokens: {
      treatise: 12000,     // Detailed feedback for treatises (increased for large documents)
      assignment: 4000,    // Standard feedback for assignments
      report: 6000,        // Comprehensive feedback for reports
      question_paper: 8000, // Detailed marking for question papers
      memo: 6000,          // Feedback when using memo as rubric
      default: 3000        // Basic feedback
    },
    
    // Temperature settings for different evaluation types
    temperature: {
      treatise: 0.2,       // More focused for academic evaluation
      assignment: 0.3,      // Balanced creativity and consistency
      report: 0.25,         // Slightly more focused for reports
      question_paper: 0.1,  // Very focused for objective marking
      memo: 0.15,           // Focused for memo-based marking
      default: 0.3
    }
  },

  // Cost estimation (GPT-4o pricing as of 2024)
  pricing: {
    promptTokens: 0.005,      // $0.005 per 1K prompt tokens (GPT-4o)
    completionTokens: 0.015   // $0.015 per 1K completion tokens (GPT-4o)
  },

  // Get configuration for a specific document type
  getConfig: function(documentType = 'default') {
    return {
      maxTextLength: this.documentLimits[documentType] || this.documentLimits.default,
      model: this.openai.models[documentType] || this.openai.models.default,
      maxTokens: this.openai.maxTokens[documentType] || this.openai.maxTokens.default,
      temperature: this.openai.temperature[documentType] || this.openai.temperature.default
    };
  },

  // Estimate cost based on token usage
  estimateCost: function(promptTokens, completionTokens) {
    const promptCost = (promptTokens / 1000) * this.pricing.promptTokens;
    const completionCost = (completionTokens / 1000) * this.pricing.completionTokens;
    return promptCost + completionCost;
  }
};

