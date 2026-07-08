const fs = require('fs');
const path = require('path');

describe('wallet page self-improvement UI', () => {
    const walletPath = path.join(__dirname, '../../public/portal/wallet.html');
    const html = fs.readFileSync(walletPath, 'utf8');

    test('renders a live top-up action status region', () => {
        expect(html).toContain('id="walletActionStatus" role="status" aria-live="polite" aria-atomic="true"');
        expect(html).toContain('function setWalletActionStatus(message, state = \'idle\')');
        expect(html).toContain('statusEl.dataset.state = state');
        expect(html).toContain('setWalletActionStatus(text, state)');
    });

    test('builds top-up tiers as real keyboard-focusable buttons', () => {
        expect(html).toContain("const card = document.createElement('button')");
        expect(html).toContain("card.type = 'button'");
        expect(html).toContain("card.className = 'tier-card'");
        expect(html).toContain("card.setAttribute('aria-label'");
        expect(html).toContain("card.addEventListener('click', () => tapTier(card, t.productId))");
        expect(html).toContain('.tier-card:focus-visible');
    });

    test('disables only the pending top-up tier and restores it on completion', () => {
        expect(html).toContain("card.classList.add('is-pending')");
        expect(html).toContain('card.disabled = true');
        expect(html).toContain('pendingTierCard.disabled = false');
        expect(html).toContain("showTopupToast(tt('wallet_topup_success', 'Top-up successful!'), false, 'success')");
        expect(html).toContain("showTopupToast(tt('wallet_topup_failed', 'Top-up failed. Please try again.'), true, 'error')");
    });
});
