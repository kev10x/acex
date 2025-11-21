# Claude Integration for MarkMate

MarkMate now supports both **OpenAI (GPT)** and **Anthropic (Claude)** for academic content analysis. You can choose which provider to use based on your needs.

## Why Claude for Academic Content?

Claude 3.5 Sonnet offers several advantages for academic analysis:

1. **Larger Context Window**: 200K tokens (vs GPT-4o's 128K) - can process full treatises/theses without truncation
2. **Better Academic Reasoning**: Stronger at nuanced analysis, critical evaluation, and maintaining consistency
3. **More Consistent Evaluation**: Better at maintaining consistent standards across long documents
4. **Better Instruction Following**: More reliable at following complex rubric instructions

## Setup

### 1. Install Dependencies

The Anthropic SDK has already been installed. If you need to reinstall:

```bash
npm install @anthropic-ai/sdk
```

### 2. Configure Environment Variables

Add to your `.env` file:

```env
# AI Provider Configuration
# Set to 'openai' or 'anthropic' (default: 'openai')
AI_PROVIDER=anthropic

# Anthropic (Claude) API Configuration
# Get your API key from https://console.anthropic.com/
ANTHROPIC_API_KEY=your_anthropic_api_key_here
```

### 3. Get Your Anthropic API Key

1. Sign up at https://console.anthropic.com/
2. Create an API key
3. Add it to your `.env` file

## Usage

### Option 1: Set Default Provider (Recommended)

Set `AI_PROVIDER=anthropic` in your `.env` file. All marking operations will use Claude by default.

### Option 2: Specify Provider Per Request

You can specify the provider in API requests:

```javascript
// Single assignment marking
POST /api/mark/single
{
  "assignment_id": 123,
  "rubric_id": 456,
  "provider": "anthropic"  // or "openai"
}

// Multiple assignments
POST /api/mark/multiple
{
  "assignment_ids": [123, 124, 125],
  "rubric_id": 456,
  "provider": "anthropic"  // or "openai"
}
```

### Option 3: Use Environment Variable

The system will use the provider specified in `AI_PROVIDER` environment variable if not specified in the request.

## Configuration

The AI configuration is in `server/config/ai-config.js`. Key settings:

### Document Limits

- **Treatise**: 800,000 characters (Claude can handle much more than GPT)
- **Assignment**: 15,000 characters
- **Report**: 25,000 characters
- **Question Paper**: 30,000 characters
- **Memo**: 50,000 characters

### Models Used

- **Claude**: `claude-3-5-sonnet-20240620` (for all document types)
- **OpenAI**: 
  - `gpt-4o` (for treatises, question papers, memos)
  - `gpt-4o-mini` (for assignments)

### Token Limits

Claude has higher token limits:
- **Treatise**: 16,000 tokens (vs 12,000 for GPT)
- **Question Paper**: 10,000 tokens (vs 8,000 for GPT)
- **Report**: 8,000 tokens (vs 6,000 for GPT)

## Cost Comparison

### Claude 3.5 Sonnet Pricing
- Input: $0.003 per 1K tokens
- Output: $0.015 per 1K tokens

### GPT-4o Pricing
- Input: $0.005 per 1K tokens
- Output: $0.015 per 1K tokens

**Note**: Claude is cheaper for input tokens, making it more cost-effective for large documents.

## Features

### Automatic Provider Selection

The system automatically:
- Uses the provider from `AI_PROVIDER` env var if not specified
- Falls back to OpenAI if Anthropic is not configured
- Handles rate limits with exponential backoff for both providers

### Unified API

Both providers use the same interface:
- Same request format
- Same response format
- Automatic retry logic
- Cost estimation

## Troubleshooting

### "Anthropic client not initialized"

Make sure you've set `ANTHROPIC_API_KEY` in your `.env` file.

### Rate Limits

Both providers have rate limits. The system automatically retries with exponential backoff. If you hit persistent rate limits:
- For OpenAI: Check your organization's TPM limits
- For Anthropic: Check your account's rate limits at https://console.anthropic.com/

### Provider Not Working

The system will fall back to the default provider (OpenAI) if:
- The specified provider's API key is missing
- The provider encounters an error
- The provider is not available

## Best Practices

1. **For Large Documents (Treatises/Theses)**: Use Claude for better context handling
2. **For Small Assignments**: Either provider works well
3. **For Cost Optimization**: Use Claude for large documents (cheaper input tokens)
4. **For Speed**: GPT-4o-mini is faster for small documents

## Migration Notes

- Existing code continues to work - defaults to OpenAI if not specified
- No breaking changes to API endpoints
- Provider selection is backward compatible


