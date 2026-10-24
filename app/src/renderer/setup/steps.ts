import type { SettingsSnapshot, SetupCheck, SetupChecks, SetupStepId } from "../../main/ui/windows/types";

// The setup wizard's steps (Setup.swift SetupStep) with the Linux permissions in place of the macOS ones, and the
// state each one shows in the sidebar. DOM-free for tests.

export interface StepMeta { id: SetupStepId; title: string; icon: string; optional: boolean; required: boolean }

export const STEPS: StepMeta[] = [
  { id: "welcome", title: "Welcome", icon: "hand", optional: false, required: false },
  { id: "microphone", title: "Microphone", icon: "mic", optional: false, required: true },
  { id: "keyboard", title: "Keyboard Access", icon: "keyboard", optional: false, required: true },
  { id: "screen", title: "Screen Capture", icon: "screen", optional: false, required: true },
  { id: "control", title: "Computer Control", icon: "cursor", optional: false, required: true },
  { id: "terminal", title: "Terminal", icon: "terminal", optional: true, required: false },
  { id: "transcription", title: "Speech Model", icon: "brain", optional: false, required: false },
  { id: "voice", title: "Voice", icon: "speaker", optional: true, required: false },
  { id: "assistant", title: "Assistant", icon: "sparkles", optional: false, required: false },
  { id: "addons", title: "Add-ons", icon: "puzzle", optional: true, required: false },
  { id: "done", title: "All Set", icon: "seal", optional: false, required: false },
];

export type StepState = SetupCheck["state"];

/** SetupModel.state(of:): main's check wins; the speech, voice and assistant steps fall back to the settings. */
export function stateOf(id: SetupStepId, current: SetupStepId, checks: SetupChecks, s: SettingsSnapshot | null): StepState {
  if (id === "welcome") return STEPS.findIndex((x) => x.id === current) > 0 ? "done" : "pending";
  if (id === "done") return "pending";
  const c = checks[id];
  if (c) return c.state;
  const meta = STEPS.find((x) => x.id === id)!;
  if (!s) return meta.optional ? "optional" : "pending";
  switch (id) {
    case "transcription":
      if (s.speechEngine === "parakeet") return s.parakeetReady ? "done" : "pending";
      if (s.speechEngine.startsWith("whisper")) return s.whisperModels.length ? "done" : "pending";
      return "done";
    case "voice": return s.speak ? "done" : "optional";
    case "assistant": return s.tools[s.assistant]?.connected ? "done" : "pending";
    case "addons": return s.addOns.length && s.addOns.every((a) => a.installed) ? "done" : "optional";
    default: return meta.optional ? "optional" : "pending";
  }
}

/** Steps still to do (not optional, not done), for the last page. */
export function missing(current: SetupStepId, checks: SetupChecks, s: SettingsSnapshot | null): StepMeta[] {
  return STEPS.filter((x) => !x.optional && x.id !== "done" && x.id !== "welcome" && stateOf(x.id, current, checks, s) === "pending");
}

/** Everything required is done (SetupModel.requiredGranted): closing the wizard then counts as finished. */
export function requiredDone(current: SetupStepId, checks: SetupChecks, s: SettingsSnapshot | null): boolean {
  return STEPS.filter((x) => x.required).every((x) => stateOf(x.id, current, checks, s) === "done");
}

export function next(id: SetupStepId): SetupStepId | null {
  const i = STEPS.findIndex((x) => x.id === id);
  return i >= 0 && i + 1 < STEPS.length ? STEPS[i + 1].id : null;
}

export function back(id: SetupStepId): SetupStepId | null {
  const i = STEPS.findIndex((x) => x.id === id);
  return i > 0 ? STEPS[i - 1].id : null;
}

export function whisperDetail(name: string): string {
  if (name.startsWith("large")) return "Most accurate Whisper, slower. Already on your computer.";
  if (name.startsWith("medium")) return "More accurate, a bit slower. Already on your computer.";
  return `Fast and accurate${name.endsWith(".en") ? " (English)" : ""}. Already on your computer.`;
}
