// Unified AI Service for MarkMate
// Supports both OpenAI and Anthropic (Claude) APIs

// Ensure environment variables are loaded
require('dotenv').config();

const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const aiConfig = require('../config/ai-config');

class AIService {
  constructor() {
    // Initialize OpenAI client
    if (process.env.OPENAI_API_KEY) {
      this.openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
      });
    } else {
      console.warn('⚠️  OPENAI_API_KEY not found. OpenAI provider will not be available.');
    }

    // Initialize Anthropic client
    if (process.env.ANTHROPIC_API_KEY) {
      this.anthropic = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY
      });
    } else {
      console.warn('⚠️  ANTHROPIC_API_KEY not found. Anthropic provider will not be available.');
    }
  }

  /**
   * Generate a chat completion using the specified provider
   * @param {Object} params - Parameters for the completion
   * @param {string} params.provider - 'openai' or 'anthropic'
   * @param {string} params.model - Model name
   * @param {Array} params.messages - Array of message objects
   * @param {number} params.temperature - Temperature setting
   * @param {number} params.maxTokens - Maximum tokens for completion
   * @param {string} params.user - User identifier (for OpenAI)
   * @returns {Promise<Object>} Completion result with standardized format
   */
  async createCompletion({ provider, model, messages, temperature, maxTokens, user = 'anonymous' }) {
    const selectedProvider = provider || aiConfig.defaultProvider;

    if (selectedProvider === 'openai') {
      return await this._createOpenAICompletion({ model, messages, temperature, maxTokens, user });
    } else if (selectedProvider === 'anthropic') {
      return await this._createAnthropicCompletion({ model, messages, temperature, maxTokens });
    } else {
      throw new Error(`Unsupported provider: ${selectedProvider}. Must be 'openai' or 'anthropic'`);
    }
  }

  /**
   * Create completion using OpenAI
   */
  async _createOpenAICompletion({ model, messages, temperature, maxTokens, user }) {
    if (!this.openai) {
      throw new Error('OpenAI client not initialized. Please set OPENAI_API_KEY environment variable.');
    }

    const completion = await this.openai.chat.completions.create({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      user
    });

    // Standardize the response format
    return {
      content: completion.choices[0].message.content,
      usage: {
        prompt_tokens: completion.usage.prompt_tokens,
        completion_tokens: completion.usage.completion_tokens,
        total_tokens: completion.usage.total_tokens
      },
      provider: 'openai'
    };
  }

  /**
   * Create completion using Anthropic (Claude)
   */
  async _createAnthropicCompletion({ model, messages, temperature, maxTokens }) {
    if (!this.anthropic) {
      throw new Error('Anthropic client not initialized. Please set ANTHROPIC_API_KEY environment variable.');
    }

    // Convert OpenAI message format to Anthropic format
    // Anthropic uses a different message structure
    const systemMessage = messages.find(m => m.role === 'system');
    const conversationMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => {
        // Anthropic uses 'user' and 'assistant' roles
        if (m.role === 'user') {
          return { role: 'user', content: m.content };
        } else if (m.role === 'assistant') {
          return { role: 'assistant', content: m.content };
        }
        // Convert other roles to user
        return { role: 'user', content: m.content };
      });

    const message = await this.anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      temperature,
      system: systemMessage ? systemMessage.content : undefined,
      messages: conversationMessages
    });

    // Extract text content from Anthropic's response
    // Anthropic returns content as an array of text blocks
    const content = message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');

    // Standardize the response format
    return {
      content,
      usage: {
        prompt_tokens: message.usage.input_tokens,
        completion_tokens: message.usage.output_tokens,
        total_tokens: message.usage.input_tokens + message.usage.output_tokens
      },
      provider: 'anthropic'
    };
  }

  /**
   * Retry wrapper with exponential backoff for rate limits and overload errors
   */
  async createCompletionWithRetry(params, maxRetries = 5) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.createCompletion(params);
      } catch (err) {
        // Check if it's a rate limit error (429)
        const isRateLimit = err?.status === 429 || 
                           err?.statusCode === 429 ||
                           err?.message?.includes('rate_limit') ||
                           err?.message?.includes('rate limit');
        
        // Check if it's an overload error (529)
        const isOverload = err?.status === 529 ||
                          err?.statusCode === 529 ||
                          err?.error?.type === 'overloaded_error' ||
                          err?.message?.includes('overloaded') ||
                          err?.message?.includes('Overloaded');

        if ((isRateLimit || isOverload) && attempt < maxRetries) {
          // Use longer delays for overload errors
          const baseDelay = isOverload ? 5000 : 1000; // 5s for overload, 1s for rate limit
          const delayMs = baseDelay * Math.pow(2, attempt); // Exponential backoff
          const maxDelay = isOverload ? 60000 : 30000; // Max 60s for overload, 30s for rate limit
          const finalDelay = Math.min(delayMs, maxDelay);
          
          const errorType = isOverload ? 'overloaded' : 'rate limited';
          console.warn(`⚠️  API ${errorType} (attempt ${attempt + 1}/${maxRetries}). Retrying in ${(finalDelay/1000).toFixed(1)}s...`);
          await new Promise(r => setTimeout(r, finalDelay));
          continue;
        }
        throw err;
      }
    }
  }
}

// Export singleton instance
module.exports = new AIService();


