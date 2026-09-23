; Adds the File Explorer right-click entries for the installing user, and
; removes them on uninstall. Mirrors electron/shell-integration.cjs.
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

!macro customInstall
  !insertmacro AddVerb ".pdf" "Edit" "Edit with PDF Maker" "--edit" "0"
  !insertmacro AddVerb ".pdf" "Merge" "Merge with PDF Maker" "--merge" "1"
  !insertmacro AddVerb ".pdf" "Compress" "Compress with PDF Maker" "--compress" "0"
  !insertmacro AddVerb ".jpg" "Convert" "Convert to PDF with PDF Maker" "--images" "1"
  !insertmacro AddVerb ".jpeg" "Convert" "Convert to PDF with PDF Maker" "--images" "1"
  !insertmacro AddVerb ".png" "Convert" "Convert to PDF with PDF Maker" "--images" "1"
  !insertmacro AddVerb ".webp" "Convert" "Convert to PDF with PDF Maker" "--images" "1"
  !insertmacro AddVerb ".bmp" "Convert" "Convert to PDF with PDF Maker" "--images" "1"
  !insertmacro AddVerb ".gif" "Convert" "Convert to PDF with PDF Maker" "--images" "1"
  !insertmacro AddVerb ".tif" "Convert" "Convert to PDF with PDF Maker" "--images" "1"
  !insertmacro AddVerb ".tiff" "Convert" "Convert to PDF with PDF Maker" "--images" "1"
  !insertmacro AddVerb ".docx" "Convert" "Convert to PDF with PDF Maker" "--create" "0"
  !insertmacro AddVerb ".txt" "Convert" "Convert to PDF with PDF Maker" "--create" "0"
  !insertmacro AddVerb ".md" "Convert" "Convert to PDF with PDF Maker" "--create" "0"
  !insertmacro AddVerb ".markdown" "Convert" "Convert to PDF with PDF Maker" "--create" "0"
  !insertmacro AddVerb ".html" "Convert" "Convert to PDF with PDF Maker" "--create" "0"
  !insertmacro AddVerb ".htm" "Convert" "Convert to PDF with PDF Maker" "--create" "0"
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
