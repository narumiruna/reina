import { AsyncLocalStorage } from "node:async_hooks"
import { Agent, Dispatcher, getGlobalDispatcher, setGlobalDispatcher } from "undici"
import { publicLookup } from "./network.js"

const responseLimit = 1024 * 1024
const requestLimit = 64 * 1024
const headerLimit = 16 * 1024
const scopeDuration = 15 * 60_000
const scopes = new AsyncLocalStorage<{
  providerId: string
  deadline: number
  remaining: number
  active: boolean
}>()

// SDK 1.5.0 auth/oauth sources: no auth request needs query parameters.
const routes: Readonly<Record<string, readonly string[]>> = {
  "openai-codex": [
    "POST auth.openai.com/api/accounts/deviceauth/usercode",
    "POST auth.openai.com/api/accounts/deviceauth/token",
    "POST auth.openai.com/oauth/token",
  ],
  anthropic: ["POST platform.claude.com/v1/oauth/token"],
  "github-copilot": [
    "POST github.com/login/device/code",
    "POST github.com/login/oauth/access_token",
    "GET api.github.com/copilot_internal/v2/token",
  ],
  "kimi-coding": [
    "POST auth.kimi.com/api/oauth/device_authorization",
    "POST auth.kimi.com/api/oauth/token",
  ],
  meta: [
    "POST auth.meta.com/oidc/device/authorization/",
    "POST auth.meta.com/oidc/device/token/",
    "POST api.meta.ai/muse-code/key",
  ],
  xai: ["POST auth.x.ai/oauth2/device/code", "POST auth.x.ai/oauth2/token"],
}
const denied = () => new Error("provider_auth_network_denied")

function validate(providerId: string, options: Dispatcher.DispatchOptions): string[] {
  // Fetch removes fragments before dispatch; only the received origin/path are visible here.
  const origin = new URL(String(options.origin))
  if (
    origin.protocol !== "https:" ||
    origin.port ||
    origin.username ||
    origin.password ||
    origin.href !== `${origin.origin}/` ||
    options.query ||
    options.upgrade ||
    /[?#\\\s%]/u.test(options.path)
  )
    throw denied()
  const copilot =
    providerId === "github-copilot" &&
    /^api\.(individual|business|enterprise)\.githubcopilot\.com$/.test(origin.hostname) &&
    ((options.method === "GET" && options.path === "/models") ||
      (options.method === "POST" &&
        /^\/models\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}\/policy$/.test(options.path)))
  const allowed = Object.hasOwn(routes, providerId) ? routes[providerId] : []
  if (!copilot && !allowed.includes(`${options.method} ${origin.hostname}${options.path}`))
    throw denied()
  const source = options.headers
  const headers = new Headers(
    Array.isArray(source) && typeof source[0] === "string"
      ? (Array.from({ length: source.length / 2 }, (_, i) => [
          source[i * 2],
          source[i * 2 + 1],
        ]) as [string, string][])
      : (source as HeadersInit),
  )
  if (headers.has("host")) throw denied()
  if (Number(headers.get("content-length") ?? 0) > requestLimit) throw denied()
  // Reject compressed responses too: the dispatcher sees bytes before fetch decompression.
  headers.set("accept-encoding", "identity")
  const flat = [...headers].flat()
  if (flat.reduce((size, value) => size + Buffer.byteLength(value) + 4, 0) > headerLimit)
    throw denied()
  return flat
}

function boundedBody(body: Dispatcher.DispatchOptions["body"]): Dispatcher.DispatchOptions["body"] {
  if (body == null) return body
  if (typeof body === "string" || body instanceof Uint8Array) {
    if (Buffer.byteLength(body) > requestLimit) throw denied()
    return body
  }
  // Native fetch supplies an async iterable, including for string/form bodies.
  return (async function* () {
    let size = 0
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      size += Buffer.byteLength(chunk)
      if (size > requestLimit) throw denied()
      yield chunk
    }
  })() as unknown as Dispatcher.DispatchOptions["body"]
}

function dispatchBounded(
  safe: Dispatcher,
  options: Dispatcher.DispatchOptions,
  handler: Dispatcher.DispatchHandler,
  timeout: number,
): boolean {
  let transport: Dispatcher.DispatchController | undefined
  let finished = false
  let failure: Error | null = null
  let received = 0
  const control: Dispatcher.DispatchController = {
    get aborted() {
      return failure !== null
    },
    get paused() {
      return transport?.paused ?? false
    },
    get reason() {
      return failure
    },
    abort: fail,
    pause: () => transport?.pause(),
    resume: () => transport?.resume(),
  }
  const timer = setTimeout(() => fail(new Error("provider_auth_network_timeout")), timeout)
  timer.unref()
  function fail(error: Error) {
    if (finished) return
    finished = true
    failure = error
    clearTimeout(timer)
    transport?.abort(error)
    handler.onResponseError?.(control, error)
  }
  try {
    return safe.dispatch(options, {
      onRequestStart(controller, context) {
        transport = controller
        if (failure) return controller.abort(failure)
        handler.onRequestStart?.(control, context)
      },
      onResponseStart(controller, status, headers, message) {
        if (finished) return
        if (
          (status >= 300 && status < 400) ||
          (headers["content-encoding"] && headers["content-encoding"] !== "identity") ||
          Number(headers["content-length"] ?? 0) > responseLimit ||
          Buffer.byteLength(JSON.stringify(headers)) > headerLimit
        )
          return fail(denied())
        handler.onResponseStart?.(controller, status, headers, message)
      },
      onResponseData(controller, chunk) {
        if (finished) return
        received += chunk.byteLength
        if (received > responseLimit) return fail(denied())
        handler.onResponseData?.(controller, chunk)
      },
      onResponseEnd(controller, trailers) {
        if (finished) return
        finished = true
        clearTimeout(timer)
        handler.onResponseEnd?.(controller, trailers)
      },
      onResponseError(_controller, error) {
        fail(error)
      },
    })
  } catch (error) {
    clearTimeout(timer)
    throw error
  }
}

let installed: Dispatcher | undefined

/** Install once. The optional transport is a test dependency, not a policy override.
 * close/destroy affect only the auth transport; the original fallback remains owned by its caller.
 */
export function installProviderAuthDispatcher(safeDispatcher?: Dispatcher): Dispatcher {
  if (installed) return installed
  const fallback = getGlobalDispatcher()
  const safe =
    safeDispatcher ??
    new Agent({
      connect: { lookup: publicLookup, timeout: 10_000 },
      allowH2: false,
      maxResponseSize: responseLimit,
      maxHeaderSize: headerLimit,
      headersTimeout: 15_000,
      bodyTimeout: 15_000,
    })
  const wrapper = new Dispatcher()
  wrapper.dispatch = (options, handler) => {
    const scope = scopes.getStore()
    if (!scope) return fallback.dispatch(options, handler)
    if (!scope.active || Date.now() >= scope.deadline || scope.remaining-- <= 0) throw denied()
    const bounded = {
      ...options,
      headers: validate(scope.providerId, options),
      body: boundedBody(options.body),
      headersTimeout: 15_000,
      bodyTimeout: 15_000,
    }
    return dispatchBounded(safe, bounded, handler, Math.min(30_000, scope.deadline - Date.now()))
  }
  wrapper.close = safe.close.bind(safe)
  wrapper.destroy = safe.destroy.bind(safe)
  setGlobalDispatcher(wrapper)
  installed = wrapper
  return wrapper
}

export async function closeProviderAuthDispatcher(): Promise<void> {
  await installed?.close()
}

/** Scope SDK auth work. API-key-only providers get prompts, but no outbound auth routes. */
export async function withProviderAuth<T>(
  providerId: string,
  action: () => Promise<T>,
): Promise<T> {
  installProviderAuthDispatcher()
  const scope = { providerId, deadline: Date.now() + scopeDuration, remaining: 2048, active: true }
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("provider_auth_network_timeout")), scopeDuration)
    timer.unref()
  })
  try {
    return await Promise.race([scopes.run(scope, action), expiry])
  } finally {
    scope.active = false
    clearTimeout(timer)
  }
}
