// Vercel serverless function — worker comments
// GET  /api/comments?key=cmine.s21xp003   → { comments: [{ts, text}, ...] }
// GET  /api/comments?debug=1              → diagnostic (token present, repo, github reachable)
// POST /api/comments  body: { key, text }  → { ok: true, comments: [...] }

const https = require('https');

const FILE_PATH  = 'data/worker-comments.json';
const GH_API     = 'api.github.com';

// Minimal HTTPS request helper (no external deps, works in all Node versions)
function ghRequest(opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, json: { _raw: data } }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function ghHeaders(token) {
  return {
    Authorization: `token ${token}`,
    Accept:        'application/vnd.github.v3+json',
    'Content-Type':'application/json',
    'User-Agent':  'btc-miner-monitor/1.0',
  };
}

async function getFile(token, repo) {
  const r = await ghRequest({
    hostname: GH_API,
    path:     `/repos/${repo}/contents/${FILE_PATH}`,
    method:   'GET',
    headers:  ghHeaders(token),
  });
  console.log(`GET file status: ${r.status}`);
  if (r.status === 404) return { sha: null, data: {} };
  if (r.status !== 200) throw new Error(`GitHub GET ${r.status}: ${r.json.message || JSON.stringify(r.json)}`);
  const data = JSON.parse(Buffer.from(r.json.content, 'base64').toString('utf8'));
  return { sha: r.json.sha, data };
}

async function putFile(token, repo, sha, data, message) {
  const bodyObj = {
    message,
    content: Buffer.from(JSON.stringify(data, null, 2)).toString('base64'),
  };
  if (sha) bodyObj.sha = sha;
  const bodyStr = JSON.stringify(bodyObj);

  const r = await ghRequest({
    hostname: GH_API,
    path:     `/repos/${repo}/contents/${FILE_PATH}`,
    method:   'PUT',
    headers:  { ...ghHeaders(token), 'Content-Length': Buffer.byteLength(bodyStr) },
  }, bodyStr);

  console.log(`PUT file status: ${r.status}`);
  if (r.status !== 200 && r.status !== 201) {
    throw new Error(`GitHub PUT ${r.status}: ${r.json.message || JSON.stringify(r.json)}`);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.GITHUB_TOKEN;
  const repo  = process.env.GITHUB_REPO;

  console.log(`[comments] ${req.method} | token=${token ? token.slice(0,6)+'...' : 'MISSING'} | repo=${repo || 'MISSING'}`);

  if (!token || !repo) {
    return res.status(500).json({ error: 'GITHUB_TOKEN or GITHUB_REPO not configured' });
  }

  try {
    if (req.method === 'GET') {
      const { data } = await getFile(token, repo);
      const key = req.query?.key;
      return res.status(200).json({ comments: key ? (data[key] || []) : data });

    } else if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch(e) { body = {}; }
      }
      const { key, text } = body || {};
      if (!key || !String(text || '').trim()) {
        return res.status(400).json({ error: 'key and text required' });
      }
      const { sha, data } = await getFile(token, repo);
      if (!data[key]) data[key] = [];
      data[key].push({ ts: new Date().toISOString(), text: String(text).trim() });
      await putFile(token, repo, sha, data, `comments: add note for ${key}`);
      return res.status(200).json({ ok: true, comments: data[key] });

    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (err) {
    console.error('[comments] ERROR:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
