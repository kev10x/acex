const axios = require('axios');

// Simple test script to debug marking issues
async function testMarking() {
  const API_BASE_URL = 'http://localhost:3001/api';
  
  console.log('🧪 Testing MarkMate Marking System');
  console.log('==================================');
  
  try {
    // First, get available assignments and rubrics
    console.log('\n1. Fetching assignments and rubrics...');
    
    const assignmentsRes = await axios.get(`${API_BASE_URL}/upload`);
    const rubricsRes = await axios.get(`${API_BASE_URL}/rubrics`);
    
    const assignments = assignmentsRes.data.assignments;
    const rubrics = rubricsRes.data.rubrics;
    
    console.log(`✅ Found ${assignments.length} assignments`);
    console.log(`✅ Found ${rubrics.length} rubrics`);
    
    if (assignments.length === 0) {
      console.log('❌ No assignments found. Please upload some assignments first.');
      return;
    }
    
    if (rubrics.length === 0) {
      console.log('❌ No rubrics found. Please create a rubric first.');
      return;
    }
    
    // Show available assignments
    console.log('\n📋 Available assignments:');
    assignments.forEach((assignment, index) => {
      console.log(`  ${index + 1}. ${assignment.filename} (ID: ${assignment.id}, Status: ${assignment.status})`);
    });
    
    // Show available rubrics
    console.log('\n📋 Available rubrics:');
    rubrics.forEach((rubric, index) => {
      console.log(`  ${index + 1}. ${rubric.name} (ID: ${rubric.id}, ${rubric.total_points} points)`);
    });
    
    // Test with the first available assignment and rubric
    const testAssignment = assignments[0];
    const testRubric = rubrics[0];
    
    console.log(`\n2. Testing with assignment: ${testAssignment.filename}`);
    console.log(`   Using rubric: ${testRubric.name}`);
    
    // Use the debug endpoint
    console.log('\n3. Testing debug endpoint...');
    const debugRes = await axios.post(`${API_BASE_URL}/mark/debug`, {
      assignment_id: testAssignment.id,
      rubric_id: testRubric.id
    });
    
    console.log('✅ Debug test successful!');
    console.log('📊 Results:');
    console.log(`   - Assignment: ${debugRes.data.assignment?.filename || 'Unknown'}`);
    console.log(`   - Rubric: ${debugRes.data.rubric?.name || 'Unknown'}`);
    console.log(`   - Text extracted: ${debugRes.data.extracted_text_length} characters`);
    console.log(`   - Marking completed: ${debugRes.data.marking_result ? 'Yes' : 'No'}`);
    
    if (debugRes.data.marking_result) {
      console.log(`   - Total score: ${debugRes.data.marking_result.total_score}/${debugRes.data.rubric?.total_points || 'Unknown'}`);
      console.log(`   - Criteria marked: ${debugRes.data.marking_result.scores?.length || 0}`);
    }
    
  } catch (error) {
    console.log('❌ Test failed:');
    console.log('Error:', error.message);
    if (error.response) {
      console.log('Response status:', error.response.status);
      console.log('Response data:', error.response.data);
    }
  }
}

// Run the test
testMarking().catch(console.error);
