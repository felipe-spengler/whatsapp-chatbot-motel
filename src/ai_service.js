const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const FormData = require('form-data');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('./db_service');

// Carregar o prompt do arquivo txt
const MOTEL_PROMPT = fs.readFileSync(path.join(__dirname, '..', 'prompt_ia.txt'), 'utf8');
const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = 'https://api.groq.com/openai/v1';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * Definição das ferramentas (functions) que a IA pode chamar
 */
const tools = [
    {
        type: 'function',
        function: {
            name: 'verificar_disponibilidade_real',
            description: 'Consulta o banco de dados do motel para ver quais quartos estão livres, ocupados, em limpeza ou manutenção, além de ver os preços atuais.',
            parameters: {
                type: 'object',
                properties: {
                    tipo: {
                        type: 'string',
                        description: 'Opcional. Filtro pelo tipo de quarto (ex: "Apartamento", "Suite").'
                    }
                }
            }
        }
    }
];

/**
 * Mapeamento das funções para execução
 */
const functionHandlers = {
    verificar_disponibilidade_real: async ({ tipo }) => {
        try {
            const rooms = await db.getFullRoomsStatus();
            let filteredRooms = rooms;
            
            if (tipo) {
                filteredRooms = rooms.filter(r => 
                    r.tipoquarto.toLowerCase().includes(tipo.toLowerCase())
                );
            }

            // Traduzir status para algo amigável se necessário e formatar
            const response = filteredRooms.map(r => ({
                quarto: r.numeroquarto,
                tipo: r.tipoquarto,
                status: r.status === 'livre' ? 'LIVRE (Disponível agora)' : r.status,
                valor_2h30: `R$ ${r.valorquarto}`,
                valor_pernoite: `R$ ${r.pernoitequarto}`
            }));

            return {
                mensagem: `Aqui está a situação atual dos quartos ${tipo ? `do tipo ${tipo}` : ''}:`,
                dados: response
            };
        } catch (error) {
            return { erro: 'Não foi possível consultar o banco de dados no momento.' };
        }
    }
};

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
            },
            timeout: 30000 // 30 segundos
        });

        return response.data.text;
    } catch (error) {
        console.error('Erro na transcrição Groq:', error.response ? error.response.data : error.message);
        return null;
    }
}

/**
 * Resposta de fallback usando Gemini com suporte a ferramentas
 */
async function getGeminiResponse(userText, history = []) {
    try {
        console.log('Utilizando Gemini (com ferramentas)...');
        
        // Configuração das ferramentas para Gemini
        const geminiTools = [
            {
                functionDeclarations: [
                    {
                        name: 'verificar_disponibilidade_real',
                        description: 'Consulta o banco de dados do motel para ver a disponibilidade e preços dos quartos em tempo real.',
                        parameters: {
                            type: 'OBJECT',
                            properties: {
                                tipo: { type: 'STRING', description: 'Filtro por tipo de quarto' }
                            }
                        }
                    }
                ]
            }
        ];

        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            tools: geminiTools
        });

        const chat = model.startChat({
            history: [
                { role: 'user', parts: [{ text: MOTEL_PROMPT }] },
                { role: 'model', parts: [{ text: 'Entendido. Serei a Recepcionista Virtual do Motel Intensy com acesso ao sistema.' }] },
                ...history.map(msg => ({
                    role: (msg.role === 'assistant' || msg.role === 'model') ? 'model' : 'user',
                    parts: [{ text: msg.content }]
                }))
            ]
        });

        const result = await chat.sendMessage(userText);
        const response = result.response;
        
        // Verificar se quer chamar função
        const call = response.candidates[0].content.parts.find(p => p.functionCall);
        if (call) {
            const { name, args } = call.functionCall;
            console.log(`Gemini chamando função: ${name}`, args);
            const data = await functionHandlers[name](args);
            
            const toolResult = await chat.sendMessage([{
                functionResponse: {
                    name,
                    response: data
                }
            }]);
            return toolResult.response.text();
        }

        return response.text();
    } catch (error) {
        console.error('Erro no fallback Gemini:', error.message);
        throw error;
    }
}

/**
 * Obter resposta do Llama 3 no Groq com suporte a ferramentas
 */
async function getMotelAIResponse(userText, history = []) {
    let messages = [
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
                model: 'llama-3.1-8b-instant', // Llama-3.1 8b já suporta tool calling perfeitamente
                messages,
                tools,
                tool_choice: 'auto',
                temperature: 0.7
            }, {
                headers: { 'Authorization': `Bearer ${GROQ_KEY}` },
                timeout: 30000
            });

            const responseMessage = response.data.choices[0].message;

            // Se houver chamadas de ferramenta
            if (responseMessage.tool_calls) {
                messages.push(responseMessage);
                
                for (const toolCall of responseMessage.tool_calls) {
                    const functionName = toolCall.function.name;
                    const functionArgs = JSON.parse(toolCall.function.arguments);
                    console.log(`Groq chamando função: ${functionName}`, functionArgs);
                    
                    const functionResponse = await functionHandlers[functionName](functionArgs);
                    
                    messages.push({
                        tool_call_id: toolCall.id,
                        role: 'tool',
                        name: functionName,
                        content: JSON.stringify(functionResponse)
                    });
                }

                // Segunda chamada para obter a resposta final baseada no retorno da ferramenta
                const secondResponse = await axios.post(`${GROQ_URL}/chat/completions`, {
                    model: 'llama-3.1-8b-instant',
                    messages,
                    temperature: 0.7
                }, {
                    headers: { 'Authorization': `Bearer ${GROQ_KEY}` },
                    timeout: 30000
                });

                return secondResponse.data.choices[0].message.content;
            }

            return responseMessage.content;

        } catch (error) {
            console.error(`Erro na Groq API (tentativa ${attempt + 1}):`, error.response ? JSON.stringify(error.response.data) : error.message);
            
            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                attempt++;
                continue;
            }
            
            try {
                return await getGeminiResponse(userText, history);
            } catch (geminiError) {
                console.error('Ambos Groq e Gemini falharam.');
                throw error;
            }
        }
    }
}

module.exports = { getMotelAIResponse, transcribeAudio };
