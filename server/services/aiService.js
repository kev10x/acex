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

    // Initialize xAI client (OpenAI-compatible base URL)
    if (process.env.XAI_API_KEY) {
      this.xai = new OpenAI({
        apiKey: process.env.XAI_API_KEY,
        baseURL: 'https://api.x.ai/v1'
      });
    } else {
      console.warn('⚠️  XAI_API_KEY not found. Grok image/TTS features will not be available.');
    }

    // Initialize Anthropic client
    if (process.env.ANTHROPIC_API_KEY) {
      this.anthropic = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY
      });
    } else {
      console.warn('⚠️  ANTHROPIC_API_KEY not found. Anthropic provider will not be available.');
    }

    // Initialize Ollama client (OpenAI-compatible local API)
    const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1';
    this.ollama = new OpenAI({
      apiKey: 'ollama',
      baseURL: ollamaBaseUrl
    });
    console.log(`🦙 Ollama client initialised at ${ollamaBaseUrl}`);

    // Request throttling: Track last request time per provider
    // Add minimum delay between requests to avoid rate limits
    this.lastRequestTime = {
      openai: 0,
      anthropic: 0,
      ollama: 0
    };

    // Minimum delay between requests (in milliseconds)
    // OpenAI: ~60 requests/minute for GPT-4o = ~1 request/second
    // Anthropic: ~50 requests/minute = ~1.2 requests/second
    // Ollama: local, no rate limits
    this.minRequestInterval = {
      openai: 1200,    // 1.2 seconds between requests (50 req/min)
      anthropic: 1500, // 1.5 seconds between requests (40 req/min)
      ollama: 0        // No throttling for local inference
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
  async createCompletion({ provider, model, messages, temperature, maxTokens, user = 'anonymous', seed = null, functions = null, function_call = null, response_format = null }) {
    const selectedProvider = provider || aiConfig.defaultProvider;

    if (selectedProvider === 'openai') {
      return await this._createOpenAICompletion({ model, messages, temperature, maxTokens, user, functions, function_call, response_format });
    } else if (selectedProvider === 'anthropic') {
      return await this._createAnthropicCompletion({ model, messages, temperature, maxTokens });
    } else if (selectedProvider === 'ollama') {
      return await this._createOllamaCompletion({ model, messages, temperature, maxTokens, response_format });
    } else {
      throw new Error(`Unsupported provider: ${selectedProvider}. Must be 'openai', 'anthropic', or 'ollama'`);
    }
  }

  /**
   * Create completion using OpenAI
   */
  async _createOpenAICompletion({ model, messages, temperature, maxTokens, user, seed = null, functions = null, function_call = null, response_format = null }) {
    if (!this.openai) {
      throw new Error('OpenAI client not initialized. Please set OPENAI_API_KEY environment variable.');
    }

    // Some models (e.g. GPT-5.x) only support temperature = 1; omit or use 1 to avoid API error
    const safeTemperature = /gpt-5/i.test(model) ? 1 : temperature;

    const completionParams = {
      model,
      messages,
      temperature: safeTemperature,
      max_completion_tokens: maxTokens,
      user
    };

    // Forward function-calling params if provided
    if (functions) completionParams.functions = functions;
    if (function_call) completionParams.function_call = function_call;
    if (response_format) completionParams.response_format = response_format;

    // Add seed for reproducibility (OpenAI GPT-4, GPT-5 and newer models support this)
    if (seed !== null && (model.includes('gpt-4') || model.includes('gpt-5') || model.includes('gpt-3.5'))) {
      completionParams.seed = seed;
    }

    const completion = await this.openai.chat.completions.create(completionParams);

    // If the model used function calling, extract the function_call.arguments as the response
    const choiceMessage = completion.choices[0]?.message || {};
    let content = '';
    if (choiceMessage.function_call && choiceMessage.function_call.arguments) {
      const decodeResult = this.decodeFunctionCallArguments(choiceMessage.function_call.arguments);
      content = decodeResult.content;
    } else {
      const rawContent = choiceMessage.content;
      // OpenAI can return content as string or as array of parts
      if (Array.isArray(rawContent)) {
        content = rawContent
          .filter(part => part && part.type === 'text' && part.text != null)
          .map(part => part.text)
          .join('');
      } else if (rawContent != null && typeof rawContent !== 'string') {
        content = String(rawContent);
      } else {
        content = rawContent || '';
      }
    }
    if (!content && completion.choices[0]) {
      const finishReason = completion.choices[0].finish_reason;
      console.warn('OpenAI returned empty content. finish_reason:', finishReason, 'usage:', completion.usage);
    }

    // Standardize the response format
    return {
      content: content ?? '',
      usage: {
        prompt_tokens: completion.usage?.prompt_tokens,
        completion_tokens: completion.usage?.completion_tokens,
        total_tokens: completion.usage?.total_tokens,
        reasoning_tokens: completion.usage?.reasoning_tokens,
        prompt_tokens_details: completion.usage?.prompt_tokens_details,
        completion_tokens_details: completion.usage?.completion_tokens_details
      },
      choices: completion.choices,
      provider: 'openai'
    };
  }

  // Decode function_call.arguments payloads with support for base64-encoded JSON
  decodeFunctionCallArguments(args) {
    try {
      const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args;

      // If the model provided a base64 payload, decode and parse it
      if (parsedArgs && typeof parsedArgs.payload_b64 === 'string') {
        try {
          const buf = Buffer.from(parsedArgs.payload_b64, 'base64');
          const decoded = buf.toString('utf8');
          const parsed = JSON.parse(decoded);
          const valid = this.validateMarkingSchema(parsed);
          if (!valid) {
            console.warn('Decoded payload did not match expected marking schema');
          }
          return { content: JSON.stringify(parsed), parsed };
        } catch (err) {
          console.warn('Failed to decode/parse payload_b64:', err.message);
          return { content: String(args), parsed: null };
        }
      }

      // If arguments are already the object we expect, stringify after validation
      if (parsedArgs && typeof parsedArgs === 'object') {
        const valid = this.validateMarkingSchema(parsedArgs);
        if (!valid) {
          console.warn('Function arguments object did not match expected marking schema');
        }
        return { content: JSON.stringify(parsedArgs), parsed: parsedArgs };
      }

      return { content: String(args), parsed: null };
    } catch (e) {
      return { content: String(args), parsed: null };
    }
  }

  // Basic validator for the marking result schema to catch obvious issues early
  validateMarkingSchema(obj) {
    if (!obj || typeof obj !== 'object') return false;
    if (!Array.isArray(obj.scores)) return false;
    if (typeof obj.overall_feedback !== 'string') return false;
    if (typeof obj.total_score !== 'number') return false;
    return true;
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
          // Handle content as string or array (for vision)
          let content = m.content;
          if (typeof content === 'string') {
            content = [{ type: 'text', text: content }];
          } else if (Array.isArray(content)) {
            // Convert OpenAI vision format to Anthropic
            content = content.map(part => {
              if (part.type === 'text') {
                return { type: 'text', text: part.text };
              } else if (part.type === 'image_url') {
                const url = part.image_url.url;
                if (url.startsWith('data:image/')) {
                  const [mime, base64] = url.split(',');
                  return {
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: mime.split(':')[1].split(';')[0],
                      data: base64
                    }
                  };
                }
              }
              return { type: 'text', text: JSON.stringify(part) };
            });
          }
          return { role: 'user', content };
        } else if (m.role === 'assistant') {
          return { role: 'assistant', content: m.content };
        }
        // Convert other roles to user
        return { role: 'user', content: [{ type: 'text', text: m.content }] };
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
   * Create completion using Ollama (local LLM, OpenAI-compatible API)
   */
  async _createOllamaCompletion({ model, messages, temperature, maxTokens, response_format }) {
    const params = {
      model,
      messages,
      temperature,
      max_tokens: maxTokens
    };

    // Ollama supports json_object mode but not the full json_schema strict mode
    if (response_format?.type === 'json_schema' || response_format?.type === 'json_object') {
      params.response_format = { type: 'json_object' };
    }

    const completion = await this.ollama.chat.completions.create(params);
    const content = completion.choices[0]?.message?.content || '';

    if (!content) {
      const finishReason = completion.choices[0]?.finish_reason;
      console.warn('Ollama returned empty content. finish_reason:', finishReason);
    }

    return {
      content,
      usage: {
        prompt_tokens: completion.usage?.prompt_tokens,
        completion_tokens: completion.usage?.completion_tokens,
        total_tokens: completion.usage?.total_tokens
      },
      provider: 'ollama'
    };
  }

  /**
   * Throttle requests to avoid rate limits
   * Ensures minimum time between requests per provider
   */
  async _throttleRequest(provider) {
    const providerKey = provider === 'openai' ? 'openai' : (provider === 'ollama' ? 'ollama' : 'anthropic');
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

