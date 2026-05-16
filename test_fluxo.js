require('dotenv').config();
const { getMotelAIResponse } = require('./src/ai_service');

async function testConversation() {
    let history = [];
    const messages = [
        "Disponível pra agora?",
        "Quero reservar",
        "Intensy",
        "Hoje às 23:00",
        "Pernoite",
        "6 horas",
        "6 horas",
        "Duas pessoas"
    ];

    console.log("=== SIMULANDO CONVERSA DE RESERVA ===");

    for (const msg of messages) {
        console.log(`\n➡ Usuário: "${msg}"`);
        try {
            const response = await getMotelAIResponse(msg, history);
            console.log(`🤖 IA: ${response}`);
            history.push({ role: 'user', content: msg });
            history.push({ role: 'assistant', content: response });
        } catch (err) {
            console.error(`❌ Erro no passo "${msg}":`, err.message);
        }
        // Simular um delay maior para evitar rate limit
        await new Promise(r => setTimeout(r, 3000));
    }

    console.log("\n=== FIM DA SIMULAÇÃO ===");
    process.exit(0);
}

testConversation();
