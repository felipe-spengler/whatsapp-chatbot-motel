require('dotenv').config();
const { getMotelAIResponse } = require('./src/ai_service');
const db = require('./src/db_service');

async function testSingle() {
    let history = [
        { role: 'user', content: "bom diaaaaa, tudo bem?" },
        { role: 'assistant', content: "Assistente Virtual:\n\nPosso te ajudar com algumas opções ✨\n\n1️⃣ Valores para Períodos (1h e 2h)\n2️⃣ Valores para Pernoite (12h)\n3️⃣ Tirar uma dúvida\n4️⃣ Fazer uma reserva\n\nSe preferir, pode me dizer direto o que precisa 💖" }
    ];
    const msg = "como está de papeis, copos, saco de lixo?";
    console.log(`\n➡ Usuário: "${msg}"`);
    try {
        const response = await getMotelAIResponse(msg, history);
        console.log(`🤖 IA: ${response}`);
    } catch (err) {
        console.error("Erro:", err.message);
    }
    await db.pool.end();
}

testSingle();
