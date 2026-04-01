const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const FormData = require('form-data');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('./db_service');

// ===== PROMPTS =====
const MOTEL_PROMPT = fs.readFileSync(path.join(__dirname, '..', 'prompt_ia.txt'), 'utf8');
const PRECO_PERIODO = fs.readFileSync(path.join(__dirname, '..', 'preco_periodo.txt'), 'utf8');
const PRECO_PERNOITE = fs.readFileSync(path.join(__dirname, '..', 'preco_pernoite.txt'), 'utf8');
const PRICE_CONTEXT = `\n\n[TABELA DE PREÇOS]:\nPeríodo (2h30):\n${PRECO_PERIODO}\n\nPernoite (12h):\n${PRECO_PERNOITE}\n`;

const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = 'https://api.groq.com/openai/v1';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ===== CACHE DISPONIBILIDADE =====
let availabilityCache = { data: '', lastUpdate: 0 };
const CACHE_TTL = 60000;

// ===== MENU =====
function menuInicial() {
    return `Posso te ajudar com algumas opções ✨

1️⃣ Valores para período (2h30)
2️⃣ Valores para pernoite (12h)
3️⃣ Tirar uma dúvida
4️⃣ Fazer uma reserva

Se preferir, pode me dizer direto o que precisa 💖`;
}

// ===== INTERPRETAR MENU =====
function interpretarMenu(msg) {
    const t = msg.toLowerCase().trim();
    
    // Evita acionar o menu se o usuário enviou uma frase longa
    if (msg.length > 25) return null;

    if (t === "1" || t.includes("periodo") || t.includes("2h") || t.includes("2:30")) return "periodo";
    if (t === "2" || t.includes("pernoite") || t.includes("12h")) return "pernoite";
    if (t === "3" || t.includes("duvida")) return "duvida";
    if (t === "4" || t.includes("reserva")) return "reserva";

    return null;
}

// ===== RESPOSTAS DIRETAS =====
function respostaDireta(msg) {
    const t = msg.toLowerCase().trim();

    if (["ok", "blz", "beleza", "isso"].includes(t)) {
        return "Perfeito! 😊";
    }

    if (t.includes("obrigado") || t.includes("valeu")) {
        return "Imagina! Fico à disposição 💖";
    }

    if (t.includes("hora extra")) {
        return "Hora extra: Apartamento +R$20/h | Suítes +R$30/h ✨";
    }

    if (t.includes("3 pessoas") || t.includes("mais pessoas")) {
        return "Após a 2ª pessoa, é cobrado R$ 30 por pessoa adicional 💖";
    }

    return null;
}

// ===== DETECÇÃO PREÇO =====
function detectarPreco(msg) {
    const t = msg.toLowerCase();
    
    // Se a mensagem for muito longa, provavelmente é uma dúvida mais complexa. Deixa a IA resolver.
    if (msg.length > 30) return { geral: false, periodo: false, pernoite: false };

    return {
        geral: /(preço|valor|quanto)/.test(t),
        periodo: /(2h|2:30|periodo)/.test(t),
        pernoite: /(pernoite|12h)/.test(t)
    };
}

/**
 * Função inteligente para obter o contexto de preços e disponibilidade apenas quando necessário
 */
async function getDynamicContext(userText) {
    const textLower = userText.toLowerCase();
    
    const triggerKeywords = [
        'tem', 'vago', 'disponivel', 'disponibilidade', 'quarto', 'suite', 'apto', 
        'valor', 'preço', 'preco', 'quanto', 'reserva', 'período', 'periodo', 'pernoite', 'menu'
    ];

    const needsContext = triggerKeywords.some(kw => textLower.includes(kw));
    
    if (!needsContext && userText !== "[FORÇA_CONTEXTO]") return '';

    let context = PRICE_CONTEXT;

    const now = Date.now();
    
    if (availabilityCache.data && (now - availabilityCache.lastUpdate < CACHE_TTL)) {
        return context + availabilityCache.data;
    }

    try {
        const rooms = await db.getFullRoomsStatus();
        const freeRooms = rooms.filter(r => r.status === 'livre');
        const availableTypes = [...new Set(freeRooms.map(r => r.tipoquarto))];
        
        let avContext = '';
        if (availableTypes.length > 0) {
            avContext = `\n\n[DISPONIBILIDADE REAL AGORA]: Temos as seguintes categorias com quartos livres: ${availableTypes.join(', ')}.`;
        } else {
            avContext = `\n\n[DISPONIBILIDADE REAL AGORA]: No momento, todos os quartos estão ocupados ou em limpeza.`;
        }

        availabilityCache = {
            data: avContext,
            lastUpdate: now
        };
        
        return context + avContext;
    } catch (dbError) {
        return context + (availabilityCache.data || ''); 
    }
}

// ===== TOOLS =====
const tools = [
    {
        type: 'function',
        function: {
            name: 'verificar_tempo_permanencia',
            parameters: {
                type: 'object',
                properties: {
                    numero_quarto: { type: 'number' }
                },
                required: ['numero_quarto']
            }
        }
    }
];

const functionHandlers = {
    verificar_tempo_permanencia: async ({ numero_quarto }) => {
        try {
            const rooms = await db.getFullRoomsStatus();
            const room = rooms.find(r => r.numeroquarto == numero_quarto);

            if (!room) return { erro: `Não encontrei o quarto número ${numero_quarto} no sistema.` };

            const statusOcupado = ['ocupado-periodo', 'ocupado-pernoite'];
            if (!statusOcupado.includes(room.status)) {
                return {
                    mensagem: `O quarto ${numero_quarto} não consta como ocupado no momento.`,
                    alerta: "O cálculo de tempo só funciona para quartos ocupados."
                };
            }

            if (!room.horastatus) return { erro: "Não encontrei horários para este quarto." };

            const now = new Date();
            const nowUTC = new Date(now.getTime() + (now.getTimezoneOffset() * 60000));
            const nowInBr = new Date(nowUTC.getTime() - (3 * 3600000));
            
            const statusTime = new Date(room.horastatus);
            const diffMs = nowInBr - statusTime;
            const diffMin = Math.floor(diffMs / (1000 * 60));

            const hours = Math.floor(Math.abs(diffMin) / 60);
            const mins = Math.abs(diffMin) % 60;

            const formatTime = (date) => new Date(date).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });

            return {
                quarto: numero_quarto,
                tipo: room.tipoquarto,
                status_atual: room.status,
                tempo_decorrido: `${hours}h ${mins}min`,
                horario_entrada: formatTime(room.horastatus),
                horario_atual_sistema: formatTime(nowInBr)
            };
        } catch (error) {
            console.error('Erro na ferramenta de tempo:', error);
            return { erro: 'Erro ao calcular tempo.' };
        }
    }
};

// ===== IA PRINCIPAL =====
async function getMotelAIResponse(userText, history = []) {

    if (!history || history.length === 0 || userText.toLowerCase().trim() === 'menu') {
        return menuInicial();
    }

    const direta = respostaDireta(userText);
    if (direta) return direta;

    const opcao = interpretarMenu(userText);

    if (opcao === "periodo") return PRECO_PERIODO;
    if (opcao === "pernoite") return PRECO_PERNOITE;

    if (opcao === "reserva") {
        return "Perfeito! Me diga qual suíte deseja ✨";
    }

    const preco = detectarPreco(userText);

    if (preco.geral && !preco.periodo && !preco.pernoite) {
        return "Você prefere 2h30 ou pernoite (12h)? ✨";
    }

    if (preco.periodo) return PRECO_PERIODO;
    if (preco.pernoite) return PRECO_PERNOITE;

    const dynamicContext = await getDynamicContext(userText);

    const historyLimit = history.slice(-3);

    const messages = [
        {
            role: 'system',
            content: MOTEL_PROMPT + dynamicContext
        },
        ...historyLimit.map(m => ({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: m.content
        })),
        { role: 'user', content: userText }
    ];

    try {
        const response = await axios.post(`${GROQ_URL}/chat/completions`, {
            model: 'llama-3.1-8b-instant',
            messages,
            tools,
            tool_choice: 'auto',
            temperature: 0.7
        }, {
            headers: { Authorization: `Bearer ${GROQ_KEY}` }
        });

        const msg = response.data.choices[0].message;

        // Correção de Parser para Modelo Llama no Groq
        if (!msg.tool_calls && msg.content && msg.content.includes('<function=')) {
            const regex = /<function=([^>]+)>([\s\S]*?)<\/function>/g;
            let match;
            msg.tool_calls = [];
            let newContent = msg.content;
            
            while ((match = regex.exec(msg.content)) !== null) {
                msg.tool_calls.push({
                    id: 'call_' + Math.random().toString(36).substr(2, 9),
                    type: 'function',
                    function: { name: match[1], arguments: match[2] }
                });
                newContent = newContent.replace(match[0], '');
            }
            msg.content = newContent.trim() || null;
        }

        if (msg.tool_calls && msg.tool_calls.length > 0) {
            // Garante que a mensagem salva no histórico tenha um content válido (mesmo vazio) para a próxima requisição não falhar
            const assistantMsg = { ...msg };
            if (!assistantMsg.content) assistantMsg.content = "";
            messages.push(assistantMsg);

            for (const call of msg.tool_calls) {
                const fn = call.function.name;
                const argsStr = call.function.arguments;
                // Tratamento caso os argumentos não sejam um JSON perfeito
                let args = {};
                try { args = JSON.parse(argsStr); } catch(e) { console.error('Erro parser args:', argsStr); }
                
                const result = await functionHandlers[fn] ? await functionHandlers[fn](args) : { erro: "Ferramenta não encontrada" };

                messages.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    name: fn,
                    content: JSON.stringify(result)
                });
            }

            const second = await axios.post(`${GROQ_URL}/chat/completions`, {
                model: 'llama-3.1-8b-instant',
                messages,
                tools
            }, {
                headers: { Authorization: `Bearer ${GROQ_KEY}` }
            });

            // Retorna limpando qualquer resíduo de function que possa ter vazado na segunda resposta
            let finalContent = second.data.choices[0].message.content || "";
            return finalContent.replace(/<function=[^>]+>[\s\S]*?<\/function>/g, '').trim();
        }

        let mainContent = msg.content || "";
        return mainContent.replace(/<function=[^>]+>[\s\S]*?<\/function>/g, '').trim();

    } catch (err) {
        console.error('[GROQ API ERROR]:', err.response ? err.response.data : err.message);
        return await getGeminiResponse(userText, history);
    }
}

// ===== TRANSCRIÇÃO DE ÁUDIO =====
async function transcribeAudio(audioBuffer, filename = 'audio.ogg') {
    try {
        const formData = new FormData();
        formData.append('file', audioBuffer, filename);
        formData.append('model', 'whisper-large-v3');

        const response = await axios.post(`${GROQ_URL}/audio/transcriptions`, formData, {
            headers: {
                ...formData.getHeaders(),
                'Authorization': `Bearer ${GROQ_KEY}`
            },
            timeout: 30000 
        });

        return response.data.text;
    } catch (error) {
        console.error('Erro na transcrição Groq:', error.response ? error.response.data : error.message);
        return null;
    }
}

// ===== FALLBACK =====
async function getGeminiResponse(userText, history = []) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
        const dynamicContext = await getDynamicContext(userText);

        const chat = model.startChat({
            history: [
                { role: 'user', parts: [{ text: MOTEL_PROMPT + dynamicContext }] },
                ...history.slice(-3).map(m => ({
                    role: m.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: m.content }]
                }))
            ]
        });

        const result = await chat.sendMessage(userText);
        return result.response.text();
    } catch (error) {
        console.error("Gemini Fallback Error:", error.message);
        return "Desculpe, estou passando por uma instabilidade técnica no sistema. Um atendente já vai te ajudar! 🌸";
    }
}

module.exports = { getMotelAIResponse, transcribeAudio, getDynamicContext };
