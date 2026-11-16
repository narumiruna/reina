import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { date, detectLocale, list, message, number, raw, translate } from "../public/i18n.js"
import en from "../public/locales/en.json" with { type: "json" }
import tw from "../public/locales/tw.json" with { type: "json" }

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8")

describe("locale messages", () => {
  it("uses matching semantic kebab-case keys in both catalogs", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(tw).sort())
    for (const [key, value] of Object.entries(en)) {
      expect(key).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
      expect(value.trim(), key).not.toBe("")
    }
  })

  it("uses the English catalog as fallback without treating English copy as keys", () => {
    const key = "test-fallback"
    Object.defineProperty(en, key, { value: "English fallback", configurable: true })
    try {
      expect(translate(key)).toBe("English fallback")
      expect(translate(key, "tw")).toBe("English fallback")
      expect(translate(message(key), "tw")).toBe("English fallback")
      expect(translate(key, "unknown")).toBe("English fallback")
    } finally {
      Reflect.deleteProperty(en, key)
    }
    expect(translate("Models", "tw")).toBe("Models")
    expect(translate("unknown-message-key", "tw")).toBe("unknown-message-key")
  })

  it("allows copy changes without changing the key or UI references", () => {
    const original = en["models-title"]
    try {
      en["models-title"] = "Model settings"
      expect(translate("models-title", "en")).toBe("Model settings")
      expect(translate("models-title", "tw")).toBe("模型")
    } finally {
      en["models-title"] = original
    }
  })

  it("uses the saved locale, then the first supported browser preference, then English", () => {
    expect(detectLocale("en", ["zh-TW"])).toBe("en")
    expect(detectLocale("tw", ["en-US"])).toBe("tw")
    for (const language of ["tw", "zh", "zh-TW", "zh-Hant", "zh-HK", "zh-CN"])
      expect(detectLocale(null, [language])).toBe("tw")
    expect(detectLocale("invalid", ["ja-JP", "zh-Hant-TW", "en"])).toBe("tw")
    expect(detectLocale(null, ["en-GB", "zh-TW"])).toBe("en")
    expect(detectLocale("__proto__", ["ja-JP"])).toBe("en")
    expect(detectLocale(null, [])).toBe("en")
  })

  it("keeps interpolated data literal, including key-like names and i18next syntax", () => {
    expect(translate("models-title", "en")).toBe("Models")
    expect(translate("models-title", "tw")).toBe("模型")
    expect(translate(raw("models-title"), "tw")).toBe("models-title")
    for (const name of [
      "models-title",
      "{{other}}",
      "$t(models-title)",
      '<img src=x onerror="alert(1)">',
    ])
      expect(translate(message("model-delete-confirmation", { name }), "tw")).toBe(`刪除 ${name}？`)
    expect(translate("toString", "tw")).toBe("toString")
  })

  it("uses i18next plural rules with kebab-case suffixes and numeric count values", () => {
    for (const count of [0, 1, 2, 1000]) {
      const value = message("provider-saved-model-count", { provider: "OpenAI", count })
      const formatted = new Intl.NumberFormat("en").format(count)
      expect(translate(value, "en")).toBe(
        `OpenAI · ${formatted} saved ${count === 1 ? "model" : "models"}`,
      )
      expect(translate(value, "tw")).toBe(`OpenAI · 已儲存 ${formatted} 個模型`)
    }
  })

  it("localizes nested messages, lists, counts, and dates with valid language tags", () => {
    const value = message("runtime-status-summary", {
      state: message("runtime-state-running"),
      reason: message("runtime-selected-model", { name: "Models" }),
    })
    expect(translate(value, "tw")).toBe("設定已套用。已選取模型：Models。")
    expect(translate(list([message("models-title"), raw("models-title")]), "tw")).toBe(
      "模型, models-title",
    )
    expect(translate(number(128000), "tw")).toBe(new Intl.NumberFormat("zh-Hant").format(128000))
    const timestamp = "2026-01-01T00:00:00Z"
    for (const [locale, tag] of [
      ["en", "en"],
      ["tw", "zh-Hant"],
    ])
      expect(translate(date(timestamp), locale)).toBe(
        new Intl.DateTimeFormat(tag, { dateStyle: "medium", timeStyle: "short" }).format(
          new Date(timestamp),
        ),
      )
  })

  it("keeps i18next placeholders aligned with the English catalog", () => {
    const placeholders = (value: string) =>
      [...value.matchAll(/\{\{\s*(\w+)(?:\s*,[^}]+)?\s*\}\}/g)].map((match) => match[1]).sort()
    for (const [key, translated] of Object.entries(tw)) {
      expect(translated.trim(), key).not.toBe("")
      expect(placeholders(translated), key).toEqual(placeholders(en[key]))
      expect(translated.replace(/\{\{[^}]+\}\}/g, ""), key).not.toMatch(/\{\w+\}/)
    }
  })

  it("covers explicit message references, including plural base keys", () => {
    const keys = [...app.matchAll(/\bmessage\("([a-z][a-z0-9-]+)"/g)].map((match) => match[1])
    expect(keys.length).toBeGreaterThan(100)
    for (const key of keys)
      expect(Object.hasOwn(en, key) || Object.hasOwn(en, `${key}-other`), key).toBe(true)
    expect(app).not.toMatch(/\bmessage\("[A-Z]/)
  })
})
