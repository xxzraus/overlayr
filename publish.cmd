@echo off
chcp 65001 >nul
title Overlayr publisher
echo.
echo   Overlayr publisher
echo   -----------------
echo   1. Create a token: https://github.com/settings/tokens/new
echo      Scope: repo (classic) or Contents + Administration (fine-grained)
echo   2. Paste it below. The input is hidden.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s = Read-Host -AsSecureString 'GitHub token';" ^
  "$p = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s));" ^
  "if (-not $p) { Write-Host 'No token, aborted.'; exit 1 };" ^
  "& '%~dp0build\publish.ps1' -Token $p"
echo.
pause
