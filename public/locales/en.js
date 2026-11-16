// English source messages are stable keys. Keep interpolation names unchanged.
export const en = {
  "Models · Reina": "Models · Reina",
  "Sign in · Reina": "Sign in · Reina",
  "Skip to content": "Skip to content",
  "Reina home": "Reina home",
  ADMINISTRATION: "ADMINISTRATION",
  WORKSPACE: "WORKSPACE",
  Settings: "Settings",
  Models: "Models",
  "GitHub App": "GitHub App",
  Runtime: "Runtime",
  "Your agent, configured.": "Your agent, configured.",
  "Manage the connections that power Reina.": "Manage the connections that power Reina.",
  "Workspace settings": "Workspace settings",
  Language: "Language",
  "Loading account…": "Loading account…",
  "Reina session": "Reina session",
  "Log out of Reina": "Log out of Reina",
  CONFIGURATION: "CONFIGURATION",
  "Configure a provider. Select a model for Reina.":
    "Configure a provider. Select a model for Reina.",
  "＋ Configure provider": "＋ Configure provider",
  "Loading your settings…": "Loading your settings…",
  "Retry loading settings": "Retry loading settings",
  "Enable JavaScript to manage Reina settings.": "Enable JavaScript to manage Reina settings.",
  "Runtime configuration": "Runtime configuration",
  RUNTIME: "RUNTIME",
  "Checking configuration…": "Checking configuration…",
  "Open Runtime settings": "Open Runtime settings",
  "Applying configuration can start bounded issue scans and use the selected model. Coding still requires explicit approval.":
    "Applying configuration can start bounded issue scans and use the selected model. Coding still requires explicit approval.",
  "Refresh status": "Refresh status",
  "Apply configuration": "Apply configuration",
  Providers: "Providers",
  "Credentials stay private": "Credentials stay private",
  "MAKE THE FIRST CONNECTION": "MAKE THE FIRST CONNECTION",
  "A model for your workflow": "A model for your workflow",
  "Connect an account or API key, save a model,": "Connect an account or API key, save a model,",
  "then select it for Reina.": "then select it for Reina.",
  "Configure your first provider": "Configure your first provider",
  "Configure provider": "Configure provider",
  "Save model": "Save model",
  "Select model": "Select model",
  "Saved models": "Saved models",
  "Clear selection": "Clear selection",
  "Saving a model does not select it. Choose": "Saving a model does not select it. Choose",
  "to save your preference. Runtime status shows whether the configuration is applied.":
    "to save your preference. Runtime status shows whether the configuration is applied.",
  "No saved models yet. Configure a provider, then save a model from its catalog or enter your own.":
    "No saved models yet. Configure a provider, then save a model from its catalog or enter your own.",
  "Runtime settings": "Runtime settings",
  "Configure one repository and its worker policy. Refresh status keeps your unsaved edits.":
    "Configure one repository and its worker policy. Refresh status keeps your unsaved edits.",
  "GitHub identity": "GitHub identity",
  "Connect GitHub to select a verified repository.":
    "Connect GitHub to select a verified repository.",
  "Open GitHub settings": "Open GitHub settings",
  "Advanced GitHub identity": "Advanced GitHub identity",
  "Manual identity fields are retained for compatibility. A connected repository supplies these values automatically.":
    "Manual identity fields are retained for compatibility. A connected repository supplies these values automatically.",
  "GitHub App ID (required)": "GitHub App ID (required)",
  "Webhook secret (required for first save)": "Webhook secret (required for first save)",
  "Write-only. Enter at least 32 characters for the first save. Use the same secret in your GitHub App webhook configuration. Saved secrets are never displayed.":
    "Write-only. Enter at least 32 characters for the first save. Use the same secret in your GitHub App webhook configuration. Saved secrets are never displayed.",
  "Repository owner (required)": "Repository owner (required)",
  "Repository name (required)": "Repository name (required)",
  "Repository ID (required)": "Repository ID (required)",
  "Installation ID (required)": "Installation ID (required)",
  "Worker image": "Worker image",
  "Immutable worker image ID (required)": "Immutable worker image ID (required)",
  "Use a prepared worker image ID, sha256: followed by 64 lowercase hexadecimal characters, or an image reference pinned with @sha256: and that digest. Tags alone are not allowed.":
    "Use a prepared worker image ID, sha256: followed by 64 lowercase hexadecimal characters, or an image reference pinned with @sha256: and that digest. Tags alone are not allowed.",
  "Repository policy": "Repository policy",
  "Allowed paths (required)": "Allowed paths (required)",
  "One repository-relative pattern per line, up to 64 patterns of 256 characters each. Blank lines are ignored. Forbidden paths take priority.":
    "One repository-relative pattern per line, up to 64 patterns of 256 characters each. Blank lines are ignored. Forbidden paths take priority.",
  "Forbidden paths (required)": "Forbidden paths (required)",
  "Name this repository's security and deployment domains. For example, src/auth/**, infra/**, or .github/** may need protection in your repository. These examples are not a complete policy. Enter your own list: one repository-relative pattern per line, up to 64 patterns of 256 characters each.":
    "Name this repository's security and deployment domains. For example, src/auth/**, infra/**, or .github/** may need protection in your repository. These examples are not a complete policy. Enter your own list: one repository-relative pattern per line, up to 64 patterns of 256 characters each.",
  "Verification commands (required)": "Verification commands (required)",
  'Enter a JSON array of argument arrays, for example [["npm","run","ci"]]. Use 1–8 commands with 1–32 non-empty string arguments each. Commands run directly, not through a shell. Do not enter a shell command string.':
    'Enter a JSON array of argument arrays, for example [["npm","run","ci"]]. Use 1–8 commands with 1–32 non-empty string arguments each. Commands run directly, not through a shell. Do not enter a shell command string.',
  "Advanced runtime limits": "Advanced runtime limits",
  "Scan and job limits": "Scan and job limits",
  "Maximum concurrent jobs is fixed at 1. Reina runs one job at a time to keep work bounded.":
    "Maximum concurrent jobs is fixed at 1. Reina runs one job at a time to keep work bounded.",
  "Scan interval (milliseconds, required)": "Scan interval (milliseconds, required)",
  "60,000–86,400,000 ms. Default: 900,000 ms (15 minutes).":
    "60,000–86,400,000 ms. Default: 900,000 ms (15 minutes).",
  "Maximum issues per scan (required)": "Maximum issues per scan (required)",
  "Agent timeout (milliseconds, required)": "Agent timeout (milliseconds, required)",
  "1,000–600,000 ms. Default: 600,000 ms (10 minutes).":
    "1,000–600,000 ms. Default: 600,000 ms (10 minutes).",
  "Maximum changed files (required)": "Maximum changed files (required)",
  "Maximum patch size (bytes, required)": "Maximum patch size (bytes, required)",
  "Saving also applies these settings with a safe runtime reload. Issue scans and model use can start; coding still requires explicit approval.":
    "Saving also applies these settings with a safe runtime reload. Issue scans and model use can start; coding still requires explicit approval.",
  "Save and apply configuration": "Save and apply configuration",
  "Connect GitHub": "Connect GitHub",
  "Authorize your GitHub account, then choose a repository available to this service's GitHub App. Existing App installations can be reused.":
    "Authorize your GitHub account, then choose a repository available to this service's GitHub App. Existing App installations can be reused.",
  "Not connected": "Not connected",
  "Continue to the official GitHub authorization page in this tab. Repository selection can resume a matching saved Runtime configuration. Coding still requires explicit approval.":
    "Continue to the official GitHub authorization page in this tab. Repository selection can resume a matching saved Runtime configuration. Coding still requires explicit approval.",
  "This service needs one-time GitHub App setup. Choose Connect GitHub to open the missing settings. Existing App keys and matching webhook settings are retained.":
    "This service needs one-time GitHub App setup. Choose Connect GitHub to open the missing settings. Existing App keys and matching webhook settings are retained.",
  Repository: "Repository",
  "Connected by": "Connected by",
  "Connected at": "Connected at",
  "Choose an authorized repository": "Choose an authorized repository",
  "Repository (required)": "Repository (required)",
  "Only verified repositories available to your account and this App are listed. Selection is not saved until you choose Use repository.":
    "Only verified repositories available to your account and this App are listed. Selection is not saved until you choose Use repository.",
  "Choose a repository": "Choose a repository",
  "Repository selection can resume a complete saved Runtime configuration. The App, repository, and installation must match. Scans use its saved worker image and policy and can use model quota. Unsaved form edits do not stop this restart. Save and apply is required to change worker settings or policy. Repository selection does not approve coding.":
    "Repository selection can resume a complete saved Runtime configuration. The App, repository, and installation must match. Scans use its saved worker image and policy and can use model quota. Unsaved form edits do not stop this restart. Save and apply is required to change worker settings or policy. Repository selection does not approve coding.",
  "Use repository": "Use repository",
  "Install / manage App": "Install / manage App",
  "Refresh repositories": "Refresh repositories",
  "Cancel connection": "Cancel connection",
  "To add repositories, use Install / manage App on GitHub. If organization approval is required, ask an organization owner to approve the request, then refresh repositories to check access again. If this connection attempt has expired, use Connect GitHub again. Reina cannot approve requests for you.":
    "To add repositories, use Install / manage App on GitHub. If organization approval is required, ask an organization owner to approve the request, then refresh repositories to check access again. If this connection attempt has expired, use Connect GitHub again. Reina cannot approve requests for you.",
  "Service operator: one-time GitHub App setup": "Service operator: one-time GitHub App setup",
  "This section is for the service operator, not users connecting a repository. Register an existing GitHub App for this Reina service. Credentials are write-only and are never displayed.":
    "This section is for the service operator, not users connecting a repository. Register an existing GitHub App for this Reina service. Credentials are write-only and are never displayed.",
  "In your GitHub App settings, register the exact callback URL and setup URL below. Enable":
    "In your GitHub App settings, register the exact callback URL and setup URL below. Enable",
  "Redirect on update": "Redirect on update",
  Leave: "Leave",
  "Request user authorization (OAuth) during installation":
    "Request user authorization (OAuth) during installation",
  "off. Connect GitHub starts a separate authorization flow with PKCE.":
    "off. Connect GitHub starts a separate authorization flow with PKCE.",
  "Enter the App ID and client secret. Configure the same webhook secret in GitHub and Reina. Upload the App's unencrypted PEM private key below.":
    "Enter the App ID and client secret. Configure the same webhook secret in GitHub and Reina. Upload the App's unencrypted PEM private key below.",
  "Callback URL": "Callback URL",
  "Setup URL": "Setup URL",
  "Service credentials": "Service credentials",
  "Register service App": "Register service App",
  "Secrets are write-only. Leave a secret blank to keep its saved value for the same App. A different App requires new secrets. Client secret: paste the generated value from GitHub (1–4,096 characters); surrounding whitespace is removed. Webhook secret: 32–4,096 characters; whitespace is not changed.":
    "Secrets are write-only. Leave a secret blank to keep its saved value for the same App. A different App requires new secrets. Client secret: paste the generated value from GitHub (1–4,096 characters); surrounding whitespace is removed. Webhook secret: 32–4,096 characters; whitespace is not changed.",
  "Client secret (required)": "Client secret (required)",
  "Webhook secret (required)": "Webhook secret (required)",
  "Save service App": "Save service App",
  "App private key": "App private key",
  "The service operator uploads the App's PEM private key once for this service.":
    "The service operator uploads the App's PEM private key once for this service.",
  "Not configured": "Not configured",
  Fingerprint: "Fingerprint",
  "No key uploaded": "No key uploaded",
  "Last uploaded": "Last uploaded",
  "Upload private key": "Upload private key",
  "PEM file (required)": "PEM file (required)",
  "Select an unencrypted RSA private key downloaded from your GitHub App (at least 2048 bits). Maximum 32 KiB. Its contents are never displayed.":
    "Select an unencrypted RSA private key downloaded from your GitHub App (at least 2048 bits). Maximum 32 KiB. Its contents are never displayed.",
  "Delete private key": "Delete private key",
  "Write-only credentials.": "Write-only credentials.",
  "Reina returns only the key fingerprint and configuration status. Upload a new file to replace an existing key.":
    "Reina returns only the key fingerprint and configuration status. Upload a new file to replace an existing key.",
  "Connection settings": "Connection settings",
  CONNECTION: "CONNECTION",
  "Close provider dialog": "Close provider dialog",
  "Select authentication method": "Select authentication method",
  "Sign in with an account": "Sign in with an account",
  "Authorize a supported provider account.": "Authorize a supported provider account.",
  "Sign in with an API key": "Sign in with an API key",
  "Use the provider's prompts, or configure a custom endpoint.":
    "Use the provider's prompts, or configure a custom endpoint.",
  "Only methods supported by Reina are listed. Credentials save separately from model selection.":
    "Only methods supported by Reina are listed. Credentials save separately from model selection.",
  "Supported sign-in limits": "Supported sign-in limits",
  "OpenAI API keys use OpenAI. ChatGPT account login uses the separate OpenAI Codex provider. OpenAI and OpenRouter callback-based account login, Radius, filesystem credentials, and GitHub Enterprise login are not available here. A saved credential does not confirm subscription access or model availability.":
    "OpenAI API keys use OpenAI. ChatGPT account login uses the separate OpenAI Codex provider. OpenAI and OpenRouter callback-based account login, Radius, filesystem credentials, and GitHub Enterprise login are not available here. A saved credential does not confirm subscription access or model availability.",
  Continue: "Continue",
  "Search providers": "Search providers",
  "Search by name or ID": "Search by name or ID",
  "Select provider (required)": "Select provider (required)",
  "Loading catalog…": "Loading catalog…",
  "Retry catalog": "Retry catalog",
  "Add custom provider": "Add custom provider",
  "Confirm GitHub Copilot policy changes": "Confirm GitHub Copilot policy changes",
  "Starting GitHub Copilot sign-in may enable model policies on your GitHub account. Continue only if you permit these remote changes. Only public github.com accounts are supported.":
    "Starting GitHub Copilot sign-in may enable model policies on your GitHub account. Continue only if you permit these remote changes. Only public github.com accounts are supported.",
  "Allow policy changes and continue": "Allow policy changes and continue",
  "Provider credential": "Provider credential",
  "Update credential": "Update credential",
  "Remove credential": "Remove credential",
  "Provider sign-in": "Provider sign-in",
  "Open the verification link in a new tab. If your browser blocks it, copy the link address and open it yourself. Reina does not open popups automatically.":
    "Open the verification link in a new tab. If your browser blocks it, copy the link address and open it yourself. Reina does not open popups automatically.",
  "Provider response": "Provider response",
  "Display name (required)": "Display name (required)",
  "e.g. My provider": "e.g. My provider",
  "API (required)": "API (required)",
  "The API selects the wire protocol used for model requests.":
    "The API selects the wire protocol used for model requests.",
  "Select an API": "Select an API",
  "Base URL (required)": "Base URL (required)",
  "Use an HTTPS API endpoint, including its version path. Do not include credentials, a query, or a fragment.":
    "Use an HTTPS API endpoint, including its version path. Do not include credentials, a query, or a fragment.",
  "API key (optional)": "API key (optional)",
  "Write-only. You can add a key later; a key is required to use a model.":
    "Write-only. You can add a key later; a key is required to use a model.",
  "Save provider": "Save provider",
  Back: "Back",
  Cancel: "Cancel",
  MODEL: "MODEL",
  "Close model dialog": "Close model dialog",
  "Search model catalog": "Search model catalog",
  "Search by model name or ID": "Search by model name or ID",
  "Catalog models": "Catalog models",
  "Select catalog model": "Select catalog model",
  "Or enter a custom model below": "Or enter a custom model below",
  "e.g. My model": "e.g. My model",
  "Model ID (required)": "Model ID (required)",
  "The exact model identifier. Start with a letter or digit; use only letters, digits, dots, underscores, slashes, and hyphens.":
    "The exact model identifier. Start with a letter or digit; use only letters, digits, dots, underscores, slashes, and hyphens.",
  "e.g. model-name-version": "e.g. model-name-version",
  "Advanced limits": "Advanced limits",
  "Context window: 4,096–4,000,000 tokens. Maximum output tokens setting: 256–4,096 tokens. Codex SDK 1.5.0 ignores this setting. Gateway time, request-count, and response-size limits still apply; they are not an upstream token or billing cap.":
    "Context window: 4,096–4,000,000 tokens. Maximum output tokens setting: 256–4,096 tokens. Codex SDK 1.5.0 ignores this setting. Gateway time, request-count, and response-size limits still apply; they are not an upstream token or billing cap.",
  "Context window (tokens, required)": "Context window (tokens, required)",
  "Maximum output tokens setting (required)": "Maximum output tokens setting (required)",
  "CONFIRM DELETION": "CONFIRM DELETION",
  "Delete item?": "Delete item?",
  Delete: "Delete",
  "YOUR AGENT. YOUR WORKSPACE.": "YOUR AGENT. YOUR WORKSPACE.",
  "Welcome to Reina": "Welcome to Reina",
  "Sign in to configure your models": "Sign in to configure your models",
  "and GitHub App connection.": "and GitHub App connection.",
  "Continue with Pocket ID": "Continue with Pocket ID",
  "Secure access through your Pocket ID account.": "Secure access through your Pocket ID account.",
  "Reina administration": "Reina administration",
  "Sign-in could not be completed. Please try again.":
    "Sign-in could not be completed. Please try again.",
  "This account does not have access to Reina. Contact your administrator.":
    "This account does not have access to Reina. Contact your administrator.",
  "Sign-in is not configured. Contact your administrator.":
    "Sign-in is not configured. Contact your administrator.",
  "The request could not be processed. Reload the page and try again.":
    "The request could not be processed. Reload the page and try again.",
  "Check the highlighted fields and try again.": "Check the highlighted fields and try again.",
  "Reina returned an unexpected response. Reload the page and try again.":
    "Reina returned an unexpected response. Reload the page and try again.",
  "Settings are unavailable. Try again or contact your administrator.":
    "Settings are unavailable. Try again or contact your administrator.",
  "Use a public HTTPS endpoint without credentials, a query, or a fragment.":
    "Use a public HTTPS endpoint without credentials, a query, or a fragment.",
  "Use a public HTTPS provider endpoint. Private network addresses are not allowed.":
    "Use a public HTTPS provider endpoint. Private network addresses are not allowed.",
  "The provider redirected to a different origin. Check its base URL.":
    "The provider redirected to a different origin. Check its base URL.",
  "Enter a new API key when changing the provider endpoint.":
    "Enter a new API key when changing the provider endpoint.",
  "Add a credential to this provider before selecting its model.":
    "Add a credential to this provider before selecting its model.",
  "Update this provider's credential, then try again.":
    "Update this provider's credential, then try again.",
  "This credential changed during setup. Close this dialog and try again.":
    "This credential changed during setup. Close this dialog and try again.",
  "This model is not available for the saved credential. Choose another catalog model or reconnect.":
    "This model is not available for the saved credential. Choose another catalog model or reconnect.",
  "Use context and output settings within the selected catalog model's limits.":
    "Use context and output settings within the selected catalog model's limits.",
  "Enter a response for the current provider prompt, then continue.":
    "Enter a response for the current provider prompt, then continue.",
  "Sign-in expired. Go back and start again.": "Sign-in expired. Go back and start again.",
  "Sign-in was cancelled. The previous credential is unchanged.":
    "Sign-in was cancelled. The previous credential is unchanged.",
  "Sign-in could not be completed. Go back and try again.":
    "Sign-in could not be completed. Go back and try again.",
  "Too many sign-in attempts are active. Cancel an unused attempt or try later.":
    "Too many sign-in attempts are active. Cancel an unused attempt or try later.",
  "This sign-in method is not available for this provider.":
    "This sign-in method is not available for this provider.",
  "Your Reina session is no longer active. Reload the page to sign in again.":
    "Your Reina session is no longer active. Reload the page to sign in again.",
  "Confirm the GitHub Copilot policy changes before starting.":
    "Confirm the GitHub Copilot policy changes before starting.",
  "This prompt is no longer active. Go back and start again.":
    "This prompt is no longer active. Go back and start again.",
  "The provider returned an unsupported authorization link. Sign-in was stopped.":
    "The provider returned an unsupported authorization link. Sign-in was stopped.",
  "This provider prompt is not supported in Reina.":
    "This provider prompt is not supported in Reina.",
  "Provider authorization was denied. Go back to try again.":
    "Provider authorization was denied. Go back to try again.",
  "Provider sign-in expired. Go back and start again.":
    "Provider sign-in expired. Go back and start again.",
  "Provider sign-in failed. Go back to try again.":
    "Provider sign-in failed. Go back to try again.",
  "This model is already saved for this provider.":
    "This model is already saved for this provider.",
  "The limit of 50 providers has been reached. Delete an unused provider first.":
    "The limit of 50 providers has been reached. Delete an unused provider first.",
  "The limit of 500 models has been reached. Delete an unused model first.":
    "The limit of 500 models has been reached. Delete an unused model first.",
  "The file could not be read. Select the PEM file again.":
    "The file could not be read. Select the PEM file again.",
  "Select an unencrypted RSA private key in PEM format (at least 2048 bits).":
    "Select an unencrypted RSA private key in PEM format (at least 2048 bits).",
  "GitHub connection is not configured for this service. Ask the service operator to complete App setup.":
    "GitHub connection is not configured for this service. Ask the service operator to complete App setup.",
  "This GitHub connection attempt expired. Choose Connect GitHub to start again.":
    "This GitHub connection attempt expired. Choose Connect GitHub to start again.",
  "GitHub connection could not be completed. Choose Connect GitHub to try again. Your saved repository is unchanged.":
    "GitHub connection could not be completed. Choose Connect GitHub to try again. Your saved repository is unchanged.",
  "GitHub authorization was denied. Your saved repository is unchanged. You can connect again when ready.":
    "GitHub authorization was denied. Your saved repository is unchanged. You can connect again when ready.",
  "This GitHub connection attempt is no longer current. Choose Connect GitHub to start again.":
    "This GitHub connection attempt is no longer current. Choose Connect GitHub to start again.",
  "Too many GitHub connection attempts are active. Cancel an unused attempt or try again later.":
    "Too many GitHub connection attempts are active. Cancel an unused attempt or try again later.",
  "GitHub returned an unsupported navigation URL. Navigation was stopped. Start a new connection.":
    "GitHub returned an unsupported navigation URL. Navigation was stopped. Start a new connection.",
  "The request is too large. Keep runtime settings within 512 KiB, PEM files within 32 KiB, and API keys within 8,192 characters.":
    "The request is too large. Keep runtime settings within 512 KiB, PEM files within 32 KiB, and API keys within 8,192 characters.",
  "This item no longer exists. Refresh settings and try again.":
    "This item no longer exists. Refresh settings and try again.",
  "This provider no longer exists. Refresh settings and try again.":
    "This provider no longer exists. Refresh settings and try again.",
  "This model no longer exists. Refresh settings and try again.":
    "This model no longer exists. Refresh settings and try again.",
  "Your security token has expired. Reload the page and try again.":
    "Your security token has expired. Reload the page and try again.",
  "This action is not allowed. Reload the page and try again.":
    "This action is not allowed. Reload the page and try again.",
  "Could not reach Reina. Check your connection and try again.":
    "Could not reach Reina. Check your connection and try again.",
  "{action} {context}": "{action} {context}",
  "The action could not be completed. Check your settings and try again.":
    "The action could not be completed. Check your settings and try again.",
  "Settings could not be loaded. Check your connection and try again.":
    "Settings could not be loaded. Check your connection and try again.",
  "Saving changes…": "Saving changes…",
  "Changes were saved, but settings could not be refreshed. Retry loading settings before making more changes.":
    "Changes were saved, but settings could not be refreshed. Retry loading settings before making more changes.",
  "Check this value and try again.": "Check this value and try again.",
  "Webhook secret (optional replacement)": "Webhook secret (optional replacement)",
  "Secret configured. Leave blank to keep it, or enter at least 32 characters to replace it. Use the same secret in your GitHub App webhook configuration. The saved secret is never displayed.":
    "Secret configured. Leave blank to keep it, or enter at least 32 characters to replace it. Use the same secret in your GitHub App webhook configuration. The saved secret is never displayed.",
  "Applying configuration": "Applying configuration",
  "Configuration applied": "Configuration applied",
  "Configuration incomplete": "Configuration incomplete",
  "Configuration could not be applied": "Configuration could not be applied",
  "Choose a saved model to continue.": "Choose a saved model to continue.",
  "Ask the service operator to complete GitHub App setup.":
    "Ask the service operator to complete GitHub App setup.",
  "Complete Runtime settings to continue.": "Complete Runtime settings to continue.",
  "Server environment settings are incomplete. Contact your administrator.":
    "Server environment settings are incomplete. Contact your administrator.",
  "Server cleanup failed. Ask your administrator to check cleanup and restart Reina.":
    "Server cleanup failed. Ask your administrator to check cleanup and restart Reina.",
  "Settings could not be read. Contact your administrator.":
    "Settings could not be read. Contact your administrator.",
  "Check GitHub App credentials and server sandbox configuration.":
    "Check GitHub App credentials and server sandbox configuration.",
  "{state}. {reason}": "{state}. {reason}",
  "Selected model: {name}.": "Selected model: {name}.",
  "No model selected.": "No model selected.",
  "Key configured": "Key configured",
  "Fingerprint unavailable": "Fingerprint unavailable",
  "Replace private key": "Replace private key",
  "Repository or App identity changed. Stored Runtime settings were not changed. The worker image and forbidden paths were cleared in this form. Review the allowed paths, verification commands, and limits for this target before saving and applying.":
    "Repository or App identity changed. Stored Runtime settings were not changed. The worker image and forbidden paths were cleared in this form. Review the allowed paths, verification commands, and limits for this target before saving and applying.",
  "Connected repository: {repository}. Identity is supplied by Connect GitHub. An exact match to the complete saved Runtime configuration can restart scans and use model quota. New or changed worker settings and policy require Runtime Save and apply. Coding still requires explicit approval.":
    "Connected repository: {repository}. Identity is supplied by Connect GitHub. An exact match to the complete saved Runtime configuration can restart scans and use model quota. New or changed worker settings and policy require Runtime Save and apply. Coding still requires explicit approval.",
  "No connected repository. Connect GitHub to select a verified repository, or use Advanced GitHub identity to enter a manual target.":
    "No connected repository. Connect GitHub to select a verified repository, or use Advanced GitHub identity to enter a manual target.",
  "Client secret": "Client secret",
  "Webhook secret": "Webhook secret",
  "{label} (required)": "{label} (required)",
  "{label} (optional replacement)": "{label} (optional replacement)",
  "GitHub App ID": "GitHub App ID",
  "OAuth client secret": "OAuth client secret",
  "Repository connected": "Repository connected",
  "{repository} · Repository ID {repositoryId} · Installation ID {installationId} · App ID {appId}":
    "{repository} · Repository ID {repositoryId} · Installation ID {installationId} · App ID {appId}",
  "{login} · User ID {id}": "{login} · User ID {id}",
  "Date unavailable": "Date unavailable",
  "Connect GitHub / change repository": "Connect GitHub / change repository",
  "Unavailable in this service version": "Unavailable in this service version",
  "Client secret: {client}. Webhook secret: {webhook}. Private key: {key}.":
    "Client secret: {client}. Webhook secret: {webhook}. Private key: {key}.",
  configured: "configured",
  "not configured": "not configured",
  "Service App status is unavailable. Ask the service operator to update Reina before using Connect GitHub.":
    "Service App status is unavailable. Ask the service operator to update Reina before using Connect GitHub.",
  " as {login}": " as {login}",
  "Choose Connect GitHub to authorize an account and select a repository. Your saved repository, if any, stays unchanged until you choose Use repository.":
    "Choose Connect GitHub to authorize an account and select a repository. Your saved repository, if any, stays unchanged until you choose Use repository.",
  "Missing service settings: {fields}. Choose Connect GitHub to open the required setup fields.":
    "Missing service settings: {fields}. Choose Connect GitHub to open the required setup fields.",
  "GitHub service status is unavailable. Refresh settings or contact the service operator.":
    "GitHub service status is unavailable. Refresh settings or contact the service operator.",
  "GitHub authorization has started. Complete authorization on GitHub, or cancel this attempt and connect again.":
    "GitHub authorization has started. Complete authorization on GitHub, or cancel this attempt and connect again.",
  "GitHub authorized{user}. Choose a repository, then choose Use repository to save it. Use Install / manage App to add repositories.":
    "GitHub authorized{user}. Choose a repository, then choose Use repository to save it. Use Install / manage App to add repositories.",
  "GitHub authorized{user}, but no repositories are available. Install the App or request organization approval, then refresh repositories.":
    "GitHub authorized{user}, but no repositories are available. Install the App or request organization approval, then refresh repositories.",
  "GitHub authorized{user}. No App installation with an available repository was found. Install the App or request organization approval, then refresh repositories.":
    "GitHub authorized{user}. No App installation with an available repository was found. Install the App or request organization approval, then refresh repositories.",
  "Checking GitHub connection…": "Checking GitHub connection…",
  "API key configured": "API key configured",
  "Subscription configured": "Subscription configured",
  "Account configured": "Account configured",
  "{provider} · {count} saved model": "{provider} · {count} saved model",
  "{provider} · {count} saved models": "{provider} · {count} saved models",
  "Built-in provider": "Built-in provider",
  Edit: "Edit",
  "Delete saved connection to {name}?": "Delete saved connection to {name}?",
  "This deletes the saved connection, its credential, and all its saved models. If one is selected, the selection is cleared. Built-in providers remain in the catalog. This cannot be undone.":
    "This deletes the saved connection, its credential, and all its saved models. If one is selected, the selection is cleared. Built-in providers remain in the catalog. This cannot be undone.",
  "Saved connection deleted.": "Saved connection deleted.",
  "＋ Save model": "＋ Save model",
  "for {name}": "for {name}",
  "Selected model": "Selected model",
  "{provider} · Context window: {context} tokens · {output}":
    "{provider} · Context window: {context} tokens · {output}",
  "Maximum output tokens setting: ignored by SDK 1.5.0":
    "Maximum output tokens setting: ignored by SDK 1.5.0",
  "Maximum output tokens: {count}": "Maximum output tokens: {count}",
  "{model} from {provider}": "{model} from {provider}",
  "Delete {name}?": "Delete {name}?",
  "This deletes the saved model and clears the current selection. The provider and its credential will remain.":
    "This deletes the saved model and clears the current selection. The provider and its credential will remain.",
  "This deletes the saved model. The provider and its credential will remain.":
    "This deletes the saved model. The provider and its credential will remain.",
  "Model deleted.": "Model deleted.",
  "Add a credential to {name} before selecting this model.":
    "Add a credential to {name} before selecting this model.",
  "{name} selected. Check runtime status to confirm that the configuration is applied.":
    "{name} selected. Check runtime status to confirm that the configuration is applied.",
  "Connect your GitHub account and choose a repository.":
    "Connect your GitHub account and choose a repository.",
  "Configure the repository, worker image, and runtime policy.":
    "Configure the repository, worker image, and runtime policy.",
  "{page} · Reina": "{page} · Reina",
  "Catalog unavailable. Retry, or go back to choose another method. Custom endpoints are available only with API keys.":
    "Catalog unavailable. Retry, or go back to choose another method. Custom endpoints are available only with API keys.",
  "Catalog unavailable. Close and reopen to retry. Built-in providers require a catalog model.":
    "Catalog unavailable. Close and reopen to retry. Built-in providers require a catalog model.",
  "Catalog unavailable. Enter a custom model below, or close and reopen to retry.":
    "Catalog unavailable. Enter a custom model below, or close and reopen to retry.",
  "{count} providers. Select a provider to configure.":
    "{count} providers. Select a provider to configure.",
  "No matching providers. Try another search.": "No matching providers. Try another search.",
  "No providers support this method in Reina. Go back to choose another method.":
    "No providers support this method in Reina. Go back to choose another method.",
  "{description}{method}": "{description}{method}",
  "Providers available for sign in with an account. OpenAI Codex is separate from OpenAI API keys.":
    "Providers available for sign in with an account. OpenAI Codex is separate from OpenAI API keys.",
  "Providers available for sign in with an API key. Built-in providers use their own setup prompts.":
    "Providers available for sign in with an API key. Built-in providers use their own setup prompts.",
  " Authentication method: {name}.": " Authentication method: {name}.",
  "{count} models. Select a catalog model, then review it before saving.":
    "{count} models. Select a catalog model, then review it before saving.",
  "No matching catalog models. Try another search. Built-in providers require a catalog model.":
    "No matching catalog models. Try another search. Built-in providers require a catalog model.",
  "No matching models. Try another search or enter a custom model below.":
    "No matching models. Try another search or enter a custom model below.",
  "{status} — {method}. Updating keeps this saved connection and authentication method. Models and selection save separately.":
    "{status} — {method}. Updating keeps this saved connection and authentication method. Models and selection save separately.",
  Account: "Account",
  "API key": "API key",
  "Add credential": "Add credential",
  "API key configured. Leave blank to keep it, or enter a new key to replace it. Changing the endpoint requires a new key. The saved key is never returned.":
    "API key configured. Leave blank to keep it, or enter a new key to replace it. Changing the endpoint requires a new key. The saved key is never returned.",
  "Write-only. A key is needed to use a model. You can save the provider without one.":
    "Write-only. A key is needed to use a model. You can save the provider without one.",
  "Step 1: Select authentication method": "Step 1: Select authentication method",
  "Step 2: Select provider": "Step 2: Select provider",
  "Step 3: Confirm remote policy changes": "Step 3: Confirm remote policy changes",
  "Manage credential": "Manage credential",
  "Step 3: Complete provider sign-in": "Step 3: Complete provider sign-in",
  "Step 3: Add custom provider": "Step 3: Add custom provider",
  "Edit custom provider": "Edit custom provider",
  "Select provider": "Select provider",
  "Edit provider": "Edit provider",
  "Starting provider sign-in…": "Starting provider sign-in…",
  "Sign-in stopped. Go back to try again.": "Sign-in stopped. Go back to try again.",
  "{error} Existing credentials and model selection were not changed by this attempt.":
    "{error} Existing credentials and model selection were not changed by this attempt.",
  "Open authorization page": "Open authorization page",
  "Open this link to authorize your account.": "Open this link to authorize your account.",
  "Continue account authorization.": "Continue account authorization.",
  "Authentication in progress.": "Authentication in progress.",
  Authorization: "Authorization",
  "Authorization link unavailable: only secure HTTPS links are allowed. Go back and retry sign-in.":
    "Authorization link unavailable: only secure HTTPS links are allowed. Go back and retry sign-in.",
  "Enter this code on the provider's verification page:":
    "Enter this code on the provider's verification page:",
  "Open verification page": "Open verification page",
  "Credential saved. Refreshing settings…": "Credential saved. Refreshing settings…",
  "Credential saved. Model selection is unchanged. Save a model, then use Select model to save your preference.":
    "Credential saved. Model selection is unchanged. Save a model, then use Select model to save your preference.",
  "Credential saved, but settings could not be refreshed. Retry loading settings before making more changes.":
    "Credential saved, but settings could not be refreshed. Retry loading settings before making more changes.",
  "Complete the provider prompt to continue.": "Complete the provider prompt to continue.",
  "Waiting for the provider. You can go back or cancel sign-in.":
    "Waiting for the provider. You can go back or cancel sign-in.",
  "Choose an option": "Choose an option",
  "Built-in providers use exact catalog model IDs. Select a catalog model before saving. Each model keeps its own API and endpoint.":
    "Built-in providers use exact catalog model IDs. Select a catalog model before saving. Each model keeps its own API and endpoint.",
  "Choose a catalog model, then review its name and limits below.":
    "Choose a catalog model, then review its name and limits below.",
  "Edit model": "Edit model",
  "Error: {error}": "Error: {error}",
  "{field}: {error}": "{field}: {error}",
  Field: "Field",
  "Choose a supported provider before continuing.":
    "Choose a supported provider before continuing.",
  "Remove {name} credential?": "Remove {name} credential?",
  "This removes the credential from Reina and stops affected work. The saved connection and models remain, but a model selected from this provider is deselected. It does not revoke access at the provider or log you out of Pocket ID. To use this provider again, add a new credential. This cannot be undone.":
    "This removes the credential from Reina and stops affected work. The saved connection and models remain, but a model selected from this provider is deselected. It does not revoke access at the provider or log you out of Pocket ID. To use this provider again, add a new credential. This cannot be undone.",
  "Credential removed. Saved models remain.": "Credential removed. Saved models remain.",
  "Sending response to the provider…": "Sending response to the provider…",
  "Provider saved. Save a model, then choose Select model to select it.":
    "Provider saved. Save a model, then choose Select model to select it.",
  "Choose a catalog model with Select catalog model before saving.":
    "Choose a catalog model with Select catalog model before saving.",
  "Model saved. Use Select model to save your model preference.":
    "Model saved. Use Select model to save your model preference.",
  "Enter 1–64 unique repository-relative patterns, one per line, with up to 256 characters each.":
    "Enter 1–64 unique repository-relative patterns, one per line, with up to 256 characters each.",
  'Enter a JSON array of 1–8 argv arrays, such as [["npm","run","ci"]]. Each command needs 1–32 non-empty string arguments, up to 4,096 characters each, without line breaks or null characters.':
    'Enter a JSON array of 1–8 argv arrays, such as [["npm","run","ci"]]. Each command needs 1–32 non-empty string arguments, up to 4,096 characters each, without line breaks or null characters.',
  "Enter a whole number from 1 to 9,007,199,254,740,991.":
    "Enter a whole number from 1 to 9,007,199,254,740,991.",
  "Use at least 32 characters without leading or trailing spaces or control characters.":
    "Use at least 32 characters without leading or trailing spaces or control characters.",
  "Runtime settings saved and reload requested. Refresh status to check the applied state.":
    "Runtime settings saved and reload requested. Refresh status to check the applied state.",
  "Complete the one-time service setup. Missing: {fields}.":
    "Complete the one-time service setup. Missing: {fields}.",
  "Service App status is unavailable. Refresh settings before continuing.":
    "Service App status is unavailable. Refresh settings before continuing.",
  "Opening official GitHub authorization in this tab…":
    "Opening official GitHub authorization in this tab…",
  "Opening the official GitHub App installation page in this tab…":
    "Opening the official GitHub App installation page in this tab…",
  "GitHub connection attempt cancelled. Your saved repository and Runtime settings are unchanged.":
    "GitHub connection attempt cancelled. Your saved repository and Runtime settings are unchanged.",
  "Repository connected. An exact match to the complete saved Runtime configuration can restart scans and use model quota. New or changed worker settings and policy require Runtime Save and apply. Coding still requires explicit approval.":
    "Repository connected. An exact match to the complete saved Runtime configuration can restart scans and use model quota. New or changed worker settings and policy require Runtime Save and apply. Coding still requires explicit approval.",
  "Paste only the client secret value from GitHub (1–4,096 characters, without embedded control characters).":
    "Paste only the client secret value from GitHub (1–4,096 characters, without embedded control characters).",
  "Use {minimum}–4,096 characters without leading or trailing spaces or control characters.":
    "Use {minimum}–4,096 characters without leading or trailing spaces or control characters.",
  "Service App settings saved. Complete any missing service credentials, then use Connect GitHub. Runtime configuration and coding approval remain separate.":
    "Service App settings saved. Complete any missing service credentials, then use Connect GitHub. Runtime configuration and coding approval remain separate.",
  "Select a non-empty PEM file no larger than 32 KiB.":
    "Select a non-empty PEM file no larger than 32 KiB.",
  "GitHub App private key saved. Configuration will be applied automatically.":
    "GitHub App private key saved. Configuration will be applied automatically.",
  "Delete GitHub App private key?": "Delete GitHub App private key?",
  "Reina will no longer have a GitHub App private key. Upload a new key to restore the connection. This cannot be undone.":
    "Reina will no longer have a GitHub App private key. Upload a new key to restore the connection. This cannot be undone.",
  "GitHub App private key deleted.": "GitHub App private key deleted.",
  "Model selection cleared.": "Model selection cleared.",
  "Configuration reload requested. Refresh settings to check the applied state.":
    "Configuration reload requested. Refresh settings to check the applied state.",
  "Signed out of the Reina session. Provider credentials and Pocket ID sign-in are unchanged.":
    "Signed out of the Reina session. Provider credentials and Pocket ID sign-in are unchanged.",
  "Choose a model from the catalog first.": "Choose a model from the catalog first.",
  "Catalog model selected for this form. Codex SDK 1.5.0 ignores the maximum output tokens setting. Gateway time, request-count, and response-size limits still apply; they are not an upstream token or billing cap. Save the model, then select it separately for Reina.":
    "Catalog model selected for this form. Codex SDK 1.5.0 ignores the maximum output tokens setting. Gateway time, request-count, and response-size limits still apply; they are not an upstream token or billing cap. Save the model, then select it separately for Reina.",
  "Catalog model selected for this form. Review its settings, then save. The maximum output tokens setting is at most 4,096. Select the saved model separately for Reina.":
    "Catalog model selected for this form. Review its settings, then save. The maximum output tokens setting is at most 4,096. Select the saved model separately for Reina.",
}
