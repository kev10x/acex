// AI Configuration for MarkMate
// This file contains settings for OpenAI and Anthropic API calls and document processing
//
// NOTE: MarkMate includes explicit instructions to counteract AI positive bias
// (the tendency of GenAI models to be overly positive/encouraging in assessments).
// See AI_POSITIVE_BIAS_MITIGATION.md for details on how realistic assessment is enforced.

module.exports = {
  // Default AI provider: 'openai' or 'anthropic'
  // Can be overridden via AI_PROVIDER environment variable
  defaultProvider: process.env.AI_PROVIDER || 'openai',

  // Document processing limits
  documentLimits: {
    // Maximum characters to process for different document types
    // Claude has much larger context windows, so we can process more
    treatise: 800000,     // For Masters treatises - increased for Claude's 200K token context
    assignment: 15000,     // For regular assignments (approximately 3,750 tokens)
    report: 25000,         // For research reports (approximately 6,250 tokens)
    question_paper: 30000, // For exam/test papers (approximately 7,500 tokens)
    memo: 50000,          // For memos/answer keys (approximately 12,500 tokens)
    default: 10000         // Default limit (approximately 2,500 tokens)
  },

  // OpenAI API settings (GPT-5.2 / GPT-5 mini; fallback to gpt-4o if your account lacks GPT-5)
  openai: {
    models: {
      treatise: "gpt-5.2",           // Flagship for large documents and complex JSON
      assignment: "gpt-5-mini",      // Faster, cost-efficient for smaller assignments
      question_paper: "gpt-5.2",     // Detailed marking for question papers
      memo: "gpt-5.2",               // Detailed analysis for memo-based marking
      default: "gpt-5-mini"
    },
    
    // Token limits for different document types
    // Allow enough output for full JSON (scores, feedback, corrections, language_errors)
    maxTokens: {
      treatise: 16000,     // Extensive detailed feedback for treatises
      assignment: 12000,   // Comprehensive feedback for assignments (increased to avoid truncation)
      report: 12000,       // Extensive feedback for reports
      question_paper: 14000, // Detailed marking with extensive feedback for question papers
      memo: 12000,         // Comprehensive feedback when using memo as rubric
      default: 10000       // Detailed feedback default
    },
    
    // Temperature settings for different evaluation types
    // Moderate temperatures allow variation while maintaining accuracy
    // Increased from very low (0.05-0.1) to moderate (0.3-0.4) to allow unique evaluation per submission
    temperature: {
      treatise: 0.4,       // Moderate for varied but accurate academic evaluation
      assignment: 0.3,      // Moderate for natural variation in marking
      report: 0.3,         // Moderate for varied report marking
      question_paper: 0.25, // Slightly lower for objective marking but still allows variation
      memo: 0.25,          // Slightly lower for memo-based marking but still allows variation
      default: 0.3         // Moderate default for natural variation
    }
  },

  // Anthropic (Claude) API settings
  // Note: If you get 404 errors, your API key may only have access to claude-3-haiku-20240307
  // To use Claude 3.5 Sonnet, you may need to upgrade your Anthropic account
  anthropic: {
    models: {
      treatise: "claude-3-haiku-20240307",  // Using Haiku (Sonnet requires account upgrade)
      assignment: "claude-3-haiku-20240307", // Using Haiku (Sonnet requires account upgrade)
      question_paper: "claude-3-haiku-20240307",
      memo: "claude-3-haiku-20240307",
      report: "claude-3-haiku-20240307",
      default: "claude-3-haiku-20240307"
    },
    
    // Max tokens for completion (Claude uses max_tokens instead of maxTokens)
    // Increased significantly to allow for extensive, detailed feedback
    maxTokens: {
      treatise: 16000,     // Extensive detailed feedback for treatises (increased for comprehensive feedback)
      assignment: 8000,    // Comprehensive feedback for assignments (doubled for detailed feedback)
      report: 10000,       // Extensive feedback for reports (increased for detailed feedback)
      question_paper: 12000, // Detailed marking with extensive feedback for question papers
      memo: 8000,          // Comprehensive feedback when using memo as rubric
      default: 6000        // Detailed feedback (doubled from basic)
    },
    
    // Temperature settings (same as OpenAI for consistency)
    // Moderate temperatures allow variation while maintaining accuracy
    // Increased from very low (0.05-0.1) to moderate (0.3-0.4) to allow unique evaluation per submission
    temperature: {
      treatise: 0.4,       // Moderate for varied but accurate academic evaluation
      assignment: 0.3,      // Moderate for natural variation in marking
      report: 0.3,         // Moderate for varied report marking
      question_paper: 0.25, // Slightly lower for objective marking but still allows variation
      memo: 0.25,          // Slightly lower for memo-based marking but still allows variation
      default: 0.3         // Moderate default for natural variation
    }
  },

  // Cost estimation (pricing as of 2025; GPT-5.2 is higher than GPT-4o)
  pricing: {
    openai: {
      promptTokens: 0.00175,   // $1.75 per 1M input (GPT-5.2)
      completionTokens: 0.014  // $14 per 1M output (GPT-5.2)
    },
    anthropic: {
      promptTokens: 0.003,      // $0.003 per 1K prompt tokens (Claude 3.5 Sonnet)
      completionTokens: 0.015    // $0.015 per 1K completion tokens (Claude 3.5 Sonnet)
    }
  },

  // Get configuration for a specific document type and provider
  getConfig: function(documentType = 'default', provider = null) {
    const selectedProvider = provider || this.defaultProvider;
    const providerConfig = this[selectedProvider];
    
    if (!providerConfig) {
      throw new Error(`Invalid provider: ${selectedProvider}. Must be 'openai' or 'anthropic'`);
    }

    return {
      provider: selectedProvider,
      maxTextLength: this.documentLimits[documentType] || this.documentLimits.default,
      model: providerConfig.models[documentType] || providerConfig.models.default,
      maxTokens: providerConfig.maxTokens[documentType] || providerConfig.maxTokens.default,
      temperature: providerConfig.temperature[documentType] || providerConfig.temperature.default
    };
  },

  // Estimate cost based on token usage and provider
  estimateCost: function(promptTokens, completionTokens, provider = null) {
    const selectedProvider = provider || this.defaultProvider;
    const pricing = this.pricing[selectedProvider];
    
    if (!pricing) {
      console.warn(`No pricing info for provider ${selectedProvider}, using OpenAI pricing`);
      const defaultPricing = this.pricing.openai;
      const promptCost = (promptTokens / 1000) * defaultPricing.promptTokens;
      const completionCost = (completionTokens / 1000) * defaultPricing.completionTokens;
      return promptCost + completionCost;
    }
    
    const promptCost = (promptTokens / 1000) * pricing.promptTokens;
    const completionCost = (completionTokens / 1000) * pricing.completionTokens;
    return promptCost + completionCost;
  }
};

