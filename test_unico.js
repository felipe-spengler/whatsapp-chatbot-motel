require('dotenv').config();
const { getMotelAIResponse } = require('./src/ai_service');

async function testSingle() {
    let history = [
        { role: 'user', content: "Quero reservar uma Intensy para hoje às 23:00" },
        { role: 'assistant', content: "Com certeza! Por quanto tempo deseja ficar? Temos 1h, 2h ou Pernoite (12h)." },
        { role: 'user', content: "Pernoite" },
        { role: 'assistant', content: "Perfeito, pernoite na Suíte Intensy custa R$ 210. Deseja confirmar?" }
    ];
    const msg = "6 horas";
    console.log(`\n➡ Usuário: "${msg}"`);
    try {
        const response = await getMotelAIResponse(msg, history);
        console.log(`🤖 IA: ${response}`);
    } catch (err) {
        console.error("Erro:", err.message);
    }
    process.exit(0);
}

testSingle();
