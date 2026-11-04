import { configureServiceDiagnostics, log } from '../../logger.js';
configureServiceDiagnostics(process.argv[2]);
for (let index = 0; index < 16000; index++) log('info', 'fixture', { index, detail: 'diagnostic fixture '.repeat(15) });
log('error', 'last-before-process-death');
process.kill(process.pid, 'SIGKILL');
