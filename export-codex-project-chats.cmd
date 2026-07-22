@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

set "NODE_EXE=node"
where node >nul 2>nul
if errorlevel 1 (
  if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" (
    set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  ) else (
    echo Node.js was not found.
    echo.
    echo Common reasons:
    echo - Node.js is not installed or not in PATH.
    echo - Codex Desktop's bundled Node runtime was not found at the expected path.
    echo.
    echo Opening FAQ.md...
    if exist "%~dp0FAQ.md" start "" "%~dp0FAQ.md"
    echo.
    pause
    exit /b 1
  )
)

:menu
cls
echo Codex Project Chat Exporter
echo ===========================
echo.
echo No administrator rights are required.
echo Active and archived Codex sessions are scanned by default.
echo.
echo  [1] Export all detected sessions
echo  [2] Export one project or work folder
echo  [3] List detected projects
echo  [4] List every detected session
echo  [5] Diagnose active and archived session detection
echo  [6] Open README and FAQ
echo  [0] Exit
echo.
choice /c 1234560 /n /m "Select an option: "
if errorlevel 7 goto end
if errorlevel 6 goto open_help
if errorlevel 5 goto diagnose
if errorlevel 4 goto list_sessions
if errorlevel 3 goto list_projects
if errorlevel 2 goto export_project
if errorlevel 1 goto export_all

goto menu

:export_all
cls
echo Export all detected sessions
echo ============================
echo.
call :ask_export_options
if errorlevel 1 goto menu
if "!OUTPUT_DIR!"=="" (
  "%NODE_EXE%" "%~dp0bin\export-codex-project-chats.mjs" --all !NO_RAW_FLAG!
) else (
  "%NODE_EXE%" "%~dp0bin\export-codex-project-chats.mjs" --all !NO_RAW_FLAG! --out "!OUTPUT_DIR!"
)
call :after_command
goto menu

:export_project
cls
echo Export one project or work folder
echo =================================
echo.
echo Detected projects:
echo.
"%NODE_EXE%" "%~dp0bin\export-codex-project-chats.mjs" --list
if errorlevel 1 (
  call :after_command
  goto menu
)
echo.
set "PROJECT_FILTER="
set /p PROJECT_FILTER=Enter a project name or full stored work-folder path: 
if "!PROJECT_FILTER!"=="" (
  echo.
  echo No project was entered. Nothing was exported.
  pause
  goto menu
)
call :ask_export_options
if errorlevel 1 goto menu
if "!OUTPUT_DIR!"=="" (
  "%NODE_EXE%" "%~dp0bin\export-codex-project-chats.mjs" --project "!PROJECT_FILTER!" !NO_RAW_FLAG!
) else (
  "%NODE_EXE%" "%~dp0bin\export-codex-project-chats.mjs" --project "!PROJECT_FILTER!" !NO_RAW_FLAG! --out "!OUTPUT_DIR!"
)
call :after_command
goto menu

:list_projects
cls
echo Detected projects
echo =================
echo.
"%NODE_EXE%" "%~dp0bin\export-codex-project-chats.mjs" --list
call :after_command
goto menu

:list_sessions
cls
echo Detected sessions
echo =================
echo.
set "REPORT_FILE=%TEMP%\codex-project-chat-exporter-sessions.txt"
"%NODE_EXE%" "%~dp0bin\export-codex-project-chats.mjs" --list-sessions > "!REPORT_FILE!" 2>&1
set "COMMAND_ERROR=!ERRORLEVEL!"
type "!REPORT_FILE!"
echo.
echo The same report is opening in Notepad:
echo !REPORT_FILE!
start "" notepad.exe "!REPORT_FILE!"
if not "!COMMAND_ERROR!"=="0" echo The command did not complete successfully.
echo.
pause
goto menu

:diagnose
cls
echo Session detection diagnostics
echo =============================
echo.
set "REPORT_FILE=%TEMP%\codex-project-chat-exporter-diagnostics.txt"
"%NODE_EXE%" "%~dp0bin\export-codex-project-chats.mjs" --diagnose > "!REPORT_FILE!" 2>&1
set "COMMAND_ERROR=!ERRORLEVEL!"
type "!REPORT_FILE!"
echo.
echo The same report is opening in Notepad:
echo !REPORT_FILE!
start "" notepad.exe "!REPORT_FILE!"
if not "!COMMAND_ERROR!"=="0" echo The command did not complete successfully.
echo.
pause
goto menu

:open_help
if exist "%~dp0README.md" start "" "%~dp0README.md"
if exist "%~dp0FAQ.md" start "" "%~dp0FAQ.md"
goto menu

:ask_export_options
set "NO_RAW_FLAG="
set "MARKDOWN_ONLY="
set /p MARKDOWN_ONLY=Create Markdown only and omit unchanged raw JSONL copies? (y/n): 
if /I "!MARKDOWN_ONLY!"=="Y" set "NO_RAW_FLAG=--no-raw"
if /I "!MARKDOWN_ONLY!"=="YES" set "NO_RAW_FLAG=--no-raw"
echo.
echo Optional output folder. A short path such as C:\cx\codex-export is recommended.
echo Leave this empty to create a dated folder in Documents.
set "OUTPUT_DIR="
set /p OUTPUT_DIR=Output folder: 
exit /b 0

:after_command
if errorlevel 1 (
  echo.
  echo The command did not complete successfully.
  echo Use menu option 5 for diagnostics or open FAQ.md.
)
echo.
pause
exit /b 0

:end
endlocal
exit /b 0
