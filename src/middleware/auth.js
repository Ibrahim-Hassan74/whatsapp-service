const config = require('../config');
const logger = require('../utils/logger');

/**
 * Token-based authentication middleware.
 * Validates x-node-token and x-server-name headers against configured values.
 * Skips authentication for the /health endpoint.
 */
function authMiddleware(req, res, next) {
    // Health check is always public
    if (req.path === '/health') {
        return next();
    }

    const token = req.headers['x-node-token'];
    const server = req.headers['x-server-name'];

    if (!token || !server) {
        logger.warn('Request missing auth headers', {
            path: req.path,
            ip: req.ip,
        });
        return res.status(401).json({ error: 'Missing authentication headers' });
    }

    if (token !== config.nodeToken || server !== config.serverName) {
        logger.warn('Unauthorized request', {
            path: req.path,
            ip: req.ip,
        });
        return res.status(401).json({ error: 'Unauthorized' });
    }

    next();
}

module.exports = authMiddleware;
