import proxyHandler from './proxy.js';

export default async function handler(req, res) {
    return proxyHandler(req, res);
}