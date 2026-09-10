; Otto directory preservation. Extend, do not replace, electron-builder 26.15.3.
; This is an accidental data-loss guard, not a sandbox against a concurrent
; privileged process. Unknown layouts stop for manual review; nothing is moved.
!include LogicLib.nsh
!include FileFunc.nsh

Var OttoSafetyPath
Var OttoSafetyReason
!ifndef BUILD_UNINSTALLER
Var OttoSafetyOldPath
Var OttoSafetyOldCommand
Var OttoSafetyOldExe
!endif
Var OttoSafetyScanPath
Var OttoSafetyEntries
Var OttoSafetyDepth
Var OttoSafetyNonempty

!macro OttoSafetySaveRegisters
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
!macroend

!macro OttoSafetyRestoreRegisters
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro OttoSafetyCheckRegistry ROOT
  ReadRegStr $OttoSafetyOldPath ${ROOT} "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ReadRegStr $OttoSafetyOldCommand ${ROOT} "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  ${If} $OttoSafetyOldPath != ""
  ${OrIf} $OttoSafetyOldCommand != ""
    StrCpy $OttoSafetyReason "incomplete or ambiguous previous installation registration"
    ${If} $OttoSafetyOldPath == ""
    ${OrIf} $OttoSafetyOldCommand == ""
      Call OttoSafetyBlocked
    ${EndIf}
    Call OttoSafetyParseOldCommand
    StrCpy $OttoSafetyPath $OttoSafetyOldPath
    Call OttoSafetyValidatePath
    GetFullPathName $0 $OttoSafetyOldPath
    ${GetParent} $OttoSafetyOldExe $1
    GetFullPathName $1 $1
    StrCpy $OttoSafetyReason "previous uninstaller and installation directory disagree"
    ${If} $0 != $1
      Call OttoSafetyBlocked
    ${EndIf}
    StrCpy $OttoSafetyReason "previous installation is incomplete; preserve files for manual recovery"
    IfFileExists "$0\${APP_EXECUTABLE_FILENAME}" 0 +2
      Goto +2
    Call OttoSafetyBlocked
    IfFileExists "$0\resources\app.asar" 0 +2
      Goto +2
    Call OttoSafetyBlocked
    IfFileExists "$OttoSafetyOldExe" 0 +2
      Goto +2
    Call OttoSafetyBlocked
  ${EndIf}
!macroend

!macro OttoSafetyFunctions PREFIX
Function ${PREFIX}OttoSafetyBlocked
  DetailPrint "[otto-install-safety] blocked: $OttoSafetyReason"
  MessageBox MB_OK|MB_ICONSTOP "[otto-install-safety] blocked: $OttoSafetyReason.$\r$\nOtto has preserved your files. Use a dedicated application directory; review the existing installation before retrying." /SD IDOK
  SetErrorLevel 73
  Quit
FunctionEnd

; Only existing, recognised runtime subtrees are traversed. A shared workspace
; is rejected at its first unknown top-level entry, not recursively scanned.
; Bounds deliberately fail closed and are not an approval to delete files.
Function ${PREFIX}OttoSafetyScanTree
  !insertmacro OttoSafetySaveRegisters
  IntOp $OttoSafetyDepth $OttoSafetyDepth + 1
  StrCpy $OttoSafetyReason "runtime directory inspection limit exceeded"
  ${If} $OttoSafetyDepth > 32
    Call ${PREFIX}OttoSafetyBlocked
  ${EndIf}
  StrCpy $0 $OttoSafetyScanPath
  System::Alloc 592
  Pop $5
  ${If} $5 == 0
    Call ${PREFIX}OttoSafetyBlocked
  ${EndIf}
  System::Call 'kernel32::FindFirstFileW(w "$0\*", p r5) p.r1 ?e'
  Pop $6
  ${If} $1 == -1
    ${If} $6 != 2
      StrCpy $OttoSafetyReason "runtime directory cannot be inspected"
      Call ${PREFIX}OttoSafetyBlocked
    ${EndIf}
  ${Else}
    ${Do}
      IntOp $6 $5 + 44
      System::Call 'kernel32::lstrcpynW(w .r2, p r6, i 260) p'
      ${If} $2 != "."
      ${AndIf} $2 != ".."
        IntOp $OttoSafetyEntries $OttoSafetyEntries + 1
        StrCpy $OttoSafetyReason "runtime directory inspection limit exceeded"
        ${If} $OttoSafetyEntries > 8192
          Call ${PREFIX}OttoSafetyBlocked
        ${EndIf}
        StrCpy $3 $2 15 -15
        StrCpy $OttoSafetyReason "source repository or workspace found inside application files"
        ${If} $2 == ".git"
        ${OrIf} $2 == ".hg"
        ${OrIf} $2 == ".svn"
        ${OrIf} $3 == ".code-workspace"
          Call ${PREFIX}OttoSafetyBlocked
        ${EndIf}
        System::Call 'kernel32::GetFileAttributesW(w "$0\$2") i.r3'
        StrCpy $OttoSafetyReason "runtime entry is inaccessible or redirected"
        ${If} $3 == -1
          Call ${PREFIX}OttoSafetyBlocked
        ${EndIf}
        IntOp $4 $3 & 0x400
        ${If} $4 != 0
          Call ${PREFIX}OttoSafetyBlocked
        ${EndIf}
        IntOp $4 $3 & 0x10
        ${If} $OttoSafetyDepth == 1
          ${GetFileName} $0 $8
          ${If} $8 == "resources"
            StrCpy $OttoSafetyReason "resources contains an unknown file or source directory"
            ${If} $4 != 0
              ${If} $2 != "app.asar.unpacked"
              ${AndIf} $2 != "otto-native"
              ${AndIf} $2 != "ripgrep"
              ${AndIf} $2 != "sqlcipher"
              ${AndIf} $2 != "runtime"
                Call ${PREFIX}OttoSafetyBlocked
              ${EndIf}
            ${Else}
              ${If} $2 != "app.asar"
              ${AndIf} $2 != "app-icon.png"
              ${AndIf} $2 != "app-update.yml"
              ${AndIf} $2 != "elevate.exe"
                Call ${PREFIX}OttoSafetyBlocked
              ${EndIf}
            ${EndIf}
          ${EndIf}
        ${EndIf}
        ${If} $4 != 0
          StrCpy $OttoSafetyScanPath "$0\$2"
          Call ${PREFIX}OttoSafetyScanTree
        ${EndIf}
      ${EndIf}
      System::Call 'kernel32::FindNextFileW(p r1, p r5) i.r7 ?e'
      Pop $6
      ${If} $7 == 0
        ${If} $6 != 18
          StrCpy $OttoSafetyReason "runtime directory changed or cannot be inspected"
          Call ${PREFIX}OttoSafetyBlocked
        ${EndIf}
        ${Break}
      ${EndIf}
    ${Loop}
    System::Call 'kernel32::FindClose(p r1)'
  ${EndIf}
  System::Free $5
  IntOp $OttoSafetyDepth $OttoSafetyDepth - 1
  !insertmacro OttoSafetyRestoreRegisters
FunctionEnd

Function ${PREFIX}OttoSafetyValidatePath
  !insertmacro OttoSafetySaveRegisters
  StrCpy $OttoSafetyReason "installation path must be an ordinary local absolute directory"
  StrCpy $0 $OttoSafetyPath
  StrCpy $1 $0 2 1
  ${If} $1 != ":\"
    Call ${PREFIX}OttoSafetyBlocked
  ${EndIf}
  System::Call 'shlwapi::PathGetDriveNumberW(w r0) i.r1'
  ${If} $1 < 0
    Call ${PREFIX}OttoSafetyBlocked
  ${EndIf}
  ; Reject ambiguous DOS/device/ADS syntax, 8.3 aliases and trailing-dot/space
  ; components. Ordinary Unicode names and spaces within names remain valid.
  StrLen $4 $0
  ${If} $4 < 4
    Call ${PREFIX}OttoSafetyBlocked
  ${EndIf}
  StrCpy $1 3
  ${DoWhile} $1 < $4
    StrCpy $2 $0 1 $1
    ${If} $2 == ":"
    ${OrIf} $2 == "/"
    ${OrIf} $2 == "~"
    ${OrIf} $2 == "*"
    ${OrIf} $2 == "?"
    ${OrIf} $2 == "<"
    ${OrIf} $2 == ">"
    ${OrIf} $2 == "|"
    ${OrIf} $2 == "$\r"
    ${OrIf} $2 == "$\n"
    ${OrIf} $2 == "$\t"
      Call ${PREFIX}OttoSafetyBlocked
    ${EndIf}
    StrCmp $2 '"' 0 +2
      Call ${PREFIX}OttoSafetyBlocked
    IntOp $1 $1 + 1
    StrCpy $3 $0 1 $1
    ${If} $3 == "\"
    ${OrIf} $3 == ""
      ${If} $2 == "."
      ${OrIf} $2 == " "
        Call ${PREFIX}OttoSafetyBlocked
      ${EndIf}
    ${EndIf}
  ${Loop}
  ; NSIS GetFullPathName requires an existing path. The Win32 API also
  ; canonicalises a not-yet-created /D destination without creating it.
  System::Call 'kernel32::GetFullPathNameW(w r0, i ${NSIS_MAX_STRLEN}, w .r1, p 0) i.r2'
  ${If} $2 == 0
  ${OrIf} $2 >= ${NSIS_MAX_STRLEN}
  ${OrIf} $0 != $1
    Call ${PREFIX}OttoSafetyBlocked
  ${EndIf}
  StrCpy $OttoSafetyReason "a system, profile or shared storage root is not a dedicated application directory"
  ${If} $0 == $WINDIR
  ${OrIf} $0 == $SYSDIR
  ${OrIf} $0 == $PROGRAMFILES
  ${OrIf} $0 == $PROGRAMFILES64
  ${OrIf} $0 == $COMMONFILES
  ${OrIf} $0 == $COMMONFILES64
  ${OrIf} $0 == $PROFILE
  ${OrIf} $0 == $DESKTOP
  ${OrIf} $0 == $DOCUMENTS
  ${OrIf} $0 == $APPDATA
  ${OrIf} $0 == $LOCALAPPDATA
  ${OrIf} $0 == $TEMP
    Call ${PREFIX}OttoSafetyBlocked
  ${EndIf}
  System::Call 'shell32::SHGetFolderPathW(p 0, i 0x23, p 0, i 0, w .r1) i.r2'
  ${If} $2 != 0
  ${OrIf} $0 == $1
    Call ${PREFIX}OttoSafetyBlocked
  ${EndIf}
  ; Check every existing ancestor; never follow a junction/symlink or silently
  ; treat access denied as a new directory. This is not an atomic directory lock.
  StrCpy $1 $0
  ${Do}
    System::Call 'kernel32::GetFileAttributesW(w r1) i.r2 ?e'
    Pop $3
    ${If} $2 == -1
      StrCpy $OttoSafetyReason "installation path cannot be inspected"
      ${If} $3 != 2
      ${AndIf} $3 != 3
        Call ${PREFIX}OttoSafetyBlocked
      ${EndIf}
    ${Else}
      IntOp $3 $2 & 0x410
      StrCpy $OttoSafetyReason "installation path contains a redirect or non-directory ancestor"
      ${If} $3 != 16
        Call ${PREFIX}OttoSafetyBlocked
      ${EndIf}
      StrCpy $OttoSafetyReason "installation is inside a source repository"
      IfFileExists "$1\.git" 0 +2
        Call ${PREFIX}OttoSafetyBlocked
      IfFileExists "$1\.hg" 0 +2
        Call ${PREFIX}OttoSafetyBlocked
      IfFileExists "$1\.svn" 0 +2
        Call ${PREFIX}OttoSafetyBlocked
    ${EndIf}
    StrLen $2 $1
    ${If} $2 <= 3
      ${Break}
    ${EndIf}
    ${GetParent} $1 $1
    StrLen $2 $1
    ${If} $2 == 2
      StrCpy $1 "$1\"
    ${EndIf}
  ${Loop}
  System::Call 'kernel32::GetFileAttributesW(w r0) i.r1'
  ${If} $1 != -1
    StrCpy $OttoSafetyNonempty 0
    System::Alloc 592
    Pop $5
    ${If} $5 == 0
      StrCpy $OttoSafetyReason "directory inspection cannot allocate its bounded buffer"
      Call ${PREFIX}OttoSafetyBlocked
    ${EndIf}
    System::Call 'kernel32::FindFirstFileW(w "$0\*", p r5) p.r1 ?e'
    Pop $6
    ${If} $1 == -1
      ${If} $6 != 2
        StrCpy $OttoSafetyReason "installation directory cannot be inspected"
        Call ${PREFIX}OttoSafetyBlocked
      ${EndIf}
    ${Else}
      ${Do}
        IntOp $6 $5 + 44
        System::Call 'kernel32::lstrcpynW(w .r2, p r6, i 260) p'
        ${If} $2 != "."
        ${AndIf} $2 != ".."
          StrCpy $OttoSafetyNonempty 1
          System::Call 'kernel32::GetFileAttributesW(w "$0\$2") i.r3'
          IntOp $4 $3 & 0x400
          StrCpy $OttoSafetyReason "installation contains an inaccessible or redirected entry"
          ${If} $3 == -1
          ${OrIf} $4 != 0
            Call ${PREFIX}OttoSafetyBlocked
          ${EndIf}
          IntOp $4 $3 & 0x10
          ${If} $4 != 0
            StrCpy $OttoSafetyReason "installation contains a source, workspace or unknown directory"
            ${If} $2 != "resources"
            ${AndIf} $2 != "locales"
            ${AndIf} $2 != "swiftshader"
              Call ${PREFIX}OttoSafetyBlocked
            ${EndIf}
            StrCpy $OttoSafetyScanPath "$0\$2"
            StrCpy $OttoSafetyEntries 0
            StrCpy $OttoSafetyDepth 0
            Call ${PREFIX}OttoSafetyScanTree
          ${Else}
            StrCpy $OttoSafetyReason "installation contains an unknown file; preserve it before upgrading"
            ${If} $2 != "${APP_EXECUTABLE_FILENAME}"
            ${AndIf} $2 != "${UNINSTALL_FILENAME}"
            ${AndIf} $2 != "chrome_100_percent.pak"
            ${AndIf} $2 != "chrome_200_percent.pak"
            ${AndIf} $2 != "d3dcompiler_47.dll"
            ${AndIf} $2 != "dxcompiler.dll"
            ${AndIf} $2 != "dxil.dll"
            ${AndIf} $2 != "ffmpeg.dll"
            ${AndIf} $2 != "icudtl.dat"
            ${AndIf} $2 != "libEGL.dll"
            ${AndIf} $2 != "libGLESv2.dll"
            ${AndIf} $2 != "LICENSE.electron.txt"
            ${AndIf} $2 != "LICENSES.chromium.html"
            ${AndIf} $2 != "resources.pak"
            ${AndIf} $2 != "snapshot_blob.bin"
            ${AndIf} $2 != "v8_context_snapshot.bin"
            ${AndIf} $2 != "vk_swiftshader_icd.json"
            ${AndIf} $2 != "vk_swiftshader.dll"
            ${AndIf} $2 != "vulkan-1.dll"
            ${AndIf} $2 != "uninstallerIcon.ico"
            ${AndIf} $2 != "debug.log"
              Call ${PREFIX}OttoSafetyBlocked
            ${EndIf}
          ${EndIf}
        ${EndIf}
        System::Call 'kernel32::FindNextFileW(p r1, p r5) i.r7 ?e'
        Pop $6
        ${If} $7 == 0
          ${If} $6 != 18
            StrCpy $OttoSafetyReason "installation directory changed or cannot be inspected"
            Call ${PREFIX}OttoSafetyBlocked
          ${EndIf}
          ${Break}
        ${EndIf}
      ${Loop}
      System::Call 'kernel32::FindClose(p r1)'
    ${EndIf}
    System::Free $5
    ${If} $OttoSafetyNonempty == 1
      StrCpy $OttoSafetyReason "nonempty directory is not a recognised Otto installation"
      IfFileExists "$0\${APP_EXECUTABLE_FILENAME}" 0 +2
        Goto +2
      Call ${PREFIX}OttoSafetyBlocked
      IfFileExists "$0\resources\app.asar" 0 +2
        Goto +2
      Call ${PREFIX}OttoSafetyBlocked
    ${EndIf}
  ${EndIf}
  !insertmacro OttoSafetyRestoreRegisters
FunctionEnd
!macroend

!macro customHeader
  !ifdef BUILD_UNINSTALLER
    !insertmacro OttoSafetyFunctions "un."
  !else
    !insertmacro OttoSafetyFunctions ""
    Function OttoSafetyParseOldCommand
      StrCpy $OttoSafetyReason "previous uninstall command is not an exact recognised Otto command"
      StrCpy $0 $OttoSafetyOldCommand 1
      StrCmp $0 '"' +2
        Call OttoSafetyBlocked
      StrCpy $1 1
      ${Do}
        StrCpy $0 $OttoSafetyOldCommand 1 $1
        ${If} $0 == ""
          Call OttoSafetyBlocked
        ${EndIf}
        StrCmp $0 '"' 0 +2
          ${Break}
        IntOp $1 $1 + 1
      ${Loop}
      IntOp $2 $1 - 1
      StrCpy $OttoSafetyOldExe $OttoSafetyOldCommand $2 1
      IntOp $1 $1 + 1
      StrCpy $0 $OttoSafetyOldCommand "" $1
      ${If} $0 != ""
      ${AndIf} $0 != " /currentuser"
      ${AndIf} $0 != " /allusers"
        Call OttoSafetyBlocked
      ${EndIf}
      ${GetFileName} $OttoSafetyOldExe $0
      ${If} $0 != "${UNINSTALL_FILENAME}"
        Call OttoSafetyBlocked
      ${EndIf}
    FunctionEnd
    Function OttoSafetyCheckAll
      !insertmacro OttoSafetySaveRegisters
      StrCpy $OttoSafetyPath $INSTDIR
      Call OttoSafetyValidatePath
      ; Both scopes matter: an all-user install also uninstalls HKCU. Do not
      ; check only the new /D destination. Keep the upstream-selected reg view.
      !insertmacro OttoSafetyCheckRegistry HKCU
      !insertmacro OttoSafetyCheckRegistry HKLM
      !insertmacro OttoSafetyRestoreRegisters
    FunctionEnd
    ; customHeader expands before the upstream install section. Unlike a page
    ; callback, this mandatory section also runs for /S and after directory UI.
    Section "-Otto directory safety"
      SectionIn RO
      Call OttoSafetyCheckAll
    SectionEnd
  !endif
!macroend

!macro customInit
  Call OttoSafetyCheckAll
!macroend

!macro customUnInit
  StrCpy $OttoSafetyPath $INSTDIR
  Call un.OttoSafetyValidatePath
!macroend

!macro customUnInstall
  ; Repeat after any interactive install-mode selection, immediately before
  ; the upstream removal code. This affects newly generated uninstallers only.
  StrCpy $OttoSafetyPath $INSTDIR
  Call un.OttoSafetyValidatePath
!macroend
