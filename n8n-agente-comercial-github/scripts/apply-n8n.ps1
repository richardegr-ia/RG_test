$ErrorActionPreference = 'Stop'
$k = [IO.File]::ReadAllText("$env:TEMP\n8nkey.txt")
$h = @{ 'X-N8N-API-KEY' = $k; 'Accept' = 'application/json' }
$base = 'https://YOUR_N8N_HOST/api/v1'
$enc = New-Object Text.UTF8Encoding($false)

function Get-Wf($id) { Invoke-RestMethod -Uri "$base/workflows/$id" -Headers $h }
function Put-Wf($id, $w) {
  $body = [ordered]@{ name = $w.name; nodes = $w.nodes; connections = $w.connections; settings = $w.settings }
  $json = $body | ConvertTo-Json -Depth 100
  Invoke-RestMethod -Uri "$base/workflows/$id" -Headers $h -Method Put -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($json))
}

$oldBlock = @'
const lead_id = String(m.call?.metadata?.lead_id ?? m.metadata?.lead_id ?? '');
const call_id = String(m.call?.id ?? m.callId ?? '');
const telefono = String(m.call?.customer?.number ?? m.customer?.number ?? m.call?.metadata?.telefono ?? '');
const estado_actual = String(m.call?.metadata?.estado ?? m.metadata?.estado ?? '');
'@

$newBlock = @'
const call_id = String(m.call?.id ?? m.callId ?? '');
const telefono = String(m.call?.customer?.number ?? m.customer?.number ?? m.call?.metadata?.telefono ?? '');
const digitos = (s) => String(s || '').replace(/\D/g, '');
const tel = digitos(telefono);

// La voz outbound trae lead_id en metadata. En una llamada entrante o web no existe:
// se resuelve por telefono y, si tampoco hay telefono, con un id estable por llamada.
const lead_id = String(m.call?.metadata?.lead_id ?? m.metadata?.lead_id ?? '')
  || (tel ? 'TEL-' + tel : 'WEB-' + (call_id || String(Date.now())).slice(0, 8));
const estado_actual = String(m.call?.metadata?.estado ?? m.metadata?.estado ?? '');
const canal = String(m.call?.type ?? m.type ?? '') === 'webCall' ? 'voz_web' : 'voz';
'@

$oldReturn = 'return { json: { toolCallId: c.toolCallId ?? c.id, name: c.function?.name, args, lead_id, call_id, telefono, estado_actual } };'
$newReturn = 'return { json: { toolCallId: c.toolCallId ?? c.id, name: c.function?.name, args, lead_id, canal, call_id, telefono, estado_actual } };'

# ------------------------------------------------ WF-02
$id2 = 'FVacIy9vSPnz7WwR'
$w2 = Get-Wf $id2
$n2 = $w2.nodes | Where-Object { $_.name -eq 'Normalizar tool calls' }
$code = $n2.parameters.jsCode -replace "`r`n", "`n"

if ($code.Contains('const canal =')) { "WF-02: ya estaba parcheado, no toco nada" }
elseif (-not $code.Contains($oldBlock)) { "WF-02: BLOQUE NO ENCONTRADO - abortado"; }
elseif (-not $code.Contains($oldReturn)) { "WF-02: RETURN NO ENCONTRADO - abortado"; }
else {
  $code = $code.Replace($oldBlock, $newBlock).Replace($oldReturn, $newReturn)
  $n2.parameters.jsCode = $code
  $pc = $w2.nodes | Where-Object { $_.name -eq 'Preparar cita' }
  $pc.parameters.jsCode = $pc.parameters.jsCode.Replace("creada_por: 'agente_voz',", "creada_por: (tool.canal === 'voz_web' ? 'agente_voz_web' : 'agente_voz'),")
  $r = Put-Wf $id2 $w2
  "WF-02: guardado. active=$($r.active) updatedAt=$($r.updatedAt)"
}

# ------------------------------------------------ WF-11
$id11 = '8miJaY64Yqs2mWqA'
$w11 = Get-Wf $id11
$er = $w11.nodes | Where-Object { $_.name -eq 'Extraer report' }
$c11 = $er.parameters.jsCode -replace "`r`n", "`n"

if ($c11.Contains('const canal =')) { "WF-11: ya estaba parcheado, no toco nada" }
elseif (-not $c11.Contains("const md = call.metadata ?? {};")) { "WF-11: ANCLA NO ENCONTRADA - abortado" }
else {
  $helpers = @'
const md = call.metadata ?? {};

const digitos = (s) => String(s || '').replace(/\D/g, '');
const call_id = String(call.id ?? m.callId ?? '');
const tel = digitos(telefono);

// Igual que en vapi-tools: una llamada entrante o web no trae metadata.lead_id.
const lead_id = String(md.lead_id ?? '')
  || (tel ? 'TEL-' + tel : 'WEB-' + (call_id || String(Date.now())).slice(0, 8));
const canal = String(call.type ?? '') === 'webCall' ? 'voz_web' : 'voz';
'@
  $c11 = $c11.Replace('const md = call.metadata ?? {};', $helpers)
  $c11 = $c11.Replace("  lead_id: String(md.lead_id ?? ''),", "  lead_id: lead_id,`n  canal: canal,")
  $er.parameters.jsCode = $c11

  $cp = $w11.nodes | Where-Object { $_.name -eq 'Clasificar y programar' }
  $cp.parameters.jsCode = $cp.parameters.jsCode.Replace("  canal: 'voz',", "  canal: j.canal || 'voz',")

  $cw = $w11.nodes | Where-Object { $_.name -eq 'Confirmar WhatsApp' }
  $cw | Add-Member -NotePropertyName onError -NotePropertyValue 'continueRegularOutput' -Force

  $r = Put-Wf $id11 $w11
  "WF-11: guardado. active=$($r.active) updatedAt=$($r.updatedAt)"
}
