@echo off
setlocal
cd /d "%~dp0"

start "" "%~dp0README.md"

echo Codex Project Chat Exporter
echo.
echo Project folder:
cd
echo.
echo Useful first commands:
echo node .\bin\export-codex-project-chats.mjs --list
echo node .\bin\export-codex-project-chats.mjs --list-sessions
echo.
cmd /k
