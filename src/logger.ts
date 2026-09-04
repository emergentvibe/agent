import pino from 'pino';

function buildTransport(): pino.TransportSingleOptions | pino.TransportMultiOptions {
  const axiomToken = process.env.AXIOM_TOKEN;
  const axiomDataset = process.env.AXIOM_DATASET || 'nanoclaw';

  if (axiomToken) {
    return {
      targets: [
        {
          target: 'pino-pretty',
          options: { colorize: true },
          level: process.env.LOG_LEVEL || 'info',
        },
        {
          target: '@axiomhq/pino',
          options: { dataset: axiomDataset, token: axiomToken },
          level: process.env.LOG_LEVEL || 'info',
        },
      ],
    };
  }

  return { target: 'pino-pretty', options: { colorize: true } };
}

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: buildTransport(),
});

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
