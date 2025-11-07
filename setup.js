const fs = require('fs');
const path = require('path');

console.log('🚀 Setting up MarkMate...\n');

// Check if .env file exists
if (!fs.existsSync('.env')) {
  console.log('📝 Creating .env file from template...');
  fs.copyFileSync('env.example', '.env');
  console.log('✅ .env file created! Please edit it with your configuration.\n');
} else {
  console.log('✅ .env file already exists.\n');
}

// Create uploads directory
const uploadsDir = './uploads';
if (!fs.existsSync(uploadsDir)) {
  console.log('📁 Creating uploads directory...');
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log('✅ Uploads directory created!\n');
} else {
  console.log('✅ Uploads directory already exists.\n');
}

console.log('🎉 Setup complete! Next steps:');
console.log('1. Edit .env file with your OpenAI API key');
console.log('2. Run: npm run dev');
console.log('3. Open http://localhost:3000 in your browser\n');

console.log('📚 For detailed instructions, see README.md');

