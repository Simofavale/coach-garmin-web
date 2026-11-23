#!/bin/bash
# Doppio clic: collega (o ricollega) gli allenamenti MyWhoosh alla web app Coach Garmin.
cd "$(dirname "$0")"
node collega-mywhoosh.mjs
echo
read -n 1 -s -r -p "Premi un tasto per chiudere…"
