!macro jawUpdateUserPath MODE
  InitPluginsDir
  File "/oname=$PLUGINSDIR\update-user-path.ps1" "${BUILD_RESOURCES_DIR}\update-user-path.ps1"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\update-user-path.ps1" -Dir "$INSTDIR\resources\server\bin" -Mode ${MODE}'
  Pop $0
  ${If} $0 != 0
    DetailPrint "cli-jaw: could not update the user PATH (exit $0). The app still works; add $INSTDIR\resources\server\bin to PATH to use jaw from a terminal."
  ${EndIf}
!macroend

!macro customInstall
  !insertmacro jawUpdateUserPath add
!macroend

!macro customUnInstall
  !insertmacro jawUpdateUserPath remove
!macroend
