import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
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
  const stage = path.join(distDir, `.stage-${vsixBase}`);
  const archivePath = path.join(distDir, `${vsixBase}.vsix.partial`);
  const vsixPath = path.join(distDir, `${vsixBase}.vsix`);

  await fs.mkdir(distDir, { recursive: true });
  await removeOwnedPath(stage, distDir, { allowDirectory: true });
  await removeOwnedPath(archivePath, distDir);
  const removedCandidates = await pruneOwnedVsixCandidates(distDir, packageJson.name);
  await assertPathAbsent(vsixPath, "final VSIX destination");

  try {
    await fs.mkdir(path.join(stage, "extension", "src"), { recursive: true });
    await fs.mkdir(path.join(stage, "extension", "vendor", "codex-project-chat-exporter", "bin"), { recursive: true });

    await copyVerifiedFile(path.join(extensionRoot, "package.json"), path.join(stage, "extension", "package.json"));
    await copyVerifiedFile(path.join(extensionRoot, "README.md"), path.join(stage, "extension", "README.md"));
    await copyVerifiedFile(path.join(extensionRoot, "PACKAGED_TEST_PLAN.md"), path.join(stage, "extension", "PACKAGED_TEST_PLAN.md"));
    await copyVerifiedFile(path.join(extensionRoot, "LICENSE"), path.join(stage, "extension", "LICENSE"));
    await copyVerifiedFile(path.join(extensionRoot, "src", "extension.cjs"), path.join(stage, "extension", "src", "extension.cjs"));
    await copyVerifiedFile(path.join(extensionRoot, "src", "vscode-adapter.cjs"), path.join(stage, "extension", "src", "vscode-adapter.cjs"));
    await copyVerifiedFile(path.join(repoRoot, "bin", "export-codex-project-chats.mjs"), path.join(stage, "extension", "vendor", "codex-project-chat-exporter", "bin", "export-codex-project-chats.mjs"));
    await copyVerifiedFile(path.join(repoRoot, "LICENSE"), path.join(stage, "extension", "vendor", "codex-project-chat-exporter", "LICENSE"));

    await fs.writeFile(path.join(stage, "[Content_Types].xml"), `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json"/>
  <Default Extension="md" ContentType="text/markdown"/>
  <Default Extension="txt" ContentType="text/plain"/>
  <Default Extension="cjs" ContentType="application/javascript"/>
  <Default Extension="mjs" ContentType="application/javascript"/>
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
  </Assets>
</PackageManifest>
`, "utf8");

    await archiveWriter({ stage, archivePath });
    await fs.rename(archivePath, vsixPath);
    return { archivePath, distDir, removedCandidates, stage, vsixPath };
  } finally {
    await removeOwnedPath(archivePath, distDir);
    await removeOwnedPath(stage, distDir, { allowDirectory: true });
  }
}

async function copyVerifiedFile(source, destination) {
  await fs.copyFile(source, destination);
  const [sourceBytes, destinationBytes] = await Promise.all([fs.readFile(source), fs.readFile(destination)]);
  if (!sourceBytes.equals(destinationBytes)) {
    throw new Error(`Packaged source copy differs from its source: ${path.basename(source)}`);
  }
}

async function pruneOwnedVsixCandidates(distDir, packageName) {
  const removed = [];
  for (const entry of await fs.readdir(distDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(`${packageName}-`) || !entry.name.endsWith(".vsix")) continue;
    const candidate = path.join(distDir, entry.name);
    assertDirectChild(distDir, candidate);
    await fs.unlink(candidate);
    removed.push(candidate);
  }
  return removed;
}

async function removeOwnedPath(candidate, distDir, { allowDirectory = false } = {}) {
  assertDirectChild(distDir, candidate);
  let stat;
  try {
    stat = await fs.lstat(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink() || stat.isFile()) {
    await fs.unlink(candidate);
    return;
  }
  if (allowDirectory && stat.isDirectory()) {
    await fs.rm(candidate, { recursive: true });
    return;
  }
  throw new Error(`Refusing to remove unexpected build artifact type: ${candidate}`);
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
  return `Add-Type -AssemblyName System.IO.Compression; Add-Type -AssemblyName System.IO.Compression.FileSystem; $source=${source}; $archive=[System.IO.Compression.ZipFile]::Open(${destination}, [System.IO.Compression.ZipArchiveMode]::Create); try { Get-ChildItem -LiteralPath $source -File -Recurse | Sort-Object FullName | ForEach-Object { $relative=$_.FullName.Substring($source.Length).TrimStart([System.IO.Path]::DirectorySeparatorChar).Replace([System.IO.Path]::DirectorySeparatorChar, [char]'/'); $entry=$archive.CreateEntry($relative, [System.IO.Compression.CompressionLevel]::Optimal); $input=[System.IO.File]::OpenRead($_.FullName); $output=$entry.Open(); try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() } } } finally { $archive.Dispose() }`;
}

async function writeZipArchive({ stage, archivePath }) {
  await execFileAsync("powershell.exe", ["-NoProfile", "-Command", createZipCommand(stage, archivePath)]);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const result = await buildVsix();
  console.log(result.vsixPath);
}
