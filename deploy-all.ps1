# Despliega el dashboard a las 3 instancias Vercel:
#   dealbot-panama.vercel.app  (canonica PA)
#   dealbot-colombia.vercel.app (canonica CO)
#   dealbot-atun.vercel.app    (alias legado PA - enlaces viejos y alertas Telegram)
# El pais lo decide el hostname en runtime (config PAISES en index.html).
$root = $PSScriptRoot
Set-Location $root
npx vercel deploy --prod --yes 2>&1 | Select-String -Pattern "ready" | Select-Object -Last 1

foreach ($inst in @("dealbot-panama", "dealbot-colombia")) {
  Copy-Item "$root\index.html" "$root\$inst\index.html" -Force
  Set-Location "$root\$inst"
  npx vercel deploy --prod --yes 2>&1 | Select-String -Pattern "ready" | Select-Object -Last 1
  Set-Location $root
}
Write-Host "Deploy completo: atun (alias) + panama + colombia"
