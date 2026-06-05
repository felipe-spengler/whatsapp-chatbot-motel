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

const CRASH_LOG_PATH = path.join(__dirname, '..', 'temp', 'last_crash.json');

function saveCrashReport(error, source = 'Unknown') {
    try {
        const report = {
            time: new Date().toLocaleString('pt-BR'),
            source,
            message: error.message || String(error),
            stack: error.stack ? error.stack.split('\n').slice(0, 5).join('\n') : 'No stack trace'
        };
        const tempDir = path.dirname(CRASH_LOG_PATH);
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        fs.writeFileSync(CRASH_LOG_PATH, JSON.stringify(report, null, 2));
        console.log(`[REPORTER] Erro salvo em ${CRASH_LOG_PATH}`);
    } catch (e) {
        console.error('[REPORTER] Erro ao salvar crash report:', e);
    }
}

// Tratamento Global de Erros para Evitar Travamentos Silenciosos
process.on('uncaughtException', async (err) => {
    console.error('[CRITICAL] Uncaught Exception:', err);
    saveCrashReport(err, 'Uncaught Exception');
    if (wppClient && NOTIFICATION_NUMBER) {
        try { await wppClient.sendText(`${NOTIFICATION_NUMBER}@c.us`, `🚨 *FALHA CRÍTICA:* Erro fatal na aplicação:\n${err.message}\nO bot será reiniciado.`); } catch(e) {}
    }
    setTimeout(() => process.exit(1), 2000); // Força reinício pelo Docker
});

process.on('unhandledRejection', async (reason, promise) => {
    console.error('[CRITICAL] Unhandled Rejection at:', promise, 'reason:', reason);
    const err = reason instanceof Error ? reason : new Error(String(reason));
    saveCrashReport(err, 'Unhandled Rejection');
    if (wppClient && NOTIFICATION_NUMBER) {
        try { await wppClient.sendText(`${NOTIFICATION_NUMBER}@c.us`, `🚨 *FALHA CRÍTICA:* Rejeição de processo não tratada.\nO bot será reiniciado.`); } catch(e) {}
    }
    setTimeout(() => process.exit(1), 2000); // Força reinício pelo Docker
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
        
        console.log(`[INIT] 🚀 Iniciando fluxo de conexão: ${sessionName}`);
        console.log(`[INIT] 📂 Caminho da sessão: ${sessionPath}`);

        // Limpeza robusta de travas do Chromium (essencial para Docker/VPS)
        if (fs.existsSync(sessionPath)) {
            console.log(`[INIT] 🧹 Limpando travas da sessão anterior...`);
            try {
                // Remove arquivos de trava de forma recursiva e segura
                const removeLocks = (dir) => {
                    if (!fs.existsSync(dir)) return;
                    const files = fs.readdirSync(dir);
                    files.forEach(file => {
                        const fullPath = path.join(dir, file);
                        if (file.startsWith('Singleton') || file.includes('lockfile') || file === 'LOCK') {
                            try {
                                fs.unlinkSync(fullPath);
                                console.log(`[CLEANUP] Removido: ${file}`);
                            } catch (e) {}
                        }
                    });
                };

                removeLocks(sessionPath);
                removeLocks(path.join(sessionPath, 'Default'));
                
                // Limpeza de pastas de cache se existirem (ajuda na performance no boot)
                ['Cache', 'Code Cache', 'GPUCache'].forEach(folder => {
                    const folderPath = path.join(sessionPath, folder);
                    if (fs.existsSync(folderPath)) {
                        try {
                            fs.rmSync(folderPath, { recursive: true, force: true });
                            console.log(`[CLEANUP] Pasta de cache removida: ${folder}`);
                        } catch (e) {}
                    }
                });
            } catch (e) {
                console.warn(`[INIT] Aviso na limpeza de sessão:`, e.message);
            }
        }

        console.log('[INIT] 🌐 Chamando wppconnect.create...');
        
        // Timeout de 4 minutos para a criação do cliente — essencial para VPS com volume lento
        const clientPromise = wppconnect.create({
            session: sessionName,
            autoClose: 0,
            catchQR: (base64Qrimg) => {
                console.log('[WPP] 📲 QR Code gerado.');
                lastQR = base64Qrimg;
                lastStatus = 'qr';
                io.emit('qr', base64Qrimg);
            },
            protocolTimeout: 120000, // 120s para o protocolo interno
            puppeteerOptions: {
                userDataDir: sessionPath,
                executablePath: '/usr/bin/google-chrome-stable', // Caminho padrão no Debian/Ubuntu do Docker
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-software-rasterizer',
                    '--blink-settings=imagesEnabled=false',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-features=site-per-process',
                    '--disable-extensions'
                ]
            },
            disableWelcome: true,
            updatesLog: false,
            statusFind: (statusSession) => {
                lastStatus = statusSession;
                if (statusSession === 'isLogged' || statusSession === 'connected') {
                    lastQR = null;
                }
                io.emit('status', statusSession);
                console.log('[WPP] Status:', statusSession);
            },
            headless: 'new',
            useChrome: true // Força o uso do Chrome instalado ao invés do Chromium baixado
        });

        // Wrapper de timeout ampliado para 4 minutos
        const client = await Promise.race([
            clientPromise,
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('WPPConnect Timeout: demorou mais de 4 minutos para iniciar. Verifique limites de CPU/RAM.')), 240000)
            )
        ]);

        wppClient = client;
        console.log('✅ Motel Bot está ATIVO!');
        lastStatus = 'connected';
        io.emit('status', 'connected');

        if (NOTIFICATION_NUMBER) {
            setTimeout(async () => {
                try {
                    let startupMsg = `🚀 *SISTEMA ONLINE:* O Motel Bot foi reinicializado com sucesso!`;
                    if (fs.existsSync(CRASH_LOG_PATH)) {
                        const crashInfo = JSON.parse(fs.readFileSync(CRASH_LOG_PATH, 'utf8'));
                        startupMsg += `\n\n⚠️ *RELATÓRIO:* ${crashInfo.message}`;
                        fs.unlinkSync(CRASH_LOG_PATH);
                    }
                    await wppClient.sendText(`${NOTIFICATION_NUMBER}@c.us`, startupMsg).catch(() => {});
                } catch (err) {}
            }, 5000);
        }

        client.onStateChange((state) => {
            console.log(`[WPP] Estado: ${state}`);
            if (state === 'CONFLICT' || state === 'UNPAIRED' || state === 'UNLAUNCHED') {
                process.exit(1);
            }
        });

        setInterval(async () => {
            if (wppClient && lastStatus === 'connected') {
                try {
                    const isConn = await wppClient.isConnected();
                    if (!isConn) process.exit(1);
                } catch (e) { process.exit(1); }
            }
        }, 60000);

        client.onMessage(async (message) => await handleMessage(client, message));
        client.onAnyMessage(async (message) => await handleAnyMessage(client, message));

    } catch (error) {
        console.error('❌ ERRO NO BOOT:', error.message);
        saveCrashReport(error, 'Initialization Error');
        io.emit('status', 'error');
        console.log('[RETRY] Reiniciando em 15s...');
        setTimeout(() => process.exit(1), 15000);
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
