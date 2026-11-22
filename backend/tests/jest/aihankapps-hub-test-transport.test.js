'use strict';
const http = require('http');
const express = require('express');
const request = require('./helpers/local-supertest');
const listen = (server, options) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options, () => { server.removeListener('error', reject); resolve(server); });
});
const close = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
let ownedFixture;
test('unbound app binds exact IPv4 loopback and reuses one owned fixture', async () => {
    const app = express(); app.get('/', (_, res) => res.json({ success: true }));
    const client = await request(app); const again = await request(app);
    expect(client).toBe(again);
    const test = client.get('/'); ownedFixture = test.app;
    expect(test.app.address().address).toBe('127.0.0.1');
    await test.expect(200, { success: true });
});
test('previous test fixture is closed by scoped cleanup', () => {
    expect(ownedFixture.listening).toBe(false);
});
test('an already bound fixture remains owned by its caller', async () => {
    const server = await listen(http.createServer((_, res) => res.end('owned fixture')), { port: 0, host: '127.0.0.1' });
    try { await (await request(server)).get('/').expect(200, 'owned fixture'); expect(server.listening).toBe(true); }
    finally { await close(server); }
});
test('separate IPv4 and IPv6 owners at one port get their own expected response', async () => {
    const ipv4 = await listen(http.createServer((_, res) => res.end('IPv4 fixture')), { port: 0, host: '127.0.0.1' });
    let ipv6;
    try {
        ipv6 = await listen(http.createServer((_, res) => res.end('IPv6 fixture')), { port: ipv4.address().port, host: '::1', ipv6Only: true });
        // The helper only owns unbound fixtures. Explicit IPv6 users can pass
        // their exact URL; this regression never contacts an unrelated owner.
        await (await request('http://[::1]:' + ipv6.address().port)).get('/').expect(200, 'IPv6 fixture');
        await (await request(ipv4)).get('/').expect(200, 'IPv4 fixture');
    } finally { if (ipv6) await close(ipv6); await close(ipv4); }
});
test('wildcard aliasing is either refused or resolves to the specific owned fixture', async () => {
    const specific = await listen(http.createServer((_, res) => res.end('specific fixture')), { port: 0, host: '127.0.0.1' });
    let wildcard;
    try {
        const proposed = http.createServer((_, res) => res.end('wildcard fixture'));
        try { wildcard = await listen(proposed, { port: specific.address().port, host: '0.0.0.0' }); }
        catch (error) { expect(error.code).toBe('EADDRINUSE'); return; }
        // macOS permits both owners: the destination address chooses the
        // specific fixture, not the wildcard listener's intended handler.
        await (await request('http://127.0.0.1:' + wildcard.address().port)).get('/').expect(200, 'specific fixture');
    } finally { if (wildcard) await close(wildcard); await close(specific); }
});
