Option Explicit
' Overlayr launcher - starts the app without a console window.
Dim sh, fso, root, exe
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
exe = root & "\node_modules\electron\dist\electron.exe"

On Error Resume Next
sh.Environment("Process").Remove("ELECTRON_RUN_AS_NODE")
On Error GoTo 0

sh.CurrentDirectory = root
sh.Run """" & exe & """ """ & root & """", 1, False
