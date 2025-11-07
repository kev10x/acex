const { query } = require('./server/database/connection');

async function testDatabaseQuery() {
  try {
    console.log('🔍 Testing database queries...');
    
    // Test assignments query
    console.log('\n1. Testing assignments query:');
    const assignmentsResult = await query('SELECT * FROM assignments WHERE id = ?', [14]);
    console.log('Assignments result type:', typeof assignmentsResult);
    console.log('Assignments result:', JSON.stringify(assignmentsResult, null, 2));
    
    // Test rubrics query
    console.log('\n2. Testing rubrics query:');
    const rubricsResult = await query('SELECT * FROM rubrics WHERE id = ?', [3]);
    console.log('Rubrics result type:', typeof rubricsResult);
    console.log('Rubrics result:', JSON.stringify(rubricsResult, null, 2));
    
    // Test if we can access the data
    if (rubricsResult && rubricsResult.rows) {
      console.log('\n3. Accessing via .rows:');
      console.log('First rubric:', JSON.stringify(rubricsResult.rows[0], null, 2));
      if (rubricsResult.rows[0] && rubricsResult.rows[0].criteria) {
        console.log('Criteria type:', typeof rubricsResult.rows[0].criteria);
        console.log('Criteria:', JSON.stringify(rubricsResult.rows[0].criteria, null, 2));
      }
    }
    
  } catch (error) {
    console.error('Database test error:', error);
  }
}

testDatabaseQuery().catch(console.error);
