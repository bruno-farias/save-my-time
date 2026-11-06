// Local contract fixtures, not a language model. Never deploy this test server.
const http = require('node:http');
const requests = [];
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function readBody(req) {
  if (req.body !== undefined) return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/_requests') return json(res, 200, { requests });
    if (req.method === 'GET' && ['/api/tags', '/v1/models', '/v1beta/models'].includes(url.pathname)) {
      const provider = url.pathname === '/api/tags' ? 'ollama' : url.pathname === '/v1beta/models' ? 'gemini' : req.headers['anthropic-version'] ? 'anthropic' : 'openai';
      const key = provider === 'openai' ? (req.headers.authorization || '').replace(/^Bearer /, '') : provider === 'anthropic' ? req.headers['x-api-key'] : provider === 'gemini' ? req.headers['x-goog-api-key'] : '';
      if (provider === 'anthropic' && (req.headers['anthropic-version'] !== '2023-06-01' || req.headers['anthropic-dangerous-direct-browser-access'] !== 'true')) return json(res, 400, { error: 'Missing browser/version headers' });
      if (url.searchParams.has('key')) return json(res, 400, { error: 'Keys must not appear in URLs' });
      if (provider !== 'ollama' && !/^fake-test-key(?:-(?:auth|forbidden|quota|html|invalid|empty|slow|repeat|redirect|alternate))?$/.test(key || '')) return json(res, 401, { error: 'Fixture requires fake test credentials' });
      const scenario = req.headers['x-fixture-scenario'] || key?.replace('fake-test-key-', '') || 'success';
      requests.push({ provider, method: 'GET', path: req.url, scenario });
      if (requests.length > 200) requests.shift();
      if (scenario === 'auth') return json(res, 401, { error: 'PRIVATE_KEY_ECHO' });
      if (scenario === 'forbidden') return json(res, 403, { error: 'PRIVATE_KEY_ECHO' });
      if (scenario === 'quota') return json(res, 429, { error: 'PRIVATE_KEY_ECHO' });
      if (scenario === 'html') { res.writeHead(502, { 'Content-Type': 'text/html' }); return res.end('<html>PRIVATE_SERVER_DATA</html>'); }
      if (scenario === 'invalid') return json(res, 200, { models: 'not-an-array', data: 'not-an-array' });
      if (scenario === 'redirect') { res.writeHead(302, { Location: '/never-follow' }); return res.end(); }
      if (scenario === 'slow') await delay(1_500);
      if (res.destroyed) return;
      if (scenario === 'empty') return json(res, 200, { models: [], data: [], has_more: false });
      if (provider === 'ollama') return json(res, 200, { models: [{ name: 'simulate-success' }, { name: 'simulate-slow' }, { name: 'simulate-success' }] });
      if (provider === 'openai') return json(res, 200, { data: (scenario === 'alternate' ? ['gpt-fixture-alternate'] : ['gpt-4.1-mini', 'gpt-fixture-chat', 'ft:gpt-4.1-mini:custom', 'text-embedding-3-small', 'gpt-4o-transcribe', 'dall-e-3', 'gpt-4.1-mini']).map(id => ({ id })) });
      if (provider === 'anthropic') {
        const next = url.searchParams.has('after_id');
        return json(res, 200, { data: [{ id: next ? 'claude-fixture-older' : 'claude-fixture-new', display_name: next ? 'Claude Fixture Older' : 'Claude Fixture New' }], has_more: !next || scenario === 'repeat', last_id: 'claude-fixture-new' });
      }
      const next = url.searchParams.has('pageToken');
      return json(res, 200, { models: [{ name: `models/${next ? 'gemini-fixture-older' : 'gemini-fixture-new'}`, displayName: next ? 'Gemini Fixture Older' : 'Gemini Fixture New', supportedGenerationMethods: ['generateContent', 'countTokens'] }, { name: 'models/embedding-only', supportedGenerationMethods: ['embedContent'] }], ...(!next || scenario === 'repeat' ? { nextPageToken: 'opaque/token+=1' } : {}) });
    }
    const provider = url.pathname === '/api/chat' ? 'ollama'
      : url.pathname === '/v1/chat/completions' ? 'openai'
      : url.pathname === '/v1/messages' ? 'anthropic'
      : /^\/v1beta\/models\/[^/]+:streamGenerateContent$/.test(url.pathname) ? 'gemini' : null;
    if (req.method !== 'POST' || !provider) return json(res, 501, { error: { message: 'This route is not modeled by the extension contract fixture.' } });
    const body = await readBody(req);
    const model = provider === 'gemini' ? decodeURIComponent(url.pathname.split('/').at(-1).split(':')[0]) : body.model;
    if (provider === 'openai' && req.headers.authorization !== 'Bearer fake-test-key') return json(res, 401, { error: { message: 'Fixture requires the fake test key.' } });
    if (provider === 'anthropic' && (req.headers['x-api-key'] !== 'fake-test-key' || req.headers['anthropic-version'] !== '2023-06-01')) return json(res, 401, { error: { message: 'Missing Claude contract headers.' } });
    if (provider === 'gemini' && (req.headers['x-goog-api-key'] !== 'fake-test-key' || url.searchParams.get('alt') !== 'sse')) return json(res, 401, { error: { message: 'Missing Gemini contract headers or SSE query.' } });
    if (!model || (provider !== 'gemini' && (!Array.isArray(body.messages) || body.stream !== true))) return json(res, 400, { error: { message: 'Missing required model, messages, or stream.' } });
    if (provider === 'anthropic' && (!body.max_tokens || !body.system || body.messages.some(m => !['user', 'assistant'].includes(m.role)))) return json(res, 400, { error: { message: 'Invalid Claude payload.' } });
    if (provider === 'gemini' && (!Array.isArray(body.contents) || !body.systemInstruction || body.contents.some(m => !['user', 'model'].includes(m.role)))) return json(res, 400, { error: { message: 'Invalid Gemini payload.' } });
    requests.push({ provider, method: req.method, path: req.url, model, body });
    if (requests.length > 100) requests.shift();
    if (model === 'simulate-auth') return json(res, 401, { error: { message: 'Invalid key' } });
    if (model === 'simulate-quota') return json(res, 429, { error: { message: 'Quota exceeded' } });
    if (model === 'simulate-missing') return json(res, 404, { error: { message: 'Model not found' } });
    if (model === 'simulate-html') { res.writeHead(502, { 'Content-Type': 'text/html' }); return res.end('<html>Gateway error with PRIVATE_SERVER_DATA</html>'); }
    if (model === 'simulate-slow') await delay(1_200);
    if (res.destroyed) return;
    res.writeHead(200, { 'Content-Type': provider === 'ollama' ? 'application/x-ndjson' : 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.flushHeaders();
    const send = object => {
      if (res.destroyed) return;
      const data = typeof object === 'string' ? object : JSON.stringify(object);
      res.write(provider === 'ollama' ? `${data}\n` : `data: ${data}\r\n\r\n`);
    };
    if (model === 'simulate-malformed') { send('{invalid-json'); return res.end(); }
    if (model === 'simulate-error') { send({ type: 'error', error: { message: 'The model became unavailable mid-stream.' } }); return res.end(); }
    if (model === 'simulate-blocked' && provider === 'gemini') { send({ promptFeedback: { blockReason: 'SAFETY' } }); return res.end(); }
    if (model !== 'simulate-empty') {
      const text = '**A clear takeaway.**\n\n- Protect your attention.\n- Make room for rest.\n\nOlá, 世界. These are suggestions, not universal evidence.';
      for (const delta of text.match(/.{1,14}/gs)) {
        if (res.destroyed) return;
        if (provider === 'ollama') send({ message: { role: 'assistant', content: delta }, done: false });
        if (provider === 'openai') send({ choices: [{ delta: { content: delta }, finish_reason: null }] });
        if (provider === 'anthropic') send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta } });
        if (provider === 'gemini') send({ candidates: [{ content: { role: 'model', parts: [{ thought: true, text: 'INTERNAL_THOUGHT' }, { text: delta }] } }] });
        await delay(model === 'simulate-slow' ? 120 : 3);
      }
    }
    if (model === 'simulate-drop') return res.end();
    const limited = model === 'simulate-length';
    if (provider === 'ollama') send({ message: { role: 'assistant', content: '' }, done: true, done_reason: limited ? 'length' : 'stop' });
    if (provider === 'openai') { send({ choices: [{ delta: {}, finish_reason: limited ? 'length' : 'stop' }] }); send('[DONE]'); }
    if (provider === 'anthropic') { send({ type: 'message_delta', delta: { stop_reason: limited ? 'max_tokens' : 'end_turn' } }); send({ type: 'message_stop' }); }
    if (provider === 'gemini') send({ candidates: [{ finishReason: limited ? 'MAX_TOKENS' : 'STOP' }] });
    res.end();
  } catch { if (!res.headersSent) json(res, 500, { error: { message: 'Fixture rejected an invalid request.' } }); else res.end(); }
}).listen(process.env.PORT || 4500);
