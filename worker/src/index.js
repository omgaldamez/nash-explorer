const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
  • ID del fragmento
  • Fecha (DD/MM/YYYY)
  • Subject
  • Keywords
  • Timestamp: min_sec

TIPOS DE RESPUESTA:

1. BÚSQUEDA SEMÁNTICA LIBRE:
- Presenta las declaraciones más relevantes (máx. 6, orden por similitud desc)
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

5. CONSULTAS COMBINADAS:
- Aplica todos los filtros indicados
- Especifica qué filtros se aplicaron
- Si hay pocos resultados indica qué filtro es más restrictivo
</response_format>

<critical_rules>
- NUNCA parafrasees — cita siempre el content textual exacto
- SIEMPRE incluye el ID para trazabilidad al punto en la base de datos
- SIEMPRE incluye el timestamp (min_sec) para verificación en audio
- SIEMPRE incluye la fecha
- Tono analítico y neutral — describe patrones, no interpretes políticamente
- Si no hay resultados suficientes, sugiere ampliar con keywords relacionados o rango de fechas
</critical_rules>

<examples>
<example>
Consulta: "qué se dijo sobre desaparecidos"
Respuesta:
Encontré 3 declaraciones relevantes sobre desaparecidos.

- "Y ella misma por su historia personal, de que tiene un hermano desaparecido en la época donde había represión desde el Estado."
  - ID: 766
  - Fecha: 14/11/2024
  - Subject: Desapariciones
  - Keywords: desaparecidos
  - Timestamp: 96:01

Análisis: El discurso vincula el tema de desapariciones con historias personales y con la represión estatal histórica.
</example>
</examples>`;

/* ══ BUILD-DATA helpers (para visualización scrollytelling) ══════════════ */

const MAX_KW = 999;
const MES_ES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];

function makeRng(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildData(points) {
  const rows = [];
  for (const pt of points) {
    const p = pt.payload;
    const m = p.metadata || p;
    const kw    = (m.keywords || m.keyword || '').trim().toLowerCase();
    const fecha = (m.fecha || '').trim();
    const frase = (p.content || '').trim().slice(0, 160);
    const sub   = (m.subject || '').trim();
    const id    = (m.id || '').toString();
    if (!kw || !fecha) continue;
    const parts = fecha.split('/');
    if (parts.length !== 3) continue;
    const dt = Date.UTC(+parts[2], +parts[1] - 1, +parts[0]);
    if (isNaN(dt)) continue;
    rows.push({ kw, dt, sub, frase, id });
  }

  // Top MAX_KW keywords por frecuencia
  const kwCount = {};
  rows.forEach(r => { kwCount[r.kw] = (kwCount[r.kw] || 0) + 1; });
  const KW    = Object.entries(kwCount).sort((a,b) => b[1]-a[1]).slice(0, MAX_KW).map(([k]) => k);
  const kwIdx = Object.fromEntries(KW.map((k,i) => [k,i]));

  // Meses únicos
  const moSet = new Set();
  rows.forEach(r => {
    const d = new Date(r.dt);
    moSet.add(`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`);
  });
  const moKeys   = [...moSet].sort();
  const moLabels = moKeys.map(k => {
    const [y, mo] = k.split('-');
    return `${MES_ES[+mo - 1]} ${y.slice(2)}`;
  });
  const moIdx = Object.fromEntries(moKeys.map((k,i) => [k,i]));

  // Días únicos
  const daySet = new Set(rows.map(r => r.dt));
  const dayMs  = [...daySet].sort((a,b) => a-b);

  // Dots
  const rng  = makeRng(42);
  const dots = [];
  const kwN  = new Array(KW.length).fill(0);

  rows.forEach(r => {
    const ki = kwIdx[r.kw];
    if (ki === undefined) { rng(); rng(); return; }
    const d     = new Date(r.dt);
    const moKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
    const mi    = moIdx[moKey];
    if (mi === undefined) { rng(); rng(); return; }
    const rx = +(rng() - 0.5).toFixed(4);
    const ry = +rng().toFixed(4);
    kwN[ki]++;
    dots.push([ki, mi, r.dt, rx, ry, r.sub, r.frase, r.id]);
  });

  return { kw: KW, kwN, mo: moLabels, dayMs, dots };
}

/* ── Cache de visualización (1 hora) ───────────────────────────────────── */
let _dataCache     = null;
let _dataCacheTime = 0;
const CACHE_TTL    = 60 * 60 * 1000;

/* ══ Qdrant helpers ═════════════════════════════════════════════════════ */

async function scrollAllQdrant(qdrantUrl, qdrantKey) {
  const points = [];
  let offset   = null;
  do {
    const body = { limit: 1000, with_payload: true, with_vectors: false };
    if (offset !== null) body.offset = offset;
    const res = await fetch(`${qdrantUrl}/collections/Nash/points/scroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': qdrantKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Qdrant scroll error ${res.status}: ${err}`);
    }
    const data = await res.json();
    points.push(...(data.result?.points ?? []));
    offset = data.result?.next_page_offset ?? null;
  } while (offset !== null);
  return points;
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
    headers: { 'Content-Type': 'application/json', 'api-key': qdrantKey },
    body: JSON.stringify({ vector, limit: topK, with_payload: true }),
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
      const m = p.metadata || p;
      return [
        `[${i + 1}]`,
        `ID: ${m.id || '?'}`,
        `Fecha: ${m.fecha || '?'}`,
        `Subject: ${m.subject || '?'}`,
        `Keywords: ${m.keywords || m.keyword || '?'}`,
        `Timestamp: ${m.min_sec || '?'}`,
        `Archivo: ${m.archivo || '?'}`,
        `Similitud: ${f.score?.toFixed(4) || '?'}`,
        `Texto: "${p.content || ''}"`,
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
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

/* ══ Helpers ════════════════════════════════════════════════════════════ */

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function errorResponse(message, status = 500) {
  return jsonResponse({ error: message }, status);
}

/* ══ Handler ════════════════════════════════════════════════════════════ */

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 200, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const { QDRANT_URL, QDRANT_API_KEY, GEMINI_API_KEY } = env;

    /* ── GET /data — datos para la visualización ── */
    if (request.method === 'GET' && url.pathname === '/data') {
      if (!QDRANT_URL || !QDRANT_API_KEY) {
        return errorResponse('Secrets no configurados en el Worker', 500);
      }
      try {
        const now = Date.now();
        if (!_dataCache || now - _dataCacheTime > CACHE_TTL) {
          const points   = await scrollAllQdrant(QDRANT_URL, QDRANT_API_KEY);
          _dataCache     = buildData(points);
          _dataCacheTime = now;
        }
        return jsonResponse(_dataCache);
      } catch (err) {
        return errorResponse(err.message);
      }
    }

    /* ── GET /debug — conteos para validar ingesta ── */
    if (request.method === 'GET' && url.pathname === '/debug') {
      if (!QDRANT_URL || !QDRANT_API_KEY) {
        return errorResponse('Secrets no configurados en el Worker', 500);
      }
      try {
        const points = await scrollAllQdrant(QDRANT_URL, QDRANT_API_KEY);
        const total  = points.length;

        // Contar por keyword
        const kwAll = {};
        points.forEach(pt => {
          const p = pt.payload; const m = p.metadata || p;
          const kw = (m.keywords || m.keyword || '').trim().toLowerCase() || '(vacío)';
          kwAll[kw] = (kwAll[kw] || 0) + 1;
        });
        const topKwAll = Object.entries(kwAll).sort((a,b) => b[1]-a[1]).slice(0, 20);

        // Contar por subject
        const subAll = {};
        points.forEach(pt => {
          const p = pt.payload; const m = p.metadata || p;
          const sub = (m.subject || '(vacío)').trim();
          subAll[sub] = (subAll[sub] || 0) + 1;
        });

        // Validación de campos
        let missingKw = 0, missingFecha = 0, badFecha = 0, missingId = 0;
        points.forEach(pt => {
          const p = pt.payload; const m = p.metadata || p;
          const kw    = (m.keywords || m.keyword || '').trim();
          const fecha = (m.fecha || '').trim();
          const id    = (m.id || '').toString().trim();
          if (!kw)    missingKw++;
          if (!fecha) missingFecha++;
          else if (fecha.split('/').length !== 3) badFecha++;
          if (!id)    missingId++;
        });

        return jsonResponse({
          total_scrolled:     total,
          missing_keyword:    missingKw,
          missing_fecha:      missingFecha,
          bad_fecha_format:   badFecha,
          missing_id:         missingId,
          top20_keywords:     topKwAll,
          subjects:           subAll,
          MAX_KW,
        });
      } catch (err) {
        return errorResponse(err.message);
      }
    }

    /* ── POST /query — RAG ── */
    if (request.method === 'POST' && url.pathname === '/query') {
      if (!QDRANT_URL || !QDRANT_API_KEY || !GEMINI_API_KEY) {
        return errorResponse('Secrets no configurados en el Worker', 500);
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('Body JSON inválido', 400);
      }

      const query = (body.query || '').trim();
      if (!query) return errorResponse('El campo "query" es requerido', 400);

      try {
        const vector    = await embedQuery(query, GEMINI_API_KEY);
        const fragments = await searchQdrant(vector, QDRANT_URL, QDRANT_API_KEY);
        const answer    = await generateAnswer(query, fragments, GEMINI_API_KEY);

        const sources = fragments.map(f => {
          const p = f.payload;
          const m = p.metadata || p;
          return {
            content:          p.content || '',
            id:               m.id || '',
            fecha:            m.fecha || '',
            subject:          m.subject || '',
            keywords:         m.keywords || m.keyword || '',
            min_sec:          m.min_sec || '',
            archivo:          m.archivo || '',
            score_similarity: f.score,
          };
        });

        return jsonResponse({ answer, sources });
      } catch (err) {
        return errorResponse(err.message);
      }
    }

    /* ── GET / — health check ── */
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response('Nash API — OK', { status: 200, headers: CORS_HEADERS });
    }

    return errorResponse('Not found', 404);
  },
};