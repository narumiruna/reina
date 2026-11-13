const $ = (id) => document.getElementById(id)

if (document.body.dataset.page === "login") {
  const messages = {
    login_failed: "Sign-in could not be completed. Please try again.",
    access_denied: "This account does not have access to Reina. Contact your administrator.",
    auth_not_configured: "Sign-in is not configured. Contact your administrator.",
  }
  const code = new URLSearchParams(location.search).get("error")
  if (code) {
    $("login-error").textContent = Object.hasOwn(messages, code)
      ? messages[code]
      : messages.login_failed
    $("login-error").hidden = false
  }
} else if (document.body.dataset.page === "admin") {
  initializeAdmin()
}

function initializeAdmin() {
  let settings = null
  let runtimeFormInitialized = false
  let githubAppFormInitialized = false
  let githubView = null
  let githubViewRequested = false
  let githubNavigating = false
  const callbackUrl = new URL(location.href)
  const githubCallback = callbackUrl.searchParams.get("github_connect")
  let githubCallbackError =
    githubCallback && githubCallback !== "ready"
      ? callbackUrl.searchParams.get("error") || githubCallback
      : null
  if (githubCallback) {
    callbackUrl.searchParams.delete("github_connect")
    callbackUrl.searchParams.delete("error")
    history.replaceState(
      null,
      "",
      `${callbackUrl.pathname}${callbackUrl.search}${callbackUrl.hash}`,
    )
  }
  let catalog = null
  let catalogRequest = null
  let busy = false
  let providerEditId = null
  let modelEditId = null
  let modelProviderId = null
  let pendingDelete = null
  let setup = null
  let sessionExpired = false
  let modelOptions = []
  let catalogModels = []
  let searchAnnouncement
  const apiNames = {
    "openai-completions": "OpenAI Completions",
    "openai-responses": "OpenAI Responses",
    "anthropic-messages": "Anthropic Messages",
    "google-generative-ai": "Google Generative AI",
  }
  const runtimeFields = {
    appId: "runtime-app-id",
    "repository.owner": "runtime-repository-owner",
    "repository.name": "runtime-repository-name",
    "repository.id": "runtime-repository-id",
    "repository.installationId": "runtime-installation-id",
    image: "runtime-image",
    allowedPaths: "runtime-allowed-paths",
    forbiddenPaths: "runtime-forbidden-paths",
    commands: "runtime-commands",
    scanIntervalMs: "runtime-scan-interval",
    maxIssuesPerScan: "runtime-max-issues",
    agentTimeoutMs: "runtime-agent-timeout",
    maxChangedFiles: "runtime-max-files",
    maxPatchBytes: "runtime-max-bytes",
  }
  const errorMessages = {
    invalid_request: "The request could not be processed. Reload the page and try again.",
    invalid_input: "Check the highlighted fields and try again.",
    invalid_content_type: "The request could not be processed. Reload the page and try again.",
    invalid_response: "Reina returned an unexpected response. Reload the page and try again.",
    settings_unavailable: "Settings are unavailable. Try again or contact your administrator.",
    invalid_provider_url:
      "Use a public HTTPS endpoint without credentials, a query, or a fragment.",
    provider_address_not_public:
      "Use a public HTTPS provider endpoint. Private network addresses are not allowed.",
    provider_origin_changed: "The provider redirected to a different origin. Check its base URL.",
    api_key_required_for_new_endpoint: "Enter a new API key when changing the provider endpoint.",
    provider_api_key_required: "Add a credential to this provider before selecting its model.",
    provider_credential_required: "Add a credential to this provider before selecting its model.",
    provider_reconnect_required: "Update this provider's credential, then try again.",
    provider_auth_required: "Update this provider's credential, then try again.",
    provider_credential_changed:
      "This credential changed during setup. Close this dialog and try again.",
    model_not_available:
      "This model is not available for the saved credential. Choose another catalog model or reconnect.",
    model_limits_exceeded:
      "Use context and output settings within the selected catalog model's limits.",
    provider_setup_invalid_response:
      "Enter a response for the current provider prompt, then continue.",
    setup_expired: "Sign-in expired. Go back and start again.",
    setup_cancelled: "Sign-in was cancelled. The previous credential is unchanged.",
    setup_failed: "Sign-in could not be completed. Go back and try again.",
    setup_limit: "Too many sign-in attempts are active. Cancel an unused attempt or try later.",
    unsupported_auth_method: "This sign-in method is not available for this provider.",
    unsupported_method: "This sign-in method is not available for this provider.",
    owner_inactive: "Your Reina session is no longer active. Reload the page to sign in again.",
    consent_required: "Confirm the GitHub Copilot policy changes before starting.",
    capacity: "Too many sign-in attempts are active. Cancel an unused attempt or try later.",
    stale_prompt: "This prompt is no longer active. Go back and start again.",
    unsafe_authorization_url:
      "The provider returned an unsupported authorization link. Sign-in was stopped.",
    unsupported_prompt: "This provider prompt is not supported in Reina.",
    access_denied: "Provider authorization was denied. Go back to try again.",
    login_expired: "Provider sign-in expired. Go back and start again.",
    login_failed: "Provider sign-in failed. Go back to try again.",
    invalid_prompt: "This prompt is no longer active. Go back and start again.",
    policy_confirmation_required: "Confirm the GitHub Copilot policy changes before starting.",
    model_already_exists: "This model is already saved for this provider.",
    provider_limit: "The limit of 50 providers has been reached. Delete an unused provider first.",
    model_limit: "The limit of 500 models has been reached. Delete an unused model first.",
    file_read_failed: "The file could not be read. Select the PEM file again.",
    invalid_private_key:
      "Select an unencrypted RSA private key in PEM format (at least 2048 bits).",
    github_connect_not_configured:
      "GitHub connection is not configured for this service. Ask the service operator to complete App setup.",
    github_connect_expired:
      "This GitHub connection attempt expired. Choose Connect GitHub to start again.",
    github_connect_failed:
      "GitHub connection could not be completed. Choose Connect GitHub to try again. Your saved repository is unchanged.",
    github_connect_access_denied:
      "GitHub authorization was denied. Your saved repository is unchanged. You can connect again when ready.",
    github_connect_stale:
      "This GitHub connection attempt is no longer current. Choose Connect GitHub to start again.",
    github_connect_limit:
      "Too many GitHub connection attempts are active. Cancel an unused attempt or try again later.",
    unsafe_github_url:
      "GitHub returned an unsupported navigation URL. Navigation was stopped. Start a new connection.",
    payload_too_large:
      "The request is too large. Keep runtime settings within 512 KiB, PEM files within 32 KiB, and API keys within 8,192 characters.",
    not_found: "This item no longer exists. Refresh settings and try again.",
    provider_not_found: "This provider no longer exists. Refresh settings and try again.",
    model_not_found: "This model no longer exists. Refresh settings and try again.",

    csrf_failed: "Your security token has expired. Reload the page and try again.",
    forbidden: "This action is not allowed. Reload the page and try again.",
    network_error: "Could not reach Reina. Check your connection and try again.",
  }

  function node(tag, className, text) {
    const element = document.createElement(tag)
    if (className) element.className = className
    if (text !== undefined) element.textContent = text
    return element
  }

  function button(text, className, onClick, context) {
    const element = node("button", className, text)
    element.type = "button"
    if (context) element.setAttribute("aria-label", `${text} ${context}`)
    element.addEventListener("click", onClick)
    return element
  }

  function status(target, message = "", kind = "") {
    target.textContent = message
    target.classList.remove("error", "pending")
    if (kind) target.classList.add(kind)
  }

  function errorMessage(error) {
    return (
      errorMessages[error.code] ||
      errorMessages[String(error.code).replace(/^provider_(?:setup|auth)_/, "")] ||
      "The action could not be completed. Check your settings and try again."
    )
  }

  async function request(path, { method = "GET", data, pem } = {}) {
    const headers = method === "GET" ? {} : { Accept: "application/json" }
    if (method !== "GET") {
      if (!settings?.csrfToken) throw { code: "csrf_failed" }
      headers["x-csrf-token"] = settings.csrfToken
    }
    if (data !== undefined) headers["Content-Type"] = "application/json"
    if (pem !== undefined) headers["Content-Type"] = "application/x-pem-file"
    let response
    try {
      response = await fetch(path, {
        method,
        headers,
        credentials: "same-origin",
        cache: "no-store",
        mode: "same-origin",
        body: pem !== undefined ? pem : data !== undefined ? JSON.stringify(data) : undefined,
      })
    } catch {
      throw { code: "network_error" }
    }
    if (response.status === 401) {
      sessionExpired = true
      abandonSetup()
      location.replace("/login")
      throw { code: "unauthorized" }
    }
    let result
    try {
      result = await response.json()
    } catch {
      throw { code: "invalid_response" }
    }
    if (!response.ok || (result.error && !result.status)) {
      throw {
        code: typeof result.error === "string" ? result.error : "request_failed",
        fields: Array.isArray(result.fields) ? result.fields : [],
      }
    }
    return result
  }

  async function refreshSettings(guard = () => true) {
    const next = await request("/api/settings")
    if (!guard() || sessionExpired) return
    if (!Array.isArray(next.providers) || typeof next.csrfToken !== "string")
      throw { code: "invalid_response" }
    settings = next
    renderSettings()
    $("settings-content").hidden = false
    $("retry-settings").hidden = true
  }

  async function loadSettings() {
    if (busy) return
    busy = true
    const controls = [...document.querySelectorAll("button, input, select, textarea")].map(
      (control) => [control, control.disabled],
    )
    controls.forEach(([control]) => {
      control.disabled = true
    })
    $("settings-content").setAttribute("aria-busy", "true")
    status($("page-status"), "Loading your settings…", "pending")
    try {
      await refreshSettings()
      status($("page-status"))
    } catch (error) {
      if (error.code !== "unauthorized") {
        status(
          $("page-status"),
          "Settings could not be loaded. Check your connection and try again.",
          "error",
        )
        $("retry-settings").hidden = false
      }
    } finally {
      busy = false
      controls.forEach(([control, disabled]) => {
        if (control.isConnected) control.disabled = disabled
      })
      $("retry-settings").disabled = false
      $("settings-content").removeAttribute("aria-busy")
      if (settings) updateControls()
    }
    if (settings && !$("github-page").hidden) await loadGithubView()
  }

  // Mutations are serialized. Inputs and close controls stay fixed while a request is pending.
  async function mutate({
    path,
    method,
    data,
    file,
    target = $("page-status"),
    form,
    success,
    onSaved,
    refresh = true,
  }) {
    if (busy) return
    busy = true
    const controls = [...document.querySelectorAll("button, input, select, textarea")].map(
      (control) => [control, control.disabled],
    )
    controls.forEach(([control]) => {
      control.disabled = true
    })
    const dialog = target.closest("dialog")
    ;(dialog || $("settings-content")).setAttribute("aria-busy", "true")
    status(target, "Saving changes…", "pending")
    let saved = false
    const invalidControls = []
    try {
      let pem
      if (file) {
        try {
          pem = await file.text()
        } catch {
          throw { code: "file_read_failed" }
        }
      }
      const response = request(path, { method, data, pem })
      // Only the in-flight request retains a serialized secret.
      pem = undefined
      if (data?.apiKey) delete data.apiKey
      if (data?.webhookSecret) delete data.webhookSecret
      if (data?.clientSecret) delete data.clientSecret
      const result = await response
      saved = true
      await onSaved?.(result)
      if (refresh) await refreshSettings()
      if (dialog?.open) dialog.close("saved")
      if (success !== undefined) status(dialog ? $("page-status") : target, success)
    } catch (error) {
      if (error.code !== "unauthorized") {
        if (
          target === $("github-connect-status") &&
          ["github_connect_expired", "github_connect_stale"].includes(error.code)
        ) {
          githubView = null
          renderGithubView()
        }
        const message =
          saved && error.code !== "unsafe_github_url"
            ? "Changes were saved, but settings could not be refreshed. Retry loading settings before making more changes."
            : errorMessage(error)
        if (saved && dialog?.open) dialog.close("saved")
        status(saved && dialog ? $("page-status") : target, message, "error")
        if (saved) {
          $("retry-settings").hidden = false
        } else if (form && error.fields?.length) {
          for (const name of error.fields) {
            const names =
              form.id === "runtime-form"
                ? [...Object.keys(runtimeFields), "webhookSecret"].filter(
                    (field) =>
                      field === name ||
                      field.startsWith(`${name}.`) ||
                      name.startsWith(`${field}.`),
                  )
                : [name]
            for (const field of names) {
              const control = form.elements.namedItem(field)
              if (
                !(
                  control instanceof HTMLInputElement ||
                  control instanceof HTMLSelectElement ||
                  control instanceof HTMLTextAreaElement
                )
              )
                continue
              if (control.closest("details")) control.closest("details").open = true
              control.setCustomValidity("Check this value and try again.")
              invalidControls.push(control)
            }
          }
        }
      }
    } finally {
      busy = githubNavigating
      controls.forEach(([control, disabled]) => {
        if (control.isConnected && !githubNavigating) control.disabled = disabled
      })
      ;(dialog || $("settings-content")).removeAttribute("aria-busy")
      // Freshly rendered controls did not exist when the pending state started.
      if (settings) updateControls()
      for (const control of invalidControls) syncValidation(control, true)
      invalidControls[0]?.focus()
      if (saved) focusAfterRemoval()
      if (githubNavigating) {
        // Browser Back can restore this disabled page from the back/forward cache.
        window.addEventListener(
          "pageshow",
          () => {
            githubNavigating = false
            busy = false
            controls.forEach(([control, disabled]) => {
              if (control.isConnected) control.disabled = disabled
            })
            updateControls()
            if (!$("github-page").hidden) void loadGithubView()
          },
          { once: true },
        )
      }
      if (githubViewRequested && !busy) void loadGithubView()
    }
  }

  function focusAfterRemoval() {
    // Native dialogs restore their invoker. Only use a page heading if that invoker was removed.
    if (document.activeElement === document.body && !document.querySelector("dialog[open]"))
      $("page-title").focus()
  }

  function normalizedUrl(value) {
    return value.replace(/\/+$/, "")
  }

  function catalogForProvider(provider) {
    if (provider.sdkProviderId)
      return (catalog?.providers || []).filter((preset) => preset.id === provider.sdkProviderId)
    // Custom endpoints retain protocol-based suggestions. Built-ins use all their own models.
    const matches = (catalog?.providers || [])
      .map((preset) => ({
        ...preset,
        models: preset.models.filter((model) => model.api === provider.api),
      }))
      .filter((preset) => preset.models.length)
    const exact = matches
      .map((preset) => ({
        ...preset,
        models: preset.models.filter(
          (model) => normalizedUrl(model.baseUrl) === normalizedUrl(provider.baseUrl),
        ),
      }))
      .filter((preset) => preset.models.length)
    return exact.length ? exact : matches
  }

  function updateControls() {
    $("add-provider").disabled = !settings || busy
    $("logout-form").querySelector("button").disabled = !settings || busy
    $("clear-selection").hidden = !settings.selectedModelId
    $("delete-key").hidden = !settings.github.configured
    const configured = settings.githubApp?.configured === true
    $("github-connect").disabled = busy
    const authorized =
      ["select_repository", "install_required"].includes(githubView?.state) &&
      (!Number.isFinite(githubView?.expiresAt) || githubView.expiresAt > Date.now())
    $("github-refresh").disabled = busy || !configured || !authorized
    $("github-install").disabled = busy || !configured
    $("github-cancel").disabled = busy
    $("github-repository-select").disabled = busy
    $("github-use-repository").disabled = busy
    $("github-save-app").disabled = busy || !settings.githubApp
    const repositoryReview = !$("runtime-repository-review").hidden
    $("reload-runtime").disabled = busy || repositoryReview
    if (repositoryReview) $("runtime-settings-link").hidden = false
  }

  function populateRuntimeSettings(runtime) {
    if (runtime) {
      for (const [name, id] of Object.entries(runtimeFields)) {
        const value = name.startsWith("repository.")
          ? runtime.repository[name.slice("repository.".length)]
          : runtime[name]
        $(id).value =
          name === "commands"
            ? JSON.stringify(value, null, 2)
            : Array.isArray(value)
              ? value.join("\n")
              : String(value)
      }
    }
    // The safe settings view never supplies a secret to this write-only control.
    $("runtime-webhook-secret").value = ""
    resetValidation($("runtime-form"))
    renderRuntimeSecretStatus(runtime)
  }

  function renderRuntimeSecretStatus(runtime = settings.runtimeSettings) {
    const app = settings.githubApp
    const appId = Number($("runtime-app-id").value)
    const inherited =
      app?.webhookSecretConfigured === true &&
      (app.clientSecretConfigured === true || app.configured === true) &&
      positiveId(app.appId) &&
      app.appId === appId
    const configured =
      inherited || (runtime?.webhookSecretConfigured === true && runtime.appId === appId)
    const secret = $("runtime-webhook-secret")
    secret.closest(".field").hidden = inherited
    secret.required = !configured
    if (inherited) secret.value = ""
    $("runtime-secret-label").textContent = configured
      ? "Webhook secret (optional replacement)"
      : "Webhook secret (required for first save)"
    $("runtime-secret-hint").textContent = configured
      ? "Secret configured. Leave blank to keep it, or enter at least 32 characters to replace it. Use the same secret in your GitHub App webhook configuration. The saved secret is never displayed."
      : "Write-only. Enter at least 32 characters for the first save. Use the same secret in your GitHub App webhook configuration. Saved secrets are never displayed."
  }

  function renderSettings() {
    if (!runtimeFormInitialized) {
      populateRuntimeSettings(settings.runtimeSettings)
      syncRuntimeConnection()
      runtimeFormInitialized = true
    }
    renderRuntimeSecretStatus()
    const providers = settings.providers
    const models = providers.flatMap((provider) =>
      provider.models.map((model) => ({ ...model, provider })),
    )
    $("user-name").textContent = settings.user.name
    $("user-avatar").textContent = (Array.from(settings.user.name.trim())[0] || "R").toUpperCase()
    $("provider-count").textContent = String(providers.length)
    $("model-count").textContent = String(models.length)
    $("provider-empty").hidden = providers.length > 0
    $("models-empty").hidden = models.length > 0
    $("provider-list").replaceChildren(...providers.map(renderProvider))
    $("model-list").replaceChildren(...models.map(renderModel))
    const selected = models.find((model) => model.id === settings.selectedModelId)
    const runtime = settings.runtime
    const states = {
      starting: "Applying configuration",
      running: "Configuration applied",
      not_configured: "Configuration incomplete",
      failed: "Configuration could not be applied",
    }
    const reasons = {
      configure_model: "Choose a saved model to continue.",
      upload_private_key: "Ask the service operator to complete GitHub App setup.",
      configure_runtime: "Complete Runtime settings to continue.",
      configure_environment:
        "Server environment settings are incomplete. Contact your administrator.",
      cleanup_requires_operator_check:
        "Server cleanup failed. Ask your administrator to check cleanup and restart Reina.",
      settings_unavailable: "Settings could not be read. Contact your administrator.",
      authentication_or_sandbox_unavailable:
        "Check GitHub App credentials and server sandbox configuration.",
    }
    const runtimeText = states[runtime.state] || "Runtime configuration"
    $("runtime-status").textContent =
      `${runtimeText}. ${reasons[runtime.reason] || (selected ? `Selected model: ${selected.name}.` : "No model selected.")}`
    $("runtime-settings-link").hidden = runtime.reason !== "configure_runtime"
    $("github-badge").textContent = settings.github.configured ? "Key configured" : "Not configured"
    $("github-badge").classList.toggle("good", settings.github.configured)
    $("github-fingerprint").textContent = settings.github.configured
      ? settings.github.fingerprint || "Fingerprint unavailable"
      : "No key uploaded"
    const uploaded = settings.github.uploadedAt
    $("github-uploaded").textContent =
      uploaded && Number.isFinite(new Date(uploaded).getTime())
        ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
            new Date(uploaded),
          )
        : "—"
    $("key-form-title").textContent = settings.github.configured
      ? "Replace private key"
      : "Upload private key"
    $("upload-key").textContent = settings.github.configured
      ? "Replace private key"
      : "Upload private key"
    renderGithubSettings()
    updateControls()
  }

  function positiveId(value) {
    return Number.isSafeInteger(value) && value > 0
  }

  function syncRuntimeConnection(explicit = false) {
    const connection = settings.githubConnection
    const appId = connection?.appId ?? settings.githubApp?.appId
    if (positiveId(appId)) $("runtime-app-id").value = String(appId)
    if (!connection) return
    const repository = connection.repository
    const previousId = Number($("runtime-repository-id").value)
    if (previousId !== repository.id && (explicit || settings.runtimeSettings)) {
      $("runtime-image").value = ""
      $("runtime-forbidden-paths").value = ""
      $("runtime-repository-review").hidden = false
      $("runtime-repository-review").textContent =
        "Repository changed. Stored Runtime settings were not changed. The worker image and forbidden paths were cleared in this form. Review the allowed paths, verification commands, and limits for this repository before saving and applying."
    }
    for (const name of [
      "appId",
      "repository.owner",
      "repository.name",
      "repository.id",
      "repository.installationId",
    ]) {
      const control = $(runtimeFields[name])
      control.value = String(name === "appId" ? connection.appId : repository[name.slice(11)])
      control.readOnly = true
    }
    $("runtime-connection-status").textContent =
      `Connected repository: ${repository.owner}/${repository.name}. Identity is supplied by Connect GitHub. The worker image and policy still require review and a separate Save and apply action.`
    resetValidation($("runtime-form"))
    renderRuntimeSecretStatus()
  }

  function updateGithubSecretRequirements() {
    const app = settings?.githubApp
    // A legacy webhook can exist before the first service App save.
    const sameApp = !positiveId(app?.appId) || Number($("github-app-id").value) === app.appId
    for (const [id, configured, label] of [
      ["github-client-secret", app?.clientSecretConfigured, "Client secret"],
      ["github-webhook-secret", app?.webhookSecretConfigured, "Webhook secret"],
    ]) {
      const required = !sameApp || !configured
      $(id).required = required
      $(`${id}-label`).textContent = `${label} (${required ? "required" : "optional replacement"})`
    }
  }

  function missingGithubSetupFields() {
    const app = settings?.githubApp
    if (!app) return []
    return [
      ["GitHub App ID", "github-app-id", positiveId(app.appId)],
      ["App private key", "private-key", app.privateKeyConfigured],
      ["OAuth client secret", "github-client-secret", app.clientSecretConfigured],
      ["Webhook secret", "github-webhook-secret", app.webhookSecretConfigured],
    ].filter(([, , configured]) => !configured)
  }

  function renderGithubSettings() {
    const app = settings.githubApp
    const connection = settings.githubConnection
    $("github-service-notice").hidden = app?.configured === true
    $("github-connection-badge").textContent = connection ? "Repository connected" : "Not connected"
    $("github-connection-badge").classList.toggle("good", Boolean(connection))
    $("github-connection-metadata").hidden = !connection
    if (connection) {
      const repository = connection.repository
      $("github-current-repository").textContent =
        `${repository.owner}/${repository.name} · Repository ID ${repository.id} · Installation ID ${repository.installationId} · App ID ${connection.appId}`
      $("github-current-user").textContent =
        `${connection.user.login} · User ID ${connection.user.id}`
      const connectedAt = new Date(connection.connectedAt)
      $("github-connected-at").textContent = Number.isFinite(connectedAt.getTime())
        ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
            connectedAt,
          )
        : "Date unavailable"
    }
    $("github-connect").textContent = connection
      ? "Connect GitHub / change repository"
      : "Connect GitHub"
    if (app?.configured !== true) {
      $("github-connect").setAttribute("aria-controls", "github-service-setup")
      $("github-connect").setAttribute("aria-expanded", String($("github-service-setup").open))
    } else {
      $("github-connect").removeAttribute("aria-controls")
      $("github-connect").removeAttribute("aria-expanded")
    }
    $("github-callback-url").textContent = app?.callbackUrl || "Unavailable in this service version"
    $("github-setup-url").textContent = app?.setupUrl || "Unavailable in this service version"
    $("github-service-status").textContent = app
      ? `Client secret: ${app.clientSecretConfigured ? "configured" : "not configured"}. Webhook secret: ${app.webhookSecretConfigured ? "configured" : "not configured"}. Private key: ${app.privateKeyConfigured ? "configured" : "not configured"}.`
      : "Service App status is unavailable. Ask the service operator to update Reina before using Connect GitHub."
    if (!githubAppFormInitialized) {
      if (positiveId(app?.appId)) $("github-app-id").value = String(app.appId)
      githubAppFormInitialized = true
    }
    updateGithubSecretRequirements()
  }

  function renderGithubView() {
    const expired = Number.isFinite(githubView?.expiresAt) && githubView.expiresAt <= Date.now()
    const state = expired ? "idle" : githubView?.state || "idle"
    const repositories = githubView?.repositories || []
    const canSelect = state === "select_repository" && repositories.length > 0
    const authorized = ["select_repository", "install_required"].includes(state)
    const select = $("github-repository-select")
    const previous = select.value
    select.replaceChildren(
      new Option("Choose a repository", ""),
      ...repositories.map((repository) => new Option(repository.fullName, String(repository.id))),
    )
    select.value = previous
    if (select.selectedIndex < 0) select.value = ""
    $("github-repository-form").hidden = !canSelect
    $("github-install").hidden = !authorized
    $("github-install-help").hidden = !authorized
    $("github-cancel").hidden = state === "idle"
    const user = githubView?.user?.login ? ` as ${githubView.user.login}` : ""
    const missing = missingGithubSetupFields().map(([label]) => label)
    const messages = {
      idle:
        settings.githubApp?.configured === true
          ? "Choose Connect GitHub to authorize an account and select a repository. Your saved repository, if any, stays unchanged until you choose Use repository."
          : missing.length
            ? `Missing service settings: ${missing.join(", ")}. Choose Connect GitHub to open the required setup fields.`
            : "GitHub service status is unavailable. Refresh settings or contact the service operator.",
      connecting:
        "GitHub authorization has started. Complete authorization on GitHub, or cancel this attempt and connect again.",
      select_repository: canSelect
        ? `GitHub authorized${user}. Choose a repository, then choose Use repository to save it. Use Install / manage App to add repositories.`
        : `GitHub authorized${user}, but no repositories are available. Install the App or request organization approval, then refresh repositories.`,
      install_required: `GitHub authorized${user}. No App installation with an available repository was found. Install the App or request organization approval, then refresh repositories.`,
    }
    const code = githubCallbackError || (expired ? "github_connect_expired" : null)
    status(
      $("github-connect-status"),
      code
        ? Object.hasOwn(errorMessages, code) && code.startsWith("github_connect_")
          ? errorMessages[code]
          : errorMessages.github_connect_failed
        : messages[state],
      code ? "error" : state === "idle" && settings.githubApp?.configured !== true ? "pending" : "",
    )
    githubCallbackError = null
  }

  async function loadGithubView() {
    if (!settings || busy || $("github-page").hidden) return
    githubViewRequested = false
    if (settings.githubApp?.configured !== true) {
      githubView = null
      renderGithubView()
      return
    }
    busy = true
    const controls = [...document.querySelectorAll("button, input, select, textarea")].map(
      (control) => [control, control.disabled],
    )
    controls.forEach(([control]) => {
      control.disabled = true
    })
    $("github-page").setAttribute("aria-busy", "true")
    status($("github-connect-status"), "Checking GitHub connection…", "pending")
    try {
      applyGithubView(await request("/api/github/connect"))
    } catch (error) {
      githubView = null
      renderGithubView()
      if (error.code !== "unauthorized")
        status($("github-connect-status"), errorMessage(error), "error")
    } finally {
      busy = false
      controls.forEach(([control, disabled]) => {
        if (control.isConnected) control.disabled = disabled
      })
      $("github-page").removeAttribute("aria-busy")
      updateControls()
    }
  }

  function applyGithubView(view) {
    if (
      !["idle", "connecting", "select_repository", "install_required"].includes(view.state) ||
      !Array.isArray(view.repositories) ||
      !view.repositories.every(
        (repository) =>
          positiveId(repository.id) &&
          positiveId(repository.installationId) &&
          [repository.owner, repository.name, repository.fullName].every(
            (value) => typeof value === "string" && value.length > 0,
          ),
      )
    )
      throw { code: "invalid_response" }
    githubView = view
    renderGithubView()
  }

  function navigateGithub(result, installation = false) {
    try {
      const url = new URL(result.url)
      const trusted = "https://github.com"
      const sameOrigin =
        "Origin" in globalThis
          ? Origin.from(url).isSameOrigin(Origin.from(trusted))
          : url.origin !== "null" && url.origin === new URL(trusted).origin
      const allowedPath = installation
        ? /^\/apps\/[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?\/installations\/new$/.test(url.pathname)
        : url.pathname === "/login/oauth/authorize"
      if (
        !sameOrigin ||
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        !allowedPath
      )
        throw { code: "unsafe_github_url" }
      githubNavigating = true
      location.assign(url.href)
    } catch {
      githubNavigating = false
      throw { code: "unsafe_github_url" }
    }
  }

  function credentialStatus(provider) {
    if (!provider.hasCredential) return "Not configured"
    if (provider.authType !== "oauth") return "API key configured"
    return provider.authDetails?.oauth?.isSubscription === true
      ? "Subscription configured"
      : "Account configured"
  }

  function renderProvider(provider) {
    const item = node("li", "provider-card")
    const top = node("div", "card-top")
    const identity = node("div", "provider-identity")
    const mark = node(
      "span",
      "provider-mark",
      Array.from(provider.name).slice(0, 2).join("").toUpperCase(),
    )
    mark.setAttribute("aria-hidden", "true")
    const title = node("div")
    title.append(
      node("h3", "", provider.name),
      node("p", "mono", provider.sdkProviderId || provider.baseUrl),
    )
    identity.append(mark, title)
    top.append(
      identity,
      node("span", `badge${provider.hasCredential ? " good" : ""}`, credentialStatus(provider)),
    )
    const bottom = node("div", "card-bottom")
    const info = node("div")
    info.append(
      node(
        "p",
        "",
        `${provider.sdkProviderId ? "Built-in provider" : apiNames[provider.api] || provider.api} · ${provider.models.length} saved ${provider.models.length === 1 ? "model" : "models"}`,
      ),
    )
    const actions = node("div", "card-actions")
    actions.append(
      button("Edit", "quiet", () => openProvider(provider), provider.name),
      button(
        "Delete",
        "quiet danger",
        () =>
          confirmDelete({
            path: `/api/providers/${encodeURIComponent(provider.id)}`,
            title: `Delete saved connection to ${provider.name}?`,
            description:
              "This deletes the saved connection, its credential, and all its saved models. If one is selected, the selection is cleared. Built-in providers remain in the catalog. This cannot be undone.",
            success: "Saved connection deleted.",
          }),
        provider.name,
      ),
      button("＋ Save model", "secondary", () => openModel(provider), `for ${provider.name}`),
    )
    bottom.append(info, actions)
    item.append(top, bottom)
    return item
  }

  function renderModel(model) {
    const selected = model.id === settings.selectedModelId
    const item = node("li", `model-row${selected ? " is-selected" : ""}`)
    const info = node("div", "model-info")
    const title = node("div", "model-title")
    title.append(node("h3", "", model.name))
    if (selected) title.append(node("span", "badge selected", "Selected model"))
    info.append(
      title,
      node("code", "", model.modelId),
      node(
        "p",
        "model-meta",
        `${model.provider.name} · Context window: ${model.contextWindow.toLocaleString()} tokens · ${model.provider.sdkProviderId === "openai-codex" ? "Maximum output tokens setting: ignored by SDK 1.5.0" : `Maximum output tokens: ${model.maxTokens.toLocaleString()}`}`,
      ),
    )
    const actions = node("div", "card-actions")
    actions.append(
      button(
        "Edit",
        "quiet",
        () => openModel(model.provider, model),
        `${model.name} from ${model.provider.name}`,
      ),
      button(
        "Delete",
        "quiet danger",
        () =>
          confirmDelete({
            path: `/api/models/${encodeURIComponent(model.id)}`,
            title: `Delete ${model.name}?`,
            description: selected
              ? "This deletes the saved model and clears the current selection. The provider and its credential will remain."
              : "This deletes the saved model. The provider and its credential will remain.",
            success: "Model deleted.",
          }),
        `${model.name} from ${model.provider.name}`,
      ),
    )
    const use = button(
      selected ? "Selected model" : "Select model",
      selected ? "secondary" : "primary",
      () => {
        if (selected) return
        if (!model.provider.hasCredential) {
          status(
            $("page-status"),
            `Add a credential to ${model.provider.name} before selecting this model.`,
            "error",
          )
          return
        }
        void mutate({
          path: "/api/selection",
          method: "PUT",
          data: { modelId: model.id },
          success: `${model.name} selected. Check runtime status to confirm that the configuration is applied.`,
        })
      },
      `${model.name} from ${model.provider.name}`,
    )
    if (selected) use.setAttribute("aria-disabled", "true")
    actions.append(use)
    item.append(info, actions)
    return item
  }

  function showPage({ focus = false } = {}) {
    const pages = {
      models: ["Models", "Configure a provider. Select a model for Reina."],
      github: ["GitHub App", "Connect your GitHub account and choose a repository."],
      runtime: ["Runtime", "Configure the repository, worker image, and runtime policy."],
    }
    const page = Object.hasOwn(pages, location.hash.slice(1)) ? location.hash.slice(1) : "models"
    for (const name of Object.keys(pages)) {
      $(`${name}-page`).hidden = name !== page
      $(`nav-${name}`).removeAttribute("aria-current")
    }
    $("add-provider").hidden = page !== "models"
    $("page-title").textContent = pages[page][0]
    $("page-description").textContent = pages[page][1]
    document.title = `${pages[page][0]} · Reina`
    $(`nav-${page}`).setAttribute("aria-current", "page")
    if (focus) $("page-title").focus()
    if (page === "github") {
      githubViewRequested = true
      if (settings && !busy) void loadGithubView()
    }
  }

  function populateApiOptions(preferred = "") {
    $("provider-api").replaceChildren(
      new Option("Select an API", ""),
      ...Object.entries(apiNames).map(([id, name]) => new Option(name, id)),
    )
    $("provider-api").value = preferred
  }

  async function loadCatalog() {
    if (catalog) return
    if (catalogRequest) return catalogRequest
    $("provider-catalog-status").textContent = "Loading catalog…"
    $("model-catalog-status").textContent = "Loading catalog…"
    catalogRequest = (async () => {
      try {
        const result = await request("/api/catalog")
        if (!Array.isArray(result.providers)) throw { code: "invalid_response" }
        catalog = result
      } catch (error) {
        if (error.code !== "unauthorized") {
          $("provider-catalog-status").textContent =
            "Catalog unavailable. Retry, or go back to choose another method. Custom endpoints are available only with API keys."
          $("retry-provider-catalog").hidden = false
          $("model-catalog-status").textContent = settings?.providers.find(
            (provider) => provider.id === modelProviderId,
          )?.sdkProviderId
            ? "Catalog unavailable. Close and reopen to retry. Built-in providers require a catalog model."
            : "Catalog unavailable. Enter a custom model below, or close and reopen to retry."
        }
      } finally {
        catalogRequest = null
        if (catalog && !sessionExpired) {
          if (setup?.stage === "provider") filterProviders()
          if ($("model-dialog").open) prepareModelCatalog()
        }
      }
    })()
    return catalogRequest
  }

  function announceSearch(target, message) {
    clearTimeout(searchAnnouncement)
    searchAnnouncement = setTimeout(() => {
      if (target.closest("dialog")?.open) target.textContent = message
    }, 350)
  }

  function filterProviders() {
    if (!catalog || setup?.stage !== "provider") return
    const query = $("provider-search").value.trim().toLowerCase()
    const previous = $("provider-preset").value || setup.providerId
    const options = catalog.providers.filter(
      (provider) =>
        provider.authMethods.includes(setup.authType) &&
        `${provider.name} ${provider.id}`.toLowerCase().includes(query),
    )
    $("provider-preset").replaceChildren(
      ...options.map((provider) => new Option(`${provider.name} — ${provider.id}`, provider.id)),
    )
    $("provider-preset").value = previous || ""
    $("provider-preset").disabled = !options.length
    $("continue-provider").disabled = false
    updateProviderSignInLabel()
    $("retry-provider-catalog").hidden = true
    const message = options.length
      ? `${options.length} providers. Select a provider to configure.`
      : query
        ? "No matching providers. Try another search."
        : "No providers support this method in Reina. Go back to choose another method."
    announceSearch($("provider-catalog-status"), message)
  }

  function updateProviderSignInLabel() {
    if (!setup) return
    const provider = catalog?.providers.find((item) => item.id === $("provider-preset").value)
    const details = provider?.authDetails?.[setup?.authType]
    $("continue-provider").textContent = provider
      ? details?.loginLabel ||
        (setup.authType === "oauth" ? "Sign in with an account" : "Sign in with an API key")
      : "Continue"
    $("auth-provider-description").textContent =
      (setup.authType === "oauth"
        ? "Providers available for sign in with an account. OpenAI Codex is separate from OpenAI API keys."
        : "Providers available for sign in with an API key. Built-in providers use their own setup prompts.") +
      (details?.name ? ` Authentication method: ${details.name}.` : "")
  }

  function prepareModelCatalog() {
    const provider = settings?.providers.find((item) => item.id === modelProviderId)
    if (!provider || !catalog) return
    catalogModels = catalogForProvider(provider).flatMap((preset) =>
      preset.models.map((model) => ({ ...model, catalogProvider: preset.name })),
    )
    filterModels()
  }

  function filterModels() {
    if (!catalog) return
    const query = $("model-search").value.trim().toLowerCase()
    modelOptions = catalogModels.filter((model) =>
      `${model.name} ${model.id} ${model.catalogProvider}`.toLowerCase().includes(query),
    )
    $("model-preset").replaceChildren(
      ...modelOptions.map(
        (model, index) =>
          new Option(`${model.name} — ${model.id} · ${model.catalogProvider}`, String(index)),
      ),
    )
    $("model-preset").selectedIndex = -1
    $("use-model-preset").disabled = busy || !modelOptions.length
    $("model-preset").disabled = !modelOptions.length
    announceSearch(
      $("model-catalog-status"),
      modelOptions.length
        ? `${modelOptions.length} models. Select a catalog model, then review it before saving.`
        : settings?.providers.find((provider) => provider.id === modelProviderId)?.sdkProviderId
          ? "No matching catalog models. Try another search. Built-in providers require a catalog model."
          : "No matching models. Try another search or enter a custom model below.",
    )
  }

  function openProvider(provider = null) {
    if (!settings || busy || sessionExpired) return
    abandonSetup()
    providerEditId = provider?.id || null
    setup = {
      stage: "method",
      authType: provider?.authType || null,
      providerId: provider?.sdkProviderId || null,
      savedProviderId: provider?.id || null,
      pinned: Boolean(provider?.sdkProviderId),
      pending: false,
      revision: 0,
    }
    $("auth-method-form").reset()
    resetValidation($("auth-method-form"))
    $("provider-search").value = ""
    if (setup.pinned) {
      $("auth-credential-title").textContent = provider.name
      $("auth-credential-status").textContent =
        `${credentialStatus(provider)} — ${provider.authDetails?.[provider.authType]?.name || (provider.authType === "oauth" ? "Account" : "API key")}. Updating keeps this saved connection and authentication method. Models and selection save separately.`
      $("update-credential").textContent = provider.hasCredential
        ? "Update credential"
        : "Add credential"
      $("remove-credential").hidden = !provider.hasCredential
      setSetupStage("credential", false)
    } else if (provider) {
      prepareCustomProvider(provider)
      setSetupStage("custom", false)
    } else setSetupStage("method", false)
    $("provider-dialog").showModal()
    focusSetupStage()
  }

  function prepareCustomProvider(provider = null) {
    $("provider-form").reset()
    resetValidation($("provider-form"))
    populateApiOptions(provider?.api)
    $("provider-name").value = provider?.name || ""
    $("provider-url").value = provider?.baseUrl || ""
    $("provider-key").value = ""
    $("provider-key-hint").textContent = provider?.hasApiKey
      ? "API key configured. Leave blank to keep it, or enter a new key to replace it. Changing the endpoint requires a new key. The saved key is never returned."
      : "Write-only. A key is needed to use a model. You can save the provider without one."
  }

  const setupStages = {
    method: ["auth-method-form", "Step 1: Select authentication method", "auth-account"],
    provider: ["auth-provider-form", "Step 2: Select provider", "provider-search"],
    policy: ["auth-policy-form", "Step 3: Confirm remote policy changes", "auth-policy-title"],
    credential: ["auth-credential-actions", "Manage credential", "update-credential"],
    setup: ["auth-setup", "Step 3: Complete provider sign-in", "auth-progress"],
    custom: ["provider-form", "Step 3: Add custom provider", "provider-name"],
  }

  function focusSetupStage() {
    if (!setup || !$("provider-dialog").open) return
    const target = $(setupStages[setup.stage][2])
    if (!target.matches("input, select, button")) target.tabIndex = -1
    target.focus()
  }

  function setSetupStage(stage, focus = true) {
    if (!setup) return
    setup.stage = stage
    $("provider-title").textContent =
      stage === "custom"
        ? providerEditId
          ? "Edit custom provider"
          : "Add custom provider"
        : stage === "provider"
          ? "Select provider"
          : providerEditId
            ? "Edit provider"
            : "Configure provider"
    for (const [key, [id]] of Object.entries(setupStages)) $(id).hidden = stage !== key
    $("provider-step").textContent =
      stage === "custom" && providerEditId ? "Edit custom provider" : setupStages[stage][1]
    $("provider-back").hidden =
      stage === "method" ||
      stage === "credential" ||
      (stage === "custom" && Boolean(providerEditId))
    $("auth-prompt-input").value = ""
    status($("provider-status"))
    if (focus) focusSetupStage()
  }

  function currentSetup(flow) {
    return setup === flow && $("provider-dialog").open && !sessionExpired
  }

  function cancelRemote(id) {
    if (!id || sessionExpired) return
    void request(`/api/provider-setups/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(
      () => {},
    )
  }

  function stopSetupFlow(flow) {
    if (!flow) return
    clearTimeout(flow.timer)
    flow.revision++
    if (flow.active) cancelRemote(flow.id)
    flow.active = false
    flow.pending = false
    $("auth-prompt-input").value = ""
    $("auth-prompt-select").replaceChildren()
    $("auth-prompt-form").hidden = true
    $("auth-event").replaceChildren()
    $("auth-progress").textContent = ""
    $("auth-link-help").hidden = true
  }

  function abandonSetup() {
    const previous = setup
    setup = null
    stopSetupFlow(previous)
  }

  function showProviderPicker() {
    setSetupStage("provider")
    $("custom-provider").hidden = setup.authType !== "api_key"
    $("provider-preset").replaceChildren()
    updateProviderSignInLabel()
    $("continue-provider").disabled = !catalog
    if (catalog) filterProviders()
    else void loadCatalog()
  }

  function beginSelectedProvider() {
    if (setup.providerId === "github-copilot" && setup.authType === "oauth") setSetupStage("policy")
    else void startProviderSetup(false)
  }

  async function startProviderSetup(confirmPolicyChanges) {
    const flow = setup
    if (!flow || flow.pending || flow.active || sessionExpired) return
    setSetupStage("setup")
    flow.pending = true
    flow.active = true
    flow.id = null
    flow.promptId = null
    flow.eventKey = null
    const revision = ++flow.revision
    $("auth-progress").textContent = "Starting provider sign-in…"
    try {
      const view = await request("/api/provider-setups", {
        method: "POST",
        data: {
          providerId: flow.providerId,
          authType: flow.authType,
          ...(flow.savedProviderId ? { savedProviderId: flow.savedProviderId } : {}),
          ...(confirmPolicyChanges ? { confirmPolicyChanges: true } : {}),
        },
      })
      if (!currentSetup(flow) || flow.revision !== revision) {
        cancelRemote(view.id)
        return
      }
      flow.pending = false
      flow.id = view.id
      await applySetupView(flow, view)
    } catch (error) {
      if (currentSetup(flow) && flow.revision === revision) failSetup(flow, error)
    }
  }

  function failSetup(flow, error) {
    clearTimeout(flow.timer)
    // Cancel uncertain network outcomes too. A later response cannot advance this UI.
    if (flow.active) cancelRemote(flow.id)
    flow.active = false
    flow.pending = false
    flow.revision++
    $("auth-prompt-input").value = ""
    $("auth-prompt-form").hidden = true
    $("auth-event").replaceChildren()
    $("auth-link-help").hidden = true
    $("auth-progress").textContent = "Sign-in stopped. Go back to try again."
    if (error.code !== "unauthorized")
      status(
        $("provider-status"),
        `${errorMessage(error)} Existing credentials and model selection were not changed by this attempt.`,
        "error",
      )
  }

  function safeAuthLink(url, label) {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null
      const link = node("a", "auth-link", label || "Open authorization page")
      link.href = parsed.href
      link.target = "_blank"
      link.rel = "noopener noreferrer"
      return link
    } catch {
      return null
    }
  }

  function renderAuthEvent(event) {
    const output = $("auth-event")
    output.replaceChildren()
    $("auth-link-help").hidden = true
    if (!event) return
    const addLink = (url, label) => {
      const link = safeAuthLink(url, label)
      if (link) {
        output.append(link)
        $("auth-link-help").hidden = false
      } else
        output.append(
          node(
            "p",
            "hint",
            "Authorization link unavailable: only secure HTTPS links are allowed. Go back and retry sign-in.",
          ),
        )
    }
    if (event.type === "device_code") {
      output.append(
        node("p", "hint", "Enter this code on the provider's verification page:"),
        node("output", "device-code mono", event.userCode),
      )
      addLink(event.verificationUri, "Open verification page")
      if (event.instructions) output.append(node("p", "hint", event.instructions))
    } else if (event.type === "auth_url") {
      if (event.instructions) output.append(node("p", "hint", event.instructions))
      addLink(event.url, "Open authorization page")
    } else if (event.type === "info" || event.type === "progress") {
      output.append(node("p", "hint", event.message))
      for (const link of event.links || []) addLink(link.url, link.label)
    }
  }

  async function applySetupView(flow, view) {
    if (!currentSetup(flow)) return
    if (
      typeof view.id !== "string" ||
      view.id !== flow.id ||
      view.providerId !== flow.providerId ||
      view.authType !== flow.authType
    )
      throw { code: "invalid_response" }
    if (view.status === "complete") {
      const revision = flow.revision
      const stillCompleting = () => currentSetup(flow) && flow.revision === revision
      flow.active = false
      flow.pending = true
      $("auth-prompt-input").value = ""
      $("auth-prompt-form").hidden = true
      $("auth-progress").textContent = "Credential saved. Refreshing settings…"
      try {
        await refreshSettings(stillCompleting)
        if (!stillCompleting()) return
        $("provider-dialog").close("saved")
        status(
          $("page-status"),
          "Credential saved. Model selection is unchanged. Save a model, then use Select model to save your preference.",
        )
        focusAfterRemoval()
      } catch {
        if (!stillCompleting()) return
        $("provider-dialog").close("saved")
        status(
          $("page-status"),
          "Credential saved, but settings could not be refreshed. Retry loading settings before making more changes.",
          "error",
        )
        $("retry-settings").hidden = false
        focusAfterRemoval()
      }
      return
    }
    if (["failed", "cancelled", "expired"].includes(view.status)) {
      flow.active = false
      failSetup(flow, {
        code: view.status === "failed" ? view.error || "setup_failed" : `setup_${view.status}`,
      })
      return
    }
    if (!["pending", "prompt"].includes(view.status)) throw { code: "invalid_response" }
    const eventKey = JSON.stringify(view.event || null)
    if (eventKey !== flow.eventKey) {
      flow.eventKey = eventKey
      renderAuthEvent(view.event)
    }
    const prompt = view.status === "prompt" ? view.prompt : null
    if (
      view.status === "prompt" &&
      (!prompt || !["text", "secret", "manual_code", "select"].includes(prompt.type))
    )
      throw { code: "invalid_response" }
    $("auth-progress").textContent = prompt
      ? "Complete the provider prompt to continue."
      : "Waiting for the provider. You can go back or cancel sign-in."
    if (prompt?.id !== flow.promptId) {
      flow.promptId = prompt?.id || null
      $("auth-prompt-input").value = ""
      resetValidation($("auth-prompt-form"))
      $("auth-prompt-form").hidden = !prompt
      if (prompt) {
        const isSelect = prompt.type === "select"
        const input = $("auth-prompt-input")
        const select = $("auth-prompt-select")
        input.hidden = isSelect
        input.disabled = isSelect
        input.required = false // SDK prompts can accept empty optional configuration.
        input.type = prompt.type === "secret" ? "password" : "text"
        input.autocomplete =
          prompt.type === "manual_code"
            ? "one-time-code"
            : prompt.type === "secret"
              ? "current-password"
              : "on"
        input.placeholder = prompt.placeholder || ""
        select.hidden = !isSelect
        select.disabled = !isSelect
        select.required = isSelect
        select.replaceChildren(
          new Option("Choose an option", ""),
          ...(prompt.options || []).map(
            (option) =>
              new Option(
                option.description ? `${option.label} — ${option.description}` : option.label,
                option.id,
              ),
          ),
        )
        $("auth-prompt-label").textContent = prompt.message
        $("auth-prompt-label").htmlFor = isSelect ? select.id : input.id
        $("submit-auth-prompt").disabled = false
        ;(isSelect ? select : input).focus()
      }
    }
    scheduleSetupPoll(flow)
  }

  function scheduleSetupPoll(flow) {
    clearTimeout(flow.timer)
    if (!currentSetup(flow) || !flow.active || flow.pending) return
    const revision = flow.revision
    flow.timer = setTimeout(async () => {
      try {
        const view = await request(`/api/provider-setups/${encodeURIComponent(flow.id)}`)
        if (!currentSetup(flow) || flow.revision !== revision) return
        await applySetupView(flow, view)
      } catch (error) {
        if (currentSetup(flow) && flow.revision === revision) failSetup(flow, error)
      }
    }, 1000)
  }

  function openModel(provider, model = null) {
    if (busy) return
    modelEditId = model?.id || null
    modelProviderId = provider.id
    $("model-form").reset()
    resetValidation($("model-form"))
    $("model-name").value = model?.name || ""
    $("model-id").value = model?.modelId || ""
    $("model-id").readOnly = Boolean(provider.sdkProviderId)
    $("model-id-hint").textContent = provider.sdkProviderId
      ? "Built-in providers use exact catalog model IDs. Select a catalog model before saving. Each model keeps its own API and endpoint."
      : "The exact model identifier. Start with a letter or digit; use only letters, digits, dots, underscores, slashes, and hyphens."
    $("model-presets").querySelector(".form-divider").textContent = provider.sdkProviderId
      ? "Choose a catalog model, then review its name and limits below."
      : "Or enter a custom model below"
    $("model-context").value = String(model?.contextWindow || 128000)
    $("model-output").value = String(model?.maxTokens || 4096)
    $("model-advanced").open = Boolean(model)
    $("model-title").textContent = model ? "Edit model" : "Save model"
    $("model-provider-name").textContent = provider.name
    $("model-presets").hidden = Boolean(model)
    $("model-search").value = ""
    status($("model-status"))
    $("model-dialog").showModal()
    if (model) $("model-name").focus()
    else if (catalog) prepareModelCatalog()
    else {
      $("model-preset").replaceChildren()
      $("use-model-preset").disabled = true
      void loadCatalog()
    }
  }

  function confirmDelete(options) {
    if (busy) return
    pendingDelete = options
    $("delete-title").textContent = options.title
    $("delete-description").textContent = options.description
    status($("delete-status"))
    $("delete-dialog").showModal()
  }

  // Add inline errors without exposing an untouched required field as invalid.
  const edited = new WeakSet()
  let validationAnnouncement
  let validationField
  function syncValidation(control, force = false, announce = false) {
    if (!control.matches?.("input, select, textarea") || !control.dataset.error) return
    const invalid =
      force ||
      control.matches(":user-invalid") ||
      (edited.has(control) &&
        control.getAttribute("aria-invalid") === "true" &&
        !control.validity.valid)
    const previous = control.getAttribute("aria-invalid") === "true"
    control.setAttribute("aria-invalid", String(invalid))
    const error = $(control.dataset.error)
    error.textContent = invalid ? `Error: ${control.validationMessage}` : ""
    const descriptions = (control.getAttribute("aria-describedby") || "")
      .split(/\s+/)
      .filter((id) => id && id !== error.id)
    if (invalid) descriptions.push(error.id)
    if (descriptions.length) control.setAttribute("aria-describedby", descriptions.join(" "))
    else control.removeAttribute("aria-describedby")
    if (!invalid && validationField === control) {
      clearTimeout(validationAnnouncement)
      validationField = null
    }
    if (announce && invalid && !previous) {
      clearTimeout(validationAnnouncement)
      validationField = control
      const target = control.closest("dialog")?.querySelector(".notice") || $("page-status")
      validationAnnouncement = setTimeout(
        () =>
          status(
            target,
            `${control.labels?.[0]?.textContent || "Field"}: ${control.validationMessage}`,
            "error",
          ),
        500,
      )
    }
  }

  function resetValidation(form) {
    for (const control of form.querySelectorAll("input, select, textarea")) {
      control.setCustomValidity("")
      control.setAttribute("aria-invalid", "false")
      const errorId = control.dataset.error
      if (errorId) {
        $(errorId).textContent = ""
        const ids = (control.getAttribute("aria-describedby") || "")
          .split(/\s+/)
          .filter((id) => id && id !== errorId)
        if (ids.length) control.setAttribute("aria-describedby", ids.join(" "))
        else control.removeAttribute("aria-describedby")
      }
      edited.delete(control)
    }
  }

  for (const control of document.querySelectorAll("form input, form select, form textarea")) {
    const error = node("span", "field-error")
    error.id = `${control.id}-error`
    control.dataset.error = error.id
    control.setAttribute("aria-invalid", "false")
    control.after(error)
    control.addEventListener("input", () => {
      edited.add(control)
      control.setCustomValidity("")
      syncValidation(control)
    })
    control.addEventListener("change", () => {
      edited.add(control)
      control.setCustomValidity("")
      syncValidation(control, false, true)
    })
    control.addEventListener("blur", () => {
      if (edited.has(control)) syncValidation(control, false, true)
    })
    control.addEventListener("invalid", () => {
      const details = control.closest("details")
      if (details) details.open = true
      syncValidation(control, true)
    })
  }

  $("auth-method-form").addEventListener("submit", (event) => {
    event.preventDefault()
    if (!setup) return
    setup.authType = new FormData(event.currentTarget).get("authType")
    showProviderPicker()
  })
  $("auth-provider-form").addEventListener("submit", (event) => {
    event.preventDefault()
    const provider = catalog?.providers.find(
      (item) =>
        item.id === $("provider-preset").value && item.authMethods.includes(setup?.authType),
    )
    if (!provider || !setup) {
      status($("provider-status"), "Choose a supported provider before continuing.", "error")
      $("provider-preset").focus()
      return
    }
    setup.providerId = provider.id
    beginSelectedProvider()
  })
  $("auth-policy-form").addEventListener("submit", (event) => {
    event.preventDefault()
    if (setup?.stage === "policy") void startProviderSetup(true)
  })
  $("update-credential").addEventListener("click", beginSelectedProvider)
  $("remove-credential").addEventListener("click", () => {
    const provider = settings.providers.find((item) => item.id === setup?.savedProviderId)
    if (!provider) return
    $("provider-dialog").close("remove")
    confirmDelete({
      path: `/api/providers/${encodeURIComponent(provider.id)}/credential`,
      title: `Remove ${provider.name} credential?`,
      description:
        "This removes the credential from Reina and stops affected work. The saved connection and models remain, but a model selected from this provider is deselected. It does not revoke access at the provider or log you out of Pocket ID. To use this provider again, add a new credential. This cannot be undone.",
      success: "Credential removed. Saved models remain.",
    })
  })
  $("custom-provider").addEventListener("click", () => {
    if (setup?.authType !== "api_key") return
    prepareCustomProvider()
    setSetupStage("custom")
  })
  $("retry-provider-catalog").addEventListener("click", () => void loadCatalog())
  $("provider-back").addEventListener("click", () => {
    if (!setup || busy) return
    const stage = setup.stage
    stopSetupFlow(setup)
    if (setup.pinned) setSetupStage("credential")
    else if (stage === "provider") setSetupStage("method")
    else showProviderPicker()
  })
  $("auth-prompt-form").addEventListener("submit", async (event) => {
    event.preventDefault()
    const flow = setup
    if (!flow?.active || flow.pending || !flow.promptId) return
    clearTimeout(flow.timer)
    const revision = ++flow.revision
    flow.pending = true
    const promptId = flow.promptId
    const data = {
      promptId,
      value: $("auth-prompt-select").hidden
        ? $("auth-prompt-input").value
        : $("auth-prompt-select").value,
    }
    $("auth-prompt-input").value = ""
    $("auth-prompt-select").value = ""
    $("submit-auth-prompt").disabled = true
    $("auth-prompt-input").disabled = true
    $("auth-prompt-select").disabled = true
    $("auth-progress").textContent = "Sending response to the provider…"
    try {
      const response = request(`/api/provider-setups/${encodeURIComponent(flow.id)}/responses`, {
        method: "POST",
        data,
      })
      delete data.value
      const view = await response
      if (!currentSetup(flow) || flow.revision !== revision) return
      flow.pending = false
      flow.promptId = null
      await applySetupView(flow, view)
    } catch (error) {
      if (currentSetup(flow) && flow.revision === revision) failSetup(flow, error)
    }
  })

  $("provider-form").addEventListener("submit", (event) => {
    event.preventDefault()
    if (busy) return
    const data = {
      name: $("provider-name").value.trim(),
      api: $("provider-api").value,
      baseUrl: $("provider-url").value.trim(),
    }
    if ($("provider-key").value) data.apiKey = $("provider-key").value
    $("provider-key").value = ""
    void mutate({
      path: providerEditId
        ? `/api/providers/${encodeURIComponent(providerEditId)}`
        : "/api/providers",
      method: providerEditId ? "PUT" : "POST",
      data,
      form: $("provider-form"),
      target: $("provider-status"),
      success: "Provider saved. Save a model, then choose Select model to select it.",
    })
  })

  $("model-form").addEventListener("submit", (event) => {
    event.preventDefault()
    if (busy) return
    if (!$("model-id").value) {
      status(
        $("model-status"),
        "Choose a catalog model with Select catalog model before saving.",
        "error",
      )
      $("model-preset").focus()
      return
    }
    void mutate({
      path: modelEditId
        ? `/api/models/${encodeURIComponent(modelEditId)}`
        : `/api/providers/${encodeURIComponent(modelProviderId)}/models`,
      method: modelEditId ? "PUT" : "POST",
      data: {
        name: $("model-name").value.trim(),
        modelId: $("model-id").value.trim(),
        contextWindow: Number($("model-context").value),
        maxTokens: Number($("model-output").value),
      },
      form: $("model-form"),
      target: $("model-status"),
      success: "Model saved. Use Select model to save your model preference.",
    })
  })

  function readRuntimePaths(id) {
    const control = $(id)
    const paths = control.value
      .split(/\r?\n/)
      .map((path) => path.trim())
      .filter(Boolean)
    if (
      paths.length < 1 ||
      paths.length > 64 ||
      paths.some((path) => path.length > 256) ||
      new Set(paths.map((path) => path.toLowerCase())).size !== paths.length
    )
      control.setCustomValidity(
        "Enter 1–64 unique repository-relative patterns, one per line, with up to 256 characters each.",
      )
    return paths
  }

  function readRuntimeCommands() {
    try {
      const commands = JSON.parse($("runtime-commands").value)
      if (
        Array.isArray(commands) &&
        commands.length >= 1 &&
        commands.length <= 8 &&
        commands.every(
          (argv) =>
            Array.isArray(argv) &&
            argv.length >= 1 &&
            argv.length <= 32 &&
            argv.every(
              (arg) =>
                typeof arg === "string" &&
                arg.length >= 1 &&
                arg.length <= 4096 &&
                !/[\0\r\n]/.test(arg),
            ),
        )
      )
        return commands
    } catch {
      // Parser messages can include input. Use a fixed, actionable message instead.
    }
    $("runtime-commands").setCustomValidity(
      'Enter a JSON array of 1–8 argv arrays, such as [["npm","run","ci"]]. Each command needs 1–32 non-empty string arguments, up to 4,096 characters each, without line breaks or null characters.',
    )
    return []
  }

  $("runtime-form").addEventListener("submit", (event) => {
    event.preventDefault()
    if (busy) return
    for (const id of ["runtime-app-id", "runtime-repository-id", "runtime-installation-id"]) {
      if (!Number.isSafeInteger(Number($(id).value)) || Number($(id).value) < 1)
        $(id).setCustomValidity("Enter a whole number from 1 to 9,007,199,254,740,991.")
    }
    const allowedPaths = readRuntimePaths("runtime-allowed-paths")
    const forbiddenPaths = readRuntimePaths("runtime-forbidden-paths")
    const commands = readRuntimeCommands()
    const secret = $("runtime-webhook-secret")
    if (secret.value && (secret.value.trim() !== secret.value || /[\p{Cc}]/u.test(secret.value)))
      secret.setCustomValidity(
        "Use at least 32 characters without leading or trailing spaces or control characters.",
      )
    if (!event.currentTarget.reportValidity()) return
    const data = {
      appId: Number($("runtime-app-id").value),
      repository: {
        owner: $("runtime-repository-owner").value.trim(),
        name: $("runtime-repository-name").value.trim(),
        id: Number($("runtime-repository-id").value),
        installationId: Number($("runtime-installation-id").value),
      },
      image: $("runtime-image").value.trim(),
      allowedPaths,
      forbiddenPaths,
      commands,
      scanIntervalMs: Number($("runtime-scan-interval").value),
      maxIssuesPerScan: Number($("runtime-max-issues").value),
      maxConcurrentJobs: 1,
      agentTimeoutMs: Number($("runtime-agent-timeout").value),
      maxChangedFiles: Number($("runtime-max-files").value),
      maxPatchBytes: Number($("runtime-max-bytes").value),
    }
    if (secret.value) data.webhookSecret = secret.value
    secret.value = ""
    void mutate({
      path: "/api/runtime/settings",
      method: "POST",
      data,
      form: $("runtime-form"),
      target: $("runtime-form-status"),
      success:
        "Runtime settings saved and reload requested. Refresh status to check the applied state.",
      onSaved: () => {
        populateRuntimeSettings({ ...data, webhookSecretConfigured: true })
        $("runtime-repository-review").hidden = true
      },
    })
  })

  $("runtime-app-id").addEventListener("input", () => renderRuntimeSecretStatus())
  $("runtime-app-id").addEventListener("change", () => renderRuntimeSecretStatus())

  $("github-service-setup").addEventListener("toggle", () => {
    if (settings && settings.githubApp?.configured !== true)
      $("github-connect").setAttribute("aria-expanded", String($("github-service-setup").open))
  })
  $("github-connect").addEventListener("click", () => {
    if (busy) return
    if (!settings.githubApp?.configured) {
      const missing = missingGithubSetupFields()
      $("github-service-setup").open = true
      status(
        $("github-app-status"),
        missing.length
          ? `Complete the one-time service setup. Missing: ${missing.map(([label]) => label).join(", ")}.`
          : "Service App status is unavailable. Refresh settings before continuing.",
        "pending",
      )
      const control = missing[0]
        ? $(missing[0][1])
        : $("github-service-setup").querySelector("summary")
      control.focus()
      return
    }
    githubCallbackError = null
    void mutate({
      path: "/api/github/connect",
      method: "POST",
      target: $("github-connect-status"),
      refresh: false,
      success: "Opening official GitHub authorization in this tab…",
      onSaved: (result) => navigateGithub(result),
    })
  })
  $("github-install").addEventListener("click", () => {
    void mutate({
      path: "/api/github/connect/install",
      method: "POST",
      target: $("github-connect-status"),
      refresh: false,
      success: "Opening the official GitHub App installation page in this tab…",
      onSaved: (result) => navigateGithub(result, true),
    })
  })
  $("github-refresh").addEventListener("click", () => {
    void mutate({
      path: "/api/github/connect/refresh",
      method: "POST",
      target: $("github-connect-status"),
      refresh: false,
      onSaved: applyGithubView,
    })
  })
  $("github-cancel").addEventListener("click", () => {
    void mutate({
      path: "/api/github/connect/cancel",
      method: "POST",
      target: $("github-connect-status"),
      refresh: false,
      success:
        "GitHub connection attempt cancelled. Your saved repository and Runtime settings are unchanged.",
      onSaved: () => {
        githubView = null
        renderGithubView()
      },
    })
  })
  $("github-repository-form").addEventListener("submit", (event) => {
    event.preventDefault()
    const repositoryId = Number($("github-repository-select").value)
    if (
      !positiveId(repositoryId) ||
      !githubView?.repositories.some((repository) => repository.id === repositoryId)
    )
      return
    void mutate({
      path: "/api/github/connect/select",
      method: "POST",
      data: { repositoryId },
      form: event.currentTarget,
      target: $("github-connect-status"),
      refresh: false,
      success:
        "Repository connected. Review the worker image and repository policy in Runtime settings before saving and applying. Connecting does not start the runtime or approve coding.",
      onSaved: async () => {
        await refreshSettings()
        if (!settings.githubConnection) throw { code: "invalid_response" }
        syncRuntimeConnection(true)
        githubView = null
        renderGithubView()
      },
    })
  })
  $("github-app-id").addEventListener("input", updateGithubSecretRequirements)
  $("github-app-id").addEventListener("change", updateGithubSecretRequirements)
  $("github-app-form").addEventListener("submit", (event) => {
    event.preventDefault()
    if (busy) return
    const appId = Number($("github-app-id").value)
    if (!positiveId(appId))
      $("github-app-id").setCustomValidity("Enter a whole number from 1 to 9,007,199,254,740,991.")
    updateGithubSecretRequirements()
    const data = { appId }
    for (const [id, name, minimum] of [
      ["github-client-secret", "clientSecret", 1],
      ["github-webhook-secret", "webhookSecret", 32],
    ]) {
      const control = $(id)
      const value = name === "clientSecret" ? control.value.trim() : control.value
      if (
        control.value &&
        (value.length < minimum ||
          value.length > 4096 ||
          value.trim() !== value ||
          /[\p{Cc}]/u.test(value))
      )
        control.setCustomValidity(
          name === "clientSecret"
            ? "Paste only the client secret value from GitHub (1–4,096 characters, without embedded control characters)."
            : `Use ${minimum}–4,096 characters without leading or trailing spaces or control characters.`,
        )
      if (value) data[name] = value
    }
    if (!event.currentTarget.reportValidity()) return
    $("github-client-secret").value = ""
    $("github-webhook-secret").value = ""
    void mutate({
      path: "/api/github/app",
      method: "POST",
      data,
      form: event.currentTarget,
      target: $("github-app-status"),
      success:
        "Service App settings saved. Complete any missing service credentials, then use Connect GitHub. Runtime configuration and coding approval remain separate.",
      onSaved: () => {
        githubAppFormInitialized = false
      },
    })
  })

  $("github-form").addEventListener("submit", (event) => {
    event.preventDefault()
    if (busy) return
    const file = $("private-key").files?.[0]
    if (!file) return
    if (file.size > 32768 || file.size === 0) {
      $("private-key").setCustomValidity("Select a non-empty PEM file no larger than 32 KiB.")
      syncValidation($("private-key"), true)
      $("private-key").reportValidity()
      return
    }
    // Clear the file control before sending. Private-key contents never enter the DOM.
    $("private-key").value = ""
    void mutate({
      path: "/api/github/private-key",
      method: "POST",
      file,
      success: "GitHub App private key saved. Configuration will be applied automatically.",
    })
  })

  $("delete-form").addEventListener("submit", (event) => {
    event.preventDefault()
    if (pendingDelete)
      void mutate({ ...pendingDelete, method: "DELETE", target: $("delete-status") })
  })
  $("delete-key").addEventListener("click", () =>
    confirmDelete({
      path: "/api/github/private-key",
      title: "Delete GitHub App private key?",
      description:
        "Reina will no longer have a GitHub App private key. Upload a new key to restore the connection. This cannot be undone.",
      success: "GitHub App private key deleted.",
      onSaved: () => {
        $("private-key").value = ""
      },
    }),
  )
  $("clear-selection").addEventListener("click", () => {
    void mutate({
      path: "/api/selection",
      method: "PUT",
      data: { modelId: null },
      success: "Model selection cleared.",
    })
  })
  $("reload-runtime").addEventListener("click", () => {
    void mutate({
      path: "/api/runtime/reload",
      method: "POST",
      success: "Configuration reload requested. Refresh settings to check the applied state.",
    })
  })
  $("logout-form").addEventListener("submit", (event) => {
    event.preventDefault()
    void mutate({
      path: "/auth/logout",
      method: "POST",
      success:
        "Signed out of the Reina session. Provider credentials and Pocket ID sign-in are unchanged.",
      refresh: false,
      onSaved: () => location.replace("/login"),
    })
  })
  $("retry-settings").addEventListener("click", () => void loadSettings())
  $("refresh-settings").addEventListener("click", () => void loadSettings())
  $("private-key").addEventListener("cancel", () => {
    $("private-key").value = ""
  })
  $("add-provider").addEventListener("click", () => openProvider())
  $("empty-add-provider").addEventListener("click", () => openProvider())
  $("provider-search").addEventListener("input", filterProviders)
  $("provider-preset").addEventListener("change", updateProviderSignInLabel)
  $("model-search").addEventListener("input", filterModels)
  for (const id of ["provider-catalog-status", "model-catalog-status"])
    $(id).setAttribute("role", "status")
  $("use-model-preset").addEventListener("click", () => {
    const preset = modelOptions[Number($("model-preset").value)]
    if (!preset || $("model-preset").selectedIndex < 0) {
      $("model-catalog-status").textContent = "Choose a model from the catalog first."
      $("model-preset").focus()
      return
    }
    $("model-name").value = preset.name
    $("model-id").value = preset.id
    $("model-context").value = String(preset.contextWindow)
    $("model-output").value = String(Math.min(preset.maxTokens, 4096))
    resetValidation($("model-form"))
    $("model-name").focus()
    status(
      $("model-status"),
      preset.api === "openai-codex-responses"
        ? "Catalog model selected for this form. Codex SDK 1.5.0 ignores the maximum output tokens setting. Gateway time, request-count, and response-size limits still apply; they are not an upstream token or billing cap. Save the model, then select it separately for Reina."
        : "Catalog model selected for this form. Review its settings, then save. The maximum output tokens setting is at most 4,096. Select the saved model separately for Reina.",
    )
  })

  document.querySelectorAll("[data-close]").forEach((control) => {
    control.addEventListener("click", () => {
      if (busy) return
      if (control.dataset.close === "provider-dialog") abandonSetup()
      $("provider-key").value = ""
      $(control.dataset.close).close("cancel")
    })
  })
  for (const dialog of document.querySelectorAll("dialog")) {
    dialog.addEventListener("cancel", (event) => {
      if (dialog.id === "provider-dialog" && setup?.stage === "setup") abandonSetup()
      else if (busy) event.preventDefault()
      else $("provider-key").value = ""
    })
    dialog.addEventListener("close", () => {
      // A queued close event must not reset a dialog that has already been reopened.
      if (dialog.open) return
      clearTimeout(validationAnnouncement)
      clearTimeout(searchAnnouncement)
      $("provider-key").value = ""
      if (dialog.id === "provider-dialog") {
        abandonSetup()
        $("provider-form").reset()
        resetValidation($("provider-form"))
        providerEditId = null
      }
      if (dialog.id === "model-dialog") {
        $("model-form").reset()
        resetValidation($("model-form"))
        modelEditId = null
        modelProviderId = null
      }
      if (dialog.id === "delete-dialog") pendingDelete = null
      dialog.returnValue = ""
    })
  }
  window.addEventListener("hashchange", () => showPage({ focus: true }))
  window.addEventListener("pagehide", () => {
    abandonSetup()
    $("provider-key").value = ""
    $("runtime-webhook-secret").value = ""
    $("github-client-secret").value = ""
    $("github-webhook-secret").value = ""
    $("private-key").value = ""
  })
  populateApiOptions()
  showPage()
  void loadSettings()
}
