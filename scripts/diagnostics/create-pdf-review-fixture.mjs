#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { exportArchive } from "../../bin/export-codex-project-chats.mjs";

const SESSION_ID = "99999999-9999-7999-8999-999999999999";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAGAAAAAwCAIAAABhdOiYAAABq0lEQVR4nO2b0W3DMAxEFaED3U7dIUN0h+ykZQr0ox8Fmq/INkmLR8GxeV8BAkvn5ztFjpPb989vSW2rCu+lSikfTwr4/EocndrjngnSlRWzVazL1ZWF19UmE6QoASlKQBcDhP8VhLhrqWelAxKj8wBCzF63npgOGMjqe60IqxLG909d32tFWKobuT3u3L1uFCAsiEQwWtLpXvjnDQGEDU9cRlt0uPPyAUH0zWKk0mEVjQwIa76XjJyYjNmhFI0JCNu+l2vnsGN7s+QDZwOCwbef0V46/qJxAMHs28NoLDvOohEAwXdVjaaHmyWPEw4I7qtqMe2k4ymaCxAcvu2MKNkZLto4ILh9WxixmiUPywcEkm95i8SlM3b4CCCwfa9GKSI7A0XbDQgxmZfrFvQwysJoHyBE+rbcMcTNQgCE+Ksad8+5NaYaIisgTMl8d3875zGvzKgeis5TE+jYB69HozNNxqLVa9LpJJxXvTKdZuiyBKi9fuNVzij1vJSKtYmfJseUvki3C9M5z6PnOCUgRQlIUQLa+SvX/EV5p0yQogSk6Jb/9pGVCSqy/gD5cfpUy6at1AAAAABJRU5ErkJggg==";
const JPEG = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAgAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDxeiiiv3g/FAooooAKKKKACiiigAooooAKKKKACiiigAooooA//9k=";

function readOutputDirectory(argv) {
  const index = argv.indexOf("--out");
  const value = index < 0 ? "" : argv[index + 1];
  if (!value || value.startsWith("-")) throw new Error("Usage: node scripts/diagnostics/create-pdf-review-fixture.mjs --out <new-directory>");
  return path.resolve(value);
}

const outputDirectory = readOutputDirectory(process.argv.slice(2));
if (await fs.lstat(outputDirectory).then(() => true, (error) => {
  if (error?.code === "ENOENT") return false;
  throw error;
})) throw new Error("The synthetic PDF review output directory must not already exist");
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-pdf-review-fixture-")));
try {
  const codexHome = path.join(temp, ".codex");
  const sessionDirectory = path.join(codexHome, "sessions", "2026", "08", "25");
  await fs.mkdir(sessionDirectory, { recursive: true });
  const records = [
    {
      type: "session_meta",
      timestamp: "2026-08-25T09:00:00.000Z",
      payload: {
        id: SESSION_ID,
        cwd: "C:\\Synthetic\\pdf-review",
        timestamp: "2026-08-25T09:00:00.000Z",
        source: "vscode",
        thread_source: "user",
      },
    },
    {
      type: "response_item",
      timestamp: "2026-08-25T09:00:01.000Z",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "# Manueller PDF-Abnahmetest\n\nUmlaute: Ä Ö Ü ä ö ü ß. XML-Sonderzeichen bleiben sichtbar: <tag> & \"Zitat\".\n\nGemeinsame Grundlinie: Aa→Bb ←Cc ↑Dd ↓Ee ✓Ff ⚠Gg ±Hh ≤Ii ≥Jj.\n\nSymbolfolge: → ← ↑ ↓ ✓ ⚠ ± ≤ ≥.\n\nLink: [OpenAI](https://openai.com/).\n\n- erster Listenpunkt → ✓\n- zweiter Listenpunkt ≤ ≥\n\n```js\nconst greeting = 'Grüße <&> aus Köln';\nconst symbols = '→ ← ↑ ↓ ✓ ⚠ ± ≤ ≥';\nconsole.log(greeting, symbols);\n```",
          },
          { type: "input_image", image_url: `data:image/png;base64,${PNG}` },
          { type: "input_image", image_url: `data:image/jpeg;base64,${JPEG}` },
          { type: "input_image", image_url: `data:application/octet-stream;base64,${Buffer.from("synthetic non-renderable attachment", "utf8").toString("base64")}` },
        ],
        internal_chat_message_metadata_passthrough: { turn_id: "synthetic-turn-1" },
      },
    },
    {
      type: "response_item",
      timestamp: "2026-08-25T09:00:02.000Z",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Zweite Nachricht zur Kontrolle der Rollen- und Nachrichtenreihenfolge." }] },
    },
  ];
  const sessionFile = path.join(sessionDirectory, `rollout-2026-08-25T09-00-00-${SESSION_ID}.jsonl`);
  await fs.writeFile(sessionFile, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, { encoding: "utf8", flag: "wx" });
  const result = await exportArchive({ codexHome, scope: "all", outputDirectory, exportProfile: "readable", documentFormats: ["pdf"] });
  const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
  const pdfRelative = manifest.sessions[0]?.pdf_file;
  if (manifest.sessions.length !== 1 || !pdfRelative) throw new Error("Synthetic fixture export did not produce exactly one PDF");
  process.stdout.write(`${path.join(outputDirectory, ...pdfRelative.split("/"))}\n`);
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
