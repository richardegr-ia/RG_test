/**
 * Genera vapi/assistant.json a partir de vapi/prompt.md
 * Uso:  node vapi/build-assistant.js
 *
 * Cambia N8N_BASE_URL y TOOL_SECRET por tus valores reales.
 * El secreto se envía como cabecera x-vapi-secret (server.secret).
 */

const fs = require('fs');
const path = require('path');

const N8N_BASE_URL = (process.argv[2] || 'https://TU-N8N.ejemplo.com').replace(/\/+$/, '');
const VOICE_ID = process.argv[3] || '';
const TOOL_SECRET = 'YOUR_SHARED_SECRET';

const prompt = fs
  .readFileSync(path.join(__dirname, 'prompt.md'), 'utf8')
  .trim()
  .replace(/\[NOMBRE\]/g, 'Julian')
  .replace(/\[AGENCIA\]/g, 'Rose Holding IA');

const toolServer = {
  url: `${N8N_BASE_URL}/webhook/vapi-tools`,
  timeoutSeconds: 30,
  headers: { 'x-vapi-secret': TOOL_SECRET }
};

const tools = [
  {
    type: 'function',
    async: false,
    function: {
      name: 'consultar_disponibilidad',
      description:
        'Consulta los huecos reales del calendario del comercial para los proximos 14 dias. Usala solo cuando el prospecto haya aceptado una reunion.',
      parameters: {
        type: 'object',
        properties: {
          desde: { type: 'string', description: 'ISO 8601 opcional. Por defecto ahora.' },
          hasta: { type: 'string', description: 'ISO 8601 opcional. Por defecto +14 dias.' }
        },
        required: []
      }
    },
    server: toolServer,
    messages: [
      { type: 'request-start', content: 'Déjame ver la agenda un segundo.' }
    ]
  },
  {
    type: 'function',
    async: false,
    function: {
      name: 'crear_cita',
      description:
        'Crea la reunion en el calendario. Solo cuando el prospecto haya confirmado dia y hora. No pidas el email: el enlace de la videollamada se envia por WhatsApp al numero desde el que llama.',
      parameters: {
        type: 'object',
        properties: {
          nombre: { type: 'string' },
          empresa: { type: 'string' },
          inicio: { type: 'string', description: 'Copia literal el ISO entre corchetes que devolvio consultar_disponibilidad, p. ej. 2026-11-03T10:00:00.000+01:00. No lo recalcules.' },
          motivo: { type: 'string', description: 'Resumen del dolor o necesidad en una frase.' }
        },
        required: ['nombre', 'inicio']
      }
    },
    server: toolServer,
    messages: [
      { type: 'request-start', content: 'Perfecto, te lo reservo ahora mismo.' }
    ]
  },
  {
    type: 'function',
    async: false,
    function: {
      name: 'guardar_datos',
      description:
        'Guarda en el CRM cualquier dato nuevo que el prospecto cuente. Llamala en cuanto tengas un dato relevante, sin esperar al final.',
      parameters: {
        type: 'object',
        properties: {
          nombre: { type: 'string' },
          empresa: { type: 'string' },
          sector: { type: 'string' },
          tamano: { type: 'string', description: 'Numero aproximado de empleados.' },
          problema: { type: 'string' },
          procesos_manuales: { type: 'string' },
          quiere_automatizar: { type: 'string' },
          urgencia: { type: 'string', enum: ['alta', 'media', 'baja', 'desconocida'] },
          decisor: { type: 'boolean' }
        },
        required: []
      }
    },
    server: toolServer
  },
  {
    type: 'function',
    async: false,
    function: {
      name: 'escalar_humano',
      description:
        'Transfiere la llamada a una persona del equipo cuando el prospecto lo pide, hay enfado o el caso queda fuera del alcance del agente.',
      parameters: {
        type: 'object',
        properties: {
          motivo: { type: 'string' }
        },
        required: ['motivo']
      }
    },
    server: toolServer,
    messages: [
      { type: 'request-start', content: 'Te paso con un compañero del equipo.' }
    ]
  }
];

const COMERCIAL = 'Julian';
const AGENCIA = 'Rose Holding IA';
const TELEFONO_TRANSFERENCIA = '+34600000000'; // numero de pruebas

const assistant = {
  name: 'Comercial Outbound · Rose Holding IA',
  firstMessage:
    `Hola, soy ${COMERCIAL}, de ${AGENCIA}. Te llamo porque pediste información sobre automatización con IA y quería ver si tiene sentido en vuestro caso. ¿Te pillo dos minutos?`,
  firstMessageMode: 'assistant-speaks-first',
  model: {
    provider: 'openai',
    model: 'gpt-4o',
    temperature: 0.2,
    maxTokens: 220,
    messages: [{ role: 'system', content: prompt }],
    tools: tools
  },
  transcriber: {
    provider: 'deepgram',
    model: 'nova-3',
    language: 'es',
    smartFormat: true,
    endpointing: 350
  },
  // Voz: si no se pasa voiceId, se omite y Vapi usa la suya por defecto.
  // Para fijarla:  node vapi/build-assistant.js <URL_N8N> <VOICE_ID_11LABS>
  ...(VOICE_ID
    ? {
        voice: {
          provider: '11labs',
          voiceId: VOICE_ID,
          model: 'eleven_multilingual_v2',
          stability: 0.45,
          similarityBoost: 0.75,
          speed: 1.0
        }
      }
    : {}),
  server: {
    url: `${N8N_BASE_URL}/webhook/vapi-events`,
    headers: { 'x-vapi-secret': TOOL_SECRET }
  },
  voicemailDetection: {
    provider: 'vapi',
    backoffPlan: {
      maxRetries: 2,
      startAtSeconds: 4,
      frequencySeconds: 3
    }
  },
  voicemailMessage:
    `Hola, soy ${COMERCIAL} de ${AGENCIA}. Te llamaba por la información que pediste sobre automatización con IA. Te dejo un WhatsApp y hablamos cuando te venga bien. Gracias.`,
  endCallPhrases: ['adiós', 'hasta luego', 'no me interesa'],
  maxDurationSeconds: 420,
  silenceTimeoutSeconds: 20,
  responseDelaySeconds: 0.4,
  llmRequestDelaySeconds: 0.1,
  backgroundSound: 'off',
  // Fluidez: asentimientos ("mm", "ajá") mientras habla el prospecto
  backchannelingEnabled: true,
  // Que se le pueda interrumpir ya en el saludo
  firstMessageInterruptionsEnabled: true,
  // Arranca a hablar antes (0.4 -> 0.3) para que no haya silencios
  startSpeakingPlan: {
    waitSeconds: 0.6,
    smartEndpointingEnabled: true
  },
  // Cede el turno en cuanto el prospecto dice 2 palabras
  stopSpeakingPlan: {
    numWords: 2,
    voiceSeconds: 0.2,
    backoffSeconds: 1,
    acknowledgementPhrases: ['vale', 'ajá', 'aja', 'mmm', 'sí', 'ya', 'claro', 'entiendo'],
    interruptionPhrases: ['para', 'espera', 'un momento', 'oye']
  },
  artifactPlan: {
    recordingEnabled: true,
    transcriptPlan: {
      enabled: true,
      assistantName: 'Asistente'
    }
  },
  analysisPlan: {
    summaryPlan: {
      enabled: true
    },
    structuredDataPlan: {
      enabled: true,
      schema: {
        type: 'object',
        properties: {
          nombre: { type: 'string' },
          empresa: { type: 'string' },
          sector: { type: 'string' },
          tamano: { type: 'string' },
          problema: { type: 'string' },
          procesos_manuales: { type: 'string' },
          quiere_automatizar: { type: 'string' },
          urgencia: { type: 'string', enum: ['alta', 'media', 'baja', 'desconocida'] },
          decisor: { type: 'boolean' },
          interes: { type: 'string', enum: ['alto', 'medio', 'bajo'] },
          score: { type: 'number', description: '0-100 segun encaje, dolor, urgencia y autoridad' },
          objecion: { type: 'string' },
          resultado: {
            type: 'string',
            enum: ['cita', 'callback', 'info', 'no_interesado', 'humano', 'sin_contacto']
          },
          fecha_cita: { type: 'string', description: 'ISO 8601 si se agendo' },
          email: { type: 'string' },
          proximo_paso: { type: 'string' }
        },
        required: ['resultado', 'interes', 'score']
      }
    },
    successEvaluationPlan: {
      enabled: false
    }
  }
};

fs.writeFileSync(
  path.join(__dirname, 'assistant.json'),
  JSON.stringify(assistant, null, 2) + '\n',
  'utf8'
);

console.log('OK -> vapi/assistant.json');
