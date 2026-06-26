const aiService = require('../server/services/aiService');

const run = async () => {
  console.log('Test: valid base64 payload');
  const validObj = {
    scores: [
      { criterion_name: 'Title', points_awarded: 6, max_points: 10 }
    ],
    overall_feedback: 'Good',
    total_score: 6
  };
  const payloadB64 = Buffer.from(JSON.stringify(validObj)).toString('base64');
  const args = JSON.stringify({ payload_b64: payloadB64 });
  const res = aiService.decodeFunctionCallArguments(args);
  console.log('Result:', res);

  console.log('\nTest: invalid base64 payload');
  const badArgs = JSON.stringify({ payload_b64: 'not-a-valid-base64' });
  const res2 = aiService.decodeFunctionCallArguments(badArgs);
  console.log('Result:', res2);

  console.log('\nTest: raw arguments object (missing fields)');
  const raw = JSON.stringify({ foo: 'bar' });
  const res3 = aiService.decodeFunctionCallArguments(raw);
  console.log('Result:', res3);
};

run().catch(err => { console.error(err); process.exit(1); });
