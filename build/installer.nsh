; Adds the File Explorer right-click entries for the installing user, and
; removes them on uninstall. Mirrors electron/shell-integration.cjs.
; "PDFMaker.<verb>" is a registry key name, not a label. It stays as it is so
; entries written by older versions are still overwritten and removed.
!macro AddVerb EXT VERB LABEL ARGS MULTI
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\PDFMaker.${VERB}" "" "${LABEL}"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\PDFMaker.${VERB}" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\PDFMaker.${VERB}" "PDFMakerExe" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  ${If} "${MULTI}" == "1"
    WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\PDFMaker.${VERB}" "MultiSelectModel" "Player"
  ${EndIf}
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\PDFMaker.${VERB}\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" ${ARGS} "%1"'
!macroend

!macro RemoveVerb EXT VERB
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\PDFMaker.${VERB}"
!macroend

!include LogicLib.nsh
!include FileFunc.nsh
!include WinMessages.nsh

!ifndef BUILD_UNINSTALLER
; Folio installs for the current user, without admin rights, so it can only go
; where this Windows account may create folders. Some drives (D:\ here) only
; let administrators do that. Setup used to get most of the way and then stop
; with "Error opening file for writing", and an update removed the old copy
; and then could not write the new one, so the app vanished. An update deletes
; the install folder and creates it again, so the folder that holds it must
; allow that too.
;
; Pushes 1 if Folio can be installed in $INSTDIR, 0 if not.
Function FolioCheckInstDir
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  StrCpy $R3 0
  ; The folder that will hold the install folder. Setup adds "\Folio" when the
  ; chosen path does not already end with it.
  StrLen $R1 "\${APP_FILENAME}"
  IntOp $R1 0 - $R1
  StrCpy $R2 $INSTDIR "" $R1
  ${If} $R2 == "\${APP_FILENAME}"
    ${GetParent} $INSTDIR $R0
  ${Else}
    StrCpy $R0 $INSTDIR
  ${EndIf}
  ; It may not exist yet: test the nearest folder above it that does.
  findExisting:
    StrCmp $R0 "" tested
    IfFileExists "$R0\*.*" tryWrite
    ${GetParent} $R0 $R0
    Goto findExisting
  tryWrite:
    StrCpy $R1 "$R0\.folio-write-check"
    ClearErrors
    CreateDirectory $R1
    IfErrors tested
    FileOpen $R2 "$R1\check" w
    IfErrors cleanup
    FileClose $R2
    StrCpy $R3 1
  cleanup:
    Delete "$R1\check"
    RMDir $R1
  tested:
  Exch $R3
  Exch
  Pop $R2
  Exch
  Pop $R1
  Exch
  Pop $R0
FunctionEnd

; Folder page: keep Next disabled, and say why, while the folder can't be used.
Function .onVerifyInstDir
  Push $0
  Push $1
  Call FolioCheckInstDir
  Pop $0
  ${IfNot} ${Silent}
  ${AndIf} $HWNDPARENT != 0
    FindWindow $1 "#32770" "" $HWNDPARENT
    GetDlgItem $1 $1 1006
    ${If} $1 != 0
      ${If} $0 == 1
        SendMessage $1 ${WM_SETTEXT} 0 "STR:Setup will install ${PRODUCT_NAME} in the following folder. To install in a different folder, click Browse and select another folder. Click Next to continue."
      ${Else}
        SendMessage $1 ${WM_SETTEXT} 0 "STR:This Windows account can't create folders here, so ${PRODUCT_NAME} can't be installed in this location. Pick a folder you can save files in, such as the one Setup suggested."
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ${If} $0 != 1
    Pop $1
    Pop $0
    Abort
  ${EndIf}
  Pop $1
  Pop $0
FunctionEnd
!endif

; A silent update into a folder it can't rebuild stops before anything is
; removed, so the installed copy keeps working.
!macro customInit
  ${If} ${Silent}
    Push $0
    Call FolioCheckInstDir
    Pop $0
    ${If} $0 != 1
      MessageBox MB_OK|MB_ICONEXCLAMATION "${PRODUCT_NAME} couldn't update itself: this Windows account can't create folders where it is installed ($INSTDIR).$\r$\n$\r$\nYour current version still works. To get updates, reinstall ${PRODUCT_NAME} from its setup file and keep the folder Setup suggests."
      ${GetParameters} $0
      ClearErrors
      ${GetOptions} $0 "--force-run" $0
      ${IfNot} ${Errors}
        Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
      ${EndIf}
      SetErrorLevel 2
      Quit
    ${EndIf}
    Pop $0
  ${EndIf}
!macroend

!macro customInstall
  !insertmacro AddVerb ".pdf" "Edit" "Edit with Folio" "--edit" "0"
  !insertmacro AddVerb ".pdf" "Merge" "Merge with Folio" "--merge" "1"
  !insertmacro AddVerb ".pdf" "Compress" "Compress with Folio" "--compress" "0"
  !insertmacro AddVerb ".jpg" "Convert" "Convert to PDF with Folio" "--images" "1"
  !insertmacro AddVerb ".jpeg" "Convert" "Convert to PDF with Folio" "--images" "1"
  !insertmacro AddVerb ".png" "Convert" "Convert to PDF with Folio" "--images" "1"
  !insertmacro AddVerb ".webp" "Convert" "Convert to PDF with Folio" "--images" "1"
  !insertmacro AddVerb ".bmp" "Convert" "Convert to PDF with Folio" "--images" "1"
  !insertmacro AddVerb ".gif" "Convert" "Convert to PDF with Folio" "--images" "1"
  !insertmacro AddVerb ".tif" "Convert" "Convert to PDF with Folio" "--images" "1"
  !insertmacro AddVerb ".tiff" "Convert" "Convert to PDF with Folio" "--images" "1"
  !insertmacro AddVerb ".docx" "Convert" "Convert to PDF with Folio" "--create" "0"
  !insertmacro AddVerb ".txt" "Convert" "Convert to PDF with Folio" "--create" "0"
  !insertmacro AddVerb ".md" "Convert" "Convert to PDF with Folio" "--create" "0"
  !insertmacro AddVerb ".markdown" "Convert" "Convert to PDF with Folio" "--create" "0"
  !insertmacro AddVerb ".html" "Convert" "Convert to PDF with Folio" "--create" "0"
  !insertmacro AddVerb ".htm" "Convert" "Convert to PDF with Folio" "--create" "0"
!macroend

!macro customUnInstall
  !insertmacro RemoveVerb ".pdf" "Edit"
  !insertmacro RemoveVerb ".pdf" "Merge"
  !insertmacro RemoveVerb ".pdf" "Compress"
  !insertmacro RemoveVerb ".jpg" "Convert"
  !insertmacro RemoveVerb ".jpeg" "Convert"
  !insertmacro RemoveVerb ".png" "Convert"
  !insertmacro RemoveVerb ".webp" "Convert"
  !insertmacro RemoveVerb ".bmp" "Convert"
  !insertmacro RemoveVerb ".gif" "Convert"
  !insertmacro RemoveVerb ".tif" "Convert"
  !insertmacro RemoveVerb ".tiff" "Convert"
  !insertmacro RemoveVerb ".docx" "Convert"
  !insertmacro RemoveVerb ".txt" "Convert"
  !insertmacro RemoveVerb ".md" "Convert"
  !insertmacro RemoveVerb ".markdown" "Convert"
  !insertmacro RemoveVerb ".html" "Convert"
  !insertmacro RemoveVerb ".htm" "Convert"
!macroend
