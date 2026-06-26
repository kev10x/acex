const { query } = require('./server/database/connection');

const createDemoData = async () => {
  try {
    console.log('🎭 Creating demo data...\n');

    // Create a sample rubric
    const rubricData = {
      name: 'Essay Writing Rubric',
      criteria: [
        {
          name: 'Content Quality',
          max_points: 30,
          description: 'Depth of analysis, relevance of arguments, and use of evidence'
        },
        {
          name: 'Structure & Organization',
          max_points: 20,
          description: 'Clear introduction, logical flow, and effective conclusion'
        },
        {
          name: 'Grammar & Style',
          max_points: 15,
          description: 'Proper grammar, sentence structure, and writing style'
        },
        {
          name: 'Citations & References',
          max_points: 10,
          description: 'Proper citation format and credible sources'
        }
      ],
      total_points: 75
    };

    const rubricResult = await query(
      'INSERT INTO rubrics (name, criteria, total_points) VALUES (?, ?, ?)',
      [rubricData.name, JSON.stringify(rubricData.criteria), rubricData.total_points]
    );

    console.log('✅ Created sample rubric:', rubricData.name);
    console.log('   - Criteria:', rubricData.criteria.length);
    console.log('   - Total Points:', rubricData.total_points);
    console.log('   - ID:', rubricResult.lastID);

    console.log('\n🎉 Demo data created successfully!');
    console.log('\nYou can now:');
    console.log('1. Start the application: npm run dev');
    console.log('2. Upload some PDF files');
    console.log('3. Use the sample rubric for marking');
    console.log('4. Test the AI marking functionality');

  } catch (error) {
    console.error('❌ Error creating demo data:', error);
  }
};

// Only run if called directly
if (require.main === module) {
  createDemoData().then(() => {
    process.exit(0);
  });
}

module.exports = createDemoData;

