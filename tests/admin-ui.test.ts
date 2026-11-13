import { readFileSync } from "node:fs"
import { setImmediate } from "node:timers/promises"
import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"

const script = readFileSync(new URL("../public/app.js", import.meta.url), "utf8")
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8")

// Only the DOM operations used by app.js are implemented. No app functions are replaced.
class Element {
  id = ""
  name = ""
  value = ""
  textContent = ""
  dataset: Record<string, string> = {}
  attributes = new Map<string, string>()
  children: Element[] = []
  parent: Element | null = null
  hidden = false
  disabled = false
  readOnly = false
  required = false
  open = false
  type = ""
  validationMessage = ""
  listeners = new Map<string, Array<(event: EventFixture) => void>>()
  classes = new Set<string>()
  classList = {
    add: (name: string) => this.classes.add(name),
    remove: (...names: string[]) =>
      names.forEach((name) => {
        this.classes.delete(name)
      }),
    toggle: (name: string, enabled: boolean) =>
      enabled ? this.classes.add(name) : this.classes.delete(name),
  }

  constructor(public tag: string) {}

  get isConnected(): boolean {
    return this.tag === "document" || Boolean(this.parent?.isConnected)
  }
  get selectedIndex() {
    return this.children.findIndex((child) => child.value === this.value)
  }
  get elements() {
    return {
      namedItem: (name: string) =>
        this.querySelectorAll("input, select, textarea").find((child) => child.name === name),
    }
  }
  get validity() {
    return { valid: !this.validationMessage }
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null
  }
  removeAttribute(name: string) {
    this.attributes.delete(name)
  }
  addEventListener(name: string, listener: (event: EventFixture) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) || []), listener])
  }
  fire(name: string) {
    for (const listener of this.listeners.get(name) || [])
      listener({ currentTarget: this, preventDefault() {} })
  }
  append(...children: Element[]) {
    for (const child of children) {
      child.parent = this
      this.children.push(child)
    }
  }
  replaceChildren(...children: Element[]) {
    for (const child of this.children) child.parent = null
    this.children = []
    this.append(...children)
  }
  after(child: Element) {
    if (!this.parent) throw new Error("Missing parent")
    child.parent = this.parent
    this.parent.children.splice(this.parent.children.indexOf(this) + 1, 0, child)
  }
  matches(selector: string): boolean {
    return selector.split(",").some((part) => {
      const tokens = part.trim().split(/\s+/)
      const last = tokens.pop() || ""
      const match =
        last === this.tag ||
        (last === "dialog[open]" && this.tag === "dialog" && this.open) ||
        (last.startsWith(".") && this.classes.has(last.slice(1))) ||
        (last === "[data-close]" && Boolean(this.dataset.close))
      return match && (!tokens.length || Boolean(this.parent?.closest(tokens.join(" "))))
    })
  }
  closest(selector: string): Element | null {
    return this.matches(selector) ? this : this.parent?.closest(selector) || null
  }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ])
  }
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] || null
  }
  setCustomValidity(message: string) {
    this.validationMessage = message
  }
  reportValidity(): boolean {
    const controls = this.tag === "form" ? this.querySelectorAll("input, select, textarea") : [this]
    let valid = true
    for (const control of controls) {
      if (control.disabled || control.readOnly) continue
      const pattern = control.getAttribute("pattern")
      const nativeInvalid =
        (control.required && !control.value) ||
        (control.value && pattern && !new RegExp(`^(?:${pattern})$`, "u").test(control.value))
      if (nativeInvalid || control.validationMessage) {
        if (!control.validationMessage)
          control.validationMessage = "Fill in this field with a valid value."
        control.fire("invalid")
        valid = false
      }
    }
    return valid
  }
  focus() {}
}

type EventFixture = { currentTarget: Element; preventDefault(): void }

function documentFixture() {
  const root = new Element("document")
  const stack = [root]
  // Parse the real markup so hidden state, names, defaults, and help text stay coupled to HTML.
  for (const match of html.matchAll(
    /<!--[\s\S]*?-->|<![^>]*>|<\/([\w-]+)\s*>|<([\w-]+)([^>]*)>|([^<]+)/g,
  )) {
    if (match[1]) {
      if (stack.at(-1)?.tag === match[1]) stack.pop()
    } else if (match[2]) {
      const element = new Element(match[2])
      for (const attr of match[3].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
        const [name, value] = [attr[1], attr[2] || ""]
        element.setAttribute(name, value)
        if (["id", "name", "value", "type"].includes(name))
          Object.assign(element, { [name]: value })
        if (["hidden", "disabled", "required"].includes(name))
          Object.assign(element, { [name]: true })
        if (name === "class") for (const item of value.split(" ")) element.classes.add(item)
        if (name.startsWith("data-")) element.dataset[name.slice(5)] = value
      }
      stack.at(-1)?.append(element)
      if (!["meta", "link", "input", "br"].includes(element.tag)) stack.push(element)
    } else if (match[4]) {
      const parent = stack.at(-1)
      if (parent) {
        parent.textContent += match[4]
        if (parent.tag === "textarea" || parent.tag === "option") parent.value += match[4]
      }
    }
  }
  const getElementById = (id: string): Element => {
    const search = (element: Element): Element | undefined =>
      element.id === id ? element : element.children.map(search).find(Boolean)
    const element = search(root)
    if (!element) throw new Error(`Missing element: ${id}`)
    return element
  }
  return {
    body: root.querySelector("body"),
    activeElement: root.querySelector("body"),
    getElementById,
    createElement: (tag: string) => new Element(tag),
    querySelector: (selector: string) => root.querySelector(selector),
    querySelectorAll: (selector: string) => root.querySelectorAll(selector),
  }
}

const repositoryA = { owner: "example", name: "alpha", id: 456, installationId: 789 }
const repositoryB = { owner: "other", name: "beta", id: 457, installationId: 790 }
const connection = (repository = repositoryA, appId = 123) => ({
  appId,
  repository,
  user: { login: "operator", id: 42 },
  connectedAt: "2026-01-01T00:00:00Z",
})
const savedRuntime = () => ({
  appId: 123,
  repository: { ...repositoryA },
  image: `sha256:${"d".repeat(64)}`,
  allowedPaths: ["src/**"],
  forbiddenPaths: ["src/auth/**"],
  commands: [["npm", "test"]],
  scanIntervalMs: 900000,
  maxIssuesPerScan: 10,
  agentTimeoutMs: 600000,
  maxChangedFiles: 10,
  maxPatchBytes: 65536,
  webhookSecretConfigured: true,
})
const initialSettings = () => ({
  csrfToken: "fixture-csrf",
  providers: [],
  selectedModelId: null,
  user: { name: "Operator" },
  github: { configured: false },
  githubApp: {
    appId: 123,
    configured: true,
    clientSecretConfigured: true,
    webhookSecretConfigured: true,
  },
  githubConnection: connection() as ReturnType<typeof connection> | null,
  runtimeSettings: savedRuntime() as ReturnType<typeof savedRuntime> | null,
  runtime: { state: "not_configured", reason: "configure_runtime" },
})

async function settle() {
  for (let index = 0; index < 8; index++) await setImmediate()
}

async function ui(initial = initialSettings()) {
  const document = documentFixture()
  const $ = document.getElementById
  const state = {
    settings: initial,
    failRefresh: false,
    rejectRuntimeSave: false,
    selected: repositoryB,
    requests: [] as Array<{ path: string; data: Record<string, unknown> | undefined }>,
  }
  const location = { href: "https://reina.example/#runtime", hash: "#runtime" }
  runInNewContext(
    script,
    {
      document,
      location,
      URL,
      URLSearchParams,
      history: { replaceState() {} },
      window: { addEventListener() {} },
      HTMLInputElement: Element,
      HTMLSelectElement: Element,
      HTMLTextAreaElement: Element,
      Option: class extends Element {
        constructor(text: string, value: string) {
          super("option")
          this.textContent = text
          this.value = value
        }
      },
      setTimeout: () => 1,
      clearTimeout() {},
      fetch: async (path: string, options: { method: string; body?: string }) => {
        const data = options.body ? JSON.parse(options.body) : undefined
        state.requests.push({ path, data })
        let result: unknown = {}
        let ok = true
        if (path === "/api/settings") {
          if (state.failRefresh) throw new Error("Offline fixture")
          result = structuredClone(state.settings)
        } else if (path === "/api/github/connect") {
          result = {
            state: "select_repository",
            repositories: [repositoryA, repositoryB].map((repo) => ({
              ...repo,
              fullName: `${repo.owner}/${repo.name}`,
            })),
          }
        } else if (path === "/api/github/connect/select") {
          state.settings.githubConnection = connection(state.selected)
        } else if (path === "/api/runtime/settings") {
          if (state.rejectRuntimeSave) {
            ok = false
            result = { error: "invalid_input", fields: ["image"] }
          } else {
            state.settings.runtimeSettings = { ...data, webhookSecretConfigured: true }
            if (!state.settings.githubApp.clientSecretConfigured)
              state.settings.githubApp.appId = Number(data?.appId)
          }
        } else throw new Error(`Unexpected request: ${path}`)
        return { ok, status: ok ? 200 : 400, json: async () => result }
      },
    },
    { filename: "public/app.js" },
  )
  await settle()
  return {
    $,
    state,
    async refresh() {
      $("refresh-settings").fire("click")
      await settle()
    },
    async openGithub() {
      $("github-page").hidden = false
      $("refresh-settings").fire("click")
      await settle()
    },
    async useRepository(repository = repositoryB) {
      state.selected = repository
      $("github-repository-select").value = String(repository.id)
      $("github-repository-form").fire("submit")
      await settle()
    },
    async save() {
      $("runtime-form").fire("submit")
      await settle()
    },
  }
}

function policyDraft($: (id: string) => Element) {
  $("runtime-image").value = `sha256:${"a".repeat(64)}`
  $("runtime-forbidden-paths").value = "draft/private/**"
  $("runtime-allowed-paths").value = "draft/**"
  $("runtime-commands").value = '[["fixture","verify"]]'
  $("runtime-max-files").value = "3"
}

function expectReview($: (id: string) => Element) {
  expect($("runtime-image").value).toBe("")
  expect($("runtime-forbidden-paths").value).toBe("")
  expect($("runtime-allowed-paths").value).toBe("draft/**")
  expect($("runtime-commands").value).toBe('[["fixture","verify"]]')
  expect($("runtime-max-files").value).toBe("3")
  expect($("runtime-repository-review").hidden).toBe(false)
  expect($("reload-runtime").disabled).toBe(true)
}

describe("admin Runtime identity reconciliation", () => {
  it("preserves same-target drafts and custom validation errors on every refresh", async () => {
    const { $, refresh } = await ui()
    policyDraft($)
    $("runtime-commands").value = "not JSON"
    $("runtime-commands").setCustomValidity("Review commands")
    $("runtime-commands").fire("invalid")
    await refresh()
    await refresh()
    expect($("runtime-image").value).toBe(`sha256:${"a".repeat(64)}`)
    expect($("runtime-commands").value).toBe("not JSON")
    expect($("runtime-commands").validationMessage).toBe("Review commands")
    expect($("runtime-commands").getAttribute("aria-invalid")).toBe("true")
    expect($("runtime-commands-error").textContent).toBe("Error: Review commands")
    expect($("runtime-repository-review").hidden).toBe(true)
  })

  it.each([
    repositoryB,
    { ...repositoryA, owner: "renamed-owner" },
    { ...repositoryA, name: "renamed-repository" },
    { ...repositoryA, installationId: 999 },
  ])("reconciles the full external repository binding: %j", async (repository) => {
    const { $, state, refresh } = await ui()
    policyDraft($)
    state.settings.githubConnection = connection(repository)
    await refresh()
    expect($("runtime-repository-owner").value).toBe(repository.owner)
    expect($("runtime-repository-name").value).toBe(repository.name)
    expect($("runtime-installation-id").value).toBe(String(repository.installationId))
    expect($("runtime-repository-id").readOnly).toBe(true)
    expectReview($)
    await refresh()
    expectReview($)
  })

  it("clears a first-save draft on B even without stored Runtime settings", async () => {
    const initial = initialSettings()
    initial.runtimeSettings = null
    const { $, state, refresh } = await ui(initial)
    policyDraft($)
    state.settings.githubConnection = connection(repositoryB)
    await refresh()
    expectReview($)
  })

  it.each([true, false])(
    "does not clear a new-target draft on initial render (connection=%s)",
    async (connected) => {
      const initial = initialSettings()
      initial.runtimeSettings = null
      if (!connected) initial.githubConnection = null
      const { $, refresh } = await ui(initial)
      expect($("runtime-repository-review").hidden).toBe(true)
      policyDraft($)
      await refresh()
      expect($("runtime-image").value).toBe(`sha256:${"a".repeat(64)}`)
      expect($("runtime-repository-review").hidden).toBe(true)
    },
  )

  it.each([false, true])(
    "keeps review after selection and settings retry (failed refresh=%s)",
    async (failRefresh) => {
      const initial = initialSettings()
      initial.runtimeSettings = null
      const { $, state, openGithub, useRepository, refresh } = await ui(initial)
      await openGithub()
      policyDraft($)
      state.failRefresh = failRefresh
      await useRepository()
      if (failRefresh) {
        expect($("retry-settings").hidden).toBe(false)
        state.failRefresh = false
        $("retry-settings").fire("click")
        await settle()
      }
      expectReview($)
      await refresh()
      expectReview($)
    },
  )

  it("preserves drafts and errors when selecting the same complete target", async () => {
    const { $, openGithub, useRepository } = await ui()
    await openGithub()
    policyDraft($)
    $("runtime-image").setCustomValidity("Review image")
    $("runtime-image").fire("invalid")
    await useRepository(repositoryA)
    expect($("runtime-image").value).toBe(`sha256:${"a".repeat(64)}`)
    expect($("runtime-image").validationMessage).toBe("Review image")
    expect($("runtime-repository-review").hidden).toBe(true)
  })

  it("releases disconnected identity and supports the advanced manual workflow", async () => {
    const { $, state, refresh, save } = await ui()
    policyDraft($)
    state.settings.githubConnection = null
    await refresh()
    expectReview($)
    for (const id of [
      "runtime-app-id",
      "runtime-repository-owner",
      "runtime-repository-name",
      "runtime-repository-id",
      "runtime-installation-id",
    ])
      expect($(id).readOnly).toBe(false)
    expect($("runtime-connection-status").textContent).not.toContain("Connected repository:")
    $("runtime-app-id").value = "999"
    $("runtime-app-id").fire("input")
    expect($("runtime-webhook-secret").required).toBe(true)
    expect($("runtime-webhook-secret").closest(".field")?.hidden).toBe(false)
    $("runtime-webhook-secret").value = "manual-fixture-secret-32-characters-long"
    policyDraft($)
    await refresh()
    expect($("runtime-app-id").value).toBe("999")
    expect($("runtime-webhook-secret").value).toBe("manual-fixture-secret-32-characters-long")
    await save()
    expect(
      state.requests.find((request) => request.path === "/api/runtime/settings")?.data?.appId,
    ).toBe(999)
    expect($("runtime-repository-review").hidden).toBe(true)
  })

  it("submits the refreshed connection identity, not the old target", async () => {
    const { $, state, refresh, save } = await ui()
    policyDraft($)
    state.settings.githubConnection = connection(repositoryB)
    await refresh()
    expectReview($)
    policyDraft($)
    await save()
    const request = state.requests.find((entry) => entry.path === "/api/runtime/settings")
    expect(request?.data?.repository).toEqual(repositoryB)
    expect(request?.data?.appId).toBe(123)
    expect($("runtime-repository-review").hidden).toBe(true)
  })

  it.each([false, true])(
    "keeps an applied manual policy when legacy App metadata follows its new App ID (failed refresh=%s)",
    async (failRefresh) => {
      const initial = initialSettings()
      initial.githubConnection = null
      initial.githubApp.configured = false
      initial.githubApp.clientSecretConfigured = false
      const { $, state, save, refresh } = await ui(initial)
      state.failRefresh = failRefresh
      policyDraft($)
      $("runtime-app-id").value = "999"
      $("runtime-app-id").fire("input")
      $("runtime-webhook-secret").value = "manual-fixture-secret-32-characters-long"
      await save()
      expect(state.settings.githubApp.appId).toBe(999)
      expect($("runtime-app-id").value).toBe("999")
      expect($("github-app-id").value).toBe("999")
      expect($("runtime-image").value).toBe(`sha256:${"a".repeat(64)}`)
      expect($("runtime-forbidden-paths").value).toBe("draft/private/**")
      expect($("runtime-repository-review").hidden).toBe(true)
      if (failRefresh) {
        expect($("retry-settings").hidden).toBe(false)
        $("runtime-commands").value = '[["new-draft","verify"]]'
        $("github-app-id").value = "888"
        $("github-client-secret").value = "new-app-secret-draft"
        state.failRefresh = false
        $("retry-settings").fire("click")
        await settle()
        expect($("runtime-commands").value).toBe('[["new-draft","verify"]]')
        expect($("github-app-id").value).toBe("888")
        expect($("github-client-secret").value).toBe("new-app-secret-draft")
      }
      await refresh()
      expect($("runtime-image").value).toBe(`sha256:${"a".repeat(64)}`)
      expect($("runtime-repository-review").hidden).toBe(true)
    },
  )

  it.each([".github", ".repository", "-repository"])(
    "can reopen and save a manual repository named %s",
    async (name) => {
      const initial = initialSettings()
      initial.githubConnection = null
      initial.runtimeSettings = { ...savedRuntime(), repository: { ...repositoryA, name } }
      const { $, state, save } = await ui(initial)
      expect($("runtime-repository-name").readOnly).toBe(false)
      expect($("runtime-repository-name").value).toBe(name)
      await save()
      const request = state.requests.find((entry) => entry.path === "/api/runtime/settings")
      expect(request?.data?.repository).toEqual({ ...repositoryA, name })
      expect($("runtime-repository-review").hidden).toBe(true)
    },
  )

  it.each([".", "..", "../repository", "repository/child", "x".repeat(101)])(
    "rejects an unsafe manual repository name %s before submission",
    async (name) => {
      const initial = initialSettings()
      initial.githubConnection = null
      const { $, state, save } = await ui(initial)
      $("runtime-repository-name").value = name
      await save()
      expect(state.requests.some((entry) => entry.path === "/api/runtime/settings")).toBe(false)
      expect($("runtime-repository-name").getAttribute("aria-invalid")).toBe("true")
    },
  )

  it("reconciles App changes, clears old secret drafts, and keeps review until a successful save", async () => {
    const { $, state, refresh, save } = await ui()
    policyDraft($)
    $("runtime-webhook-secret").value = "stale-runtime-secret"
    $("github-client-secret").value = "stale-client-secret"
    $("github-webhook-secret").value = "stale-service-secret"
    state.settings.githubConnection = null
    state.settings.githubApp = {
      appId: 987,
      configured: false,
      clientSecretConfigured: false,
      webhookSecretConfigured: false,
    }
    await refresh()
    expectReview($)
    expect($("runtime-app-id").value).toBe("987")
    expect($("runtime-app-id").readOnly).toBe(false)
    expect($("github-app-id").value).toBe("987")
    for (const id of ["runtime-webhook-secret", "github-client-secret", "github-webhook-secret"])
      expect($(id).value).toBe("")
    expect($("runtime-webhook-secret").required).toBe(true)
    expect($("runtime-webhook-secret").closest(".field")?.hidden).toBe(false)
    policyDraft($)
    $("runtime-webhook-secret").value = "replacement-fixture-secret-32-characters-long"
    state.rejectRuntimeSave = true
    await save()
    expect($("runtime-repository-review").hidden).toBe(false)
    await refresh()
    expect($("runtime-image").getAttribute("aria-invalid")).toBe("true")
    expect($("runtime-repository-review").hidden).toBe(false)
    state.rejectRuntimeSave = false
    $("runtime-image").fire("input")
    $("runtime-webhook-secret").value = "replacement-fixture-secret-32-characters-long"
    await save()
    expect($("runtime-repository-review").hidden).toBe(true)
    expect($("reload-runtime").disabled).toBe(false)
  })

  it("detects an App binding change even when the repository ID is unchanged", async () => {
    const { $, state, refresh } = await ui()
    policyDraft($)
    $("runtime-webhook-secret").value = "stale-runtime-secret"
    state.settings.githubConnection = connection(repositoryA, 987)
    state.settings.githubApp.appId = 987
    await refresh()
    expect($("runtime-app-id").value).toBe("987")
    expect($("runtime-webhook-secret").value).toBe("")
    expect($("runtime-webhook-secret").required).toBe(false)
    expect($("runtime-webhook-secret").closest(".field")?.hidden).toBe(true)
    expectReview($)
  })

  it("shows the model-quota warning before Use repository and keeps it in success status", async () => {
    const { $, openGithub, useRepository } = await ui()
    await openGithub()
    expect($("github-repository-form").hidden).toBe(false)
    const warning = $("github-selection-warning")
    expect(warning.hidden).toBe(false)
    expect(warning.textContent).toContain("use model quota")
    expect(warning.textContent).toContain("saved worker image and policy")
    expect(warning.textContent).toContain("Unsaved form edits do not stop this restart")
    expect(warning.textContent).toContain("complete saved Runtime configuration")
    expect(warning.textContent).toContain("does not approve coding")
    expect($("github-use-repository").getAttribute("aria-describedby")).toBe(warning.id)
    const siblings = warning.parent?.children || []
    expect(siblings.indexOf(warning)).toBeLessThan(
      siblings.findIndex((element) => element.children.includes($("github-use-repository"))),
    )
    await useRepository(repositoryA)
    expect($("github-connect-status").textContent).toContain("restart scans and use model quota")
    expect($("runtime-connection-status").textContent).not.toContain(
      "still require review and a separate",
    )
    expect($("github-connect-status").getAttribute("role")).toBe("status")
  })
})
