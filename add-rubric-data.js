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
async function addCustomRubric(rubricData, options = {}) {
  let connection;
  const userId = options.userId != null ? options.userId : 1;
  const rubricType = options.rubricType || 'rubric';

  try {
    connection = await mysql.createConnection(dbConfig);

    // Include user_id and rubric_type if table has these columns (for app compatibility)
    const insertQuery = `
      INSERT INTO rubrics (name, criteria, total_points, rubric_type, user_id)
      VALUES (?, ?, ?, ?, ?)
    `;

    const [result] = await connection.execute(insertQuery, [
      rubricData.name,
      JSON.stringify(rubricData.criteria),
      rubricData.totalPoints,
      rubricType,
      userId
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
    case 'mit-proposal':
      // Anele Siwela - MIT proposal review rubric (12 criteria, 1–4 points each)
      const mitProposalRubric = {
        name: "MIT Proposal Review",
        criteria: [
          {
            name: "TITLE",
            description: "Clarity, focus and alignment of the title with the research",
            maxPoints: 4,
            levels: [
              { level: "1", points: 1, description: "The title is unclear, way too long, not focused enough. Complete revision necessary." },
              { level: "2", points: 2, description: "The title lacks focus and should be aligned better with the research question and objectives." },
              { level: "3", points: 3, description: "Good working title that may require tweaking but likely to be very similar." },
              { level: "4", points: 4, description: "Title unlikely to change. Exact, well-worded and focused." }
            ]
          },
          {
            name: "INTRODUCTION",
            description: "Positioning of research within the bigger picture and underpinning theories, models or frameworks",
            maxPoints: 4,
            levels: [
              { level: "1", points: 1, description: "The student was unconvincing in positioning his/her research within the bigger picture, including the underpinning theories, models, or frameworks related to the study." },
              { level: "2", points: 2, description: "The student cannot position his/her research, and could not convince me that s/he sees the bigger picture or fully understands the underpinning theories, models, or frameworks related to the study." },
              { level: "3", points: 3, description: "The student convinced me that s/he understands the background to the problem adequately and has a reasonable grasp of the underpinning theories, models, or frameworks related to the study." },
              { level: "4", points: 4, description: "The student is undoubtedly in command of the bigger research domain and demonstrates a thorough understanding of the underpinning theories, models, or frameworks related to the study." }
            ]
          },
          {
            name: "PROBLEM AREA DESCRIPTION",
            description: "Clarity, depth and context of the problem area",
            maxPoints: 4,
            levels: [
              { level: "1", points: 1, description: "The problem area is vaguely or inadequately described, lacking clarity and specificity. There is little to no context provided, making it difficult to understand the importance or relevance of the problem." },
              { level: "2", points: 2, description: "The problem area is identified, but the description lacks depth or thoroughness. Essential background is provided, but it may not fully capture the scope or significance of the problem." },
              { level: "3", points: 3, description: "The problem area is clearly and effectively described, with a good level of detail and background. The significance and scope of the problem are adequately communicated, but there may be room for deeper analysis or more comprehensive context." },
              { level: "4", points: 4, description: "The problem area is described with exceptional clarity and depth. The description provides a comprehensive background, clearly delineating the scope, significance, and potential impact of the problem. It engages critically with the topic and sets a strong foundation for the research." }
            ]
          },
          {
            name: "PROBLEM STATEMENT",
            description: "Distinction between the real-world problem and the research problem",
            maxPoints: 4,
            levels: [
              { level: "1", points: 1, description: "The problem statement is vague or missing." },
              { level: "2", points: 2, description: "The problem statement delineates the problem, but could still distil the research question better from the real-world problem." },
              { level: "3", points: 3, description: "The problem statement is well delineated and would most likely not require significant changes." },
              { level: "4", points: 4, description: "The problem statement is extremely sharply focused and demonstrates a very clear distinction between the real-world problem and the research problem." }
            ]
          },
          {
            name: "PRIMARY RESEARCH QUESTION/OBJECTIVES",
            description: "Validity and framing of the primary research question or objectives",
            maxPoints: 4,
            levels: [
              { level: "1", points: 1, description: "It is unclear what question the candidate wants to answer." },
              { level: "2", points: 2, description: "The primary question/objectives are valid, but unclear how the primary question and the research problem tie together." },
              { level: "3", points: 3, description: "The primary question/objectives are valid but could use some better framing. Probably just a language/phrasing issue." },
              { level: "4", points: 4, description: "The research question/objectives are valid and are well-framed in the context of the research." }
            ]
          },
          {
            name: "SECONDARY RESEARCH QUESTIONS/OBJECTIVES",
            description: "Alignment and completeness of sub-questions with the main research question",
            maxPoints: 4,
            levels: [
              { level: "1", points: 1, description: "No sub-questions stated or relationship of sub-questions to main research question is unclear." },
              { level: "2", points: 2, description: "Sub-questions are supplied, but do not tie completely coherently to the research question and the problem statement." },
              { level: "3", points: 3, description: "Sub-questions are aligned with the problem statement and the main research question but possibly lack completeness." },
              { level: "4", points: 4, description: "Sub-questions are aligned with the problem statement and the main research question and cover the problem completely." }
            ]
          },
          {
            name: "RESEARCH APPROACH/METHODOLOGY",
            description: "Conceptualisation and operational detail of the research approach",
            maxPoints: 4,
            levels: [
              { level: "1", points: 1, description: "The candidate shows very little insight into methodological aspects." },
              { level: "2", points: 2, description: "The Research Approach is conceptualised, but several details are missing. Needs significant refinement." },
              { level: "3", points: 3, description: "Does provide a good starting point. The Research Approach provides good guidance to go ahead. Some operational details will have to be fleshed out." },
              { level: "4", points: 4, description: "The Research Approach is developed in depth, is motivated well and requires little further work." }
            ]
          },
          {
            name: "CRITICAL ALIGNMENT",
            description: "Alignment between title, problem statement and objectives",
            maxPoints: 4,
            levels: [
              { level: "1", points: 1, description: "The title, problem statement, and objectives are misaligned and do not reflect a cohesive research focus. Major revisions are necessary to establish a clear connection between these elements." },
              { level: "2", points: 2, description: "There is some alignment between the title, problem statement, and objectives, but inconsistencies exist that need to be addressed. The connection between these elements is unclear or weak." },
              { level: "3", points: 3, description: "The title, problem statement, and objectives are generally aligned, with minor adjustments needed to ensure they fully complement each other. The research focus is mostly coherent." },
              { level: "4", points: 4, description: "The title, problem statement, and objectives are perfectly aligned, creating a clear and cohesive research focus. No further adjustments are needed." }
            ]
          },
          {
            name: "ETHICAL CONSIDERATIONS",
            description: "Identification and discussion of ethical issues and strategies to address them",
            maxPoints: 4,
            levels: [
              { level: "1", points: 1, description: "The proposal lacks a clear identification and discussion of ethical issues. There is little to no consideration of the ethical implications of the research." },
              { level: "2", points: 2, description: "The proposal identifies some ethical issues but provides only a basic discussion. Key ethical principles are mentioned, but the strategies for addressing these issues are vague or insufficient." },
              { level: "3", points: 3, description: "The proposal adequately identifies and discusses ethical issues. Ethical principles are clearly stated, and there are reasonable strategies in place to address these issues." },
              { level: "4", points: 4, description: "The proposal provides a thorough identification and discussion of all relevant ethical issues. Ethical principles are well articulated, and there are comprehensive, clear strategies in place to address these issues." }
            ]
          },
          {
            name: "SCOPE OF RESEARCH",
            description: "Appropriateness of scope for the qualification",
            maxPoints: 4,
            levels: [
              { level: "1", points: 1, description: "The scope of the research is completely out of line for the qualification, i.e. way too much, or way too little." },
              { level: "2", points: 2, description: "Scope must be tied down drastically, probably related to a focus issue." },
              { level: "3", points: 3, description: "The research is defined in such a way that some scope creep can become a real problem. Beware." },
              { level: "4", points: 4, description: "The research is scoped in such a way that it is unlikely that anything but arbitrary tweaking will be necessary." }
            ]
          },
          {
            name: "REFERENCES",
            description: "Consistency, relevance and currency of references",
            maxPoints: 4,
            levels: [
              { level: "1", points: 1, description: "Referencing is done inconsistently and with little care and shows a worrying level of background reading. References are outdated or not closely related to the topic at hand, showing a lack of recent and relevant sources." },
              { level: "2", points: 2, description: "Referencing is done somewhat consistently, but is limited in coverage. References are generally relevant, though some may not be the most current, limiting the comprehensiveness of the background study." },
              { level: "3", points: 3, description: "Referencing is done consistently and with care, and shows that a comprehensive background study has been done. References are mostly relevant, and there is a balance of recent sources." },
              { level: "4", points: 4, description: "The reference list is nothing but impressive and shows a considerable amount of background reading. References are not only consistent and current but also highly relevant to the topic, showing a comprehensive and up-to-date background study." }
            ]
          },
          {
            name: "ANSWERING QUESTIONS",
            description: "Candidate's ability to answer questions about the proposal and area of study",
            maxPoints: 4,
            levels: [
              { level: "1", points: 1, description: "The candidate was unable to answer reasonable questions about his/her proposal and area of study." },
              { level: "2", points: 2, description: "The candidate answered most of the questions, but the answers sometimes were a bit perfunctory in that it's a response rather than an answer." },
              { level: "3", points: 3, description: "The candidate answered all questions with reasonable ease and did not hide behind standardized answers to just say something." },
              { level: "4", points: 4, description: "The candidate answered any questions with confidence and comprehensively, clearly showing his/her expertise and comfort with the subject area and research process." }
            ]
          }
        ],
        totalPoints: 48
      };
      addCustomRubric(mitProposalRubric);
      break;
    default:
      console.log('Usage:');
      console.log('  node add-rubric-data.js add     - Add sample rubrics');
      console.log('  node add-rubric-data.js list    - List all rubrics');
      console.log('  node add-rubric-data.js custom  - Add a custom rubric example');
      console.log('  node add-rubric-data.js mphil   - Add MPhil Information Security Governance rubric');
      console.log('  node add-rubric-data.js mit-proposal - Add MIT Proposal Review rubric');
      break;
  }
}

module.exports = {
  addRubricData,
  addCustomRubric,
  listRubrics
};
