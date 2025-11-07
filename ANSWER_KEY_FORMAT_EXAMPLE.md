# Answer Key / Memo Format Guide

When uploading an answer key (marking memorandum) to use for marking question papers, you should structure it as a rubric. The system will automatically detect it as a memo and use it appropriately.

## Answer Key Structure

An answer key should follow this format when uploaded as a rubric:

### Example Answer Key Format:

**Rubric Name:** "DevOps Exam - Answer Key" or "Marking Memorandum - Question Paper 1"

**Criteria Structure:**

Each question or question part becomes a "criterion" with the following:

```javascript
{
  name: "Question 1: Explain microservices architecture",
  description: "Model Answer: Microservices architecture is a design approach where an application is built as a collection of small, independent services. Each service runs in its own process and communicates via well-defined APIs. Key characteristics include: (1) Service independence - each service can be developed, deployed, and scaled independently, (2) Technology diversity - different services can use different programming languages and databases, (3) Fault isolation - failures in one service don't bring down the entire system, (4) Distributed development - teams can work on different services simultaneously.",
  maxPoints: 15,
  levels: [
    {
      level: "Full Marks (13-15 points)",
      points: 15,
      description: "Student provides a complete and accurate explanation covering all key characteristics mentioned in the model answer. Demonstrates clear understanding of microservices concepts."
    },
    {
      level: "Partial Marks (10-12 points)",
      points: 12,
      description: "Student covers most key points but may miss 1-2 characteristics or have minor inaccuracies. Shows good understanding overall."
    },
    {
      level: "Partial Marks (7-9 points)",
      points: 9,
      description: "Student covers some key points but misses significant characteristics or has notable inaccuracies. Shows basic understanding."
    },
    {
      level: "Low Marks (0-6 points)",
      points: 6,
      description: "Student provides minimal or incorrect information. Lacks understanding of core concepts."
    }
  ]
}
```

## Key Characteristics of an Answer Key:

1. **Contains Model Answers**: Each criterion should include the correct/expected answer in the description
2. **Marking Allocations**: Shows how many points each question/part is worth
3. **Grading Guidelines**: The levels show how partial marks are awarded
4. **Specific Solutions**: Includes worked examples or detailed solutions where applicable

## Example Answer Key Criteria:

### For Multiple Choice Questions:
```javascript
{
  name: "Question 2: Which is NOT a benefit of containerization?",
  description: "Correct Answer: Option C - Increased application size\n\nMarking: 1 point for correct answer. 0 points for incorrect.",
  maxPoints: 1,
  levels: [
    {
      level: "Correct",
      points: 1,
      description: "Student selected Option C"
    },
    {
      level: "Incorrect",
      points: 0,
      description: "Student selected any other option"
    }
  ]
}
```

### For Calculation Questions:
```javascript
{
  name: "Question 3: Calculate deployment frequency",
  description: "Model Solution:\nGiven: 120 deployments in 30 days\nDeployment frequency = Total deployments / Number of days\n= 120 / 30\n= 4 deployments per day\n\nMarking: 5 points for correct calculation, 3 points for correct formula but wrong arithmetic, 1 point for partial attempt.",
  maxPoints: 5,
  levels: [
    {
      level: "Full Marks (5 points)",
      points: 5,
      description: "Correct calculation: 4 deployments per day"
    },
    {
      level: "Partial Marks (3 points)",
      points: 3,
      description: "Correct formula used but calculation error"
    },
    {
      level: "Partial Marks (1 point)",
      points: 1,
      description: "Shows understanding but incorrect approach"
    },
    {
      level: "No Marks (0 points)",
      points: 0,
      description: "Incorrect or no answer"
    }
  ]
}
```

### For Essay Questions:
```javascript
{
  name: "Question 4: Compare monolithic vs microservices architecture",
  description: "Model Answer should cover:\n\n1. Monolithic Architecture:\n   - Single, unified application\n   - All components tightly coupled\n   - Easier initial development\n   - Harder to scale and maintain\n\n2. Microservices Architecture:\n   - Multiple independent services\n   - Loosely coupled components\n   - More complex initial setup\n   - Easier to scale and maintain\n\n3. Key Differences:\n   - Deployment: Monolithic = single deployment, Microservices = independent deployments\n   - Scalability: Monolithic = scale entire app, Microservices = scale individual services\n   - Technology: Monolithic = single stack, Microservices = multiple stacks\n\nMarking Allocation:\n- Comprehensive comparison (12-15 points)\n- Good comparison with minor gaps (9-11 points)\n- Basic comparison missing key points (6-8 points)\n- Inadequate comparison (0-5 points)",
  maxPoints: 15,
  levels: [
    {
      level: "Excellent (12-15 points)",
      points: 15,
      description: "Comprehensive comparison covering all three aspects with clear explanations and examples"
    },
    {
      level: "Good (9-11 points)",
      points: 11,
      description: "Good comparison covering most aspects but may miss some details"
    },
    {
      level: "Fair (6-8 points)",
      points: 8,
      description: "Basic comparison but missing significant aspects or has inaccuracies"
    },
    {
      level: "Poor (0-5 points)",
      points: 5,
      description: "Inadequate comparison, missing most key points or incorrect information"
    }
  ]
}
```

## Detection Keywords

The system will detect your document as a memo if it contains keywords like:
- "memo" or "memorandum"
- "answer key" or "answer sheet"
- "model answer" or "sample answer"
- "correct answer" or "expected answer"
- "solution" or "marking scheme"
- "examiner's guide"

## Tips for Creating Answer Keys:

1. **Include the Question**: Start each criterion name with the question number and brief description
2. **Provide Model Answers**: Put the correct/expected answer in the description field
3. **Show Marking Scheme**: Clearly indicate how points are allocated
4. **Include Partial Credit Guidelines**: Use levels to show how partial marks are awarded
5. **Be Specific**: Include worked examples, calculations, or detailed explanations
6. **Match Question Structure**: Organize criteria to match the question paper structure

## When Uploading:

1. Go to the "Rubrics" tab
2. Click "Create Rubric" or "Upload Rubric"
3. Structure your answer key as a rubric (as shown above)
4. The system will automatically detect it as a memo
5. Use it to mark question papers in the "Marking" tab

The system will compare student answers against the model answers in your memo and award marks accordingly!





