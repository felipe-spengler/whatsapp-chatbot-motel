const { getMotelAIResponse } = require('./ai_service');

const sessions = {};
const NOTIFICATION_NUMBER = (process.env.NOTIFICATION_NUMBER || '5549999459490').replace(/\D/g, '');
const startTime = Math.floor(Date.now() / 1000); // Timestamp em segundos

/**
 * Handle incoming messages for Motel Intensy
 */
async function handleMessage(client, message) {
    if (!message.from || message.isGroupMsg) return;

    // Ignorar mensagens antigas (antes do bot iniciar)
    if (message.timestamp < startTime) return;

    // Ignorar mensagens do número de notificação para evitar loops
    if (message.from.includes(NOTIFICATION_NUMBER)) return;

    const from = message.from;
    const text = message.body ? message.body.trim() : '';

    if (!sessions[from]) {
        sessions[from] = { 
            history: [],
            messageCount: 0,
            lastUserText: '',
            repeatCount: 0
        };
    }

    const session = sessions[from];

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

        // Lógica de monitoramento de reserva (Baseado no prompt do usuário)
        // O fluxo tem 4 perguntas. Vamos detectar se a IA enviou a mensagem final.
        if (aiResponse.includes("Vou te transferir agora para um de nossos atendentes")) {
            console.log(`Reserva detectada para ${from}! Notificando...`);
            
            // Notificar o número configurado
            const notificationMsg = `🔔 *NOVA RESERVA INICIADA!*\n\nCliente: ${from.split('@')[0]}\n\nO robô já coletou as informações básicas. Por favor, assuma o atendimento para finalizar o pagamento.`;
            
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

module.exports = { handleMessage };
