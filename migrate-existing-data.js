/**
 * Migration script to assign existing data to a default user
 * Run this after setting up authentication to migrate existing data
 * 
 * Usage: node migrate-existing-data.js <email> <password>
 * 
 * This will:
 * 1. Create a user with the provided email/password (or use existing)
 * 2. Assign all existing data (assignments, rubrics, batches, marking_results) to this user
 */

require('dotenv').config();
const { query, initDatabase } = require('./server/database/connection');
const bcrypt = require('bcrypt');

async function migrateData(email, password) {
  try {
    console.log('Starting data migration...');
    
    // Initialize database
    await initDatabase();
    
    // Check if user exists
    let userResult = await query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );
    
    let userId;
    const user = userResult.rows?.[0] || userResult?.[0];
    
    if (user) {
      console.log(`Using existing user: ${email} (ID: ${user.id})`);
      userId = user.id;
    } else {
      // Create new user
      const saltRounds = 10;
      const passwordHash = await bcrypt.hash(password, saltRounds);
      
      const createResult = await query(
        'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id',
        [email, passwordHash, 'Default User']
      );
      
      userId = createResult.rows?.[0]?.id || createResult?.[0]?.id;
      console.log(`Created new user: ${email} (ID: ${userId})`);
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
    
    console.log('\n✅ Migration completed successfully!');
    console.log(`\nYou can now login with:`);
    console.log(`  Email: ${email}`);
    console.log(`  Password: ${password}`);
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

// Get command line arguments
const email = process.argv[2];
const password = process.argv[3];

if (!email || !password) {
  console.error('Usage: node migrate-existing-data.js <email> <password>');
  console.error('\nExample:');
  console.error('  node migrate-existing-data.js admin@example.com mypassword123');
  process.exit(1);
}

migrateData(email, password)
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('Migration error:', error);
    process.exit(1);
  });
