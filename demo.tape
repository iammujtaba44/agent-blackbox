# VHS tape for the Agent Black Box demo GIF.
#   brew install vhs   &&   vhs demo.tape   →   docs/demo.gif
#
# Tip: run `npm run build` once beforehand so the demo's build step is instant
# and the GIF has no dead air.

Output docs/demo.gif

Set Shell "bash"
Set FontSize 16
Set Width 1200
Set Height 760
Set Padding 24
Set Theme "Dracula"
Set TypingSpeed 60ms

Type "npm run demo"
Sleep 600ms
Enter

# The demo prints over ~11s then exits cleanly; wait for it to finish.
Sleep 15s
