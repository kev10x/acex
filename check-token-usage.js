const { query } = require('./server/database/connection');
const OpenAI = require('openai');
require('dotenv').config();

async function checkTokenUsage() {
  try {
    console.log('🔍 Checking token usage for AI marking...');
    
    // Get assignment and rubric data
    const assignmentResult = await query('SELECT * FROM assignments WHERE id = ?', [14]);
    const rubricResult = await query('SELECT * FROM rubrics WHERE id = ?', [3]);
    
    const assignment = assignmentResult.rows[0];
    const rubric = rubricResult.rows[0];
    
    // Convert rubric to simple format
    const simpleCriteria = rubric.criteria.map(criterion => ({
      name: criterion.name,
      max_points: criterion.maxPoints,
      description: criterion.description
    }));
    
    // Truncate assignment text (same as in the actual function)
    const truncatedText = assignment.file_path ? 
      'Sample assignment text...' : // We'll use a placeholder since we don't have PDF parsing here
      'Sample assignment text...';
    
    const prompt = `Mark this assignment using the rubric. Respond with valid JSON only.

ASSIGNMENT:
${truncatedText}

RUBRIC:
${simpleCriteria.map((c, i) => `${i+1}. ${c.name} (${c.max_points}pts): ${c.description}`).join('\n')}

TOTAL: ${rubric.total_points} points

JSON format:
{
  "scores": [{"criterion_name": "name", "points_awarded": number, "max_points": number, "feedback": "text"}],
  "overall_feedback": "text",
  "total_score": number
}`;

    console.log('📊 Prompt Analysis:');
    console.log(`Prompt length: ${prompt.length} characters`);
    console.log(`Estimated tokens: ~${Math.ceil(prompt.length / 4)} tokens`);
    console.log(`Max completion tokens: 2000`);
    console.log(`Total estimated tokens: ~${Math.ceil(prompt.length / 4) + 2000} tokens`);
    
    // Initialize OpenAI
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
    
    console.log('\n🤖 Testing with actual API call...');
    const completion = await openai.completions.create({
      model: "gpt-4o-mini",
      prompt: prompt,
      temperature: 0.3,
      max_tokens: 2000,
      user: "anonymous" // Enhanced privacy: don't send user identifiers
    });
    
    console.log('📈 Actual Token Usage:');
    console.log(`Prompt tokens: ${completion.usage?.prompt_tokens || 'Not available'}`);
    console.log(`Completion tokens: ${completion.usage?.completion_tokens || 'Not available'}`);
    console.log(`Total tokens: ${completion.usage?.total_tokens || 'Not available'}`);
    
    if (completion.usage) {
      console.log('\n💰 Cost Estimation (GPT-4o-mini):');
      const promptCost = (completion.usage.prompt_tokens / 1000) * 0.00015; // $0.00015 per 1K tokens
      const completionCost = (completion.usage.completion_tokens / 1000) * 0.0006; // $0.0006 per 1K tokens
      const totalCost = promptCost + completionCost;
      
      console.log(`Prompt cost: $${promptCost.toFixed(6)}`);
      console.log(`Completion cost: $${completionCost.toFixed(6)}`);
      console.log(`Total cost: $${totalCost.toFixed(6)}`);
    }
    
  } catch (error) {
    console.error('Error checking token usage:', error.message);
  }
}

checkTokenUsage().catch(console.error);
