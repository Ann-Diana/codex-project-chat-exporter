import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const defaultExtensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultRepoRoot = path.resolve(defaultExtensionRoot, "..", "..");

export async function buildVsix(options = {}) {
  const extensionRoot = path.resolve(options.extensionRoot || defaultExtensionRoot);
  const repoRoot = path.resolve(options.repoRoot || defaultRepoRoot);
  const distDir = path.resolve(options.distDir || path.join(extensionRoot, "dist"));
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
    ]) {
      await createOwnedStageDirectory(stageOwned, stage, relative);
    }

    await copyVerifiedFile(path.join(extensionRoot, "package.json"), path.join(stage, "extension", "package.json"), stageOwned, stage);
    await copyVerifiedFile(path.join(extensionRoot, "README.md"), path.join(stage, "extension", "README.md"), stageOwned, stage);
    await copyVerifiedFile(path.join(extensionRoot, "PACKAGED_TEST_PLAN.md"), path.join(stage, "extension", "PACKAGED_TEST_PLAN.md"), stageOwned, stage);
    await copyVerifiedFile(path.join(extensionRoot, "LICENSE"), path.join(stage, "extension", "LICENSE"), stageOwned, stage);
    await copyVerifiedFile(path.join(extensionRoot, "images", "icon.png"), path.join(stage, "extension", "images", "icon.png"), stageOwned, stage);
    await copyVerifiedFile(path.join(extensionRoot, "src", "extension.cjs"), path.join(stage, "extension", "src", "extension.cjs"), stageOwned, stage);
    await copyVerifiedFile(path.join(extensionRoot, "src", "vscode-adapter.cjs"), path.join(stage, "extension", "src", "vscode-adapter.cjs"), stageOwned, stage);
    const packagedCore = path.join(stage, "extension", "vendor", "codex-project-chat-exporter", "bin", "export-codex-project-chats.mjs");
    const packagedCoreSha256 = await copyVerifiedFile(path.join(repoRoot, "bin", "export-codex-project-chats.mjs"), packagedCore, stageOwned, stage);
    await copyVerifiedFile(path.join(repoRoot, "LICENSE"), path.join(stage, "extension", "vendor", "codex-project-chat-exporter", "LICENSE"), stageOwned, stage);
    await writeOwnedStageFile(stageOwned, stage, path.join(stage, "extension", "vendor", "codex-project-chat-exporter", "integrity.json"), `${JSON.stringify({ format: 1, files: { "bin/export-codex-project-chats.mjs": packagedCoreSha256 } }, null, 2)}\n`);

    await writeOwnedStageFile(stageOwned, stage, path.join(stage, "[Content_Types].xml"), `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json"/>
  <Default Extension="md" ContentType="text/markdown"/>
  <Default Extension="txt" ContentType="text/plain"/>
  <Default Extension="cjs" ContentType="application/javascript"/>
  <Default Extension="mjs" ContentType="application/javascript"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="vsixmanifest" ContentType="text/xml"/>
  <Default Extension="xml" ContentType="text/xml"/>
</Types>
`);

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
    </Properties>
    <License>extension/LICENSE</License>
    <ProjectUrl>${escapeXml(packageJson.homepage)}</ProjectUrl>
    <Repository>${escapeXml(packageJson.repository.url)}</Repository>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/images/icon.png" Addressable="true"/>
  </Assets>
</PackageManifest>
`);

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

async function copyVerifiedFile(source, destination, stageOwned, stage) {
  const sourceBytes = await fs.readFile(source);
  await writeOwnedStageFile(stageOwned, stage, destination, sourceBytes);
  const destinationBytes = await fs.readFile(destination);
  if (!sourceBytes.equals(destinationBytes)) {
    throw new Error(`Packaged source copy differs from its source: ${path.basename(source)}`);
  }
  return createHash("sha256").update(sourceBytes).digest("hex");
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

function powershellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function createZipCommand(sourceDirectory, destinationFile) {
  const source = powershellLiteral(sourceDirectory);
  const destination = powershellLiteral(destinationFile);
  return `Add-Type -AssemblyName System.IO.Compression; $source=${source}; $stream=[System.IO.File]::Open(${destination}, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None); $archive=[System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create, $false); try { Get-ChildItem -LiteralPath $source -File -Recurse | Sort-Object FullName | ForEach-Object { $relative=$_.FullName.Substring($source.Length).TrimStart([System.IO.Path]::DirectorySeparatorChar).Replace([System.IO.Path]::DirectorySeparatorChar, [char]'/'); $entry=$archive.CreateEntry($relative, [System.IO.Compression.CompressionLevel]::Optimal); $input=[System.IO.File]::OpenRead($_.FullName); $output=$entry.Open(); try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() } } } finally { $archive.Dispose(); $stream.Dispose() }`;
}

async function writeZipArchive({ stage, archivePath }) {
  await execFileAsync("powershell.exe", ["-NoProfile", "-Command", createZipCommand(stage, archivePath)]);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const result = await buildVsix();
  console.log(result.vsixPath);
}
