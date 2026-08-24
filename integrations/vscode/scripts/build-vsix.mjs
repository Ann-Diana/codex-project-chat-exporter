import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

import JSZip from "jszip";

const defaultExtensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultRepoRoot = path.resolve(defaultExtensionRoot, "..", "..");
const FIXED_ARCHIVE_DATE = new Date("2000-01-01T00:00:00.000Z");
const RUNTIME_ROOT = "extension/vendor/codex-project-chat-exporter";
const FORBIDDEN_NATIVE_EXTENSIONS = new Set([".dll", ".dylib", ".exe", ".node", ".so"]);

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
      "extension/vendor/codex-project-chat-exporter/fonts",
      "extension/vendor/codex-project-chat-exporter/lib",
      "extension/vendor/codex-project-chat-exporter/node_modules",
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
  const packageJson = parseJsonFile(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"), "root package.json");
  const packageLock = parseJsonFile(await fs.readFile(path.join(repoRoot, "package-lock.json"), "utf8"), "root package-lock.json");
  validateProductionLock(packageJson, packageLock);
  const runtimeHashes = new Map();
  const copyRuntimeFile = async (source, relativePath) => {
    const normalized = normalizeRuntimeRelativePath(relativePath);
    const destination = path.join(stage, RUNTIME_ROOT, ...normalized.split("/"));
    await ensureOwnedStageDirectory(stageOwned, stage, path.dirname(path.join(RUNTIME_ROOT, ...normalized.split("/"))));
    const hash = await copyVerifiedFile(source, destination, stageOwned, stage);
    runtimeHashes.set(normalized, hash);
  };

  for (const relativePath of ["package.json", "package-lock.json", "LICENSE", "bin/export-codex-project-chats.mjs"]) {
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
  licenseSections.push(
    "Bundled font assets",
    "Noto Sans 2.015, Noto Sans Mono 2.014, and Noto Sans Symbols 2.003",
    "Declared license: SIL Open Font License 1.1",
    "Source: fonts/OFL.txt",
    "",
    fontLicense,
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
    ["mjs", "application/javascript"], ["png", "image/png"], ["ttf", "font/ttf"], ["txt", "text/plain"],
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
