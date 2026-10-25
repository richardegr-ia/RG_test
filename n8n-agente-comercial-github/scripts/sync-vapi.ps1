# Descarga la configuracion viva de los asistentes de Vapi.
# Uso:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\sync-vapi.ps1
# Requiere la API key en %TEMP%\vapikey.txt o en la variable VAPI_API_KEY.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$dir = Join-Path $root 'vapi'

$key = $env:VAPI_API_KEY
if (-not $key -and (Test-Path "$env:TEMP\vapikey.txt")) { $key = ([IO.File]::ReadAllText("$env:TEMP\vapikey.txt")).Trim() }
if (-not $key) { throw "Falta la API key: define VAPI_API_KEY o crea %TEMP%\vapikey.txt" }

$h = @{ Authorization = "Bearer $key"; Accept = 'application/json' }
$enc = New-Object Text.UTF8Encoding($false)

# id -> archivo local
$map = [ordered]@{
  '398f30d5-1c4b-4e7c-b327-b75c1a063dc5' = 'inbound-live.json'        # asistente de voz inbound (activo)
  'e7d02cef-0c27-4e26-be37-a757e77862c0' = 'live-assistant-backup.json' # asistente outbound antiguo
}

foreach ($id in $map.Keys) {
  $a = Invoke-RestMethod -Uri "https://api.vapi.ai/assistant/$id" -Headers $h -Method Get
  $path = Join-Path $dir $map[$id]
  [IO.File]::WriteAllText($path, ($a | ConvertTo-Json -Depth 40), $enc)
  "{0,-26} tools={1} model={2}" -f $map[$id], $a.model.tools.Count, $a.model.model
}

"OK"
