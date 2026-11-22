'use strict';
/* global afterEach */
// Bind the exact loopback address before giving the server to Supertest.
// Wildcard ephemeral listeners can share a port with a more specific local
// listener on macOS; the client can otherwise reach that unrelated service.
const http = require('http');
const supertest = require('supertest');
const owned = new Set();
let fixtures = new WeakMap();
afterEach(async () => {
    const closing = [...owned]; owned.clear(); fixtures = new WeakMap();
    await Promise.all(closing.map(server => new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    })));
});
module.exports = async function localSupertest(app) {
    if (typeof app === 'string' || app.listening) return supertest(app);
    if (!fixtures.has(app)) {
        fixtures.set(app, new Promise((resolve, reject) => {
            const server = typeof app === 'function' ? http.createServer(app) : app;
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
                server.removeListener('error', reject); owned.add(server);
                resolve(supertest(server));
            });
        }));
    }
    return fixtures.get(app);
};
