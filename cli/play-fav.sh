#!/bin/bash
# Load the fav playlist, shuffled, and start playing.
# Called by cover-hook.lua when the Play media key is pressed while idle.

cd /Users/kt/code/vox/cli || exit 1
/usr/local/bin/node vox-cli.js playlist -s
