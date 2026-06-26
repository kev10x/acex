const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Usage: node scripts/reparse-failed.js --file=filename.txt OR --all
(async () => {
  const arg = process.argv.slice(2)[0] || '';
  const serverUrl = process.env.ACEXEN_SERVER || 'http://localhost:3001';
  const token = process.env.ADMIN_TOKEN || ''; // If your app uses auth, set ADMIN_TOKEN

  const params = {};
  if (arg.startsWith('--file=')) params.filename = arg.split('=')[1];
  if (arg === '--all') params.all = true;

  try {
    const resp = await axios.post(`${serverUrl}/api/ai-diagnostics/reparse`, params, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    console.log('Reparse summary:', JSON.stringify(resp.data, null, 2));
  } catch (err) {
    console.error('Reparse failed:', err.response ? err.response.data : err.message);
    process.exit(1);
  }
})();
