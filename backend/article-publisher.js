// Article Publisher — Blogger OAuth + Hashnode API integration
// Provides: OAuth flow for Blogger, publish/delete for both platforms
const express = require('express');
const crypto = require('crypto');
const router = express.Router();

// ============================================
// CONFIG
// ============================================
const BLOGGER_CLIENT_ID = process.env.BLOGGER_CLIENT_ID;
const BLOGGER_CLIENT_SECRET = process.env.BLOGGER_CLIENT_SECRET;
const BLOGGER_REDIRECT_URI = process.env.BLOGGER_REDIRECT_URI || 'https://eclawbot.com/api/publisher/blogger/oauth/callback';
const BLOGGER_SCOPE = 'https://www.googleapis.com/auth/blogger';
const HASHNODE_API_TOKEN = process.env.HASHNODE_API_TOKEN;
const HASHNODE_GQL_ENDPOINT = 'https://gql.hashnode.com';

// In-memory token store (per device) — production should use DB
const bloggerTokens = new Map(); // deviceId -> { access_token, refresh_token, expires_at, blog_id }

// ============================================
// BLOGGER OAUTH FLOW
// ============================================

// Step 1: Start OAuth — redirect user to Google consent
router.get('/blogger/oauth/start', (req, res) => {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const state = crypto.randomBytes(16).toString('hex') + ':' + deviceId;
    const params = new URLSearchParams({
        client_id: BLOGGER_CLIENT_ID,
        redirect_uri: BLOGGER_REDIRECT_URI,
        response_type: 'code',
        scope: BLOGGER_SCOPE,
        access_type: 'offline',   // get refresh_token
        prompt: 'consent',        // force consent to ensure refresh_token
        state
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// Step 2: OAuth callback — exchange code for tokens
router.get('/blogger/oauth/callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error) return res.status(400).send(`OAuth error: ${error}`);
    if (!code || !state) return res.status(400).send('Missing code or state');

    const deviceId = state.split(':').slice(1).join(':');

    try {
        // Exchange code for tokens
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: BLOGGER_CLIENT_ID,
                client_secret: BLOGGER_CLIENT_SECRET,
                redirect_uri: BLOGGER_REDIRECT_URI,
                grant_type: 'authorization_code'
            })
        });
        const tokens = await tokenRes.json();
        if (tokens.error) return res.status(400).json({ error: tokens.error, description: tokens.error_description });

        // Store tokens
        bloggerTokens.set(deviceId, {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_at: Date.now() + (tokens.expires_in * 1000) - 60000 // 1min buffer
        });

        // Fetch blog list to auto-detect blog ID
        const blogsRes = await fetch('https://www.googleapis.com/blogger/v3/users/self/blogs', {
            headers: { Authorization: `Bearer ${tokens.access_token}` }
        });
        const blogs = await blogsRes.json();
        if (blogs.items && blogs.items.length > 0) {
            const entry = bloggerTokens.get(deviceId);
            entry.blogs = blogs.items.map(b => ({ id: b.id, name: b.name, url: b.url }));
            entry.blog_id = blogs.items[0].id; // default to first blog
        }

        res.send(`<h2>Blogger OAuth Success!</h2>
            <p>Device: ${deviceId}</p>
            <p>Blogs found: ${blogs.items ? blogs.items.length : 0}</p>
            <pre>${JSON.stringify(bloggerTokens.get(deviceId)?.blogs || [], null, 2)}</pre>
            <p>You can close this window.</p>`);
    } catch (err) {
        console.error('[Publisher] Blogger OAuth error:', err);
        res.status(500).send('OAuth exchange failed: ' + err.message);
    }
});

// Refresh access token if expired
async function refreshBloggerToken(deviceId) {
    const entry = bloggerTokens.get(deviceId);
    if (!entry?.refresh_token) throw new Error('No refresh token for device ' + deviceId);
    if (entry.expires_at > Date.now()) return entry.access_token; // still valid

    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: BLOGGER_CLIENT_ID,
            client_secret: BLOGGER_CLIENT_SECRET,
            refresh_token: entry.refresh_token,
            grant_type: 'refresh_token'
        })
    });
    const data = await res.json();
    if (data.error) throw new Error(`Token refresh failed: ${data.error}`);

    entry.access_token = data.access_token;
    entry.expires_at = Date.now() + (data.expires_in * 1000) - 60000;
    return entry.access_token;
}

// Check OAuth status
router.get('/blogger/status', (req, res) => {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    const entry = bloggerTokens.get(deviceId);
    if (!entry) return res.json({ authorized: false });
    res.json({
        authorized: true,
        blogs: entry.blogs || [],
        blog_id: entry.blog_id,
        token_expires_at: entry.expires_at
    });
});

// ============================================
// BLOGGER PUBLISH / DELETE
// ============================================

router.post('/blogger/publish', express.json(), async (req, res) => {
    const { deviceId, deviceSecret, title, content, labels, blogId, isDraft } = req.body;
    if (!deviceId || !title || !content) {
        return res.status(400).json({ error: 'deviceId, title, content required' });
    }

    try {
        const token = await refreshBloggerToken(deviceId);
        const targetBlogId = blogId || bloggerTokens.get(deviceId)?.blog_id;
        if (!targetBlogId) return res.status(400).json({ error: 'No blog_id. Complete OAuth first.' });

        const url = `https://www.googleapis.com/blogger/v3/blogs/${targetBlogId}/posts` +
            (isDraft ? '?isDraft=true' : '');
        const postRes = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ kind: 'blogger#post', title, content, labels: labels || [] })
        });
        const post = await postRes.json();
        if (post.error) return res.status(postRes.status).json(post);

        console.log(`[Publisher] Blogger post created: ${post.id} "${title}"`);
        res.json({ success: true, platform: 'blogger', postId: post.id, url: post.url, title: post.title });
    } catch (err) {
        console.error('[Publisher] Blogger publish error:', err);
        res.status(500).json({ error: err.message });
    }
});

router.delete('/blogger/post/:postId', async (req, res) => {
    const { deviceId } = req.query;
    const { postId } = req.params;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    try {
        const token = await refreshBloggerToken(deviceId);
        const blogId = bloggerTokens.get(deviceId)?.blog_id;
        if (!blogId) return res.status(400).json({ error: 'No blog_id' });

        const delRes = await fetch(
            `https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts/${postId}`,
            { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
        );
        if (delRes.status === 204 || delRes.ok) {
            console.log(`[Publisher] Blogger post deleted: ${postId}`);
            return res.json({ success: true, platform: 'blogger', deleted: postId });
        }
        const err = await delRes.json();
        res.status(delRes.status).json(err);
    } catch (err) {
        console.error('[Publisher] Blogger delete error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// HASHNODE PUBLISH / DELETE
// ============================================

async function hashnodeGQL(query, variables = {}) {
    const res = await fetch(HASHNODE_GQL_ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: HASHNODE_API_TOKEN
        },
        body: JSON.stringify({ query, variables })
    });
    const data = await res.json();
    if (data.errors) throw new Error(data.errors.map(e => e.message).join('; '));
    return data.data;
}

// Get current user's publications
router.get('/hashnode/me', async (req, res) => {
    try {
        const data = await hashnodeGQL(`query { me { id username publications(first: 10) { edges { node { id title url } } } } }`);
        res.json({ success: true, user: data.me });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/hashnode/publish', express.json(), async (req, res) => {
    const { publicationId, title, contentMarkdown, tags, slug } = req.body;
    if (!publicationId || !title || !contentMarkdown) {
        return res.status(400).json({ error: 'publicationId, title, contentMarkdown required' });
    }

    try {
        const data = await hashnodeGQL(`
            mutation PublishPost($input: PublishPostInput!) {
                publishPost(input: $input) {
                    post { id title slug url }
                }
            }
        `, {
            input: {
                publicationId,
                title,
                contentMarkdown,
                slug: slug || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
                tags: tags ? tags.map(t => ({ slug: t })) : []
            }
        });
        const post = data.publishPost.post;
        console.log(`[Publisher] Hashnode post created: ${post.id} "${title}"`);
        res.json({ success: true, platform: 'hashnode', postId: post.id, url: post.url, slug: post.slug });
    } catch (err) {
        console.error('[Publisher] Hashnode publish error:', err);
        res.status(500).json({ error: err.message });
    }
});

router.delete('/hashnode/post/:postId', async (req, res) => {
    const { postId } = req.params;
    try {
        await hashnodeGQL(`
            mutation RemovePost($id: ID!) {
                removePost(input: { id: $id }) {
                    post { id }
                }
            }
        `, { id: postId });
        console.log(`[Publisher] Hashnode post deleted: ${postId}`);
        res.json({ success: true, platform: 'hashnode', deleted: postId });
    } catch (err) {
        console.error('[Publisher] Hashnode delete error:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = { router };
