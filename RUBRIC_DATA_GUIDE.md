# Rubric Data Management Guide

This guide explains how to add and manage rubric data in your MarkMate application.

## Quick Start

### 1. Add Sample Rubrics
```bash
node add-rubric-data.js add
```
This adds two pre-built rubrics:
- **Research Report Rubric - IEMT302** (100 points)
- **General Assignment Rubric** (100 points)

### 2. List All Rubrics
```bash
node add-rubric-data.js list
```
Shows all rubrics currently in the database.

### 3. Add Custom Rubric
```bash
node add-rubric-data.js custom
```
Adds an example custom rubric.

## Rubric Structure

Each rubric follows this structure:

```javascript
{
  name: "Rubric Name",
  criteria: [
    {
      name: "Criterion Name",
      description: "What this criterion evaluates",
      maxPoints: 25,
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
    }
    // Add more criteria...
  ],
  totalPoints: 100 // Sum of all maxPoints
}
```

## Creating Custom Rubrics

### Method 1: Use the Template
1. Open `rubric-template.js`
2. Copy one of the example rubrics
3. Modify the values to match your needs
4. Use the `addCustomRubric()` function

### Method 2: Direct Database Insert
```javascript
const { addCustomRubric } = require('./add-rubric-data.js');

const myRubric = {
  name: "My Custom Rubric",
  criteria: [
    // Your criteria here
  ],
  totalPoints: 100
};

addCustomRubric(myRubric);
```

## Available Scripts

| Command | Description |
|---------|-------------|
| `node add-rubric-data.js add` | Add sample rubrics to database |
| `node add-rubric-data.js list` | List all rubrics in database |
| `node add-rubric-data.js custom` | Add example custom rubric |

## Testing the Application

1. **Start the application:**
   ```bash
   npm run dev
   ```

2. **Open in browser:**
   - Go to http://localhost:3000

3. **Test workflow:**
   - Upload a PDF file
   - Select a rubric from the dropdown
   - Test the marking functionality (without AI for now)

## Database Schema

The rubrics are stored in the `rubrics` table with this structure:
- `id` - Auto-increment primary key
- `name` - Rubric name (VARCHAR)
- `criteria` - JSON object containing all criteria and levels
- `total_points` - Total points for the rubric (INT)
- `created_at` - Timestamp of creation

## Troubleshooting

### Connection Issues
- Ensure MySQL is running
- Check database credentials in the script
- Verify database `markmate` exists

### Data Issues
- Check JSON format of criteria
- Ensure total_points matches sum of criterion maxPoints
- Verify all required fields are present

## Example Rubrics Included

### 1. Research Report Rubric - IEMT302
- **Research Quality** (25 points)
- **Content Analysis** (30 points)
- **Writing Quality** (20 points)
- **Critical Thinking** (25 points)

### 2. General Assignment Rubric
- **Understanding** (30 points)
- **Organization** (25 points)
- **Evidence and Support** (25 points)
- **Presentation** (20 points)

## Next Steps

Once you have rubrics in the database, you can:
1. Test the application with uploaded PDFs
2. Create more specific rubrics for different assignment types
3. Modify existing rubrics to better fit your needs
4. Use the application for actual marking (once AI quota is resolved)
