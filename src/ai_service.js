const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');

// Carregar o prompt do arquivo txt
const MOTEL_PROMPT = fs.readFileSync(path.join(__dirname, '..', 'prompt_ia.txt'), 'utf8');

async function getMotelAIResponse(userText, history = []) {
    try {
        const apiKey = process.env.GEMINI_API_KEY;
        const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`;

        const historyText = history.map(h => `${h.role === 'user' ? 'Usuário' : 'IA'}: ${h.content}`).join('\n');
        const fullPrompt = `${MOTEL_PROMPT}\n\nHistórico:\n${historyText}\n\nUsuário: ${userText}`;

        const response = await axios.post(url, {
            contents: [{
                parts: [{ text: fullPrompt }]
            }]
        });

        if (response.data && response.data.candidates && response.data.candidates[0].content) {
            return response.data.candidates[0].content.parts[0].text;
        }

        return "Ops, desculpe. Tive um probleminha técnico. Poderia repetir? 💖";
    } catch (error) {
        console.error("Erro na Gemini API (Direct Axios):", error.response ? error.response.data : error.message);
        return "Ops, tive um probleminha de conexão com a IA. Pode tentar novamente? 💖";
    }
}

module.exports = { getMotelAIResponse };
