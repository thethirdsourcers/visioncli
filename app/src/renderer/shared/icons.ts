// SF Symbols used by the macOS overlay, redrawn as small inline SVGs (24×24 grid, currentColor) so they look the
// same on every Linux desktop without an icon theme.

const stroke = (d: string, w = 2) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const fill = (d: string) => `<svg viewBox="0 0 24 24" fill="currentColor">${d}</svg>`;

export const icons = {
  // The VisionCLI mark (docs/brand/mark.svg, Views.swift LogoMark): six aperture segments around a pupil, on the
  // 18-unit grid of the macOS MenuIcon scaled to 24 (ring r 6.1, stroke 2.3, pupil 4.6 across; dashes 42% of a sixth).
  mark: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.13" fill="none" stroke="currentColor" stroke-width="3.07" stroke-linecap="round" stroke-dasharray="3.58 4.94" transform="rotate(-70 12 12)"/><circle cx="12" cy="12" r="3.07" fill="currentColor"/></svg>',
  // eye.fill
  eye: fill('<path d="M12 4.5C6.6 4.5 2.7 8.6 1.3 11.4a1.4 1.4 0 0 0 0 1.2C2.7 15.4 6.6 19.5 12 19.5s9.3-4.1 10.7-6.9a1.4 1.4 0 0 0 0-1.2C21.3 8.6 17.4 4.5 12 4.5Zm0 12.2a4.7 4.7 0 1 1 0-9.4 4.7 4.7 0 0 1 0 9.4Zm0-7.3a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2Z"/>'),
  // exclamationmark.triangle.fill
  warning: fill('<path d="M10.3 3.3a2 2 0 0 1 3.4 0l8.5 14.8a2 2 0 0 1-1.7 3H3.5a2 2 0 0 1-1.7-3L10.3 3.3Zm.4 5.4.3 6.1h2l.3-6.1h-2.6Zm1.3 7.7a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Z"/>'),
  // doc.on.doc
  copy: stroke('<rect x="8.5" y="8.5" width="12" height="13" rx="2.5"/><path d="M15.5 8.5V5a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 5v8.5A2.5 2.5 0 0 0 6 16h2.5"/>', 1.8),
  // speaker.wave.2
  speaker: stroke('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6"/><path d="M18.3 6.5a8 8 0 0 1 0 11"/>', 1.8),
  // speaker.wave.2.fill
  speakerFill: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6"/><path d="M18.3 6.5a8 8 0 0 1 0 11"/></svg>`,
  // clock.arrow.circlepath
  history: stroke('<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3 4.5V9h4.5"/><path d="M12 7.5V12l3 2"/>', 1.8),
  // arrow.up.forward.square
  open: stroke('<rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><path d="M9.5 14.5 15 9M10 9h5v5"/>', 1.8),
  // pin
  pin: stroke('<path d="M9 3.5h6l-1 6 3.5 3.5v1.5h-11V13L10 9.5z"/><path d="M12 14.5v6"/>', 1.8),
  // pin.slash
  pinSlash: stroke('<path d="M9 3.5h6l-1 6 3.5 3.5v1.5h-11V13L10 9.5z"/><path d="M12 14.5v6"/><path d="M4 3l16 18"/>', 1.8),
  // xmark
  close: stroke('<path d="M6 6l12 12M18 6 6 18"/>', 2.2),
  // hand.raised.fill
  hand: fill('<path d="M8.6 4.3a1.4 1.4 0 0 1 2.8 0v6.2h.5V3.2a1.4 1.4 0 0 1 2.8 0v7.3h.5V4.6a1.4 1.4 0 0 1 2.8 0v9.9c0 4-2.9 7.3-6.9 7.3-2.4 0-4.3-1.1-5.6-3.2l-2.6-4.4a1.4 1.4 0 0 1 2.3-1.5l1.8 2.2V6.2a1.4 1.4 0 0 1 2.8 0v4.3h.5z"/>'),
  // sparkles
  sparkles: fill('<path d="M10 2.5 11.6 8 17 9.6l-5.4 1.6L10 16.7 8.4 11.2 3 9.6 8.4 8z"/><path d="M18 13.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z"/><path d="M18.5 2.5l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6z"/>'),
  // pause.circle.fill
  pause: fill('<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-3 6h2v8H9zm4 0h2v8h-2z"/>'),
  // checkmark
  check: stroke('<path d="M4.5 12.5l5 5 10-11"/>', 3),
  // cursorarrow.rays
  cursor: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M10 9l10 4-4.2 1.6L14 19z" fill="currentColor" stroke-linejoin="round"/><path d="M7 3.5v2.5M2.5 8H5M3.8 4.8l1.7 1.7M10.2 4.8 8.5 6.5M3.8 11.2l1.7-1.7"/></svg>`,
  // text.cursor
  textCursor: stroke('<path d="M9 4h6M9 20h6M12 4v16"/>', 2),
  // camera.viewfinder (screenshot badges)
  camera: stroke('<path d="M3 8V5.5A2.5 2.5 0 0 1 5.5 3H8M16 3h2.5A2.5 2.5 0 0 1 21 5.5V8M21 16v2.5a2.5 2.5 0 0 1-2.5 2.5H16M8 21H5.5A2.5 2.5 0 0 1 3 18.5V16"/><circle cx="12" cy="12" r="3.5"/>', 1.8),
  // square.dashed (area selected)
  area: stroke('<rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="3 3"/>', 1.8),
};

export type IconName = keyof typeof icons;

/** Unknown names (e.g. an SF Symbol name passed through from the app) fall back to the eye. */
export function icon(name: string): string {
  const aliases: Record<string, IconName> = {
    "eye": "eye", "eye.fill": "eye", "cursorarrow.rays": "cursor", "hand.raised.fill": "hand", "sparkles": "sparkles",
    "camera.viewfinder": "camera", "camera": "camera", "doc.on.doc": "copy", "checkmark": "check",
  };
  return icons[(name in icons ? name : aliases[name] ?? "eye") as IconName];
}
