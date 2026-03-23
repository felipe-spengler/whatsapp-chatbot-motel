require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const http = require('http');
const { Server } = require('socket.io');
const wppconnect = require('@wppconnect-team/wppconnect');
const path = require('path');
const { handleMessage } = require('./handler');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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
        const client = await wppconnect.create({
            session: process.env.SESSION_NAME || 'motel-intensy',
            catchQR: (base64Qrimg) => io.emit('qr', base64Qrimg),
            statusFind: (statusSession) => io.emit('status', statusSession),
            headless: 'new',
            useChrome: true,
            browserArgs: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        console.log('Motel Bot is active!');
        io.emit('status', 'connected');

        client.onMessage(async (message) => {
            await handleMessage(client, message);
        });

    } catch (error) {
        console.error('WPP Error:', error);
        io.emit('status', 'error');
    }
}

server.listen(PORT, () => {
    console.log(`Motel Dashboard: http://localhost:${PORT}`);
    initWhatsApp();
});
