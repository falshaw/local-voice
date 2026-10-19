import { describe, it, expect } from "vitest";
import {
  MAX_ENTRIES,
  FROM_MAX,
  TO_MAX,
  validateDictionary,
  compile,
  apply,
  mirrorCase,
} from "../lib/dictionary.js";

function run(text, entries, mode) {
  return apply(text, compile(validateDictionary(entries), mode));
}

describe("whole-word matching", () => {
  it('"cat" does not match inside "catalog" or "cats"', () => {
    expect(run("cat catalog cats cat.", [{ from: "cat", to: "dog" }])).toBe("dog catalog cats dog.");
  });

  it("does not match across underscores or digits", () => {
    expect(run("my_cat cat2 cat", [{ from: "cat", to: "dog" }])).toBe("my_cat cat2 dog");
  });

  it("handles umlauts and ß as letters", () => {
    expect(run("herr muller und mullers", [{ from: "muller", to: "Müller" }])).toBe("herr Müller und mullers");
    expect(run("die straße, straßen", [{ from: "straße", to: "Strasse" }])).toBe("die Strasse, straßen");
    expect(run("Müller müller MÜLLER", [{ from: "müller", to: "Mueller" }])).toBe("Mueller Mueller Mueller");
  });

  it("escapes regex metacharacters in from", () => {
    expect(run("c++ and c", [{ from: "c++", to: "C++" }])).toBe("C++ and c");
    expect(run("a.b ab", [{ from: "a.b", to: "AB" }])).toBe("AB ab");
  });

  it("returns the input untouched with no entries or empty text", () => {
    expect(apply("hello", null)).toBe("hello");
    expect(apply("hello", compile([], "raw"))).toBe("hello");
    expect(apply("", compile([{ from: "a", to: "b", modes: [] }], "raw"))).toBe("");
    expect(compile([], "raw")).toBeNull();
  });
});

describe("case mirroring", () => {
  it("a lowercase replacement copies the spoken casing", () => {
    const d = [{ from: "vpn", to: "vpn tunnel" }];
    expect(run("vpn", d)).toBe("vpn tunnel");
    expect(run("Vpn", d)).toBe("Vpn tunnel");
    expect(run("VPN", d)).toBe("VPN TUNNEL");
  });

  it("a replacement with capitals is used verbatim", () => {
    const d = [{ from: "github", to: "GitHub" }];
    expect(run("github", d)).toBe("GitHub");
    expect(run("Github", d)).toBe("GitHub");
    expect(run("GITHUB", d)).toBe("GitHub");
  });

  it("a single capital letter match is Capitalised, not ALL CAPS", () => {
    expect(mirrorCase("I", "me")).toBe("Me");
    expect(mirrorCase("Ok", "fine")).toBe("Fine");
    expect(mirrorCase("OK", "fine")).toBe("FINE");
    expect(mirrorCase("ok", "fine")).toBe("fine");
    expect(mirrorCase("123", "x")).toBe("x");
  });

  it("caseSensitive entries match the exact spelling only", () => {
    const d = [{ from: "IT", to: "information technology", caseSensitive: true }];
    expect(run("IT and it", d)).toBe("information technology and it");
  });

  it("a caseSensitive and a loose entry for the same word coexist", () => {
    const d = [
      { from: "IT", to: "information technology", caseSensitive: true },
      { from: "it", to: "that" },
    ];
    expect(run("IT it It", d)).toBe("information technology that That");
  });
});

describe("phrases", () => {
  it("longer phrases win over their parts", () => {
    const d = [
      { from: "alto", to: "ALTO" },
      { from: "palo alto", to: "Palo Alto Networks" },
    ];
    expect(run("we use palo alto and alto", d)).toBe("we use Palo Alto Networks and ALTO");
  });

  it("whitespace inside a phrase matches any run of spaces", () => {
    const d = [{ from: "palo  alto", to: "Palo Alto" }];
    expect(run("palo alto / palo   alto", d)).toBe("Palo Alto / Palo Alto");
  });

  it("the output of one entry is not re-scanned in the same pass", () => {
    const d = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ];
    expect(run("a b", d)).toBe("b c");
  });
});

describe("idempotence (the pipeline applies the dictionary twice)", () => {
  it("simple replacements are stable", () => {
    const c = compile(validateDictionary([{ from: "cat", to: "dog" }, { from: "bob", to: "Bob" }]), "raw");
    const once = apply("cat bob", c);
    expect(once).toBe("dog Bob");
    expect(apply(once, c)).toBe(once);
  });

  it("a replacement that contains its own trigger does not grow on the second pass", () => {
    const c = compile(
      validateDictionary([
        { from: "vpn", to: "vpn tunnel" },
        { from: "alto", to: "palo alto" },
        { from: "pa", to: "PA firewall" },
      ]),
      "raw",
    );
    const once = apply("vpn alto pa", c);
    expect(once).toBe("vpn tunnel palo alto PA firewall");
    expect(apply(once, c)).toBe(once);
    expect(apply("VPN", c)).toBe("VPN TUNNEL");
    expect(apply("VPN TUNNEL", c)).toBe("VPN TUNNEL");
  });
});

describe("modes", () => {
  const d = [
    { from: "foo", to: "FOO", modes: ["code"] },
    { from: "bar", to: "BAR", modes: [] },
    { from: "baz", to: "BAZ" },
  ];
  it("an entry with modes applies only in those modes; no modes = every mode", () => {
    expect(run("foo bar baz", d, "code")).toBe("FOO BAR BAZ");
    expect(run("foo bar baz", d, "formal")).toBe("foo BAR BAZ");
  });
  it("no mode given = everything applies", () => {
    expect(run("foo bar baz", d, undefined)).toBe("FOO BAR BAZ");
  });
});

describe("validateDictionary", () => {
  it("normalises entries", () => {
    expect(validateDictionary([{ from: "  palo   alto ", to: " PAN ", modes: ["code", "code"] }])).toEqual([
      { from: "palo alto", to: "PAN", caseSensitive: false, modes: ["code"] },
    ]);
    expect(validateDictionary([{ from: "a", to: "" }])[0].to).toBe("");
  });

  it("enforces the limits", () => {
    expect(MAX_ENTRIES).toBe(500);
    expect(FROM_MAX).toBe(64);
    expect(TO_MAX).toBe(256);
    const many = Array.from({ length: 501 }, (_, i) => ({ from: `w${i}`, to: "x" }));
    expect(() => validateDictionary(many)).toThrow(/500/);
    expect(validateDictionary(many.slice(0, 500))).toHaveLength(500);
    expect(() => validateDictionary([{ from: "", to: "x" }])).toThrow(/1–64/);
    expect(() => validateDictionary([{ from: "x".repeat(65), to: "x" }])).toThrow(/1–64/);
    expect(() => validateDictionary([{ from: "x", to: "y".repeat(257) }])).toThrow(/256/);
  });

  it("rejects bad shapes and control characters", () => {
    expect(() => validateDictionary("nope")).toThrow(/array/);
    expect(() => validateDictionary([null])).toThrow(/Entry 1/);
    expect(() => validateDictionary([["a", "b"]])).toThrow(/Entry 1/);
    expect(() => validateDictionary([{ from: 1, to: "b" }])).toThrow(/strings/);
    expect(() => validateDictionary([{ from: "a\u0000", to: "b" }])).toThrow(/control/);
    expect(() => validateDictionary([{ from: "a", to: "b\u001b[0m" }])).toThrow(/control/);
    expect(() => validateDictionary([{ from: "a", to: "b", caseSensitive: "yes" }])).toThrow(/caseSensitive/);
    expect(() => validateDictionary([{ from: "a", to: "b", modes: ["email"] }])).toThrow(/raw\/formal\/code/);
    expect(() => validateDictionary([{ from: "a", to: "b", modes: "code" }])).toThrow(/modes/);
  });
});
