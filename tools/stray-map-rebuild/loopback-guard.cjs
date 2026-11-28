'use strict';
// NEW ISOLATION BOUNDARY, not a recovered production setting. No external egress or env-file reads.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { fileURLToPath } = require('node:url');
function guardFile(filename) {
    const value = filename instanceof URL ? fileURLToPath(filename) : Buffer.isBuffer(filename) ? filename.toString() : filename;
    if (typeof value === 'string' && path.basename(value).startsWith('.env')) {
        const error = new Error('ISOLATED_ENV_FILE_BLOCKED'); error.code = 'ENOENT'; throw error;
    }
}
const originalRead = fs.readFileSync;
fs.readFileSync = function (filename, ...args) {
    guardFile(filename);
    return originalRead.call(this, filename, ...args);
};
const originalAsyncRead = fs.readFile;
fs.readFile = function (filename, ...args) {
    try { guardFile(filename); } catch(error) {
        const callback=args.at(-1);if(typeof callback!=='function')throw error;
        return process.nextTick(callback,error);
    }
    return originalAsyncRead.call(this,filename,...args);
};
const promises = require('node:fs/promises');
const originalPromiseRead = promises.readFile;
promises.readFile = async function(filename,...args) { guardFile(filename);return originalPromiseRead.call(this,filename,...args); };
require('node:module').syncBuiltinESMExports();
const allowedPorts = new Set((process.env.STRAY_REBUILD_PORTS || '').split(',').filter(Boolean));
if (process.env.STRAY_REBUILD_SYNTHETIC !== '1' || !allowedPorts.size) throw new Error('ISOLATION_CONTEXT_REQUIRED');
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
    let options = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (typeof options === 'number' || (typeof options === 'string' && /^\d+$/.test(options))) options = { port: options, host: typeof args[1] === 'string' ? args[1] : 'localhost' };
    if (!options || typeof options !== 'object' || options.path || options.lookup !== undefined
        || !['localhost', '127.0.0.1', '::1'].includes(options.host || 'localhost')
        || !allowedPorts.has(String(options.port))) throw new Error('ISOLATED_EGRESS_BLOCKED');
    const host=options.host==='::1'?'::1':'127.0.0.1';
    if(Array.isArray(args[0]))args[0][0]={...options,host};
    else if(typeof args[0]==='object')args[0]={...options,host};
    else if(typeof args[1]==='string')args[1]=host;else args.splice(1,0,host);
    return connect.apply(this, args);
};
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
    if (typeof args[0] === 'object') args[0] = { ...args[0], host: '127.0.0.1' };
    else if (typeof args[0] === 'number') {
        if (typeof args[1] === 'string') args[1] = '127.0.0.1'; else args.splice(1, 0, '127.0.0.1');
    } else throw new Error('ISOLATED_LISTEN_BLOCKED');
    return listen.apply(this, args);
};
if (globalThis.fetch) {
    const fetch = globalThis.fetch;
    globalThis.fetch = function (input, ...args) {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !allowedPorts.has(url.port)) throw new Error('ISOLATED_FETCH_BLOCKED');
        return fetch.call(this, input, ...args);
    };
}
