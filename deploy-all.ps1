# Despliega el dashboard a las 2 instancias Vercel:
#   dealbot-panama.vercel.app   (carpeta pa/)
#   dealbot-colombia.vercel.app (carpeta co/)
# index.html en la raiz es el MAESTRO (config-driven): se edita UNA vez y este
# script lo copia a pa/ y co/. El pais lo decide el hostname en runtime.
# Cada carpeta conserva su .vercel/ (enlace al proyecto) y sus logos/ propios.
$root = $PSScriptRoot

foreach ($inst in @("pa", "co")) {
  Copy-Item "$root\index.html" "$root\$inst\index.html" -Force
  Set-Location "$root\$inst"
  npx vercel deploy --prod --yes 2>&1 | Select-String -Pattern "ready" | Select-Object -Last 1
  Set-Location $root
}
Write-Host "Deploy completo: pa (Panama) + co (Colombia)"
