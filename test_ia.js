require('dotenv').config();
const { getMotelAIResponse } = require('./src/ai_service');

async function runTest(label, userText, history = []) {
    console.log(`\n🧪 TESTE: ${label}`);
    console.log(`➡ Usuário: "${userText}"`);
    try {
        const resposta = await getMotelAIResponse(userText, history);
        console.log(`🤖 IA: ${resposta}`);
    } catch (err) {
        console.error(`❌ Falha no teste:`, err.message);
    }
}

async function main() {
    console.log("=== Iniciando testes da IA de Atendimento ===");
    
    // Teste 1: Perguntando os itens de um quarto específico
    await runTest(
        "Itens do Apartamento", 
        "o que tem no apartamento?", 
        [{ role: "user", content: "Olá" }]
    );

    // Teste 2: Perguntando de uma suíte superior
    await runTest(
        "Itens da Suíte Master", 
        "E o que tem na suíte master?", 
        [
            { role: "user", content: "o que tem no apartamento?" },
            { role: "assistant", content: "O Apartamento tem ar, tv..." }
        ]
    );

    // Teste 3: Pergunta específica de frigobar
    await runTest(
        "Tem frigobar?", 
        "as suítes tem frigobar?", 
        [{ role: "user", content: "Olá" }]
    );
    
    console.log("\n=== Fim dos testes ===");
    const db = require('./src/db_service');
    await db.pool.end();
}

main();
