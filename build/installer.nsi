Unicode true

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

!define APP_NAME      "Overlayr"
!define APP_VERSION   "1.3.1"
!define APP_PUBLISHER "Overlayr"
!define APP_EXE       "Overlayr.exe"
!define APP_SRC       "..\dist\Overlayr-win32-x64"
!define APP_ROOT      ".."
!define UNINST_KEY    "Software\Microsoft\Windows\CurrentVersion\Uninstall\Overlayr"
!define APP_REGKEY    "Software\Overlayr"

Name "${APP_NAME} ${APP_VERSION}"
BrandingText "Overlayr — темы, музыка и быстрый доступ"
OutFile "..\dist\Overlayr-Setup-${APP_VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\Overlayr"
InstallDirRegKey HKCU "${APP_REGKEY}" "InstallDir"
RequestExecutionLevel user

SetCompressor /SOLID lzma
SetCompressorDictSize 64
SetDatablockOptimize on
CRCCheck on
XPStyle on

VIProductVersion "1.3.1.0"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "CompanyName" "${APP_PUBLISHER}"
VIAddVersionKey "FileDescription" "${APP_NAME} Setup"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "LegalCopyright" "${APP_PUBLISHER}"

!define MUI_ICON   "${APP_ROOT}\assets\icon.ico"
!define MUI_UNICON "${APP_ROOT}\assets\icon.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEFINISHPAGE_BITMAP "${APP_ROOT}\assets\installer-welcome.bmp"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_BITMAP "${APP_ROOT}\assets\installer-header.bmp"
!define MUI_HEADERIMAGE_RIGHT
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Запустить Overlayr"
!define MUI_FINISHPAGE_LINK "Что нового и как пользоваться"
!define MUI_FINISHPAGE_LINK_LOCATION "$INSTDIR\README.md"

!define MUI_WELCOMEPAGE_TITLE "Установка Overlayr"
!define MUI_WELCOMEPAGE_TEXT "Overlayr — темы, музыкальный оверлей и быстрый доступ в одной программе.$\r$\n$\r$\n• 18 тем и своя палитра с подстройкой под обои$\r$\n• музыкальный оверлей с обложками, эквалайзером и громкостью приложения$\r$\n• быстрый доступ к приложениям, профили и горячие клавиши$\r$\n$\r$\nУстановка не требует прав администратора."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Russian"

Function .onInit
  ; Overlayr keeps running in the tray, so stop it before replacing files.
  nsExec::Exec 'taskkill /IM ${APP_EXE} /F'
  Pop $0
FunctionEnd

Section "Overlayr" SecMain
  SetOutPath "$INSTDIR"
  File /r "${APP_SRC}\*.*"

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateShortcut "$DESKTOP\Overlayr.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
  CreateDirectory "$SMPROGRAMS\Overlayr"
  CreateShortcut "$SMPROGRAMS\Overlayr\Overlayr.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
  CreateShortcut "$SMPROGRAMS\Overlayr\Удалить Overlayr.lnk" "$INSTDIR\Uninstall.exe"

  WriteRegStr HKCU "${APP_REGKEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${APP_REGKEY}" "Version" "${APP_VERSION}"

  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" "$\"$INSTDIR\Uninstall.exe$\""
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" "$\"$INSTDIR\Uninstall.exe$\" /S"
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1

  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" "$0"
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /IM ${APP_EXE} /F'
  Pop $0

  Delete "$DESKTOP\Overlayr.lnk"
  Delete "$SMPROGRAMS\Overlayr\Overlayr.lnk"
  Delete "$SMPROGRAMS\Overlayr\Удалить Overlayr.lnk"
  RMDir "$SMPROGRAMS\Overlayr"

  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "${APP_REGKEY}"

  ; Settings in %APPDATA%\Overlayr are kept on purpose.
  RMDir /r "$INSTDIR"
SectionEnd
