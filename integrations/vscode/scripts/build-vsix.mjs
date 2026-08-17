import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(extensionRoot, "..", "..");
const packageJson = JSON.parse(await fs.readFile(path.join(extensionRoot, "package.json"), "utf8"));
const distDir = path.join(extensionRoot, "dist");
const stage = path.join(distDir, "stage");
const vsixBase = `${packageJson.name}-${packageJson.version}`;
const zipPath = path.join(distDir, `${vsixBase}.zip`);
const vsixPath = path.join(distDir, `${vsixBase}.vsix`);

await fs.rm(distDir, { recursive: true, force: true });
await fs.mkdir(path.join(stage, "extension", "src"), { recursive: true });
await fs.mkdir(path.join(stage, "extension", "vendor", "codex-project-chat-exporter", "bin"), { recursive: true });

await copyFile("package.json", path.join(stage, "extension", "package.json"));
await copyFile("README.md", path.join(stage, "extension", "README.md"));
await copyFile("PACKAGED_TEST_PLAN.md", path.join(stage, "extension", "PACKAGED_TEST_PLAN.md"));
await copyFile("LICENSE", path.join(stage, "extension", "LICENSE"));
await copyFile(path.join("src", "extension.cjs"), path.join(stage, "extension", "src", "extension.cjs"));
await copyFile(path.join("src", "vscode-adapter.cjs"), path.join(stage, "extension", "src", "vscode-adapter.cjs"));
await fs.copyFile(path.join(repoRoot, "bin", "export-codex-project-chats.mjs"), path.join(stage, "extension", "vendor", "codex-project-chat-exporter", "bin", "export-codex-project-chats.mjs"));
await fs.copyFile(path.join(repoRoot, "LICENSE"), path.join(stage, "extension", "vendor", "codex-project-chat-exporter", "LICENSE"));

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

await fs.rm(zipPath, { force: true });
await fs.rm(vsixPath, { force: true });
await execFileAsync("powershell.exe", ["-NoProfile", "-Command", createZipCommand(stage, zipPath)]);
await fs.rename(zipPath, vsixPath);
console.log(vsixPath);

async function copyFile(relative, destination) {
  await fs.copyFile(path.join(extensionRoot, relative), destination);
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
