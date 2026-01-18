#!/usr/bin/env node

/**
 * Model Training Script
 * 
 * This script helps you train a custom model on your marking data.
 * Supports multiple approaches:
 * 1. OpenAI Fine-tuning
 * 2. Anthropic Fine-tuning
 * 3. Local model training (using transformers.js or similar)
 * 
 * Usage:
 *   node scripts/train-model.js --format openai --file training_data_openai_2024-01-01.jsonl
 *   node scripts/train-model.js --format anthropic --file training_data_anthropic_2024-01-01.jsonl
 */

const fs = require('fs').promises;
const path = require('path');
const { execSync } = require('child_process');

// Parse command line arguments
const args = process.argv.slice(2);
const getArg = (flag) => {
  const index = args.indexOf(flag);
  return index !== -1 && args[index + 1] ? args[index + 1] : null;
};

const format = getArg('--format') || 'openai';
const file = getArg('--file');
const apiKey = getArg('--api-key') || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;
const model = getArg('--model') || (format === 'openai' ? 'gpt-3.5-turbo' : 'claude-3-haiku-20240307');
const suffix = getArg('--suffix') || 'markmate-trained';

async function main() {
  console.log('🚀 Model Training Script\n');

  if (!file) {
    console.error('❌ Error: --file argument is required');
    console.log('\nUsage:');
    console.log('  node scripts/train-model.js --format openai --file training_data_openai_2024-01-01.jsonl');
    console.log('  node scripts/train-model.js --format anthropic --file training_data_anthropic_2024-01-01.jsonl');
    console.log('\nOptions:');
    console.log('  --format <openai|anthropic>  Training format (default: openai)');
    console.log('  --file <filename>            Training data file (required)');
    console.log('  --api-key <key>             API key (or set OPENAI_API_KEY/ANTHROPIC_API_KEY)');
    console.log('  --model <model-name>        Base model to fine-tune');
    console.log('  --suffix <suffix>           Suffix for fine-tuned model name');
    process.exit(1);
  }

  const trainingDataDir = path.join(__dirname, '../training_data');
  const filePath = path.join(trainingDataDir, file);

  // Check if file exists
  try {
    await fs.access(filePath);
  } catch {
    console.error(`❌ Error: File not found: ${filePath}`);
    process.exit(1);
  }

  // Check file format
  const stats = await fs.stat(filePath);
  console.log(`📄 Training file: ${file}`);
  console.log(`   Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

  // Validate JSONL format
  if (file.endsWith('.jsonl')) {
    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.trim().split('\n').filter(line => line.trim());
    console.log(`   Examples: ${lines.length}`);

    // Validate each line is valid JSON
    let validLines = 0;
    for (const line of lines) {
      try {
        JSON.parse(line);
        validLines++;
      } catch (e) {
        console.error(`⚠️  Invalid JSON on line ${validLines + 1}`);
      }
    }

    if (validLines !== lines.length) {
      console.error(`❌ Error: ${lines.length - validLines} invalid lines found`);
      process.exit(1);
    }
  }

  console.log(`\n📋 Training Configuration:`);
  console.log(`   Format: ${format}`);
  console.log(`   Base Model: ${model}`);
  console.log(`   Suffix: ${suffix}`);

  if (!apiKey) {
    console.error('\n❌ Error: API key not provided');
    console.log('   Set OPENAI_API_KEY or ANTHROPIC_API_KEY environment variable, or use --api-key');
    process.exit(1);
  }

  console.log('\n🔧 Training Approach:\n');

  if (format === 'openai') {
    await trainOpenAI(filePath, model, suffix, apiKey);
  } else if (format === 'anthropic') {
    await trainAnthropic(filePath, model, suffix, apiKey);
  } else {
    console.error(`❌ Error: Unknown format: ${format}`);
    console.log('   Supported formats: openai, anthropic');
    process.exit(1);
  }
}

async function trainOpenAI(filePath, model, suffix, apiKey) {
  console.log('📤 OpenAI Fine-tuning Process:\n');
  console.log('Step 1: Upload training file to OpenAI...');
  console.log('   (This requires the OpenAI CLI or API)');
  console.log('\n   Using OpenAI CLI:');
  console.log(`   export OPENAI_API_KEY=${apiKey}`);
  console.log(`   openai api fine_tunes.create -t ${filePath} -m ${model} --suffix ${suffix}`);
  console.log('\n   Or using Python SDK:');
  console.log('   ```python');
  console.log('   import openai');
  console.log(`   openai.api_key = "${apiKey}"`);
  console.log(`   training_file = openai.File.create(file=open("${filePath}", "rb"), purpose="fine-tune")`);
  console.log(`   fine_tune = openai.FineTune.create(training_file=training_file.id, model="${model}", suffix="${suffix}")`);
  console.log(`   print(f"Fine-tune job ID: {fine_tune.id}")`);
  console.log('   ```');
  console.log('\n   Monitor progress:');
  console.log('   ```python');
  console.log('   import openai');
  console.log('   status = openai.FineTune.retrieve(fine_tune.id)');
  console.log('   print(status)');
  console.log('   ```');
  console.log('\n📚 Documentation: https://platform.openai.com/docs/guides/fine-tuning');
}

async function trainAnthropic(filePath, model, suffix, apiKey) {
  console.log('📤 Anthropic Fine-tuning Process:\n');
  console.log('Note: Anthropic fine-tuning is currently in limited beta.');
  console.log('Contact Anthropic for access to fine-tuning capabilities.');
  console.log('\n   Using Anthropic API (when available):');
  console.log('   ```python');
  console.log('   import anthropic');
  console.log(`   client = anthropic.Anthropic(api_key="${apiKey}")`);
  console.log(`   # Upload training file and create fine-tuning job`);
  console.log(`   # (API endpoints may vary - check Anthropic documentation)`);
  console.log('   ```');
  console.log('\n📚 Documentation: https://docs.anthropic.com/');
}

// Alternative: Local training approach (using transformers.js or similar)
async function trainLocal(filePath) {
  console.log('📤 Local Model Training:\n');
  console.log('This approach trains a smaller model locally using your data.');
  console.log('Requires: Node.js with transformers.js or Python with transformers');
  console.log('\n   Example with transformers.js:');
  console.log('   ```javascript');
  console.log('   import { pipeline } from "@xenova/transformers";');
  console.log('   // Load a base model and fine-tune on your data');
  console.log('   ```');
  console.log('\n   Example with Python transformers:');
  console.log('   ```python');
  console.log('   from transformers import AutoModelForSequenceClassification, Trainer, TrainingArguments');
  console.log('   # Load model and train on your data');
  console.log('   ```');
}

if (require.main === module) {
  main().catch(error => {
    console.error('❌ Error:', error);
    process.exit(1);
  });
}

module.exports = { trainOpenAI, trainAnthropic, trainLocal };





