// Vercel serverless function — worker comments
// GET  /api/comments?key=cmine.s21xp003   → { comments: [{ts, text}, ...] }
// POST /api/comments  body: { key, text }  → { ok: true }
//
// Stockage : data/worker-comments.json dans le repo GitHub
// Env vars Vercel requis : GITHUB_TOKEN, GITHUB_REPO (ex: "sebwebmail-arch/btc-miner-monitor")

const FILE_PATH = 'data/worker-comments.json';

async function getFileFromGitHub(token, repo) {
  const url = `https://api.github.com/repos/${repo}/contents/${FILE_PATH}`;
  const r = await fetch(url, {
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });
  if (r.status === 404) return { sha: null, data: {} };
  if (!r.ok) throw new Error(`GitHub GET failed: ${r.status}`);
  const j = await r.json();
  const content = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
  return { sha: j.sha, data: content };
}

async function writeFileToGitHub(token, repo, sha, data, message) {
  const url = `https://api.github.com/repos/${repo}/contents/${FILE_PATH}`;
  const body = {
    message,
    content: Buffer.from(JSON.stringify(data, null, 2)).toString('base64'),
  };
  if (sha) body.sha = sha;
  const r = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = await r.json();
    throw new Error(err.message || `GitHub PUT failed: ${r.status}`);
  }
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.GITHUB_TOKEN;
  const repo  = process.env.GITHUB_REPO;
  if (!token || !repo) {
    return res.status(500).json({ error: 'GITHUB_TOKEN or GITHUB_REPO not configured' });
  }

  try {
    if (req.method === 'GET') {
      const { sha, data } = await getFileFromGitHub(token, repo);
      const key = req.query.key;
      const comments = key ? (data[key] || []) : data;
      return res.status(200).json({ comments, sha });

    } else if (req.method === 'POST') {
      const { key, text } = req.body;
      if (!key || !text?.trim()) {
        return res.status(400).json({ error: 'key and text are required' });
      }

      const { sha, data } = await getFileFromGitHub(token, repo);
      if (!data[key]) data[key] = [];
      data[key].push({ ts: new Date().toISOString(), text: text.trim() });

      await writeFileToGitHub(token, repo, sha, data,
        `comments: add note for ${key}`);

      return res.status(200).json({ ok: true, comments: data[key] });

    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (err) {
    console.error('Comments API error:', err);
    return res.status(500).json({ error: err.message });
  }
}
