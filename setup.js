const fs = require('fs');
const path = require('path');

console.log('Setting up MarkMate...\n');

if (!fs.existsSync('.env')) {
  console.log('Creating .env file from template...');
  fs.copyFileSync('env.example', '.env');
  console.log('.env file created. Please edit it with your configuration.\n');
} else {
  console.log('.env file already exists.\n');
}

function ensureDir(dirPath, label) {
  if (!fs.existsSync(dirPath)) {
    console.log(`Creating ${label} directory...`);
    fs.mkdirSync(dirPath, { recursive: true });
    console.log(`${label} directory created.\n`);
  } else {
    console.log(`${label} directory already exists.\n`);
  }
}

const uploadsDir = './uploads';
ensureDir(uploadsDir, 'uploads');
ensureDir(path.join(uploadsDir, 'feedback-videos'), 'feedback videos');
ensureDir('./training_data', 'training data');

const readinessWarnings = [];
const envPath = path.resolve('.env');
const envContents = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

if (!/^\s*DATABASE_URL=mysql:\/\//m.test(envContents)) {
  readinessWarnings.push('DATABASE_URL is missing or not configured for MySQL/MariaDB.');
}
if (!/^\s*JWT_SECRET=(?!your-secret-key-change-in-production).+/m.test(envContents)) {
  readinessWarnings.push('JWT_SECRET is missing or still using the default placeholder.');
}
if (!/^\s*(OPENAI_API_KEY|ANTHROPIC_API_KEY)=.+/m.test(envContents)) {
  readinessWarnings.push('No AI provider API key is configured yet.');
}
if (!/^\s*CLIENT_URL=.+/m.test(envContents)) {
  readinessWarnings.push('CLIENT_URL is not set; email links may be incorrect outside local development.');
}

if (readinessWarnings.length > 0) {
  console.log('Configuration warnings:');
  readinessWarnings.forEach((warning) => console.log(` - ${warning}`));
  console.log('');
}

console.log('Setup complete! Next steps:');
console.log('1. Edit .env with your MySQL connection string, JWT secret, and provider keys');
console.log('2. Run: npm run dev');
console.log('3. Open http://localhost:3000 in your browser\n');

console.log('For detailed instructions, see the project documentation.');
