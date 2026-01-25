/**
 * Seed script to create user kkativu@gmail.com and assign all existing data
 */

require('dotenv').config();
const { query, initDatabase } = require('./server/database/connection');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');

async function seedUser() {
  try {
    console.log('Starting user seeding...');
    
    // Check if DATABASE_URL is set, if not, try to use SQLite
    if (!process.env.DATABASE_URL) {
      const sqlitePath = path.join(__dirname, 'database.sqlite');
      if (fs.existsSync(sqlitePath)) {
        process.env.DATABASE_URL = `sqlite:${sqlitePath}`;
        console.log(`Using SQLite database: ${sqlitePath}`);
      } else {
        // Try to create a default SQLite database
        process.env.DATABASE_URL = `sqlite:${sqlitePath}`;
        console.log(`Creating new SQLite database: ${sqlitePath}`);
      }
    }
    
    // Initialize database
    await initDatabase();
    
    const email = 'kkativu@gmail.com';
    const password = '!Pwd2wic3';
    
    // Check if user already exists
    let userResult = await query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );
    
    let userId;
    const user = userResult.rows?.[0] || userResult?.[0];
    
    if (user) {
      console.log(`User already exists: ${email} (ID: ${user.id})`);
      userId = user.id;
      
      // Update password in case it changed
      const saltRounds = 10;
      const passwordHash = await bcrypt.hash(password, saltRounds);
      await query(
        'UPDATE users SET password_hash = $1 WHERE id = $2',
        [passwordHash, userId]
      );
      console.log('✓ Password updated');
    } else {
      // Create new user
      const saltRounds = 10;
      const passwordHash = await bcrypt.hash(password, saltRounds);
      
      const createResult = await query(
        'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id',
        [email, passwordHash, 'Kkativu']
      );
      
      userId = createResult.rows?.[0]?.id || createResult?.[0]?.id;
      console.log(`✓ Created new user: ${email} (ID: ${userId})`);
    }
    
    // Migrate assignments
    const assignmentsResult = await query(
      'UPDATE assignments SET user_id = $1 WHERE user_id IS NULL',
      [userId]
    );
    const assignmentsUpdated = assignmentsResult.rowCount || assignmentsResult.changes || 0;
    console.log(`✓ Updated ${assignmentsUpdated} assignments`);
    
    // Migrate rubrics
    const rubricsResult = await query(
      'UPDATE rubrics SET user_id = $1 WHERE user_id IS NULL',
      [userId]
    );
    const rubricsUpdated = rubricsResult.rowCount || rubricsResult.changes || 0;
    console.log(`✓ Updated ${rubricsUpdated} rubrics`);
    
    // Migrate batches
    const batchesResult = await query(
      'UPDATE batches SET user_id = $1 WHERE user_id IS NULL',
      [userId]
    );
    const batchesUpdated = batchesResult.rowCount || batchesResult.changes || 0;
    console.log(`✓ Updated ${batchesUpdated} batches`);
    
    // Migrate marking_results
    const markingResultsResult = await query(
      'UPDATE marking_results SET user_id = $1 WHERE user_id IS NULL',
      [userId]
    );
    const markingResultsUpdated = markingResultsResult.rowCount || markingResultsResult.changes || 0;
    console.log(`✓ Updated ${markingResultsUpdated} marking results`);
    
    console.log('\n✅ User seeding completed successfully!');
    console.log(`\nLogin credentials:`);
    console.log(`  Email: ${email}`);
    console.log(`  Password: ${password}`);
    console.log(`\nAll existing data has been assigned to this user.`);
    
  } catch (error) {
    console.error('❌ Seeding failed:', error);
    process.exit(1);
  }
}

seedUser()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('Seeding error:', error);
    process.exit(1);
  });
