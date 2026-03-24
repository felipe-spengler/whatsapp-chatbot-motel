const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');

// Carregar o prompt do arquivo txt
const MOTEL_PROMPT = fs.readFileSync(path.join(__dirname, '..', 'prompt_ia.txt'), 'utf8');
const API_KEY = process.env.GEMINI_API_KEY;
const API_URL = 'https://generativelanguage.googleapis.com/v1/models';

async function getMotelAIResponse(userText, history = []) {
    const contents = [
        { role: 'user', parts: [{ text: MOTEL_PROMPT }] },
        { role: 'model', parts: [{ text: "Compreendido. Sou a atendente virtual do Motel Intensy. Estou pronta." }] },
        ...history.map(msg => ({
            role: (msg.role === 'assistant' || msg.role === 'model') ? 'model' : 'user',
            parts: [{ text: msg.content }]
        })),
        { role: 'user', parts: [{ text: userText }] }
    ];

    const maxRetries = 3; // Tentar até 3 vezes extras se der 429
    let attempt = 0;

    while (attempt <= maxRetries) {
        try {
            const response = await axios.post(`${API_URL}/gemini-2.5-flash-lite:generateContent?key=${API_KEY}`, {
                contents,
                generationConfig: { temperature: 0.7, topP: 0.8, topK: 40 }
            });

            if (response.data && response.data.candidates && response.data.candidates[0].content) {
                return response.data.candidates[0].content.parts[0].text;
            }
            throw new Error('Resposta sem conteúdo da Gemini');

        } catch (error) {
            const isQuotaError = error.response && error.response.status === 429;
            if (isQuotaError && attempt < maxRetries) {
                console.log(`Cota Gemini excedida. Aguardando 60s (Tentativa ${attempt + 1}/${maxRetries})...`);
                await new Promise(resolve => setTimeout(resolve, 60000));
                attempt++;
                continue;
            }
            console.error('Erro na Gemini API:', error.response ? error.response.data : error.message);
            throw error;
        }
    }
}

module.exports = { getMotelAIResponse };
