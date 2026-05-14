// AI Configuration for MarkMate
// This file contains settings for OpenAI and Anthropic API calls and document processing
//
// NOTE: MarkMate includes explicit instructions to counteract AI positive bias
// (the tendency of GenAI models to be overly positive/encouraging in assessments).
// See AI_POSITIVE_BIAS_MITIGATION.md for details on how realistic assessment is enforced.

const envInt = (name, fallback) => {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

module.exports = {
  // Default AI provider: 'openai' or 'anthropic'
  // Can be overridden via AI_PROVIDER environment variable
  defaultProvider: process.env.AI_PROVIDER || 'openai',

  // Document processing limits
  documentLimits: {
    // Maximum characters to process for different document types
    // These are prompt-processing caps, not PDF extraction caps. Extracted text is stored in full.
    treatise: envInt('MARKING_TREATISE_MAX_CHARS', 800000),
    assignment: envInt('MARKING_ASSIGNMENT_MAX_CHARS', 60000),
    report: envInt('MARKING_REPORT_MAX_CHARS', 60000),
    question_paper: envInt('MARKING_QUESTION_PAPER_MAX_CHARS', 60000),
    memo: envInt('MARKING_MEMO_MAX_CHARS', 80000),
    default: envInt('MARKING_DEFAULT_MAX_CHARS', 60000)
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
      treatise: 32000,
      assignment: 32000,
      report: 32000,
      question_paper: 32000,
      memo: 32000,
      default: 32000
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
      treatise: 16000,
      assignment: 16000,
      report: 16000,
      question_paper: 16000,
      memo: 16000,
      default: 16000
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

  // Task-specific overrides so lightweight extraction/classification work
  // does not accidentally inherit large marking budgets.
  taskProfiles: {
    classification: {
      openai: { model: 'gpt-5-mini', maxTokens: 220, temperature: 0.1 },
      anthropic: { model: 'claude-3-haiku-20240307', maxTokens: 220, temperature: 0.1 }
    },
    structuredExtraction: {
      openai: { model: 'gpt-5-mini', maxTokens: 8000, temperature: 0.2 },
      anthropic: { model: 'claude-3-haiku-20240307', maxTokens: 4096, temperature: 0.2 }
    },
    assessmentGeneration: {
      openai: { model: 'gpt-5-mini', maxTokens: 32000, temperature: 0.6},
      anthropic: { model: 'claude-3-haiku-20240307', maxTokens: 4096, temperature: 0.6}
    },
    contentGeneration: {
      openai: { model: 'gpt-5-mini', maxTokens: 32000, temperature: 0.55 },
      anthropic: { model: 'claude-3-haiku-20240307', maxTokens: 4096, temperature: 0.55 }
    },
    practicalGeneration: {
      openai: { model: 'gpt-5-mini', maxTokens: 24000, temperature: 0.45},
      anthropic: { model: 'claude-3-haiku-20240307', maxTokens: 4096, temperature: 0.45}
    },
    anchorExtraction: {
      openai: { model: 'gpt-4o-mini', maxTokens: 250, temperature: 0.1 },
      anthropic: { model: 'claude-3-haiku-20240307', maxTokens: 250, temperature: 0.1 }
    },
    visionOCR: {
      openai: { model: 'gpt-4o-mini', maxTokens: 4000, temperature: 0.2 }
    },
    visionMCQ: {
      openai: { model: 'gpt-4o-mini', maxTokens: 350, temperature: 0.1 }
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

  getTaskConfig: function(taskName, provider = null) {
    const selectedProvider = provider || this.defaultProvider;
    const profile = this.taskProfiles[taskName];
    if (!profile) {
      throw new Error(`Unknown AI task profile: ${taskName}`);
    }

    const providerProfile = profile[selectedProvider] || profile.openai || profile.anthropic;
    if (!providerProfile) {
      throw new Error(`No AI task profile for task ${taskName} and provider ${selectedProvider}`);
    }

    return {
      provider: selectedProvider,
      model: providerProfile.model,
      maxTokens: providerProfile.maxTokens,
      temperature: providerProfile.temperature
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
