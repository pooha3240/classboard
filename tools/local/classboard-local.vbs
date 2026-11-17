' classboard local edition launcher: runs classboard-local.ps1 without a console window.
' Usage: wscript classboard-local.vbs [server|stop]
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
args = ""
If WScript.Arguments.Count > 0 Then args = " -" & WScript.Arguments(0)
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\classboard-local.ps1""" & args, 0, False
