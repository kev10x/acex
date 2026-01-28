/**
 * Fix user login issues
 * This script will:
 * 1. Find the user
 * 2. Normalize the email
 * 3. Reset the password
 * 4. Ensure user is active
 */

require('dotenv').config();
const { query, initDatabase } = require('./server/database/connection');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');

async function fixUserLogin() {
  try {
    console.log('Fixing user login...\n');
    
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
    
    const email = 'kkativu@gmail.com';
    const password = 'An1m0s1t###';
    const normalizedEmail = email.toLowerCase().trim();
    
    console.log(`Email: ${email}`);
    console.log(`Normalized: ${normalizedEmail}`);
    console.log(`Password: ${password}\n`);
    
    // Find user (case-insensitive)
    let userResult = await query(
      'SELECT id, email, password_hash, name, is_active FROM users WHERE LOWER(email) = $1',
      [normalizedEmail]
    );
    
    let user = userResult.rows?.[0] || userResult?.[0];
    
    if (!user) {
      console.log('User not found. Creating new user...');
      
      // Create new user
      const saltRounds = 10;
      const passwordHash = await bcrypt.hash(password, saltRounds);
      
      const createResult = await query(
        'INSERT INTO users (email, password_hash, name, is_active) VALUES ($1, $2, $3, $4) RETURNING id',
        [normalizedEmail, passwordHash, 'Kkativu', 1]
      );
      
      const userId = createResult.rows?.[0]?.id || createResult?.[0]?.id;
      console.log(`✓ Created new user: ${normalizedEmail} (ID: ${userId})`);
      
      // Assign existing data
      await query('UPDATE assignments SET user_id = $1 WHERE user_id IS NULL', [userId]);
      await query('UPDATE rubrics SET user_id = $1 WHERE user_id IS NULL', [userId]);
      await query('UPDATE batches SET user_id = $1 WHERE user_id IS NULL', [userId]);
      await query('UPDATE marking_results SET user_id = $1 WHERE user_id IS NULL', [userId]);
      console.log('✓ Assigned existing data to user');
      
    } else {
      console.log(`Found existing user: ${user.email} (ID: ${user.id})`);
      console.log(`Current email in DB: ${user.email}`);
      console.log(`Is active: ${user.is_active}`);
      
      // Fix email normalization
      if (user.email !== normalizedEmail) {
        console.log(`\n⚠ Email mismatch! Updating email from "${user.email}" to "${normalizedEmail}"`);
        await query(
          'UPDATE users SET email = $1 WHERE id = $2',
          [normalizedEmail, user.id]
        );
        console.log('✓ Email normalized');
      }
      
      // Reset password
      const saltRounds = 10;
      const passwordHash = await bcrypt.hash(password, saltRounds);
      await query(
        'UPDATE users SET password_hash = $1 WHERE id = $2',
        [passwordHash, user.id]
      );
      console.log('✓ Password reset');
      
      // Ensure user is active
      if (!user.is_active) {
        await query(
          'UPDATE users SET is_active = 1 WHERE id = $1',
          [user.id]
        );
        console.log('✓ User activated');
      }
    }
    
    // Verify the fix
    console.log('\nVerifying fix...');
    const verifyResult = await query(
      'SELECT id, email, password_hash, name, is_active FROM users WHERE LOWER(email) = $1',
      [normalizedEmail]
    );
    
    const verifiedUser = verifyResult.rows?.[0] || verifyResult?.[0];
    
    if (verifiedUser) {
      const passwordMatch = await bcrypt.compare(password, verifiedUser.password_hash);
      
      console.log('\n✅ User fixed successfully!');
      console.log(`  Email: ${verifiedUser.email}`);
      console.log(`  Active: ${verifiedUser.is_active ? 'Yes' : 'No'}`);
      console.log(`  Password test: ${passwordMatch ? '✓ Matches' : '✗ Does not match'}`);
      
      if (passwordMatch && verifiedUser.is_active) {
        console.log('\n✅ Login should work now!');
        console.log(`  Email: ${verifiedUser.email}`);
        console.log(`  Password: ${password}`);
      } else {
        console.log('\n⚠ There may still be issues. Check the output above.');
      }
    }
    
  } catch (error) {
    console.error('❌ Fix failed:', error);
    process.exit(1);
  }
}

fixUserLogin()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('Fix error:', error);
    process.exit(1);
  });
