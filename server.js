import cors from 'cors';
import express from 'express';
import htmlHandler from './api/html.js';
import proxyHandler from './api/proxy.js';
import resolveStreamHandler from './api/resolve-stream.js';
import statusHandler from './api/status.js';
import streamHandler from './api/stream.js';

const app = express();

app.use(express.json());
app.use(cors());
app.use(express.static('public'));

app.post('/api/chat', proxyHandler);
app.get('/html', htmlHandler);
app.get('/api/html', htmlHandler);
app.get('/resolve-stream', resolveStreamHandler);
app.get('/api/resolve-stream', resolveStreamHandler);
app.get('/stream', streamHandler);
app.get('/api/stream', streamHandler);
app.post('/api/proxy', proxyHandler);
app.get('/api/status', statusHandler);
app.post('/api/status', statusHandler);

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
    console.log(`=================================`);
    console.log(`WebScrapingAI Router działa pod adresem:`);
    console.log(`http://localhost:${PORT}`);
    console.log(`=================================`);
});