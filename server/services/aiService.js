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
    
    // Request throttling: Track last request time per provider
    // Add minimum delay between requests to avoid rate limits
    this.lastRequestTime = {
      openai: 0,
      anthropic: 0
    };
    
    // Minimum delay between requests (in milliseconds)
    // OpenAI: ~60 requests/minute for GPT-4o = ~1 request/second
    // Anthropic: ~50 requests/minute = ~1.2 requests/second
    this.minRequestInterval = {
      openai: 1200,    // 1.2 seconds between requests (50 req/min)
      anthropic: 1500  // 1.5 seconds between requests (40 req/min)
    };
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
   * @param {number} params.seed - Seed for reproducibility (OpenAI only)
   * @returns {Promise<Object>} Completion result with standardized format
   */
  async createCompletion({ provider, model, messages, temperature, maxTokens, user = 'anonymous', seed = null }) {
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
  async _createOpenAICompletion({ model, messages, temperature, maxTokens, user, seed = null }) {
    if (!this.openai) {
      throw new Error('OpenAI client not initialized. Please set OPENAI_API_KEY environment variable.');
    }

    const completionParams = {
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      user
    };

    // Add seed for reproducibility (OpenAI GPT-4, GPT-5 and newer models support this)
    if (seed !== null && (model.includes('gpt-4') || model.includes('gpt-5') || model.includes('gpt-3.5'))) {
      completionParams.seed = seed;
    }

    const completion = await this.openai.chat.completions.create(completionParams);

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
   * Throttle requests to avoid rate limits
   * Ensures minimum time between requests per provider
   */
  async _throttleRequest(provider) {
    const providerKey = provider === 'openai' ? 'openai' : 'anthropic';
    const minInterval = this.minRequestInterval[providerKey] || 1000;
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime[providerKey];
    
    if (timeSinceLastRequest < minInterval) {
      const waitTime = minInterval - timeSinceLastRequest;
      console.log(`⏳ Throttling request: waiting ${(waitTime/1000).toFixed(1)}s to avoid rate limits...`);
      await new Promise(r => setTimeout(r, waitTime));
    }
    
    this.lastRequestTime[providerKey] = Date.now();
  }

  /**
   * Retry wrapper with exponential backoff for rate limits and overload errors
   * Improved rate limit handling with Retry-After header support
   */
  async createCompletionWithRetry(params, maxRetries = 5) {
    const selectedProvider = params.provider || aiConfig.defaultProvider;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Throttle requests to avoid hitting rate limits
        await this._throttleRequest(selectedProvider);
        
        return await this.createCompletion(params);
      } catch (err) {
        // Check if it's a rate limit error (429)
        const isRateLimit = err?.status === 429 || 
                           err?.statusCode === 429 ||
                           err?.code === 'rate_limit_exceeded' ||
                           err?.error?.code === 'rate_limit_exceeded' ||
                           err?.message?.toLowerCase().includes('rate_limit') ||
                           err?.message?.toLowerCase().includes('rate limit') ||
                           err?.message?.toLowerCase().includes('too many requests');
        
        // Check if it's an overload error (529)
        const isOverload = err?.status === 529 ||
                          err?.statusCode === 529 ||
                          err?.error?.type === 'overloaded_error' ||
                          err?.message?.toLowerCase().includes('overloaded');

        if ((isRateLimit || isOverload) && attempt < maxRetries) {
          // Check for Retry-After header (in seconds)
          let retryAfter = null;
          if (err?.response?.headers?.['retry-after']) {
            retryAfter = parseInt(err.response.headers['retry-after'], 10) * 1000; // Convert to ms
          } else if (err?.headers?.['retry-after']) {
            retryAfter = parseInt(err.headers['retry-after'], 10) * 1000;
          }
          
          // Calculate delay
          let delayMs;
          if (retryAfter && retryAfter > 0) {
            // Use Retry-After header if available (add small buffer)
            delayMs = retryAfter + 1000; // Add 1 second buffer
            console.warn(`⚠️  API rate limited. Server requested ${(retryAfter/1000).toFixed(1)}s wait. Waiting ${(delayMs/1000).toFixed(1)}s...`);
          } else {
            // Use exponential backoff with longer delays for rate limits
            const baseDelay = isOverload ? 10000 : 5000; // 10s for overload, 5s for rate limit (increased)
            delayMs = baseDelay * Math.pow(2, attempt); // Exponential backoff
            const maxDelay = isOverload ? 120000 : 60000; // Max 120s for overload, 60s for rate limit
            delayMs = Math.min(delayMs, maxDelay);
            
            const errorType = isOverload ? 'overloaded' : 'rate limited';
            console.warn(`⚠️  API ${errorType} (attempt ${attempt + 1}/${maxRetries}). Retrying in ${(delayMs/1000).toFixed(1)}s...`);
          }
          
          await new Promise(r => setTimeout(r, delayMs));
          continue;
        }
        
        // If we've exhausted retries for rate limit, throw a more helpful error
        if ((isRateLimit || isOverload) && attempt >= maxRetries) {
          const errorType = isOverload ? 'overloaded' : 'rate limited';
          throw new Error(
            `API ${errorType} after ${maxRetries} retries. ` +
            `Please wait a few minutes before trying again. ` +
            `If this persists, consider reducing the number of concurrent marking requests.`
          );
        }
        
        throw err;
      }
    }
  }
}

// Export singleton instance
module.exports = new AIService();


