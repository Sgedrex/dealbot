# Despliega el dashboard a las 2 instancias Vercel:
#   dealbot-panama.vercel.app   (carpeta pa/)
#   dealbot-colombia.vercel.app (carpeta co/)
# index.html y traza.html en la raiz son los MAESTROS (config-driven): se editan
# UNA vez y este script los copia a pa/ y co/. El pais lo decide el hostname.
# NOTA: Vercel tambien auto-despliega desde GitHub usando la RAIZ del repo en cada
# push (por eso la raiz tiene index.html + traza.html + logos/). Este script es el
# camino manual; el git push hace lo mismo automaticamente.
# Cada carpeta conserva su .vercel/ (enlace al proyecto) y sus logos/ propios.
$root = $PSScriptRoot

foreach ($inst in @("pa", "co")) {
  Copy-Item "$root\index.html" "$root\$inst\index.html" -Force
  Copy-Item "$root\traza.html" "$root\$inst\traza.html" -Force
  Set-Location "$root\$inst"
  npx vercel deploy --prod --yes 2>&1 | Select-String -Pattern "ready" | Select-Object -Last 1
  Set-Location $root
}
Write-Host "Deploy completo: pa (Panama) + co (Colombia)"
