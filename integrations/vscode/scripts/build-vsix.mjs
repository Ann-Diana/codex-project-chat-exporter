import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import JSZip from "jszip";
import xmlJs from "xml-js";
import { fromMarkdown } from "mdast-util-from-markdown";
import { Marked, Renderer } from "marked";

const defaultExtensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultRepoRoot = path.resolve(defaultExtensionRoot, "..", "..");
const FIXED_ARCHIVE_DATE = new Date("2000-01-01T00:00:00.000Z");
const RUNTIME_ROOT = "extension/vendor/codex-project-chat-exporter";
const FORBIDDEN_NATIVE_EXTENSIONS = new Set([".dll", ".dylib", ".exe", ".node", ".so"]);
const execFileAsync = promisify(execFile);
const PACKAGED_README_REPOSITORY_URL = "https://github.com/Ann-Diana/codex-project-chat-exporter";
function packagedReadmeTransformations(sourceRef) {
  return [
    {
      source: 'src="images/codex-project-chat-exporter-hero.png"',
      packaged: `src="${PACKAGED_README_REPOSITORY_URL}/raw/${sourceRef}/integrations/vscode/images/codex-project-chat-exporter-hero.png"`,
      expectedOccurrences: 1,
    },
    ...[
      "01-scope-picker.png",
      "02-project-history-picker.png",
      "03-document-format-picker.png",
      "04-export-success.png",
    ].map((name) => ({
      source: `](images/${name})`,
      packaged: `](${PACKAGED_README_REPOSITORY_URL}/raw/${sourceRef}/integrations/vscode/images/${name})`,
      expectedOccurrences: 1,
    })),
    {
      source: "](LICENSE)",
      packaged: `](${PACKAGED_README_REPOSITORY_URL}/blob/${sourceRef}/integrations/vscode/LICENSE)`,
      expectedOccurrences: 2,
    },
    {
      source: "](PACKAGED_TEST_PLAN.md)",
      packaged: `](${PACKAGED_README_REPOSITORY_URL}/blob/${sourceRef}/integrations/vscode/PACKAGED_TEST_PLAN.md)`,
      expectedOccurrences: 1,
    },
  ];
}
const PUBLIC_IMAGE_HASHES = new Map([
  ["codex-project-chat-exporter-hero.png", "36a0a0923c97c040d85d16e9584a80b997c8b265d93a5d8cb7a01b08c07dd311"],
  ["01-scope-picker.png", "78ba8cf95d07d48be0eb06a773ac702aac02d3155a760aaf0da664f7646ab5b0"],
  ["02-project-history-picker.png", "437b751ede0c909e6b188b0dfaddaffc066d87ba4b7f1ee3f7e9f64463c31fd5"],
  ["03-document-format-picker.png", "5167954996b948e269b8db5c3236f5297fb81ecfd6128f9c25542862254c91bf"],
  ["04-export-success.png", "f5eb92017ad651cfdbcb50171a0c8e520e901dbb450594b64e5d52c0a13c112b"],
]);

export async function buildVsix(options = {}) {
  const extensionRoot = path.resolve(options.extensionRoot || defaultExtensionRoot);
  const repoRoot = path.resolve(options.repoRoot || defaultRepoRoot);
  const distDir = path.resolve(options.distDir || path.join(extensionRoot, "dist"));
  const sourceRef = await resolveCheckedOutCommit(repoRoot);
  const archiveWriter = options.archiveWriter || writeZipArchive;
  const packageJson = JSON.parse(await fs.readFile(path.join(extensionRoot, "package.json"), "utf8"));
  const vsixBase = `${packageJson.name}-${packageJson.version}`;
  const vsixPath = path.join(distDir, `${vsixBase}.vsix`);

  await fs.mkdir(distDir, { recursive: true });
  const unexpectedArtifacts = await listUnexpectedDistArtifacts(distDir, vsixPath);
  if (unexpectedArtifacts.length > 0) {
    throw new Error(`Unexpected dist artifacts must be reviewed manually before packaging: ${unexpectedArtifacts.map((entry) => path.basename(entry)).join(", ")}`);
  }
  const stage = await fs.mkdtemp(path.join(distDir, `.stage-${vsixBase}-`));
  const stageRootOwned = await inspectOwnedBuildPath(stage, distDir, "directory");
  const stageOwned = {
    root: stageRootOwned,
    directories: [],
    files: [],
    byPath: new Map([[buildPathKey(stage), stageRootOwned]]),
  };
  const archivePath = path.join(distDir, `${vsixBase}.vsix.partial-${randomUUID()}`);
  await assertPathAbsent(archivePath, "VSIX temporary archive path");
  let archiveCurrent = null;
  let previousCandidate = null;
  let publishedCandidate = null;
  let stageCleanupAttempted = false;

  try {
    for (const relative of [
      "extension",
      "extension/src",
      "extension/images",
      "extension/vendor",
      "extension/vendor/codex-project-chat-exporter",
      "extension/vendor/codex-project-chat-exporter/bin",
      "extension/vendor/codex-project-chat-exporter/fonts",
      "extension/vendor/codex-project-chat-exporter/lib",
      "extension/vendor/codex-project-chat-exporter/node_modules",
    ]) {
      await createOwnedStageDirectory(stageOwned, stage, relative);
    }

    await copyVerifiedFile(path.join(extensionRoot, "package.json"), path.join(stage, "extension", "package.json"), stageOwned, stage);
    const sourceReadme = await fs.readFile(path.join(extensionRoot, "README.md"), "utf8");
    await writeOwnedStageFile(stageOwned, stage, path.join(stage, "extension", "README.md"), transformPackagedReadme(sourceReadme, sourceRef));
    await copyVerifiedFile(path.join(extensionRoot, "CHANGELOG.md"), path.join(stage, "extension", "CHANGELOG.md"), stageOwned, stage);
    await copyVerifiedFile(path.join(extensionRoot, "PACKAGED_TEST_PLAN.md"), path.join(stage, "extension", "PACKAGED_TEST_PLAN.md"), stageOwned, stage);
    await copyVerifiedFile(path.join(extensionRoot, "LICENSE"), path.join(stage, "extension", "LICENSE"), stageOwned, stage);
    for (const name of [
      "icon.png",
      "exporter.svg",
      "codex-project-chat-exporter-hero.png",
      "01-scope-picker.png",
      "02-project-history-picker.png",
      "03-document-format-picker.png",
      "04-export-success.png",
    ]) {
      const hash = await copyVerifiedFile(path.join(extensionRoot, "images", name), path.join(stage, "extension", "images", name), stageOwned, stage);
      const expectedHash = PUBLIC_IMAGE_HASHES.get(name);
      if (expectedHash && hash !== expectedHash) throw new Error(`Public image differs from its approved SHA-256: ${name}`);
    }
    await copyVerifiedFile(path.join(extensionRoot, "src", "extension.cjs"), path.join(stage, "extension", "src", "extension.cjs"), stageOwned, stage);
    await copyVerifiedFile(path.join(extensionRoot, "src", "vscode-adapter.cjs"), path.join(stage, "extension", "src", "vscode-adapter.cjs"), stageOwned, stage);
    const packagedCore = await packageExporterRuntime({ repoRoot, stage, stageOwned });

    await writeOwnedStageFile(stageOwned, stage, path.join(stage, "extension.vsixmanifest"), `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${escapeXml(packageJson.name)}" Version="${escapeXml(packageJson.version)}" Publisher="${escapeXml(packageJson.publisher)}"/>
    <DisplayName>${escapeXml(packageJson.displayName)}</DisplayName>
    <Description xml:space="preserve">${escapeXml(packageJson.description)}</Description>
    <Tags>${packageJson.keywords.map(escapeXml).join(",")}</Tags>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${escapeXml(packageJson.engines.vscode)}"/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui"/>
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="${escapeXml(packageJson.pricing)}"/>
      <Property Id="Microsoft.VisualStudio.Services.Links.Support" Value="${escapeXml(packageJson.bugs.url)}"/>
      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="${escapeXml(packageJson.repository.url)}"/>
      <Property Id="Microsoft.VisualStudio.Services.Links.Learn" Value="${escapeXml(packageJson.homepage)}"/>
    </Properties>
    <License>extension/LICENSE</License>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/images/icon.png" Addressable="true"/>
  </Assets>
</PackageManifest>
`);

    await writeOwnedStageFile(stageOwned, stage, path.join(stage, "[Content_Types].xml"), createContentTypes(stageOwned, stage));
    try {
      await import(`${pathToFileURL(packagedCore).href}?build=${randomUUID()}`);
    } catch (error) {
      throw new Error(`Packaged exporter runtime cannot resolve its complete import tree: ${error?.message || error}`, { cause: error });
    }

    if (options.beforeArchiveWrite) await options.beforeArchiveWrite({ stage, archivePath });
    await verifyOwnedStageForArchive(stageOwned, stage, distDir);
    await archiveWriter({ stage, archivePath });
    archiveCurrent = await inspectOwnedBuildPath(archivePath, distDir, "file");
    const archiveIdentity = archiveCurrent.identity;
    previousCandidate = await moveExactCandidateAside(vsixPath, distDir);
    await fs.rename(archivePath, vsixPath);
    publishedCandidate = await inspectOwnedBuildPath(vsixPath, distDir, "file");
    if (publishedCandidate.identity !== archiveIdentity) throw new Error("Published VSIX does not match the run-owned temporary archive");
    archiveCurrent = null;
    await removeOwnedBuildPath(previousCandidate, distDir);
    previousCandidate = null;
    stageCleanupAttempted = true;
    await removeOwnedStage(stageOwned, stage, distDir);
    return { archivePath, distDir, removedCandidates: [], stage, unexpectedArtifacts, vsixPath };
  } catch (error) {
    if (publishedCandidate) {
      await removeOwnedBuildPath(publishedCandidate, distDir);
      publishedCandidate = null;
    }
    if (previousCandidate) {
      await restoreExactCandidate(vsixPath, previousCandidate, distDir);
      previousCandidate = null;
    }
    throw error;
  } finally {
    if (archiveCurrent) await removeOwnedBuildPath(archiveCurrent, distDir);
    if (!stageCleanupAttempted) {
      stageCleanupAttempted = true;
      await removeOwnedStage(stageOwned, stage, distDir);
    }
  }
}

export function validateSourceCommit(output) {
  const sourceRef = typeof output === "string" ? output.trim() : "";
  if (!/^[0-9a-f]{40}$/.test(sourceRef)) throw new Error("VSIX source commit must be a full lowercase 40-character SHA-1 hash");
  return sourceRef;
}

export async function resolveCheckedOutCommit(repoRoot) {
  const sourceRoot = path.resolve(repoRoot);
  try {
    const { stdout: rootOutput } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: sourceRoot, encoding: "utf8", windowsHide: true });
    const gitRoot = await fs.realpath(rootOutput.trim());
    if (path.relative(await fs.realpath(sourceRoot), gitRoot) !== "") throw new Error("VSIX source is not the Git checkout root");
    const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: sourceRoot, encoding: "utf8", windowsHide: true });
    return validateSourceCommit(stdout);
  } catch (error) {
    throw new Error("Cannot determine the VSIX source commit from the repository checkout", { cause: error });
  }
}

export function transformPackagedReadme(sourceReadme, sourceRef) {
  if (typeof sourceReadme !== "string") throw new TypeError("VSIX README source must be text");
  sourceRef = validateSourceCommit(sourceRef);
  const transformations = packagedReadmeTransformations(sourceRef);
  const relativeTargets = new Map(transformations.map(({ source, packaged, expectedOccurrences }) => [
    source.slice(source.startsWith('src="') ? 5 : 2, -1),
    { target: packaged.slice(packaged.startsWith('src="') ? 5 : 2, -1), expectedOccurrences, occurrences: 0 },
  ]));
  const { tree, targets } = parseReadmeTargets(sourceReadme, sourceRef);
  verifyReadmeRendererAgreement(sourceReadme);
  const replacements = [];
  const expected = new Map();
  let packagedReadme = sourceReadme;
  for (const target of targets) {
    // Markdown URLs already have exactly the parser's decoding. Never decode them again.
    const decoded = target.url;
    let bound;
    let absolute = false;
    try { new URL(decoded); absolute = true; } catch { /* Only approved relative files may be resolved. */ }
    if (!absolute && !decoded.startsWith("#")) {
      const suffixStart = Math.min(...[decoded.indexOf("?"), decoded.indexOf("#"), decoded.length].filter((index) => index >= 0));
      const relative = relativeTargets.get(decoded.slice(0, suffixStart));
      if (!relative) throw new Error(`Unmapped relative VSIX README target: ${decoded}`);
      relative.occurrences++;
      bound = new URL(relative.target + decoded.slice(suffixStart)).href;
    } else bound = bindRepositoryContentUrl(decoded, sourceRef);
    expected.set(target, bound);
    if (bound === decoded) continue;
    const replacement = target.quote ? escapeXml(bound).replaceAll("'", "&apos;")
      : target.kind === "autolink" ? bound
        : bound.replaceAll("&", "&amp;").replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
    replacements.push({ ...target, replacement });
  }
  for (const [relative, { occurrences, expectedOccurrences }] of relativeTargets) {
    if (occurrences !== expectedOccurrences) throw new Error(`Expected ${expectedOccurrences} VSIX README occurrence(s) of ${relative}, found ${occurrences}`);
  }
  for (const { start, end, replacement } of replacements.toReversed()) {
    packagedReadme = packagedReadme.slice(0, start) + replacement + packagedReadme.slice(end);
  }
  const reparsed = parseReadmeTargets(packagedReadme, sourceRef);
  verifyReadmeRendererAgreement(packagedReadme);
  if (reparsed.targets.length !== targets.length || reparsed.targets.some((target, index) => target.url !== expected.get(targets[index]))) {
    throw new Error("VSIX README semantic targets changed during replacement");
  }
  // Verify the complete semantic tree, not only the URL list: a replacement must
  // not create another node, change a title/reference, or escape its source range.
  for (const target of targets) {
    const bound = expected.get(target);
    if (!target.quote) target.node.url = bound;
    if (target.kind === "autolink" && bound !== target.url) target.node.children[0].value = bound;
  }
  const htmlNodes = new Set(replacements.filter((target) => target.quote).map((target) => target.node));
  for (const node of htmlNodes) {
    let value = sourceReadme.slice(node.position.start.offset, node.position.end.offset);
    for (const target of replacements.filter((target) => target.node === node).toReversed()) {
      const start = target.start - node.position.start.offset, end = target.end - node.position.start.offset;
      value = value.slice(0, start) + target.replacement + value.slice(end);
    }
    node.value = value;
  }
  const semanticTree = (value) => JSON.stringify(value, (key, child) => key === "position" ? undefined : child);
  if (semanticTree(tree) !== semanticTree(reparsed.tree)) throw new Error("VSIX README structure changed during replacement");
  return packagedReadme;
}

function bindRepositoryContentUrl(target, sourceRef) {
  if (target.startsWith("#")) return target;
  let url;
  try { url = new URL(target); }
  catch { throw new Error(`Unsupported VSIX README URL: ${target}`); }
  if (!["https:", "http:", "mailto:"].includes(url.protocol)
    || url.hostname.includes("&") || target !== target.trim() || target.includes("\uFFFD")
    || [...target].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw new Error(`Unsupported VSIX README URL scheme or control character: ${target}`);
  }
  const hostWithoutDot = url.hostname.endsWith(".") ? url.hostname.slice(0, -1) : url.hostname;
  const host = hostWithoutDot.startsWith("www.") ? hostWithoutDot.slice(4) : hostWithoutDot;
  const rawHost = host === "raw.githubusercontent.com";
  if (host !== "github.com" && !rawHost) return target;
  if (target.includes("\\")) throw new Error(`Ambiguous VSIX README repository URL: ${target}`);
  const parts = url.pathname.split("/");
  // Residual entity spelling here is literal (including deliberate double encoding).
  // Do not decode it recursively or guess a repository identity from it.
  if (parts.slice(1, 3).some((part) => part.includes("&"))) throw new Error(`Ambiguous VSIX README repository URL: ${target}`);
  let identity;
  try { identity = decodeURIComponent(url.pathname).split("/").slice(1, 3).map((part) => part.toLowerCase()); }
  catch { throw new Error(`Ambiguous VSIX README repository URL: ${target}`); }
  if (identity[0] !== "ann-diana" || identity[1] !== "codex-project-chat-exporter") return target;
  const fail = () => { throw new Error(`Ambiguous or unsupported VSIX README repository URL: ${target}`); };
  if (!target.startsWith("https://") || url.protocol !== "https:" || url.hostname !== host || url.username || url.password || url.port
    || target !== target.trim() || target.includes("\\") || [...target].some((char) => char.charCodeAt(0) < 32)) fail();
  // Inspect the original path before URL's dot-segment normalization can hide ambiguity.
  const authorityEnd = target.indexOf("/", "https://".length);
  const rawPath = target.slice(authorityEnd).split("?")[0].split("#")[0];
  for (const segment of rawPath.split("/").slice(1)) {
    let decoded;
    try { decoded = decodeURIComponent(segment); } catch { fail(); }
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")
      || [...decoded].some((char) => char.charCodeAt(0) < 32)) fail();
  }
  if (rawHost) {
    if (parts.length < 5 || !parts.slice(4).every(Boolean)) fail();
    if (parts[3] !== "main") { try { validateSourceCommit(parts[3]); } catch { fail(); } }
    parts[3] = sourceRef;
  } else if (parts.length === 3 || (parts.length === 4 && parts[3] === "")) {
    // Repository navigation stays live; a README/section anchor is versioned content.
    if (!url.hash) return target;
    url.pathname = `/${parts[1]}/${parts[2]}/tree/${sourceRef}`;
    return url.href;
  } else if (["blob", "raw", "tree"].includes(parts[3])) {
    const contentParts = parts[3] === "tree" && parts.at(-1) === "" ? parts.slice(4, -1) : parts.slice(4);
    if (contentParts.length < (parts[3] === "tree" ? 1 : 2) || !contentParts.every(Boolean)) fail();
    // A slash-bearing branch/tag cannot be separated from its file path safely here.
    // Accept main and complete commit IDs only; require explicit handling of other refs.
    if (parts[4] !== "main") { try { validateSourceCommit(parts[4]); } catch { fail(); } }
    parts[4] = sourceRef;
  } else if (["issues", "pull", "pulls", "actions", "releases", "discussions", "projects", "security", "labels", "milestones", "branches", "tags"].includes(parts[3])) {
    return target;
  } else fail();
  url.pathname = parts.join("/");
  return url.href;
}

function parseReadmeTargets(readme, sourceRef) {
  const destinations = new Map(), autolinks = new Map(), targets = [], definitions = new Map(), references = [];
  const fail = () => { throw rendererAmbiguity("missing or ambiguous source mapping"); };
  function destination(token) {
    const node = this.stack.at(-1);
    if (destinations.has(node)) fail();
    let start = token.start.offset, end = token.end.offset;
    if (readme[start] === "<") { if (readme[end - 1] !== ">") fail(); start++; end--; }
    destinations.set(node, { node, start, end, kind: "markdown" });
  }
  function autolinkMarker(token) {
    const node = this.stack.at(-1);
    if (readme.slice(token.start.offset, token.end.offset) === "<") autolinks.set(node, token.end.offset);
    else {
      if (!autolinks.has(node) || destinations.has(node)) fail();
      const start = autolinks.get(node), end = token.start.offset;
      // Renderers disagree on entity/escape decoding in URI autolinks. Reject
      // these raw spellings rather than guessing or recursively decoding them.
      const raw = readme.slice(start, end);
      if (raw.includes("&") || raw.includes("\\")) {
        throw Object.assign(new Error("Ambiguous VSIX README autolink: '&' and backslashes are not supported; use a normal Markdown link with an unambiguous URL instead."), {
          code: "VSIX_README_AMBIGUOUS_AUTOLINK",
        });
      }
      destinations.set(node, { node, start, end, kind: "autolink" });
      autolinks.delete(node);
    }
  }
  // These token exits have no default mdast handler. Observe positions without
  // replacing the parser's decoding or link construction (including autolinks).
  const tree = fromMarkdown(readme, { mdastExtensions: [{ exit: {
    resourceDestination: destination, definitionDestination: destination, autolinkMarker,
  } }] });
  const walk = (node, insideLink = false, container = false) => {
    if (["link", "image", "definition"].includes(node.type)) {
      const target = destinations.get(node);
      if (!target || typeof node.url !== "string" || !Number.isSafeInteger(target.start) || !Number.isSafeInteger(target.end)
        || target.start < node.position.start.offset || target.end > node.position.end.offset || target.end <= target.start) fail();
      targets.push({ ...target, url: node.url }); destinations.delete(node);
      if (node.type === "definition") {
        // Preserve the conservative contract for definitions inside containers.
        if (container || definitions.has(node.identifier)) fail();
        definitions.set(node.identifier, node);
      }
    } else if (["linkReference", "imageReference"].includes(node.type)) references.push(node);
    else if (node.type === "html") targets.push(...htmlReadmeTargets(node, readme));
    else if (node.type === "text" && !insideLink) {
      // GFM may auto-link bare text that CommonMark leaves as text. This is only
      // a conservative unsupported-syntax guard; parsed URLs decide ownership.
      for (const match of node.value.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
        if (bindRepositoryContentUrl(match[0], sourceRef) !== match[0]) throw new Error("Unsupported VSIX README repository link syntax");
      }
    }
    for (const child of node.children || []) walk(child, insideLink || ["link", "linkReference"].includes(node.type), container || ["blockquote", "listItem"].includes(node.type));
  };
  walk(tree);
  if (destinations.size || autolinks.size || references.some((node) => !definitions.has(node.identifier))) fail();
  targets.sort((left, right) => left.start - right.start);
  for (let index = 1; index < targets.length; index++) if (targets[index].start < targets[index - 1].end) fail();
  return { tree, targets };
}

function rendererAmbiguity(detail) {
  return Object.assign(new Error(`Ambiguous VSIX README renderer interpretation: ${detail}`), { code: "VSIX_README_RENDERER_AMBIGUITY" });
}

export function verifyReadmeRendererAgreement(source) {
  // Marked normalizes line endings before lexing. Use that same coordinate
  // space for both graphs; replacements still use the original mdast offsets.
  const readme = source.replace(/\r\n?/g, "\n");
  const tree = fromMarkdown(readme), definitions = new Map(), mdast = [];
  const fail = (detail) => { throw rendererAmbiguity(detail); };
  const define = (node) => {
    if (node.type === "definition") {
      if (definitions.has(node.identifier)) fail("duplicate reference definition");
      definitions.set(node.identifier, node);
    }
    for (const child of node.children || []) define(child);
  };
  define(tree);
  const range = (node) => ({ start: node.position.start.offset, end: node.position.end.offset });
  const htmlEntries = (node) => htmlReadmeTargets(node, readme).map((target) => ({
    kind: target.occurrenceKind, url: target.url, start: target.start, end: target.end,
  }));
  const visit = (node) => {
    if (["link", "image", "linkReference", "imageReference"].includes(node.type)) {
      const target = node.type.endsWith("Reference") ? definitions.get(node.identifier) : node;
      if (!target) fail("unresolved reference");
      mdast.push({ kind: node.type.startsWith("image") ? "image" : "link", url: target.url, ...range(node) });
    } else if (node.type === "html") mdast.push(...htmlEntries(node));
    for (const child of node.children || []) visit(child);
  };
  visit(tree);

  const renderer = new Renderer(), marked = new Marked();
  marked.setOptions({ renderer, gfm: true, async: false });
  const tokens = marked.lexer(readme), positions = new WeakMap(), rendered = [];
  // Locate raw tokens inside their enclosing raw source range, in sibling order.
  // Never search the whole document for an isolated link. Repeated references
  // remain distinct; a missing/rewritten/overlapping range is rejected.
  const locate = (siblings, start, end) => {
    let cursor = start;
    for (const token of siblings) {
      if (typeof token.raw !== "string" || !token.raw || positions.has(token)) fail("missing token source range");
      const offset = readme.indexOf(token.raw, cursor), limit = offset + token.raw.length;
      if (offset < cursor || limit > end) fail("unmappable token source range");
      positions.set(token, { start: offset, end: limit });
      cursor = limit;
      if (token.type === "image") continue; // Alt text never emits nested links/images.
      if (token.tokens) locate(token.tokens, offset, limit);
      if (token.items) locate(token.items, offset, limit);
      if (token.type === "table") {
        const cells = [...token.header, ...token.rows.flat()];
        locate(cells.flatMap((cell) => cell.tokens), offset, limit);
      }
    }
  };
  locate(tokens, 0, readme.length);
  // Read the default renderer's quoted attribute, not token.href: Marked leaves
  // some entity spellings for HTML to decode. This separate HTML decoding step
  // doubles backslashes so it cannot apply Markdown escape semantics again.
  const renderedTarget = (html, kind) => {
    const prefix = kind === "link" ? '<a href="' : '<img src="';
    if (!html.startsWith(prefix)) fail("renderer omitted a link target");
    const end = html.indexOf('"', prefix.length);
    if (end < 0) fail("missing rendered attribute boundary");
    const attribute = html.slice(prefix.length, end);
    const nodes = fromMarkdown(`[target](<${attribute.replaceAll("\\", "\\\\")}>)`).children[0]?.children;
    if (nodes?.length !== 1 || nodes[0].type !== "link") fail("unreadable rendered attribute");
    return nodes[0].url;
  };
  for (const kind of ["link", "image"]) {
    const original = renderer[kind];
    renderer[kind] = function (token) {
      const position = positions.get(token);
      if (!position) fail("rendered occurrence without source position");
      const entry = { kind, ...position };
      rendered.push(entry); // Parent link precedes any image rendered inside it.
      const html = original.call(this, token);
      entry.url = renderedTarget(html, kind);
      return html;
    };
  }
  const originalHtml = renderer.html;
  renderer.html = function (token) {
    const position = positions.get(token);
    if (!position || token.text !== readme.slice(position.start, position.end)) fail("unmappable raw HTML");
    rendered.push(...htmlEntries({ position: { start: { offset: position.start }, end: { offset: position.end } } }));
    return originalHtml.call(this, token);
  };
  marked.parser(tokens);
  // URI serialization (e.g. Unicode/space percent encoding) is not Markdown
  // decoding. A fixed synthetic base also covers relative files and anchors.
  const effective = (url) => {
    try { return new URL(url, "https://readme.invalid/").href; }
    catch { return fail("invalid semantic URL"); }
  };
  if (mdast.length !== rendered.length) fail("different occurrence counts");
  for (let index = 0; index < mdast.length; index++) {
    const left = mdast[index], right = rendered[index];
    if (left.kind !== right.kind || left.start !== right.start || left.end !== right.end || effective(left.url) !== effective(right.url)) {
      fail(`different target, kind or source position at occurrence ${index + 1}`);
    }
  }
  return { mdast, marked: rendered };
}

function htmlReadmeTargets(node, readme) {
  // Raw HTML is a separate syntax. Retain a bounded, quoted-attribute subset;
  // never apply Markdown backslash semantics to an HTML attribute.
  const targets = [], limit = node.position.end.offset;
  let pos = node.position.start.offset;
  while (pos < limit) {
    if (readme[pos] !== "<") { pos++; continue; }
    pos++;
    const closing = readme[pos] === "/";
    if (closing) pos++;
    const tag = /^[A-Za-z]+/.exec(readme.slice(pos, limit));
    if (!tag || !["a", "img", "p", "br", "div", "span", "em", "strong", "b", "i", "small", "sub", "sup", "details", "summary", "kbd", "code", "hr"].includes(tag[0].toLowerCase())) throw new Error("Unsupported VSIX README HTML tag");
    pos += tag[0].length;
    const seen = new Set();
    while (pos < limit) {
      while (readme[pos]?.trim() === "") pos++;
      if (readme[pos] === ">") { pos++; break; }
      if (readme.slice(pos, pos + 2) === "/>") { pos += 2; break; }
      const name = /^[A-Za-z_:][A-Za-z0-9_:.-]*/.exec(readme.slice(pos, limit));
      if (closing || !name) throw new Error("Unsupported VSIX README HTML attribute");
      pos += name[0].length;
      while (readme[pos]?.trim() === "") pos++;
      if (readme[pos++] !== "=") throw new Error("VSIX README HTML attributes must have quoted values");
      while (readme[pos]?.trim() === "") pos++;
      const quote = readme[pos++];
      if (quote !== '"' && quote !== "'") throw new Error("VSIX README HTML attributes must have quoted values");
      const end = readme.indexOf(quote, pos);
      if (end < 0 || end >= limit) throw new Error("Unterminated VSIX README HTML attribute");
      const key = name[0].toLowerCase();
      if (seen.has(key)) throw new Error("Duplicate VSIX README HTML attribute");
      seen.add(key);
      if (["srcset", "imagesrcset", "poster", "background", "xlink:href"].includes(key)) throw rendererAmbiguity("unmapped HTML resource attribute");
      if (key === "href" || key === "src") {
        if ((key === "href" && tag[0].toLowerCase() !== "a") || (key === "src" && tag[0].toLowerCase() !== "img")) throw rendererAmbiguity("unsupported link-bearing HTML attribute");
        const raw = readme.slice(pos, end);
        // In HTML attributes, an unterminated named reference followed by '='
        // stays literal. Other unterminated references are deliberately rejected.
        const attribute = raw.replace(/&(?!(?:[A-Za-z][A-Za-z0-9]*|#[0-9]+|#x[0-9A-Fa-f]+);)/g, (amp, offset) => {
          if (!/^[A-Za-z][A-Za-z0-9_-]*=/.test(raw.slice(offset + 1))) throw new Error("Ambiguous VSIX README HTML entity");
          return "&amp;";
        });
        const url = xmlJs.xml2js(`<link value=${quote}${attribute}${quote}/>`, { compact: true }).link._attributes.value;
        // Cross-check the strict XML subset with the Markdown entity decoder;
        // reject XML-only case folding or numeric behavior rather than guessing.
        const probe = fromMarkdown(`[target](<${raw.replaceAll("\\", "\\\\")}>)`).children[0]?.children;
        if (probe?.length !== 1 || probe[0].type !== "link" || probe[0].url !== url) throw new Error("Ambiguous VSIX README HTML entity semantics");
        targets.push({ node, start: pos, end, quote, kind: "html", occurrenceKind: key === "href" ? "link" : "image", url });
      }
      pos = end + 1;
    }
    if (readme[pos - 1] !== ">") throw new Error("Unterminated VSIX README HTML tag");
  }
  return targets;
}

async function copyVerifiedFile(source, destination, stageOwned, stage) {
  const sourceBytes = await fs.readFile(source);
  await writeOwnedStageFile(stageOwned, stage, destination, sourceBytes);
  const destinationBytes = await fs.readFile(destination);
  if (!sourceBytes.equals(destinationBytes)) {
    throw new Error(`Packaged source copy differs from its source: ${path.basename(source)}`);
  }
  return createHash("sha256").update(sourceBytes).digest("hex");
}

async function packageExporterRuntime({ repoRoot, stage, stageOwned }) {
  const packageSource = await fs.readFile(path.join(repoRoot, "package.json"), "utf8");
  const lockSource = await fs.readFile(path.join(repoRoot, "package-lock.json"), "utf8");
  const packageJson = parseJsonFile(packageSource, "root package.json");
  const packageLock = parseJsonFile(lockSource, "root package-lock.json");
  validateProductionLock(packageJson, packageLock);
  const runtimeHashes = new Map();
  const copyRuntimeFile = async (source, relativePath) => {
    const normalized = normalizeRuntimeRelativePath(relativePath);
    const destination = path.join(stage, RUNTIME_ROOT, ...normalized.split("/"));
    await ensureOwnedStageDirectory(stageOwned, stage, path.dirname(path.join(RUNTIME_ROOT, ...normalized.split("/"))));
    const hash = await copyVerifiedFile(source, destination, stageOwned, stage);
    runtimeHashes.set(normalized, hash);
  };

  // Build-only dependencies must not leak through either files or runtime metadata.
  const productionPackage = structuredClone(packageJson), productionLock = structuredClone(packageLock);
  delete productionPackage.devDependencies;
  delete productionLock.packages[""].devDependencies;
  for (const [key, entry] of Object.entries(productionLock.packages)) if (entry.dev === true) delete productionLock.packages[key];
  for (const [relativePath, value, source] of [
    ["package.json", productionPackage, packageSource], ["package-lock.json", productionLock, lockSource],
  ]) {
    // Omit fields by parsed object identity while retaining every other source
    // byte, including mixed line endings in the existing production manifests.
    const bytes = Buffer.from(projectJsonSource(source, value));
    await writeOwnedStageFile(stageOwned, stage, path.join(stage, RUNTIME_ROOT, relativePath), bytes);
    runtimeHashes.set(relativePath, createHash("sha256").update(bytes).digest("hex"));
  }
  for (const relativePath of ["LICENSE", "bin/export-codex-project-chats.mjs"]) {
    await copyRuntimeFile(path.join(repoRoot, ...relativePath.split("/")), relativePath);
  }
  await copyRuntimeDirectory(path.join(repoRoot, "lib"), "lib", copyRuntimeFile);
  await copyRuntimeDirectory(path.join(repoRoot, "fonts"), "fonts", copyRuntimeFile);

  const licenseSections = [
    "Third-party production dependencies bundled in this VSIX",
    "Generated deterministically from package-lock.json and installed package metadata.",
    "",
  ];
  const productionPackages = Object.entries(packageLock.packages)
    .filter(([key, value]) => key.startsWith("node_modules/") && value?.dev !== true)
    .sort(([left], [right]) => compareOrdinal(left, right));
  for (const [lockPath, lockEntry] of productionPackages) {
    const installedRoot = path.join(repoRoot, ...lockPath.split("/"));
    const installedPackage = parseJsonFile(await fs.readFile(path.join(installedRoot, "package.json"), "utf8"), `${lockPath}/package.json`);
    validateInstalledProductionPackage(lockPath, lockEntry, installedPackage);
    await copyRuntimeDirectory(installedRoot, lockPath, copyRuntimeFile, { skipNestedPackageTree: true });
    const licenseSources = await selectLicenseSources(installedRoot);
    licenseSections.push(
      `Package: ${installedPackage.name}@${installedPackage.version}`,
      `Declared license: ${String(installedPackage.license || lockEntry.license || "UNKNOWN")}`,
      `Source: ${licenseSources.map((name) => `${lockPath}/${name}`).join(", ")}`,
    );
    for (const name of licenseSources) {
      licenseSections.push("", await fs.readFile(path.join(installedRoot, name), "utf8"), "");
    }
    licenseSections.push("----", "");
  }
  const fontLicense = await fs.readFile(path.join(repoRoot, "fonts", "OFL.txt"), "utf8");
  const symbolFontLicense = await fs.readFile(path.join(repoRoot, "fonts", "OFL-SYMBOLS.txt"), "utf8");
  const emojiFontLicense = await fs.readFile(path.join(repoRoot, "fonts", "OFL-EMOJI.txt"), "utf8");
  licenseSections.push(
    "Bundled font assets",
    "Noto Sans 2.015 and Noto Sans Mono 2.014",
    "Declared license: SIL Open Font License 1.1",
    "Source: fonts/OFL.txt",
    "",
    fontLicense,
    "",
    "----",
    "",
    "Bundled symbol font assets",
    "Noto Sans Symbols 2.003 and Noto Sans Symbols 2 2.008",
    "Declared license: SIL Open Font License 1.1",
    "Source: fonts/OFL-SYMBOLS.txt",
    "",
    symbolFontLicense,
    "",
    "----",
    "",
    "Bundled monochrome emoji font asset",
    "Noto Emoji 3.002 at Google Fonts commit ade3d1533e06b2b1462ffcde8e08b129627ca360",
    "Declared license: SIL Open Font License 1.1",
    "Source: fonts/OFL-EMOJI.txt",
    "",
    emojiFontLicense,
    "",
    "----",
    "",
  );
  const thirdPartyRelative = "THIRD_PARTY_LICENSES.txt";
  const thirdPartyBytes = Buffer.from(`${licenseSections.join("\n").replaceAll("\r\n", "\n").trimEnd()}\n`, "utf8");
  await writeOwnedStageFile(stageOwned, stage, path.join(stage, RUNTIME_ROOT, thirdPartyRelative), thirdPartyBytes);
  runtimeHashes.set(thirdPartyRelative, createHash("sha256").update(thirdPartyBytes).digest("hex"));

  const integrity = Object.fromEntries([...runtimeHashes].sort(([left], [right]) => compareOrdinal(left, right)));
  await writeOwnedStageFile(
    stageOwned,
    stage,
    path.join(stage, RUNTIME_ROOT, "integrity.json"),
    `${JSON.stringify({ format: 1, files: integrity }, null, 2)}\n`,
  );
  return path.join(stage, RUNTIME_ROOT, "bin", "export-codex-project-chats.mjs");
}

function projectJsonSource(source, projected) {
  const edits = [];
  let pos = 0;
  const whitespace = () => { while ([" ", "\t", "\r", "\n"].includes(source[pos])) pos++; };
  const string = () => {
    const start = pos++;
    while (pos < source.length) {
      if (source[pos++] === '"') return JSON.parse(source.slice(start, pos));
      if (source[pos - 1] === "\\") pos++;
    }
    throw new Error("Unterminated runtime manifest string");
  };
  const value = (selection, retain) => {
    whitespace();
    if (source[pos] === '"') { string(); return; }
    if (source[pos] === "[") {
      pos++; whitespace();
      let index = 0;
      while (source[pos] !== "]") {
        value(selection?.[index++], retain); whitespace();
        if (source[pos] !== ",") break;
        pos++;
      }
      if (source[pos++] !== "]") throw new Error("Invalid runtime manifest array");
      return;
    }
    if (source[pos] !== "{") {
      while (pos < source.length && ![",", "}", "]", " ", "\t", "\r", "\n"].includes(source[pos])) pos++;
      return;
    }
    const start = pos++, fields = [], seen = new Set();
    whitespace();
    while (source[pos] !== "}") {
      if (source[pos] !== '"') throw new Error("Invalid runtime manifest object key");
      const key = string();
      if (seen.has(key)) throw new Error("Duplicate runtime manifest object key");
      seen.add(key); whitespace();
      if (source[pos++] !== ":") throw new Error("Invalid runtime manifest object");
      const keep = Object.hasOwn(selection || {}, key);
      value(selection?.[key], retain && keep);
      const end = pos;
      whitespace();
      const comma = source[pos] === "," ? pos++ : null;
      fields.push({ keep, end, comma });
      whitespace();
      if (comma === null) break;
    }
    if (source[pos++] !== "}") throw new Error("Invalid runtime manifest object end");
    if (!retain) return;
    for (let first = 0; first < fields.length; first++) {
      if (fields[first].keep) continue;
      let last = first;
      while (last + 1 < fields.length && !fields[last + 1].keep) last++;
      const following = last + 1 < fields.length;
      edits.push({
        start: first === 0 ? start + 1 : fields[first - 1].comma + (following ? 1 : 0),
        end: following ? fields[last].comma + 1 : fields[last].end,
      });
      first = last;
    }
  };
  // JSON.parse is the grammar/semantic validator; the scanner only locates fields.
  JSON.parse(source);
  value(projected, true); whitespace();
  if (pos !== source.length) throw new Error("Unmapped runtime manifest source bytes");
  let result = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + result.slice(edit.end);
  if (JSON.stringify(JSON.parse(result)) !== JSON.stringify(projected)) throw new Error("Runtime manifest projection differs from production metadata");
  return result;
}

function validateProductionLock(packageJson, packageLock) {
  if (!Number.isSafeInteger(packageLock?.lockfileVersion) || packageLock.lockfileVersion < 3 || !packageLock.packages || typeof packageLock.packages !== "object") {
    throw new Error("package-lock.json must be a reproducible npm lockfileVersion 3 package map");
  }
  const declared = packageJson.dependencies || {};
  const locked = packageLock.packages[""]?.dependencies || {};
  if (JSON.stringify(sortObject(declared)) !== JSON.stringify(sortObject(locked))) throw new Error("package.json production dependencies differ from package-lock.json");
  for (const script of ["preinstall", "install", "postinstall"]) {
    if (typeof packageJson.scripts?.[script] === "string") throw new Error(`Root package contains an install script: ${script}`);
  }
  for (const [lockPath, entry] of Object.entries(packageLock.packages)) {
    if (!lockPath.startsWith("node_modules/") || entry?.dev === true) continue;
    if (typeof entry.version !== "string" || !entry.version || typeof entry.integrity !== "string" || !entry.integrity.startsWith("sha512-")) {
      throw new Error(`Production dependency lacks a reproducible version or SHA-512 lock entry: ${lockPath}`);
    }
    if (typeof entry.resolved !== "string" || !entry.resolved.startsWith("https://registry.npmjs.org/")) {
      throw new Error(`Production dependency has an unexpected resolution source: ${lockPath}`);
    }
    if (entry.hasInstallScript === true) throw new Error(`Production dependency declares an install script: ${lockPath}`);
  }
}

function validateInstalledProductionPackage(lockPath, lockEntry, installedPackage) {
  const expectedName = lockEntry.name || lockPath.slice(lockPath.lastIndexOf("node_modules/") + "node_modules/".length);
  if (installedPackage.name !== expectedName || installedPackage.version !== lockEntry.version) {
    throw new Error(`Installed production dependency differs from package-lock.json: ${lockPath}`);
  }
  for (const script of ["preinstall", "install", "postinstall"]) {
    if (typeof installedPackage.scripts?.[script] === "string") throw new Error(`Production dependency contains an install script: ${installedPackage.name} (${script})`);
  }
}

async function copyRuntimeDirectory(sourceRoot, runtimeRelativeRoot, copyRuntimeFile, options = {}) {
  const rootStat = await fs.lstat(sourceRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`Runtime source must be a regular directory: ${sourceRoot}`);
  const canonical = await fs.realpath(sourceRoot);
  if (buildPathKey(canonical) !== buildPathKey(sourceRoot)) throw new Error(`Runtime source directory resolves through an alias: ${sourceRoot}`);
  async function visit(directory, relativeDirectory) {
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((left, right) => compareOrdinal(left.name, right.name));
    for (const entry of entries) {
      if (options.skipNestedPackageTree && directory === sourceRoot && entry.name === "node_modules" && entry.isDirectory()) continue;
      const source = path.join(directory, entry.name);
      const relative = `${relativeDirectory}/${entry.name}`;
      const stat = await fs.lstat(source);
      if (stat.isSymbolicLink()) throw new Error(`Symbolic links are forbidden in the packaged runtime: ${relative}`);
      if (stat.isDirectory()) {
        await visit(source, relative);
      } else if (stat.isFile()) {
        if (FORBIDDEN_NATIVE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) throw new Error(`Native binary is forbidden in the packaged runtime: ${relative}`);
        await copyRuntimeFile(source, relative);
      } else {
        throw new Error(`Special files are forbidden in the packaged runtime: ${relative}`);
      }
    }
  }
  await visit(sourceRoot, runtimeRelativeRoot);
}

async function selectLicenseSources(packageRoot) {
  const names = await fs.readdir(packageRoot);
  const licenseFiles = names.filter((name) => {
    const lower = name.toLowerCase();
    return lower.startsWith("license") || lower.startsWith("copying") || lower.startsWith("notice");
  }).sort(compareOrdinal);
  if (licenseFiles.length) return licenseFiles;
  const readme = names.filter((name) => name.toLowerCase().startsWith("readme")).sort(compareOrdinal)[0];
  if (!readme) throw new Error(`Production dependency lacks a license or README source: ${packageRoot}`);
  return [readme];
}

async function ensureOwnedStageDirectory(stageOwned, stage, relativePath) {
  const normalized = String(relativePath).replaceAll("\\", "/");
  let current = path.resolve(stage);
  for (const segment of normalized.split("/").filter(Boolean)) {
    current = path.join(current, segment);
    if (stageOwned.byPath.has(buildPathKey(current))) continue;
    await createOwnedStageDirectory(stageOwned, stage, path.relative(stage, current));
  }
}

function normalizeRuntimeRelativePath(relativePath) {
  const normalized = String(relativePath).replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (!normalized || normalized.startsWith("/") || segments.some((segment) => !segment || segment === "." || segment === "..")) throw new Error(`Unsafe packaged runtime path: ${relativePath}`);
  return normalized;
}

function parseJsonFile(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid ${label}: ${error?.message || error}`, { cause: error });
  }
}

function sortObject(value) {
  return Object.fromEntries(Object.entries(value || {}).sort(([left], [right]) => compareOrdinal(left, right)));
}

async function createOwnedStageDirectory(stageOwned, stage, relativePath) {
  const candidate = path.resolve(stage, relativePath);
  assertPathInside(stage, candidate);
  await verifyOwnedStageParent(stageOwned, stage, candidate);
  await assertPathAbsent(candidate, "VSIX stage directory");
  await fs.mkdir(candidate);
  const owned = await inspectOwnedStagePath(candidate, stage, "directory");
  stageOwned.directories.push(owned);
  stageOwned.byPath.set(buildPathKey(candidate), owned);
}

async function writeOwnedStageFile(stageOwned, stage, destination, bytes) {
  const candidate = path.resolve(destination);
  assertPathInside(stage, candidate);
  await verifyOwnedStageParent(stageOwned, stage, candidate);
  let handle;
  let owned;
  try {
    handle = await fs.open(candidate, "wx");
    const initialStat = await handle.stat({ bigint: true });
    const identity = reliableBuildIdentity(initialStat);
    if (!initialStat.isFile() || !identity) throw new Error(`Reliable regular-file identity is unavailable for VSIX stage file: ${candidate}`);
    owned = { path: candidate, identity, kind: "file" };
    stageOwned.files.push(owned);
    stageOwned.byPath.set(buildPathKey(candidate), owned);
    await handle.writeFile(bytes);
    const finalStat = await handle.stat({ bigint: true });
    if (!finalStat.isFile() || reliableBuildIdentity(finalStat) !== identity) throw new Error(`VSIX stage file identity changed while writing: ${candidate}`);
  } finally {
    await handle?.close();
  }
  const current = await inspectOwnedStagePath(candidate, stage, "file");
  if (current.identity !== owned.identity) throw new Error(`VSIX stage file changed after writing: ${candidate}`);
}

async function verifyOwnedStageParent(stageOwned, stage, candidate) {
  const parent = path.dirname(candidate);
  const expected = stageOwned.byPath.get(buildPathKey(parent));
  if (!expected) throw new Error(`VSIX stage parent was not created by this build: ${parent}`);
  const current = parent === path.resolve(stage)
    ? await inspectOwnedBuildPath(parent, path.dirname(parent), "directory")
    : await inspectOwnedStagePath(parent, stage, "directory");
  if (current.identity !== expected.identity) throw new Error(`VSIX stage parent identity changed before mutation: ${parent}`);
}

async function inspectOwnedStagePath(candidate, stage, kind) {
  assertPathInside(stage, candidate);
  const stat = await fs.lstat(candidate, { bigint: true });
  if (stat.isSymbolicLink()) throw new Error(`Refusing a symbolic-link VSIX stage artifact: ${candidate}`);
  if (kind === "file" && !stat.isFile()) throw new Error(`Expected a regular VSIX stage file: ${candidate}`);
  if (kind === "directory" && !stat.isDirectory()) throw new Error(`Expected a VSIX stage directory: ${candidate}`);
  const canonical = await fs.realpath(candidate);
  if (buildPathKey(canonical) !== buildPathKey(candidate)) throw new Error(`VSIX stage artifact resolves through an alias: ${candidate}`);
  const identity = reliableBuildIdentity(stat);
  if (!identity) throw new Error(`Reliable identity is unavailable for VSIX stage artifact: ${candidate}`);
  return { path: candidate, identity, kind };
}

async function verifyOwnedStageForArchive(stageOwned, stage, distDir) {
  const currentRoot = await inspectOwnedBuildPath(stage, distDir, "directory");
  if (currentRoot.identity !== stageOwned.root.identity) throw new Error(`VSIX stage root identity changed before archive creation: ${stage}`);
  const expected = new Map([
    ...stageOwned.directories.map((owned) => [buildPathKey(owned.path), owned]),
    ...stageOwned.files.map((owned) => [buildPathKey(owned.path), owned]),
  ]);
  const discovered = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      const owned = expected.get(buildPathKey(candidate));
      if (!owned) throw new Error(`Unexpected VSIX stage content must be reviewed manually: ${candidate}`);
      const current = await inspectOwnedStagePath(candidate, stage, owned.kind);
      if (current.identity !== owned.identity) throw new Error(`VSIX stage artifact identity changed before archive creation: ${candidate}`);
      discovered.push(buildPathKey(candidate));
      if (owned.kind === "directory") await visit(candidate);
    }
  }
  await visit(stage);
  if (discovered.length !== expected.size || discovered.some((key) => !expected.has(key))) {
    throw new Error("VSIX stage contents no longer match the run-owned build ledger");
  }
}

async function removeOwnedStage(stageOwned, stage, distDir) {
  for (const owned of [...stageOwned.files].reverse()) {
    const current = await inspectOwnedStagePath(owned.path, stage, "file");
    if (current.identity !== owned.identity) throw new Error(`Refusing to remove a VSIX stage file whose identity changed: ${owned.path}`);
    await fs.unlink(owned.path);
  }
  for (const owned of [...stageOwned.directories].reverse()) {
    const current = await inspectOwnedStagePath(owned.path, stage, "directory");
    if (current.identity !== owned.identity) throw new Error(`Refusing to remove a VSIX stage directory whose identity changed: ${owned.path}`);
    await fs.rmdir(owned.path);
  }
  const currentRoot = await inspectOwnedBuildPath(stage, distDir, "directory");
  if (currentRoot.identity !== stageOwned.root.identity) throw new Error(`Refusing to remove a VSIX stage root whose identity changed: ${stage}`);
  await fs.rmdir(stage);
}

async function listUnexpectedDistArtifacts(distDir, allowedCandidate) {
  const unexpected = [];
  for (const entry of await fs.readdir(distDir, { withFileTypes: true })) {
    const candidate = path.join(distDir, entry.name);
    assertDirectChild(distDir, candidate);
    if (path.resolve(candidate) !== path.resolve(allowedCandidate)) unexpected.push(candidate);
  }
  return unexpected;
}

async function moveExactCandidateAside(vsixPath, distDir) {
  const existing = await inspectOwnedBuildPath(vsixPath, distDir, "file", true);
  if (!existing) return null;
  const backupPath = path.join(distDir, `${path.basename(vsixPath)}.previous-${randomUUID()}`);
  await assertPathAbsent(backupPath, "VSIX backup path");
  await fs.rename(vsixPath, backupPath);
  const moved = await inspectOwnedBuildPath(backupPath, distDir, "file");
  if (moved.identity !== existing.identity) throw new Error("Existing VSIX identity changed while moving it aside");
  return moved;
}

async function restoreExactCandidate(vsixPath, previousCandidate, distDir) {
  await assertPathAbsent(vsixPath, "VSIX restore destination");
  const current = await inspectOwnedBuildPath(previousCandidate.path, distDir, "file");
  if (current.identity !== previousCandidate.identity) throw new Error("Previous VSIX identity changed before restoration");
  await fs.rename(previousCandidate.path, vsixPath);
}

async function inspectOwnedBuildPath(candidate, distDir, kind, allowMissing = false) {
  assertDirectChild(distDir, candidate);
  let stat;
  try {
    stat = await fs.lstat(candidate, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT" && allowMissing) return null;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`Refusing a symbolic-link build artifact: ${candidate}`);
  if (kind === "file" && !stat.isFile()) throw new Error(`Expected a regular build file: ${candidate}`);
  if (kind === "directory" && !stat.isDirectory()) throw new Error(`Expected a build directory: ${candidate}`);
  const canonical = await fs.realpath(candidate);
  if (path.resolve(canonical) !== path.resolve(candidate)) throw new Error(`Build artifact resolves outside its controlled path: ${candidate}`);
  const identity = reliableBuildIdentity(stat);
  if (!identity) throw new Error(`Reliable file identity is unavailable for build artifact: ${candidate}`);
  return { path: candidate, identity, kind };
}

async function removeOwnedBuildPath(owned, distDir) {
  if (!owned) return;
  const current = await inspectOwnedBuildPath(owned.path, distDir, owned.kind);
  if (current.identity !== owned.identity) throw new Error(`Refusing to remove a build artifact whose identity changed: ${owned.path}`);
  if (owned.kind === "file") {
    await fs.unlink(owned.path);
    return;
  }
  await fs.rmdir(owned.path);
}

function reliableBuildIdentity(stat) {
  if (typeof stat?.dev === "bigint" && typeof stat?.ino === "bigint") {
    if (stat.dev < 0n || stat.ino <= 0n) return null;
    return `${stat.dev}:${stat.ino}`;
  }
  if (!Number.isSafeInteger(stat?.dev) || !Number.isSafeInteger(stat?.ino) || stat.dev < 0 || stat.ino <= 0) return null;
  return `${stat.dev}:${stat.ino}`;
}

async function assertPathAbsent(candidate, label) {
  try {
    await fs.lstat(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Refusing to overwrite unexpected ${label}: ${candidate}`);
}

function assertDirectChild(parent, candidate) {
  if (path.dirname(path.resolve(candidate)) !== path.resolve(parent)) {
    throw new Error(`Build artifact is outside the controlled dist directory: ${candidate}`);
  }
}

function assertPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`VSIX stage artifact is outside the controlled stage: ${candidate}`);
  }
}

function buildPathKey(candidate) {
  const resolved = path.resolve(candidate);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function createContentTypes(stageOwned, stage) {
  const known = new Map([
    ["cjs", "application/javascript"], ["js", "application/javascript"], ["json", "application/json"],
    ["map", "application/json"], ["md", "text/markdown"], ["markdown", "text/markdown"],
    ["mjs", "application/javascript"], ["svg", "image/svg+xml"], ["png", "image/png"], ["ttf", "font/ttf"], ["txt", "text/plain"],
    ["vsixmanifest", "text/xml"], ["xml", "text/xml"],
  ]);
  const extensions = new Set();
  const extensionless = [];
  for (const owned of stageOwned.files) {
    const relative = path.relative(stage, owned.path).replaceAll("\\", "/");
    const extension = path.posix.extname(relative).slice(1).toLowerCase();
    if (extension) extensions.add(extension);
    else extensionless.push(relative);
  }
  const defaults = [...extensions].sort(compareOrdinal).map((extension) => `  <Default Extension="${escapeXml(extension)}" ContentType="${escapeXml(known.get(extension) || "application/octet-stream")}"/>`);
  const overrides = extensionless.sort(compareOrdinal).map((relative) => `  <Override PartName="/${escapeXml(relative)}" ContentType="application/octet-stream"/>`);
  return `<?xml version="1.0" encoding="utf-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n${[...defaults, ...overrides].join("\n")}\n</Types>\n`;
}

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function writeZipArchive({ stage, archivePath }) {
  const zip = new JSZip();
  const files = [];
  async function visit(directory) {
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((left, right) => compareOrdinal(left.name, right.name));
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      const stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink()) throw new Error(`Symbolic links are forbidden in the VSIX archive: ${candidate}`);
      if (stat.isDirectory()) await visit(candidate);
      else if (stat.isFile()) files.push(candidate);
      else throw new Error(`Special files are forbidden in the VSIX archive: ${candidate}`);
    }
  }
  await visit(stage);
  for (const candidate of files.sort((left, right) => compareOrdinal(path.relative(stage, left), path.relative(stage, right)))) {
    const relative = path.relative(stage, candidate).replaceAll("\\", "/");
    zip.file(relative, await fs.readFile(candidate), {
      binary: true,
      createFolders: false,
      date: FIXED_ARCHIVE_DATE,
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    });
  }
  const bytes = await zip.generateAsync({ type: "nodebuffer", platform: "DOS", compression: "DEFLATE", compressionOptions: { level: 9 } });
  await fs.writeFile(archivePath, bytes, { flag: "wx" });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const result = await buildVsix();
  console.log(result.vsixPath);
}
