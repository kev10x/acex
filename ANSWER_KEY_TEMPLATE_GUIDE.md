# Answer Key ODF Template Guide

This guide explains how to create and use an ODF (OpenDocument Format) template for answer keys/marking memorandums.

## Quick Start

1. Open LibreOffice Writer (or any ODF-compatible word processor)
2. Use the structure provided below
3. Save as `.odt` template file
4. Fill in your answer key information
5. Upload as a rubric in MarkMate

## Template Structure

### Header Section

```
MARKING MEMORANDUM / ANSWER KEY
[Course Name/Code]
[Exam/Test Name]
Total Marks: [Total Points]

Instructions:
- Each question should be structured as a criterion
- Include model answers in the description field
- Define marking levels for partial credit
```

### Question Template Structure

For each question, use this structure:

---

**QUESTION [NUMBER]: [Question Title]**

**Max Points:** [Points]

**Model Answer / Expected Response:**
[Write the complete correct answer here, including:
- Key points that must be covered
- Worked examples or calculations
- Specific details required
- Marking allocations for each part]

**Marking Scheme:**
- **Full Marks ([X-Y] points):** [Description of what earns full marks]
- **Partial Marks ([X-Y] points):** [Description of what earns partial marks]
- **Partial Marks ([X-Y] points):** [Description of lower partial marks]
- **No/Low Marks (0-[X] points):** [Description of what earns no or minimal marks]

---

## Detailed Template Examples

### Example 1: Short Answer Question

```
QUESTION 1: Define DevOps and explain its key principles

Max Points: 10

Model Answer:
DevOps is a set of practices that combines software development (Dev) and IT operations (Ops) to shorten the development lifecycle and provide continuous delivery with high quality.

Key principles:
1. Collaboration between development and operations teams
2. Automation of processes (CI/CD pipelines)
3. Continuous monitoring and feedback
4. Infrastructure as Code
5. Microservices architecture

Marking Scheme:
- Full Marks (9-10 points): Complete definition with all 5 principles explained clearly
- Good (7-8 points): Definition with 3-4 principles, minor gaps
- Fair (5-6 points): Basic definition with 2-3 principles, some inaccuracies
- Poor (0-4 points): Incomplete or incorrect definition, missing most principles
```

### Example 2: Calculation Question

```
QUESTION 2: Calculate deployment frequency

Max Points: 5

Model Answer:
Given: 120 deployments in 30 days

Deployment frequency = Total deployments / Number of days
= 120 / 30
= 4 deployments per day

Alternative calculation methods accepted:
- 120 ÷ 30 = 4
- 4 deployments/day

Marking Scheme:
- Full Marks (5 points): Correct calculation showing work (4 deployments/day)
- Partial (3 points): Correct formula but arithmetic error
- Partial (1 point): Shows understanding but incorrect approach
- No Marks (0 points): Incorrect or no answer
```

### Example 3: Essay Question

```
QUESTION 3: Compare monolithic and microservices architectures

Max Points: 15

Model Answer:
A comprehensive comparison should cover:

1. Monolithic Architecture:
   - Single, unified application
   - All components tightly coupled
   - Easier initial development
   - Harder to scale and maintain
   - Single technology stack
   - Single deployment unit

2. Microservices Architecture:
   - Multiple independent services
   - Loosely coupled components
   - More complex initial setup
   - Easier to scale and maintain
   - Multiple technology stacks possible
   - Independent deployments

3. Key Differences:
   - Deployment: Monolithic = single deployment, Microservices = independent deployments
   - Scalability: Monolithic = scale entire app, Microservices = scale individual services
   - Technology: Monolithic = single stack, Microservices = multiple stacks
   - Team structure: Monolithic = single team, Microservices = multiple teams
   - Fault tolerance: Monolithic = single point of failure, Microservices = isolated failures

Marking Scheme:
- Excellent (13-15 points): Comprehensive comparison covering all three sections with clear explanations and examples
- Good (10-12 points): Good comparison covering most aspects but may miss some details
- Fair (7-9 points): Basic comparison but missing significant aspects or has inaccuracies
- Poor (0-6 points): Inadequate comparison, missing most key points or incorrect information
```

### Example 4: Multiple Choice Question

```
QUESTION 4: Which is NOT a benefit of containerization?

Max Points: 1

Model Answer:
Correct Answer: Option C - Increased application size

Explanation:
Containerization provides benefits such as:
- Portability (A)
- Resource efficiency (B)
- Isolation (D)
- Consistency across environments

However, it does NOT increase application size. Containers actually help reduce overhead compared to virtual machines.

Marking Scheme:
- Correct (1 point): Student selected Option C
- Incorrect (0 points): Student selected any other option
```

## Converting Template to Rubric Format

When you're ready to upload your answer key to MarkMate:

1. **For Each Question:**
   - **Criterion Name:** "Question [N]: [Question Title]"
   - **Description:** Copy the "Model Answer" section
   - **Max Points:** Use the points value
   - **Levels:** Create levels based on your "Marking Scheme"

2. **Example Conversion:**

   Original Template:
   ```
   QUESTION 1: Define DevOps
   Max Points: 10
   Model Answer: [answer]
   Marking Scheme: [scheme]
   ```

   Converted to Rubric Criterion:
   ```json
   {
     "name": "Question 1: Define DevOps",
     "description": "Model Answer: [answer]\n\nMarking Scheme: [scheme]",
     "max_points": 10,
     "levels": [
       {
         "level": "Full Marks",
         "points": 10,
         "description": "[full marks description]"
       },
       // ... other levels
     ]
   }
   ```

## Tips for Creating Your Template

1. **Use Clear Headers:** Make questions easy to identify
2. **Be Specific:** Include all key points that must be covered
3. **Show Calculations:** Include worked examples for math problems
4. **Define Partial Credit:** Clearly specify how partial marks are awarded
5. **Include Alternative Answers:** If multiple correct answers exist, note them
6. **Add Examiner Notes:** Include any special marking considerations

## Template File Setup

### Recommended Document Settings:

- **Font:** Arial or Times New Roman, 11-12pt
- **Spacing:** 1.15 line spacing
- **Headers:** Use Heading 1 for "MARKING MEMORANDUM"
- **Subheadings:** Use Heading 2 for each question
- **Bold:** Use bold for "Max Points", "Model Answer", "Marking Scheme"

### Sections to Include:

1. **Title Page:**
   - Course name
   - Exam name
   - Date
   - Total marks

2. **Instructions:**
   - How to use the template
   - Marking guidelines

3. **Questions:**
   - One section per question
   - Use consistent formatting

4. **Appendix (Optional):**
   - Common mistakes
   - Partial credit examples
   - Examiner notes

## Using the Template

1. **Fill in the Template:**
   - Replace placeholders with actual questions
   - Add model answers
   - Define marking schemes

2. **Review:**
   - Check that all questions are included
   - Verify point totals match
   - Ensure marking schemes are clear

3. **Convert to Rubric:**
   - Go to MarkMate Rubrics tab
   - Create new rubric
   - Enter each question as a criterion
   - Copy model answers into descriptions
   - Add levels based on marking schemes

4. **Upload and Use:**
   - Save the rubric
   - Use it to mark question papers in the Marking tab

## Detection Keywords

To ensure the system recognizes your answer key as a memo, include these keywords in your document:

- "Marking Memorandum" or "Answer Key" in the title
- "Model Answer" or "Expected Answer" in headings
- "Marking Scheme" or "Marking Guide"
- "Correct Answer" or "Solution"

The system will automatically detect these and treat your rubric as a memo for marking purposes!





