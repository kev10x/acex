# MarkMate - AI-Powered PDF Assignment Marking Application

MarkMate is a comprehensive web application that allows teachers to upload student assignment PDFs, create marking rubrics, and automatically grade assignments using AI. The application provides a modern, intuitive interface for managing the entire marking workflow.

## Features

### 🚀 Core Functionality
- **PDF Upload System**: Drag-and-drop interface for uploading multiple PDF assignments
- **Rubric Management**: Create, edit, and manage custom marking rubrics with multiple criteria
- **AI-Powered Marking**: Automatic assignment grading using OpenAI GPT-4 with customizable prompts
- **Results Dashboard**: View, analyze, and export marking results with confidence levels
- **Student Management**: Optional student name tracking for assignments
- **PDF Annotations**: Automatic PDF annotation with clickable comment bubbles attached to specific text
- **Assessment Types**: Support for assignments, tests, treatises, and theses
- **Educational Levels**: Customized marking for primary school, high school, undergraduate, and postgraduate
- **Confidence Scoring**: AI provides confidence levels for each assessment to flag items needing human review

### 📊 Key Capabilities
- **Multiple File Upload**: Upload single or multiple PDF files simultaneously (including ZIP files)
- **Custom Rubrics**: Define detailed marking criteria with point values and descriptions
- **Intelligent Grading**: AI analyzes assignments against rubrics and provides detailed feedback
- **Level-Appropriate Feedback**: Customized AI prompts based on educational level (primary to postgraduate)
- **Assessment-Specific Marking**: Different marking approaches for assignments, tests, treatises, and theses
- **Confidence Indicators**: Visual confidence levels (high/medium/low) for each assessment
- **Human Review Flags**: Automatic flagging of assessments with low confidence (<70%) for review
- **PDF Annotations**: Comments attached directly to relevant text in the PDF
- **Progress Tracking**: Real-time status updates during the marking process
- **Data Export**: Export results to CSV format for external analysis
- **Responsive Design**: Modern UI that works on desktop and mobile devices

## Technology Stack

### Backend
- **Node.js** with Express.js
- **PostgreSQL** database (with SQLite support)
- **OpenAI GPT-4** for AI-powered marking
- **pdf-parse** for PDF text extraction
- **Multer** for file upload handling

### Frontend
- **React 18** with TypeScript
- **Tailwind CSS** for styling
- **React Dropzone** for file uploads
- **Lucide React** for icons
- **Axios** for API communication

## Prerequisites

Before running the application, ensure you have:

- **Node.js** (v16 or higher)
- **npm** or **yarn**
- **PostgreSQL** database (or use SQLite for development)
- **OpenAI API key**

## Installation

### 1. Clone the Repository
```bash
git clone <repository-url>
cd markmate
```

### 2. Install Dependencies
```bash
# Install backend dependencies
npm install

# Install frontend dependencies
cd client
npm install
cd ..
```

### 3. Environment Configuration
Create a `.env` file in the root directory:

```env
# Database Configuration
DATABASE_URL=postgresql://username:password@localhost:5432/markmate
# For SQLite (alternative): DATABASE_URL=sqlite:./database.sqlite

# OpenAI API Configuration
OPENAI_API_KEY=your_openai_api_key_here

# Server Configuration
PORT=3001
NODE_ENV=development

# File Upload Configuration
UPLOAD_DIR=./uploads
MAX_FILE_SIZE=10485760

# Client URL (for CORS)
CLIENT_URL=http://localhost:3000
```

### 4. Database Setup
The application will automatically create the necessary database tables on startup. Ensure your PostgreSQL database exists and is accessible with the provided connection string.

### 5. Start the Application

#### Development Mode (Recommended)
```bash
# Start both backend and frontend concurrently
npm run dev
```

#### Manual Start
```bash
# Terminal 1 - Backend
npm run server

# Terminal 2 - Frontend
npm run client
```

The application will be available at:
- **Frontend**: http://localhost:3000
- **Backend API**: http://localhost:3001

## Usage Guide

### 1. Upload Assignments
1. Navigate to the "Upload PDFs" tab
2. Drag and drop PDF files or click to select them
3. Wait for upload confirmation
4. View uploaded assignments in the list

### 2. Create Rubrics
1. Go to the "Manage Rubrics" tab
2. Click "New Rubric"
3. Enter rubric name and add criteria:
   - Criterion name
   - Maximum points
   - Description
4. Save the rubric for future use

### 3. Mark Assignments
1. Switch to the "Mark Assignments" tab
2. **Select Assessment Settings**:
   - Choose assessment type (Assignment, Test, Treatise, or Thesis)
   - Select educational level (Primary School, High School, Undergraduate, or Postgraduate)
3. Select output type (Annotate PDF or Create Assessment Report)
4. Select a rubric from the available options
5. Choose assignments to mark (checkboxes)
6. Optionally add student names
7. Click "Mark Selected Assignments"
8. Wait for AI processing to complete
9. View annotated PDFs with clickable comment bubbles attached to relevant text

### 4. View Results
1. Go to the "View Results" tab
2. Browse all marking results with confidence indicators
3. **Low confidence assessments** are automatically flagged with a "Review" badge
4. Click the eye icon to view detailed feedback including:
   - Per-criterion confidence scores
   - Overall confidence level
   - Minimum criterion confidence
   - Review recommendations
5. Click the green checkmark icon to view annotated PDFs with comments
6. Export results to CSV if needed
7. View statistics and analytics

## API Endpoints

### Upload Endpoints
- `POST /api/upload/single` - Upload single PDF
- `POST /api/upload/multiple` - Upload multiple PDFs
- `GET /api/upload` - Get all assignments
- `DELETE /api/upload/:id` - Delete assignment

### Rubric Endpoints
- `POST /api/rubrics` - Create rubric
- `GET /api/rubrics` - Get all rubrics
- `GET /api/rubrics/:id` - Get specific rubric
- `PUT /api/rubrics/:id` - Update rubric
- `DELETE /api/rubrics/:id` - Delete rubric

### Marking Endpoints
- `POST /api/mark/single` - Mark single assignment
- `POST /api/mark/multiple` - Mark multiple assignments

### Results Endpoints
- `GET /api/results` - Get all results
- `GET /api/results/:id` - Get specific result
- `GET /api/results/export/csv` - Export results to CSV
- `GET /api/results/stats/overview` - Get statistics
- `DELETE /api/results/:id` - Delete result

## Database Schema

### Tables
- **rubrics**: Stores marking rubrics with criteria
- **assignments**: Stores uploaded PDF file information
- **marking_results**: Stores AI-generated marking results

### Key Fields
- Rubrics include JSON criteria and total points
- Assignments track file paths and processing status
- Results include scores, feedback, and timestamps

## Configuration Options

### File Upload
- Maximum file size: 10MB (configurable)
- Supported formats: PDF only
- Storage: Local filesystem (configurable for cloud storage)

### AI Marking
- Model: GPT-4o for complex documents, GPT-4o-mini for simpler assignments
- Temperature: Varies by document type (0.1-0.3 for optimal consistency)
- Max tokens: 3000-12000 depending on document type
- **Confidence Scoring**: AI provides 0-100 confidence scores for each criterion
- **Custom Prompts**: Level and assessment-type specific prompts for appropriate feedback

### Database
- Primary: PostgreSQL (production)
- Alternative: SQLite (development)
- Auto-migration on startup

## Security Features

- File type validation (PDF only)
- File size limits
- Input sanitization
- CORS protection
- Environment variable protection for API keys

## Troubleshooting

### Common Issues

1. **Database Connection Error**
   - Verify DATABASE_URL is correct
   - Ensure PostgreSQL is running
   - Check database permissions

2. **OpenAI API Error**
   - Verify OPENAI_API_KEY is set
   - Check API key validity
   - Ensure sufficient API credits

3. **File Upload Issues**
   - Check file size limits
   - Verify file is PDF format
   - Ensure upload directory permissions

4. **Frontend Not Loading**
   - Verify both servers are running
   - Check CORS configuration
   - Clear browser cache

### Development Tips

- Use browser developer tools for debugging
- Check server logs for backend issues
- Monitor network requests in browser
- Verify environment variables are loaded

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Support

For support and questions:
- Create an issue in the repository
- Check the troubleshooting section
- Review the API documentation

## New Features (Latest Version)

### Assessment Type & Level Selection
- **Assessment Types**: Choose from Assignment, Test, Treatise, or Thesis
- **Educational Levels**: Select Primary School, High School, Undergraduate, or Postgraduate
- **Customized AI Prompts**: The AI automatically adjusts its language, terminology, and feedback style based on your selections
- **Level-Appropriate Feedback**: 
  - Primary School: Simple, encouraging language
  - High School: Clear, supportive feedback
  - Undergraduate: Academic, analytical feedback
  - Postgraduate: Scholarly, rigorous feedback

### Confidence Scoring System
- **Per-Criterion Confidence**: Each marking criterion receives a confidence score (0-100)
- **Overall Confidence**: Aggregate confidence score for the entire assessment
- **Visual Indicators**: Color-coded badges (High/Medium/Low) in the results dashboard
- **Human Review Flags**: Assessments with confidence < 70% are automatically flagged for review
- **Review Recommendations**: Clear indicators showing which assessments need human verification

### PDF Annotations
- **Clickable Comment Bubbles**: Comments appear as PDF annotations (sticky notes) attached to relevant text
- **Non-Intrusive**: Comments don't cover the student's work - they appear as small icons
- **Text-Attached**: Comments are positioned near the relevant questions/answers when possible
- **Standard PDF Feature**: Works with all PDF viewers (Adobe, Chrome, Edge, etc.)
- **Toggle Comments**: Comments can be shown/hidden in PDF viewers

## Quick Start Guide

### For High School Teachers
See `MARKMATE_HIGH_SCHOOL_GUIDE.md` for a detailed guide tailored to high school use cases.

### For University Lecturers
1. Select "Undergraduate" or "Postgraduate" as the educational level
2. Choose the appropriate assessment type (Assignment, Test, Treatise, or Thesis)
3. The AI will automatically use appropriate academic terminology and standards

### For Primary School Teachers
1. Select "Primary School" as the educational level
2. Choose "Assignment" or "Test" as the assessment type
3. The AI will provide age-appropriate, encouraging feedback

## Configuration Examples

### Example .env File
```env
# Database (use SQLite for easy setup)
DATABASE_URL=sqlite:./database.sqlite

# OpenAI API Key (required)
OPENAI_API_KEY=sk-your-api-key-here

# Server Configuration
PORT=3001
NODE_ENV=development

# Client URL
REACT_APP_API_URL=http://localhost:3001/api
```

## Troubleshooting

### PDF Annotations Not Appearing
- Ensure you selected "Annotate PDF" as the output type (not "Create Assessment Report")
- Check server console logs for annotation errors
- Verify the PDF has extractable text (not just images)

### Low Confidence Scores
- Low confidence (< 70%) indicates the AI is uncertain about the marking
- Review these assessments manually
- Consider providing more detailed rubrics
- Check if the student's work is clear and complete

### Comments Appearing in Wrong Location
- Comments attach to text when anchor phrases are found
- If no match is found, comments appear in the right margin
- The AI generates anchor phrases automatically from the feedback

## Future Enhancements

- [ ] User authentication and authorization
- [ ] Cloud storage integration (AWS S3, Google Cloud)
- [ ] Advanced analytics and reporting
- [ ] Batch processing improvements
- [ ] Mobile app development
- [ ] Integration with learning management systems
- [ ] Custom AI model training
- [ ] Multi-language support

---

**MarkMate** - Making assignment marking efficient, accurate, and effortless with AI technology.

**Repository**: https://github.com/kev10x/MarkMate.git

