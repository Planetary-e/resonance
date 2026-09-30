/** One bounded authenticated witness exchange; Internet endpoints require normal TLS validation. */
import WebSocket from 'ws';
import type { Socket } from 'node:net';
import { assertSecureRelayTransportEndpoint } from '@resonance/core';
import type { AdmissionWitnessRequest, AdmissionWitnessSet } from '@resonance/core/admission-witness';

export function requestAdmissionWitnessVote(member: AdmissionWitnessSet['members'][number], request: AdmissionWitnessRequest, signal: AbortSignal, onTransportSocket?: (socket: Socket) => void): Promise<unknown> {
  assertSecureRelayTransportEndpoint(member.endpoint);
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Witness request cancelled')); return; }
    let socket: WebSocket | undefined, settled = false;
    const finish = (value?: unknown, error?: Error) => {
      if (settled) return; settled = true; signal.removeEventListener('abort', abort);
      socket?.terminate();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(undefined, new Error('Witness request cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    try { socket = new WebSocket(member.endpoint, { handshakeTimeout: 3000, maxPayload: 4096, followRedirects: false }); }
    catch { finish(undefined, new Error('Witness connection failed')); return; }
    socket.on('error', () => finish(undefined, new Error('Witness connection failed')));
    socket.on('close', () => finish(undefined, new Error('Witness connection closed')));
    socket.on('upgrade', response => onTransportSocket?.(response.socket));
    socket.on('open', () => { if (!settled) socket!.send(JSON.stringify(request)); });
    socket.on('message', (data, binary) => {
      if (binary) { finish(undefined, new Error('Invalid witness response')); return; }
      try { finish(JSON.parse(data.toString())); } catch { finish(undefined, new Error('Invalid witness response')); }
    });
  });
}
