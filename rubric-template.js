// Rubric Template - Use this to create custom rubrics
// Copy this template and modify the values as needed

const rubricTemplate = {
  name: "Your Rubric Name Here",
  criteria: [
    {
      name: "Criterion 1 Name",
      description: "Description of what this criterion evaluates",
      maxPoints: 25, // Maximum points for this criterion
      levels: [
        {
          level: "Excellent",
          points: 25,
          description: "Description of excellent performance"
        },
        {
          level: "Good", 
          points: 20,
          description: "Description of good performance"
        },
        {
          level: "Satisfactory",
          points: 15,
          description: "Description of satisfactory performance"
        },
        {
          level: "Needs Improvement",
          points: 10,
          description: "Description of work that needs improvement"
        }
      ]
    },
    {
      name: "Criterion 2 Name",
      description: "Description of what this criterion evaluates",
      maxPoints: 30,
      levels: [
        {
          level: "Excellent",
          points: 30,
          description: "Description of excellent performance"
        },
        {
          level: "Good",
          points: 24,
          description: "Description of good performance"
        },
        {
          level: "Satisfactory",
          points: 18,
          description: "Description of satisfactory performance"
        },
        {
          level: "Needs Improvement",
          points: 12,
          description: "Description of work that needs improvement"
        }
      ]
    }
    // Add more criteria as needed...
  ],
  totalPoints: 100 // Sum of all maxPoints from criteria
};

// Example: Research Paper Rubric
const researchPaperRubric = {
  name: "Research Paper Rubric",
  criteria: [
    {
      name: "Thesis Statement",
      description: "Clarity and strength of the thesis statement",
      maxPoints: 15,
      levels: [
        { level: "Excellent", points: 15, description: "Clear, specific, and arguable thesis statement" },
        { level: "Good", points: 12, description: "Clear and specific thesis statement" },
        { level: "Satisfactory", points: 9, description: "Basic thesis statement present" },
        { level: "Needs Improvement", points: 6, description: "Weak or unclear thesis statement" }
      ]
    },
    {
      name: "Research Quality",
      description: "Quality and depth of research",
      maxPoints: 25,
      levels: [
        { level: "Excellent", points: 25, description: "Extensive research with credible sources" },
        { level: "Good", points: 20, description: "Good research with adequate sources" },
        { level: "Satisfactory", points: 15, description: "Basic research with limited sources" },
        { level: "Needs Improvement", points: 10, description: "Insufficient or poor quality research" }
      ]
    },
    {
      name: "Analysis and Argument",
      description: "Depth of analysis and strength of argument",
      maxPoints: 30,
      levels: [
        { level: "Excellent", points: 30, description: "Sophisticated analysis with strong arguments" },
        { level: "Good", points: 24, description: "Good analysis with solid arguments" },
        { level: "Satisfactory", points: 18, description: "Basic analysis with adequate arguments" },
        { level: "Needs Improvement", points: 12, description: "Weak analysis and arguments" }
      ]
    },
    {
      name: "Writing Quality",
      description: "Clarity, grammar, and style",
      maxPoints: 20,
      levels: [
        { level: "Excellent", points: 20, description: "Clear, well-written with no errors" },
        { level: "Good", points: 16, description: "Mostly clear with minor errors" },
        { level: "Satisfactory", points: 12, description: "Adequate writing with some errors" },
        { level: "Needs Improvement", points: 8, description: "Poor writing with many errors" }
      ]
    },
    {
      name: "Citations and Formatting",
      description: "Proper citations and formatting",
      maxPoints: 10,
      levels: [
        { level: "Excellent", points: 10, description: "Perfect citations and formatting" },
        { level: "Good", points: 8, description: "Mostly correct citations and formatting" },
        { level: "Satisfactory", points: 6, description: "Adequate citations and formatting" },
        { level: "Needs Improvement", points: 4, description: "Poor citations and formatting" }
      ]
    }
  ],
  totalPoints: 100
};

// Example: Presentation Rubric
const presentationRubric = {
  name: "Presentation Rubric",
  criteria: [
    {
      name: "Content",
      description: "Quality and relevance of presentation content",
      maxPoints: 30,
      levels: [
        { level: "Excellent", points: 30, description: "Comprehensive, relevant, and well-organized content" },
        { level: "Good", points: 24, description: "Good content with clear organization" },
        { level: "Satisfactory", points: 18, description: "Adequate content with basic organization" },
        { level: "Needs Improvement", points: 12, description: "Weak or irrelevant content" }
      ]
    },
    {
      name: "Delivery",
      description: "Speaking skills and presentation delivery",
      maxPoints: 25,
      levels: [
        { level: "Excellent", points: 25, description: "Confident, clear, and engaging delivery" },
        { level: "Good", points: 20, description: "Clear delivery with good eye contact" },
        { level: "Satisfactory", points: 15, description: "Adequate delivery with some eye contact" },
        { level: "Needs Improvement", points: 10, description: "Poor delivery, unclear speech" }
      ]
    },
    {
      name: "Visual Aids",
      description: "Effectiveness of slides or visual materials",
      maxPoints: 20,
      levels: [
        { level: "Excellent", points: 20, description: "Professional, clear, and supportive visual aids" },
        { level: "Good", points: 16, description: "Good visual aids that support the presentation" },
        { level: "Satisfactory", points: 12, description: "Basic visual aids" },
        { level: "Needs Improvement", points: 8, description: "Poor or distracting visual aids" }
      ]
    },
    {
      name: "Q&A",
      description: "Handling of questions and audience interaction",
      maxPoints: 15,
      levels: [
        { level: "Excellent", points: 15, description: "Thoughtful, confident responses to all questions" },
        { level: "Good", points: 12, description: "Good responses to most questions" },
        { level: "Satisfactory", points: 9, description: "Adequate responses to questions" },
        { level: "Needs Improvement", points: 6, description: "Poor responses or inability to answer questions" }
      ]
    },
    {
      name: "Time Management",
      description: "Adherence to time limits",
      maxPoints: 10,
      levels: [
        { level: "Excellent", points: 10, description: "Perfect timing, well-paced" },
        { level: "Good", points: 8, description: "Good timing, slightly over or under" },
        { level: "Satisfactory", points: 6, description: "Adequate timing" },
        { level: "Needs Improvement", points: 4, description: "Poor timing, significantly over or under" }
      ]
    }
  ],
  totalPoints: 100
};

module.exports = {
  rubricTemplate,
  researchPaperRubric,
  presentationRubric
};
