const { query } = require('./server/database/connection');

const inspectDatabase = async () => {
  try {
    console.log('Inspecting database...');
    
    const result = await query('SELECT * FROM assignments ORDER BY uploaded_at DESC');
    console.log('Assignments:', JSON.stringify(result.rows, null, 2));
    
    // Check if there are any files in uploads directory
    const fs = require('fs');
    const path = require('path');
    const uploadsDir = './uploads';
    
    if (fs.existsSync(uploadsDir)) {
      const files = fs.readdirSync(uploadsDir);
      console.log('Files in uploads directory:', files);
    } else {
      console.log('Uploads directory does not exist');
    }
    
  } catch (error) {
    console.error('Error:', error);
  }
};

inspectDatabase().then(() => {
  process.exit(0);
});
