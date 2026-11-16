import { tw } from "./locales/tw.js"

export const locales = { en: "en", tw: "zh-Hant" }
const storageKey = "reina.locale"

// English source messages are the default catalog and the fallback for missing translations.
export function message(key, values = {}) {
  return key && typeof key === "object" ? key : { key, values }
}

export function list(values) {
  return { list: values }
}

export function raw(value) {
  return { literal: String(value) }
}

export function number(value) {
  return { number: value }
}

export function date(value) {
  return { date: value }
}

export function translate(value, locale = "en") {
  if (typeof value === "function") return translate(value(), locale)
  if (value && typeof value === "object") {
    if ("literal" in value) return value.literal
    if ("list" in value) return value.list.map((part) => translate(part, locale)).join(", ")
    if ("number" in value)
      return new Intl.NumberFormat(locales[locale] || "en").format(value.number)
    if ("date" in value)
      return new Intl.DateTimeFormat(locales[locale] || "en", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value.date))
    const template = locale === "tw" && Object.hasOwn(tw, value.key) ? tw[value.key] : value.key
    return template.replace(/\{(\w+)\}/g, (placeholder, key) => {
      if (!Object.hasOwn(value.values, key)) return placeholder
      const part = value.values[key]
      // Plain interpolation values are data, not translation keys.
      return part && typeof part === "object" ? translate(part, locale) : String(part)
    })
  }
  const key = String(value ?? "")
  return locale === "tw" && Object.hasOwn(tw, key) ? tw[key] : key
}

export function detectLocale(saved, languages = []) {
  if (Object.hasOwn(locales, saved)) return saved
  for (const language of languages) {
    if (/^(?:tw|zh)(?:-|$)/i.test(language)) return "tw"
    if (/^en(?:-|$)/i.test(language)) return "en"
  }
  return "en"
}

export function createI18n({
  document = globalThis.document,
  navigator = globalThis.navigator,
  storage,
} = {}) {
  let saved
  try {
    storage ??= globalThis.localStorage
    saved = storage?.getItem(storageKey)
  } catch {
    // A blocked storage API must not prevent login or settings access.
  }
  let locale = detectLocale(saved, navigator?.languages || [navigator?.language || "en"])
  const bindings = new WeakMap()

  function bind(element, field, update, deferred = false) {
    let fields = bindings.get(element)
    if (!fields) {
      fields = new Map()
      bindings.set(element, fields)
    }
    fields.set(field, { update, deferred })
    update()
  }

  function setText(element, value) {
    bind(
      element,
      "text",
      () => {
        element.textContent = translate(value, locale)
      },
      typeof value === "function",
    )
  }

  function setAttribute(element, name, value) {
    bind(element, name, () => {
      element.setAttribute(name, translate(value, locale))
    })
  }

  function setValidity(element, value) {
    bind(element, "validity", () => {
      element.setCustomValidity(translate(value, locale))
    })
  }

  function option(label, value) {
    const element = document.createElement("option")
    element.value = value
    setText(element, label)
    return element
  }

  function setLocale(next) {
    if (!Object.hasOwn(locales, next)) return false
    locale = next
    document.documentElement.lang = locales[locale]
    const deferred = []
    for (const element of document.querySelectorAll("*")) {
      for (const binding of bindings.get(element)?.values() || []) {
        if (binding.deferred) deferred.push(binding.update)
        else binding.update()
      }
    }
    // Callbacks can read labels and validity from controls later in the DOM.
    for (const update of deferred) update()
    const select = document.getElementById("language-select")
    if (select) select.value = locale
    try {
      storage?.setItem(storageKey, locale)
    } catch {
      // In-memory switching remains available without persistent storage.
    }
    return true
  }

  for (const element of document.querySelectorAll("[data-i18n]")) {
    const parts = [...element.childNodes]
      .filter((node) => node.nodeType === 3 && node.textContent.trim())
      .map((node) => ({ node, source: node.textContent }))
    bind(element, "text", () => {
      for (const { node, source } of parts) {
        node.textContent = source.replace(/\S[\s\S]*\S|\S/, (key) => translate(key, locale))
      }
    })
  }
  for (const name of ["aria-label", "placeholder"]) {
    for (const element of document.querySelectorAll(`[data-i18n-${name}]`))
      setAttribute(element, name, element.getAttribute(name))
  }
  const select = document.getElementById("language-select")
  select?.addEventListener("change", () => setLocale(select.value))
  setLocale(locale)

  return { setText, setAttribute, setValidity, option, setLocale, getLocale: () => locale }
}
