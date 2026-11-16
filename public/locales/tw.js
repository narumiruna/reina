// English source messages are stable keys. Keep interpolation names unchanged.
export const tw = {
  "Models · Reina": "模型 · Reina",
  "Sign in · Reina": "登入 · Reina",
  "Skip to content": "跳至主要內容",
  "Reina home": "Reina 首頁",
  ADMINISTRATION: "管理介面",
  WORKSPACE: "工作區",
  Settings: "設定",
  Models: "模型",
  "GitHub App": "GitHub App",
  Runtime: "執行環境",
  "Your agent, configured.": "設定你的 agent。",
  "Manage the connections that power Reina.": "管理 Reina 使用的連線。",
  "Workspace settings": "工作區設定",
  Language: "語言",
  "Loading account…": "正在載入帳號…",
  "Reina session": "Reina 工作階段",
  "Log out of Reina": "登出 Reina",
  CONFIGURATION: "設定",
  "Configure a provider. Select a model for Reina.": "設定服務供應商，並為 Reina 選取模型。",
  "＋ Configure provider": "＋ 設定服務供應商",
  "Loading your settings…": "正在載入設定…",
  "Retry loading settings": "重新載入設定",
  "Enable JavaScript to manage Reina settings.": "請啟用 JavaScript 以管理 Reina 設定。",
  "Runtime configuration": "執行環境設定",
  RUNTIME: "執行環境",
  "Checking configuration…": "正在檢查設定…",
  "Open Runtime settings": "開啟執行環境設定",
  "Applying configuration can start bounded issue scans and use the selected model. Coding still requires explicit approval.":
    "套用設定可能會啟動有限範圍的 issue 掃描，並使用已選取的模型。修改程式碼仍須明確核准。",
  "Refresh status": "重新整理狀態",
  "Apply configuration": "套用設定",
  Providers: "服務供應商",
  "Credentials stay private": "憑證不會公開",
  "MAKE THE FIRST CONNECTION": "建立第一個連線",
  "A model for your workflow": "為工作流程選擇模型",
  "Connect an account or API key, save a model,": "連接帳號或 API key，儲存模型，",
  "then select it for Reina.": "再選取該模型供 Reina 使用。",
  "Configure your first provider": "設定第一個服務供應商",
  "Configure provider": "設定服務供應商",
  "Save model": "儲存模型",
  "Select model": "選取模型",
  "Saved models": "已儲存的模型",
  "Clear selection": "清除選取",
  "Saving a model does not select it. Choose": "儲存模型不代表已選取。請按",
  "to save your preference. Runtime status shows whether the configuration is applied.":
    "以儲存偏好。執行環境狀態會顯示設定是否已套用。",
  "No saved models yet. Configure a provider, then save a model from its catalog or enter your own.":
    "尚未儲存模型。請先設定服務供應商，再從目錄儲存模型，或自行輸入。",
  "Runtime settings": "執行環境設定",
  "Configure one repository and its worker policy. Refresh status keeps your unsaved edits.":
    "設定一個儲存庫及其 worker 政策。重新整理狀態不會清除尚未儲存的編輯。",
  "GitHub identity": "GitHub 識別資訊",
  "Connect GitHub to select a verified repository.": "連接 GitHub 以選取已驗證的儲存庫。",
  "Open GitHub settings": "開啟 GitHub 設定",
  "Advanced GitHub identity": "進階 GitHub 識別資訊",
  "Manual identity fields are retained for compatibility. A connected repository supplies these values automatically.":
    "手動識別欄位僅為相容性而保留。連接儲存庫後會自動填入這些值。",
  "GitHub App ID (required)": "GitHub App ID（必填）",
  "Webhook secret (required for first save)": "Webhook secret（首次儲存時必填）",
  "Write-only. Enter at least 32 characters for the first save. Use the same secret in your GitHub App webhook configuration. Saved secrets are never displayed.":
    "僅供寫入。首次儲存請輸入至少 32 個字元，並在 GitHub App 的 webhook 設定中使用相同密鑰。已儲存的密鑰不會顯示。",
  "Repository owner (required)": "儲存庫擁有者（必填）",
  "Repository name (required)": "儲存庫名稱（必填）",
  "Repository ID (required)": "儲存庫 ID（必填）",
  "Installation ID (required)": "安裝 ID（必填）",
  "Worker image": "Worker 映像檔",
  "Immutable worker image ID (required)": "不可變的 worker 映像檔 ID（必填）",
  "Use a prepared worker image ID, sha256: followed by 64 lowercase hexadecimal characters, or an image reference pinned with @sha256: and that digest. Tags alone are not allowed.":
    "請使用已準備的 worker 映像檔 ID：sha256: 後接 64 個小寫十六進位字元，或以 @sha256: 及該摘要固定版本的映像檔參照。不可僅使用標籤。",
  "Repository policy": "儲存庫政策",
  "Allowed paths (required)": "允許的路徑（必填）",
  "One repository-relative pattern per line, up to 64 patterns of 256 characters each. Blank lines are ignored. Forbidden paths take priority.":
    "每行輸入一個相對於儲存庫的路徑模式，最多 64 個，每個最多 256 個字元。空白行會略過。禁止的路徑優先。",
  "Forbidden paths (required)": "禁止的路徑（必填）",
  "Name this repository's security and deployment domains. For example, src/auth/**, infra/**, or .github/** may need protection in your repository. These examples are not a complete policy. Enter your own list: one repository-relative pattern per line, up to 64 patterns of 256 characters each.":
    "請列出儲存庫中涉及安全性與部署的範圍。例如 src/auth/**、infra/** 或 .github/** 可能需要保護。這些範例並非完整政策。請自行輸入清單：每行一個相對於儲存庫的路徑模式，最多 64 個，每個最多 256 個字元。",
  "Verification commands (required)": "驗證指令（必填）",
  'Enter a JSON array of argument arrays, for example [["npm","run","ci"]]. Use 1–8 commands with 1–32 non-empty string arguments each. Commands run directly, not through a shell. Do not enter a shell command string.':
    '請輸入由引數陣列組成的 JSON 陣列，例如 [["npm","run","ci"]]。可使用 1–8 個指令，每個包含 1–32 個非空字串引數。指令會直接執行，不經過 shell。請勿輸入 shell 指令字串。',
  "Advanced runtime limits": "進階執行環境限制",
  "Scan and job limits": "掃描與工作限制",
  "Maximum concurrent jobs is fixed at 1. Reina runs one job at a time to keep work bounded.":
    "同時執行的工作數固定為 1。Reina 每次只執行一項工作，以限制工作範圍。",
  "Scan interval (milliseconds, required)": "掃描間隔（毫秒，必填）",
  "60,000–86,400,000 ms. Default: 900,000 ms (15 minutes).":
    "60,000–86,400,000 毫秒。預設：900,000 毫秒（15 分鐘）。",
  "Maximum issues per scan (required)": "每次掃描的 issue 數量上限（必填）",
  "Agent timeout (milliseconds, required)": "Agent 逾時（毫秒，必填）",
  "1,000–600,000 ms. Default: 600,000 ms (10 minutes).":
    "1,000–600,000 毫秒。預設：600,000 毫秒（10 分鐘）。",
  "Maximum changed files (required)": "變更檔案數量上限（必填）",
  "Maximum patch size (bytes, required)": "Patch 大小上限（位元組，必填）",
  "Saving also applies these settings with a safe runtime reload. Issue scans and model use can start; coding still requires explicit approval.":
    "儲存時也會安全地重新載入執行環境並套用設定。這可能啟動 issue 掃描並使用模型；修改程式碼仍須明確核准。",
  "Save and apply configuration": "儲存並套用設定",
  "Connect GitHub": "連接 GitHub",
  "Authorize your GitHub account, then choose a repository available to this service's GitHub App. Existing App installations can be reused.":
    "授權 GitHub 帳號，再選取此服務的 GitHub App 可存取的儲存庫。可重複使用現有的 App 安裝。",
  "Not connected": "尚未連接",
  "Continue to the official GitHub authorization page in this tab. Repository selection can resume a matching saved Runtime configuration. Coding still requires explicit approval.":
    "在此分頁前往 GitHub 官方授權頁面。選取儲存庫可能恢復相符且已儲存的執行環境設定。修改程式碼仍須明確核准。",
  "This service needs one-time GitHub App setup. Choose Connect GitHub to open the missing settings. Existing App keys and matching webhook settings are retained.":
    "此服務需要完成一次性的 GitHub App 設定。請按「連接 GitHub」開啟缺少的設定。現有的 App 金鑰與相符的 webhook 設定會保留。",
  Repository: "儲存庫",
  "Connected by": "連接帳號",
  "Connected at": "連接時間",
  "Choose an authorized repository": "選擇已授權的儲存庫",
  "Repository (required)": "儲存庫（必填）",
  "Only verified repositories available to your account and this App are listed. Selection is not saved until you choose Use repository.":
    "僅列出已驗證且帳號與此 App 皆可存取的儲存庫。按「使用儲存庫」後才會儲存選取結果。",
  "Choose a repository": "選擇儲存庫",
  "Repository selection can resume a complete saved Runtime configuration. The App, repository, and installation must match. Scans use its saved worker image and policy and can use model quota. Unsaved form edits do not stop this restart. Save and apply is required to change worker settings or policy. Repository selection does not approve coding.":
    "選取儲存庫可能恢復已完整儲存的執行環境設定。App、儲存庫與安裝資訊必須相符。掃描會使用已儲存的 worker 映像檔與政策，並可能消耗模型額度。表單中尚未儲存的編輯不會阻止重新啟動。變更 worker 設定或政策須按「儲存並套用」。選取儲存庫不代表核准修改程式碼。",
  "Use repository": "使用儲存庫",
  "Install / manage App": "安裝／管理 App",
  "Refresh repositories": "重新整理儲存庫",
  "Cancel connection": "取消連接",
  "To add repositories, use Install / manage App on GitHub. If organization approval is required, ask an organization owner to approve the request, then refresh repositories to check access again. If this connection attempt has expired, use Connect GitHub again. Reina cannot approve requests for you.":
    "若要新增儲存庫，請在 GitHub 使用「安裝／管理 App」。如需組織核准，請組織擁有者核准要求，再重新整理儲存庫以確認存取權。若此次連接已過期，請再次按「連接 GitHub」。Reina 無法代為核准。",
  "Service operator: one-time GitHub App setup": "服務管理者：一次性 GitHub App 設定",
  "This section is for the service operator, not users connecting a repository. Register an existing GitHub App for this Reina service. Credentials are write-only and are never displayed.":
    "本區供服務管理者使用，不適用於連接儲存庫的使用者。請為此 Reina 服務註冊現有的 GitHub App。憑證僅供寫入，不會顯示。",
  "In your GitHub App settings, register the exact callback URL and setup URL below. Enable":
    "請在 GitHub App 設定中登錄下列完全相符的 callback URL 與 setup URL。啟用",
  "Redirect on update": "Redirect on update",
  Leave: "並關閉",
  "Request user authorization (OAuth) during installation":
    "Request user authorization (OAuth) during installation",
  "off. Connect GitHub starts a separate authorization flow with PKCE.":
    "選項。「連接 GitHub」會啟動獨立的 PKCE 授權流程。",
  "Enter the App ID and client secret. Configure the same webhook secret in GitHub and Reina. Upload the App's unencrypted PEM private key below.":
    "輸入 App ID 與 client secret。在 GitHub 與 Reina 設定相同的 webhook secret，並於下方上傳 App 未加密的 PEM 私密金鑰。",
  "Callback URL": "Callback URL",
  "Setup URL": "Setup URL",
  "Service credentials": "服務憑證",
  "Register service App": "註冊服務 App",
  "Secrets are write-only. Leave a secret blank to keep its saved value for the same App. A different App requires new secrets. Client secret: paste the generated value from GitHub (1–4,096 characters); surrounding whitespace is removed. Webhook secret: 32–4,096 characters; whitespace is not changed.":
    "密鑰僅供寫入。同一 App 的密鑰留空即可保留已儲存的值；不同 App 須提供新密鑰。Client secret：貼上 GitHub 產生的值（1–4,096 個字元），前後空白會移除。Webhook secret：32–4,096 個字元，空白不會變更。",
  "Client secret (required)": "Client secret（必填）",
  "Webhook secret (required)": "Webhook secret（必填）",
  "Save service App": "儲存服務 App",
  "App private key": "App 私密金鑰",
  "The service operator uploads the App's PEM private key once for this service.":
    "由服務管理者為此服務上傳一次 App 的 PEM 私密金鑰。",
  "Not configured": "尚未設定",
  Fingerprint: "指紋",
  "No key uploaded": "尚未上傳金鑰",
  "Last uploaded": "上次上傳時間",
  "Upload private key": "上傳私密金鑰",
  "PEM file (required)": "PEM 檔案（必填）",
  "Select an unencrypted RSA private key downloaded from your GitHub App (at least 2048 bits). Maximum 32 KiB. Its contents are never displayed.":
    "請選擇從 GitHub App 下載的未加密 RSA 私密金鑰（至少 2048 bits），大小上限為 32 KiB。檔案內容不會顯示。",
  "Delete private key": "刪除私密金鑰",
  "Write-only credentials.": "憑證僅供寫入。",
  "Reina returns only the key fingerprint and configuration status. Upload a new file to replace an existing key.":
    "Reina 只會傳回金鑰指紋與設定狀態。上傳新檔案即可取代現有金鑰。",
  "Connection settings": "連線設定",
  CONNECTION: "連線",
  "Close provider dialog": "關閉服務供應商對話框",
  "Select authentication method": "選擇驗證方式",
  "Sign in with an account": "使用帳號登入",
  "Authorize a supported provider account.": "授權支援的服務供應商帳號。",
  "Sign in with an API key": "使用 API key 登入",
  "Use the provider's prompts, or configure a custom endpoint.":
    "依服務供應商提示操作，或設定自訂端點。",
  "Only methods supported by Reina are listed. Credentials save separately from model selection.":
    "僅列出 Reina 支援的方式。憑證與模型選取會分別儲存。",
  "Supported sign-in limits": "支援的登入方式與限制",
  "OpenAI API keys use OpenAI. ChatGPT account login uses the separate OpenAI Codex provider. OpenAI and OpenRouter callback-based account login, Radius, filesystem credentials, and GitHub Enterprise login are not available here. A saved credential does not confirm subscription access or model availability.":
    "OpenAI API key 使用 OpenAI。ChatGPT 帳號登入則使用獨立的 OpenAI Codex 服務供應商。此處不支援 OpenAI 與 OpenRouter 的 callback 帳號登入、Radius、檔案系統憑證及 GitHub Enterprise 登入。儲存憑證不代表已確認訂閱權限或模型可用性。",
  Continue: "繼續",
  "Search providers": "搜尋服務供應商",
  "Search by name or ID": "依名稱或 ID 搜尋",
  "Select provider (required)": "選擇服務供應商（必填）",
  "Loading catalog…": "正在載入目錄…",
  "Retry catalog": "重新載入目錄",
  "Add custom provider": "新增自訂服務供應商",
  "Confirm GitHub Copilot policy changes": "確認 GitHub Copilot 政策變更",
  "Starting GitHub Copilot sign-in may enable model policies on your GitHub account. Continue only if you permit these remote changes. Only public github.com accounts are supported.":
    "開始 GitHub Copilot 登入可能會啟用 GitHub 帳號的模型政策。僅在允許這些遠端變更時繼續。只支援公開 github.com 帳號。",
  "Allow policy changes and continue": "允許政策變更並繼續",
  "Provider credential": "服務供應商憑證",
  "Update credential": "更新憑證",
  "Remove credential": "移除憑證",
  "Provider sign-in": "服務供應商登入",
  "Open the verification link in a new tab. If your browser blocks it, copy the link address and open it yourself. Reina does not open popups automatically.":
    "請在新分頁開啟驗證連結。若瀏覽器封鎖，請複製連結位址並自行開啟。Reina 不會自動開啟彈出式視窗。",
  "Provider response": "服務供應商回應",
  "Display name (required)": "顯示名稱（必填）",
  "e.g. My provider": "例如：我的服務供應商",
  "API (required)": "API（必填）",
  "The API selects the wire protocol used for model requests.": "API 決定模型請求使用的通訊協定。",
  "Select an API": "選擇 API",
  "Base URL (required)": "Base URL（必填）",
  "Use an HTTPS API endpoint, including its version path. Do not include credentials, a query, or a fragment.":
    "請使用包含版本路徑的 HTTPS API 端點。不可包含憑證、查詢參數或片段識別碼。",
  "API key (optional)": "API key（選填）",
  "Write-only. You can add a key later; a key is required to use a model.":
    "僅供寫入。可以稍後新增金鑰；使用模型時必須有金鑰。",
  "Save provider": "儲存服務供應商",
  Back: "返回",
  Cancel: "取消",
  MODEL: "模型",
  "Close model dialog": "關閉模型對話框",
  "Search model catalog": "搜尋模型目錄",
  "Search by model name or ID": "依模型名稱或 ID 搜尋",
  "Catalog models": "目錄中的模型",
  "Select catalog model": "選取目錄模型",
  "Or enter a custom model below": "或在下方輸入自訂模型",
  "e.g. My model": "例如：我的模型",
  "Model ID (required)": "模型 ID（必填）",
  "The exact model identifier. Start with a letter or digit; use only letters, digits, dots, underscores, slashes, and hyphens.":
    "請輸入完整且正確的模型識別碼。以英文字母或數字開頭，僅可使用英文字母、數字、句點、底線、斜線與連字號。",
  "e.g. model-name-version": "例如：model-name-version",
  "Advanced limits": "進階限制",
  "Context window: 4,096–4,000,000 tokens. Maximum output tokens setting: 256–4,096 tokens. Codex SDK 1.5.0 ignores this setting. Gateway time, request-count, and response-size limits still apply; they are not an upstream token or billing cap.":
    "Context window：4,096–4,000,000 tokens。輸出 token 數量上限設定：256–4,096 tokens。Codex SDK 1.5.0 會忽略此設定。Gateway 的時間、請求數量與回應大小限制仍有效，但不代表上游 token 或費用上限。",
  "Context window (tokens, required)": "Context window（tokens，必填）",
  "Maximum output tokens setting (required)": "輸出 token 數量上限設定（必填）",
  "CONFIRM DELETION": "確認刪除",
  "Delete item?": "刪除項目？",
  Delete: "刪除",
  "YOUR AGENT. YOUR WORKSPACE.": "你的 agent，你的工作區。",
  "Welcome to Reina": "歡迎使用 Reina",
  "Sign in to configure your models": "登入以設定模型",
  "and GitHub App connection.": "與 GitHub App 連線。",
  "Continue with Pocket ID": "使用 Pocket ID 繼續",
  "Secure access through your Pocket ID account.": "透過 Pocket ID 帳號安全登入。",
  "Reina administration": "Reina 管理介面",

  "Sign-in could not be completed. Please try again.": "無法完成登入，請再試一次。",
  "This account does not have access to Reina. Contact your administrator.":
    "此帳號沒有 Reina 存取權，請聯絡管理員。",
  "Sign-in is not configured. Contact your administrator.": "尚未設定登入，請聯絡管理員。",
  "The request could not be processed. Reload the page and try again.":
    "無法處理請求。請重新載入頁面後再試一次。",
  "Check the highlighted fields and try again.": "請檢查標示的欄位後再試一次。",
  "Reina returned an unexpected response. Reload the page and try again.":
    "Reina 傳回非預期的回應。請重新載入頁面後再試一次。",
  "Settings are unavailable. Try again or contact your administrator.":
    "設定目前無法使用。請再試一次或聯絡管理員。",
  "Use a public HTTPS endpoint without credentials, a query, or a fragment.":
    "請使用公開 HTTPS 端點，不可包含憑證、查詢參數或片段識別碼。",
  "Use a public HTTPS provider endpoint. Private network addresses are not allowed.":
    "請使用服務供應商的公開 HTTPS 端點，不可使用私人網路位址。",
  "The provider redirected to a different origin. Check its base URL.":
    "服務供應商重新導向至不同來源。請檢查 base URL。",
  "Enter a new API key when changing the provider endpoint.":
    "變更服務供應商端點時，請輸入新的 API key。",
  "Add a credential to this provider before selecting its model.":
    "請先為此服務供應商新增憑證，再選取模型。",
  "Update this provider's credential, then try again.": "請更新此服務供應商的憑證後再試一次。",
  "This credential changed during setup. Close this dialog and try again.":
    "設定期間憑證已變更。請關閉此對話框後再試一次。",
  "This model is not available for the saved credential. Choose another catalog model or reconnect.":
    "已儲存的憑證無法使用此模型。請選擇其他目錄模型或重新連接。",
  "Use context and output settings within the selected catalog model's limits.":
    "Context 與輸出設定不得超過所選目錄模型的限制。",
  "Enter a response for the current provider prompt, then continue.":
    "請回應目前的服務供應商提示後再繼續。",
  "Sign-in expired. Go back and start again.": "登入已過期。請返回並重新開始。",
  "Sign-in was cancelled. The previous credential is unchanged.": "登入已取消，原有憑證未變更。",
  "Sign-in could not be completed. Go back and try again.": "無法完成登入。請返回後再試一次。",
  "Too many sign-in attempts are active. Cancel an unused attempt or try later.":
    "目前進行中的登入嘗試過多。請取消不再使用的嘗試，或稍後再試。",
  "This sign-in method is not available for this provider.": "此服務供應商不支援這種登入方式。",
  "Your Reina session is no longer active. Reload the page to sign in again.":
    "Reina 工作階段已失效。請重新載入頁面並再次登入。",
  "Confirm the GitHub Copilot policy changes before starting.":
    "開始前請確認 GitHub Copilot 政策變更。",
  "This prompt is no longer active. Go back and start again.": "此提示已失效。請返回並重新開始。",
  "The provider returned an unsupported authorization link. Sign-in was stopped.":
    "服務供應商傳回不支援的授權連結，登入已停止。",
  "This provider prompt is not supported in Reina.": "Reina 不支援此服務供應商提示。",
  "Provider authorization was denied. Go back to try again.":
    "服務供應商授權遭拒。請返回後再試一次。",
  "Provider sign-in expired. Go back and start again.": "服務供應商登入已過期。請返回並重新開始。",
  "Provider sign-in failed. Go back to try again.": "服務供應商登入失敗。請返回後再試一次。",
  "This model is already saved for this provider.": "此服務供應商已儲存此模型。",
  "The limit of 50 providers has been reached. Delete an unused provider first.":
    "已達 50 個服務供應商的上限。請先刪除不再使用的服務供應商。",
  "The limit of 500 models has been reached. Delete an unused model first.":
    "已達 500 個模型的上限。請先刪除不再使用的模型。",
  "The file could not be read. Select the PEM file again.": "無法讀取檔案。請重新選擇 PEM 檔案。",
  "Select an unencrypted RSA private key in PEM format (at least 2048 bits).":
    "請選擇 PEM 格式的未加密 RSA 私密金鑰（至少 2048 bits）。",
  "GitHub connection is not configured for this service. Ask the service operator to complete App setup.":
    "此服務尚未設定 GitHub 連線。請服務管理者完成 App 設定。",
  "This GitHub connection attempt expired. Choose Connect GitHub to start again.":
    "此次 GitHub 連接已過期。請按「連接 GitHub」重新開始。",
  "GitHub connection could not be completed. Choose Connect GitHub to try again. Your saved repository is unchanged.":
    "無法完成 GitHub 連接。請按「連接 GitHub」再試一次。已儲存的儲存庫未變更。",
  "GitHub authorization was denied. Your saved repository is unchanged. You can connect again when ready.":
    "GitHub 授權遭拒。已儲存的儲存庫未變更，準備好後可再次連接。",
  "This GitHub connection attempt is no longer current. Choose Connect GitHub to start again.":
    "此次 GitHub 連接已失效。請按「連接 GitHub」重新開始。",
  "Too many GitHub connection attempts are active. Cancel an unused attempt or try again later.":
    "目前進行中的 GitHub 連接嘗試過多。請取消不再使用的嘗試，或稍後再試。",
  "GitHub returned an unsupported navigation URL. Navigation was stopped. Start a new connection.":
    "GitHub 傳回不支援的導向 URL，導向已停止。請重新連接。",
  "The request is too large. Keep runtime settings within 512 KiB, PEM files within 32 KiB, and API keys within 8,192 characters.":
    "請求過大。執行環境設定不得超過 512 KiB、PEM 檔案不得超過 32 KiB、API key 不得超過 8,192 個字元。",
  "This item no longer exists. Refresh settings and try again.":
    "此項目已不存在。請重新整理設定後再試一次。",
  "This provider no longer exists. Refresh settings and try again.":
    "此服務供應商已不存在。請重新整理設定後再試一次。",
  "This model no longer exists. Refresh settings and try again.":
    "此模型已不存在。請重新整理設定後再試一次。",
  "Your security token has expired. Reload the page and try again.":
    "安全 token 已過期。請重新載入頁面後再試一次。",
  "This action is not allowed. Reload the page and try again.":
    "不允許此操作。請重新載入頁面後再試一次。",
  "Could not reach Reina. Check your connection and try again.":
    "無法連接 Reina。請檢查網路連線後再試一次。",
  "{action} {context}": "{action} {context}",
  "The action could not be completed. Check your settings and try again.":
    "無法完成操作。請檢查設定後再試一次。",
  "Settings could not be loaded. Check your connection and try again.":
    "無法載入設定。請檢查網路連線後再試一次。",
  "Saving changes…": "正在儲存變更…",
  "Changes were saved, but settings could not be refreshed. Retry loading settings before making more changes.":
    "變更已儲存，但無法重新整理設定。進一步變更前，請重新載入設定。",
  "Check this value and try again.": "請檢查此值後再試一次。",
  "Webhook secret (optional replacement)": "Webhook secret（選填，可取代原值）",
  "Secret configured. Leave blank to keep it, or enter at least 32 characters to replace it. Use the same secret in your GitHub App webhook configuration. The saved secret is never displayed.":
    "已設定密鑰。留空可保留原值，或輸入至少 32 個字元以取代。在 GitHub App 的 webhook 設定中須使用相同密鑰。已儲存的密鑰不會顯示。",
  "Applying configuration": "正在套用設定",
  "Configuration applied": "設定已套用",
  "Configuration incomplete": "設定尚未完成",
  "Configuration could not be applied": "無法套用設定",
  "Choose a saved model to continue.": "請選取已儲存的模型以繼續。",
  "Ask the service operator to complete GitHub App setup.": "請服務管理者完成 GitHub App 設定。",
  "Complete Runtime settings to continue.": "請完成執行環境設定以繼續。",
  "Server environment settings are incomplete. Contact your administrator.":
    "伺服器環境設定尚未完成。請聯絡管理員。",
  "Server cleanup failed. Ask your administrator to check cleanup and restart Reina.":
    "伺服器清理失敗。請管理員檢查清理狀態並重新啟動 Reina。",
  "Settings could not be read. Contact your administrator.": "無法讀取設定。請聯絡管理員。",
  "Check GitHub App credentials and server sandbox configuration.":
    "請檢查 GitHub App 憑證與伺服器 sandbox 設定。",
  "{state}. {reason}": "{state}。{reason}",
  "Selected model: {name}.": "已選取模型：{name}。",
  "No model selected.": "尚未選取模型。",
  "Key configured": "已設定金鑰",
  "Fingerprint unavailable": "無法取得指紋",
  "Replace private key": "取代私密金鑰",
  "Repository or App identity changed. Stored Runtime settings were not changed. The worker image and forbidden paths were cleared in this form. Review the allowed paths, verification commands, and limits for this target before saving and applying.":
    "儲存庫或 App 識別資訊已變更。已儲存的執行環境設定未變更。此表單中的 worker 映像檔與禁止路徑已清除。儲存並套用前，請檢查此目標的允許路徑、驗證指令與限制。",
  "Connected repository: {repository}. Identity is supplied by Connect GitHub. An exact match to the complete saved Runtime configuration can restart scans and use model quota. New or changed worker settings and policy require Runtime Save and apply. Coding still requires explicit approval.":
    "已連接的儲存庫：{repository}。識別資訊由「連接 GitHub」提供。若與已完整儲存的執行環境設定完全相符，可能重新啟動掃描並使用模型額度。新增或變更 worker 設定與政策須在執行環境中按「儲存並套用」。修改程式碼仍須明確核准。",
  "No connected repository. Connect GitHub to select a verified repository, or use Advanced GitHub identity to enter a manual target.":
    "尚未連接儲存庫。請連接 GitHub 以選取已驗證的儲存庫，或使用「進階 GitHub 識別資訊」手動輸入目標。",
  "Client secret": "Client secret",
  "Webhook secret": "Webhook secret",
  "{label} (required)": "{label}（必填）",
  "{label} (optional replacement)": "{label}（選填，可取代原值）",
  "GitHub App ID": "GitHub App ID",
  "OAuth client secret": "OAuth client secret",
  "Repository connected": "已連接儲存庫",
  "{repository} · Repository ID {repositoryId} · Installation ID {installationId} · App ID {appId}":
    "{repository} · 儲存庫 ID {repositoryId} · 安裝 ID {installationId} · App ID {appId}",
  "{login} · User ID {id}": "{login} · 使用者 ID {id}",
  "Date unavailable": "無法取得日期",
  "Connect GitHub / change repository": "連接 GitHub／變更儲存庫",
  "Unavailable in this service version": "此服務版本不支援",
  "Client secret: {client}. Webhook secret: {webhook}. Private key: {key}.":
    "Client secret：{client}。Webhook secret：{webhook}。私密金鑰：{key}。",
  configured: "已設定",
  "not configured": "尚未設定",
  "Service App status is unavailable. Ask the service operator to update Reina before using Connect GitHub.":
    "無法取得服務 App 狀態。使用「連接 GitHub」前，請服務管理者更新 Reina。",
  " as {login}": "（帳號：{login}）",
  "Choose Connect GitHub to authorize an account and select a repository. Your saved repository, if any, stays unchanged until you choose Use repository.":
    "請按「連接 GitHub」授權帳號並選取儲存庫。按「使用儲存庫」前，原有的儲存庫設定不會變更。",
  "Missing service settings: {fields}. Choose Connect GitHub to open the required setup fields.":
    "缺少服務設定：{fields}。請按「連接 GitHub」開啟必要的設定欄位。",
  "GitHub service status is unavailable. Refresh settings or contact the service operator.":
    "無法取得 GitHub 服務狀態。請重新整理設定或聯絡服務管理者。",
  "GitHub authorization has started. Complete authorization on GitHub, or cancel this attempt and connect again.":
    "已開始 GitHub 授權。請在 GitHub 完成授權，或取消此次嘗試後重新連接。",
  "GitHub authorized{user}. Choose a repository, then choose Use repository to save it. Use Install / manage App to add repositories.":
    "GitHub 已授權{user}。請選取儲存庫，再按「使用儲存庫」儲存。若要新增儲存庫，請按「安裝／管理 App」。",
  "GitHub authorized{user}, but no repositories are available. Install the App or request organization approval, then refresh repositories.":
    "GitHub 已授權{user}，但沒有可用的儲存庫。請安裝 App 或要求組織核准，再重新整理儲存庫。",
  "GitHub authorized{user}. No App installation with an available repository was found. Install the App or request organization approval, then refresh repositories.":
    "GitHub 已授權{user}。找不到可存取儲存庫的 App 安裝。請安裝 App 或要求組織核准，再重新整理儲存庫。",
  "Checking GitHub connection…": "正在檢查 GitHub 連線…",
  "API key configured": "已設定 API key",
  "Subscription configured": "已設定訂閱",
  "Account configured": "已設定帳號",
  "{provider} · {count} saved model": "{provider} · 已儲存 {count} 個模型",
  "{provider} · {count} saved models": "{provider} · 已儲存 {count} 個模型",
  "Built-in provider": "內建服務供應商",
  Edit: "編輯",
  "Delete saved connection to {name}?": "刪除與 {name} 的已儲存連線？",
  "This deletes the saved connection, its credential, and all its saved models. If one is selected, the selection is cleared. Built-in providers remain in the catalog. This cannot be undone.":
    "這會刪除已儲存的連線、憑證及其所有已儲存模型。如果其中有已選取的模型，也會清除選取。內建服務供應商仍會保留在目錄中。此操作無法復原。",
  "Saved connection deleted.": "已刪除儲存的連線。",
  "＋ Save model": "＋ 儲存模型",
  "for {name}": "供 {name} 使用",
  "Selected model": "已選取的模型",
  "{provider} · Context window: {context} tokens · {output}":
    "{provider} · Context window：{context} tokens · {output}",
  "Maximum output tokens setting: ignored by SDK 1.5.0":
    "輸出 token 數量上限設定：SDK 1.5.0 會忽略此設定",
  "Maximum output tokens: {count}": "輸出 token 數量上限：{count}",
  "{model} from {provider}": "{provider} 的 {model}",
  "Delete {name}?": "刪除 {name}？",
  "This deletes the saved model and clears the current selection. The provider and its credential will remain.":
    "這會刪除已儲存的模型並清除目前的選取。服務供應商與憑證會保留。",
  "This deletes the saved model. The provider and its credential will remain.":
    "這會刪除已儲存的模型。服務供應商與憑證會保留。",
  "Model deleted.": "已刪除模型。",
  "Add a credential to {name} before selecting this model.":
    "請先為 {name} 新增憑證，再選取此模型。",
  "{name} selected. Check runtime status to confirm that the configuration is applied.":
    "已選取 {name}。請檢查執行環境狀態以確認設定已套用。",
  "Connect your GitHub account and choose a repository.": "連接 GitHub 帳號並選取儲存庫。",
  "Configure the repository, worker image, and runtime policy.":
    "設定儲存庫、worker 映像檔與執行環境政策。",
  "{page} · Reina": "{page} · Reina",
  "Catalog unavailable. Retry, or go back to choose another method. Custom endpoints are available only with API keys.":
    "目錄無法使用。請重試，或返回選擇其他方式。自訂端點僅支援 API key。",
  "Catalog unavailable. Close and reopen to retry. Built-in providers require a catalog model.":
    "目錄無法使用。請關閉並重新開啟以重試。內建服務供應商必須使用目錄模型。",
  "Catalog unavailable. Enter a custom model below, or close and reopen to retry.":
    "目錄無法使用。請在下方輸入自訂模型，或關閉並重新開啟以重試。",
  "{count} providers. Select a provider to configure.":
    "共 {count} 個服務供應商。請選取要設定的服務供應商。",
  "No matching providers. Try another search.": "找不到相符的服務供應商。請嘗試其他搜尋條件。",
  "No providers support this method in Reina. Go back to choose another method.":
    "Reina 中沒有服務供應商支援此方式。請返回選擇其他方式。",
  "{description}{method}": "{description}{method}",
  "Providers available for sign in with an account. OpenAI Codex is separate from OpenAI API keys.":
    "可使用帳號登入的服務供應商。OpenAI Codex 與 OpenAI API key 是分開的。",
  "Providers available for sign in with an API key. Built-in providers use their own setup prompts.":
    "可使用 API key 登入的服務供應商。內建服務供應商使用各自的設定提示。",
  " Authentication method: {name}.": " 驗證方式：{name}。",
  "{count} models. Select a catalog model, then review it before saving.":
    "共 {count} 個模型。請選取目錄模型，並於儲存前檢查設定。",
  "No matching catalog models. Try another search. Built-in providers require a catalog model.":
    "找不到相符的目錄模型。請嘗試其他搜尋條件。內建服務供應商必須使用目錄模型。",
  "No matching models. Try another search or enter a custom model below.":
    "找不到相符的模型。請嘗試其他搜尋條件，或在下方輸入自訂模型。",
  "{status} — {method}. Updating keeps this saved connection and authentication method. Models and selection save separately.":
    "{status} — {method}。更新會保留已儲存的連線與驗證方式。模型與選取會分別儲存。",
  Account: "帳號",
  "API key": "API key",
  "Add credential": "新增憑證",
  "API key configured. Leave blank to keep it, or enter a new key to replace it. Changing the endpoint requires a new key. The saved key is never returned.":
    "已設定 API key。留空可保留原值，或輸入新金鑰以取代。變更端點須提供新金鑰。已儲存的金鑰不會傳回。",
  "Write-only. A key is needed to use a model. You can save the provider without one.":
    "僅供寫入。使用模型時須有金鑰，但可以先不填金鑰就儲存服務供應商。",
  "Step 1: Select authentication method": "步驟 1：選擇驗證方式",
  "Step 2: Select provider": "步驟 2：選擇服務供應商",
  "Step 3: Confirm remote policy changes": "步驟 3：確認遠端政策變更",
  "Manage credential": "管理憑證",
  "Step 3: Complete provider sign-in": "步驟 3：完成服務供應商登入",
  "Step 3: Add custom provider": "步驟 3：新增自訂服務供應商",
  "Edit custom provider": "編輯自訂服務供應商",
  "Select provider": "選擇服務供應商",
  "Edit provider": "編輯服務供應商",
  "Starting provider sign-in…": "正在啟動服務供應商登入…",
  "Sign-in stopped. Go back to try again.": "登入已停止。請返回後再試一次。",
  "{error} Existing credentials and model selection were not changed by this attempt.":
    "{error} 此次嘗試未變更現有憑證與模型選取。",
  "Open authorization page": "開啟授權頁面",
  "Open this link to authorize your account.": "請開啟此連結以授權帳號。",
  "Continue account authorization.": "請繼續完成帳號授權。",
  "Authentication in progress.": "正在進行驗證。",
  Authorization: "授權",
  "Authorization link unavailable: only secure HTTPS links are allowed. Go back and retry sign-in.":
    "授權連結無法使用：僅允許安全的 HTTPS 連結。請返回並重新登入。",
  "Enter this code on the provider's verification page:": "請在服務供應商的驗證頁面輸入此代碼：",
  "Open verification page": "開啟驗證頁面",
  "Credential saved. Refreshing settings…": "憑證已儲存，正在重新整理設定…",
  "Credential saved. Model selection is unchanged. Save a model, then use Select model to save your preference.":
    "憑證已儲存，模型選取未變更。請儲存模型，再按「選取模型」儲存偏好。",
  "Credential saved, but settings could not be refreshed. Retry loading settings before making more changes.":
    "憑證已儲存，但無法重新整理設定。進一步變更前，請重新載入設定。",
  "Complete the provider prompt to continue.": "請完成服務供應商提示以繼續。",
  "Waiting for the provider. You can go back or cancel sign-in.":
    "正在等候服務供應商。可以返回或取消登入。",
  "Choose an option": "選擇選項",
  "Built-in providers use exact catalog model IDs. Select a catalog model before saving. Each model keeps its own API and endpoint.":
    "內建服務供應商使用完全相符的目錄模型 ID。儲存前請先選取目錄模型。每個模型會保留各自的 API 與端點。",
  "Choose a catalog model, then review its name and limits below.":
    "請選取目錄模型，再檢查下方的名稱與限制。",
  "Edit model": "編輯模型",
  "Error: {error}": "錯誤：{error}",
  "{field}: {error}": "{field}：{error}",
  Field: "欄位",
  "Choose a supported provider before continuing.": "繼續前請選擇支援的服務供應商。",
  "Remove {name} credential?": "移除 {name} 的憑證？",
  "This removes the credential from Reina and stops affected work. The saved connection and models remain, but a model selected from this provider is deselected. It does not revoke access at the provider or log you out of Pocket ID. To use this provider again, add a new credential. This cannot be undone.":
    "這會從 Reina 移除憑證並停止受影響的工作。已儲存的連線與模型會保留，但會取消選取此服務供應商的模型。不會撤銷服務供應商端的存取權，也不會登出 Pocket ID。若要再次使用此服務供應商，請新增憑證。此操作無法復原。",
  "Credential removed. Saved models remain.": "憑證已移除，已儲存的模型會保留。",
  "Sending response to the provider…": "正在傳送回應給服務供應商…",
  "Provider saved. Save a model, then choose Select model to select it.":
    "服務供應商已儲存。請儲存模型，再按「選取模型」選取。",
  "Choose a catalog model with Select catalog model before saving.":
    "儲存前請先按「選取目錄模型」選擇模型。",
  "Model saved. Use Select model to save your model preference.":
    "模型已儲存。請按「選取模型」儲存模型偏好。",
  "Enter 1–64 unique repository-relative patterns, one per line, with up to 256 characters each.":
    "請輸入 1–64 個不重複且相對於儲存庫的路徑模式，每行一個，每個最多 256 個字元。",
  'Enter a JSON array of 1–8 argv arrays, such as [["npm","run","ci"]]. Each command needs 1–32 non-empty string arguments, up to 4,096 characters each, without line breaks or null characters.':
    '請輸入包含 1–8 個 argv 陣列的 JSON 陣列，例如 [["npm","run","ci"]]。每個指令須有 1–32 個非空字串引數，每個最多 4,096 個字元，不可包含換行或 null 字元。',
  "Enter a whole number from 1 to 9,007,199,254,740,991.":
    "請輸入 1 至 9,007,199,254,740,991 之間的整數。",
  "Use at least 32 characters without leading or trailing spaces or control characters.":
    "請使用至少 32 個字元，不可包含前後空白或控制字元。",
  "Runtime settings saved and reload requested. Refresh status to check the applied state.":
    "執行環境設定已儲存，並已要求重新載入。請重新整理狀態以確認套用結果。",
  "Complete the one-time service setup. Missing: {fields}.":
    "請完成一次性服務設定。缺少：{fields}。",
  "Service App status is unavailable. Refresh settings before continuing.":
    "無法取得服務 App 狀態。繼續前請重新整理設定。",
  "Opening official GitHub authorization in this tab…": "正在此分頁開啟 GitHub 官方授權頁面…",
  "Opening the official GitHub App installation page in this tab…":
    "正在此分頁開啟 GitHub App 官方安裝頁面…",
  "GitHub connection attempt cancelled. Your saved repository and Runtime settings are unchanged.":
    "已取消此次 GitHub 連接。已儲存的儲存庫與執行環境設定未變更。",
  "Repository connected. An exact match to the complete saved Runtime configuration can restart scans and use model quota. New or changed worker settings and policy require Runtime Save and apply. Coding still requires explicit approval.":
    "儲存庫已連接。若與已完整儲存的執行環境設定完全相符，可能重新啟動掃描並使用模型額度。新增或變更 worker 設定與政策須在執行環境中按「儲存並套用」。修改程式碼仍須明確核准。",
  "Paste only the client secret value from GitHub (1–4,096 characters, without embedded control characters).":
    "請僅貼上 GitHub 的 client secret 值（1–4,096 個字元，不可含控制字元）。",
  "Use {minimum}–4,096 characters without leading or trailing spaces or control characters.":
    "請使用 {minimum}–4,096 個字元，不可包含前後空白或控制字元。",
  "Service App settings saved. Complete any missing service credentials, then use Connect GitHub. Runtime configuration and coding approval remain separate.":
    "服務 App 設定已儲存。請補齊缺少的服務憑證，再按「連接 GitHub」。執行環境設定與程式碼修改核准仍為獨立步驟。",
  "Select a non-empty PEM file no larger than 32 KiB.": "請選擇非空且不超過 32 KiB 的 PEM 檔案。",
  "GitHub App private key saved. Configuration will be applied automatically.":
    "GitHub App 私密金鑰已儲存，設定將自動套用。",
  "Delete GitHub App private key?": "刪除 GitHub App 私密金鑰？",
  "Reina will no longer have a GitHub App private key. Upload a new key to restore the connection. This cannot be undone.":
    "Reina 將不再持有 GitHub App 私密金鑰。上傳新金鑰即可恢復連線。此操作無法復原。",
  "GitHub App private key deleted.": "GitHub App 私密金鑰已刪除。",
  "Model selection cleared.": "已清除模型選取。",
  "Configuration reload requested. Refresh settings to check the applied state.":
    "已要求重新載入設定。請重新整理設定以確認套用結果。",
  "Signed out of the Reina session. Provider credentials and Pocket ID sign-in are unchanged.":
    "已登出 Reina 工作階段。服務供應商憑證與 Pocket ID 登入狀態未變更。",
  "Choose a model from the catalog first.": "請先從目錄選擇模型。",
  "Catalog model selected for this form. Codex SDK 1.5.0 ignores the maximum output tokens setting. Gateway time, request-count, and response-size limits still apply; they are not an upstream token or billing cap. Save the model, then select it separately for Reina.":
    "已為此表單選取目錄模型。Codex SDK 1.5.0 會忽略輸出 token 數量上限設定。Gateway 的時間、請求數量與回應大小限制仍有效，但不代表上游 token 或費用上限。請儲存模型，再另外選取供 Reina 使用。",
  "Catalog model selected for this form. Review its settings, then save. The maximum output tokens setting is at most 4,096. Select the saved model separately for Reina.":
    "已為此表單選取目錄模型。請檢查設定後儲存。輸出 token 數量上限設定最多為 4,096。請另外選取已儲存的模型供 Reina 使用。",
}
