/** One bounded authenticated witness exchange; Internet endpoints require normal TLS validation. */
import WebSocket from 'ws';
import type { Socket } from 'node:net';
import { assertSecureRelayTransportEndpoint, relayTlsClientOptions } from '@resonance/core';
import type { AdmissionWitnessRequest, AdmissionWitnessSet } from '@resonance/core/admission-witness';

export function requestAdmissionWitnessVote(member: AdmissionWitnessSet['members'][number], request: AdmissionWitnessRequest, signal: AbortSignal, onTransportSocket?: (socket: Socket) => void): Promise<unknown> {
  assertSecureRelayTransportEndpoint(member.endpoint);
  let encoded: string;
  try { encoded = JSON.stringify(request); if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > 4096) throw new Error(); }
  catch { return Promise.reject(new Error('Invalid or oversized witness request')); }
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Witness request cancelled')); return; }
    let socket: WebSocket | undefined, settled = false;
    const deadline = performance.now() + 30_000;
    const finish = (value?: unknown, error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      socket?.terminate();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(undefined, new Error('Witness request cancelled'));
    const timer = setTimeout(() => finish(undefined, new Error('Witness request timed out')), 30_000);
    signal.addEventListener('abort', abort, { once: true });
    try { socket = new WebSocket(member.endpoint, { ...relayTlsClientOptions, handshakeTimeout: 3000, maxPayload: 4096, followRedirects: false, perMessageDeflate: false }); }
    catch { finish(undefined, new Error('Witness connection failed')); return; }
    socket.on('error', () => finish(undefined, new Error('Witness connection failed')));
    socket.on('close', () => finish(undefined, new Error('Witness connection closed')));
    socket.on('upgrade', response => {
      if (settled) return;
      try { onTransportSocket?.(response.socket); }
      catch { finish(undefined, new Error('Witness socket accounting failed')); }
    });
    socket.on('open', () => {
      if (settled) return;
      if (performance.now() >= deadline) { finish(undefined, new Error('Witness request timed out')); return; }
      try { socket!.send(encoded); } catch { finish(undefined, new Error('Witness request send failed')); }
    });
    socket.on('message', (data, binary) => {
      if (settled) return;
      if (performance.now() >= deadline) { finish(undefined, new Error('Witness request timed out')); return; }
      if (binary) { finish(undefined, new Error('Invalid witness response')); return; }
      try { finish(JSON.parse(data.toString())); } catch { finish(undefined, new Error('Invalid witness response')); }
    });
  });
}
