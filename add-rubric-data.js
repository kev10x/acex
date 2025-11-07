const mysql = require('mysql2/promise');
require('dotenv').config();

// Database connection configuration
const dbConfig = {
  host: 'localhost',
  port: 3306,
  user: 'root',
  password: 'Pwd2wic3',
  database: 'markmate'
};

// Sample rubric data template
const sampleRubrics = [
  {
    name: "Research Report Rubric - IEMT302",
    criteria: [
      {
        name: "Research Quality",
        description: "Depth and breadth of research conducted",
        maxPoints: 25,
        levels: [
          { level: "Excellent", points: 25, description: "Comprehensive research with multiple credible sources, demonstrates deep understanding" },
          { level: "Good", points: 20, description: "Good research with adequate sources, shows solid understanding" },
          { level: "Satisfactory", points: 15, description: "Basic research with limited sources, shows some understanding" },
          { level: "Needs Improvement", points: 10, description: "Insufficient research, lacks depth and credible sources" }
        ]
      },
      {
        name: "Content Analysis",
        description: "Analysis of emerging technology applications and implications",
        maxPoints: 30,
        levels: [
          { level: "Excellent", points: 30, description: "Thorough analysis with clear insights, well-supported arguments" },
          { level: "Good", points: 24, description: "Good analysis with some insights, mostly supported arguments" },
          { level: "Satisfactory", points: 18, description: "Basic analysis with limited insights, some supported arguments" },
          { level: "Needs Improvement", points: 12, description: "Superficial analysis, weak or unsupported arguments" }
        ]
      },
      {
        name: "Writing Quality",
        description: "Clarity, structure, and presentation of the report",
        maxPoints: 20,
        levels: [
          { level: "Excellent", points: 20, description: "Clear, well-structured, professional writing with no errors" },
          { level: "Good", points: 16, description: "Mostly clear and structured, minor errors" },
          { level: "Satisfactory", points: 12, description: "Adequate clarity and structure, some errors" },
          { level: "Needs Improvement", points: 8, description: "Unclear, poorly structured, many errors" }
        ]
      },
      {
        name: "Critical Thinking",
        description: "Demonstration of critical analysis and evaluation",
        maxPoints: 25,
        levels: [
          { level: "Excellent", points: 25, description: "Exceptional critical thinking, original insights, well-reasoned conclusions" },
          { level: "Good", points: 20, description: "Good critical thinking, some original insights, reasonable conclusions" },
          { level: "Satisfactory", points: 15, description: "Basic critical thinking, limited insights, adequate conclusions" },
          { level: "Needs Improvement", points: 10, description: "Weak critical thinking, no original insights, poor conclusions" }
        ]
      }
    ],
    totalPoints: 100
  },
  {
    name: "General Assignment Rubric",
    criteria: [
      {
        name: "Understanding",
        description: "Demonstrates understanding of the topic",
        maxPoints: 30,
        levels: [
          { level: "Excellent", points: 30, description: "Shows complete understanding with sophisticated insights" },
          { level: "Good", points: 24, description: "Shows good understanding with some insights" },
          { level: "Satisfactory", points: 18, description: "Shows basic understanding" },
          { level: "Needs Improvement", points: 12, description: "Shows limited understanding" }
        ]
      },
      {
        name: "Organization",
        description: "Structure and flow of the assignment",
        maxPoints: 25,
        levels: [
          { level: "Excellent", points: 25, description: "Excellent organization with clear structure" },
          { level: "Good", points: 20, description: "Good organization with mostly clear structure" },
          { level: "Satisfactory", points: 15, description: "Adequate organization" },
          { level: "Needs Improvement", points: 10, description: "Poor organization" }
        ]
      },
      {
        name: "Evidence and Support",
        description: "Use of evidence to support arguments",
        maxPoints: 25,
        levels: [
          { level: "Excellent", points: 25, description: "Strong evidence and support throughout" },
          { level: "Good", points: 20, description: "Good evidence and support" },
          { level: "Satisfactory", points: 15, description: "Adequate evidence and support" },
          { level: "Needs Improvement", points: 10, description: "Weak evidence and support" }
        ]
      },
      {
        name: "Presentation",
        description: "Formatting, grammar, and presentation",
        maxPoints: 20,
        levels: [
          { level: "Excellent", points: 20, description: "Professional presentation with no errors" },
          { level: "Good", points: 16, description: "Good presentation with minor errors" },
          { level: "Satisfactory", points: 12, description: "Adequate presentation with some errors" },
          { level: "Needs Improvement", points: 8, description: "Poor presentation with many errors" }
        ]
      }
    ],
    totalPoints: 100
  }
];

async function addRubricData() {
  let connection;
  
  try {
    console.log('Connecting to MySQL database...');
    connection = await mysql.createConnection(dbConfig);
    console.log('Connected successfully!');

    // Clear existing rubrics (optional - remove this if you want to keep existing data)
    console.log('Clearing existing rubrics...');
    await connection.execute('DELETE FROM rubrics');
    console.log('Existing rubrics cleared.');

    // Insert sample rubrics
    console.log('Adding sample rubrics...');
    
    for (const rubric of sampleRubrics) {
      const insertQuery = `
        INSERT INTO rubrics (name, criteria, total_points) 
        VALUES (?, ?, ?)
      `;
      
      const [result] = await connection.execute(insertQuery, [
        rubric.name,
        JSON.stringify(rubric.criteria),
        rubric.totalPoints
      ]);
      
      console.log(`✅ Added rubric: "${rubric.name}" (ID: ${result.insertId})`);
    }

    // Verify the data was inserted
    console.log('\nVerifying inserted data...');
    const [rows] = await connection.execute('SELECT id, name, total_points FROM rubrics ORDER BY id');
    
    console.log('\n📋 Current rubrics in database:');
    rows.forEach(row => {
      console.log(`  ID: ${row.id} | Name: ${row.name} | Total Points: ${row.total_points}`);
    });

    console.log('\n✅ Script completed successfully!');
    console.log('\nYou can now test the application by:');
    console.log('1. Going to http://localhost:3000');
    console.log('2. Uploading a PDF file');
    console.log('3. Selecting a rubric from the dropdown');
    console.log('4. Testing the marking functionality');

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
      console.log('\nDatabase connection closed.');
    }
  }
}

// Function to add a single custom rubric
async function addCustomRubric(rubricData) {
  let connection;
  
  try {
    connection = await mysql.createConnection(dbConfig);
    
    const insertQuery = `
      INSERT INTO rubrics (name, criteria, total_points) 
      VALUES (?, ?, ?)
    `;
    
    const [result] = await connection.execute(insertQuery, [
      rubricData.name,
      JSON.stringify(rubricData.criteria),
      rubricData.totalPoints
    ]);
    
    console.log(`✅ Added custom rubric: "${rubricData.name}" (ID: ${result.insertId})`);
    return result.insertId;
    
  } catch (error) {
    console.error('❌ Error adding custom rubric:', error.message);
    throw error;
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

// Function to list all rubrics
async function listRubrics() {
  let connection;
  
  try {
    connection = await mysql.createConnection(dbConfig);
    
    const [rows] = await connection.execute(`
      SELECT id, name, total_points, created_at 
      FROM rubrics 
      ORDER BY created_at DESC
    `);
    
    console.log('\n📋 All rubrics in database:');
    if (rows.length === 0) {
      console.log('  No rubrics found.');
    } else {
      rows.forEach(row => {
        console.log(`  ID: ${row.id} | Name: ${row.name} | Total Points: ${row.total_points} | Created: ${row.created_at}`);
      });
    }
    
    return rows;
    
  } catch (error) {
    console.error('❌ Error listing rubrics:', error.message);
    throw error;
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

// Main execution
if (require.main === module) {
  const command = process.argv[2];
  
  switch (command) {
    case 'add':
      addRubricData();
      break;
    case 'list':
      listRubrics();
      break;
    case 'custom':
      // Example of adding a custom rubric
      const customRubric = {
        name: "My Custom Rubric",
        criteria: [
          {
            name: "Custom Criterion",
            description: "Description of the criterion",
            maxPoints: 50,
            levels: [
              { level: "Excellent", points: 50, description: "Excellent work" },
              { level: "Good", points: 40, description: "Good work" },
              { level: "Satisfactory", points: 30, description: "Satisfactory work" },
              { level: "Needs Improvement", points: 20, description: "Needs improvement" }
            ]
          }
        ],
        totalPoints: 50
      };
      addCustomRubric(customRubric);
      break;
    case 'mphil':
      // Add the MPhil Information Security Governance rubric
      const mphilRubric = {
        name: "MPhil Information Security Governance Treatise Rubric",
        criteria: [
          {
            name: "Research Design and Methodology",
            description: "Appropriateness and rigor of research design, methodology selection, and data collection approaches",
            maxPoints: 20,
            levels: [
              { level: "Excellent", points: 20, description: "Exceptional research design with clear methodology, appropriate for the research question, demonstrates mastery of research methods, includes comprehensive data collection strategy with clear ethical considerations" },
              { level: "Good", points: 16, description: "Strong research design with sound methodology, mostly appropriate for research question, shows good understanding of research methods, includes adequate data collection strategy with ethical considerations" },
              { level: "Satisfactory", points: 12, description: "Adequate research design with basic methodology, somewhat appropriate for research question, shows basic understanding of research methods, includes basic data collection strategy" },
              { level: "Needs Improvement", points: 8, description: "Weak research design with unclear methodology, inappropriate for research question, shows limited understanding of research methods, lacks clear data collection strategy" }
            ]
          },
          {
            name: "Literature Review and Theoretical Framework",
            description: "Comprehensiveness of literature review, depth of theoretical analysis, and positioning within existing knowledge",
            maxPoints: 25,
            levels: [
              { level: "Excellent", points: 25, description: "Comprehensive literature review covering all relevant areas, sophisticated theoretical framework, clear positioning within existing knowledge, demonstrates critical analysis and synthesis of sources, identifies research gaps effectively" },
              { level: "Good", points: 20, description: "Good literature review covering most relevant areas, solid theoretical framework, clear positioning, shows good analysis and synthesis, identifies some research gaps" },
              { level: "Satisfactory", points: 15, description: "Adequate literature review covering basic areas, basic theoretical framework, some positioning, shows basic analysis, limited gap identification" },
              { level: "Needs Improvement", points: 10, description: "Insufficient literature review, weak theoretical framework, unclear positioning, poor analysis, no clear gap identification" }
            ]
          },
          {
            name: "Information Security Governance Knowledge",
            description: "Demonstration of deep understanding of information security governance principles, frameworks, and practices",
            maxPoints: 30,
            levels: [
              { level: "Excellent", points: 30, description: "Exceptional understanding of information security governance, demonstrates mastery of key frameworks (COBIT, ISO 27001, NIST, etc.), sophisticated analysis of governance challenges, innovative insights into governance practices" },
              { level: "Good", points: 24, description: "Strong understanding of information security governance, good knowledge of key frameworks, solid analysis of governance challenges, some innovative insights" },
              { level: "Satisfactory", points: 18, description: "Adequate understanding of information security governance, basic knowledge of frameworks, basic analysis of governance challenges, limited insights" },
              { level: "Needs Improvement", points: 12, description: "Weak understanding of information security governance, limited knowledge of frameworks, superficial analysis, no clear insights" }
            ]
          },
          {
            name: "Critical Analysis and Evaluation",
            description: "Depth of critical thinking, analytical rigor, and evaluation of evidence and arguments",
            maxPoints: 25,
            levels: [
              { level: "Excellent", points: 25, description: "Exceptional critical analysis with sophisticated evaluation, demonstrates independent thinking, challenges assumptions, provides well-reasoned conclusions, shows ability to evaluate conflicting evidence" },
              { level: "Good", points: 20, description: "Strong critical analysis with good evaluation, shows independent thinking, questions some assumptions, provides reasonable conclusions, evaluates evidence well" },
              { level: "Satisfactory", points: 15, description: "Adequate critical analysis with basic evaluation, shows some independent thinking, limited questioning of assumptions, provides basic conclusions" },
              { level: "Needs Improvement", points: 10, description: "Weak critical analysis, limited evaluation, lacks independent thinking, no questioning of assumptions, poor conclusions" }
            ]
          },
          {
            name: "Practical Application and Recommendations",
            description: "Relevance and feasibility of practical applications, recommendations, and their potential impact",
            maxPoints: 20,
            levels: [
              { level: "Excellent", points: 20, description: "Highly relevant and feasible practical applications, innovative recommendations with clear implementation strategies, demonstrates understanding of real-world constraints, shows potential for significant impact" },
              { level: "Good", points: 16, description: "Good practical applications with mostly feasible recommendations, clear implementation strategies, shows understanding of real-world constraints, potential for positive impact" },
              { level: "Satisfactory", points: 12, description: "Adequate practical applications with basic recommendations, some implementation strategies, limited understanding of real-world constraints" },
              { level: "Needs Improvement", points: 8, description: "Weak practical applications, unrealistic recommendations, no clear implementation strategies, poor understanding of real-world constraints" }
            ]
          },
          {
            name: "Academic Writing and Presentation",
            description: "Quality of academic writing, structure, clarity, and adherence to academic standards",
            maxPoints: 15,
            levels: [
              { level: "Excellent", points: 15, description: "Exceptional academic writing with clear structure, sophisticated argumentation, perfect grammar and style, excellent use of academic language, flawless formatting and citations" },
              { level: "Good", points: 12, description: "Strong academic writing with good structure, clear argumentation, good grammar and style, appropriate academic language, good formatting and citations" },
              { level: "Satisfactory", points: 9, description: "Adequate academic writing with basic structure, reasonable argumentation, some grammar issues, basic academic language, adequate formatting and citations" },
              { level: "Needs Improvement", points: 6, description: "Poor academic writing with weak structure, unclear argumentation, many grammar errors, inappropriate language, poor formatting and citations" }
            ]
          },
          {
            name: "Originality and Contribution",
            description: "Originality of research, contribution to knowledge, and advancement of the field",
            maxPoints: 20,
            levels: [
              { level: "Excellent", points: 20, description: "Highly original research with significant contribution to knowledge, advances the field of information security governance, demonstrates innovative thinking, clear potential for publication or practical application" },
              { level: "Good", points: 16, description: "Good originality with meaningful contribution, advances understanding in the field, shows innovative thinking, potential for publication or application" },
              { level: "Satisfactory", points: 12, description: "Some originality with basic contribution, limited advancement of the field, shows some innovative thinking" },
              { level: "Needs Improvement", points: 8, description: "Limited originality, minimal contribution, no clear advancement of the field, lacks innovative thinking" }
            ]
          },
          {
            name: "Ethical Considerations and Professional Standards",
            description: "Demonstration of ethical awareness, professional standards, and responsible research practices",
            maxPoints: 15,
            levels: [
              { level: "Excellent", points: 15, description: "Exceptional ethical awareness with comprehensive consideration of ethical issues, demonstrates high professional standards, shows responsible research practices, addresses privacy and security implications thoroughly" },
              { level: "Good", points: 12, description: "Good ethical awareness with adequate consideration of ethical issues, demonstrates professional standards, shows responsible research practices, addresses privacy and security implications" },
              { level: "Satisfactory", points: 9, description: "Basic ethical awareness with limited consideration of ethical issues, shows some professional standards, basic responsible research practices" },
              { level: "Needs Improvement", points: 6, description: "Poor ethical awareness, minimal consideration of ethical issues, lacks professional standards, irresponsible research practices" }
            ]
          }
        ],
        totalPoints: 170
      };
      addCustomRubric(mphilRubric);
      break;
    default:
      console.log('Usage:');
      console.log('  node add-rubric-data.js add     - Add sample rubrics');
      console.log('  node add-rubric-data.js list    - List all rubrics');
      console.log('  node add-rubric-data.js custom  - Add a custom rubric example');
      console.log('  node add-rubric-data.js mphil   - Add MPhil Information Security Governance rubric');
      break;
  }
}

module.exports = {
  addRubricData,
  addCustomRubric,
  listRubrics
};
