# Agente comercial IA multicanal

Proyecto de automatización comercial para **Rose Holding IA**. Combina un agente de voz y un agente de WhatsApp para captar prospectos, entender sus necesidades, guardar la información y reservar reuniones automáticamente.

## Qué hace

- Atiende conversaciones por voz y WhatsApp.
- Hace preguntas comerciales de forma natural.
- Identifica nombre, empresa, rubro, problema y procesos manuales.
- Guarda y actualiza los datos del prospecto en Google Sheets.
- Consulta la disponibilidad real de Google Calendar.
- Crea reuniones de 30 minutos con enlace de Google Meet.
- Envía avisos de nuevas citas por Telegram.
- Guarda el historial de conversaciones y resultados.
- Permite cancelar o reagendar citas conservando la información del cliente.

## Arquitectura

```text
Vapi (voz) ───────┐
                  ├── n8n ── Apps Script ── Google Sheets
WhatsApp ─────────┘             │           └─ Google Calendar + Meet
                                └──────────── Telegram
```

### Componentes

| Componente | Responsabilidad |
|---|---|
| Vapi | Conversación de voz y llamadas de herramientas |
| WhatsApp/YCloud | Canal de chat, audio e imágenes |
| n8n | Orquestación de workflows e integración entre servicios |
| Google Apps Script | Lógica central de agenda, Calendar y Sheets |
| Google Sheets | CRM ligero: leads, citas y conversaciones |
| Google Calendar | Disponibilidad y reuniones reales |
| Telegram | Avisos al equipo comercial |

## Flujo de una cita

1. El agente conversa con el prospecto.
2. Obtiene nombre y apellido, empresa, rubro, problema y proceso a automatizar.
3. Guarda los datos en `Leads`.
4. Consulta huecos disponibles en Google Calendar.
5. Ofrece únicamente horarios devueltos por el calendario.
6. Crea la cita y el enlace de Meet.
7. Guarda la cita en `Citas`.
8. Envía una alerta por Telegram.

La cita solo se confirma cuando Calendar devuelve un identificador real del evento.

## Estructura del repositorio

```text
apps-script/
  Code.gs              Puente entre n8n, Sheets y Calendar
  appsscript.json      Configuración del proyecto Apps Script

workflows/
  WF-02-vapi-tools.json              Herramientas del agente de voz
  WF-11-postcall.json                Procesamiento posterior a la llamada
  WF - 15 Ycloud chat Agent.json     Agente de WhatsApp
  WF - 16 no ycloud chat Agent.json  Agente de chat de prueba

vapi/
  prompt-inbound.md       Prompt del agente de voz
  assistant-inbound.json  Configuración del asistente de voz
  build-assistant.js      Script de construcción/configuración

whatsapp/
  prompt-agente.md        Prompt comercial del agente
  prompt-chat.md          Reglas de conversación por chat

scripts/
  sync-n8n.ps1          Sincronización de workflows
  sync-vapi.ps1         Sincronización de asistentes Vapi
  apply-n8n.ps1         Aplicación de cambios en n8n
```

Los archivos de backup e históricos no forman parte de la documentación principal y están excluidos mediante `.gitignore`.

## Modelo de datos

### Leads

Contiene el perfil comercial del prospecto:

- Nombre completo
- Empresa
- Rubro
- Problema
- Procesos manuales
- Teléfono y email
- Urgencia, decisor e interés
- Score y estado comercial

### Citas

Contiene la trazabilidad de la reunión:

- Fecha y hora
- Cliente y teléfono
- Lead ID
- Estado: `cita_agendada`, `cancelada` o `reagendada`
- Event ID de Google Calendar
- Enlace de Meet
- Agente que creó la cita

### Conversaciones

Guarda el resumen, resultado y referencia de la conversación o llamada.

## Reglas de negocio

- Zona horaria: `Europe/Madrid`.
- Duración: 30 minutos.
- Horarios: 09:00–11:00 y 14:00–17:00.
- Antelación mínima: 3 horas.
- Margen entre citas: 15 minutos.
- La disponibilidad se valida en el servidor, no en el modelo.
- El agente no inventa horarios.
- No confirma una cita si no existe un `event_id` real.

## Decisiones técnicas

### Apps Script como puente central

La lógica de Calendar y Sheets está concentrada en un único servicio. Esto evita duplicar reglas entre los agentes y permite que voz y WhatsApp utilicen la misma validación de horarios.

### Validación fuera del modelo

El agente propone y conversa, pero el servidor decide si una cita es válida. Así se evitan horarios inventados, dobles reservas y errores de zona horaria.

### Escritura incremental

Los datos del lead se actualizan solo con la información nueva, evitando borrar datos obtenidos anteriormente.

## Seguridad

Las credenciales reales no forman parte de este repositorio. Deben configurarse mediante variables de entorno, propiedades de Apps Script o credenciales de n8n.

Antes de publicar el proyecto hay que comprobar que no aparezcan:

- API keys
- Tokens de bots
- Secretos compartidos
- IDs privados de despliegues
- URLs internas

## Puesta en marcha

1. Configurar las credenciales en n8n y Apps Script.
2. Configurar las propiedades `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID`.
3. Configurar el ID de Google Sheets y Calendar.
4. Importar o sincronizar los workflows.
5. Desplegar Apps Script como aplicación web.
6. Ejecutar una prueba de disponibilidad.
7. Ejecutar una conversación de prueba.

Cuando se modifica `Code.gs`, hay que crear una **nueva versión del despliegue** de Apps Script.

## Limitaciones conocidas

- La transferencia a una persona requiere conectar una herramienta de transferencia real del proveedor de voz.
- WhatsApp depende de la configuración y aprobación del proveedor del canal.
- Para producción conviene añadir reintentos, logs estructurados y pruebas automáticas.

## Objetivo de la evaluación

El proyecto demuestra un flujo completo de extremo a extremo:

```text
Conversación → Cualificación → CRM → Disponibilidad → Reserva → Meet → Notificación
```