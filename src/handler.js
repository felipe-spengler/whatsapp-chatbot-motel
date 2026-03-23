const { getMotelAIResponse } = require('./ai_service');

const sessions = {};
const NOTIFICATION_NUMBER = process.env.NOTIFICATION_NUMBER || '5549999459490';

/**
 * Handle incoming messages for Motel Intensy
 */
async function handleMessage(client, message) {
    if (!message.from || message.isGroupMsg) return;

    const from = message.from;
    const text = message.body ? message.body.trim() : '';

    if (!sessions[from]) {
        sessions[from] = { 
            history: [],
            reservationStep: 0,
            reservationData: {}
        };
    }

    const session = sessions[from];

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

        // Resposta para o cliente
        await client.sendText(from, aiResponse);

    } catch (error) {
        console.error('Handler error (Motel):', error);
        await client.sendText(from, "Desculpe, tive um erro ao processar sua mensagem. 💖");
    }
}

module.exports = { handleMessage };
