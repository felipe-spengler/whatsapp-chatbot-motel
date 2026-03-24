const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const FormData = require('form-data');

// Carregar o prompt do arquivo txt
const MOTEL_PROMPT = fs.readFileSync(path.join(__dirname, '..', 'prompt_ia.txt'), 'utf8');
const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = 'https://api.groq.com/openai/v1';

/**
 * Transcrever áudio usando Groq Whisper
 */
async function transcribeAudio(audioBuffer, filename = 'audio.ogg') {
    try {
        const formData = new FormData();
        formData.append('file', audioBuffer, filename);
        formData.append('model', 'whisper-large-v3');

        const response = await axios.post(`${GROQ_URL}/audio/transcriptions`, formData, {
            headers: {
                ...formData.getHeaders(),
                'Authorization': `Bearer ${GROQ_KEY}`
            }
        });

        return response.data.text;
    } catch (error) {
        console.error('Erro na transcrição Groq:', error.response ? error.response.data : error.message);
        return null;
    }
}

/**
 * Obter resposta do Llama 3 no Groq
 */
async function getMotelAIResponse(userText, history = []) {
    const messages = [
        { role: 'system', content: MOTEL_PROMPT },
        ...history.map(msg => ({
            role: (msg.role === 'assistant' || msg.role === 'model') ? 'assistant' : 'user',
            content: msg.content
        })),
        { role: 'user', content: userText }
    ];

    const maxRetries = 2;
    let attempt = 0;

    while (attempt <= maxRetries) {
        try {
            const response = await axios.post(`${GROQ_URL}/chat/completions`, {
                model: 'llama-3.1-8b-instant',
                messages,
                temperature: 0.7,
                max_tokens: 1024
            }, {
                headers: { 'Authorization': `Bearer ${GROQ_KEY}` }
            });

            return response.data.choices[0].message.content;

        } catch (error) {
            console.error('Erro na Groq API:', error.response ? error.response.data : error.message);
            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                attempt++;
                continue;
            }
            throw error;
        }
    }
}

module.exports = { getMotelAIResponse, transcribeAudio };
