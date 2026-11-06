/**
 * api/publish.js — Vercel serverless function.
 *
 * This is the ONLY place the real GitHub token lives (as the GITHUB_TOKEN
 * environment variable, set in the Vercel project settings — never in this
 * repo, never sent to the browser). editor.js POSTs the editor's login
 * credentials plus the new content.md body here; this function checks the
 * credentials, then makes the authenticated GitHub API call on the
 * browser's behalf.
 *
 * Login credentials (EDITOR_USERNAME / EDITOR_PASSWORD) are also env vars,
 * defaulting to admin/admin if unset. This is a convenience gate, not a
 * strong one — anyone who learns the credentials can publish. Change the
 * env vars in the Vercel dashboard any time to tighten this.
 */

const OWNER = 'MontaniConnect';
const REPO = 'carlos-portfolio';
const BRANCH = 'main';
const FILE_PATH = 'content.md';
const ALLOWED_ORIGIN = 'https://montaniconnect.github.io';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  const { username, password, content, sha, message } = req.body || {};

  const expectedUser = process.env.EDITOR_USERNAME || 'admin';
  const expectedPass = process.env.EDITOR_PASSWORD || 'admin';
  if (username !== expectedUser || password !== expectedPass) {
    res.status(401).json({ error: 'Invalid username or password.', reason: 'bad_login' });
    return;
  }

  if (typeof content !== 'string' || !content.trim()) {
    res.status(400).json({ error: 'Missing content.' });
    return;
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    res.status(500).json({ error: 'Server is missing the GITHUB_TOKEN environment variable.' });
    return;
  }

  try {
    let fileSha = sha;
    if (!fileSha) {
      const getRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE_PATH}?ref=${BRANCH}`, {
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` }
      });
      if (getRes.ok) fileSha = (await getRes.json()).sha;
    }

    const putRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE_PATH}`, {
      method: 'PUT',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: message || 'Update portfolio content',
        content: Buffer.from(content, 'utf8').toString('base64'),
        sha: fileSha,
        branch: BRANCH
      })
    });

    const putJson = await putRes.json();
    if (!putRes.ok) {
      if (putRes.status === 409) {
        res.status(409).json({ error: "Someone/something else changed content.md since you loaded it. Reload and re-apply your edits.", reason: 'conflict' });
        return;
      }
      if (putRes.status === 401 || putRes.status === 403) {
        res.status(putRes.status).json({
          error: `GitHub rejected the server's token (${putJson.message || 'unauthorized'}). This means GITHUB_TOKEN on Vercel is missing, wrong, expired, or lacks Contents: Read & write on this repo — check Settings > Environment Variables and redeploy after fixing it.`,
          reason: 'github_token'
        });
        return;
      }
      res.status(putRes.status).json({ error: putJson.message || 'GitHub rejected the update.', reason: 'github' });
      return;
    }

    res.status(200).json({ sha: putJson.content.sha });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Unexpected server error.' });
  }
};
