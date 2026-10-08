(() => {
  'use strict';
  // Publish one immutable record per approved campaign. Drafts stay outside public assets.
  window.AIHANK_GIFT_CAMPAIGNS = Object.freeze([
    Object.freeze({
      id: 'rebound-autumn-welcome-2026',
      appId: 'rebound',
      publication: 'published',
      titleElementId: 'reboundGiftTitle',
      endsAt: '2026-10-25T16:00:00Z',
      statusUrl: 'https://rebound-api-production-801c.up.railway.app/v1/campaigns/public-gift'
    }),
    Object.freeze({
      id: 'elemental-fighter350-paper-celebration-20261007',
      appId: 'rebound',
      publication: 'published',
      titleElementId: 'celebrationGiftTitle',
      startsAt: '2026-10-07T10:53:52.797Z',
      endsAt: '2026-11-07T10:53:52.797Z',
      issuedCount: 146,
      verifiedAt: '2026-10-07T10:53:53.156Z',
      statusSource: 'verified-production-mailbox-receipt'
    })
  ]);
})();
