#!/usr/bin/env bash
# Copia os arquivos principais (raiz) para os outros lugares que os servem:
#  - Index.html / 200.html (hospedagem estática: página inicial e fallback)
#  - NailApp_Sheets/ (pasta antiga, mantida por compatibilidade de links)
#  - android-app/app/src/main/assets/ (páginas embutidas no APK)
# Rode sempre que editar App_Manicure.html, Pagina_Cliente.html ou config.js.
set -euo pipefail
cd "$(dirname "$0")/.."
ASSETS=android-app/app/src/main/assets
for dest in Index.html 200.html NailApp_Sheets/App_Manicure.html NailApp_Sheets/Index.html NailApp_Sheets/200.html "$ASSETS/App_Manicure.html"; do
  cp App_Manicure.html "$dest"
done
for dir in NailApp_Sheets "$ASSETS"; do
  cp Pagina_Cliente.html "$dir/Pagina_Cliente.html"
  cp config.js "$dir/config.js"
  cp manifest.json "$dir/manifest.json"
done
echo "✅ Cópias sincronizadas."
