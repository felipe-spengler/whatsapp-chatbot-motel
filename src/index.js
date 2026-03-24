require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const http = require('http');
const { Server } = require('socket.io');
const wppconnect = require('@wppconnect-team/wppconnect');
const fs = require('fs');
const path = require('path');
const { handleMessage } = require('./handler');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
let lastQR = null;
let lastStatus = 'loading';
let wppClient = null;

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
        // Limpar trava do Chromium se o container caiu e deixou sujeira
        const lockFile = path.join(__dirname, '..', 'tokens', (process.env.SESSION_NAME || 'motel-intensy'), 'SingletonLock');
        if (fs.existsSync(lockFile)) {
            try { fs.unlinkSync(lockFile); console.log('Trava de sessão antiga removida.'); } catch (e) {}
        }

        const client = await wppconnect.create({
            session: process.env.SESSION_NAME || 'motel-intensy',
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
            useChrome: true,
            autoClose: 0,
            browserArgs: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        wppClient = client;
        console.log('Motel Bot is active!');
        lastStatus = 'connected';
        io.emit('status', 'connected');

        client.onMessage(async (message) => {
            await handleMessage(client, message);
        });

        client.onAnyMessage(async (message) => {
            const { handleAnyMessage } = require('./handler');
            await handleAnyMessage(client, message);
        });

    } catch (error) {
        console.error('WPP Error:', error);
        io.emit('status', 'error');
    }
}

io.on('connection', (socket) => {
    console.log('Painel Admin conectado:', socket.id);
    if (lastQR) socket.emit('qr', lastQR);
    socket.emit('status', lastStatus);

    socket.on('refresh-qr', async () => {
        console.log('Solicitação de atualização de QR Code recebida');
        if (wppClient) {
            try {
                await wppClient.close();
                wppClient = null;
                lastQR = null;
                lastStatus = 'loading';
                io.emit('status', 'loading');
                initWhatsApp();
            } catch (e) {
                console.error('Erro ao reiniciar sessão:', e);
                initWhatsApp();
            }
        } else {
            initWhatsApp();
        }
    });
});

server.listen(PORT, () => {
    console.log(`Motel Dashboard: http://localhost:${PORT}`);
    initWhatsApp();
});
