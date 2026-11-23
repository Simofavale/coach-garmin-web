#!/bin/bash
# Doppio clic: apre la web app con dati di prova (senza account Garmin), anche dall'iPhone sulla stessa rete Wi-Fi.
cd "$(dirname "$0")"
( sleep 2; open "http://localhost:5174" ) &
node server.mjs --demo
