const { query } = require('./server/database/connection');

async function checkRubrics() {
  try {
    console.log('🔍 Checking rubrics data...');
    
    const rubricsResult = await query('SELECT * FROM rubrics ORDER BY id');
    console.log('Raw query result:', JSON.stringify(rubricsResult, null, 2));
    
    // Handle different database result formats
    let rubrics;
    if (Array.isArray(rubricsResult)) {
      rubrics = rubricsResult;
    } else if (rubricsResult.rows && Array.isArray(rubricsResult.rows)) {
      rubrics = rubricsResult.rows;
    } else {
      console.log('Unexpected result format:', typeof rubricsResult);
      return;
    }
    
    console.log(`Found ${rubrics.length} rubrics:`);
    
    if (Array.isArray(rubrics)) {
      rubrics.forEach((rubric, index) => {
      console.log(`\n${index + 1}. Rubric ID: ${rubric.id}`);
      console.log(`   Name: ${rubric.name}`);
      console.log(`   Total Points: ${rubric.total_points}`);
      console.log(`   Criteria (raw): ${rubric.criteria}`);
      
      try {
        const parsedCriteria = JSON.parse(rubric.criteria);
        console.log(`   Criteria (parsed): ${JSON.stringify(parsedCriteria, null, 2)}`);
        console.log(`   Criteria type: ${typeof parsedCriteria}`);
        console.log(`   Is array: ${Array.isArray(parsedCriteria)}`);
        if (Array.isArray(parsedCriteria)) {
          console.log(`   Criteria count: ${parsedCriteria.length}`);
        }
      } catch (parseError) {
        console.log(`   ❌ JSON parse error: ${parseError.message}`);
      }
    });
    } else {
      console.log('Rubrics is not an array:', typeof rubrics);
    }
    
  } catch (error) {
    console.error('Error checking rubrics:', error);
  }
}

checkRubrics().catch(console.error);
