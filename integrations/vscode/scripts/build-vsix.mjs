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
  const stageOwned = await inspectOwnedBuildPath(stage, distDir, "directory");
  const archivePath = path.join(distDir, `${vsixBase}.vsix.partial-${randomUUID()}`);
  const archiveHandle = await fs.open(archivePath, "wx");
  const archiveStat = await archiveHandle.stat({ bigint: true });
  await archiveHandle.close();
  const archiveOwned = { path: archivePath, identity: reliableBuildIdentity(archiveStat), kind: "file" };
  if (!archiveOwned.identity) throw new Error(`Reliable file identity is unavailable for build artifact: ${archivePath}`);
  let archiveCurrent = archiveOwned;
  let previousCandidate = null;
  let publishedCandidate = null;

  try {
    await fs.mkdir(path.join(stage, "extension", "src"), { recursive: true });
    await fs.mkdir(path.join(stage, "extension", "images"), { recursive: true });
    await fs.mkdir(path.join(stage, "extension", "vendor", "codex-project-chat-exporter", "bin"), { recursive: true });

    await copyVerifiedFile(path.join(extensionRoot, "package.json"), path.join(stage, "extension", "package.json"));
    await copyVerifiedFile(path.join(extensionRoot, "README.md"), path.join(stage, "extension", "README.md"));
    await copyVerifiedFile(path.join(extensionRoot, "PACKAGED_TEST_PLAN.md"), path.join(stage, "extension", "PACKAGED_TEST_PLAN.md"));
    await copyVerifiedFile(path.join(extensionRoot, "LICENSE"), path.join(stage, "extension", "LICENSE"));
    await copyVerifiedFile(path.join(extensionRoot, "images", "icon.png"), path.join(stage, "extension", "images", "icon.png"));
    await copyVerifiedFile(path.join(extensionRoot, "src", "extension.cjs"), path.join(stage, "extension", "src", "extension.cjs"));
    await copyVerifiedFile(path.join(extensionRoot, "src", "vscode-adapter.cjs"), path.join(stage, "extension", "src", "vscode-adapter.cjs"));
    const packagedCore = path.join(stage, "extension", "vendor", "codex-project-chat-exporter", "bin", "export-codex-project-chats.mjs");
    const packagedCoreSha256 = await copyVerifiedFile(path.join(repoRoot, "bin", "export-codex-project-chats.mjs"), packagedCore);
    await copyVerifiedFile(path.join(repoRoot, "LICENSE"), path.join(stage, "extension", "vendor", "codex-project-chat-exporter", "LICENSE"));
    await fs.writeFile(path.join(stage, "extension", "vendor", "codex-project-chat-exporter", "integrity.json"), `${JSON.stringify({ format: 1, files: { "bin/export-codex-project-chats.mjs": packagedCoreSha256 } }, null, 2)}\n`, "utf8");

    await fs.writeFile(path.join(stage, "[Content_Types].xml"), `<?xml version="1.0" encoding="utf-8"?>
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
`, "utf8");

    await fs.writeFile(path.join(stage, "extension.vsixmanifest"), `<?xml version="1.0" encoding="utf-8"?>
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
`, "utf8");

    await archiveWriter({ stage, archivePath });
    archiveCurrent = await inspectOwnedBuildPath(archivePath, distDir, "file");
    if (archiveCurrent.identity !== archiveOwned.identity) throw new Error("Temporary VSIX identity changed while packaging");
    previousCandidate = await moveExactCandidateAside(vsixPath, distDir);
    await fs.rename(archivePath, vsixPath);
    publishedCandidate = await inspectOwnedBuildPath(vsixPath, distDir, "file");
    if (publishedCandidate.identity !== archiveOwned.identity) throw new Error("Published VSIX does not match the run-owned temporary archive");
    archiveCurrent = null;
    await removeOwnedBuildPath(previousCandidate, distDir);
    previousCandidate = null;
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
    await removeOwnedBuildPath(stageOwned, distDir);
  }
}

async function copyVerifiedFile(source, destination) {
  await fs.copyFile(source, destination);
  const [sourceBytes, destinationBytes] = await Promise.all([fs.readFile(source), fs.readFile(destination)]);
  if (!sourceBytes.equals(destinationBytes)) {
    throw new Error(`Packaged source copy differs from its source: ${path.basename(source)}`);
  }
  return createHash("sha256").update(sourceBytes).digest("hex");
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
  await removeOwnedDirectoryTree(owned.path, owned.identity, distDir);
}

async function removeOwnedDirectoryTree(directory, expectedIdentity, distDir) {
  const current = await inspectOwnedBuildPath(directory, distDir, "directory");
  if (current.identity !== expectedIdentity) throw new Error(`Refusing to remove a build directory whose identity changed: ${directory}`);
  await removeDirectoryContents(directory, directory);
  const final = await fs.lstat(directory, { bigint: true });
  if (final.isSymbolicLink() || reliableBuildIdentity(final) !== expectedIdentity) throw new Error(`Build directory changed before removal: ${directory}`);
  await fs.rmdir(directory);
}

async function removeDirectoryContents(directory, root) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    const relative = path.relative(root, candidate);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Build cleanup escaped its run-owned stage: ${candidate}`);
    const stat = await fs.lstat(candidate, { bigint: true });
    if (stat.isSymbolicLink()) throw new Error(`Refusing to follow a symbolic link during build cleanup: ${candidate}`);
    if (stat.isDirectory()) {
      const identity = reliableBuildIdentity(stat);
      if (!identity) throw new Error(`Reliable directory identity is unavailable during build cleanup: ${candidate}`);
      await removeDirectoryContents(candidate, root);
      const final = await fs.lstat(candidate, { bigint: true });
      if (final.isSymbolicLink() || reliableBuildIdentity(final) !== identity) throw new Error(`Build directory changed during cleanup: ${candidate}`);
      await fs.rmdir(candidate);
    } else if (stat.isFile()) {
      await fs.unlink(candidate);
    } else {
      throw new Error(`Refusing to remove an unexpected build artifact type: ${candidate}`);
    }
  }
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

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function powershellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function createZipCommand(sourceDirectory, destinationFile) {
  const source = powershellLiteral(sourceDirectory);
  const destination = powershellLiteral(destinationFile);
  return `Add-Type -AssemblyName System.IO.Compression; $source=${source}; $stream=[System.IO.File]::Open(${destination}, [System.IO.FileMode]::Create, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None); $archive=[System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create, $false); try { Get-ChildItem -LiteralPath $source -File -Recurse | Sort-Object FullName | ForEach-Object { $relative=$_.FullName.Substring($source.Length).TrimStart([System.IO.Path]::DirectorySeparatorChar).Replace([System.IO.Path]::DirectorySeparatorChar, [char]'/'); $entry=$archive.CreateEntry($relative, [System.IO.Compression.CompressionLevel]::Optimal); $input=[System.IO.File]::OpenRead($_.FullName); $output=$entry.Open(); try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() } } } finally { $archive.Dispose(); $stream.Dispose() }`;
}

async function writeZipArchive({ stage, archivePath }) {
  await execFileAsync("powershell.exe", ["-NoProfile", "-Command", createZipCommand(stage, archivePath)]);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const result = await buildVsix();
  console.log(result.vsixPath);
}
