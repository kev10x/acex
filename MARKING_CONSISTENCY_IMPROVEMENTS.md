# Marking Consistency Improvements

This document outlines the improvements made to enhance consistency of marking across iterations.

## Key Improvements

### 1. **Lower Temperature Settings**
- Reduced temperature from 0.2-0.3 to 0.05-0.1 across all document types
- Lower temperature = more deterministic, consistent outputs
- Question papers and memos: 0.05 (very consistent)
- Assignments and reports: 0.1 (consistent but still flexible)

### 2. **Seed Parameter for Reproducibility**
- Added seed parameter based on rubric ID for OpenAI models
- Same rubric ID = same seed = more consistent outputs
- Seed ensures deterministic behavior when using the same rubric

### 3. **Previous Marking Reference**
- System now retrieves previous marking for the same assignment
- Includes previous scores in prompt for consistency
- Helps maintain consistency when re-marking the same assignment

### 4. **Calibration Examples**
- Retrieves 3 similar assignments marked with the same rubric
- Includes scoring patterns in prompt as reference
- Helps AI understand expected scoring patterns for the rubric

### 5. **Consistency Requirements in Prompt**
- Added explicit consistency requirements to the prompt:
  - Apply same marking standards across similar assignments
  - Use consistent scoring patterns
  - Maintain consistency in feedback tone and structure
  - Reference rubric criteria consistently

### 6. **Improved Prompt Determinism**
- More structured and specific instructions
- Clearer guidelines for consistent evaluation
- Better alignment with rubric criteria

## How It Works

1. **When marking an assignment:**
   - System checks for previous marking of the same assignment
   - Retrieves similar assignments marked with the same rubric
   - Generates a seed based on rubric ID
   - Includes all this information in the prompt

2. **Temperature Control:**
   - Very low temperatures (0.05-0.1) ensure minimal randomness
   - Same input + same temperature + same seed = similar outputs

3. **Few-Shot Learning:**
   - Previous markings and calibration examples act as few-shot examples
   - AI learns the expected pattern from these examples

## Benefits

- **More Consistent Scores:** Similar work receives similar scores
- **Reproducible Results:** Same assignment marked multiple times produces similar results
- **Better Calibration:** AI learns from previous markings to maintain standards
- **Reduced Variance:** Lower temperature and seed reduce random variation

## Usage

These improvements are automatic - no configuration needed. The system will:
- Automatically use lower temperatures
- Generate seeds based on rubric ID
- Include previous markings when available
- Use calibration examples for consistency

## Future Enhancements

Potential future improvements:
- Fine-tuning on your marking history
- Ensemble marking (mark multiple times and average)
- Consistency scoring (flag when results differ significantly)
- Learning from manual corrections

