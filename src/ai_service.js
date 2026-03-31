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
            description: 'Consulta o banco de dados para ver quais tipos de quartos estão livres e seus preços. Retorna apenas as categorias com unidades disponíveis.',
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
    },
    {
        type: 'function',
        function: {
            name: 'verificar_tempo_permanencia',
            description: 'Calcula há quanto tempo um quarto está no status atual (útil para saber tempo de ocupação ou limpeza).',
            parameters: {
                type: 'object',
                properties: {
                    numero_quarto: {
                        type: 'number',
                        description: 'O número do quarto (ex: 10, 22).'
                    }
                },
                required: ['numero_quarto']
            }
        }
    }
];

/**
 * Mapeamento das funções para execução
 */
const functionHandlers = {
    verificar_disponibilidade_real: async (args) => {
        const tipo = args?.tipo;
        try {
            const rooms = await db.getFullRoomsStatus();
            
            // Focamos apenas em quartos LIVRES por solicitação do usuário
            const freeRooms = rooms.filter(r => r.status === 'livre');
            
            let filteredRooms = freeRooms;
            if (tipo) {
                filteredRooms = freeRooms.filter(r => 
                    r.tipoquarto.toLowerCase().includes(tipo.toLowerCase())
                );
            }

            // Apenas listar os tipos únicos disponíveis (sem quantidade)
            const availableTypes = [...new Set(filteredRooms.map(r => r.tipoquarto))];

            if (availableTypes.length === 0) {
                return { mensagem: "No momento não temos quartos deste tipo disponíveis." };
            }

            return {
                mensagem: "No momento temos as seguintes categorias disponíveis para você:",
                categorias: availableTypes
            };
        } catch (error) {
            console.error('Erro na ferramenta de disponibilidade:', error);
            return { erro: 'Não foi possível consultar o banco de dados no momento.' };
        }
    },

    verificar_tempo_permanencia: async ({ numero_quarto }) => {
        try {
            const rooms = await db.getFullRoomsStatus();
            const room = rooms.find(r => r.numeroquarto == numero_quarto);

            if (!room) {
                return { erro: `Não encontrei o quarto número ${numero_quarto} no sistema.` };
            }

            const statusOcupado = ['ocupado-periodo', 'ocupado-pernoite'];
            if (!statusOcupado.includes(room.status)) {
                return { 
                    mensagem: `O quarto ${numero_quarto} não consta como ocupado no momento.`,
                    alerta: "O cálculo de tempo só funciona para quartos ocupados (período ou pernoite)."
                };
            }

            if (!room.horastatus) {
                return { erro: "Não encontrei informações de horário para este quarto." };
            }

            // Cálculo de Tempo (Considerando que o banco e o servidor estão em UTC-3)
            const now = new Date();
            const offset = -3; 
            const nowInBr = new Date(now.getTime() + (offset * 60 * 60 * 1000) + (now.getTimezoneOffset() * 60 * 1000));
            
            const statusTime = new Date(room.horastatus);
            
            const diffMs = nowInBr - statusTime;
            const diffMin = Math.floor(diffMs / (1000 * 60));
            const hours = Math.floor(diffMin / 60);
            const mins = diffMin % 60;

            return {
                quarto: numero_quarto,
                tipo: room.tipoquarto,
                status_atual: room.status,
                tempo_decorrido: `${hours}h ${mins}min`,
                entrada: room.horastatus
            };
        } catch (error) {
            console.error('Erro na ferramenta de tempo:', error);
            return { erro: 'Erro ao calcular tempo.' };
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
                        description: 'Consulta o banco de dados do motel para ver a disponibilidade e preços dos quartos em tempo real por categoria.',
                        parameters: {
                            type: 'OBJECT',
                            properties: {
                                tipo: { type: 'STRING', description: 'Filtro por tipo de quarto' }
                            }
                        }
                    },
                    {
                        name: 'verificar_tempo_permanencia',
                        description: 'Calcula há quanto tempo um quarto específico está no status atual.',
                        parameters: {
                            type: 'OBJECT',
                            properties: {
                                numero_quarto: { type: 'NUMBER', description: 'Número do quarto' }
                            },
                            required: ['numero_quarto']
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
