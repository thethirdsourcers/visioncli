import { readFileSync } from "node:fs";

// Linux input events (linux/input.h). `struct input_event` is a struct timeval followed by type, code and value:
// 24 bytes with a 64-bit time_t (x86_64, arm64, and 32-bit userlands built with 64-bit time), 16 bytes on classic
// 32-bit userlands (armhf, i386).

export const EV_SYN = 0, EV_KEY = 1, EV_REL = 2;
export const SYN_DROPPED = 3;
export const REL_HWHEEL = 6, REL_WHEEL = 8, REL_WHEEL_HI_RES = 11, REL_HWHEEL_HI_RES = 12;

export const KEY = {
  ESC: 1, E: 18, O: 24, P: 25, ENTER: 28, LEFTCTRL: 29, LEFTSHIFT: 42, RIGHTSHIFT: 54, LEFTALT: 56, SPACE: 57,
  KPENTER: 96, RIGHTCTRL: 97, RIGHTALT: 100, LEFTMETA: 125, RIGHTMETA: 126,
} as const;
/** Mouse buttons: BTN_LEFT … BTN_TASK (0x110–0x117). Touchpad clicks report BTN_LEFT too. */
export const BTN_MOUSE_FIRST = 0x110, BTN_MOUSE_LAST = 0x117;

export interface InputEvent { sec: number; usec: number; type: number; code: number; value: number }

/** The event size for this process: 16 bytes on 32-bit ARM/x86 userlands, 24 everywhere else. */
export function eventSize(arch: string = process.arch): 16 | 24 {
  return arch === "arm" || arch === "ia32" ? 16 : 24;
}

/** Splits a read into events; `rest` is a trailing partial event (pipes may cut anywhere) to prepend to the next read. */
export function parseEvents(buf: Buffer, size: 16 | 24 = eventSize()): { events: InputEvent[]; rest: Buffer } {
  const events: InputEvent[] = [];
  let off = 0;
  for (; off + size <= buf.length; off += size) {
    const t = size === 24
      ? { sec: Number(buf.readBigInt64LE(off)), usec: Number(buf.readBigInt64LE(off + 8)) }
      : { sec: buf.readInt32LE(off), usec: buf.readInt32LE(off + 4) };
    const p = off + size - 8;
    events.push({ ...t, type: buf.readUInt16LE(p), code: buf.readUInt16LE(p + 2), value: buf.readInt32LE(p + 4) });
  }
  return { events, rest: buf.subarray(off) };
}

/** Builds raw event bytes (tests, replays). */
export function encodeEvents(events: Partial<InputEvent>[], size: 16 | 24 = eventSize()): Buffer {
  const buf = Buffer.alloc(events.length * size);
  events.forEach((e, i) => {
    const off = i * size;
    if (size === 24) { buf.writeBigInt64LE(BigInt(e.sec ?? 0), off); buf.writeBigInt64LE(BigInt(e.usec ?? 0), off + 8); }
    else { buf.writeInt32LE(e.sec ?? 0, off); buf.writeInt32LE(e.usec ?? 0, off + 4); }
    const p = off + size - 8;
    buf.writeUInt16LE(e.type ?? 0, p);
    buf.writeUInt16LE(e.code ?? 0, p + 2);
    buf.writeInt32LE(e.value ?? 0, p + 4);
  });
  return buf;
}

export interface ProcDevice { name: string; event: string; keyboard: boolean; pointer: boolean }

/** Tests a bit in a /proc/bus/input/devices bitmap ("B: KEY=…": hex longs, most significant first). */
export function hasBit(bitmap: string, bit: number, longBits = process.arch === "arm" || process.arch === "ia32" ? 32 : 64): boolean {
  const words = bitmap.trim().split(/\s+/).reverse();
  const word = words[Math.floor(bit / longBits)];
  if (!word) return false;
  return ((BigInt("0x" + word) >> BigInt(bit % longBits)) & 1n) === 1n;
}

/** The input devices from /proc/bus/input/devices that matter: keyboards (have Alt and Space) and pointers (have a left button). */
export function parseProcDevices(text: string, longBits?: number): ProcDevice[] {
  const out: ProcDevice[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const name = /^N: Name="(.*)"$/m.exec(block)?.[1] ?? "";
    const event = /^H: Handlers=.*\b(event\d+)\b/m.exec(block)?.[1];
    const keys = /^B: KEY=(.*)$/m.exec(block)?.[1];
    if (!event || !keys) continue;
    const keyboard = hasBit(keys, KEY.LEFTALT, longBits) && hasBit(keys, KEY.SPACE, longBits);
    const pointer = hasBit(keys, BTN_MOUSE_FIRST, longBits);
    if (keyboard || pointer) out.push({ name, event, keyboard, pointer });
  }
  return out;
}

export function procDevices(): ProcDevice[] | null {
  try { return parseProcDevices(readFileSync("/proc/bus/input/devices", "utf8")); } catch { return null; }
}
