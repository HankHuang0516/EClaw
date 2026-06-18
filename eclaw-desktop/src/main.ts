import "./styles.css";

interface HealthStatus {
  app_version: string;
  platform: string;
  rust_version: string;
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
        <div id="oauth-placeholder" class="oauth-placeholder" style="display:none">
          <p>連接中，請在瀏覽器完成驗證...</p>
        </div>
      </main>
      <footer class="footer">
        <p>您的認證資料只存在本機，不会上传到服务器</p>
      </footer>
    `;

    const btnSetup = document.getElementById("btn-setup");
    btnSetup?.addEventListener("click", async () => {
      const oauthPlaceholder = document.getElementById("oauth-placeholder");
      if (oauthPlaceholder) {
        oauthPlaceholder.style.display = "block";
      }
      try {
        const result = await window.__TAURI__.core.invoke<string>("oauth_start");
        console.log("oauth_start:", result);
      } catch (e) {
        const err = e as TauriError;
        if (err.message?.includes("P1-B not implemented")) {
          oauthPlaceholder!.innerHTML =
            "<p>設定功能即將推出，請稍候。</p>";
        }
      }
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

// Augment Window to include Tauri global
declare global {
  interface Window {
    __TAURI__: typeof import("@tauri-apps/api").Tauri;
  }
}

init();
