#!/bin/bash
# Doppio clic: collega (o ricollega) l'account Garmin alla web app Coach Garmin.
cd "$(dirname "$0")"
node collega-garmin.mjs
echo
read -n 1 -s -r -p "Premi un tasto per chiudere…"
