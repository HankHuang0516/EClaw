import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readGoogleReviewSnapshot } from './google-review-response.mjs';

export function reviewCount(data, platform) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.error || data.errors) throw new Error('Invalid review response');
  if (platform === 'google') {
    const rows = data.reviews ?? [];
    if (!Array.isArray(rows)) throw new Error('Invalid Google review list');
    return { count: rows.length, partial: Boolean(data.tokenPagination?.nextPageToken || data.nextPageToken) };
  }
  if (platform !== 'apple' || !Array.isArray(data.data)) throw new Error('Invalid Apple review list');
  return { count: data.data.length, partial: Boolean(data.links?.next) };
}
const clean = (value, max = 20000) => typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim().slice(0, max) : '';
function date(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
export function normalizedReviews(data, platform, appId) {
  reviewCount(data, platform);
  const rows = platform === 'google' ? data.reviews || [] : data.data;
  return rows.map(row => {
    if (platform === 'apple') {
      const a = row.attributes || {};
      return { id: clean(row.id, 256), appId, platform, author: clean(a.reviewerNickname, 128), title: clean(a.title, 512), body: clean(a.body), rating: a.rating, date: date(a.createdDate), version: '' };
    }
    const a = (row.comments || []).find(comment => comment.userComment)?.userComment || {};
    const seconds = Number(a.lastModified?.seconds);
    const timestamp = Number.isFinite(seconds) ? seconds * 1000 + (Number(a.lastModified?.nanos) || 0) / 1e6 : NaN;
    const iso = Number.isFinite(timestamp) && Math.abs(timestamp) < 8640000000000000 ? new Date(timestamp).toISOString() : null;
    return { id: clean(row.reviewId, 256), appId, platform, author: clean(row.authorName, 128), title: '', body: clean(a.text), rating: a.starRating, date: iso, version: clean(a.appVersionName, 128) };
  }).filter(row => row.id && row.date && (row.body || row.title)).map(row => ({ ...row, rating: Number.isInteger(row.rating) && row.rating >= 1 && row.rating <= 5 ? row.rating : null }));
}
export function mergeReviewItems(items) {
  const byId = new Map();
  for (const item of items) byId.set(`${item.appId}:${item.platform}:${item.id}`, item);
  return [...byId.values()].sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}
async function archiveSnapshots(root) {
  if (!root) return [];
  let days;
  try { days = await readdir(root, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const result = [];
  for (const day of days.filter(d => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, day.name);
    result.push(path);
    try {
      for (const run of (await readdir(join(path, 'runs'), { withFileTypes: true })).filter(r => r.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) result.push(join(path, 'runs', run.name));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return result;
}
export async function loadReviewCounts(snapshot, catalog, { archiveRoot } = {}) {
  const apps = [], items = [];
  for (const app of catalog.apps) {
    const result = { id: app.communityId, google: null, apple: null };
    for (const [platform, id, source] of [['google', app.googlePackage, 'google-play'], ['apple', app.iosId, 'app-store']]) {
      if (!id) continue;
      if (!(platform === 'google' ? /^[A-Za-z0-9_.]+$/.test(id) : /^\d+$/.test(String(id)))) throw new Error('Invalid review identity');
      const directory = join(snapshot, source, 'apps', String(id));
      const data = platform === 'google' ? await readGoogleReviewSnapshot(directory, id) : JSON.parse(await readFile(join(directory, 'reviews.json'), 'utf8'));
      result[platform] = reviewCount(data, platform);
      items.push(...normalizedReviews(data, platform, app.communityId));
    }
    apps.push(result);
  }
  const historical = [];
  let archivePartial = false;
  for (const old of await archiveSnapshots(archiveRoot)) {
    if (resolve(old) === resolve(snapshot)) continue;
    for (const app of catalog.apps) {
      for (const [platform, id, source] of [['google', app.googlePackage, 'google-play'], ['apple', app.iosId, 'app-store']]) {
        if (!id) continue;
        let content;
        try { content = await readFile(join(old, source, 'apps', String(id), 'reviews.json'), 'utf8'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        try { const data = platform === 'google' ? await readGoogleReviewSnapshot(join(old, source, 'apps', String(id)), id) : JSON.parse(content); historical.push(...normalizedReviews(data, platform, app.communityId)); } catch { archivePartial = true; }
      }
    }
  }
  const values = apps.flatMap(app => [app.google, app.apple]).filter(Boolean);
  const currentCount = values.reduce((sum, value) => sum + value.count, 0);
  const merged = mergeReviewItems([...historical, ...items]);
  return { apps, visibleCount: Math.max(currentCount, merged.length), currentVisibleCount: currentCount, partial: values.some(value => value.partial), archivePartial, items: merged, label: 'API-visible-reviews-with-preserved-history-not-all-time-store-total' };
}
