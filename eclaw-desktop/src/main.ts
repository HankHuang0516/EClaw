import "./styles.css";

interface HealthStatus {
  app_version: string;
  platform: string;
  rust_version: string;
}

interface OAuthStartResult {
  auth_url: string;
  port: number;
  state: string;
  code_verifier: string;
  nonce: string;
}

interface TauriError {
  message: string;
}

async function init(): Promise<void> {
  const app = document.getElementById("app")!;

  try {
    const status = await window.__TAURI__.core.invoke<HealthStatus>("health_check");

    app.innerHTML = `
      <header class="header">
        <h1>EClaw Desktop</h1>
      </header>
      <main class="main">
        <div class="version-info">
          <span>v${status.app_version}</span>
          <span>${status.platform}</span>
          <span>Rust ${status.rust_version}</span>
        </div>
        <div class="status-badge">
          <span class="dot"></span>
          就緒
        </div>
        <div class="actions">
          <button id="btn-setup" class="btn-primary">開始設定</button>
        </div>
        <div id="oauth-status" class="oauth-status" style="display:none"></div>
      </main>
      <footer class="footer">
        <p>您的認證資料只存在本機，不会上传到服务器</p>
      </footer>
    `;

    const btnSetup = document.getElementById("btn-setup");
    btnSetup?.addEventListener("click", async () => {
      await startOAuthFlow();
    });
  } catch (e) {
    const err = e as TauriError;
    app.innerHTML = `
      <h1>EClaw Desktop</h1>
      <p class="error">連接失敗：${err.message ?? e}</p>
      <p>請確認 EClaw Desktop 已正確啟動。</p>
    `;
  }
}

async function startOAuthFlow(): Promise<void> {
  const statusEl = document.getElementById("oauth-status")!;
  const btnSetup = document.getElementById("btn-setup")!;

  btnSetup.disabled = true;
  statusEl.className = "oauth-status oauth-loading";
  statusEl.style.display = "block";
  statusEl.innerHTML = `<p>正在連接到 Google...</p>`;

  try {
    // Start OAuth flow — spawns loopback server, returns Google auth URL
    const { auth_url, port, state } = await window.__TAURI__.core.invoke<OAuthStartResult>("oauth_start");

    // Store state for polling
    sessionStorage.setItem("oauth_state", state);
    sessionStorage.setItem("oauth_port", String(port));

    // Open system browser for Google sign-in
    await window.__TAURI__.shell.open(auth_url);

    statusEl.innerHTML = `<p>請在瀏覽器中完成 Google 登入...</p>`;

    // Poll oauth_get_port to detect when callback is received (port goes None = flow done)
    const pollInterval = setInterval(async () => {
      try {
        const currentPort = await window.__TAURI__.core.invoke<number | null>("oauth_get_port");
        if (currentPort === null) {
          clearInterval(pollInterval);
          statusEl.className = "oauth-status oauth-success";
          statusEl.innerHTML = `<p>✅ Google 登入完成！</p>`;
          setTimeout(() => {
            statusEl.style.display = "none";
            btnSetup.disabled = false;
            init();
          }, 2000);
        }
      } catch {
        // Ignore polling errors
      }
    }, 1000);

    // 5 minute timeout
    setTimeout(() => {
      clearInterval(pollInterval);
      if (statusEl.style.display !== "none") {
        statusEl.className = "oauth-status oauth-error";
        statusEl.innerHTML = `<p>登入逾時，請重試。</p>`;
        btnSetup.disabled = false;
      }
    }, 5 * 60 * 1000);
  } catch (e) {
    const err = e as TauriError;
    statusEl.className = "oauth-status oauth-error";
    statusEl.innerHTML = `<p>連接失敗：${err.message ?? e}</p>`;
    btnSetup.disabled = false;
  }
}

// Augment Window to include Tauri global
declare global {
  interface Window {
    __TAURI__: typeof import("@tauri-apps/api").Tauri;
  }
}

init();
