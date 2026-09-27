Output docs/assets/demo.gif
Set FontSize 18
Set Width 1200
Set Height 700
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms
Set PlaybackSpeed 1.0

Type "npm i -g moragent"
Enter
Sleep 1s
Type "mkdir app && cd app"
Enter
Type "mora init --yes"
Enter
Sleep 1s
Type "mora plan \"API de tareas con frontend React\""
Enter
Sleep 1s
Type "mora spec status"
Enter
Sleep 700ms
Type "mora up --dry-run"
Enter
Sleep 700ms
Type "mora dispatch backend \"Crear endpoints CRUD de tareas\" --dry-run"
Enter
Sleep 700ms
Type "mora board"
Enter
Sleep 700ms
Type "mora memory recall auth"
Enter
Sleep 1s
