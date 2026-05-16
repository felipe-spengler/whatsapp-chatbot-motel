const { getMotelAIResponse, transcribeAudio } = require('./ai_service');
const { isRateLimited, enqueueJob } = require('./protection');

const sessions = {};
const NOTIFICATION_NUMBER = (process.env.NOTIFICATION_NUMBER).replace(/\D/g, '');
const startTime = Math.floor(Date.now() / 1000);
const BOT_PREFIX = '*Assistente Virtual:*';

// Limpeza de sessões inativas — delegada ao watchdog de memória da Camada 1.
// O watchdog em protection.js roda a cada 5 min e respeita a flag isProcessing.


async function handleMessage(client, message) {
    // Filtros Básicos
    if (!message.from || message.isGroupMsg || message.from.includes('broadcast')) {
        return;
    }

    const textRaw = message.body ? message.body.trim() : '';

    // Ignora mensagens sem texto (exceto áudio, que tratamos depois)
    if (!textRaw && message.type !== 'audio' && message.type !== 'ptt') {
        return;
    }

    console.log(`[DEBUG] Mensagem recebida de ${message.from}: "${textRaw || '['+message.type+']'}" (fromMe: ${message.fromMe})`);

    if (message.timestamp < startTime) {
        console.log(`[DEBUG] Ignorada: Mensagem antiga (${message.timestamp} < ${startTime}).`);
        return;
    }

    const from = message.from;

    // ─── CAMADA 3: RATE LIMITER ────────────────────────────────────
    if (isRateLimited(from)) return;

    // 2. Inicialização da Sessão
    if (!sessions[from]) {
        sessions[from] = {
            history: [],
            messageCount: 0,
            lastUserText: '',
            repeatCount: 0,
            lastHumanInteraction: 0,
            lastBotSentTime: 0,
            lastActivity: Date.now(),
            isProcessing: false,
            messageBuffer: [],
            bufferTimeout: null,
            lastSender: 'none',
            humanNotifiedAt: 0 // controle para não spammar notificação
        };
    }

    const session = sessions[from];

    // 3. Trava de Intervenção Humana (2 minutos)
    const pauseTime = 2 * 60 * 1000;
    if (Date.now() - session.lastHumanInteraction < pauseTime) {
        console.log(`[DEBUG] AI Silenciada por intervenção humana em ${from}.`);

        // Notifica o admin apenas 1x por janela de intervenção (evita spam)
        if (NOTIFICATION_NUMBER && (Date.now() - (session.humanNotifiedAt || 0)) > pauseTime) {
            session.humanNotifiedAt = Date.now();
            const notifyName = (message.sender && (message.sender.pushname || message.sender.name)) || message.notifyName || '';
            const rawNumber = from.replace('@c.us', '');
            const displayNumber = `+${rawNumber}`;
            const nameStr = notifyName ? `*${notifyName}* (${displayNumber})` : displayNumber;
            try {
                await client.sendText(
                    `${NOTIFICATION_NUMBER}@c.us`,
                    `🔕 *BOT SILENCIADO:* O cliente ${nameStr} enviou uma mensagem mas o bot está pausado por intervenção humana. Responda manualmente ou aguarde 2 min para o bot retomar.`
                );
            } catch (e) {
                console.error('[NOTIFICAÇÃO] Erro ao avisar sobre bot silenciado:', e.message);
            }
        }

        return;
    }

    // 4. Trava de Fila: Se já estiver processando esse cliente, ignorar disparos duplicados
    if (session.isProcessing) return;

    // 5. Marcação de entrada
    session.lastSender = 'customer';
    session.lastActivity = Date.now();
    let text = textRaw;

    // --- CAMADA DE SPEECH-TO-TEXT (AUDIO) ---
    if (message.type === 'audio' || message.type === 'ptt') {
        try {
            console.log(`Recebido áudio de ${from}. Transcrevendo...`);
            let buffer = await client.decryptFile(message);
            const transcribedText = await transcribeAudio(buffer, `${message.id}.ogg`);
            buffer = null;
            if (transcribedText) {
                console.log(`Transcrição concluída: "${transcribedText}"`);
                text = transcribedText;
            }
        } catch (error) {
            console.error('Erro ao processar áudio:', error);
        }
    }

    if (!text) return;

    // Bufferiza a mensagem
    if (!session.messageBuffer) session.messageBuffer = [];
    session.messageBuffer.push(text);

    // Cancela o processamento anterior se o cliente enviar outra mensagem rapidamente
    if (session.bufferTimeout) {
        clearTimeout(session.bufferTimeout);
    }

    // Inicia um timer de 3 segundos para aguardar mais mensagens (buffer)
    session.bufferTimeout = setTimeout(async () => {
        // Re-verifica intervenção humana: pode ter ocorrido durante a espera
        if (Date.now() - session.lastHumanInteraction < 2 * 60 * 1000) {
            console.log(`[DEBUG] Buffer cancelado: intervenção humana ocorreu durante a espera em ${from}.`);
            session.messageBuffer = [];
            return;
        }

        // ─── CAMADA 3: FILA DE CPU ─────────────────────────────────────
        // Encapsula o processamento pesado na fila de concorrência controlada.
        await enqueueJob(async () => {

        session.isProcessing = true; // Bloqueia novos processamentos
        const combinedText = session.messageBuffer.join('\n');
        session.messageBuffer = []; // Limpa o buffer

        try {
            // --- ANTI-LOOP E REPETIÇÃO ---
            if (combinedText === session.lastUserText) {
                session.repeatCount++;
            } else {
                session.repeatCount = 0;
                session.lastUserText = combinedText;
            }

            if (session.repeatCount >= 3) {
                console.log(`Loop detectado para ${from}. Parando.`);
                session.isProcessing = false;
                return;
            }

            // Evita erro de mensagens contendo apenas base64 (geralmente fotos/midias lidas puramente como texto)
            if (combinedText.length > 1000 && !combinedText.includes(' ')) {
                console.log(`[DEBUG] Ignorada: Mensagem longa sem espaços (provável mídia base64).`);
                session.isProcessing = false;
                return;
            }

            session.messageCount++;

            // --- RESPOSTAS RÁPIDAS (SALUDAÇÃO INICIAL) ---
            const greetings = ['oi', 'olá', 'ola', 'bom dia', 'boa tarde', 'boa noite', 'oie', 'tudo bem', 'tudo joia', 'opa'];
            const isOnlyGreeting = greetings.includes(combinedText.toLowerCase().trim()) || (combinedText.length <= 8 && greetings.some(g => combinedText.toLowerCase().includes(g)));

            if (isOnlyGreeting && session.history.length === 0) {
                console.log(`[DEBUG] Resposta rápida (saudação) para ${from}.`);
                const hour = new Date().getHours() - 3; // Brasil
                let greet = (hour >= 5 && hour < 12) ? "Bom dia!" : (hour >= 12 && hour < 18) ? "Boa tarde!" : "Boa noite!";
                const staticResponse = `${greet} ✨ Bem-vindo ao *Motel Intensy*. Como posso ajudar você hoje? 💖`;

                await client.startTyping(from);
                await new Promise(r => setTimeout(r, 1500));
                
                const responseWithPrefix = `${BOT_PREFIX}\n\n${staticResponse}`;
                await client.sendText(from, responseWithPrefix);

                session.lastBotSentTime = Date.now();
                session.lastSender = 'bot';
                session.history.push({ role: 'user', content: combinedText }, { role: 'assistant', content: staticResponse });
                session.isProcessing = false;
                return;
            }

            // --- PROCESSAMENTO IA ---
            console.log(`[DEBUG] Gerando resposta IA para ${from}...`);
            const aiResponse = await getMotelAIResponse(combinedText, session.history);

            if (!aiResponse || aiResponse.trim().length === 0) {
                console.warn(`[DEBUG] IA retornou resposta vazia para ${from}.`);
                session.isProcessing = false;
                return;
            }

            // Atualiza Histórico
            session.history.push({ role: 'user', content: combinedText }, { role: 'assistant', content: aiResponse });
            while (session.history.length > 20) session.history.shift();

            // Verificação de Transferência e Resposta
            const textLower = combinedText.toLowerCase();
            const transferKeywords = [
                'atendente', 'humano', 'falar com alguém', 'pessoa', 'atendimento', 'gerente',
                'falar com alguem', 'ajuda', 'estorno', 'cancelamento', 'cancelar', 'reembolso'
            ];
            const actionKeywords = [
                'abrir portão', 'abrir portao', 'abre o portao', 'abre o portão',
                'quero sair', 'liberar saída', 'liberar saida', 'checkout agora',
                'pedir saída', 'pedir saida', 'interfone', 'portão', 'portao'
            ];

            const userAskedForHuman = transferKeywords.some(kw => textLower.includes(kw));
            const userRequestedAction = actionKeywords.some(kw => textLower.includes(kw));

            if (userAskedForHuman || userRequestedAction || aiResponse.includes("transferir") || aiResponse.includes("acionado") || aiResponse.includes("notificado")) {
                try {
                    session.lastHumanInteraction = Date.now();
                    const notifyName = (message.sender && (message.sender.pushname || message.sender.name)) || message.notifyName || '';
                    const realNumber = (message.sender && message.sender.formattedName) ? message.sender.formattedName : from.split('@')[0];
                    const nameStr = notifyName ? `*${notifyName}* ` : '';
                    await client.sendText(`${NOTIFICATION_NUMBER}@c.us`, `🔔 *TRANSFERÊNCIA ATIVA:* Cliente ${nameStr}(${realNumber}) solicitou ajuda ou estorno. Bot pausado por 2 min.`);
                    console.log(`[NOTIFICAÇÃO] Auto-pause e aviso de transferência enviado para o Admin.`);
                } catch (notifErr) {
                    console.error('[ERRO NOTIFICAÇÃO] Falha ao enviar aviso para o Admin.', notifErr.message);
                }
            }

            // Simulação Humana e Envio
            const readingDelay = 2000 + (Math.random() * 2000);
            await new Promise(r => setTimeout(r, readingDelay));

            await client.startTyping(from);

            const typingDelay = Math.min(Math.max(aiResponse.length * 15, 2000), 5000);
            const randomFuzzy = Math.random() * 1500;
            await new Promise(r => setTimeout(r, typingDelay + randomFuzzy));

            // Checagem de interrupção humana no último segundo
            if (Date.now() - session.lastHumanInteraction < 2 * 60 * 1000) {
                console.log(`[REAL] Envio CANCELADO no último segundo (humano interveio) em ${from}.`);
                await client.stopTyping(from);
                return;
            }

            const responseWithPrefix = `${BOT_PREFIX}\n\n${aiResponse}`;
            console.log(`[DEBUG] Enviando resposta para ${from}.`);
            await client.sendText(from, responseWithPrefix);

            session.lastBotSentTime = Date.now();
            session.lastSender = 'bot';
            await client.stopTyping(from);

        } catch (error) {
            console.error('Erro no Handler Timer:', error);
            await client.sendText(from, `${BOT_PREFIX}\n\nDesculpe, tive um probleminha técnico. Um atendente já vai te ajudar! 🌸`);
        } finally {
            session.isProcessing = false;
        }

        }); // fecha enqueueJob
    }, 3000);
}

async function handleAnyMessage(client, message) {
    if (!message.fromMe) return;

    // 1. Ignorar mensagens antigas e protocolos
    const now = Math.floor(Date.now() / 1000);
    if (now - message.timestamp > 15) return;
    if (message.type === 'protocol' || message.from.includes('broadcast')) return;

    const to = message.to;
    if (!sessions[to]) return;

    // 2. DETECÇÃO DE INTERVENÇÃO HUMANA INFALÍVEL
    // Se a mensagem que EU enviei NÃO começa com o prefixo do bot, então fui EU (humano).
    const isBotResponse = message.body && message.body.startsWith(BOT_PREFIX);

    if (!isBotResponse) {
        console.log(`[REAL] Intervenção detectada para ${to} (sem prefixo). Pausando bot.`);
        sessions[to].lastHumanInteraction = Date.now();
        sessions[to].lastSender = 'human';
        
        // Mantém a sincronia da IA com o que o humano conversou
        const humanText = message.body || "[Mídia/Arquivo]";
        sessions[to].history.push({ role: 'assistant', content: humanText });
        while (sessions[to].history.length > 20) sessions[to].history.shift();

        // CANCELA qualquer processamento em curso ou na fila de buffer
        if (sessions[to].bufferTimeout) {
            clearTimeout(sessions[to].bufferTimeout);
            sessions[to].bufferTimeout = null;
            sessions[to].messageBuffer = [];
            console.log(`[REAL] Buffer cancelado para ${to}.`);
        }
    } else {
        // Se foi o bot e o prefixo existe, removemos o prefixo para salvar no histórico limpo (opcional)
        // Por segurança, apenas atualizamos o tempo
        sessions[to].lastBotSentTime = Date.now();
    }
}

module.exports = { handleMessage, handleAnyMessage, sessions };