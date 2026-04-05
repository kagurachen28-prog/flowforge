#!/bin/bash
export PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH"
node /home/test/.openclaw/workspace/flowforge/dist/flowforge.js "$@"
