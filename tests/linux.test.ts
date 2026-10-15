import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { captureScreen, captureWindow, findWindow, listWindows, pointerLocation } from "../src/capture.js";
import { arrange, asText, tabId } from "../src/browser-cdp.js";
import { browserFromClass } from "../src/browser.js";
import { appName, parseMouse, parseStacking, parseWmctrl } from "../src/linux.js";

describe("linux window listing", () => {
  const wmctrl = [
    "0x03a00003  0 4321   0    27   1280 720  google-chrome.Google-chrome  box New Tab - Google Chrome",
    "0x04400006 -1 999    1300 40   800  600  gnome-terminal-server.Gnome-terminal  box  ~/projects",
    "0x05000001  1 77     10   10   640  480  code.Code  box ",
    "garbage line",
  ].join("\n");

  test("wmctrl rows: hex id, desktop, geometry, class name and title", () => {
    const ws = parseWmctrl(wmctrl);
    assert.equal(ws.length, 3);
    assert.deepEqual(ws[0], {
      id: 0x03a00003, desktop: 0, app: "Google-chrome", title: "New Tab - Google Chrome",
      bounds: { x: 0, y: 27, width: 1280, height: 720 },
    });
    assert.equal(ws[1].desktop, -1);
    assert.equal(ws[1].title, "~/projects");
    assert.equal(ws[2].title, "");
  });

  test("app name is the WM_CLASS class part", () => {
    assert.equal(appName("org.gnome.Console.Kgx"), "gnome.Console.Kgx");
    assert.equal(appName("Navigator.firefox"), "firefox");
    assert.equal(appName("xterm"), "xterm");
  });

  test("stacking order comes back front-most first", () => {
    assert.deepEqual(parseStacking("_NET_CLIENT_LIST_STACKING(WINDOW): window id # 0x5000001, 0x3a00003, 0x4400006"),
      [0x4400006, 0x3a00003, 0x5000001]);
    assert.deepEqual(parseStacking("_NET_CLIENT_LIST_STACKING(WINDOW): window id # 0x1, 0x2\n"), [2, 1]);
    assert.deepEqual(parseStacking(""), []);
  });

  test("xdotool pointer", () => {
    assert.deepEqual(parseMouse("X=512\nY=300\nSCREEN=0\nWINDOW=123\n"), { x: 512, y: 300 });
    assert.equal(parseMouse("nope"), null);
  });
});

// CI runs this under Xvfb + openbox with an xterm and an xclock, the mouse over the clock (.github/workflows/ci-linux.yml).
describe("linux capture on a real X server", { skip: !process.env.VISIONCLI_LINUX_SMOKE && "set VISIONCLI_LINUX_SMOKE=1 under X11" }, () => {
  test("lists windows, reads the pointer, captures the window under it and the screen", async () => {
    const windows = await listWindows();
    assert.ok(windows.some((w) => w.app === "XClock"), JSON.stringify(windows));
    assert.ok(windows.some((w) => w.app === "XTerm"));
    assert.deepEqual(await pointerLocation(), { x: 800, y: 200 });
    const w = await findWindow({ underCursor: true });
    assert.equal(w.app, "XClock");
    const img = await captureWindow(w);
    assert.equal(img.mimeType, "image/jpeg");
    assert.deepEqual([img.width, img.height], [400, 400]);
    const screen = await captureScreen();
    assert.deepEqual([screen.width, screen.height], [1440, 900]);
  });
});

describe("browser tabs over DevTools", () => {
  const page = (targetId: string, windowId: number, visible: boolean, focused = false) =>
    ({ targetId, url: `https://${targetId}.test/`, title: targetId, windowId, visible, focused });

  test("the focused window comes first and only its visible tab is active", () => {
    const tabs = arrange([page("AAAAAAAAone", 1, true), page("BBBBBBBBtwo", 2, false), page("CCCCCCCCthree", 2, true, true)]);
    assert.deepEqual(tabs.map((t) => [t.id, t.window, t.index, t.active]),
      [["cbbbbbbbb", 1, 1, false], ["ccccccccc", 1, 2, true], ["caaaaaaaa", 2, 1, false]]);
  });

  test("no focused window: the first window with a visible tab", () => {
    const tabs = arrange([page("AAAAAAAAone", 7, false), page("BBBBBBBBtwo", 9, true)]);
    assert.equal(tabs.find((t) => t.active)?.targetId, "BBBBBBBBtwo");
  });

  test("tab ids are short target-id prefixes", () => assert.equal(tabId("F00DFACE1234"), "cf00dface"));

  test("evaluated values come back as text, like AppleScript's execute javascript", () => {
    assert.equal(asText(undefined), "");
    assert.equal(asText("x"), "x");
    assert.equal(asText(3), "3");
    assert.equal(asText([1, "a"]), '[1,"a"]');
  });

  test("browser from the window class (native, Flatpak, Snap)", () => {
    assert.equal(browserFromClass("google-chrome.Google-chrome"), "Google Chrome");
    assert.equal(browserFromClass("brave-browser.Brave-browser"), "Brave Browser");
    assert.equal(browserFromClass("chromium.Chromium"), "Chromium");
    assert.equal(browserFromClass("code.Code"), undefined);
  });
});
