const fastify = require('fastify')({ 
    logger: {
        level: 'info',
        prettyPrint: true
    }
});
const networking = require('@needle-tools/needle-networking');

// Enable CORS for ngrok/external access
fastify.register(require('@fastify/cors'), {
    origin: '*', // Development only! Use specific domain in production
    credentials: true
});

// Health check endpoint
fastify.get('/health', async (request, reply) => {
    return { status: 'ok', timestamp: new Date().toISOString() };
});

// Start Needle Networking
networking.startServerFastify(fastify, { 
    endpoint: '/socket',
    maxUsers: 50,
    defaultUserTimeout: 30
});

const PORT = process.env.PORT || 9001;
const HOST = '0.0.0.0'; // Important: 0.0.0.0 to accept external connections

const start = async () => {
    try {
        await fastify.listen({ port: PORT, host: HOST });
        console.log('');
        console.log('╔════════════════════════════════════════╗');
        console.log('║  Needle Networking Server Started     ║');
        console.log('╚════════════════════════════════════════╝');
        console.log('');
        console.log(`🌐 Local:    ws://localhost:${PORT}/socket`);
        console.log(`🌐 Network:  ws://0.0.0.0:${PORT}/socket`);
        console.log(`✅ Health:   http://localhost:${PORT}/health`);
        console.log('');
        console.log('Waiting for connections...');
        console.log('');
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

// Graceful shutdown
const closeGracefully = async (signal) => {
    console.log(`\n⚠️  Received ${signal}, closing server...`);
    await fastify.close();
    process.exit(0);
};

process.on('SIGINT', () => closeGracefully('SIGINT'));
process.on('SIGTERM', () => closeGracefully('SIGTERM'));

start();