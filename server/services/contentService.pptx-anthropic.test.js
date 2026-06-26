const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadWithMocks } = require('../test-utils/loadWithMocks');

test('buildPptx uses Anthropic pptx Skill with uploaded templates and handles pause_turn file output', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acexen-pptx-'));
  const templatePath = path.join(tmpDir, 'template.pptx');
  fs.writeFileSync(templatePath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]));
  const previousModel = process.env.ANTHROPIC_PPTX_MODEL;
  const previousContentModel = process.env.CONTENT_PPTX_MODEL;
  const previousMaxTokens = process.env.ANTHROPIC_PPTX_MAX_TOKENS;
  delete process.env.ANTHROPIC_PPTX_MODEL;
  delete process.env.CONTENT_PPTX_MODEL;
  delete process.env.ANTHROPIC_PPTX_MAX_TOKENS;
  const restoreEnv = () => {
    if (previousModel === undefined) delete process.env.ANTHROPIC_PPTX_MODEL;
    else process.env.ANTHROPIC_PPTX_MODEL = previousModel;
    if (previousContentModel === undefined) delete process.env.CONTENT_PPTX_MODEL;
    else process.env.CONTENT_PPTX_MODEL = previousContentModel;
    if (previousMaxTokens === undefined) delete process.env.ANTHROPIC_PPTX_MAX_TOKENS;
    else process.env.ANTHROPIC_PPTX_MAX_TOKENS = previousMaxTokens;
  };

  const createCalls = [];
  const uploadCalls = [];
  const downloadCalls = [];
  const generatedPptx = Buffer.from([
    0x50, 0x4b, 0x05, 0x06,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00,
  ]);

  const anthropicClient = {
    beta: {
      files: {
        upload: async (params) => {
          uploadCalls.push(params);
          params.file?.destroy?.();
          return { id: 'file_template' };
        },
        download: async (fileId, params) => {
          downloadCalls.push({ fileId, params });
          return {
            arrayBuffer: async () => generatedPptx.buffer.slice(
              generatedPptx.byteOffset,
              generatedPptx.byteOffset + generatedPptx.byteLength
            ),
          };
        },
      },
      messages: {
        create: async (params) => {
          createCalls.push(params);
          if (createCalls.length === 1) {
            return {
              stop_reason: 'pause_turn',
              container: { id: 'container_123' },
              content: [{ type: 'text', text: 'Working on the deck.' }],
            };
          }
          return {
            stop_reason: 'end_turn',
            container: { id: 'container_123' },
            content: [
              {
                type: 'bash_code_execution_tool_result',
                content: {
                  type: 'code_execution_result',
                  content: [{ type: 'file', file_id: 'file_final_pptx' }],
                },
              },
            ],
          };
        },
      },
    },
  };

  let restoreModule = () => {};
  try {
    const loaded = loadWithMocks(path.join(__dirname, 'contentService.js'), {
      './aiService': { anthropic: anthropicClient },
    });
    const contentService = loaded.module;
    restoreModule = loaded.restore;

    const output = await contentService.buildPptx({
      title: 'Photosynthesis',
      instructions: 'Explain clearly.',
      sections: [{ heading: 'Light reactions', support: 'Energy capture', body: 'Plants capture light energy.' }],
    }, {
      templatePath,
    });

    assert.deepEqual(output, generatedPptx);
    assert.equal(uploadCalls.length, 1);
    assert.equal(uploadCalls[0].betas[0], 'files-api-2025-04-14');

    assert.equal(createCalls.length, 2);
    const firstRequest = createCalls[0];
    assert.equal(firstRequest.model, 'claude-sonnet-4-6');
    assert.equal(firstRequest.max_tokens, 32000);
    assert.deepEqual(firstRequest.betas, [
      'code-execution-2025-08-25',
      'files-api-2025-04-14',
      'skills-2025-10-02',
    ]);
    assert.deepEqual(firstRequest.tools, [{ type: 'code_execution_20250825', name: 'code_execution' }]);
    assert.deepEqual(firstRequest.container.skills, [{ type: 'anthropic', skill_id: 'pptx', version: 'latest' }]);
    assert.ok(firstRequest.system.includes('You are a presentation builder.'));
    assert.ok(firstRequest.messages[0].content.some((block) => block.type === 'container_upload' && block.file_id === 'file_template'));

    const secondRequest = createCalls[1];
    assert.equal(secondRequest.container.id, 'container_123');
    assert.equal(secondRequest.messages[secondRequest.messages.length - 1].role, 'assistant');
    assert.deepEqual(secondRequest.messages[secondRequest.messages.length - 1].content, [{ type: 'text', text: 'Working on the deck.' }]);

    assert.deepEqual(downloadCalls, [{
      fileId: 'file_final_pptx',
      params: { betas: ['files-api-2025-04-14'] },
    }]);
  } finally {
    restoreModule();
    restoreEnv();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('buildPptx uses OpenAI Responses code interpreter when selected', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acexen-openai-pptx-'));
  const templatePath = path.join(tmpDir, 'template.pptx');
  fs.writeFileSync(templatePath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]));
  const generatedPptx = Buffer.from([
    0x50, 0x4b, 0x05, 0x06,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00,
  ]);

  const fileCreateCalls = [];
  const responseCreateCalls = [];
  const downloadCalls = [];
  const openAIClient = {
    files: {
      create: async (params) => {
        fileCreateCalls.push(params);
        params.file?.destroy?.();
        return { id: 'file-openai-template' };
      },
    },
    responses: {
      create: async (params) => {
        responseCreateCalls.push(params);
        return {
          status: 'completed',
          output: [{
            type: 'code_interpreter_call',
            container_id: 'cntr_123',
            results: [{
              type: 'files',
              files: [{
                file_id: 'cfile_final_pptx',
                mime_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
              }],
            }],
          }],
        };
      },
    },
    containers: {
      files: {
        content: {
          retrieve: async (containerId, fileId) => {
            downloadCalls.push({ containerId, fileId });
            return {
              arrayBuffer: async () => generatedPptx.buffer.slice(
                generatedPptx.byteOffset,
                generatedPptx.byteOffset + generatedPptx.byteLength
              ),
            };
          },
        },
      },
    },
  };

  let restoreModule = () => {};
  try {
    const loaded = loadWithMocks(path.join(__dirname, 'contentService.js'), {
      './aiService': { openai: openAIClient },
    });
    const contentService = loaded.module;
    restoreModule = loaded.restore;

    const output = await contentService.buildPptx({
      title: 'Cell division',
      sections: [{ heading: 'Mitosis', support: 'Growth and repair', body: 'Cells divide in ordered phases.' }],
    }, {
      templatePath,
      provider: 'openai',
    });

    assert.deepEqual(output, generatedPptx);
    assert.equal(fileCreateCalls.length, 1);
    assert.equal(fileCreateCalls[0].purpose, 'assistants');
    assert.equal(responseCreateCalls.length, 1);
    const request = responseCreateCalls[0];
    assert.equal(request.model, 'gpt-5.2');
    assert.equal(request.max_output_tokens, 16000);
    assert.equal(request.tools[0].type, 'code_interpreter');
    assert.deepEqual(request.tools[0].container.file_ids, ['file-openai-template']);
    assert.ok(request.instructions.includes('OpenAI Code Interpreter'));
    assert.ok(request.input[0].content.some((block) => block.type === 'input_file' && block.file_id === 'file-openai-template'));
    assert.deepEqual(downloadCalls, [{ containerId: 'cntr_123', fileId: 'cfile_final_pptx' }]);
  } finally {
    restoreModule();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
