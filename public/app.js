import { createI18n, date, list, message, number, raw } from "./i18n.js"

const { setText, setAttribute, setValidity, option } = createI18n()
const $ = (id) => document.getElementById(id)

if (document.body.dataset.page === "login") {
  const messages = {
    login_failed: message("login-error-failed"),
    access_denied: message("login-error-access-denied"),
    auth_not_configured: message("login-error-not-configured"),
  }
  const code = new URLSearchParams(location.search).get("error")
  if (code) {
    setText(
      $("login-error"),
      Object.hasOwn(messages, code) ? messages[code] : messages.login_failed,
    )
    $("login-error").hidden = false
  }
} else if (document.body.dataset.page === "admin") {
  initializeAdmin()
}

function initializeAdmin() {
  let settings = null
  let runtimeFormInitialized = false
  let runtimeConnectionBinding
  let runtimeServiceAppId
  let runtimeSecretAppId
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
    invalid_request: message("error-request-invalid"),
    invalid_input: message("error-input-invalid"),
    invalid_content_type: message("error-request-invalid"),
    invalid_response: message("error-response-invalid"),
    settings_unavailable: message("error-settings-unavailable"),
    invalid_provider_url: message("error-provider-url-invalid"),
    provider_address_not_public: message("error-provider-address-private"),
    provider_origin_changed: message("error-provider-origin-changed"),
    api_key_required_for_new_endpoint: message("error-provider-endpoint-key-required"),
    provider_api_key_required: message("error-provider-credential-required"),
    provider_credential_required: message("error-provider-credential-required"),
    provider_reconnect_required: message("error-provider-reconnect-required"),
    provider_auth_required: message("error-provider-reconnect-required"),
    provider_credential_changed: message("error-provider-credential-changed"),
    model_not_available: message("error-model-unavailable"),
    model_limits_exceeded: message("error-model-limits"),
    provider_setup_invalid_response: message("error-provider-response-required"),
    setup_expired: message("error-setup-expired"),
    setup_cancelled: message("error-setup-cancelled"),
    setup_failed: message("error-setup-failed"),
    setup_limit: message("error-setup-capacity"),
    unsupported_auth_method: message("error-auth-method-unsupported"),
    unsupported_method: message("error-auth-method-unsupported"),
    owner_inactive: message("error-session-inactive"),
    consent_required: message("error-copilot-consent-required"),
    capacity: message("error-setup-capacity"),
    stale_prompt: message("error-prompt-stale"),
    unsafe_authorization_url: message("error-authorization-url-unsafe"),
    unsupported_prompt: message("error-prompt-unsupported"),
    access_denied: message("error-provider-access-denied"),
    login_expired: message("error-provider-login-expired"),
    login_failed: message("error-provider-login-failed"),
    invalid_prompt: message("error-prompt-stale"),
    policy_confirmation_required: message("error-copilot-consent-required"),
    model_already_exists: message("error-model-duplicate"),
    provider_limit: message("error-provider-limit"),
    model_limit: message("error-model-limit"),
    file_read_failed: message("error-file-read"),
    invalid_private_key: message("error-private-key-invalid"),
    github_connect_not_configured: message("error-github-not-configured"),
    github_connect_expired: message("error-github-expired"),
    github_connect_failed: message("error-github-failed"),
    github_connect_access_denied: message("error-github-access-denied"),
    github_connect_stale: message("error-github-stale"),
    github_connect_limit: message("error-github-capacity"),
    unsafe_github_url: message("error-github-url-unsafe"),
    payload_too_large: message("error-payload-too-large"),
    not_found: message("error-item-not-found"),
    provider_not_found: message("error-provider-not-found"),
    model_not_found: message("error-model-not-found"),

    csrf_failed: message("error-csrf-expired"),
    forbidden: message("error-action-forbidden"),
    network_error: message("error-network"),
  }

  function node(tag, className, text) {
    const element = document.createElement(tag)
    if (className) element.className = className
    if (text !== undefined) setText(element, text)
    return element
  }

  function button(text, className, onClick, context) {
    const element = node("button", className, text)
    element.type = "button"
    if (context)
      setAttribute(
        element,
        "aria-label",
        message("contextual-action-label", { action: message(text), context }),
      )
    element.addEventListener("click", onClick)
    return element
  }

  function status(target, message = "", kind = "") {
    setText(target, message)
    target.classList.remove("error", "pending")
    if (kind) target.classList.add(kind)
  }

  function errorMessage(error) {
    return (
      errorMessages[error.code] ||
      errorMessages[String(error.code).replace(/^provider_(?:setup|auth)_/, "")] ||
      message("error-action-failed")
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
    status($("page-status"), message("settings-loading"), "pending")
    try {
      await refreshSettings()
      status($("page-status"))
    } catch (error) {
      if (error.code !== "unauthorized") {
        status($("page-status"), message("error-settings-load"), "error")
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
    status(target, message("changes-saving"), "pending")
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
        const failureMessage =
          saved && error.code !== "unsafe_github_url"
            ? message("error-settings-refresh-after-save")
            : errorMessage(error)
        if (saved && dialog?.open) dialog.close("saved")
        status(saved && dialog ? $("page-status") : target, failureMessage, "error")
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
              setValidity(control, message("validation-value-invalid"))
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
    if (runtimeSecretAppId !== undefined && runtimeSecretAppId !== appId) {
      $("runtime-webhook-secret").value = ""
      resetValidation($("runtime-webhook-secret").closest(".field"))
    }
    runtimeSecretAppId = appId
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
    setText(
      $("runtime-secret-label"),
      configured
        ? message("webhook-secret-replacement-label")
        : message("webhook-secret-first-save-label"),
    )
    setText(
      $("runtime-secret-hint"),
      configured
        ? message("webhook-secret-replacement-hint")
        : message("webhook-secret-first-save-hint"),
    )
  }

  function renderSettings() {
    if (!runtimeFormInitialized) {
      populateRuntimeSettings(settings.runtimeSettings)
      runtimeFormInitialized = true
    }
    syncRuntimeConnection()
    renderRuntimeSecretStatus()
    const providers = settings.providers
    const models = providers.flatMap((provider) =>
      provider.models.map((model) => ({ ...model, provider })),
    )
    setText($("user-name"), raw(settings.user.name))
    setText($("user-avatar"), raw((Array.from(settings.user.name.trim())[0] || "R").toUpperCase()))
    setText($("provider-count"), String(providers.length))
    setText($("model-count"), String(models.length))
    $("provider-empty").hidden = providers.length > 0
    $("models-empty").hidden = models.length > 0
    $("provider-list").replaceChildren(...providers.map(renderProvider))
    $("model-list").replaceChildren(...models.map(renderModel))
    const selected = models.find((model) => model.id === settings.selectedModelId)
    const runtime = settings.runtime
    const states = {
      starting: message("runtime-state-starting"),
      running: message("runtime-state-running"),
      not_configured: message("runtime-state-incomplete"),
      failed: message("runtime-state-failed"),
    }
    const reasons = {
      configure_model: message("runtime-reason-model-required"),
      upload_private_key: message("runtime-reason-github-setup"),
      configure_runtime: message("runtime-reason-settings-required"),
      configure_environment: message("runtime-reason-environment"),
      cleanup_requires_operator_check: message("runtime-reason-cleanup"),
      settings_unavailable: message("runtime-reason-settings-unavailable"),
      authentication_or_sandbox_unavailable: message("runtime-reason-authentication-sandbox"),
    }
    const runtimeText = states[runtime.state] || message("runtime-configuration-title")
    setText(
      $("runtime-status"),
      message("runtime-status-summary", {
        state: message(runtimeText),
        reason: reasons[runtime.reason]
          ? message(reasons[runtime.reason])
          : selected
            ? message("runtime-selected-model", { name: selected.name })
            : message("runtime-no-model"),
      }),
    )
    $("runtime-settings-link").hidden = runtime.reason !== "configure_runtime"
    setText(
      $("github-badge"),
      settings.github.configured ? message("key-configured") : message("credential-not-configured"),
    )
    $("github-badge").classList.toggle("good", settings.github.configured)
    setText(
      $("github-fingerprint"),
      settings.github.configured
        ? settings.github.fingerprint
          ? raw(settings.github.fingerprint)
          : message("key-fingerprint-unavailable")
        : message("key-not-uploaded"),
    )
    const uploaded = settings.github.uploadedAt
    setText(
      $("github-uploaded"),
      uploaded && Number.isFinite(new Date(uploaded).getTime()) ? date(uploaded) : "—",
    )
    setText(
      $("key-form-title"),
      settings.github.configured
        ? message("private-key-replace-button")
        : message("private-key-upload-button"),
    )
    setText(
      $("upload-key"),
      settings.github.configured
        ? message("private-key-replace-button")
        : message("private-key-upload-button"),
    )
    renderGithubSettings()
    updateControls()
  }

  function positiveId(value) {
    return Number.isSafeInteger(value) && value > 0
  }

  function syncRuntimeConnection() {
    const names = [
      "appId",
      "repository.owner",
      "repository.name",
      "repository.id",
      "repository.installationId",
    ]
    const binding = (values) =>
      values.every((value) => value !== "") ? JSON.stringify(values) : null
    const connection = settings.githubConnection
    const values = connection
      ? names.map((name) =>
          String(name === "appId" ? connection.appId : connection.repository[name.slice(11)]),
        )
      : null
    const nextBinding = values ? binding(values) : null
    const formBinding = binding(names.map((name) => $(runtimeFields[name]).value))
    const previousBinding = runtimeConnectionBinding || formBinding
    const serviceAppId = positiveId(settings.githubApp?.appId) ? settings.githubApp.appId : null
    const appChanged = runtimeServiceAppId !== undefined && runtimeServiceAppId !== serviceAppId
    const disconnected = Boolean(runtimeConnectionBinding && !connection)
    const appId = connection?.appId ?? serviceAppId
    const initialAppMismatch =
      runtimeServiceAppId === undefined &&
      previousBinding &&
      positiveId(appId) &&
      Number($("runtime-app-id").value) !== appId
    const targetChanged =
      (connection && previousBinding && previousBinding !== nextBinding) ||
      disconnected ||
      (appChanged && (runtimeServiceAppId !== null || previousBinding)) ||
      initialAppMismatch
    if (targetChanged) {
      $("runtime-image").value = ""
      $("runtime-forbidden-paths").value = ""
      $("runtime-repository-review").hidden = false
      setText($("runtime-repository-review"), message("runtime-identity-changed-warning"))
    }
    if (appChanged) {
      githubAppFormInitialized = false
      $("github-app-id").value = serviceAppId === null ? "" : String(serviceAppId)
      $("github-client-secret").value = ""
      $("github-webhook-secret").value = ""
      resetValidation($("github-app-form"))
    }
    for (const [index, name] of names.entries()) {
      const control = $(runtimeFields[name])
      control.readOnly = Boolean(connection)
      if (values) control.value = values[index]
    }
    if (!connection && (runtimeServiceAppId === undefined || appChanged || disconnected)) {
      if (positiveId(appId)) $("runtime-app-id").value = String(appId)
      else if (appChanged) $("runtime-app-id").value = ""
    }
    setText(
      $("runtime-connection-status"),
      connection
        ? message("runtime-connected-repository-description", {
            repository: `${connection.repository.owner}/${connection.repository.name}`,
          })
        : message("runtime-no-repository-description"),
    )
    runtimeConnectionBinding = nextBinding
    runtimeServiceAppId = serviceAppId
  }

  function updateGithubSecretRequirements() {
    const app = settings?.githubApp
    // A legacy webhook can exist before the first service App save.
    const sameApp = !positiveId(app?.appId) || Number($("github-app-id").value) === app.appId
    for (const [id, configured, label] of [
      ["github-client-secret", app?.clientSecretConfigured, message("client-secret-label")],
      ["github-webhook-secret", app?.webhookSecretConfigured, message("webhook-secret-label")],
    ]) {
      const required = !sameApp || !configured
      $(id).required = required
      setText(
        $(`${id}-label`),
        message(required ? message("field-required-label") : message("field-replacement-label"), {
          label: message(label),
        }),
      )
    }
  }

  function missingGithubSetupFields() {
    const app = settings?.githubApp
    if (!app) return []
    return [
      [message("github-app-id-label"), "github-app-id", positiveId(app.appId)],
      [message("github-private-key-label"), "private-key", app.privateKeyConfigured],
      [message("oauth-client-secret-label"), "github-client-secret", app.clientSecretConfigured],
      [message("webhook-secret-label"), "github-webhook-secret", app.webhookSecretConfigured],
    ].filter(([, , configured]) => !configured)
  }

  function renderGithubSettings() {
    const app = settings.githubApp
    const connection = settings.githubConnection
    $("github-service-notice").hidden = app?.configured === true
    setText(
      $("github-connection-badge"),
      connection ? message("github-repository-connected") : message("github-not-connected"),
    )
    $("github-connection-badge").classList.toggle("good", Boolean(connection))
    $("github-connection-metadata").hidden = !connection
    if (connection) {
      const repository = connection.repository
      setText(
        $("github-current-repository"),
        message("github-repository-metadata", {
          repository: `${repository.owner}/${repository.name}`,
          repositoryId: repository.id,
          installationId: repository.installationId,
          appId: connection.appId,
        }),
      )
      setText(
        $("github-current-user"),
        message("github-user-metadata", { login: connection.user.login, id: connection.user.id }),
      )
      const connectedAt = new Date(connection.connectedAt)
      setText(
        $("github-connected-at"),
        Number.isFinite(connectedAt.getTime()) ? date(connectedAt) : message("date-unavailable"),
      )
    }
    setText(
      $("github-connect"),
      connection ? message("github-change-repository-button") : message("github-connect-button"),
    )
    if (app?.configured !== true) {
      $("github-connect").setAttribute("aria-controls", "github-service-setup")
      $("github-connect").setAttribute("aria-expanded", String($("github-service-setup").open))
    } else {
      $("github-connect").removeAttribute("aria-controls")
      $("github-connect").removeAttribute("aria-expanded")
    }
    setText(
      $("github-callback-url"),
      app?.callbackUrl ? raw(app.callbackUrl) : message("service-version-unavailable"),
    )
    setText(
      $("github-setup-url"),
      app?.setupUrl ? raw(app.setupUrl) : message("service-version-unavailable"),
    )
    setText(
      $("github-service-status"),
      app
        ? message("github-service-credential-status", {
            client: message(
              app.clientSecretConfigured
                ? message("credential-configured")
                : message("credential-unconfigured"),
            ),
            webhook: message(
              app.webhookSecretConfigured
                ? message("credential-configured")
                : message("credential-unconfigured"),
            ),
            key: message(
              app.privateKeyConfigured
                ? message("credential-configured")
                : message("credential-unconfigured"),
            ),
          })
        : message("github-service-status-unavailable"),
    )
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
      option(message("repository-choose-option"), ""),
      ...repositories.map((repository) => option(raw(repository.fullName), String(repository.id))),
    )
    select.value = previous
    if (select.selectedIndex < 0) select.value = ""
    $("github-repository-form").hidden = !canSelect
    $("github-install").hidden = !authorized
    $("github-install-help").hidden = !authorized
    $("github-cancel").hidden = state === "idle"
    const user = githubView?.user?.login
      ? message("github-authorized-user", { login: githubView.user.login })
      : ""
    const missing = missingGithubSetupFields().map(([label]) => label)
    const messages = {
      idle:
        settings.githubApp?.configured === true
          ? message("github-connect-idle-description")
          : missing.length
            ? message("github-setup-missing-description", {
                fields: list(missing.map((label) => message(label))),
              })
            : message("github-status-unavailable"),
      connecting: message("github-authorization-started"),
      select_repository: canSelect
        ? message("github-authorized-repositories-description", { user })
        : message("github-authorized-empty-description", { user }),
      install_required: message("github-install-required-description", { user }),
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
    status($("github-connect-status"), message("github-connection-checking"), "pending")
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
    if (!provider.hasCredential) return message("credential-not-configured")
    if (provider.authType !== "oauth") return message("credential-api-key-configured")
    return provider.authDetails?.oauth?.isSubscription === true
      ? message("credential-subscription-configured")
      : message("credential-account-configured")
  }

  function renderProvider(provider) {
    const item = node("li", "provider-card")
    const top = node("div", "card-top")
    const identity = node("div", "provider-identity")
    const mark = node(
      "span",
      "provider-mark",
      raw(Array.from(provider.name).slice(0, 2).join("").toUpperCase()),
    )
    mark.setAttribute("aria-hidden", "true")
    const title = node("div")
    title.append(
      node("h3", "", raw(provider.name)),
      node("p", "mono", raw(provider.sdkProviderId || provider.baseUrl)),
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
        message("provider-saved-model-count", {
          provider: provider.sdkProviderId
            ? message("provider-builtin-label")
            : apiNames[provider.api] || provider.api,
          count: provider.models.length,
        }),
      ),
    )
    const actions = node("div", "card-actions")
    actions.append(
      button(message("edit-button"), "quiet", () => openProvider(provider), provider.name),
      button(
        message("delete-button"),
        "quiet danger",
        () =>
          confirmDelete({
            path: `/api/providers/${encodeURIComponent(provider.id)}`,
            title: message("provider-delete-confirmation", { name: provider.name }),
            description: message("provider-delete-warning"),
            success: message("provider-deleted"),
          }),
        provider.name,
      ),
      button(
        message("model-save-add-button"),
        "secondary",
        () => openModel(provider),
        message("provider-for-name", { name: provider.name }),
      ),
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
    title.append(node("h3", "", raw(model.name)))
    if (selected) title.append(node("span", "badge selected", message("model-selected-label")))
    info.append(
      title,
      node("code", "", raw(model.modelId)),
      node(
        "p",
        "model-meta",
        message("model-metadata", {
          provider: model.provider.name,
          context: number(model.contextWindow),
          output:
            model.provider.sdkProviderId === "openai-codex"
              ? message("model-output-ignored")
              : message("model-output-count", { count: number(model.maxTokens) }),
        }),
      ),
    )
    const actions = node("div", "card-actions")
    actions.append(
      button(
        message("edit-button"),
        "quiet",
        () => openModel(model.provider, model),
        message("model-provider-context", { model: model.name, provider: model.provider.name }),
      ),
      button(
        message("delete-button"),
        "quiet danger",
        () =>
          confirmDelete({
            path: `/api/models/${encodeURIComponent(model.id)}`,
            title: message("model-delete-confirmation", { name: model.name }),
            description: selected
              ? message("model-selected-delete-warning")
              : message("model-delete-warning"),
            success: message("model-deleted"),
          }),
        message("model-provider-context", { model: model.name, provider: model.provider.name }),
      ),
    )
    const use = button(
      selected ? message("model-selected-label") : message("model-select-button"),
      selected ? "secondary" : "primary",
      () => {
        if (selected) return
        if (!model.provider.hasCredential) {
          status(
            $("page-status"),
            message("model-provider-credential-required", {
              name: model.provider.name,
            }),
            "error",
          )
          return
        }
        void mutate({
          path: "/api/selection",
          method: "PUT",
          data: { modelId: model.id },
          success: message("model-selected-notice", { name: model.name }),
        })
      },
      message("model-provider-context", { model: model.name, provider: model.provider.name }),
    )
    if (selected) use.setAttribute("aria-disabled", "true")
    actions.append(use)
    item.append(info, actions)
    return item
  }

  function showPage({ focus = false } = {}) {
    const pages = {
      models: [message("models-title"), message("models-page-description")],
      github: [message("github-title"), message("github-page-description")],
      runtime: [message("runtime-title"), message("runtime-page-description")],
    }
    const page = Object.hasOwn(pages, location.hash.slice(1)) ? location.hash.slice(1) : "models"
    for (const name of Object.keys(pages)) {
      $(`${name}-page`).hidden = name !== page
      $(`nav-${name}`).removeAttribute("aria-current")
    }
    $("add-provider").hidden = page !== "models"
    setText($("page-title"), pages[page][0])
    setText($("page-description"), pages[page][1])
    setText(
      document.querySelector("title"),
      message("page-document-title", { page: message(pages[page][0]) }),
    )
    $(`nav-${page}`).setAttribute("aria-current", "page")
    if (focus) $("page-title").focus()
    if (page === "github") {
      githubViewRequested = true
      if (settings && !busy) void loadGithubView()
    }
  }

  function populateApiOptions(preferred = "") {
    $("provider-api").replaceChildren(
      option(message("api-choose-option"), ""),
      ...Object.entries(apiNames).map(([id, name]) => option(raw(name), id)),
    )
    $("provider-api").value = preferred
  }

  async function loadCatalog() {
    if (catalog) return
    if (catalogRequest) return catalogRequest
    setText($("provider-catalog-status"), message("catalog-loading"))
    setText($("model-catalog-status"), message("catalog-loading"))
    catalogRequest = (async () => {
      try {
        const result = await request("/api/catalog")
        if (!Array.isArray(result.providers)) throw { code: "invalid_response" }
        catalog = result
      } catch (error) {
        if (error.code !== "unauthorized") {
          setText($("provider-catalog-status"), message("error-provider-catalog-unavailable"))
          $("retry-provider-catalog").hidden = false
          setText(
            $("model-catalog-status"),
            settings?.providers.find((provider) => provider.id === modelProviderId)?.sdkProviderId
              ? message("error-builtin-model-catalog-unavailable")
              : message("error-custom-model-catalog-unavailable"),
          )
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
      if (target.closest("dialog")?.open) setText(target, message)
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
      ...options.map((provider) => option(raw(`${provider.name} — ${provider.id}`), provider.id)),
    )
    $("provider-preset").value = previous || ""
    $("provider-preset").disabled = !options.length
    $("continue-provider").disabled = false
    updateProviderSignInLabel()
    $("retry-provider-catalog").hidden = true
    const resultMessage = options.length
      ? message("provider-search-results", {
          count: number(options.length),
        })
      : query
        ? message("provider-search-empty")
        : message("provider-method-empty")
    announceSearch($("provider-catalog-status"), resultMessage)
  }

  function updateProviderSignInLabel() {
    if (!setup) return
    const provider = catalog?.providers.find((item) => item.id === $("provider-preset").value)
    const details = provider?.authDetails?.[setup?.authType]
    setText(
      $("continue-provider"),
      provider
        ? (details?.loginLabel ? raw(details.loginLabel) : null) ||
            (setup.authType === "oauth"
              ? message("auth-account-method")
              : message("auth-api-key-method"))
        : message("continue-button"),
    )
    setText(
      $("auth-provider-description"),
      message("provider-auth-description", {
        description: message(
          setup.authType === "oauth"
            ? message("provider-account-description")
            : message("provider-api-key-description"),
        ),
        method: details?.name
          ? message("provider-auth-method-description", { name: details.name })
          : "",
      }),
    )
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
      ...modelOptions.map((model, index) =>
        option(raw(`${model.name} — ${model.id} · ${model.catalogProvider}`), String(index)),
      ),
    )
    $("model-preset").selectedIndex = -1
    $("use-model-preset").disabled = busy || !modelOptions.length
    $("model-preset").disabled = !modelOptions.length
    announceSearch(
      $("model-catalog-status"),
      modelOptions.length
        ? message("model-search-results", {
            count: number(modelOptions.length),
          })
        : settings?.providers.find((provider) => provider.id === modelProviderId)?.sdkProviderId
          ? message("model-builtin-search-empty")
          : message("model-custom-search-empty"),
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
      setText($("auth-credential-title"), raw(provider.name))
      setText(
        $("auth-credential-status"),
        message("credential-management-description", {
          status: message(credentialStatus(provider)),
          method:
            provider.authDetails?.[provider.authType]?.name ||
            message(
              provider.authType === "oauth"
                ? message("account-method-label")
                : message("api-key-method-label"),
            ),
        }),
      )
      setText(
        $("update-credential"),
        provider.hasCredential
          ? message("credential-update-button")
          : message("credential-add-button"),
      )
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
    setText(
      $("provider-key-hint"),
      provider?.hasApiKey
        ? message("provider-api-key-replacement-hint")
        : message("provider-api-key-new-hint"),
    )
  }

  const setupStages = {
    method: ["auth-method-form", message("provider-step-method"), "auth-account"],
    provider: ["auth-provider-form", message("provider-step-provider"), "provider-search"],
    policy: ["auth-policy-form", message("provider-step-policy"), "auth-policy-title"],
    credential: [
      "auth-credential-actions",
      message("credential-manage-title"),
      "update-credential",
    ],
    setup: ["auth-setup", message("provider-step-sign-in"), "auth-progress"],
    custom: ["provider-form", message("provider-step-custom"), "provider-name"],
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
    setText(
      $("provider-title"),
      stage === "custom"
        ? providerEditId
          ? message("provider-custom-edit-title")
          : message("provider-custom-add-button")
        : stage === "provider"
          ? message("provider-select-title")
          : providerEditId
            ? message("provider-edit-title")
            : message("provider-configure-title"),
    )
    for (const [key, [id]] of Object.entries(setupStages)) $(id).hidden = stage !== key
    setText(
      $("provider-step"),
      stage === "custom" && providerEditId
        ? message("provider-custom-edit-title")
        : setupStages[stage][1],
    )
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
    setText($("auth-progress"), "")
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
    setText($("auth-progress"), message("provider-sign-in-starting"))
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
    setText($("auth-progress"), message("provider-sign-in-stopped"))
    if (error.code !== "unauthorized")
      status(
        $("provider-status"),
        message("provider-sign-in-error-notice", { error: message(errorMessage(error)) }),
        "error",
      )
  }

  function safeAuthLink(url, label) {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null
      const link = node("a", "auth-link", label || message("auth-authorization-page-link"))
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
      } else output.append(node("p", "hint", message("error-authorization-link-unavailable")))
    }
    if (event.type === "device_code") {
      output.append(
        node("p", "hint", message("auth-device-code-instructions")),
        node("output", "device-code mono", raw(event.userCode)),
      )
      addLink(event.verificationUri, message("auth-verification-page-link"))
      if (event.instructions) output.append(node("p", "hint", raw(event.instructions)))
    } else if (event.type === "auth_url") {
      if (event.instructions)
        output.append(node("p", "hint", message("auth-account-authorize-instructions")))
      addLink(event.url, message("auth-authorization-page-link"))
    } else if (event.type === "info" || event.type === "progress") {
      // Reina normalizes these events. Do not use server prose as translation keys.
      output.append(
        node(
          "p",
          "hint",
          event.type === "info" ? message("auth-account-continue") : message("auth-in-progress"),
        ),
      )
      for (const link of event.links || [])
        addLink(link.url, message("auth-authorization-link-label"))
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
      setText($("auth-progress"), message("credential-saved-refreshing"))
      try {
        await refreshSettings(stillCompleting)
        if (!stillCompleting()) return
        $("provider-dialog").close("saved")
        status($("page-status"), message("credential-saved-notice"))
        focusAfterRemoval()
      } catch {
        if (!stillCompleting()) return
        $("provider-dialog").close("saved")
        status($("page-status"), message("error-credential-refresh-after-save"), "error")
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
    setText(
      $("auth-progress"),
      prompt ? message("provider-prompt-required") : message("provider-waiting"),
    )
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
          option(message("option-choose"), ""),
          ...(prompt.options || []).map((choice) =>
            option(
              raw(choice.description ? `${choice.label} — ${choice.description}` : choice.label),
              choice.id,
            ),
          ),
        )
        setText($("auth-prompt-label"), raw(prompt.message))
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
    setText(
      $("model-id-hint"),
      provider.sdkProviderId ? message("model-builtin-id-hint") : message("model-id-hint"),
    )
    setText(
      $("model-presets").querySelector(".form-divider"),
      provider.sdkProviderId
        ? message("model-catalog-review-divider")
        : message("model-custom-entry-divider"),
    )
    $("model-context").value = String(model?.contextWindow || 128000)
    $("model-output").value = String(model?.maxTokens || 4096)
    $("model-advanced").open = Boolean(model)
    setText($("model-title"), model ? message("model-edit-title") : message("model-save-button"))
    setText($("model-provider-name"), raw(provider.name))
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
    setText($("delete-title"), options.title)
    setText($("delete-description"), options.description)
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
    setText(error, () =>
      invalid ? message("validation-inline-error", { error: raw(control.validationMessage) }) : "",
    )
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
            () =>
              message("validation-announcement", {
                field: control.labels?.[0]?.textContent || message("field-label"),
                error: control.validationMessage,
              }),
            "error",
          ),
        500,
      )
    }
  }

  function resetValidation(form) {
    for (const control of form.querySelectorAll("input, select, textarea")) {
      setValidity(control, "")
      control.setAttribute("aria-invalid", "false")
      const errorId = control.dataset.error
      if (errorId) {
        setText($(errorId), "")
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
      setValidity(control, "")
      syncValidation(control)
    })
    control.addEventListener("change", () => {
      edited.add(control)
      setValidity(control, "")
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
      status($("provider-status"), message("provider-supported-required"), "error")
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
      title: message("credential-remove-confirmation", { name: provider.name }),
      description: message("credential-remove-warning"),
      success: message("credential-removed"),
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
    setText($("auth-progress"), message("provider-response-sending"))
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
      success: message("provider-saved-notice"),
    })
  })

  $("model-form").addEventListener("submit", (event) => {
    event.preventDefault()
    if (busy) return
    if (!$("model-id").value) {
      status($("model-status"), message("model-catalog-selection-required"), "error")
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
      success: message("model-saved-notice"),
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
      setValidity(control, message("validation-path-patterns"))
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
    setValidity($("runtime-commands"), message("validation-command-arrays"))
    return []
  }

  $("runtime-form").addEventListener("submit", (event) => {
    event.preventDefault()
    if (busy) return
    for (const id of ["runtime-app-id", "runtime-repository-id", "runtime-installation-id"]) {
      if (!Number.isSafeInteger(Number($(id).value)) || Number($(id).value) < 1)
        setValidity($(id), message("validation-positive-id"))
    }
    const allowedPaths = readRuntimePaths("runtime-allowed-paths")
    const forbiddenPaths = readRuntimePaths("runtime-forbidden-paths")
    const commands = readRuntimeCommands()
    const secret = $("runtime-webhook-secret")
    if (secret.value && (secret.value.trim() !== secret.value || /[\p{Cc}]/u.test(secret.value)))
      setValidity(secret, message("validation-webhook-secret"))
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
      success: message("runtime-settings-saved-notice"),
      onSaved: () => {
        // Without saved service App settings, status derives its App ID from
        // this Runtime save. That expected change must not clear the new policy.
        if (settings.githubApp && !settings.githubApp.clientSecretConfigured) {
          if (runtimeServiceAppId !== data.appId) {
            githubAppFormInitialized = true
            $("github-app-id").value = String(data.appId)
            $("github-client-secret").value = ""
            $("github-webhook-secret").value = ""
            resetValidation($("github-app-form"))
          }
          runtimeServiceAppId = data.appId
        }
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
          ? message("github-setup-incomplete-notice", {
              fields: list(missing.map(([label]) => message(label))),
            })
          : message("github-service-refresh-required"),
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
      success: message("github-authorization-opening"),
      onSaved: (result) => navigateGithub(result),
    })
  })
  $("github-install").addEventListener("click", () => {
    void mutate({
      path: "/api/github/connect/install",
      method: "POST",
      target: $("github-connect-status"),
      refresh: false,
      success: message("github-install-opening"),
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
      success: message("github-connection-cancelled"),
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
      success: message("github-repository-connected-notice"),
      onSaved: async () => {
        await refreshSettings()
        if (!settings.githubConnection) throw { code: "invalid_response" }
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
    if (!positiveId(appId)) setValidity($("github-app-id"), message("validation-positive-id"))
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
        setValidity(
          control,
          name === "clientSecret"
            ? message("validation-client-secret")
            : message("validation-secret-length", { minimum }),
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
      success: message("github-service-app-saved-notice"),
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
      setValidity($("private-key"), message("validation-pem-file"))
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
      success: message("github-private-key-saved"),
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
      title: message("github-private-key-delete-confirmation"),
      description: message("github-private-key-delete-warning"),
      success: message("github-private-key-deleted"),
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
      success: message("model-selection-cleared"),
    })
  })
  $("reload-runtime").addEventListener("click", () => {
    void mutate({
      path: "/api/runtime/reload",
      method: "POST",
      success: message("runtime-reload-requested"),
    })
  })
  $("logout-form").addEventListener("submit", (event) => {
    event.preventDefault()
    void mutate({
      path: "/auth/logout",
      method: "POST",
      success: message("session-signed-out"),
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
      setText($("model-catalog-status"), message("model-catalog-choice-required"))
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
        ? message("model-codex-catalog-selected-notice")
        : message("model-catalog-selected-notice"),
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
