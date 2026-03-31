require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const http = require('http');
const { Server } = require('socket.io');
const wppconnect = require('@wppconnect-team/wppconnect');
const fs = require('fs');
const path = require('path');
const { handleMessage, handleAnyMessage } = require('./handler');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
let lastQR = null;
let lastStatus = 'loading';
let wppClient = null;

// Monitoramento de Memória (Log a cada 1 hora no console)
setInterval(() => {
    const used = process.memoryUsage();
    console.log(`[MONITOR] RAM: RSS ${Math.round(used.rss / 1024 / 1024 * 100) / 100}MB, Heap ${Math.round(used.heapUsed / 1024 / 1024 * 100) / 100}MB`);
}, 60 * 60 * 1000);

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
process.on('uncaughtException', (err) => {
    console.error('[CRITICAL] Uncaught Exception:', err);
    process.exit(1); // Força reinício pelo Docker
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[CRITICAL] Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1); // Força reinício pelo Docker
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

async function initWhatsApp() {
    try {
        const sessionName = process.env.SESSION_NAME || 'motel-intensy';
        const sessionPath = path.join(__dirname, '..', 'tokens', sessionName);
        
        console.log(`[INIT] Iniciando sessão: ${sessionName}`);
        console.log(`[INIT] Caminho da sessão: ${sessionPath}`);

        // Limpeza robusta de travas do Chromium (essencial para Docker/VPS)
        if (fs.existsSync(sessionPath)) {
            const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
            const targets = [
                ...lockFiles.map(f => path.join(sessionPath, f)),
                ...lockFiles.map(f => path.join(sessionPath, 'Default', f))
            ];
            
            targets.forEach(filePath => {
                if (fs.existsSync(filePath)) {
                    try {
                        fs.unlinkSync(filePath);
                        console.log(`[CLEANUP] Arquivo de trava removido: ${path.basename(filePath)} (${filePath.includes('Default') ? 'Default' : 'Root'})`);
                    } catch (e) {
                        console.error(`[CLEANUP] Erro ao remover ${filePath}:`, e.message);
                    }
                }
            });
        }

        const client = await wppconnect.create({
            session: sessionName,
            catchQR: (base64Qrimg) => {
                lastQR = base64Qrimg;
                lastStatus = 'qr';
                io.emit('qr', base64Qrimg);
            },
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
                '--use-mock-keychain',
                '--js-flags="--max-old-space-size=512"'
            ]
        });

        wppClient = client;
        console.log('Motel Bot is active!');
        lastStatus = 'connected';
        io.emit('status', 'connected');

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
