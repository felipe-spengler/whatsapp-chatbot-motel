require('dotenv').config();
const { getMotelAIResponse } = require('./src/ai_service');

async function test() {
    console.log("Chamando a IA...");
    const resposta = await getMotelAIResponse("quero saber que horas entrei, estou na 2", [{ role: "user", content: "oi" }]);
    console.log("Resposta final do bot:");
    console.log(resposta);
}

test();
