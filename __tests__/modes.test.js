import { describe, it, expect } from "vitest";
import {
  MAX_RULES,
  MATCH_MAX,
  DEFAULT_MODE_RULES,
  DEFAULT_MODE_CLEANUP,
  validateModeRules,
  validateModeCleanup,
  matchMode,
  parseActiveWindowJson,
} from "../lib/modes.js";

describe("defaults", () => {
  it("match the plan: editors/terminals → code, mail → formal, else raw", () => {
    const m = (win) => matchMode(DEFAULT_MODE_RULES, win, "raw");
    expect(m({ process: "Code", title: "main.js - Visual Studio Code" })).toBe("code");
    expect(m({ process: "WindowsTerminal", title: "pwsh" })).toBe("code");
    expect(m({ process: "pwsh", title: "" })).toBe("code");
    expect(m({ process: "OUTLOOK", title: "Inbox" })).toBe("formal");
    expect(m({ process: "thunderbird", title: "" })).toBe("formal");
    expect(m({ process: "chrome", title: "Inbox (3) - Proton Mail" })).toBe("formal");
    expect(m({ process: "notepad", title: "Untitled" })).toBe("raw");
    expect(DEFAULT_MODE_CLEANUP).toEqual({ raw: false, formal: true, code: false });
    expect(Object.isFrozen(DEFAULT_MODE_RULES)).toBe(true);
  });
});

describe("matchMode", () => {
  const rules = [
    { match: "ab", field: "title", mode: "formal" },
    { match: "a", field: "title", mode: "code" },
  ];

  it("is a case-insensitive substring match, first rule wins", () => {
    expect(matchMode(rules, { process: "x", title: "xxABxx" })).toBe("formal");
    expect(matchMode(rules, { process: "x", title: "A" })).toBe("code");
    expect(matchMode([{ match: "code", field: "process", mode: "code" }], { process: "VSCODE" })).toBe("code");
  });

  it("only looks at the rule's field", () => {
    expect(matchMode([{ match: "code", field: "title", mode: "code" }], { process: "Code", title: "x" })).toBe("raw");
  });

  it("treats regex syntax literally", () => {
    expect(matchMode([{ match: ".*", field: "title", mode: "code" }], { process: "x", title: "anything" })).toBe("raw");
    expect(matchMode([{ match: ".*", field: "title", mode: "code" }], { process: "x", title: "a.*b" })).toBe("code");
  });

  it("falls back to defaultMode (or raw when that is invalid)", () => {
    expect(matchMode(rules, null, "formal")).toBe("formal");
    expect(matchMode(rules, { process: "x", title: "zzz" }, "code")).toBe("code");
    expect(matchMode(rules, { process: "x", title: "zzz" }, "nope")).toBe("raw");
    expect(matchMode("not-an-array", { process: "x", title: "a" }, "formal")).toBe("formal");
    expect(matchMode(rules, { process: 42, title: null })).toBe("raw");
  });
});

describe("parseActiveWindowJson (PowerShell output)", () => {
  it("parses a well-formed object", () => {
    expect(parseActiveWindowJson('{"process":"Code","title":"main.js"}\r\n')).toEqual({
      process: "Code",
      title: "main.js",
    });
    expect(parseActiveWindowJson('{"process":"pwsh"}')).toEqual({ process: "pwsh", title: "" });
  });

  it("returns null for malformed or empty output", () => {
    expect(parseActiveWindowJson("")).toBeNull();
    expect(parseActiveWindowJson("   ")).toBeNull();
    expect(parseActiveWindowJson(undefined)).toBeNull();
    expect(parseActiveWindowJson("Add-Type : error")).toBeNull();
    expect(parseActiveWindowJson('{"process":"Code"')).toBeNull();
    expect(parseActiveWindowJson("null")).toBeNull();
    expect(parseActiveWindowJson("[]")).toBeNull();
    expect(parseActiveWindowJson('{"process":1,"title":2}')).toBeNull();
    expect(parseActiveWindowJson('{"process":"","title":""}')).toBeNull();
  });

  it("caps field lengths", () => {
    const r = parseActiveWindowJson(JSON.stringify({ process: "p".repeat(300), title: "t".repeat(600) }));
    expect(r.process).toHaveLength(260);
    expect(r.title).toHaveLength(512);
  });
});

describe("validateModeRules", () => {
  it("normalises rules", () => {
    expect(validateModeRules([{ match: "  Code ", field: "process", mode: "code", extra: 1 }])).toEqual([
      { match: "Code", field: "process", mode: "code" },
    ]);
    expect(validateModeRules([])).toEqual([]);
  });

  it("enforces the limits", () => {
    expect(MAX_RULES).toBe(50);
    expect(MATCH_MAX).toBe(128);
    const many = Array.from({ length: 51 }, () => ({ match: "x", field: "title", mode: "raw" }));
    expect(() => validateModeRules(many)).toThrow(/50/);
    expect(validateModeRules(many.slice(0, 50))).toHaveLength(50);
    expect(() => validateModeRules([{ match: "", field: "title", mode: "raw" }])).toThrow(/1–128/);
    expect(() => validateModeRules([{ match: "x".repeat(129), field: "title", mode: "raw" }])).toThrow(/1–128/);
    expect(() => validateModeRules([{ match: "a\tb", field: "title", mode: "raw" }])).toThrow(/printable/);
  });

  it("rejects bad shapes", () => {
    expect(() => validateModeRules({})).toThrow(/array/);
    expect(() => validateModeRules([null])).toThrow(/Rule 1/);
    expect(() => validateModeRules([{ match: 1, field: "title", mode: "raw" }])).toThrow(/string/);
    expect(() => validateModeRules([{ match: "x", field: "class", mode: "raw" }])).toThrow(/process or title/);
    expect(() => validateModeRules([{ match: "x", field: "title", mode: "email" }])).toThrow(/raw\/formal\/code/);
  });
});

describe("validateModeCleanup", () => {
  it("requires a boolean per mode and drops extras", () => {
    expect(validateModeCleanup({ raw: true, formal: false, code: true, other: true })).toEqual({
      raw: true,
      formal: false,
      code: true,
    });
    expect(() => validateModeCleanup({ raw: true, formal: false })).toThrow(/code/);
    expect(() => validateModeCleanup({ raw: "yes", formal: false, code: true })).toThrow(/raw/);
    expect(() => validateModeCleanup(null)).toThrow(/object/);
  });
});
