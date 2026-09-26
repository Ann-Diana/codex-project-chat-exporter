import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import dns from "node:dns";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

import JSZip from "jszip";
import xmlJs from "xml-js";
import { fromMarkdown } from "mdast-util-from-markdown";
import { Marked } from "marked";

import { buildVsix, resolveCheckedOutCommit, transformPackagedReadme, validateSourceCommit, verifyReadmeRendererAgreement } from "../scripts/build-vsix.mjs";

const require = createRequire(import.meta.url);
const { xml2js } = xmlJs;
const FIXED_DATE = "2000-01-01T00:00:00.000Z";
const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(extensionRoot, "..", "..");
const EXPECTED_SOURCE_REF = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: repoRoot, encoding: "utf8", windowsHide: true }).trim();
const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const ONE_PIXEL_PNG_SHA256 = "431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460";
const PACKAGED_PARENT_PROJECT = process.platform === "win32" ? "C:\\Synthetic\\parent" : "/synthetic/parent";
const PACKAGED_CHILD_PROJECT = process.platform === "win32" ? "C:\\Synthetic\\link-check" : "/synthetic/link-check";
const PACKAGED_MISSING_PROJECT = process.platform === "win32" ? "C:\\Synthetic\\renamed" : "/synthetic/renamed";
const PACKAGED_README_REPOSITORY_URL = "https://github.com/Ann-Diana/codex-project-chat-exporter";
const SUPPORT_ISSUES_URL = "https://github.com/Ann-Diana/codex-project-chat-exporter/issues";
const SUPPORT_ISSUES_LINK_PREFIX = "- [Support and bug reports: GitHub Issues](";
const PACKAGED_README_TRANSFORMATIONS = [
  {
    source: 'src="images/codex-project-chat-exporter-hero.png"',
    packaged: `src="${PACKAGED_README_REPOSITORY_URL}/raw/${EXPECTED_SOURCE_REF}/integrations/vscode/images/codex-project-chat-exporter-hero.png"`,
    expectedOccurrences: 1,
  },
  ...[
    "01-scope-picker.png",
    "02-project-history-picker.png",
    "03-document-format-picker.png",
    "04-export-success.png",
  ].map((name) => ({
    source: `](images/${name})`,
    packaged: `](${PACKAGED_README_REPOSITORY_URL}/raw/${EXPECTED_SOURCE_REF}/integrations/vscode/images/${name})`,
    expectedOccurrences: 1,
  })),
  {
    source: "](LICENSE)",
    packaged: `](${PACKAGED_README_REPOSITORY_URL}/blob/${EXPECTED_SOURCE_REF}/integrations/vscode/LICENSE)`,
    expectedOccurrences: 2,
  },
  {
    source: "](PACKAGED_TEST_PLAN.md)",
    packaged: `](${PACKAGED_README_REPOSITORY_URL}/blob/${EXPECTED_SOURCE_REF}/integrations/vscode/PACKAGED_TEST_PLAN.md)`,
    expectedOccurrences: 1,
  },
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function markdownLinkTargets(text) {
  const targets = [];
  const visit = (node) => {
    if (["link", "image", "definition"].includes(node.type)) targets.push(node.url);
    for (const child of node.children || []) visit(child);
  };
  visit(fromMarkdown(text));
  return targets;
}

function assertSupportIssuesLink(readme) {
  const lines = readme.split(/\r?\n/).filter((line) => line.startsWith(SUPPORT_ISSUES_LINK_PREFIX));
  assert.equal(lines.length, 1, "support link must appear exactly once");
  const targets = markdownLinkTargets(lines[0]);
  assert.equal(targets.length, 1, "support line must contain exactly one Markdown link");
  assert.equal(lines[0], `${SUPPORT_ISSUES_LINK_PREFIX}${targets[0]})`);
  const parsed = new URL(targets[0]);
  assert.equal(parsed.href, SUPPORT_ISSUES_URL);
  assert.equal(targets[0], SUPPORT_ISSUES_URL);
}

function htmlImageSources(text) {
  const sources = [];
  let cursor = 0;
  while (cursor < text.length) {
    const imageStart = text.indexOf("<img", cursor);
    if (imageStart < 0) break;
    const imageEnd = text.indexOf(">", imageStart + 4);
    if (imageEnd < 0) break;
    const sourceStart = text.indexOf('src="', imageStart + 4);
    if (sourceStart >= 0 && sourceStart < imageEnd) {
      const valueStart = sourceStart + 'src="'.length;
      const valueEnd = text.indexOf('"', valueStart);
      if (valueEnd >= 0 && valueEnd < imageEnd) sources.push(text.slice(valueStart, valueEnd));
    }
    cursor = imageEnd + 1;
  }
  return sources;
}

function isAllowedAbsoluteHttpsUrl(target, allowedHostname) {
  const authorityStart = "https://".length;
  if (!target.startsWith("https://") || target.length === authorityStart || "/?#".includes(target[authorityStart])) return false;
  try {
    const url = new URL(target);
    return url.protocol === "https:"
      && url.hostname === allowedHostname
      && url.username === ""
      && url.password === ""
      && url.port === "";
  } catch {
    return false;
  }
}

function assertPackagedReadmeTargets(readme) {
  const targets = [...markdownLinkTargets(readme), ...htmlImageSources(readme)];
  for (const rawTarget of targets) {
    const target = rawTarget.startsWith("<") && rawTarget.endsWith(">") ? rawTarget.slice(1, -1) : rawTarget;
    if (!target || target.startsWith("#")) continue;
    assert.equal(
      isAllowedAbsoluteHttpsUrl(target, "github.com") || isAllowedAbsoluteHttpsUrl(target, "img.shields.io")
        || isAllowedAbsoluteHttpsUrl(target, "marketplace.visualstudio.com"),
      true,
      `packaged README target is not a permitted absolute HTTPS URL: ${target}`,
    );
  }
}

function literalOccurrenceCount(text, needle) {
  let count = 0;
  let cursor = 0;
  while (cursor <= text.length - needle.length) {
    const index = text.indexOf(needle, cursor);
    if (index < 0) break;
    count += 1;
    cursor = index + needle.length;
  }
  return count;
}

function expectedPackagedReadme(sourceReadme) {
  let expected = sourceReadme;
  for (const { source, packaged, expectedOccurrences } of PACKAGED_README_TRANSFORMATIONS) {
    assert.equal(literalOccurrenceCount(expected, source), expectedOccurrences, source);
    expected = expected.replaceAll(source, packaged);
  }
  for (const file of ["FAQ.md", "SECURITY.md", "docs/archive-format-v1.md"]) {
    expected = expected.replace(`${PACKAGED_README_REPOSITORY_URL}/blob/main/${file}`, `${PACKAGED_README_REPOSITORY_URL}/blob/${EXPECTED_SOURCE_REF}/${file}`);
  }
  expected = expected.replace(`${PACKAGED_README_REPOSITORY_URL}#readme`, `${PACKAGED_README_REPOSITORY_URL}/tree/${EXPECTED_SOURCE_REF}#readme`);
  return expected;
}

function pinnedReadmeLinks(readme) {
  const pinned = [];
  for (const target of [...htmlImageSources(readme), ...markdownLinkTargets(readme)]) {
    if (!target || target.startsWith("#")) continue;
    const url = new URL(target);
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.hostname === "github.com" && parts[0] === "Ann-Diana" && parts[1] === "codex-project-chat-exporter"
      && ["raw", "blob", "tree"].includes(parts[2])) {
      assert.equal(url.protocol, "https:");
      assert.equal(url.username, "");
      assert.equal(url.password, "");
      assert.equal(url.port, "");
      assert.equal(url.search, "");
      assert.equal(url.hash, parts[2] === "tree" ? "#readme" : "");
      pinned.push(url);
    }
  }
  return pinned;
}

function assertAllPinnedReadmeLinks(readme) {
  const pinned = pinnedReadmeLinks(readme);
  const imageRoot = `${PACKAGED_README_REPOSITORY_URL}/raw/${EXPECTED_SOURCE_REF}/integrations/vscode/images/`;
  const documentRoot = `${PACKAGED_README_REPOSITORY_URL}/blob/${EXPECTED_SOURCE_REF}/integrations/vscode/`;
  const expected = [
    `${imageRoot}codex-project-chat-exporter-hero.png`,
    `${imageRoot}01-scope-picker.png`,
    `${imageRoot}02-project-history-picker.png`,
    `${imageRoot}03-document-format-picker.png`,
    `${imageRoot}04-export-success.png`,
    `${documentRoot}LICENSE`,
    `${documentRoot}LICENSE`,
    `${documentRoot}PACKAGED_TEST_PLAN.md`,
    `${PACKAGED_README_REPOSITORY_URL}/blob/${EXPECTED_SOURCE_REF}/FAQ.md`,
    `${PACKAGED_README_REPOSITORY_URL}/blob/${EXPECTED_SOURCE_REF}/SECURITY.md`,
    `${PACKAGED_README_REPOSITORY_URL}/blob/${EXPECTED_SOURCE_REF}/docs/archive-format-v1.md`,
    `${PACKAGED_README_REPOSITORY_URL}/tree/${EXPECTED_SOURCE_REF}#readme`,
  ];
  assert.equal(pinned.length, 12);
  assert.ok(pinned.every((url) => url.pathname.split("/")[4] === EXPECTED_SOURCE_REF), "no old, moving or alternate ref is permitted");
  assert.deepEqual(pinned.map((url) => url.href).sort(), expected.sort());
  assert.equal(pinned.some((url) => url.pathname.split("/")[4] === "c0d31b9712edfa577ea3276254e941651e7badfd"), false);
}

test("source commit resolution rejects missing Git context and malformed SHA output", async () => {
  const valid = "a".repeat(40);
  assert.equal(validateSourceCommit(` \r\n${valid}\n `), valid);
  for (const invalid of [undefined, "", "main", "a".repeat(39), "a".repeat(41), "A".repeat(40), "g".repeat(40), `${valid}\n${valid}`, `refs/heads/${valid}`]) {
    assert.throws(() => validateSourceCommit(invalid), /full lowercase 40-character SHA-1/);
  }
  assert.equal(await resolveCheckedOutCommit(repoRoot), EXPECTED_SOURCE_REF);
  await assert.rejects(() => resolveCheckedOutCommit(extensionRoot), /Cannot determine the VSIX source commit/);
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "packaged-vsix-git-context-")));
  try {
    await assert.rejects(() => resolveCheckedOutCommit(temp), /Cannot determine the VSIX source commit/);
    execFileSync("git", ["init", "--quiet"], { cwd: temp, windowsHide: true });
    await assert.rejects(() => resolveCheckedOutCommit(temp), /Cannot determine the VSIX source commit/);
    commitGitFixture(temp, "first");
    const first = await resolveCheckedOutCommit(temp);
    commitGitFixture(temp, "second");
    const second = await resolveCheckedOutCommit(temp);
    assert.notEqual(first, second, "the source ref must follow the actual checkout HEAD");
    const readme = await fs.readFile(path.join(extensionRoot, "README.md"), "utf8");
    const links = pinnedReadmeLinks(transformPackagedReadme(readme, second));
    assert.equal(links.length, 12);
    assert.ok(links.every((url) => url.pathname.split("/")[4] === second));
    assert.ok(links.every((url) => url.pathname.split("/")[4] !== first));
    execFileSync("git", ["checkout", "--quiet", "--detach", first], { cwd: temp, windowsHide: true });
    assert.equal(await resolveCheckedOutCommit(temp), first, "detached HEAD is the actual build source");
    const worktree = path.join(temp, "linked-checkout");
    execFileSync("git", ["worktree", "add", "--quiet", "--detach", worktree, second], { cwd: temp, windowsHide: true });
    assert.equal(await resolveCheckedOutCommit(worktree), second, "a linked worktree must resolve its own HEAD");
    assert.ok(pinnedReadmeLinks(transformPackagedReadme(readme, await resolveCheckedOutCommit(worktree)))
      .every((url) => url.pathname.split("/")[4] === second));
    execFileSync("git", ["checkout", "--quiet", "-b", "merge-proof", second], { cwd: temp, windowsHide: true });
    execFileSync("git", ["checkout", "--quiet", "-b", "incoming", first], { cwd: temp, windowsHide: true });
    commitGitFixture(temp, "incoming");
    execFileSync("git", ["checkout", "--quiet", "merge-proof"], { cwd: temp, windowsHide: true });
    execFileSync("git", ["-c", "user.name=VSIX Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "merge", "--quiet", "--no-ff", "-m", "merge proof", "incoming"], { cwd: temp, windowsHide: true });
    const merged = await resolveCheckedOutCommit(temp);
    assert.notEqual(merged, first); assert.notEqual(merged, second);
    assert.ok(pinnedReadmeLinks(transformPackagedReadme(readme, merged)).every((url) => url.pathname.split("/")[4] === merged), "a subsequent merge uses its actual commit, never a configured SHA");
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("packaged README GitHub URL validation uses an exact HTTPS hostname and fails closed", () => {
  const cases = [
    ["https://github.com/Ann-Diana/codex-project-chat-exporter", true],
    ["https://github.com.evil.example/path", false],
    ["https://example.test/?next=github.com", false],
    ["http://github.com/path", false],
    ["https://[invalid", false],
    ["https:github.com/path", false],
    ["https:///github.com/path", false],
    ["https://github.com@evil.example/path", false],
    ["https://evil.example@github.com/path", false],
  ];
  for (const [target, expected] of cases) {
    assert.equal(isAllowedAbsoluteHttpsUrl(target, "github.com"), expected, target);
  }
  assert.equal(isAllowedAbsoluteHttpsUrl("https://marketplace.visualstudio.com/items?itemName=ann-diana.codex-project-chat-exporter-vscode", "marketplace.visualstudio.com"), true);
  assert.equal(isAllowedAbsoluteHttpsUrl("https://marketplace.visualstudio.com.evil.example/items", "marketplace.visualstudio.com"), false);
});

test("packaged README support link rejects host, path, query and fragment lookalikes", async () => {
  const sourceReadme = await fs.readFile(path.join(extensionRoot, "README.md"), "utf8");
  const packagedReadme = transformPackagedReadme(sourceReadme, EXPECTED_SOURCE_REF);
  assertSupportIssuesLink(packagedReadme);
  const expectedLink = `${SUPPORT_ISSUES_LINK_PREFIX}${SUPPORT_ISSUES_URL})`;
  for (const [kind, foreignUrl] of [
    ["host", "https://github.com.evil.example/Ann-Diana/codex-project-chat-exporter/issues"],
    ["path", `https://evil.example/path/${SUPPORT_ISSUES_URL}`],
    ["query", `https://evil.example/?next=${SUPPORT_ISSUES_URL}`],
    ["fragment", `https://evil.example/#${SUPPORT_ISSUES_URL}`],
    ["same-host path", `https://github.com/other/${SUPPORT_ISSUES_URL}`],
    ["same-host query", `${SUPPORT_ISSUES_URL}?next=${SUPPORT_ISSUES_URL}`],
    ["same-host fragment", `${SUPPORT_ISSUES_URL}#${SUPPORT_ISSUES_URL}`],
  ]) {
    const altered = packagedReadme.replace(expectedLink, `${SUPPORT_ISSUES_LINK_PREFIX}${foreignUrl})`);
    assert.notEqual(altered, packagedReadme, kind);
    assert.throws(() => assertSupportIssuesLink(altered), (error) => error?.code === "ERR_ASSERTION" && error.expected === SUPPORT_ISSUES_URL, kind);
  }
});

test("packaged README transformation is exact, HEAD-bound and fails closed", async () => {
  const sourceReadme = await fs.readFile(path.join(extensionRoot, "README.md"), "utf8");
  assert.match(EXPECTED_SOURCE_REF, /^[0-9a-f]{40}$/);
  assert.equal(
    sourceReadme.includes('code --install-extension "C:\\path\\to\\codex-project-chat-exporter-vscode-<version>.vsix" --force'),
    false,
  );
  assert.equal(transformPackagedReadme(sourceReadme, EXPECTED_SOURCE_REF), expectedPackagedReadme(sourceReadme));
  assertAllPinnedReadmeLinks(transformPackagedReadme(sourceReadme, EXPECTED_SOURCE_REF));

  const missingHero = sourceReadme.replace(
    'src="images/codex-project-chat-exporter-hero.png"',
    'src="https://example.invalid/missing-hero.png"',
  );
  assert.throws(() => transformPackagedReadme(missingHero, EXPECTED_SOURCE_REF), /Expected 1 VSIX README occurrence/);
  assert.throws(
    () => transformPackagedReadme(`${sourceReadme}\n![duplicate](images/01-scope-picker.png)\n`, EXPECTED_SOURCE_REF),
    /Expected 1 VSIX README occurrence/,
  );
  assert.throws(
    () => transformPackagedReadme(`${sourceReadme}\n[unexpected](EXTRA.md)\n`, EXPECTED_SOURCE_REF),
    /Unmapped relative VSIX README target/,
  );
});

test("all repository content URL forms bind paths structurally while preserving encoded suffixes", async () => {
  const readme = await fs.readFile(path.join(extensionRoot, "README.md"), "utf8");
  const base = PACKAGED_README_REPOSITORY_URL;
  const otherCommit = "b".repeat(40);
  const cases = [
    ...["FAQ.md", "SECURITY.md", "docs/archive-format-v1.md", "new/future-file.md"].map((file) => [`${base}/blob/main/${file}`, `${base}/blob/${EXPECTED_SOURCE_REF}/${file}`]),
    [`${base}/raw/main/images/new.svg`, `${base}/raw/${EXPECTED_SOURCE_REF}/images/new.svg`],
    [`${base}/tree/main/docs`, `${base}/tree/${EXPECTED_SOURCE_REF}/docs`],
    [`${base}/tree/main/docs/`, `${base}/tree/${EXPECTED_SOURCE_REF}/docs/`],
    [`${base}/blob/${otherCommit}/README.md`, `${base}/blob/${EXPECTED_SOURCE_REF}/README.md`],
    [`https://raw.githubusercontent.com/Ann-Diana/codex-project-chat-exporter/main/images/new.svg`, `https://raw.githubusercontent.com/Ann-Diana/codex-project-chat-exporter/${EXPECTED_SOURCE_REF}/images/new.svg`],
    [`${base}/blob/main/docs/a%20b%23%3F%25%2B%C3%A4.md?raw=1&name=a%2Bb+main&next=%2Fmain#section-main%20%C3%A4`, `${base}/blob/${EXPECTED_SOURCE_REF}/docs/a%20b%23%3F%25%2B%C3%A4.md?raw=1&name=a%2Bb+main&next=%2Fmain#section-main%20%C3%A4`],
    [`${base}/blob/main/docs/name(1).md?value=(main)#part(2)`, `${base}/blob/${EXPECTED_SOURCE_REF}/docs/name(1).md?value=(main)#part(2)`],
    [`${base}/blob/main/docs/ä.md?name=ä#ä`, `${base}/blob/${EXPECTED_SOURCE_REF}/docs/%C3%A4.md?name=%C3%A4#%C3%A4`],
    [`${base}#readme`, `${base}/tree/${EXPECTED_SOURCE_REF}#readme`],
  ];
  for (const [source, expected] of cases) {
    const result = transformPackagedReadme(`${readme}\n[probe](${source})`, EXPECTED_SOURCE_REF);
    const line = result.split("\n").at(-1);
    assert.equal(line.slice(0, 8), "[probe]("); assert.equal(line.at(-1), ")");
    const actualUrl = new URL(markdownLinkTargets(line)[0]), expectedUrl = new URL(expected);
    for (const key of ["protocol", "hostname", "username", "password", "port", "pathname", "search", "hash"]) assert.equal(actualUrl[key], expectedUrl[key], `${source}: ${key}`);
    assert.equal(actualUrl.href, expected);
  }
});

test("external URLs and deliberately live services are unchanged even with main or repository decoys", async () => {
  const readme = await fs.readFile(path.join(extensionRoot, "README.md"), "utf8");
  const base = PACKAGED_README_REPOSITORY_URL;
  const targets = [
    base, `${base}/`, ...["issues", "pull/13", "pulls", "actions/workflows/test.yml", "releases/tag/v0.4.0", "discussions", "security"].map((route) => `${base}/${route}?ref=main#main`),
    "https://marketplace.visualstudio.com/items?itemName=ann-diana.codex-project-chat-exporter-vscode",
    "https://img.shields.io/github/actions/workflow/status/Ann-Diana/codex-project-chat-exporter/test.yml?branch=main",
    `${base}/issues?next=${base}/blob/main/FAQ.md#main`,
    `https://example.test/?next=${base}/blob/main/FAQ.md#main`,
    `https://example.test/#${base}/blob/main/FAQ.md`,
    "https://main.example.test/Ann-Diana/codex-project-chat-exporter/blob/main/FAQ.md",
    "https://github.com.evil.example/Ann-Diana/codex-project-chat-exporter/blob/main/FAQ.md",
    "https://github.com@evil.example/Ann-Diana/codex-project-chat-exporter/blob/main/FAQ.md",
    "https://github.com/other/repository/blob/main/FAQ.md", "http://example.test/main?ref=main#main", "mailto:info@example.test", "#main",
  ];
  for (const target of targets) {
    const result = transformPackagedReadme(`${readme}\n[probe](${target})`, EXPECTED_SOURCE_REF);
    const actual = result.split("\n").at(-1).slice(8, -1);
    assert.equal(actual, target);
    if (!target.startsWith("#")) assert.deepEqual(new URL(actual), new URL(target));
  }
});

test("reference and quoted HTML destinations are bound without corrupting URL encoding", async () => {
  const readme = await fs.readFile(path.join(extensionRoot, "README.md"), "utf8");
  const url = `${PACKAGED_README_REPOSITORY_URL}/blob/main/docs/a%20b.md?x=1&y=%26#main`;
  const expected = new URL(url); expected.pathname = `/Ann-Diana/codex-project-chat-exporter/blob/${EXPECTED_SOURCE_REF}/docs/a%20b.md`;
  for (const [input, extract] of [
    [`[probe](<${url}> "title")`, (line) => markdownLinkTargets(line)[0]],
    [`[ref]: <${url}> "title"`, (line) => markdownLinkTargets(line)[0]],
    [`<a href='${url.replaceAll("&", "&amp;")}' title="main">`, (line) => xml2js(line.slice(0, -1) + "/>", { compact: true }).a._attributes.href],
    [`<a href="${url}">`, (line) => xml2js(line.slice(0, -1) + "/>", { compact: true }).a._attributes.href],
    [`<img src="${url.replaceAll("&", "&amp;")}" alt='literal href="main"'>`, (line) => xml2js(line.slice(0, -1) + "/>", { compact: true }).img._attributes.src],
  ]) {
    const result = transformPackagedReadme(`${readme}\n${input}`, EXPECTED_SOURCE_REF);
    assert.equal(new URL(extract(result.split("\n").at(-1))).href, expected.href);
  }
  const external = '<a href="https://example.test/?a=1&b=main">';
  assert.equal(transformPackagedReadme(`${readme}\n${external}`, EXPECTED_SOURCE_REF).split("\n").at(-1), external);
  const entities = `<a href="${PACKAGED_README_REPOSITORY_URL}/blob/main/FAQ.md?q=&quot;A&quot;&amp;v=&#x2B;#main">`;
  const bound = transformPackagedReadme(`${readme}\n${entities}`, EXPECTED_SOURCE_REF).split("\n").at(-1);
  const parsed = new URL(xml2js(bound.slice(0, -1) + "/>", { compact: true }).a._attributes.href);
  assert.equal(parsed.pathname, `/Ann-Diana/codex-project-chat-exporter/blob/${EXPECTED_SOURCE_REF}/FAQ.md`);
  assert.equal(parsed.search, "?q=%22A%22&v=+"); assert.equal(parsed.hash, "#main");
  assert.throws(() => transformPackagedReadme(`${readme}\n<a href="${url}&unknown=&bogus;">`, EXPECTED_SOURCE_REF), /entity/);
});

test("approved relative README files retain query, fragment and HTML entity semantics", async () => {
  const readme = await fs.readFile(path.join(extensionRoot, "README.md"), "utf8");
  const changed = readme
    .replace('src="images/codex-project-chat-exporter-hero.png"', 'src="images/codex-project-chat-exporter-hero.png?x=1&amp;y=%26#main"')
    .replace("](LICENSE)", "](LICENSE?download=a%2Bb+main#license%20%C3%A4)");
  const result = transformPackagedReadme(changed, EXPECTED_SOURCE_REF);
  const image = xml2js(result.slice(result.indexOf("<img"), result.indexOf(">", result.indexOf("<img"))) + "/>", { compact: true });
  const imageUrl = new URL(image.img._attributes.src);
  assert.equal(imageUrl.pathname, `/Ann-Diana/codex-project-chat-exporter/raw/${EXPECTED_SOURCE_REF}/integrations/vscode/images/codex-project-chat-exporter-hero.png`);
  assert.equal(imageUrl.search, "?x=1&y=%26"); assert.equal(imageUrl.hash, "#main");
  const license = markdownLinkTargets(result).map((target) => new URL(target, "https://anchor.invalid")).find((url) => url.searchParams.has("download"));
  assert.equal(license.pathname, `/Ann-Diana/codex-project-chat-exporter/blob/${EXPECTED_SOURCE_REF}/integrations/vscode/LICENSE`);
  assert.equal(license.search, "?download=a%2Bb+main"); assert.equal(license.hash, "#license%20%C3%A4");
});

test("unknown or ambiguous own-repository URLs fail closed instead of guessing ref boundaries", async () => {
  const readme = await fs.readFile(path.join(extensionRoot, "README.md"), "utf8");
  const base = PACKAGED_README_REPOSITORY_URL;
  for (const target of [
    `${base}/unknown/main/FAQ.md`, `${base}/blob/feature/branch/FAQ.md`, `${base}/blob/v0.4.0/FAQ.md`, `${base}/blob?ref=main`, `${base}/blob/main`, `${base}/blob/main//FAQ.md`,
    `${base}/blob/main/../FAQ.md`, `${base}/blob/main/%2e%2e/FAQ.md`, `${base}/blob/main/docs%2fFAQ.md`, `${base}/blob/main/docs%5cFAQ.md`, `${base}/blob/main/%00FAQ.md`, `${base}/blob/main/%GG.md`,
    "https://github.com/Ann-Diana%2fcodex-project-chat-exporter/blob/main/FAQ.md",
    `${base}/blob/main\\FAQ.md`, "https://user:password@github.com/Ann-Diana/codex-project-chat-exporter/blob/main/FAQ.md",
    "https://github.com:444/Ann-Diana/codex-project-chat-exporter/blob/main/FAQ.md", base.replace("https:", "http:") + "/blob/main/FAQ.md",
    "https://github.com./Ann-Diana/codex-project-chat-exporter/blob/main/FAQ.md", "https://www.github.com/Ann-Diana/codex-project-chat-exporter/blob/main/FAQ.md",
    "https:github.com/Ann-Diana/codex-project-chat-exporter/blob/main/FAQ.md",
    "https://raw.githubusercontent.com/Ann-Diana/codex-project-chat-exporter/feature/branch/FAQ.md",
  ]) assert.throws(() => transformPackagedReadme(`${readme}\n[probe](${target})`, EXPECTED_SOURCE_REF), /VSIX README|URL encoding/, target);
  assert.throws(() => transformPackagedReadme(`${readme}\n<a href="${base}/blob/main/FAQ.md" href="${base}/blob/main/SECURITY.md">`, EXPECTED_SOURCE_REF), /Duplicate/);
  for (const suffix of [
    `${base}/blob/main/FAQ.md`,
    `> [quoted-ref]: ${base}/blob/main/FAQ.md`,
    `[unclosed](${base}/blob/main/FAQ.md`,
    `<a href="${base}/blob/main/FAQ.md"`,
  ]) assert.throws(() => transformPackagedReadme(`${readme}\n${suffix}`, EXPECTED_SOURCE_REF), /VSIX README/);
});

test("the builder cleans its stage and produces no package for an ambiguous repository README URL", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "packaged-vsix-ambiguous-readme-")));
  try {
    const fixture = path.join(temp, "extension"); await copyExtensionFixture(fixture);
    await fs.appendFile(path.join(fixture, "README.md"), `\n[ambiguous](${PACKAGED_README_REPOSITORY_URL}/blob/feature/branch/FAQ.md)\n`);
    const distDir = path.join(temp, "dist");
    await assert.rejects(() => buildVsix({ extensionRoot: fixture, distDir }), /Ambiguous or unsupported VSIX README repository URL/);
    assert.deepEqual(await fs.readdir(distDir), []);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test("R-01 parser semantics bind numeric, named and escaped Markdown targets exactly once", async () => {
  const readme = await fs.readFile(path.join(extensionRoot, "README.md"), "utf8");
  const base = PACKAGED_README_REPOSITORY_URL;
  const semantic = `${base}/blob/main/FAQ.md`;
  const expected = `${base}/blob/${EXPECTED_SOURCE_REF}/FAQ.md`;
  const spellings = [
    semantic.replace("Ann-Diana", "Ann&#45;Diana"),
    semantic.replace("Ann-Diana", "Ann&#x2D;Diana"),
    semantic.replace("Ann-Diana", "Ann&#X2d;Diana"),
    semantic.replace("github.com", "github&#46;com"),
    semantic.replace("github.com", "git&#x68;ub.com"),
    semantic.replace("github.com", "github&period;com"),
    semantic.replace("codex-project", "codex&#45;project").replace("main", "m&#97;in"),
    semantic.replace("https://", "https&colon;&sol;&sol;").replace("/FAQ.md", "&sol;FAQ.md"),
    semantic.replace("Ann-Diana", String.raw`Ann\-Diana`),
    semantic.replace("https:", String.raw`https\:`).replace("github.com", String.raw`github\.com`),
    semantic.replace("Ann-Diana", String.raw`Ann\-Diana`).replace("github.com", "github&#x2E;com"),
  ];
  for (const spelling of spellings) {
    for (const snippet of [
      `[probe](${spelling} "unchanged title")`, `[probe](<${spelling}>)`, `![probe](${spelling})`,
      `[probe][r01]\n\n[r01]: <${spelling}> "unchanged title"`,
      `![r01][]\n\n[r01]: ${spelling}`, `[r01]\n\n[r01]: ${spelling}`,
    ]) {
      assert.deepEqual(markdownLinkTargets(snippet), [semantic], snippet);
      const output = transformPackagedReadme(`${readme}\n\n${snippet}`, EXPECTED_SOURCE_REF);
      assert.equal(markdownLinkTargets(output).at(-1), expected, snippet);
      assert.equal(new URL(markdownLinkTargets(output).at(-1)).pathname.split("/")[4], EXPECTED_SOURCE_REF);
    }
  }
});

test("R-01 entity suffixes, delimiters, titles and repeated source ranges survive reparsing", async () => {
  const readme = await fs.readFile(path.join(extensionRoot, "README.md"), "utf8");
  const base = PACKAGED_README_REPOSITORY_URL;
  const cases = [
    [`${base}/blob/main/a\\(1\\).md?q=&NotEqualTilde;&amp;v=&#43;#&#x3B1;`, `${base}/blob/main/a(1).md?q=≂̸&v=+#α`],
    [`${base}/blob/main/FAQ.md?q=&amp;copy;&amp;d=&amp;#45;#&amp;period;`, `${base}/blob/main/FAQ.md?q=&copy;&d=&#45;#&period;`],
    [`${base}/blob/main/FAQ.md?q=&bogus;&amp;unfinished=&#xZZ;#&incomplete`, `${base}/blob/main/FAQ.md?q=&bogus;&unfinished=&#xZZ;#&incomplete`],
    [`${base}/blob/main/FAQ.md?q=&#x3c;x&#x3e;#&#x22;`, `${base}/blob/main/FAQ.md?q=<x>#"`],
  ];
  for (const [spelling, semantic] of cases) {
    const snippet = `[probe](<${spelling}> 'a &quot;title&quot;')`;
    assert.equal(markdownLinkTargets(snippet)[0], semantic);
    const expected = new URL(semantic); expected.pathname = expected.pathname.replace("/main/", `/${EXPECTED_SOURCE_REF}/`);
    const output = transformPackagedReadme(`${readme}\n\n${snippet}\n\n${snippet}`, EXPECTED_SOURCE_REF);
    const actual = markdownLinkTargets(output).slice(-2);
    assert.deepEqual(actual.map((value) => new URL(value).href), [expected.href, expected.href]);
    assert.equal(fromMarkdown(output).children.at(-1).children[0].title, 'a "title"');
  }
  const code = `\n\n\`\`\`md\n[not a link](${base}/blob/main/FAQ.md)\n\`\`\`\n`;
  assert.equal(transformPackagedReadme(readme + code, EXPECTED_SOURCE_REF), transformPackagedReadme(readme, EXPECTED_SOURCE_REF) + code);
});

test("R-01 external and live spellings remain byte-exact without recursive decoding", async () => {
  const readme = await fs.readFile(path.join(extensionRoot, "README.md"), "utf8");
  const base = PACKAGED_README_REPOSITORY_URL;
  for (const spelling of [
    "https://example&period;test/?q=&copy;#&#45;",
    "https://example.test/?q=&amp;amp;copy;#&amp;copy;",
    "https://github&#46;com.evil.example/Ann-Diana/codex-project-chat-exporter/blob/main/FAQ.md",
    "https://github.com&#64;evil.example/Ann-Diana/codex-project-chat-exporter/blob/main/FAQ.md",
    "https://sub.github.com:444/Ann-Diana/codex-project-chat-exporter/blob/main/FAQ.md",
    `${base.replace("Ann-Diana", "Ann&hyphen;Diana")}/blob/main/FAQ.md`,
    `${base.replace("Ann-Diana", "Ann&#45;Diana")}/issues?q=&copy;`,
    "mailto:info&#64;example.test", "#&#x6D;ain",
  ]) {
    const snippet = `[probe](<${spelling}>)`;
    const result = transformPackagedReadme(`${readme}\n\n${snippet}`, EXPECTED_SOURCE_REF);
    assert.equal(result.split("\n").at(-1), snippet);
    assert.equal(markdownLinkTargets(result).at(-1), markdownLinkTargets(snippet)[0]);
  }
  const autolink = `<${base}/blob/main/FAQ.md?x=&amp;copy;>`;
  assert.equal(markdownLinkTargets(autolink)[0], `${base}/blob/main/FAQ.md?x=&amp;copy;`, "mdast autolinks do not decode entities");
  assert.throws(() => transformPackagedReadme(`${readme}\n\n${autolink}`, EXPECTED_SOURCE_REF), { code: "VSIX_README_AMBIGUOUS_AUTOLINK" });
});

test("R-01 malformed identities, ambiguous definitions and encoded active schemes fail closed", async () => {
  const readme = await fs.readFile(path.join(extensionRoot, "README.md"), "utf8");
  const base = PACKAGED_README_REPOSITORY_URL;
  for (const spelling of [
    ...["Ann&amp;#45;Diana", "Ann&amp;amp;#45;Diana", "Ann&#45Diana", "Ann&bogus;Diana", "Ann&#xZZ;Diana", "Ann&#x110000;Diana"].map((owner) => `${base.replace("Ann-Diana", owner)}/blob/main/FAQ.md`),
    "https://github&#46com/Ann-Diana/codex-project-chat-exporter/blob/main/FAQ.md",
    `${base.replace("github.com", "user&#64;github.com")}/blob/main/FAQ.md`,
    `${base.replace("github.com", "github.com&#58;444")}/blob/main/FAQ.md`,
    `${base.replace("github.com", "www&#46;github.com")}/blob/main/FAQ.md`,
    `${base.replace("Ann-Diana", String.raw`Ann\\-Diana`)}/blob/main/FAQ.md`,
    "javascript:alert%281%29", "java&#115;cript&colon;alert%281%29", String.raw`javascript\:alert%281%29`,
    "java&#9;script:alert%281%29", "data&colon;text/html,test", "file&colon;/etc/passwd",
    "command&colon;workbench.action.openSettings", "vscode&colon;//file/test", "vbscript:msgbox%281%29",
    "javascript&amp;colon;alert%281%29", "&#0;https://example.test", "https://example.test/&#xD800;",
  ]) assert.throws(() => transformPackagedReadme(`${readme}\n\n[probe](<${spelling}>)`, EXPECTED_SOURCE_REF), /VSIX README/, spelling);
  for (const snippet of [
    `<${base.replace("github.com", "github&#46;com")}/blob/main/FAQ.md>`,
    `<${base.replace("Ann-Diana", "Ann&#45;Diana")}/blob/main/FAQ.md>`,
    `[x][same]\n\n[same]: ${base}/blob/main/FAQ.md\n[SAME]: https://example.test/`,
    `[empty]()`, `<a href="${base}/blob/main/FAQ.md?x=&not">`,
    `<a href="${base}/blob/main/FAQ.md?x=&Amp;">`,
  ]) assert.throws(() => transformPackagedReadme(`${readme}\n\n${snippet}`, EXPECTED_SOURCE_REF), /VSIX README/, snippet);
});

function ambiguousAutolinkTargets() {
  const url = `${PACKAGED_README_REPOSITORY_URL}/blob/main/FAQ.md`;
  return [
    // Renderer-dependent single/double decoding and backslash spellings.
    ...["&amp;copy;", "&#38;copy;", "&#x26;copy;", "&amp;amp;copy;", String.raw`\&copy;`,
      "&copy;", "&amp;&#45;", "&", "&unfinished", "&#", "&#45", "&#x", "&#xZZ;", "&bogus;", "1&y=2",
    ].map((value) => `${url}?q=${value}`),
    `${url}#&#45;`, `${url}#&copy;`, `${url}#fragment&`,
    url.replace("Ann-Diana", "Ann&#45;Diana"), url.replace("Ann-Diana", "Ann&#x2D;Diana"),
    url.replace("github.com", "github&period;com"), url.replace("github.com", "github&#46;com"),
    url.replace("github.com", "git&#x68;ub.com"), url.replace("Ann-Diana", String.raw`Ann\-Diana`),
    url.replace("github.com", "github&#46;com").replace("Ann-Diana", String.raw`Ann\-Diana`),
    "https://example.test/?q=&amp;copy;", "https://example.test/?q=1&next=2",
    String.raw`https://example.test/a\b`, `${PACKAGED_README_REPOSITORY_URL}/issues?q=&copy;`,
    "javascript:alert&#40;1&#41;", String.raw`data:text/html,\script`,
  ];
}

function assertAmbiguousAutolink(error) {
  assert.equal(error.code, "VSIX_README_AMBIGUOUS_AUTOLINK");
  assert.match(error.message, /use a normal Markdown link with an unambiguous URL instead/);
  return true;
}

test("R-01 autolinks reject raw ampersands and backslashes before any renderer decoding", async () => {
  const readme = await fs.readFile(path.join(extensionRoot, "README.md"), "utf8");
  for (const target of ambiguousAutolinkTargets()) {
    const snippet = `<${target}>`;
    assert.equal(fromMarkdown(snippet).children[0].children[0].type, "link", snippet);
    assert.throws(() => transformPackagedReadme(`${readme}\n\n${snippet}`, EXPECTED_SOURCE_REF), assertAmbiguousAutolink, snippet);
  }
  // Angle brackets around an ordinary Markdown destination are not autolinks.
  const spelling = `${PACKAGED_README_REPOSITORY_URL.replace("Ann-Diana", String.raw`Ann\-Diana`)}/blob/main/FAQ.md?q=&amp;copy;`;
  const expected = `${PACKAGED_README_REPOSITORY_URL}/blob/${EXPECTED_SOURCE_REF}/FAQ.md?q=&copy;`;
  for (const snippet of [`[FAQ](<${spelling}>)`, `![FAQ](<${spelling}>)`, `[FAQ][r]\n\n[r]: <${spelling}>`]) {
    assert.equal(markdownLinkTargets(transformPackagedReadme(`${readme}\n\n${snippet}`, EXPECTED_SOURCE_REF)).at(-1), expected);
  }
  const code = `\n\n\`<${ambiguousAutolinkTargets()[0]}>\``;
  assert.equal(transformPackagedReadme(readme + code, EXPECTED_SOURCE_REF), transformPackagedReadme(readme, EXPECTED_SOURCE_REF) + code);
});

test("R-01 unambiguous and percent-encoded autolinks retain structural URL classification", async () => {
  const readme = await fs.readFile(path.join(extensionRoot, "README.md"), "utf8");
  const base = PACKAGED_README_REPOSITORY_URL;
  for (const target of [
    `${base}/blob/main/FAQ.md`, `${base}/blob/main/a%20b.md?q=%26amp%3Bcopy%3B#%5Cmain`,
    `${base.replace("github.com", "%67ithub.com")}/blob/main/FAQ.md?q=%2526copy%253B`,
    `${base.replace("Ann-Diana", "Ann%2DDiana")}/blob/main/FAQ.md?x=main#main`,
  ]) {
    const output = transformPackagedReadme(`${readme}\n\n<${target}>`, EXPECTED_SOURCE_REF);
    const actual = new URL(markdownLinkTargets(output).at(-1)), original = new URL(target);
    assert.equal(actual.hostname, "github.com");
    assert.equal(actual.pathname, original.pathname.replace("/main/", `/${EXPECTED_SOURCE_REF}/`));
    assert.equal(actual.search, original.search); assert.equal(actual.hash, original.hash);
  }
  for (const target of [
    "https://example.test/?q=%26copy%3B#%5C", "https://example.test/?q=%2526copy%253B",
    "https://github.com.evil.example/Ann-Diana/codex-project-chat-exporter/blob/main/FAQ.md",
    "https://github.com%40evil.example@other.example/Ann-Diana/codex-project-chat-exporter/blob/main/FAQ.md",
    "https://sub.github.com:444/Ann-Diana/codex-project-chat-exporter/blob/main/FAQ.md",
    `${base}/issues?q=%26copy%3B`, "https://marketplace.visualstudio.com/items?itemName=ann-diana.codex-project-chat-exporter-vscode",
  ]) {
    const snippet = `<${target}>`;
    const result = transformPackagedReadme(`${readme}\n\n${snippet}`, EXPECTED_SOURCE_REF);
    assert.equal(result.split("\n").at(-1), snippet);
    assert.equal(markdownLinkTargets(result).at(-1), target);
  }
  for (const target of [
    `${base.replace("github.com", "user%40evil.example@github.com")}/blob/main/FAQ.md`,
    `${base.replace("github.com", "%67ithub.com:444")}/blob/main/FAQ.md`,
    "javascript:alert%281%29", "data:text/html,test", "file:/etc/passwd", "command:workbench.action.openSettings",
  ]) assert.throws(() => transformPackagedReadme(`${readme}\n\n<${target}>`, EXPECTED_SOURCE_REF), /VSIX README/, target);
});

test("R-01 every ambiguous autolink aborts the real builder before archive creation and leaves an empty target", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "packaged-vsix-autolink-")));
  try {
    const fixture = path.join(temp, "extension"); await copyExtensionFixture(fixture);
    const readme = await fs.readFile(path.join(fixture, "README.md"), "utf8");
    let archiveCalls = 0;
    for (const [index, target] of ambiguousAutolinkTargets().entries()) {
      await fs.writeFile(path.join(fixture, "README.md"), `${readme}\n\n<${target}>\n`);
      const distDir = path.join(temp, `dist-${index}`); await fs.mkdir(distDir);
      assert.deepEqual(await fs.readdir(distDir), []);
      await assert.rejects(() => buildVsix({
        extensionRoot: fixture, distDir,
        archiveWriter: async () => { archiveCalls++; throw new Error("Archive writer must not be called"); },
      }), assertAmbiguousAutolink, target);
      assert.equal(archiveCalls, 0);
      assert.deepEqual(await fs.readdir(distDir), [], "no VSIX, partial archive or staging directory may remain");
    }
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

function rendererAmbiguousSnippets() {
  const base = PACKAGED_README_REPOSITORY_URL;
  const snippets = [];
  for (const target of [
    ...["\\&copy;", "\\&#45;", "\\&#x2D;", "\\&NotEqualTilde;", "\\&amp;copy;"].map((value) => `${base}/blob/main/FAQ.md?q=${value}#${value}`),
    "https://example.test/?q=\\&copy;", `${base}/issues?q=\\&#45;`,
    "https://example.test/?q=&amp;amp;copy;#\\&copy;",
    `${base}/blob/main/FAQ.md?q=\\&copy;#\\&#45;`,
    "https://github.com.evil.example/?q=\\&copy;", "https://example.test/?q=\\&NewLine;",
  ]) {
    snippets.push(`[probe](<${target}>)`, `![probe](${target})`, `[probe][r]\n\n[r]: <${target}>`);
  }
  return snippets.concat([
    "https://example.test/", "www.example.test", "[x](https://example.test/) www.other.test",
    '<p src="https://example.test/image">unsupported resource</p>',
    '<img src="https://example.test/image" srcset="https://other.test/image 2x">',
    '![a [b](https://example.test/inner)](https://example.test/image)',
  ]);
}

test("R-01 dual-parser gate rejects entity, occurrence and source mapping differences", async () => {
  const readme = await fs.readFile(path.join(extensionRoot, "README.md"), "utf8");
  for (const snippet of rendererAmbiguousSnippets()) {
    assert.throws(() => transformPackagedReadme(`${readme}\n\n${snippet}`, EXPECTED_SOURCE_REF), { code: "VSIX_README_RENDERER_AMBIGUITY" }, snippet);
  }
  // The lexer alone does not expose the effective HTML target: the renderer
  // preserves &copy;, which HTML interprets as © after the Markdown escape.
  const marked = new Marked(), snippet = String.raw`[x](https://example.test/?q=\&copy;)`;
  assert.equal(marked.lexer(snippet)[0].tokens[0].href, "https://example.test/?q=&copy;");
  assert.equal(markdownLinkTargets(snippet)[0], "https://example.test/?q=&copy;");
  assert.throws(() => verifyReadmeRendererAgreement(snippet), { code: "VSIX_README_RENDERER_AMBIGUITY" });
  for (const spelling of ["&copy;", "&#45;", "&#x2D;", "&amp;copy;", "&amp;amp;copy;", "&bogus;", "&incomplete"]) {
    const graph = verifyReadmeRendererAgreement(`[x](https://example.test/?q=${spelling}#${spelling})`);
    assert.equal(graph.mdast.length, 1); assert.equal(graph.marked.length, 1);
    assert.equal(new URL(graph.mdast[0].url).href, new URL(graph.marked[0].url).href);
  }
});

test("R-01 dual-parser graph resolves repeated references, ignores unused definitions and preserves nested occurrence order", async () => {
  const readme = await fs.readFile(path.join(extensionRoot, "README.md"), "utf8");
  const snippet = '[a][r] [b][r] ![i][r]\n\n[r]: https://example.test/?q=&copy;\n[unused]: https://example.test/?q=\\&copy;';
  const graph = verifyReadmeRendererAgreement(snippet);
  assert.deepEqual(graph.mdast.map(({ kind }) => kind), ["link", "link", "image"]);
  assert.deepEqual(graph.mdast.map(({ start, end }) => snippet.slice(start, end)), ["[a][r]", "[b][r]", "![i][r]"]);
  assert.equal(graph.mdast.length, graph.marked.length);
  assert.equal(transformPackagedReadme(`${readme}\n\n${snippet}`, EXPECTED_SOURCE_REF).endsWith(snippet), true);
  const nested = '[![image](https://example.test/image)](https://example.test/page)';
  for (const input of [nested, `${nested}\n\n${nested}`, `\`${nested}\`\n\n${nested}`, `> ${nested}`, `- ${nested}`]) {
    const result = verifyReadmeRendererAgreement(input);
    assert.deepEqual(result.mdast.map(({ kind }) => kind), input === `${nested}\n\n${nested}` ? ["link", "image", "link", "image"] : ["link", "image"]);
    assert.ok(result.mdast.every((node, index) => node.kind === result.marked[index].kind && node.start === result.marked[index].start && node.end === result.marked[index].end));
    transformPackagedReadme(`${readme}\n\n${input}`, EXPECTED_SOURCE_REF);
  }
  assert.deepEqual(verifyReadmeRendererAgreement(snippet.replaceAll("\n", "\r\n")), graph);
});

test("R-01 raw HTML resources are either fully mapped in both graphs or rejected", async () => {
  const readme = await fs.readFile(path.join(extensionRoot, "README.md"), "utf8");
  const base = PACKAGED_README_REPOSITORY_URL;
  const html = `<div class="note"><a href="${base}/blob/main/FAQ.md?x=1&amp;y=2"><img src="${base}/raw/main/example.png" alt="sample"></a><span>plain</span></div>`;
  const graph = verifyReadmeRendererAgreement(html);
  assert.deepEqual(graph.mdast, graph.marked);
  assert.deepEqual(graph.mdast.map(({ kind }) => kind), ["link", "image"]);
  const result = transformPackagedReadme(`${readme}\n\n${html}`, EXPECTED_SOURCE_REF);
  for (const item of verifyReadmeRendererAgreement(result).mdast.slice(-2)) assert.equal(new URL(item.url).pathname.split("/")[4], EXPECTED_SOURCE_REF);
  for (const presentation of ['<div class="note"><span>plain</span></div>', '<p><strong>plain</strong><br><em>text</em></p>']) {
    assert.deepEqual(verifyReadmeRendererAgreement(presentation), { mdast: [], marked: [] });
    assert.ok(transformPackagedReadme(`${readme}\n\n${presentation}`, EXPECTED_SOURCE_REF).endsWith(presentation));
  }
  for (const invalid of [`<img src=${base}/raw/main/a.png>`, `<a href="${base}/blob/main/FAQ.md" href="https://example.test/">`, '<svg><a href="https://example.test/">x</a></svg>']) {
    assert.throws(() => transformPackagedReadme(`${readme}\n\n${invalid}`, EXPECTED_SOURCE_REF), /VSIX README/);
  }
});

test("R-01 dual-parser gate detects count, kind and order drift at the rendering boundary", () => {
  const source = "[one](https://example.test/one) [two](https://example.test/two)";
  const original = Marked.prototype.parser;
  for (const change of [
    (tokens) => tokens.reverse(),
    (tokens) => tokens.pop(),
    (tokens) => { tokens[0].type = "image"; },
  ]) {
    try {
      // Fault injection after source mapping proves that agreement is checked
      // against emitted occurrences, not merely the lexer's token inventory.
      Marked.prototype.parser = function (tokens, options) {
        change(tokens[0].tokens);
        return original.call(this, tokens, options);
      };
      assert.throws(() => verifyReadmeRendererAgreement(source), { code: "VSIX_README_RENDERER_AMBIGUITY" });
    } finally { Marked.prototype.parser = original; }
  }
  assert.equal(verifyReadmeRendererAgreement(source).mdast.length, 2);
});

test("R-01 every dual-parser rejection stops the real builder without a package or staging residue", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "packaged-vsix-dual-parser-")));
  try {
    const fixture = path.join(temp, "extension"); await copyExtensionFixture(fixture);
    const readme = await fs.readFile(path.join(fixture, "README.md"), "utf8");
    let archives = 0;
    for (const [index, snippet] of rendererAmbiguousSnippets().entries()) {
      await fs.writeFile(path.join(fixture, "README.md"), `${readme}\n\n${snippet}\n`);
      const distDir = path.join(temp, `dist-${index}`); await fs.mkdir(distDir);
      await assert.rejects(() => buildVsix({ extensionRoot: fixture, distDir, archiveWriter: async () => { archives++; } }), { code: "VSIX_README_RENDERER_AMBIGUITY" }, snippet);
      assert.equal(archives, 0); assert.deepEqual(await fs.readdir(distDir), []);
    }
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test("R-01 the rewritten README is gated again before the archive writer can run", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "packaged-vsix-renderer-recheck-")));
  const original = Marked.prototype.parser;
  let injected = 0, archives = 0;
  try {
    Marked.prototype.parser = function (tokens, options) {
      this.walkTokens(tokens, (token) => {
        if (token.type !== "link") return;
        let url; try { url = new URL(token.href); } catch { return; }
        if (url.pathname.split("/").includes(EXPECTED_SOURCE_REF)) { token.href = "https://example.test/changed"; injected++; }
      });
      return original.call(this, tokens, options);
    };
    await assert.rejects(() => buildVsix({ distDir: temp, archiveWriter: async () => { archives++; } }), { code: "VSIX_README_RENDERER_AMBIGUITY" });
    assert.ok(injected > 0); assert.equal(archives, 0); assert.deepEqual(await fs.readdir(temp), []);
  } finally { Marked.prototype.parser = original; await fs.rm(temp, { recursive: true, force: true }); }
});

test("R-01 all 22 real README targets are parsed and exactly 12 content targets are pinned", async () => {
  const source = await fs.readFile(path.join(extensionRoot, "README.md"), "utf8");
  const result = transformPackagedReadme(source, EXPECTED_SOURCE_REF);
  const sourceTargets = [...markdownLinkTargets(source), ...htmlImageSources(source)];
  const resultTargets = [...markdownLinkTargets(result), ...htmlImageSources(result)];
  assert.equal(sourceTargets.length, 22); assert.equal(resultTargets.length, 22);
  assertAllPinnedReadmeLinks(result);
  assert.equal(resultTargets.filter((target, index) => target !== sourceTargets[index]).length, 12);
  assert.equal(result, expectedPackagedReadme(source));
  const before = verifyReadmeRendererAgreement(source), after = verifyReadmeRendererAgreement(result);
  assert.equal(before.mdast.length, 22); assert.equal(before.marked.length, 22);
  for (const parser of ["mdast", "marked"]) {
    assert.equal(after[parser].length, 22);
    const changed = after[parser].filter((target, index) => target.url !== before[parser][index].url);
    assert.equal(changed.length, 12);
    for (const target of changed) {
      const url = new URL(target.url);
      assert.equal(url.hostname, "github.com");
      assert.equal(url.pathname.split("/")[4], EXPECTED_SOURCE_REF);
    }
  }
});

test("build-only manifest projection preserves mixed line endings and rejects duplicate keys", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "packaged-vsix-dev-manifests-")));
  try {
    const fixture = path.join(temp, "repo");
    for (const dir of ["bin", "lib", "fonts"]) await fs.mkdir(path.join(fixture, dir), { recursive: true });
    for (const name of ["OFL.txt", "OFL-SYMBOLS.txt", "OFL-EMOJI.txt"]) await fs.writeFile(path.join(fixture, "fonts", name), "fixture license\n");
    await fs.writeFile(path.join(fixture, "LICENSE"), "MIT\n");
    await fs.writeFile(path.join(fixture, "bin", "export-codex-project-chats.mjs"), "export function exportArchive() {}\n");
    initializeGitFixture(fixture);
    const productionPackage = '{\r\n  "name": "fixture",\n  "version": "1.0.0",\r\n  "type": "module",\n  "custom": ["literal \\\"devDependencies\\\": {}", {"quoted": "\\\\"}],\r\n  "dependencies": {}\r\n}\n';
    const productionLock = '{\n  "lockfileVersion": 3,\r\n  "packages": {\r\n    "": {"name": "fixture", "dependencies": {}}\n  }\r\n}\n';
    const dev = '"devDependencies": {"parser": "1.0.0"}';
    assert.ok(productionPackage.startsWith("{"));
    const packageVariants = [
      `{ ${dev},${productionPackage.slice(1)}`,
      productionPackage.replace('  "dependencies":', `  ${dev},\r\n  "dependencies":`),
      productionPackage.replace('"dependencies": {}', `"dependencies": {},\r\n  ${dev}`),
    ];
    const lock = productionLock.replace('"name": "fixture"', `${dev},"name": "fixture"`)
      .replace('    "":', '    "node_modules/parser-a": {"dev": true},\r\n    "":')
      .replace('"dependencies": {}}', '"dependencies": {}},\r\n    "node_modules/parser-z": {"dev": true}');
    for (let index = 0; index < packageVariants.length; index++) {
      await fs.writeFile(path.join(fixture, "package.json"), packageVariants[index]);
      await fs.writeFile(path.join(fixture, "package-lock.json"), lock);
      const result = await buildVsix({ repoRoot: fixture, distDir: path.join(temp, `dist-${index}`) });
      const zip = await JSZip.loadAsync(await fs.readFile(result.vsixPath), { checkCRC32: true });
      const prefix = "extension/vendor/codex-project-chat-exporter/";
      assert.equal(await zip.file(`${prefix}package.json`).async("string"), productionPackage);
      assert.equal(await zip.file(`${prefix}package-lock.json`).async("string"), productionLock);
    }
    await fs.writeFile(path.join(fixture, "package.json"), productionPackage.replace('"dependencies": {}', '"dependencies": {}, "dependencies": {}'));
    await assert.rejects(() => buildVsix({ repoRoot: fixture, distDir: path.join(temp, "duplicate") }), /Duplicate runtime manifest object key/);
    assert.deepEqual(await fs.readdir(path.join(temp, "duplicate")), []);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

function collectElements(value, name, result = []) {
  if (!value || typeof value !== "object") return result;
  if (value.type === "element" && value.name === name) result.push(value);
  for (const child of value.elements || []) collectElements(child, name, result);
  return result;
}

function elementText(value) {
  if (!value || typeof value !== "object") return "";
  if (value.type === "text") return String(value.text || "");
  return (value.elements || []).map(elementText).join("");
}

function assertMarketplaceLinkProperties(vsixManifest, extensionPackage) {
  const properties = collectElements(vsixManifest, "Properties");
  assert.equal(properties.length, 1);
  const directProperties = (properties[0].elements || [])
    .filter((element) => element.type === "element" && element.name === "Property");
  assert.equal(directProperties.length, 6, "the four existing and two new marketplace properties must be retained");
  assert.equal(collectElements(vsixManifest, "Property").length, directProperties.length);
  for (const [id, expected] of [
    ["Microsoft.VisualStudio.Services.Links.Source", extensionPackage.repository.url],
    ["Microsoft.VisualStudio.Services.Links.Learn", extensionPackage.homepage],
  ]) {
    const matches = directProperties.filter((element) => element.attributes?.Id === id);
    assert.equal(matches.length, 1, `${id} must occur exactly once`);
    assert.equal(matches[0].attributes.Value, expected, `${id} must match extension/package.json`);
  }
  assert.equal(collectElements(vsixManifest, "Repository").length, 0);
  assert.equal(collectElements(vsixManifest, "ProjectUrl").length, 0);
}

function inflatedPdfStreams(bytes) {
  const streamStart = Buffer.from("stream\n", "latin1");
  const streamEnd = Buffer.from("\nendstream", "latin1");
  const streams = [];
  let cursor = 0;
  while (cursor < bytes.length) {
    const marker = bytes.indexOf(streamStart, cursor);
    if (marker < 0) break;
    const start = marker + streamStart.length;
    const end = bytes.indexOf(streamEnd, start);
    assert.notEqual(end, -1);
    const content = bytes.subarray(start, end);
    try { streams.push(inflateSync(content).toString("latin1")); }
    catch { streams.push(content.toString("latin1")); }
    cursor = end + streamEnd.length;
  }
  return streams;
}

async function withoutNetwork(action) {
  const blocked = () => { throw new Error("unexpected network access"); };
  const patches = [
    [http, "get"], [http, "request"], [https, "get"], [https, "request"],
    [net, "connect"], [net, "createConnection"], [tls, "connect"], [dns, "lookup"], [dns, "resolve"],
  ].map(([owner, key]) => [owner, key, owner[key]]);
  const previousFetch = globalThis.fetch;
  try {
    for (const [owner, key] of patches) owner[key] = blocked;
    globalThis.fetch = blocked;
    return await action();
  } finally {
    for (const [owner, key, value] of patches) owner[key] = value;
    globalThis.fetch = previousFetch;
  }
}

async function extractExtension(zip, installedRoot) {
  for (const entry of Object.values(zip.files).filter((candidate) => !candidate.dir && candidate.name.startsWith("extension/"))) {
    const relative = entry.name.slice("extension/".length);
    const segments = relative.split("/");
    assert.ok(relative && !relative.startsWith("/") && !relative.includes("\\") && segments.every((segment) => segment && segment !== "." && segment !== ".."));
    const destination = path.join(installedRoot, ...segments);
    assert.equal(path.relative(installedRoot, destination).startsWith(".."), false);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, await entry.async("nodebuffer"), { flag: "wx" });
  }
}

async function copyExtensionFixture(destination) {
  await fs.mkdir(destination, { recursive: true });
  for (const name of ["package.json", "README.md", "CHANGELOG.md", "PACKAGED_TEST_PLAN.md", "LICENSE"]) {
    await fs.copyFile(path.join(extensionRoot, name), path.join(destination, name));
  }
  await fs.cp(path.join(extensionRoot, "images"), path.join(destination, "images"), { recursive: true });
  await fs.cp(path.join(extensionRoot, "src"), path.join(destination, "src"), { recursive: true });
}

function initializeGitFixture(repoRoot) {
  execFileSync("git", ["init", "--quiet"], { cwd: repoRoot, windowsHide: true });
  commitGitFixture(repoRoot, "fixture");
}

function commitGitFixture(repoRoot, message) {
  execFileSync("git", ["-c", "user.name=VSIX Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", message], { cwd: repoRoot, windowsHide: true });
}

async function writeSyntheticSession(codexHome) {
  const sessionId = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
  const parentId = "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
  const directory = path.join(codexHome, "sessions", "2026", "08", "24");
  const archivedDirectory = path.join(codexHome, "archived_sessions");
  await fs.mkdir(directory, { recursive: true });
  await fs.mkdir(archivedDirectory, { recursive: true });
  const message = "# Linktest\n\nUmlaute äöü & <XML>. Symbole → ← ↑ ↓ ✓ ⚠ ± ≤ ≥. Emoji 😄 und ⚠️. ZWJ 👩‍💻 und 😄‍😄. ANSI \u001b[31m.\n\nLink: [OpenAI](https://openai.com/).\n\n- eins\n- zwei\n\n```js\nconst value = '<&> → ✓ ⚠ ≤ ≥';\n```";
  const imageUrl = `data:image/png;base64,${ONE_PIXEL_PNG.toString("base64")}`;
  const parentPrefix = [
    { ordinal: 0, type: "session_meta", timestamp: "2026-08-24T09:00:00.000Z", payload: { id: parentId, cwd: PACKAGED_PARENT_PROJECT, timestamp: "2026-08-24T09:00:00.000Z", source: "vscode", thread_source: "user", history_mode: "paginated" } },
    { ordinal: 1, type: "response_item", timestamp: "2026-08-24T09:00:01.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: message }, { type: "input_image", image_url: imageUrl }], internal_chat_message_metadata_passthrough: { turn_id: "turn-1" } } },
    { ordinal: 2, type: "event_msg", timestamp: "2026-08-24T09:00:01.001Z", payload: { type: "user_message", message, images: [imageUrl] } },
  ];
  const parentPrefixBytes = Buffer.from(`${parentPrefix.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  const parentFile = path.join(archivedDirectory, `rollout-2026-08-24T09-00-00-${parentId}.jsonl`);
  await fs.writeFile(parentFile, Buffer.concat([parentPrefixBytes, Buffer.from(`${JSON.stringify({ ordinal: 3, type: "response_item", timestamp: "2026-08-24T09:00:02.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "AFTER_REFERENCE_BOUNDARY" }] } })}\n`, "utf8")]));
  const historyBase = { thread_id: parentId, end_ordinal_exclusive: 3, end_byte_offset: parentPrefixBytes.length };
  const records = [
    { ordinal: 3, type: "session_meta", timestamp: "2026-08-24T10:00:00.000Z", payload: { id: sessionId, cwd: PACKAGED_CHILD_PROJECT, timestamp: "2026-08-24T10:00:00.000Z", source: "vscode", thread_source: "user", forked_from_id: parentId, history_mode: "paginated", history_base: historyBase } },
    { ordinal: 4, type: "response_item", timestamp: "2026-08-24T10:00:02.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Antwort. [Query](https://example.invalid/3D?a=1&b=2)." }] } },
  ];
  const childFile = path.join(directory, `rollout-2026-08-24T10-00-00-${sessionId}.jsonl`);
  await fs.writeFile(childFile, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  return { childFile, parentPrefixBytes };
}

test("regular VSIX builds are byte-identical and their packaged runtime exports controlled DOCX/PDF links offline", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "packaged-vsix-e2e-")));
  try {
    const first = await buildVsix({ distDir: path.join(temp, "dist-1") });
    const second = await buildVsix({ distDir: path.join(temp, "dist-2") });
    const firstBytes = await fs.readFile(first.vsixPath);
    const secondBytes = await fs.readFile(second.vsixPath);
    // Avoid allocating a multi-megabyte structural assertion diff on failure.
    assert.ok(firstBytes.equals(secondBytes), `independent builds differ: ${sha256(firstBytes)} / ${sha256(secondBytes)}`);

    const zip = await JSZip.loadAsync(firstBytes, { checkCRC32: true, createFolders: false });
    const files = Object.values(zip.files).filter((entry) => !entry.dir);
    assert.ok(files.every((entry) => entry.date.toISOString() === FIXED_DATE));
    const packagedReadmeBytes = await zip.file("extension/README.md")?.async("nodebuffer");
    assert.ok(packagedReadmeBytes, "packaged README is missing");
    const sourceReadme = await fs.readFile(path.join(extensionRoot, "README.md"), "utf8");
    const packagedReadme = packagedReadmeBytes.toString("utf8");
    assert.notEqual(packagedReadme, sourceReadme);
    assert.equal(packagedReadme, expectedPackagedReadme(sourceReadme));
    assertPackagedReadmeTargets(packagedReadme);
    assertAllPinnedReadmeLinks(packagedReadme);
    assert.equal(packagedReadme.includes("../../"), false);
    assert.equal(packagedReadme.includes("before the first publication"), false);
    assert.equal(packagedReadme.includes("is not published in the Visual Studio Code Marketplace"), false);
    assertSupportIssuesLink(packagedReadme);
    const packagedChangelog = await zip.file("extension/CHANGELOG.md")?.async("string");
    assert.ok(packagedChangelog, "packaged extension CHANGELOG is missing");
    assert.equal(packagedChangelog, await fs.readFile(path.join(extensionRoot, "CHANGELOG.md"), "utf8"));
    assert.ok(packagedChangelog.includes("## 0.2.0 – First Marketplace release"));
    assert.ok(packagedChangelog.includes("## 0.2.1 – Unreleased"));
    for (const { source, packaged, expectedOccurrences } of PACKAGED_README_TRANSFORMATIONS) {
      assert.equal(literalOccurrenceCount(packagedReadme, source), 0, source);
      assert.equal(literalOccurrenceCount(packagedReadme, packaged), expectedOccurrences, packaged);
    }
    for (const requiredTarget of [
      "extension/LICENSE",
      "extension/PACKAGED_TEST_PLAN.md",
      "extension/images/codex-project-chat-exporter-hero.png",
      "extension/images/01-scope-picker.png",
      "extension/images/02-project-history-picker.png",
      "extension/images/03-document-format-picker.png",
      "extension/images/04-export-success.png",
    ]) assert.ok(zip.file(requiredTarget), requiredTarget);
    const contentTypes = xml2js(await zip.file("[Content_Types].xml").async("string"), { compact: false, alwaysChildren: true });
    const vsixManifest = xml2js(await zip.file("extension.vsixmanifest").async("string"), { compact: false, alwaysChildren: true });
    const packagedExtensionManifest = JSON.parse(await zip.file("extension/package.json").async("string"));
    assertMarketplaceLinkProperties(vsixManifest, packagedExtensionManifest);
    const identities = collectElements(vsixManifest, "Identity");
    assert.equal(identities.length, 1);
    assert.deepEqual(
      { id: identities[0].attributes.Id, publisher: identities[0].attributes.Publisher, version: identities[0].attributes.Version },
      { id: "codex-project-chat-exporter-vscode", publisher: "ann-diana", version: "0.2.1" },
    );
    const changelogAssets = collectElements(vsixManifest, "Asset")
      .filter((element) => element.attributes?.Type === "Microsoft.VisualStudio.Services.Content.Changelog");
    assert.deepEqual(changelogAssets.map((element) => element.attributes), [{
      Type: "Microsoft.VisualStudio.Services.Content.Changelog",
      Path: "extension/CHANGELOG.md",
      Addressable: "true",
    }]);
    const marketplaceProperties = new Map(collectElements(vsixManifest, "Property")
      .map((element) => [element.attributes.Id, element.attributes.Value]));
    assert.equal(marketplaceProperties.get("Microsoft.VisualStudio.Code.Engine"), packagedExtensionManifest.engines.vscode);
    assert.equal(marketplaceProperties.get("Microsoft.VisualStudio.Code.ExtensionKind"), "ui");
    assert.equal(marketplaceProperties.get("Microsoft.VisualStudio.Services.Content.Pricing"), "Free");
    assert.equal(marketplaceProperties.get("Microsoft.VisualStudio.Services.Links.Support"), packagedExtensionManifest.bugs.url);
    const defaults = new Set(collectElements(contentTypes, "Default").map((element) => String(element.attributes?.Extension || "").toLowerCase()));
    const overrides = new Set(collectElements(contentTypes, "Override").map((element) => String(element.attributes?.PartName || "")));
    for (const file of files) {
      if (file.name === "[Content_Types].xml") continue;
      const extension = path.posix.extname(file.name).slice(1).toLowerCase();
      assert.ok(extension ? defaults.has(extension) : overrides.has(`/${file.name}`), `missing content type: ${file.name}`);
    }
    const sidebar = packagedExtensionManifest.contributes.viewsContainers.activitybar;
    assert.deepEqual(sidebar, [{ id: "codexArchive", title: "Codex Exporter", icon: "images/exporter.svg" }]);
    assert.deepEqual(packagedExtensionManifest.contributes.views.codexArchive, [{ id: "codexArchive.actions", name: "Codex Exporter", icon: "images/exporter.svg" }]);
    const svgBytes = await zip.file("extension/images/exporter.svg").async("nodebuffer");
    assert.deepEqual(svgBytes, await fs.readFile(path.join(extensionRoot, "images", "exporter.svg")));
    const svg = xml2js(svgBytes.toString("utf8"), { compact: false, alwaysChildren: true });
    assert.equal(collectElements(svg, "svg")[0].attributes.viewBox, "0 0 24 24");
    assert.deepEqual(collectElements(svg, "svg")[0].elements.filter(e => e.type === "element").map(e => e.name), ["path"]);
    const iconPath = collectElements(svg, "path")[0];
    assert.equal(iconPath.attributes.fill, "none");
    assert.equal(iconPath.attributes.stroke, "#C5C5C5");
    assert.deepEqual(Object.keys(iconPath.attributes).sort(), ["d", "fill", "stroke", "stroke-linecap", "stroke-linejoin", "stroke-width"].sort());
    assert.equal(collectElements(contentTypes, "Default").find(e => e.attributes.Extension === "svg").attributes.ContentType, "image/svg+xml");
    const rootPackage = JSON.parse(await fs.readFile("package.json", "utf8"));
    const lock = JSON.parse(await fs.readFile("package-lock.json", "utf8"));
    const extensionPackage = JSON.parse(await fs.readFile(path.join("integrations", "vscode", "package.json"), "utf8"));
    assert.deepEqual(packagedExtensionManifest, extensionPackage);
    assert.equal(extensionPackage.version, "0.2.1");
    assert.equal(extensionPackage.name, "codex-project-chat-exporter-vscode");
    assert.equal(extensionPackage.publisher, "ann-diana");
    assert.equal(extensionPackage.pricing, "Free");
    assert.ok(extensionPackage.description.includes("DOCX") && extensionPackage.description.includes("PDF"));
    assert.equal(rootPackage.version, "0.4.0");
    const publicImages = new Map([
      ["codex-project-chat-exporter-hero.png", "36a0a0923c97c040d85d16e9584a80b997c8b265d93a5d8cb7a01b08c07dd311"],
      ["01-scope-picker.png", "78ba8cf95d07d48be0eb06a773ac702aac02d3155a760aaf0da664f7646ab5b0"],
      ["02-project-history-picker.png", "437b751ede0c909e6b188b0dfaddaffc066d87ba4b7f1ee3f7e9f64463c31fd5"],
      ["03-document-format-picker.png", "5167954996b948e269b8db5c3236f5297fb81ecfd6128f9c25542862254c91bf"],
      ["04-export-success.png", "f5eb92017ad651cfdbcb50171a0c8e520e901dbb450594b64e5d52c0a13c112b"],
    ]);
    for (const [name, expected] of publicImages) {
      const packaged = await zip.file(`extension/images/${name}`)?.async("nodebuffer");
      assert.ok(packaged, `missing public image: ${name}`);
      assert.equal(sha256(packaged), expected, name);
      assert.deepEqual(packaged, await fs.readFile(path.join("integrations", "vscode", "images", name)), name);
    }
    for (const name of (await fs.readdir("lib")).filter((name) => name.endsWith(".mjs"))) {
      assert.ok(zip.file(`extension/vendor/codex-project-chat-exporter/lib/${name}`), name);
    }
    for (const name of (await fs.readdir("fonts")).filter((name) => name.endsWith(".ttf") || name === "OFL.txt" || name === "OFL-SYMBOLS.txt" || name === "OFL-EMOJI.txt")) {
      assert.ok(zip.file(`extension/vendor/codex-project-chat-exporter/fonts/${name}`), name);
    }
    assert.equal(zip.file("extension/vendor/codex-project-chat-exporter/fonts/NotoEmoji-Regular.ttf"), null, "the retired emoji font must not remain packaged");
    assert.equal(zip.file("extension/vendor/codex-project-chat-exporter/fonts/APACHE-NOTO-EMOJI.txt"), null, "the retired Apache license must not remain packaged");
    assert.equal(
      sha256(await zip.file("extension/vendor/codex-project-chat-exporter/fonts/NotoEmoji-Variable.ttf").async("nodebuffer")),
      "de6c18832938afc99caf132b39d6a30a19bac7f2e812e28db2535b4608d27551",
    );
    for (const [lockPath, entry] of Object.entries(lock.packages)) {
      if (!lockPath.startsWith("node_modules/") || entry.dev === true) continue;
      assert.ok(files.some((file) => file.name.startsWith(`extension/vendor/codex-project-chat-exporter/${lockPath}/`)), lockPath);
    }
    assert.deepEqual(lock.packages[""].dependencies, rootPackage.dependencies);
    const vendorPrefix = "extension/vendor/codex-project-chat-exporter/";
    assert.deepEqual(rootPackage.devDependencies, { marked: "18.0.14", "mdast-util-from-markdown": "2.0.3" });
    assert.deepEqual(lock.packages[""].devDependencies, rootPackage.devDependencies);
    const productionPackage = structuredClone(rootPackage), productionLock = structuredClone(lock);
    delete productionPackage.devDependencies;
    delete productionLock.packages[""].devDependencies;
    const developmentPaths = Object.entries(lock.packages).filter(([, entry]) => entry.dev === true).map(([name]) => name);
    assert.ok(developmentPaths.includes("node_modules/mdast-util-from-markdown"));
    assert.ok(developmentPaths.includes("node_modules/marked"));
    assert.ok(developmentPaths.includes("node_modules/micromark"));
    for (const devPath of developmentPaths) {
      delete productionLock.packages[devPath];
      assert.equal(files.some((file) => file.name.startsWith(`${vendorPrefix}${devPath}/`)), false, devPath);
    }
    assert.deepEqual(JSON.parse(await zip.file(`${vendorPrefix}package.json`).async("string")), productionPackage);
    assert.deepEqual(JSON.parse(await zip.file(`${vendorPrefix}package-lock.json`).async("string")), productionLock);
    for (const name of ["scripts/build-vsix.mjs", "tests/packaged-vsix.test.mjs", "node_modules/mdast-util-from-markdown/index.js", "node_modules/marked/lib/marked.esm.js"]) {
      assert.equal(zip.file(`extension/${name}`), null, name);
    }
    const integrity = JSON.parse(await zip.file(`${vendorPrefix}integrity.json`).async("string"));
    const actualRuntimeFiles = files.map((file) => file.name).filter((name) => name.startsWith(vendorPrefix) && name !== `${vendorPrefix}integrity.json`).map((name) => name.slice(vendorPrefix.length)).sort();
    assert.deepEqual(Object.keys(integrity.files).sort(), actualRuntimeFiles);
    for (const relative of actualRuntimeFiles) assert.equal(sha256(await zip.file(`${vendorPrefix}${relative}`).async("nodebuffer")), integrity.files[relative], relative);
    const licenses = await zip.file(`${vendorPrefix}THIRD_PARTY_LICENSES.txt`).async("string");
    for (const name of Object.keys(rootPackage.dependencies)) assert.ok(licenses.includes(`Package: ${name}@`), name);
    assert.ok(licenses.includes("Noto Sans 2.015") && licenses.includes("Noto Sans Symbols 2 2.008") && licenses.includes("SIL OPEN FONT LICENSE Version 1.1"));
    assert.ok(licenses.includes("Source: fonts/OFL-SYMBOLS.txt") && licenses.includes("Copyright 2022 The Noto Project Authors (https://github.com/notofonts/symbols)"));
    assert.ok(licenses.includes("Noto Emoji 3.002") && licenses.includes("Source: fonts/OFL-EMOJI.txt") && licenses.includes("SIL OPEN FONT LICENSE Version 1.1"));

    const installedRoot = path.join(temp, "installed-extension");
    await extractExtension(zip, installedRoot);
    const { defaultLoadExporter } = require(path.join(installedRoot, "src", "vscode-adapter.cjs"));
    const codexHome = path.join(temp, "synthetic-codex-home");
    const outputDirectory = path.join(temp, "output");
    const paginatedFixture = await writeSyntheticSession(codexHome);
    const exporter = await withoutNetwork(() => defaultLoadExporter({ extensionPath: installedRoot }));
    let choices = 0;
    const result = await withoutNetwork(() => exporter.exportArchive({ codexHome, scope: "project", workspacePath: PACKAGED_MISSING_PROJECT, outputDirectory, exportProfile: "complete", documentFormats: ["docx", "pdf"], onSelectRecordedProject: ({ projects, reason }) => {
      choices++;
      assert.equal(reason, "no-match");
      assert.equal(projects.length, 2);
      const childProject = projects.find((project) => project.cwd === PACKAGED_CHILD_PROJECT);
      assert.equal(childProject.sessionCount, 1);
      return childProject.cwd;
    } }));
    assert.equal(choices, 1);
    const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.sessions.length, 1);
    assert.equal(manifest.archive_format_version, 1);
    assert.equal(manifest.unique_assets, 1);
    assert.equal(manifest.asset_occurrences, 2);
    const assetsManifest = JSON.parse(await fs.readFile(path.join(outputDirectory, manifest.assets_manifest), "utf8"));
    assert.equal(assetsManifest.schema_version, 2);
    assert.equal(assetsManifest.assets.length, 1);
    assert.equal(assetsManifest.assets[0].sha256, ONE_PIXEL_PNG_SHA256);
    assert.deepEqual(await fs.readFile(path.join(outputDirectory, assetsManifest.assets[0].path)), ONE_PIXEL_PNG);
    assert.equal(manifest.history_reference_closure.length, 1);
    const historySegment = manifest.history_reference_closure[0].segments[0];
    assert.equal(historySegment.snapshot_kind, "DERIVED_EXACT_PREFIX");
    assert.deepEqual(await fs.readFile(path.join(outputDirectory, historySegment.snapshot_file)), paginatedFixture.parentPrefixBytes);
    assert.deepEqual(await fs.readFile(path.join(outputDirectory, manifest.sessions[0].raw_export_file)), await fs.readFile(paginatedFixture.childFile));
    const markdown = await fs.readFile(path.join(outputDirectory, manifest.sessions[0].markdown_file), "utf8");
    assert.equal(markdown.includes("AFTER_REFERENCE_BOUNDARY"), false);
    assert.ok(markdown.includes(`assets/${ONE_PIXEL_PNG_SHA256}.png`));
    const indexHtml = await fs.readFile(path.join(outputDirectory, "index.html"), "utf8");
    assert.equal(indexHtml.split("<img ").length - 1, 1);
    assert.ok(indexHtml.includes(`assets/${ONE_PIXEL_PNG_SHA256}.png`));
    const docx = await fs.readFile(path.join(outputDirectory, manifest.sessions[0].docx_file));
    const { documentXml, mediaFiles, relsXml } = await withoutNetwork(async () => {
      const documentZip = await JSZip.loadAsync(docx, { checkCRC32: true, createFolders: false });
      for (const entry of Object.values(documentZip.files)) if (!entry.dir && (entry.name.endsWith(".xml") || entry.name.endsWith(".rels"))) xml2js(await entry.async("string"));
      return {
        documentXml: await documentZip.file("word/document.xml").async("string"),
        mediaFiles: await Promise.all(Object.values(documentZip.files).filter((entry) => !entry.dir && entry.name.startsWith("word/media/")).map((entry) => entry.async("nodebuffer"))),
        relsXml: await documentZip.file("word/_rels/document.xml.rels").async("string"),
      };
    });
    assert.equal(mediaFiles.length, 1);
    assert.deepEqual(mediaFiles[0], ONE_PIXEL_PNG);
    const relationship = collectElements(xml2js(relsXml, { compact: false, alwaysChildren: true }), "Relationship").find((element) => element.attributes?.Type.endsWith("/hyperlink"));
    assert.equal(relationship.attributes.TargetMode, "External");
    assert.equal(relationship.attributes.Target, "https://openai.com/");
    assert.ok(collectElements(xml2js(relsXml), "Relationship").some(element => element.attributes?.Target === "https://example.invalid/3D?a=1&b=2"));
    const parsedDocument = xml2js(documentXml, { compact: false, alwaysChildren: true });
    const hyperlink = collectElements(parsedDocument, "w:hyperlink")[0];
    assert.equal(hyperlink.attributes["r:id"], relationship.attributes.Id);
    assert.equal(elementText(hyperlink), "OpenAI (https://openai.com/)");
    const paragraph = collectElements(parsedDocument, "w:p").find((element) => collectElements(element, "w:hyperlink").length === 1);
    const children = paragraph.elements.filter((element) => element.type === "element");
    const index = children.findIndex((element) => element.name === "w:hyperlink");
    assert.ok(elementText(children[index - 1]).endsWith("Link: "));
    assert.equal(elementText(children[index + 1]), ".");
    assert.ok(elementText(parsedDocument).includes("ANSI ."));
    assert.equal(elementText(parsedDocument).includes("invalid XML character U+001B"), false);
    assert.equal(elementText(parsedDocument).includes("AFTER_REFERENCE_BOUNDARY"), false);

    const pdf = await fs.readFile(path.join(outputDirectory, manifest.sessions[0].pdf_file));
    const pdfSource = pdf.toString("latin1");
    assert.ok(pdfSource.startsWith("%PDF-") && pdfSource.includes("/S /URI") && pdfSource.includes("/URI (https://openai.com/)"));
    assert.ok(pdfSource.split("/Subtype /Image").length - 1 >= 1, "the packaged offline PDF must embed the synthetic image");
    assert.ok(pdfSource.includes("/URI (https://example.invalid/3D?a=1&b=2)"));
    assert.equal(pdfSource.includes("/Launch") || pdfSource.includes("/JavaScript") || pdfSource.includes("/EmbeddedFile"), false);
    const unicodeMaps = inflatedPdfStreams(pdf).filter((stream) => stream.includes("beginbfchar") || stream.includes("beginbfrange")).join("\n").toUpperCase().replaceAll(" ", "");
    assert.ok(unicodeMaps.includes("D83DDE04"), "the packaged offline PDF must retain U+1F604 in ToUnicode");
    assert.ok(unicodeMaps.includes("26A0FE0F"), "the packaged offline PDF must retain the warning variation sequence");
    assert.ok(unicodeMaps.includes("D83DDC69200DD83DDCBB"), "the packaged offline PDF must retain the supported ZWJ grapheme");
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("VSIX marketplace links round-trip XML-significant URL characters exactly once", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "packaged-vsix-links-")));
  try {
    const fixtureRoot = path.join(temp, "extension");
    await copyExtensionFixture(fixtureRoot);
    const packagePath = path.join(fixtureRoot, "package.json");
    const fixturePackage = JSON.parse(await fs.readFile(packagePath, "utf8"));
    fixturePackage.repository.url = 'https://example.test/source?one=1&two="A<B>"';
    fixturePackage.homepage = 'https://example.test/learn?first=1&second="C<D>"';
    await fs.writeFile(packagePath, `${JSON.stringify(fixturePackage, null, 2)}\n`);

    const { vsixPath } = await buildVsix({ extensionRoot: fixtureRoot, distDir: path.join(temp, "dist") });
    const zip = await JSZip.loadAsync(await fs.readFile(vsixPath), { checkCRC32: true, createFolders: false });
    const manifestXml = await zip.file("extension.vsixmanifest").async("string");
    const vsixManifest = xml2js(manifestXml, { compact: false, alwaysChildren: true });
    const packagedExtensionManifest = JSON.parse(await zip.file("extension/package.json").async("string"));
    assert.deepEqual(packagedExtensionManifest, fixturePackage);
    assertMarketplaceLinkProperties(vsixManifest, packagedExtensionManifest);
    assert.ok(manifestXml.includes('Id="Microsoft.VisualStudio.Services.Links.Source" Value="https://example.test/source?one=1&amp;two=&quot;A&lt;B&gt;&quot;"'));
    assert.ok(manifestXml.includes('Id="Microsoft.VisualStudio.Services.Links.Learn" Value="https://example.test/learn?first=1&amp;second=&quot;C&lt;D&gt;&quot;"'));
    assert.equal(manifestXml.includes("&amp;amp;"), false);
    assert.equal(manifestXml.includes("<Repository>"), false);
    assert.equal(manifestXml.includes("<ProjectUrl>"), false);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("regular builder fails closed for missing or altered approved public images", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "packaged-vsix-public-images-")));
  try {
    const fixtureRoot = path.join(temp, "extension");
    await copyExtensionFixture(fixtureRoot);
    const scopeImage = path.join(fixtureRoot, "images", "01-scope-picker.png");
    await fs.rm(scopeImage);
    await assert.rejects(
      () => buildVsix({ extensionRoot: fixtureRoot, distDir: path.join(temp, "dist-missing") }),
      (error) => error?.code === "ENOENT" && String(error.path || "").endsWith("01-scope-picker.png"),
    );
    assert.deepEqual(await fs.readdir(path.join(temp, "dist-missing")), []);

    await fs.copyFile(path.join(extensionRoot, "images", "01-scope-picker.png"), scopeImage);
    await fs.appendFile(path.join(fixtureRoot, "images", "codex-project-chat-exporter-hero.png"), Buffer.from([0]));
    await assert.rejects(
      () => buildVsix({ extensionRoot: fixtureRoot, distDir: path.join(temp, "dist-altered") }),
      /Public image differs from its approved SHA-256: codex-project-chat-exporter-hero\.png/,
    );
    assert.deepEqual(await fs.readdir(path.join(temp, "dist-altered")), []);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("regular builder fails before archive creation when a packaged runtime import is missing", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "packaged-vsix-missing-import-")));
  try {
    const repoRoot = path.join(temp, "repo");
    await fs.mkdir(path.join(repoRoot, "bin"), { recursive: true });
    await fs.mkdir(path.join(repoRoot, "lib"));
    await fs.mkdir(path.join(repoRoot, "fonts"));
    await fs.writeFile(path.join(repoRoot, "fonts", "OFL.txt"), "fixture font license\n");
    await fs.writeFile(path.join(repoRoot, "fonts", "OFL-SYMBOLS.txt"), "fixture symbol font license\n");
    await fs.writeFile(path.join(repoRoot, "fonts", "OFL-EMOJI.txt"), "fixture emoji font license\n");
    await fs.writeFile(path.join(repoRoot, "package.json"), `${JSON.stringify({ name: "fixture", version: "1.0.0", type: "module", dependencies: {} }, null, 2)}\n`);
    await fs.writeFile(path.join(repoRoot, "package-lock.json"), `${JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "fixture", version: "1.0.0", dependencies: {} } } }, null, 2)}\n`);
    await fs.writeFile(path.join(repoRoot, "LICENSE"), "MIT\n");
    await fs.writeFile(path.join(repoRoot, "bin", "export-codex-project-chats.mjs"), 'import "../lib/missing.mjs";\nexport function exportArchive() {}\n');
    initializeGitFixture(repoRoot);
    let archiveCalls = 0;
    await assert.rejects(() => buildVsix({ repoRoot, distDir: path.join(temp, "dist"), archiveWriter: async () => { archiveCalls += 1; } }), /complete import tree/);
    assert.equal(archiveCalls, 0);
    assert.deepEqual(await fs.readdir(path.join(temp, "dist")), []);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("regular builder fails before archive creation when the locked production tree is incomplete", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "packaged-vsix-missing-dependency-")));
  try {
    const repoRoot = path.join(temp, "repo");
    await fs.mkdir(path.join(repoRoot, "bin"), { recursive: true });
    await fs.mkdir(path.join(repoRoot, "lib"));
    await fs.mkdir(path.join(repoRoot, "fonts"));
    await fs.writeFile(path.join(repoRoot, "fonts", "OFL.txt"), "fixture font license\n");
    await fs.writeFile(path.join(repoRoot, "fonts", "OFL-SYMBOLS.txt"), "fixture symbol font license\n");
    await fs.writeFile(path.join(repoRoot, "fonts", "OFL-EMOJI.txt"), "fixture emoji font license\n");
    const dependencies = { "missing-dependency": "1.0.0" };
    await fs.writeFile(path.join(repoRoot, "package.json"), `${JSON.stringify({ name: "fixture", version: "1.0.0", type: "module", dependencies }, null, 2)}\n`);
    await fs.writeFile(path.join(repoRoot, "package-lock.json"), `${JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "fixture", version: "1.0.0", dependencies }, "node_modules/missing-dependency": { version: "1.0.0", resolved: "https://registry.npmjs.org/missing-dependency/-/missing-dependency-1.0.0.tgz", integrity: "sha512-fixture" } } }, null, 2)}\n`);
    await fs.writeFile(path.join(repoRoot, "LICENSE"), "MIT\n");
    await fs.writeFile(path.join(repoRoot, "bin", "export-codex-project-chats.mjs"), "export function exportArchive() {}\n");
    initializeGitFixture(repoRoot);
    let archiveCalls = 0;
    await assert.rejects(() => buildVsix({ repoRoot, distDir: path.join(temp, "dist"), archiveWriter: async () => { archiveCalls += 1; } }), (error) => error?.code === "ENOENT");
    assert.equal(archiveCalls, 0);
    assert.deepEqual(await fs.readdir(path.join(temp, "dist")), []);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("regular builder rejects a missing upstream symbol-font license before archive creation", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "packaged-vsix-missing-symbol-license-")));
  try {
    const repoRoot = path.join(temp, "repo");
    await fs.mkdir(path.join(repoRoot, "bin"), { recursive: true });
    await fs.mkdir(path.join(repoRoot, "lib"));
    await fs.mkdir(path.join(repoRoot, "fonts"));
    await fs.writeFile(path.join(repoRoot, "fonts", "OFL.txt"), "fixture font license\n");
    await fs.writeFile(path.join(repoRoot, "package.json"), `${JSON.stringify({ name: "fixture", version: "1.0.0", type: "module", dependencies: {} }, null, 2)}\n`);
    await fs.writeFile(path.join(repoRoot, "package-lock.json"), `${JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "fixture", version: "1.0.0", dependencies: {} } } }, null, 2)}\n`);
    await fs.writeFile(path.join(repoRoot, "LICENSE"), "MIT\n");
    await fs.writeFile(path.join(repoRoot, "bin", "export-codex-project-chats.mjs"), "export function exportArchive() {}\n");
    initializeGitFixture(repoRoot);
    let archiveCalls = 0;
    await assert.rejects(
      () => buildVsix({ repoRoot, distDir: path.join(temp, "dist"), archiveWriter: async () => { archiveCalls += 1; } }),
      (error) => error?.code === "ENOENT" && String(error.path || "").endsWith("OFL-SYMBOLS.txt"),
    );
    assert.equal(archiveCalls, 0);
    assert.deepEqual(await fs.readdir(path.join(temp, "dist")), []);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("regular builder rejects a missing upstream emoji-font license before archive creation", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "packaged-vsix-missing-emoji-license-")));
  try {
    const repoRoot = path.join(temp, "repo");
    await fs.mkdir(path.join(repoRoot, "bin"), { recursive: true });
    await fs.mkdir(path.join(repoRoot, "lib"));
    await fs.mkdir(path.join(repoRoot, "fonts"));
    await fs.writeFile(path.join(repoRoot, "fonts", "OFL.txt"), "fixture font license\n");
    await fs.writeFile(path.join(repoRoot, "fonts", "OFL-SYMBOLS.txt"), "fixture symbol font license\n");
    await fs.writeFile(path.join(repoRoot, "package.json"), `${JSON.stringify({ name: "fixture", version: "1.0.0", type: "module", dependencies: {} }, null, 2)}\n`);
    await fs.writeFile(path.join(repoRoot, "package-lock.json"), `${JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "fixture", version: "1.0.0", dependencies: {} } } }, null, 2)}\n`);
    await fs.writeFile(path.join(repoRoot, "LICENSE"), "MIT\n");
    await fs.writeFile(path.join(repoRoot, "bin", "export-codex-project-chats.mjs"), "export function exportArchive() {}\n");
    initializeGitFixture(repoRoot);
    let archiveCalls = 0;
    await assert.rejects(
      () => buildVsix({ repoRoot, distDir: path.join(temp, "dist"), archiveWriter: async () => { archiveCalls += 1; } }),
      (error) => error?.code === "ENOENT" && String(error.path || "").endsWith("OFL-EMOJI.txt"),
    );
    assert.equal(archiveCalls, 0);
    assert.deepEqual(await fs.readdir(path.join(temp, "dist")), []);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
