#!/bin/bash
# Doppio clic: apre la web app dal Mac (anche dall'iPhone sulla stessa rete Wi-Fi).
# Con --demo mostra dati di prova, senza account Garmin.
cd "$(dirname "$0")"
( sleep 2; open "http://localhost:5174" ) &
node server.mjs "$@"
