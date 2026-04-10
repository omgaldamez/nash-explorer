const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const SYSTEM_PROMPT = `<role>
Eres un asistente de investigación política especializado en análisis de discurso
presidencial mexicano. Trabajas con transcripciones de conferencias de prensa
indexadas con metadata estructurada.
</role>

<objective>
Recuperar, citar y analizar declaraciones con precisión académica.
El usuario es un investigador que necesita fuentes verificables con referencia
al audio original.
</objective>

<response_format>
Para CADA declaración citada incluye siempre:
  • Cita textual entre comillas
  • Fecha (DD/MM/YYYY)
  • Subject
  • Keywords
  • Timestamp: min_sec
  • Score: puntuacion_total

TIPOS DE RESPUESTA:

1. BÚSQUEDA SEMÁNTICA LIBRE:
- Presenta las declaraciones más relevantes (máx. 6, orden por puntuacion_total desc)
- Cierra con análisis del patrón discursivo

2. BÚSQUEDA POR KEYWORD:
- Agrupa por fecha para mostrar evolución temporal
- Analiza si el tratamiento del tema varía entre fechas

3. BÚSQUEDA POR SUBJECT:
- Lista declaraciones agrupadas por keyword dentro del subject
- Síntesis temática al final

4. BÚSQUEDA POR FECHA O RANGO:
- Agrupa por subject
- Resumen de agenda temática del día/periodo

5. BÚSQUEDA POR PUNTUACIÓN:
- Ordena por puntuacion_total descendente
- Formato: Score [X] | Fecha | Subject | Keywords → "cita" — Timestamp

6. CONSULTAS COMBINADAS:
- Aplica todos los filtros indicados
- Especifica qué filtros se aplicaron
</response_format>

<critical_rules>
- NUNCA parafrasees — cita siempre el content textual
- SIEMPRE incluye timestamp para trazabilidad al audio
- SIEMPRE incluye la fecha
- Prioriza puntuacion_total = 3
- Tono analítico y neutral
- Si no hay resultados sugiere ampliar la búsqueda
</critical_rules>`;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function errorResponse(message, status = 500) {
  return jsonResponse({ error: message }, status);
}

async function embedQuery(query, geminiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${geminiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'models/gemini-embedding-001',
      content: { parts: [{ text: query }] },
      taskType: 'SEMANTIC_SIMILARITY',
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini embed error ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.embedding.values;
}

async function searchQdrant(vector, qdrantUrl, qdrantKey, topK = 15) {
  const url = `${qdrantUrl}/collections/Nash/points/search`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': qdrantKey,
    },
    body: JSON.stringify({
      vector,
      limit: topK,
      with_payload: true,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Qdrant search error ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.result;
}

async function generateAnswer(query, fragments, geminiKey) {
  const context = fragments
    .map((f, i) => {
      const p = f.payload;
      const m = p.metadata || p;  // busca en metadata primero, si no en raíz
      return [
        `[${i + 1}]`,
        `Fecha: ${m.fecha || '?'}`,
        `Subject: ${m.subject || '?'}`,
        `Keywords: ${m.keywords || m.keyword || '?'}`,
        `Timestamp: ${m.min_sec || '?'}`,
        `Score: ${m.puntuacion_total ?? m.score ?? '?'}`,
        `Texto: "${p.content || p.frase || ''}"`,
      ].join('\n');
    })
    .join('\n\n---\n\n');

  const fullMessage = `${SYSTEM_PROMPT}\n\n---\n\nFRAGMENTOS RECUPERADOS:\n\n${context}\n\n---\n\nPREGUNTA DEL INVESTIGADOR:\n${query}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: fullMessage }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini chat error ${res.status}: ${err}`);
  }
  const data = await res.json();
  const answer = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  return answer;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 200, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/query') {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('Body JSON inválido', 400);
      }

      const query = (body.query || '').trim();
      if (!query) return errorResponse('El campo "query" es requerido', 400);

      const { QDRANT_URL, QDRANT_API_KEY, GEMINI_API_KEY } = env;
      if (!QDRANT_URL || !QDRANT_API_KEY || !GEMINI_API_KEY) {
        return errorResponse('Secrets no configurados en el Worker', 500);
      }

      try {
        const vector    = await embedQuery(query, GEMINI_API_KEY);
        const fragments = await searchQdrant(vector, QDRANT_URL, QDRANT_API_KEY);
        const answer    = await generateAnswer(query, fragments, GEMINI_API_KEY);

        const sources = fragments.map(f => {
          const p = f.payload;
          const m = p.metadata || p;  // busca en metadata primero, si no en raíz
          return {
            content:          p.content || p.frase || '',
            fecha:            m.fecha || '',
            subject:          m.subject || '',
            keywords:         m.keywords || m.keyword || '',
            min_sec:          m.min_sec || '',
            puntuacion_total: m.puntuacion_total ?? m.score ?? null,
            score_similarity: f.score,
          };
        });

        return jsonResponse({ answer, sources });
      } catch (err) {
        return errorResponse(err.message);
      }
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response('Nash API — OK', { status: 200, headers: CORS_HEADERS });
    }

    return errorResponse('Not found', 404);
  },
};