import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { date, detectLocale, list, message, number, raw, translate } from "../public/i18n.js"
import { en } from "../public/locales/en.js"
import { tw } from "../public/locales/tw.js"

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8")

describe("locale messages", () => {
  it("keeps the English catalog complete and aligned with Traditional Chinese", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(tw).sort())
    for (const [key, value] of Object.entries(en)) expect(value, key).toBe(key)
  })

  it("uses the English catalog for the default language and missing translations", () => {
    const key = "test.catalog.fallback"
    Object.defineProperty(en, key, { value: "English fallback", configurable: true })
    try {
      expect(translate(key)).toBe("English fallback")
      expect(translate(key, "tw")).toBe("English fallback")
      expect(translate(message(key), "tw")).toBe("English fallback")
      expect(translate(key, "unknown")).toBe("English fallback")
    } finally {
      Reflect.deleteProperty(en, key)
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

  it("falls back to English and never treats interpolated data as a translation key", () => {
    expect(translate("Models", "en")).toBe("Models")
    expect(translate("Models", "tw")).toBe("模型")
    expect(translate(message("Missing: {name}", { name: "Models" }), "tw")).toBe("Missing: Models")
    expect(translate(raw("Models"), "tw")).toBe("Models")
    expect(
      translate(message("Delete {name}?", { name: '<img src=x onerror="alert(1)">' }), "tw"),
    ).toBe('刪除 <img src=x onerror="alert(1)">？')
    expect(translate(message("Unknown {value}"), "tw")).toBe("Unknown {value}")
    expect(translate("toString", "tw")).toBe("toString")
  })

  it("localizes nested messages, lists, counts, and dates with valid language tags", () => {
    const value = message("{state}. {reason}", {
      state: message("Configuration applied"),
      reason: message("Selected model: {name}.", { name: "Models" }),
    })
    expect(translate(value, "tw")).toBe("設定已套用。已選取模型：Models。")
    expect(translate(list([message("Models"), raw("Models")]), "tw")).toBe("模型, Models")
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

  it("keeps every translation's interpolation names aligned with the English source", () => {
    const placeholders = (value: string) =>
      [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
    for (const [source, translated] of Object.entries(tw)) {
      expect(translated.trim(), source).not.toBe("")
      expect(placeholders(translated), source).toEqual(placeholders(source))
    }
  })

  it("covers first-party dynamic messages; protocol names and program tokens stay unchanged", () => {
    const unchanged = new Set([
      "GET",
      "POST",
      "PUT",
      "DELETE",
      "R",
      "Origin",
      "Content-Type",
      "OpenAI Completions",
      "OpenAI Responses",
      "Anthropic Messages",
      "Google Generative AI",
    ])
    const values = [...app.matchAll(/"(?:[^"\\]|\\.)*"/g)].map((match) => JSON.parse(match[0]))
    const keys = values.filter((value: string) => /^[A-Z＋]/.test(value) || /\{\w+\}/.test(value))
    for (const key of keys) if (!unchanged.has(key)) expect(Object.hasOwn(tw, key), key).toBe(true)
  })
})
