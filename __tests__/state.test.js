import { describe, it, expect } from "vitest";
import { STATES, transition, wantsEsc } from "../lib/state.js";

const EVENTS = ["hotkey", "holdDown", "holdUp", "esc", "autoStop", "result", "empty", "error"];

describe("state machine", () => {
  it("knows three states", () => {
    expect(STATES).toEqual(["idle", "recording", "processing"]);
  });

  it("idle: only hotkey / holdDown start a recording", () => {
    expect(transition("idle", "hotkey")).toEqual({ state: "recording", action: "start" });
    expect(transition("idle", "holdDown")).toEqual({ state: "recording", action: "start" });
    for (const ev of EVENTS.filter((e) => e !== "hotkey" && e !== "holdDown")) {
      expect(transition("idle", ev)).toEqual({ state: "idle", action: null });
    }
  });

  it("recording: hotkey / holdUp / autoStop stop into processing", () => {
    for (const ev of ["hotkey", "holdUp", "autoStop"]) {
      expect(transition("recording", ev)).toEqual({ state: "processing", action: "stop" });
    }
  });

  it("recording: Esc cancels and discards", () => {
    expect(transition("recording", "esc")).toEqual({ state: "idle", action: "cancel" });
  });

  it("recording: empty / error reset; holdDown and result are ignored", () => {
    expect(transition("recording", "empty")).toEqual({ state: "idle", action: "reset" });
    expect(transition("recording", "error")).toEqual({ state: "idle", action: "reset" });
    expect(transition("recording", "holdDown")).toEqual({ state: "recording", action: null });
    expect(transition("recording", "result")).toEqual({ state: "recording", action: null });
  });

  it("processing: result delivers, Esc drops the job, hotkey is ignored", () => {
    expect(transition("processing", "result")).toEqual({ state: "idle", action: "deliver" });
    expect(transition("processing", "esc")).toEqual({ state: "idle", action: "drop" });
    expect(transition("processing", "hotkey")).toEqual({ state: "processing", action: null });
    expect(transition("processing", "holdDown")).toEqual({ state: "processing", action: null });
    expect(transition("processing", "holdUp")).toEqual({ state: "processing", action: null });
    expect(transition("processing", "autoStop")).toEqual({ state: "processing", action: null });
    expect(transition("processing", "empty")).toEqual({ state: "idle", action: "reset" });
    expect(transition("processing", "error")).toEqual({ state: "idle", action: "reset" });
  });

  it("unknown state resets to idle", () => {
    expect(transition("bogus", "hotkey")).toEqual({ state: "idle", action: "reset" });
    expect(transition(undefined, "esc")).toEqual({ state: "idle", action: "reset" });
  });

  it("a full toggle cycle returns to idle", () => {
    let s = "idle";
    s = transition(s, "hotkey").state;
    s = transition(s, "hotkey").state;
    s = transition(s, "result").state;
    expect(s).toBe("idle");
  });

  it("Esc is wanted only while recording or processing", () => {
    expect(wantsEsc("idle")).toBe(false);
    expect(wantsEsc("recording")).toBe(true);
    expect(wantsEsc("processing")).toBe(true);
    expect(wantsEsc("bogus")).toBe(false);
  });
});
