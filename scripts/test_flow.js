require('dotenv').config();
const { getMotelAIResponse } = require('../src/ai_service');

const testMessages = [
    "Olá, gostaria de saber os valores",
    "Qual o endereço?",
    "Queria reservar uma suíte",
    "A Suíte Master",
    "Amanhã às 22h",
    "Pernoite",
    "Somente 2 pessoas"
];

async function simulateConversation() {
    console.log("🚀 Iniciando Simulação de Conversa (Motel Intensy)\n");
    let history = [];

    for (const msg of testMessages) {
        console.log(`👤 Usuário: ${msg}`);
        
        const response = await getMotelAIResponse(msg, history);
        
        console.log(`🤖 IA: ${response}`);
        console.log("------------------------------------------");
        
        history.push({ role: 'user', content: msg });
        history.push({ role: 'assistant', content: response });
        
        // Pequeno delay para simular tempo de resposta
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log("\n✅ Simulação finalizada. Verifique se a IA seguiu o fluxo do prompt_ia.txt corretamente.");
}

simulateConversation();
