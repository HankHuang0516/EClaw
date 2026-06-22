const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../../mission.js'), 'utf8');

// Bug (card_71267943 / card_984251d7): POST /api/mission/note/add read deviceId
// from req.body ONLY, but authenticate() validates deviceId from the merged
// { ...req.query, ...req.body }. A caller that passed deviceId via the query
// string therefore cleared authentication yet reached the INSERT with
// deviceId=undefined, throwing `null value in column "device_id" violates
// not-null constraint` — surfaced in prod as `[Mission] Error adding note` (500,
// ERROR-low). Fix: the handler resolves deviceId from the SAME merged source
// authenticate() uses, so the value the handler stores is exactly the one auth
// validated and can never be null past auth.
describe('mission note/add deviceId resolution (card_71267943/card_984251d7)', () => {
    function handlerSlice(routeRe) {
        const start = src.search(routeRe);
        expect(start).toBeGreaterThan(-1);
        return src.slice(start, start + 1200);
    }

    test('note/add resolves deviceId from merged query+body, not req.body only', () => {
        const body = handlerSlice(/router\.post\('\/note\/add'/);
        expect(body).toMatch(/const params = \{ \.\.\.req\.query, \.\.\.req\.body \}/);
        // deviceId is destructured from the merged params, not from req.body
        expect(body).toMatch(/const \{ deviceId[^}]*\} = params/);
    });

    test('authenticate() validates deviceId from the same merged params (parity invariant)', () => {
        const authStart = src.indexOf('function authenticate');
        expect(authStart).toBeGreaterThan(-1);
        const auth = src.slice(authStart, authStart + 400);
        // The invariant the fix relies on: auth reads merged params AND rejects
        // a missing deviceId — so any request that passes auth carries a truthy
        // deviceId in the merged params the handler now reads from.
        expect(auth).toMatch(/const params = \{ \.\.\.req\.query, \.\.\.req\.body \}/);
        expect(auth).toMatch(/if \(!deviceId\)/);
    });
});
