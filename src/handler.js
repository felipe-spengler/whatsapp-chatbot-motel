const { getMotelAIResponse, transcribeAudio } = require('./ai_service');

const sessions = {};
const NOTIFICATION_NUMBER = (process.env.NOTIFICATION_NUMBER).replace(/\D/g, '');
const startTime = Math.floor(Date.now() / 1000);

// Limpeza de sessões inativas a cada 15 minutos
setInterval(() => {
    const twelveHours = 4 * 60 * 60 * 1000;
    const now = Date.now();
    for (const from in sessions) {
        if (!sessions[from].isProcessing && now - (sessions[from].lastBotSentTime || sessions[from].lastActivity || sessions[from].lastHumanInteraction || now) > twelveHours) {
            console.log(`Limpando sessão inativa: ${from}`);
            delete sessions[from];
        }
    }
}, 15 * 60 * 1000);

async function handleMessage(client, message) {
    console.log(`[DEBUG] Mensagem recebida de ${message.from}: "${message.body}" (fromMe: ${message.fromMe})`);

    // 1. Filtros Básicos
    if (!message.from || message.isGroupMsg || message.from.includes('broadcast')) {
        console.log(`[DEBUG] Ignorada: Grupo, broadcast ou sem remetente.`);
        return;
    }

    if (message.timestamp < startTime) {
        console.log(`[DEBUG] Ignorada: Mensagem antiga (${message.timestamp} < ${startTime}).`);
        return;
    }

    const from = message.from;

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

    // 3. Trava de Intervenção Humana (5 minutos)
    const fiveMinutes = 5 * 60 * 1000;
    if (Date.now() - session.lastHumanInteraction < fiveMinutes) {
        console.log(`[DEBUG] AI Silenciada por intervenção humana em ${from}.`);

        // Notifica o admin apenas 1x por janela de intervenção (evita spam)
        if (NOTIFICATION_NUMBER && (Date.now() - (session.humanNotifiedAt || 0)) > fiveMinutes) {
            session.humanNotifiedAt = Date.now();
            const notifyName = (message.sender && (message.sender.pushname || message.sender.name)) || message.notifyName || '';
            const rawNumber = from.replace('@c.us', '');
            const displayNumber = `+${rawNumber}`;
            const nameStr = notifyName ? `*${notifyName}* (${displayNumber})` : displayNumber;
            try {
                await client.sendText(
                    `${NOTIFICATION_NUMBER}@c.us`,
                    `🔕 *BOT SILENCIADO:* O cliente ${nameStr} enviou uma mensagem mas o bot está pausado por intervenção humana. Responda manualmente ou aguarde 5 min para o bot retomar.`
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
    let text = message.body ? message.body.trim() : '';

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

    // Inicia um timer de 4 segundos para aguardar mais mensagens
    session.bufferTimeout = setTimeout(async () => {
        // Re-verifica intervenção humana: pode ter ocorrido durante os 4.5s de espera
        if (Date.now() - session.lastHumanInteraction < 5 * 60 * 1000) {
            console.log(`[DEBUG] Buffer cancelado: intervenção humana ocorreu durante a espera em ${from}.`);
            session.messageBuffer = [];
            return;
        }

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

            // --- RESPOSTAS RÁPIDAS (GREETINGS) ---
            const greetings = ['oi', 'olá', 'ola', 'bom dia', 'boa tarde', 'boa noite', 'oie', 'tudo bem', 'tudo joia', 'opa'];
            // Permite saudações no messageBuffer se só enviou isso ou frase pequena repetitiva
            const isOnlyGreeting = greetings.includes(combinedText.toLowerCase().trim()) || (combinedText.length <= 8 && greetings.some(g => combinedText.toLowerCase().includes(g)));

            if (isOnlyGreeting && session.messageCount === 1) {
                const hour = new Date().getHours() - 3; // Brasil
                let greet = (hour >= 5 && hour < 12) ? "Bom dia!" : (hour >= 12 && hour < 18) ? "Boa tarde!" : "Boa noite!";
                const staticResponse = `${greet} ✨ Bem-vindo ao *Motel Intensy*. Como posso ajudar você hoje? 💖`;

                await client.startTyping(from);
                await new Promise(r => setTimeout(r, 1500));
                await client.sendText(from, staticResponse);

                session.lastBotSentTime = Date.now();
                session.lastSender = 'bot';
                session.history.push({ role: 'user', content: combinedText }, { role: 'assistant', content: staticResponse });
                session.isProcessing = false;
                return;
            }

            // --- PROCESSAMENTO IA ---
            const aiResponse = await getMotelAIResponse(combinedText, session.history);

            // Atualiza Histórico
            session.history.push({ role: 'user', content: combinedText }, { role: 'assistant', content: aiResponse });
            while (session.history.length > 20) session.history.shift();

            // Verificação de Transferência
            const textLower = combinedText.toLowerCase();
            const transferKeywords = [
                'atendente', 'humano', 'falar com alguém', 'pessoa', 'atendimento', 'gerente',
                'falar com alguem', 'ajuda'
            ];
            const actionKeywords = [
                'abrir portão', 'abrir portao', 'abre o portao', 'abre o portão',
                'quero sair', 'liberar saída', 'liberar saida', 'checkout agora',
                'pedir saída', 'pedir saida'
            ];

            const userAskedForHuman = transferKeywords.some(kw => textLower.includes(kw));
            const userRequestedAction = actionKeywords.some(kw => textLower.includes(kw));

            if (userAskedForHuman || userRequestedAction || aiResponse.includes("Vou te transferir") || aiResponse.includes("atendente foi notificado")) {
                try {
                    const notifyName = (message.sender && (message.sender.pushname || message.sender.name)) || message.notifyName || '';
                    const realNumber = (message.sender && message.sender.formattedName) ? message.sender.formattedName : from.split('@')[0];
                    const nameStr = notifyName ? `*${notifyName}* ` : '';
                    await client.sendText(`${NOTIFICATION_NUMBER}@c.us`, `🔔 *TRANSFERÊNCIA:* Cliente ${nameStr}(${realNumber}) solicitou ajuda.`);
                    console.log(`[NOTIFICAÇÃO] Aviso de transferência enviado para o Admin.`);
                } catch (notifErr) {
                    console.error('[ERRO NOTIFICAÇÃO] Falha ao enviar aviso para o Admin. Verifique o número no .env:', notifErr.message);
                }
            }

            // Simulação Humana e Envio
            const readingDelay = 2000 + (Math.random() * 2000); // 2 a 4 segundos
            await new Promise(r => setTimeout(r, readingDelay));

            await client.startTyping(from);

            const typingDelay = Math.min(Math.max(aiResponse.length * 15, 2000), 5000);
            const randomFuzzy = Math.random() * 1500;

            await new Promise(r => setTimeout(r, typingDelay + randomFuzzy));

            await client.sendText(from, aiResponse);

            session.lastBotSentTime = Date.now();
            session.lastSender = 'bot';
            await client.stopTyping(from);

        } catch (error) {
            console.error('Erro no Handler Timer:', error);
            await client.sendText(from, "Desculpe, tive um probleminha técnico. Um atendente já vai te ajudar! 🌸");
        } finally {
            session.isProcessing = false;
        }
    }, 4500);
}

async function handleAnyMessage(client, message) {
    if (!message.fromMe) return;

    // 1. Ignorar mensagens antigas (sync inicial) e protocolos
    const now = Math.floor(Date.now() / 1000);
    if (now - message.timestamp > 15) return;
    if (message.type === 'protocol' || message.from.includes('broadcast')) return;

    const to = message.to;
    if (!sessions[to]) return;

    // 2. Se o bot está no meio de um processamento, o 'fromMe' é dele mesmo
    if (sessions[to].isProcessing) {
        sessions[to].lastBotSentTime = Date.now();
        return;
    }

    // 3. A Lógica de Ouro: Só é humano se VOCÊ mandou msg e o último foi o CLIENTE
    // E se não foi uma mensagem enviada pelo bot nos últimos 3.5 segundos
    const isBotRecently = (Date.now() - (sessions[to].lastBotSentTime || 0)) < 3500;

    if (sessions[to].lastSender === 'customer' && !isBotRecently) {
        if (message.body && message.body.length > 0) {
            sessions[to].lastHumanInteraction = Date.now();
            sessions[to].lastSender = 'human';
            console.log(`[REAL] Intervenção detectada para ${to}. Bot pausado.`);
        }
    }
}

module.exports = { handleMessage, handleAnyMessage };