import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

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

export async function loadReviewCounts(snapshot, catalog) {
  const apps = [];
  for (const app of catalog.apps) {
    const result = { id: app.communityId, google: null, apple: null };
    if (app.googlePackage) {
      if (!/^[A-Za-z0-9_.]+$/.test(app.googlePackage)) throw new Error('Invalid review package identity');
      result.google = reviewCount(JSON.parse(await readFile(join(snapshot, 'google-play/apps', app.googlePackage, 'reviews.json'), 'utf8')), 'google');
    }
    if (app.iosId) {
      if (!/^\d+$/.test(app.iosId)) throw new Error('Invalid review Apple identity');
      result.apple = reviewCount(JSON.parse(await readFile(join(snapshot, 'app-store/apps', String(app.iosId), 'reviews.json'), 'utf8')), 'apple');
    }
    apps.push(result);
  }
  const values = apps.flatMap(app => [app.google, app.apple]).filter(Boolean);
  return { apps, visibleCount: values.reduce((sum, value) => sum + value.count, 0), partial: values.some(value => value.partial), label: 'API-visible-reviews-not-all-time-store-total' };
}
