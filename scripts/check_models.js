require('dotenv').config();
const { GoogleGenerativeAI } = require("@google/generative-ai");

async function listModels() {
    try {
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        // A SDK do Node não tem um método direto simplificado para listar modelos no genAI object facilmente sem o cliente de admin, 
        // mas podemos tentar instanciar 'gemini-pro' como fallback.
        console.log("Tentando instanciar gemini-pro...");
        const model = genAI.getGenerativeModel({ model: "gemini-pro" });
        const result = await model.generateContent("Oi");
        console.log("Sucesso com gemini-pro:", result.response.text());
    } catch (error) {
        console.error("Erro ao listar/testar modelos:", error.message);
    }
}

listModels();
