import "./styles.css";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Credential {
  access_token: string;
  expires_at: number;
}

interface AgentInfo {
  agent_type: string;
  name: string;
  version: string | null;
  endpoint: string | null;
  health: string | null;
}

// ---------------------------------------------------------------------------
// State Machine
// ---------------------------------------------------------------------------

type Screen = "loading" | "welcome" | "setup" | "ready" | "error";

const $ = (id: string) => document.getElementById(id)!;

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function init(): Promise<void> {
  const app = document.getElementById("app")!;
  app.innerHTML = `<div class="screen screen-loading"><div class="spinner"></div><p>載入中...</p></div>`;

  try {
    const cred = await invoke<Credential | null>("credential_get");

    if (!cred) {
      showScreen("welcome");
    } else if (cred.expires_at * 1000 > Date.now()) {
      // Token still valid — go to ready
      showScreen("ready");
    } else {
      // Token expired — go to welcome to re-auth
      showScreen("welcome");
    }
  } catch (e) {
    showError(`初始化失敗：${e}`);
  }
}

// ---------------------------------------------------------------------------
// Screen Router
// ---------------------------------------------------------------------------

function showScreen(screen: Screen, data?: Record<string, unknown>): void {
  const app = document.getElementById("app")!;

  switch (screen) {
    case "loading":
      app.innerHTML = `<div class="screen screen-loading"><div class="spinner"></div><p>載入中...</p></div>`;
      break;
    case "welcome":
      renderWelcome(app);
      break;
    case "setup":
      renderSetup(app, data as { agents?: AgentInfo[] });
      break;
    case "ready":
      renderReady(app);
      break;
    case "error":
      renderError(app, data as { message: string });
      break;
  }
}

function showError(msg: string): void {
  const app = document.getElementById("app")!;
  renderError(app, { message: msg });
}

// ---------------------------------------------------------------------------
// Screen 1: Welcome (Globe-user)
// ---------------------------------------------------------------------------

function renderWelcome(container: HTMLElement): void {
  container.innerHTML = `
    <div class="screen screen-welcome">
      <div class="screen-header">
        <div class="hero-icon">🌐</div>
        <button id="btn-help" class="btn-help" aria-label="說明">?
          <span class="tooltip" id="help-tooltip">為什麼需要 Google 登入？EClaw 使用您的 Google 帳號來驗證身份，不會讀取您的 Gmail 或 Google Drive 資料。</span>
        </button>
      </div>
      <h1>Welcome to EClaw Desktop</h1>
      <p class="subtitle">安全、快速的 AI 桌面伴侶</p>
      <button id="btn-signin" class="btn-primary btn-google">
        <svg class="google-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.84z" fill="#FBBC05"/>
          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
        </svg>
        使用 Google 登入
      </button>
      <p class="privacy-note">您的認證資料只存在本機，不会上传到服务器</p>
      <div id="oauth-status" class="oauth-status" style="display:none"></div>
    </div>
  `;

  const btn = document.getElementById("btn-signin")!;
  btn.addEventListener("click", () => startOAuthFlow());

  const btnHelp = document.getElementById("btn-help")!;
  btnHelp.addEventListener("click", () => {
    const tooltip = document.getElementById("help-tooltip")!;
    tooltip.style.display = tooltip.style.display === "block" ? "none" : "block";
  });
}

let pollInterval: ReturnType<typeof setInterval> | null = null;

async function startOAuthFlow(): Promise<void> {
  const statusEl = document.getElementById("oauth-status")!;
  const btn = document.getElementById("btn-signin")!;

  btn.disabled = true;
  statusEl.className = "oauth-status oauth-loading";
  statusEl.style.display = "block";
  statusEl.innerHTML = `<p>正在連接到 Google...</p>`;

  try {
    const { auth_url, port, state } = await invoke<{
      auth_url: string; port: number; state: string;
    }>("oauth_start");

    sessionStorage.setItem("oauth_state", state);
    sessionStorage.setItem("oauth_port", String(port));

    await window.__TAURI__.shell.open(auth_url);

    statusEl.innerHTML = `<p>請在瀏覽器中完成 Google 登入...</p>`;

    pollInterval = setInterval(async () => {
      try {
        const currentPort = await invoke<number | null>("oauth_get_port");
        if (currentPort === null) {
          clearInterval(pollInterval!);
          pollInterval = null;
          statusEl.className = "oauth-status oauth-success";
          statusEl.innerHTML = `<p>✅ Google 登入完成！</p>`;
          setTimeout(() => {
            statusEl.style.display = "none";
            // Move to setup screen
            showScreen("setup", {});
          }, 1500);
        }
      } catch {
        // Ignore polling errors
      }
    }, 1000);

    setTimeout(() => {
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
        statusEl.className = "oauth-status oauth-error";
        statusEl.innerHTML = `<p>登入逾時，請重試。</p>`;
        btn.disabled = false;
      }
    }, 5 * 60 * 1000);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    statusEl.className = "oauth-status oauth-error";
    statusEl.innerHTML = `<p>連接失敗：${msg}</p>`;
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Screen 2: Setup
// ---------------------------------------------------------------------------

async function renderSetup(container: HTMLElement, _data: { agents?: AgentInfo[] }): Promise<void> {
  container.innerHTML = `
    <div class="screen screen-setup">
      <div class="screen-header">
        <div class="hero-icon">⚙️</div>
        <button id="btn-help-setup" class="btn-help" aria-label="說明">?
          <span class="tooltip" id="help-tooltip-setup">
            <b>資料存在哪裡？</b><br>您的登入憑證會加密保存在電腦的 Keychain（macOS）或 Credential Manager（Windows），不會上傳到任何伺服器。<br><br>
            <b>什麼是 Agent 探測？</b><br>EClaw 會掃描本機，找出已安裝的 EClaw AI 夥伴程式。
          </span>
        </button>
      </div>
      <h1>Setting up...</h1>
      <p class="subtitle">正在探測本機 AI agents</p>
      <div id="probe-results" class="agent-list">
        <div class="spinner"></div>
        <p>探測中...</p>
      </div>
      <div id="probe-status" class="probe-status"></div>
      <button id="btn-skip" class="btn-secondary">跳過，稍後設定</button>
      <button id="btn-continue" class="btn-primary" style="display:none">繼續</button>
    </div>
  `;

  document.getElementById("btn-skip")!.addEventListener("click", () => {
    showScreen("ready");
  });

  document.getElementById("btn-continue")!.addEventListener("click", () => {
    showScreen("ready");
  });

  const btnHelpSetup = document.getElementById("btn-help-setup")!;
  btnHelpSetup.addEventListener("click", () => {
    const tooltip = document.getElementById("help-tooltip-setup")!;
    tooltip.style.display = tooltip.style.display === "block" ? "none" : "block";
  });

  // Auto-probe agents
  try {
    const agents = await invoke<AgentInfo[]>("agent_probe");
    const resultsEl = document.getElementById("probe-results")!;
    const statusEl = document.getElementById("probe-status")!;
    const btnContinue = document.getElementById("btn-continue")!;

    if (agents.length === 0) {
      resultsEl.innerHTML = `<p class="probe-none">未發現任何 agents</p>`;
      statusEl.innerHTML = `<p class="probe-warn">⚠️ 未發現 EClaw agent，但您仍可繼續</p>`;
    } else {
      resultsEl.innerHTML = agents.map(agent => `
        <div class="agent-item">
          <span class="agent-type">${agent.agent_type}</span>
          <span class="agent-name">${agent.name}</span>
          <span class="agent-version">${agent.version ?? ""}</span>
          <span class="agent-health">${agent.health === "ok" ? "✅" : "❓"}</span>
        </div>
      `).join("");
      statusEl.innerHTML = `<p class="probe-ok">✅ 發現 ${agents.length} 個 agent</p>`;
    }
    btnContinue.style.display = "block";
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    document.getElementById("probe-results")!.innerHTML = `<p class="probe-error">探測失敗：${msg}</p>`;
    document.getElementById("btn-continue")!.style.display = "block";
  }
}

// ---------------------------------------------------------------------------
// Screen 3: Ready
// ---------------------------------------------------------------------------

function renderReady(container: HTMLElement): void {
  container.innerHTML = `
    <div class="screen screen-ready">
      <div class="screen-header">
        <div class="hero-icon">✅</div>
        <button id="btn-help-ready" class="btn-help" aria-label="說明">?
          <span class="tooltip" id="help-tooltip-ready"><b>登出會怎樣？</b><br>您的凭据会被清除，可随时重新登录。</span>
        </button>
      </div>
      <h1>You're all set!</h1>
      <p class="subtitle">EClaw Desktop 已就緒</p>
      <div class="status-badge"><span class="dot"></span>就緒</div>
      <button id="btn-signout" class="btn-secondary btn-signout">登出</button>
    </div>
  `;

  document.getElementById("btn-signout")!.addEventListener("click", async () => {
    try {
      await invoke("oauth_cancel");
      showScreen("welcome");
    } catch {
      showScreen("welcome");
    }
  });

  const btnHelpReady = document.getElementById("btn-help-ready");
  if (btnHelpReady) {
    btnHelpReady.addEventListener("click", () => {
      const tooltip = document.getElementById("help-tooltip-ready")!;
      tooltip.style.display = tooltip.style.display === "block" ? "none" : "block";
    });
  }
}

// ---------------------------------------------------------------------------
// Error Screen
// ---------------------------------------------------------------------------

function renderError(container: HTMLElement, data: { message: string }): void {
  container.innerHTML = `
    <div class="screen screen-error">
      <div class="hero-icon">❌</div>
      <h1>發生錯誤</h1>
      <p class="error-msg">${escapeHtml(data.message)}</p>
      <button id="btn-retry" class="btn-primary">重試</button>
    </div>
  `;
  document.getElementById("btn-retry")!.addEventListener("click", init);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Tauri invoke helper
// ---------------------------------------------------------------------------

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return await window.__TAURI__.core.invoke<T>(cmd, args);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    __TAURI__: typeof import("@tauri-apps/api").Tauri;
  }
}

init();
