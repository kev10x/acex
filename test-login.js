/**
 * Test script to verify user login
 * This helps diagnose login issues
 */

require('dotenv').config();
const { query, initDatabase } = require('./server/database/connection');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');

async function testLogin() {
  try {
    console.log('Testing user login...\n');
    
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
    
    // Normalize email (same as login route)
    const normalizedEmail = email.toLowerCase().trim();
    
    console.log(`Looking for user: ${email} (normalized: ${normalizedEmail})`);
    
    // Find user (case-insensitive search)
    const result = await query(
      'SELECT id, email, password_hash, name, is_active FROM users WHERE LOWER(email) = $1',
      [normalizedEmail]
    );
    
    const user = result.rows?.[0] || result?.[0];
    
    if (!user) {
      console.error('❌ User not found in database!');
      console.log('\nAvailable users:');
      const allUsers = await query('SELECT id, email, name FROM users');
      const users = allUsers.rows || allUsers;
      if (users.length === 0) {
        console.log('  No users found in database');
      } else {
        users.forEach(u => {
          console.log(`  - ${u.email} (ID: ${u.id}, Name: ${u.name || 'N/A'})`);
        });
      }
      process.exit(1);
    }
    
    console.log('✓ User found:');
    console.log(`  ID: ${user.id}`);
    console.log(`  Email: ${user.email}`);
    console.log(`  Name: ${user.name || 'N/A'}`);
    console.log(`  Active: ${user.is_active}`);
    console.log(`  Password hash: ${user.password_hash ? user.password_hash.substring(0, 20) + '...' : 'MISSING'}`);
    
    if (!user.is_active) {
      console.error('\n❌ User account is inactive!');
      process.exit(1);
    }
    
    if (!user.password_hash) {
      console.error('\n❌ User has no password hash!');
      process.exit(1);
    }
    
    // Test password
    console.log('\nTesting password...');
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    
    if (passwordMatch) {
      console.log('✓ Password matches!');
      console.log('\n✅ Login should work. If it doesn\'t, check:');
      console.log('  1. Server is running');
      console.log('  2. API endpoint is correct');
      console.log('  3. Email normalization (try lowercase)');
      console.log('  4. Browser console for errors');
    } else {
      console.error('❌ Password does NOT match!');
      console.log('\nPossible issues:');
      console.log('  1. Password was hashed incorrectly');
      console.log('  2. Wrong password in script');
      console.log('  3. Password was changed after seeding');
      console.log('\nRe-running seed script to update password...');
      
      // Update password
      const saltRounds = 10;
      const newPasswordHash = await bcrypt.hash(password, saltRounds);
      await query(
        'UPDATE users SET password_hash = $1 WHERE id = $2',
        [newPasswordHash, user.id]
      );
      console.log('✓ Password updated. Try logging in again.');
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

testLogin()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('Test error:', error);
    process.exit(1);
  });
