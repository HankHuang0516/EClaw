/** Runtime adaptation v1. Verified original bytes stay immutable in PostgreSQL. */
const { createHash } = require('crypto');
const ORIGINAL_MAP_SHA256 = 'ecbd4d995be28a4555f622b0ac09e2c4d2d351d2ae9aa19ad76400d7083c0893';
const ADAPTATION_VERSION = 'offline-schematic-v1';
const NOTICE = '離線流程示意圖／非實際取貨點';
// Original illustration: no geographical coordinates, address or tile service.
const SCHEMATIC_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 600"><rect width="900" height="600" fill="#f2f0e9"/><path d="M0 116C170 70 160 250 332 232S604 414 900 335" fill="none" stroke="#b7d8e3" stroke-width="92"/><path d="M0 116C170 70 160 250 332 232S604 414 900 335" fill="none" stroke="#d4e9ed" stroke-width="54"/><rect x="100" y="352" width="192" height="143" rx="28" fill="#d5e3cc"/><rect x="638" y="71" width="162" height="117" rx="28" fill="#d5e3cc"/><g fill="none" stroke="#d7d1c4" stroke-width="30"><path d="M-20 300H920"/><path d="M450-20V620"/><path d="M100-20V620"/><path d="M-20 510H920"/></g><g fill="none" stroke="#fffdf7" stroke-width="22"><path d="M-20 300H920"/><path d="M450-20V620"/><path d="M100-20V620"/><path d="M-20 510H920"/></g><g font-family="sans-serif" font-size="20" fill="#596557"><text x="657" y="123">綠地（示意）</text><text x="119" y="429">綠地（示意）</text><text x="650" y="487">道路（示意）</text><text x="225" y="129" fill="#497581">河道（示意）</text></g></svg>';
const SCENE = `const sceneBounds=[[-300,-450],[300,450]];L.imageOverlay('data:image/svg+xml;charset=utf-8,'+encodeURIComponent(${JSON.stringify(SCHEMATIC_SVG)}),sceneBounds,{interactive:false,alt:${JSON.stringify(NOTICE)}}).addTo(map);map.fitBounds(sceneBounds,{padding:[12,12]});status.hidden=false;status.textContent=${JSON.stringify(NOTICE)};status.setAttribute('role','status');`;
function replaceOnce(source, expression, replacement) {
    const matches = source.match(expression);
    if (!matches || matches.length !== 1) throw new Error('demo_map_adapter_mismatch');
    return source.replace(expression, replacement);
}
function adaptDemoMap(body) {
    if (!Buffer.isBuffer(body) || createHash('sha256').update(body).digest('hex') !== ORIGINAL_MAP_SHA256) throw new Error('demo_map_adapter_mismatch');
    let source = body.toString('utf8');
    source = replaceOnce(source, /const center=\[[^\]]+\];/g, 'const center=[0,0];');
    source = replaceOnce(source, /const map=L\.map\('map',\{scrollWheelZoom:false\}\)\.setView\(center,13\);/g, "const map=L.map('map',{crs:L.CRS.Simple,scrollWheelZoom:false,minZoom:-2,maxZoom:2}).setView(center,0);");
    source = replaceOnce(source, /const tiles=L\.tileLayer\([\s\S]*?(?=const select=index=>)/g, SCENE);
    return Buffer.from(`/* ${ADAPTATION_VERSION} */\n${source}`, 'utf8');
}
module.exports = { adaptDemoMap, ORIGINAL_MAP_SHA256, ADAPTATION_VERSION, NOTICE };
