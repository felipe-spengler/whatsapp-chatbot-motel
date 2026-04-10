/**
 * ============================================================
 *  PROTEÇÃO EM 3 CAMADAS — VPS Guard
 * ============================================================
 *  Camada 1 — MEMÓRIA : limite de heap + limpeza de sessões
 *  Camada 2 — IO      : timeouts de API + cache de DB
 *  Camada 3 — CPU     : fila de processamento + rate limiter
 * ============================================================
 */

// ─── CAMADA 1: MEMÓRIA ────────────────────────────────────────────────────────

//  ⚠️  Valores hardcoded conservadores para VPS com ~1–2 GB RAM + Docker + Chromium
//  Não é necessário definir variáveis de ambiente; estes já são os valores de produção.

const HEAP_LIMIT_MB   = parseInt(process.env.HEAP_LIMIT_MB   || '650');  // alerta em 650 MB (aprox 85% do heap de 768 MB)
const SESSION_TTL_MS  = parseInt(process.env.SESSION_TTL_MS  || String(1.5 * 60 * 60 * 1000)); // 1.5h — libera RAM mais agressivo
const MEMORY_CHECK_MS = parseInt(process.env.MEMORY_CHECK_MS || String(2 * 60 * 1000));       // 2 min (mais frequente)

/**
 * Monitora uso de heap e dispara GC + alerta quando passar do limite.
 * @param {object} sessions  - Referência ao mapa de sessões do handler.js
 * @param {Function} onCritical - Callback chamado quando memória está crítica (pode reiniciar).
 */
function startMemoryWatchdog(sessions, onCritical) {
    setInterval(() => {
        const used = process.memoryUsage();
        const heapMB = Math.round(used.heapUsed / 1024 / 1024);
        const rssMB  = Math.round(used.rss       / 1024 / 1024);

        console.log(`[MEM] Heap: ${heapMB} MB | RSS: ${rssMB} MB`);

        // — Limpeza de sessões inativas (cada ciclo de 5 min) —
        const now = Date.now();
        let cleaned = 0;
        for (const from in sessions) {
            const s = sessions[from];
            if (s.isProcessing) continue; // nunca limpa quem está processando

            const lastActivity = s.lastBotSentTime || s.lastActivity || s.lastHumanInteraction || 0;
            if (now - lastActivity > SESSION_TTL_MS) {
                delete sessions[from];
                cleaned++;
            }
        }
        if (cleaned > 0) console.log(`[MEM] ${cleaned} sessão(ões) inativas removidas.`);

        // — GC manual se disponível —
        if (global.gc) {
            global.gc();
            console.log('[MEM] GC manual executado.');
        }

        // — Alerta de heap crítico —
        if (heapMB > HEAP_LIMIT_MB) {
            console.error(`[MEM] ⚠️  Heap CRÍTICO: ${heapMB} MB > limite ${HEAP_LIMIT_MB} MB!`);
            if (typeof onCritical === 'function') onCritical(heapMB);
        }
    }, MEMORY_CHECK_MS);
}

// ─── CAMADA 2: IO ─────────────────────────────────────────────────────────────

const CIRCUIT_STATES = {}; // { serviceName: { failures, openUntil } }
const CB_THRESHOLD   = parseInt(process.env.CB_THRESHOLD || '3');     // abre após 3 falhas (era 4)
const CB_OPEN_MS     = parseInt(process.env.CB_OPEN_MS   || '45000'); // fica aberto 45s (era 30s)

/**
 * Circuit Breaker genérico para chamadas de IO (APIs externas, banco, etc.)
 * Evita que falhas em cascata congelem a fila de CPU.
 *
 * @param {string}   name    - Identificador do serviço (ex: 'groq', 'mysql')
 * @param {Function} fn      - Async function a executar
 * @param {Function} fallback - Async fallback se o circuito estiver aberto
 */
async function withCircuitBreaker(name, fn, fallback) {
    if (!CIRCUIT_STATES[name]) {
        CIRCUIT_STATES[name] = { failures: 0, openUntil: 0 };
    }

    const state = CIRCUIT_STATES[name];

    if (Date.now() < state.openUntil) {
        console.warn(`[CB] Circuito '${name}' ABERTO — usando fallback.`);
        return typeof fallback === 'function' ? await fallback() : null;
    }

    try {
        const result = await fn();
        // Sucesso: zera contador de falhas
        state.failures = 0;
        return result;
    } catch (err) {
        state.failures++;
        console.error(`[CB] Falha #${state.failures} no serviço '${name}':`, err.message);

        if (state.failures >= CB_THRESHOLD) {
            state.openUntil = Date.now() + CB_OPEN_MS;
            console.error(`[CB] 🔴 Circuito '${name}' ABERTO por ${CB_OPEN_MS / 1000}s após ${state.failures} falhas.`);
        }

        if (typeof fallback === 'function') return await fallback();
        throw err;
    }
}

/**
 * Wrapper de timeout para qualquer Promise.
 * @param {Promise} promise
 * @param {number}  ms
 * @param {string}  label
 */
function withTimeout(promise, ms, label = 'operação') {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`[TIMEOUT] ${label} excedeu ${ms}ms`)), ms)
        )
    ]);
}

// ─── CAMADA 3: CPU ────────────────────────────────────────────────────────────

//  MAX_CONCURRENT = 2: Chromium + WPPConnect já ocupam ~200–350 MB sozinhos.
//  Rodar 3 respostas de IA ao mesmo tempo junto com o browser é risco de OOM.
const MAX_CONCURRENT  = parseInt(process.env.MAX_CONCURRENT  || '2');  // máx 2 jobs simultâneos
const RATE_COOLDOWN_MS = parseInt(process.env.RATE_COOLDOWN_MS || '3000'); // mínimo 3s entre msgs do mesmo número
const RATE_LIMIT_MAX  = parseInt(process.env.RATE_LIMIT_MAX  || '6');  // máx 6 msgs por minuto por número (era 10)
const RATE_WINDOW_MS  = parseInt(process.env.RATE_WINDOW_MS  || '60000'); // janela de 1 minuto

let activeJobs = 0;
const processingQueue = [];
const rateLimitMap = {}; // { from: { count, windowStart } }

/**
 * Verifica se o número excedeu o limite de mensagens por minuto.
 * @param {string} from
 * @returns {boolean} true se deve ser BLOQUEADO
 */
function isRateLimited(from) {
    const now = Date.now();
    if (!rateLimitMap[from]) {
        rateLimitMap[from] = { count: 1, windowStart: now, lastMsg: now };
        return false;
    }

    const rl = rateLimitMap[from];

    // Cooldown por número: ignora se a última mensagem foi há menos de 3s
    // (evita que msgs rápidas consecutivas entupam a fila)
    if (now - rl.lastMsg < RATE_COOLDOWN_MS) {
        console.warn(`[RATE] ${from} enviou msgs muito rápido (cooldown ${RATE_COOLDOWN_MS}ms). Ignorando.`);
        rl.lastMsg = now;
        return true;
    }
    rl.lastMsg = now;

    // Nova janela de 1 min?
    if (now - rl.windowStart > RATE_WINDOW_MS) {
        rl.count = 1;
        rl.windowStart = now;
        return false;
    }

    rl.count++;
    if (rl.count > RATE_LIMIT_MAX) {
        console.warn(`[RATE] ${from} excedeu ${RATE_LIMIT_MAX} msgs/min. Ignorando.`);
        return true;
    }

    return false;
}

/**
 * Limpa entradas antigas do rate limiter (roda a cada hora).
 */
setInterval(() => {
    const now = Date.now();
    for (const from in rateLimitMap) {
        if (now - rateLimitMap[from].windowStart > RATE_WINDOW_MS * 2) {
            delete rateLimitMap[from];
        }
    }
}, 60 * 60 * 1000);

/**
 * Executa um job na fila de CPU com controle de concorrência.
 * @param {Function} job - async function a executar
 * @returns {Promise}
 */
async function enqueueJob(job) {
    return new Promise((resolve, reject) => {
        processingQueue.push({ job, resolve, reject });
        drainQueue();
    });
}

function drainQueue() {
    if (activeJobs >= MAX_CONCURRENT || processingQueue.length === 0) return;

    const { job, resolve, reject } = processingQueue.shift();
    activeJobs++;

    Promise.resolve()
        .then(() => job())
        .then(result => {
            resolve(result);
        })
        .catch(err => {
            reject(err);
        })
        .finally(() => {
            activeJobs--;
            drainQueue(); // tenta o próximo da fila
        });
}

/**
 * Retorna métricas atuais para o dashboard/log.
 */
function getProtectionMetrics() {
    const mem = process.memoryUsage();
    return {
        heapMB:       Math.round(mem.heapUsed / 1024 / 1024),
        rssMB:        Math.round(mem.rss       / 1024 / 1024),
        activeJobs,
        queueLength:  processingQueue.length,
        circuitStates: Object.fromEntries(
            Object.entries(CIRCUIT_STATES).map(([k, v]) => [
                k,
                Date.now() < v.openUntil ? 'OPEN' : v.failures > 0 ? 'HALF' : 'CLOSED'
            ])
        )
    };
}

module.exports = {
    // Camada 1 — Memória
    startMemoryWatchdog,

    // Camada 2 — IO
    withCircuitBreaker,
    withTimeout,

    // Camada 3 — CPU
    isRateLimited,
    enqueueJob,
    getProtectionMetrics,
};
