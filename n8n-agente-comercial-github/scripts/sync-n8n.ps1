# Sincroniza los workflows vivos de n8n con los .json locales.
# Uso:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\sync-n8n.ps1
# Requiere la API key en %TEMP%\n8nkey.txt o en la variable N8N_API_KEY.

$ErrorActionPreference = 'Stop'

$base = 'https://YOUR_N8N_HOST/api/v1'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$dir = Join-Path $root 'workflows'

$key = $env:N8N_API_KEY
if (-not $key -and (Test-Path "$env:TEMP\n8nkey.txt")) { $key = ([IO.File]::ReadAllText("$env:TEMP\n8nkey.txt")).Trim() }
if (-not $key) { throw "Falta la API key: define N8N_API_KEY o crea %TEMP%\n8nkey.txt" }

$h = @{ 'X-N8N-API-KEY' = $key; 'Accept' = 'application/json' }
$enc = New-Object Text.UTF8Encoding($false)

# id -> nombre de archivo local
$map = [ordered]@{
  'FVacIy9vSPnz7WwR' = 'WF-02-vapi-tools.json'
  '8miJaY64Yqs2mWqA' = 'WF-11-postcall.json'
  'qePZmXnrw5iTpzZ8' = 'WF-10-dialer-outbound.json'
  'yRXsqAxiXDJJDyyb' = 'WF - 15 Ycloud chat Agent.json'
  '0vAelY2J8eeQ51i3' = 'WF - 16 no ycloud chat Agent.json'
}

foreach ($id in $map.Keys) {
  $w = Invoke-RestMethod -Uri "$base/workflows/$id" -Headers $h
  $obj = [ordered]@{
    id          = $w.id
    name        = $w.name
    active      = $w.active
    nodes       = $w.nodes
    connections = $w.connections
    settings    = $w.settings
  }
  $path = Join-Path $dir $map[$id]
  [IO.File]::WriteAllText($path, ($obj | ConvertTo-Json -Depth 100), $enc)
  "{0,-34} nodes={1,-3} active={2}" -f $map[$id], $w.nodes.Count, $w.active
}

"OK"
