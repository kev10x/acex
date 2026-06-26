/**
 * Seed script to create user kkativu@gmail.com with password An1m0s1t###
 * and assign all existing data to this user
 */

require('dotenv').config();
const { query, initDatabase } = require('./server/database/connection');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');

async function seedUser() {
  try {
    console.log('Starting user seeding...');
    
    // Check if DATABASE_URL is set
    if (!process.env.DATABASE_URL) {
      console.error('❌ Error: DATABASE_URL environment variable is not set!');
      console.log('\nPlease set DATABASE_URL in your .env file:');
      console.log('  For MySQL: DATABASE_URL=mysql://user:password@localhost:3306/database');
      console.log('  For PostgreSQL: DATABASE_URL=postgresql://user:password@localhost:5432/database');
      console.log('  For SQLite: DATABASE_URL=sqlite:./database.sqlite');
      process.exit(1);
    }
    
    console.log(`Using database: ${process.env.DATABASE_URL.replace(/:[^:@]+@/, ':****@')}`);
    
    // Initialize database
    await initDatabase();
    
    // Normalize email (same as login route does)
    const email = 'kkativu@gmail.com'.toLowerCase().trim();
    const password = 'An1m0s1###';
    
    console.log(`Email (normalized): ${email}`);
    
    // Check if user already exists
    let userResult = await query(
      'SELECT id, email FROM users WHERE LOWER(email) = $1',
      [email]
    );
    
    let userId;
    const user = userResult.rows?.[0] || userResult?.[0];
    
    if (user) {
      console.log(`User already exists: ${user.email} (ID: ${user.id})`);
      userId = user.id;
      
      // Update password and ensure email is normalized, set as admin
      const saltRounds = 10;
      const passwordHash = await bcrypt.hash(password, saltRounds);
      await query(
        'UPDATE users SET password_hash = $1, email = $2, is_active = 1, role = $3, is_approved = 1, email_verified = 1 WHERE id = $4',
        [passwordHash, email, 'admin', userId]
      );
      console.log('✓ Password, email, and admin status updated');
    } else {
      // Create new user with normalized email
      const saltRounds = 10;
      const passwordHash = await bcrypt.hash(password, saltRounds);
      
      const createResult = await query(
        'INSERT INTO users (email, password_hash, name, is_active, role, is_approved, email_verified) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [email, passwordHash, 'Kkativu', 1, 'admin', 1, 1]
      );
      
      // For MySQL, get the insertId from the result
      userId = createResult.insertId || createResult.lastID;
      
      // If insertId is not available, query for the user
      if (!userId) {
        const userCheck = await query(
          'SELECT id FROM users WHERE email = $1',
          [email]
        );
        userId = (userCheck.rows?.[0] || userCheck?.[0])?.id;
      }
      
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
    console.log(`  Role: Admin`);
    console.log(`  Status: Verified and Approved`);
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
