const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const FormData = require('form-data');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('./db_service');
const { withCircuitBreaker, withTimeout } = require('./protection');

// ===== PROMPTS =====
const MOTEL_PROMPT = fs.readFileSync(path.join(__dirname, '..', 'prompt_ia.txt'), 'utf8');
const PRECO_PERIODO = fs.readFileSync(path.join(__dirname, '..', 'preco_periodo.txt'), 'utf8');
const PRECO_PERNOITE = fs.readFileSync(path.join(__dirname, '..', 'preco_pernoite.txt'), 'utf8');
const PRECO_HORA_EXTRA = fs.readFileSync(path.join(__dirname, '..', 'preco_hora_extra.txt'), 'utf8');
const PRICE_CONTEXT = `
[DADOS DE PREÇOS E CATEGORIAS]:
Abaixo estão os valores oficiais do motel. Use-os com precisão:

${PRECO_PERIODO}

${PRECO_PERNOITE}
 
${PRECO_HORA_EXTRA}

 INSTRUÇÃO PARA PREÇOS:
1. Trabalhe com duas categorias de tempo: **Período (1h ou 2h)** e **Pernoite (12h)**. 
2. Sempre que informar o valor de 1h, informe JUNTOS o de 2h, destacando que por "apenas alguns reais a mais" (cite a diferença exata, ex: R$ 5) o cliente ganha o dobro de tempo.
3. SEMPRE identifique o nome da suíte ao passar um valor.
4. HIERARQUIA DE CATEGORIAS (da menor para maior): Apartamento < Suíte Master < Suíte Intensy < Suíte dos Deuses.
5. Se a categoria pedida estiver indisponível, aplique a regra de "Upgrade com R$ 10 de desconto" **APENAS se a categoria oferecida for SUPERIOR** à solicitada. Se for inferior, mantenha o preço normal.
`;

const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = 'https://api.groq.com/openai/v1';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ===== CACHE DISPONIBILIDADE =====
let availabilityCache = { data: '', lastUpdate: 0 };
const CACHE_TTL = 60000;

// ===== MENU =====
function menuInicial() {
    return `Posso te ajudar com algumas opções ✨

1️⃣ Valores para Períodos (1h e 2h)
2️⃣ Valores para Pernoite (12h)
3️⃣ Tirar uma dúvida
4️⃣ Fazer uma reserva

Se preferir, pode me dizer direto o que precisa 💖`;
}

// ===== INTERPRETAR MENU =====
function interpretarMenu(msg) {
    const t = msg.toLowerCase().trim();
    
    // Evita acionar o menu se o usuário enviou uma frase longa
    if (msg.length > 25) return null;

    if (t === "1" || t.includes("periodo") || t.includes("1h") || t.includes("2h")) return "periodo";
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
        return "Hora extra: Apartamento +R$20/h | Master +R$30/h | Intensy +R$35/h | Deuses +R$40/h ✨";
    }

    if (t.includes("3 pessoas") || t.includes("mais pessoas")) {
        return "Após a 2ª pessoa, é cobrado R$ 30 por pessoa adicional 💖";
    }

    if (t.includes("pagar só o tempo") || t.includes("pagar so o tempo") || t.includes("pagar proporcional") || (t.includes("pagar") && (t.includes("minutos") || t.includes("meia hora")))) {
        return "O valor cobrado é sempre o do período fechado contratado (1h, 2h ou 12h), mesmo que você decida sair antes. Não trabalhamos com valores proporcionais. ✨";
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
        periodo: /(1h|2h|periodo)/.test(t),
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

    // ─── CAMADA 2: CIRCUIT BREAKER para o banco de dados ────────────────
    return await withCircuitBreaker(
        'mysql',
        async () => {
            const rooms = await withTimeout(db.getFullRoomsStatus(), 8000, 'MySQL getFullRoomsStatus');
            const freeRooms = rooms.filter(r => r.status === 'livre');
            
            // Normalização de nomes para a IA
            const mapType = (t) => {
                const lower = t.toLowerCase();
                if (lower.includes('apartamento') || lower.includes('padrão')) return 'Apartamento';
                if (lower.includes('master')) return 'Suíte Master';
                if (lower.includes('intensy')) return 'Suíte Intensy';
                if (lower.includes('deuses') || lower.includes('deus')) return 'Suíte dos Deuses';
                return t;
            };

            const availableTypes = [...new Set(freeRooms.map(r => mapType(r.tipoquarto)))];
            
            // Mapeamento de descrições/itens por categoria
            const typeDescriptions = rooms.reduce((acc, r) => {
                const mappedType = mapType(r.tipoquarto);
                if (!acc[mappedType] && r.itens) acc[mappedType] = r.itens;
                return acc;
            }, {});

            let avContext = `\n\n[O QUE TEM EM CADA CATEGORIA]:\n`;
            Object.entries(typeDescriptions).forEach(([type, items]) => {
                avContext += `- ${type}: ${items}\n`;
            });

            if (availableTypes.length > 0) {
                avContext += `\n[DISPONIBILIDADE REAL AGORA]: Temos as seguintes categorias com quartos LIVRES no momento: ${availableTypes.join(', ')}.`;
                avContext += `\nIMPORTANTE: Se o cliente perguntar por uma categoria que NÃO está nesta lista, informe que ela está esgotada no momento.`;
            } else {
                avContext += `\n[DISPONIBILIDADE REAL AGORA]: No momento, todos os quartos estão ocupados ou em limpeza.`;
            }

            availabilityCache = { data: avContext, lastUpdate: now };
            return context + avContext;
        },
        // fallback: usa o cache anterior ou sem disponibilidade
        async () => context + (availabilityCache.data || '')
    );
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
                    numero_quarto: { 
                        type: 'string', 
                        description: 'Número do quarto onde o cliente JÁ ESTÁ HOSPEDADO. Use esta função APENAS se o cliente disser que já está no motel ou perguntar quanto tempo ainda tem. NUNCA use para reservas ou consultas de preços.' 
                    }
                },
                required: ['numero_quarto']
            }
        }
    }
];

const functionHandlers = {
    verificar_tempo_permanencia: async ({ numero_quarto }) => {
        try {
            if (!numero_quarto || String(numero_quarto).length > 5) {
                return { erro: "Número de quarto inválido. Informe apenas o número (ex: 10, 101)." };
            }

            const rooms = await db.getFullRoomsStatus();
            const room = rooms.find(r => String(r.numeroquarto) === String(numero_quarto));

            if (!room) return { erro: `Não encontrei o quarto número ${numero_quarto} no sistema. Verifique se o número está correto.` };

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

            const limiteHoras = room.status === 'ocupado-pernoite' ? 12 : 1; // Base de 1h como segurança
            const tempoTotalRestanteMins = (limiteHoras * 60) - diffMin;
            const excedeuLimite = tempoTotalRestanteMins < 0;
            
            let taxaHoraExtra = 'R$ 20,00';
            const tipo = room.tipoquarto.toLowerCase();
            const precosExtraText = fs.readFileSync(path.join(__dirname, '..', 'preco_hora_extra.txt'), 'utf8');
            
            if (tipo.includes('master')) {
                const match = precosExtraText.match(/Master: R\$ (\d+)/);
                taxaHoraExtra = match ? `R$ ${match[1]},00` : 'R$ 30,00';
            } else if (tipo.includes('intensy')) {
                const match = precosExtraText.match(/Intensy: R\$ (\d+)/);
                taxaHoraExtra = match ? `R$ ${match[1]},00` : 'R$ 35,00';
            } else if (tipo.includes('deus')) {
                const match = precosExtraText.match(/Deuses: R\$ (\d+)/);
                taxaHoraExtra = match ? `R$ ${match[1]},00` : 'R$ 40,00';
            } else {
                const match = precosExtraText.match(/Apartamento: R\$ (\d+)/);
                taxaHoraExtra = match ? `R$ ${match[1]},00` : 'R$ 20,00';
            }

            let msgExtra = "";
            if (excedeuLimite) {
                const tempoExcedido = Math.abs(tempoTotalRestanteMins);
                const he = Math.floor(tempoExcedido / 60);
                const me = Math.floor(tempoExcedido % 60);
                msgExtra = `INSTRUÇÃO DE RESPOSTA OBRIGATÓRIA: Informe que o tempo contratado (${limiteHoras}h) JÁ PASSOU e eles já excederam o limite em ${he}h e ${me}min (fração de hora conta como hora cheia). Diga também que a taxa da hora adicional para esse quarto é ${taxaHoraExtra}. Pergunte educadamente se desejam fechar a conta ou se pretendem continuar no quarto. Transforme isso num texto amigável, não seja robótico.`;
            } else {
                const hr = Math.floor(tempoTotalRestanteMins / 60);
                const mr = Math.floor(tempoTotalRestanteMins % 60);
                msgExtra = `INSTRUÇÃO DE RESPOSTA OBRIGATÓRIA: Diga que já se passou ${hours}h e ${mins}min desde a entrada. Se o período for o de 1h, faltam ${hr}h e ${mr}min (ajuste se for 2h ou 12h). Avise gentilmente que caso fiquem além do período contratado, será cobrada hora extra de ${taxaHoraExtra}/hora. Transforme isso num texto amigável e natural.`;
            }

            const pernoiteVencimento = new Date(statusTime.getTime() + (12 * 3600000));

            // Preços oficiais para ajudar a IA a não alucinar
            let precosOficiais = { "1h": "R$ 65", "2h": "R$ 70", "Pernoite": "R$ 130" };
            if (tipo.includes('master')) precosOficiais = { "1h": "R$ 95", "2h": "R$ 105", "Pernoite": "R$ 190" };
            else if (tipo.includes('intensy')) precosOficiais = { "1h": "R$ 105", "2h": "R$ 120", "Pernoite": "R$ 210" };
            else if (tipo.includes('deus')) precosOficiais = { "1h": "R$ 120", "2h": "R$ 140", "Pernoite": "R$ 250" };

            return {
                quarto: numero_quarto,
                tipo: room.tipoquarto,
                categoria_mapeada: tipo.includes('master') ? 'Suíte Master' : (tipo.includes('intensy') ? 'Suíte Intensy' : (tipo.includes('deus') ? 'Suíte dos Deuses' : 'Apartamento')),
                precos_oficiais_desta_categoria: precosOficiais,
                tempo_decorrido: `${hours}h ${mins}min`,
                horario_entrada: formatTime(room.horastatus),
                horario_vencimento_pernoite: formatTime(pernoiteVencimento),
                instrucao_para_a_IA_como_responder: msgExtra
            };
        } catch (error) {
            console.error('Erro na ferramenta de tempo:', error);
            return { erro: 'Erro ao calcular tempo.' };
        }
    }
};

// ===== FALLBACK =====
async function getGeminiResponse(userText, history = []) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
        const dynamicContext = await getDynamicContext(userText);

        const chat = model.startChat({
            history: [
                { role: 'user', parts: [{ text: MOTEL_PROMPT + dynamicContext }] },
                ...history.slice(-10).map(m => ({
                    role: m.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: m.content }]
                }))
            ]
        });

        const result = await Promise.race([
            chat.sendMessage(userText),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Gemini API Timeout')), 15000))
        ]);
        let text = result.response.text() || "";
        
        // Se o Gemini tentar usar o pseudo-formato de função, extraímos e limpamos
        if (text.includes('<function=')) {
            const regex = /<function=([^>]+)>([\s\S]*?)<\/function>/g;
            let match;
            let capturedCalls = [];
            while ((match = regex.exec(text)) !== null) {
                capturedCalls.push({ name: match[1], args: match[2] });
            }
            
            // Limpa do texto original
            text = text.replace(regex, '').trim();
            
            // Se encontrou chamadas, vamos executá-las e repassar pro Gemini
            if (capturedCalls.length > 0) {
                let toolResponses = "";
                for (const call of capturedCalls) {
                    let args = {};
                    try { args = JSON.parse(call.args); } catch(e) {}
                    const result = await functionHandlers[call.name] ? await functionHandlers[call.name](args) : { erro: "Ferramenta não encontrada" };
                    toolResponses += `\n[Resultado da função ${call.name}]: ${JSON.stringify(result)}\n`;
                }
                
                const secondResult = await Promise.race([
                    chat.sendMessage(`Você executou funções internamente. Aqui estão os resultados. Use-os para responder ao cliente de forma natural, sem exibir tags: ${toolResponses}`),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Gemini API Timeout 2')), 15000))
                ]);
                text = secondResult.response.text() || "";
            }
        }
        
        return text.replace(/<function=[^>]+>[\s\S]*?<\/function>/g, '').trim();
    } catch (error) {
        console.error("Gemini Fallback Error:", error.message);
        return "Desculpe, estou passando por uma instabilidade técnica no sistema. Um atendente já vai te ajudar! 🌸";
    }
}

// Wrapper final para garantir que em hipótese alguma o texto vaze
async function safeGetMotelAIResponse(userText, history) {
    let result = await getMotelAIResponseInternal(userText, history);
    if (typeof result === 'string') {
        result = result.replace(/<function=[^>]+>[\s\S]*?<\/function>/g, '').trim();
    }
    return result;
}

// Renomeia a função principal original
async function getMotelAIResponseInternal(userText, history = []) {
    if (!history || history.length === 0 || userText.toLowerCase().trim() === 'menu') {
        return menuInicial();
    }

    const direta = respostaDireta(userText);
    if (direta) return direta;

    if (history.length <= 2) {
        const opcao = interpretarMenu(userText);

        if (opcao === "reserva") {
            return "Perfeito! Me diga qual suíte deseja ✨";
        }
    }

    const dynamicContext = await getDynamicContext(userText);

    const historyLimit = history.slice(-10);

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

    // ─── CAMADA 2: CIRCUIT BREAKER para o Groq ─────────────────────────────
    return await withCircuitBreaker(
        'groq',
        async () => {
            const response = await withTimeout(
                axios.post(`${GROQ_URL}/chat/completions`, {
                    model: 'llama-3.1-8b-instant',
                    messages,
                    tools,
                    tool_choice: 'auto',
                    temperature: 0.2
                }, {
                    headers: { Authorization: `Bearer ${GROQ_KEY}` },
                    timeout: 15000
                }),
                18000,
                'Groq chat/completions'
            );

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
                const assistantMsg = { ...msg };
                if (!assistantMsg.content) assistantMsg.content = "";
                messages.push(assistantMsg);

                for (const call of msg.tool_calls) {
                    const fn = call.function.name;
                    const argsStr = call.function.arguments;
                    let args = {};
                    try { args = JSON.parse(argsStr); } catch(e) { }

                    const result = await functionHandlers[fn] ? await functionHandlers[fn](args) : { erro: "Ferramenta não encontrada" };

                    messages.push({
                        role: 'tool',
                        tool_call_id: call.id,
                        name: fn,
                        content: JSON.stringify(result)
                    });
                }

                const second = await withTimeout(
                    axios.post(`${GROQ_URL}/chat/completions`, {
                        model: 'llama-3.1-8b-instant',
                        messages,
                        tools,
                        temperature: 0.2
                    }, {
                        headers: { Authorization: `Bearer ${GROQ_KEY}` },
                        timeout: 15000
                    }),
                    18000,
                    'Groq tool-call second pass'
                );

                return second.data.choices[0].message.content || "";
            }

            return msg.content || "";
        },
        // fallback: Gemini quando Groq estiver com o circuito aberto
        async () => {
            console.warn('[CB] Groq indisponível. Usando Gemini como fallback.');
            return await getGeminiResponse(userText, history);
        }
    );
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

module.exports = { getMotelAIResponse: safeGetMotelAIResponse, transcribeAudio, getDynamicContext };
