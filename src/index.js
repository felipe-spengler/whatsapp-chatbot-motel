require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const http = require('http');
const { Server } = require('socket.io');
const wppconnect = require('@wppconnect-team/wppconnect');
const fs = require('fs');
const path = require('path');
const { handleMessage, handleAnyMessage, sessions: handlerSessions } = require('./handler');
const { startMemoryWatchdog, getProtectionMetrics } = require('./protection');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
let lastQR = null;
let lastStatus = 'loading';
let wppClient = null;
const NOTIFICATION_NUMBER = process.env.NOTIFICATION_NUMBER ? process.env.NOTIFICATION_NUMBER.replace(/\D/g, '') : null;

// ─── CAMADA 1: WATCHDOG DE MEMÓRIA ─────────────────────────────────────────
// Inicia logo aqui, antes de qualquer IO, para garantir que o guard esteja ativo.
startMemoryWatchdog(handlerSessions, (heapMB) => {
    // Apenas loga — quem reinicia é o Docker/PM2 via process.exit nos handlers de erro.
    // Se quiser reiniciar automaticamente ao ultrapassar heap, descomente a linha abaixo:
    // if (heapMB > 480) setTimeout(() => process.exit(1), 500);
    if (wppClient && NOTIFICATION_NUMBER) {
        wppClient.sendText(`${NOTIFICATION_NUMBER}@c.us`,
            `⚠️ *ALERTA MEMÓRIA:* Heap em ${heapMB} MB. Monitore a VPS.`
        ).catch(() => {});
    }
});

// Limpeza diária de arquivos temporários (para evitar encher o disco da VPS)
setInterval(() => {
    const tempPath = path.join(__dirname, '..', 'temp');
    if (fs.existsSync(tempPath)) {
        console.log('[CLEANUP] Limpando pasta temp...');
        try {
            const files = fs.readdirSync(tempPath);
            for (const file of files) {
                fs.unlinkSync(path.join(tempPath, file));
            }
        } catch (e) { console.error('Erro na limpeza temp:', e); }
    }
}, 24 * 60 * 60 * 1000);

// Tratamento Global de Erros para Evitar Travamentos Silenciosos
process.on('uncaughtException', async (err) => {
    console.error('[CRITICAL] Uncaught Exception:', err);
    if (wppClient && NOTIFICATION_NUMBER) {
        try { await wppClient.sendText(`${NOTIFICATION_NUMBER}@c.us`, `🚨 *FALHA CRÍTICA:* Erro fatal na aplicação:\n${err.message}\nO bot será reiniciado.`); } catch(e) {}
    }
    setTimeout(() => process.exit(1), 1500); // Força reinício pelo Docker
});

process.on('unhandledRejection', async (reason, promise) => {
    console.error('[CRITICAL] Unhandled Rejection at:', promise, 'reason:', reason);
    if (wppClient && NOTIFICATION_NUMBER) {
        try { await wppClient.sendText(`${NOTIFICATION_NUMBER}@c.us`, `🚨 *FALHA CRÍTICA:* Rejeição de processo não tratada.\nO bot será reiniciado.`); } catch(e) {}
    }
    setTimeout(() => process.exit(1), 1500); // Força reinício pelo Docker
});

const PORT = process.env.PORT || 3001;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin';

app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
    secret: 'motel-intensy-secret',
    resave: false,
    saveUninitialized: true
}));

const isAuthenticated = (req, res, next) => {
    if (req.session.authenticated) return next();
    res.redirect('/login');
};

app.get('/', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USER && password === ADMIN_PASS) {
        req.session.authenticated = true;
        res.redirect('/');
    } else {
        res.send('Acesso negado. <a href="/login">Voltar</a>');
    }
});

// ─── ENDPOINT DE MÉTRICAS VPS ────────────────────────────────────────────────
app.get('/metrics', isAuthenticated, (req, res) => {
    const metrics = getProtectionMetrics();
    metrics.sessions       = Object.keys(handlerSessions).length;
    metrics.activeSessions = Object.values(handlerSessions).filter(s => s.isProcessing).length;
    metrics.uptime         = Math.round(process.uptime()) + 's';
    res.json(metrics);
});

async function initWhatsApp() {
    try {
        const sessionName = process.env.SESSION_NAME || 'motel-intensy';
        const sessionPath = path.join(__dirname, '..', 'tokens', sessionName);
        
        console.log(`[INIT] Iniciando sessão: ${sessionName}`);
        console.log(`[INIT] Caminho da sessão: ${sessionPath}`);

        // Limpeza robusta de travas do Chromium (essencial para Docker/VPS)
        if (fs.existsSync(sessionPath)) {
            try {
                const files = fs.readdirSync(sessionPath);
                console.log(`[INIT] Arquivos na pasta da sessão: ${files.join(', ')}`);
                
                // Tentativa de remover usando comando do sistema para ser mais incisivo com links simbólicos
                const { execSync } = require('child_process');
                try {
                    execSync(`rm -f ${path.join(sessionPath, 'Singleton*')}`);
                    execSync(`rm -f ${path.join(sessionPath, 'Default', 'Singleton*')}`);
                    console.log(`[CLEANUP] Comando de limpeza executado.`);
                } catch (cmdErr) {
                    // Fallback manual se o rm falhar
                    const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
                    lockFiles.forEach(file => {
                        [sessionPath, path.join(sessionPath, 'Default')].forEach(dir => {
                            const filePath = path.join(dir, file);
                            if (fs.existsSync(filePath)) {
                                fs.unlinkSync(filePath);
                                console.log(`[CLEANUP] Limpeza manual: ${filePath}`);
                            }
                        });
                    });
                }
            } catch (e) {
                console.error(`[INIT] Erro ao ler pasta da sessão:`, e.message);
            }
        } else {
            console.log(`[INIT] Pasta da sessão não existe ainda (será criada): ${sessionPath}`);
        }

        const client = await wppconnect.create({
            session: sessionName,
            catchQR: (base64Qrimg) => {
                lastQR = base64Qrimg;
                lastStatus = 'qr';
                io.emit('qr', base64Qrimg);
            },
            protocolTimeout: 130000, // Aumentado ligeiramente para mais segurança
            puppeteerOptions: {
                protocolTimeout: 130000,
            },
            disableWelcome: true, // Reduz processamento/logs no boot
            updatesLog: false,
            statusFind: (statusSession) => {
                lastStatus = statusSession;
                if (statusSession === 'isLogged' || statusSession === 'connected') {
                    lastQR = null;
                }
                io.emit('status', statusSession);
                console.log('Status Session:', statusSession);
            },
            headless: 'new',
            useChrome: false, // Forçar Chromium interno do Puppeteer para maior compatibilidade no Docker
            autoClose: 0,
            browserArgs: [
                '--disable-renderer-backgrounding',
                 '--disable-features=IntensiveWakeUpThrottling',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--hide-scrollbars',
                '--mute-audio',
                '--disable-extensions',
                '--disable-component-update',
                '--disable-background-networking',
                '--disable-background-timer-fast-tracking',
                '--disable-backgrounding-occluded-windows',
                '--disable-breakpad',
                '--disable-client-side-phishing-detection',
                '--disable-default-apps',
                '--disable-hang-monitor',
                '--disable-popup-blocking',
                '--disable-prompt-on-repost',
                '--disable-sync',
                '--disable-translate',
                '--metrics-recording-only',
                '--no-default-browser-check',
                '--safebrowsing-disable-auto-update',
                '--password-store=basic',
                '--use-mock-keychain'
            ]
        });

        wppClient = client;
        console.log('Motel Bot is active!');
        lastStatus = 'connected';
        io.emit('status', 'connected');

        if (NOTIFICATION_NUMBER) {
            console.log('[WPP] Agendando envio de notificação de inicialização para o Admin em 8s...');
            setTimeout(async () => {
                try {
                    await wppClient.sendText(`${NOTIFICATION_NUMBER}@c.us`, `🚀 *SISTEMA ONLINE:* O Motel Bot (Docker) foi inicializado com sucesso e está operante!`);
                    console.log('[WPP] Notificação de inicialização enviada com sucesso.');
                } catch (err) {
                    console.error('[WPP] Falha ao enviar notificação de inicialização', err.message);
                }
            }, 8000);
        }

        client.onStateChange((state) => {
            console.log(`[WPP] Estado alterado para: ${state}`);
            if (state === 'CONFLICT' || state === 'UNPAIRED' || state === 'UNLAUNCHED' || state === 'TIMEOUT') {
                console.log(`[CRITICAL] Falha na conexão (Estado: ${state}). Reiniciando WPPConnect...`);
                // Envia logout para limpar auth stale, então reinicia Node
                process.exit(1);
            }
        });

        // Loop de Keep-Alive (Heartbeat) - Evita que o websocket do WhatsApp Web hiberne
        setInterval(async () => {
            if (wppClient && lastStatus === 'connected') {
                try {
                    const isConn = await wppClient.isConnected();
                    if (!isConn) {
                        console.log('[CRITICAL] WPPConnect relatou isConnected=false silenciosamente! Reiniciando...');
                        if (NOTIFICATION_NUMBER) {
                            try { await wppClient.sendText(`${NOTIFICATION_NUMBER}@c.us`, `⚠️ *ALERTA WPPCONNECT:* A conexão ficou congelada silenciosamente. Vou reiniciar o bot forçadamente para reestabelecer.`); } catch(e){}
                        }
                        setTimeout(() => process.exit(1), 1000);
                    }
                } catch (e) {
                    console.error('[CRITICAL] Erro no Ping do WPPConnect (A página pode ter crashado):', e.message);
                    if (NOTIFICATION_NUMBER) {
                        try { await wppClient.sendText(`${NOTIFICATION_NUMBER}@c.us`, `⚠️ *ALERTA WPPCONNECT:* A página do WhatsApp desabou (${e.message}). Reiniciando o node/docker...`); } catch(e){}
                    }
                    setTimeout(() => process.exit(1), 1000); // Força docker/pm2 a reiniciar
                }
            }
        }, 60000); // Ping a cada 1 minuto

        client.onMessage(async (message) => {
            await handleMessage(client, message);
        });

        client.onAnyMessage(async (message) => {
            await handleAnyMessage(client, message);
        });

    } catch (error) {
        console.error('WPP Error:', error);
        io.emit('status', 'error');
        
        // Se falhou por causa do browser, tenta limpar e reiniciar uma vez após 5s
        if (error.message.includes('launch the browser')) {
            console.log('Tentando auto-recuperação em 10 segundos...');
            setTimeout(() => initWhatsApp(), 10000);
        }
    }
}

// Graceful Shutdown - Crucial para não deixar travas no Chromium
const handleShutdown = async (signal) => {
    console.log(`\n[SHUTDOWN] Sinal ${signal} recebido. Fechando processos...`);
    if (wppClient) {
        try {
            await wppClient.close();
            console.log('[SHUTDOWN] Cliente WPP fechado com sucesso.');
        } catch (e) {
            console.error('[SHUTDOWN] Erro ao fechar cliente WPP:', e.message);
        }
    }
    process.exit(0);
};

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

io.on('connection', (socket) => {
    console.log('Painel Admin conectado:', socket.id);
    if (lastQR) socket.emit('qr', lastQR);
    socket.emit('status', lastStatus);

    socket.on('refresh-qr', async () => {
        console.log('Solicitação de atualização de QR Code recebida');
        try {
            if (wppClient) {
                console.log('Fechando cliente antigo...');
                await wppClient.close().catch(e => console.error('Erro ao fechar cliente:', e.message));
                wppClient = null;
            }
            lastQR = null;
            lastStatus = 'loading';
            io.emit('status', 'loading');
            // Pequeno delay para garantir que processos do SO sejam liberados
            setTimeout(() => initWhatsApp(), 2000);
        } catch (e) {
            console.error('Erro no fluxo de reinicialização:', e);
            initWhatsApp();
        }
    });
});

server.listen(PORT, () => {
    console.log(`Motel Dashboard: http://localhost:${PORT}`);
    initWhatsApp();
});
