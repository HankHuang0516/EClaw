// E-Claw Portal - Auth Guard
// Include on every page except index.html

let currentUser = null;

async function checkAuth() {
    try {
        const data = await apiCall('GET', '/api/auth/me');
        currentUser = data.user;
        window.currentUser = currentUser;

        // Update nav email
        const emailEl = document.getElementById('navEmail');
        if (emailEl) emailEl.textContent = currentUser.email;

        return currentUser;
    } catch (e) {
        window.location.href = 'index.html';
        return null;
    }
}
