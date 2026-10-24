// Settings → Usage (ResourceUsage.swift): ps parsed, each process grouped under its nearest labeled ancestor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diskUsage, groupProcesses, parsePs, pathSize, processLabel } from "../../src/main/features/resources";

const PS = `
    1     0  0.0  9000 /sbin/init
  100     1  4.0 200000 /opt/VisionCLI/visioncli
  101   100  1.0 50000 /opt/VisionCLI/visioncli --type=zygote
  102   101  2.5 80000 /opt/VisionCLI/visioncli --type=renderer
  110   100  0.0  3000 /usr/bin/uv run --quiet --with kokoro-onnx python /opt/VisionCLI/resources/assets/kokoro_server.py model voices out
  111   110 12.0 400000 /home/u/.cache/uv/python3 /opt/VisionCLI/resources/assets/kokoro_server.py model voices out
  120   100 30.0 600000 /home/u/.config/visioncli/models/whisper-server -m ggml-small.en.bin --host 127.0.0.1
  130   100  0.5  1000 spd-say -w hello
  200     1  1.0 90000 claude
  201   200  0.2 60000 node /home/u/.local/lib/visioncli/build/server/index.mjs
  202     1  0.1 40000 /opt/VisionCLI/visioncli /home/u/.local/lib/visioncli/build/server/index.mjs browserd
  300     1 50.0 900000 /usr/bin/firefox
`;

test("usage: process labels", () => {
  assert.equal(processLabel("python kokoro_server.py"), "Kokoro voice");
  assert.equal(processLabel("sherpa-onnx-offline-websocket-server --port 1"), "Parakeet speech model");
  assert.equal(processLabel("node C:\\x\\server\\index.mjs browserd"), "Browser control");
  assert.equal(processLabel("node C:\\x\\server\\index.mjs"), "VisionCLI tools (MCP server)");
  assert.equal(processLabel("bash"), null);
});

test("usage: ps grouped by label, summed, most memory first", () => {
  const rows = parsePs(PS);
  assert.equal(rows.length, 12);
  assert.deepEqual(rows[4], { pid: 110, ppid: 100, cpu: 0, rss: 3000 * 1024, args: "/usr/bin/uv run --quiet --with kokoro-onnx python /opt/VisionCLI/resources/assets/kokoro_server.py model voices out" });
  const groups = groupProcesses(rows, new Set([100, 101, 102]));
  assert.deepEqual(groups.map((g) => [g.name, g.count, g.cpu, g.memory / 1024]), [
    ["Whisper speech model", 1, 30, 600000],
    ["Kokoro voice", 2, 12, 403000],
    ["VisionCLI app", 3, 7.5, 330000],
    ["VisionCLI tools (MCP server)", 1, 0.2, 60000],
    ["Browser control", 1, 0.1, 40000],
    ["VisionCLI app (helpers)", 1, 0.5, 1000],
  ]);
});

test("usage: no CPU figure (Windows) stays null", () => {
  const g = groupProcesses([{ pid: 5, ppid: 4, cpu: null, rss: 10, args: "whisper-server.exe -m x" }], new Set());
  assert.deepEqual(g, [{ name: "Whisper speech model", cpu: null, memory: 10, count: 1 }]);
});

test("usage: disk sizes of files and folders, empty ones left out", () => {
  const dir = mkdtempSync(join(tmpdir(), "vcli-usage-"));
  mkdirSync(join(dir, "a/b"), { recursive: true });
  writeFileSync(join(dir, "a/one"), "x".repeat(10));
  writeFileSync(join(dir, "a/b/two"), "x".repeat(5));
  writeFileSync(join(dir, "log"), "x".repeat(3));
  assert.equal(pathSize(join(dir, "a")), 15);
  assert.equal(pathSize(join(dir, "missing")), 0);
  assert.deepEqual(diskUsage([["Models", [join(dir, "a")]], ["Logs", [join(dir, "log"), join(dir, "log.1")]], ["None", [join(dir, "nope")]]]), [
    { name: "Models", path: join(dir, "a"), bytes: 15 },
    { name: "Logs", path: join(dir, "log"), bytes: 3 },
  ]);
});
