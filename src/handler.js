const { getMotelAIResponse } = require('./ai_service');

const sessions = {};
const NOTIFICATION_NUMBER = (process.env.NOTIFICATION_NUMBER || '554999459490').replace(/\D/g, '');
const startTime = Math.floor(Date.now() / 1000);

async function handleMessage(client, message) {
    if (!message.from || message.isGroupMsg || message.from.includes('broadcast')) return;

    if (message.timestamp < startTime) return;

    // Ignorar mensagens do número de notificação (gerência) para evitar que a IA responda ao dono
    if (message.from.includes(NOTIFICATION_NUMBER)) return;

    const from = message.from;
    const text = message.body ? message.body.trim() : '';

    if (!sessions[from]) {
        sessions[from] = { 
            history: [],
            messageCount: 0,
            lastUserText: '',
            repeatCount: 0,
            lastHumanInteraction: 0
        };
    }

    const session = sessions[from];

    // Trava de Atendimento Humano: Se você enviou msg nos últimos 5 minutos, o bot silencia
    const fiveMinutes = 5 * 60 * 1000;
    if (Date.now() - session.lastHumanInteraction < fiveMinutes) {
        console.log(`Atendimento humano detectado para ${from}. AI silenciada.`);
        return;
    }

    // Detectar loop de IA (mesma mensagem repetida ou muitas mensagens seguidas)
    if (text === session.lastUserText) {
        session.repeatCount++;
    } else {
        session.repeatCount = 0;
        session.lastUserText = text;
    }

    if (session.repeatCount >= 2 || session.messageCount >= 15) {
        console.log(`Possível loop de IA detectado para ${from}. Interrompendo respostas automáticas.`);
        return;
    }

    session.messageCount++;

    try {
        // Obter resposta da IA
        const aiResponse = await getMotelAIResponse(text, session.history);

        // Salvar no histórico
        session.history.push({ role: 'user', content: text });
        session.history.push({ role: 'assistant', content: aiResponse });

        // Limitar histórico para não estourar contexto
        if (session.history.length > 20) session.history.shift();

        // Lógica de monitoramento de reserva e transferência humana
        const transferKeywords = ['atendente', 'humano', 'falar com alguém', 'pessoa', 'atendimento', 'gerente'];
        const userAskedForHuman = transferKeywords.some(kw => text.toLowerCase().includes(kw));
        const aiSuggestedTransfer = aiResponse.includes("Vou te transferir agora para um de nossos atendentes");

        if (userAskedForHuman || aiSuggestedTransfer) {
            console.log(`Transferência solicitada para ${from}! Notificando...`);
            
            // Notificar o número configurado
            const notificationMsg = `🔔 *TRANSFERÊNCIA SOLICITADA!*\n\nCliente: ${from.split('@')[0]}\n\nO cliente pediu por um atendente ou finalizou o fluxo de reserva. Por favor, assuma o atendimento!`;
            
            await client.sendText(`${NOTIFICATION_NUMBER}@c.us`, notificationMsg);
        }

        // Iniciar indicador de "digitando"
        await client.startTyping(from);
        
        // Simular tempo de resposta humano (2 segundos)
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Resposta para o cliente
        await client.sendText(from, aiResponse);

    } catch (error) {
        console.error('Handler error (Motel):', error);
        await client.sendText(from, "Desculpe, tive um erro ao processar sua mensagem. 💖");
    }
}

async function handleAnyMessage(client, message) {
    if (message.fromMe && message.type === 'chat' && !message.to.includes('broadcast')) {
        const to = message.to;
        if (!sessions[to]) {
            sessions[to] = { history: [], messageCount: 0, lastUserText: '', repeatCount: 0, lastHumanInteraction: 0 };
        }
        sessions[to].lastHumanInteraction = Date.now();
        console.log(`Intervenção humana detectada para ${to}. Travando AI por 5min.`);
    }
}

module.exports = { handleMessage, handleAnyMessage };
