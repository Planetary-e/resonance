export type AdmissionWorkMechanism = 'serialize' | 'parse' | 'clone' | 'copy' | 'concat' | 'base64' | 'encrypt' | 'decrypt' | 'disk-read' | 'disk-write' | 'allocate' | 'other';
export interface AdmissionWorkMeter { charge(bytes: number, mechanism: AdmissionWorkMechanism): void }
export function chargeAdmissionWork(meter: AdmissionWorkMeter | undefined, bytes: number, mechanism: AdmissionWorkMechanism): void {
  meter?.charge(bytes, mechanism);
}
export function chargeAdmissionWorkJson(meter: AdmissionWorkMeter | undefined, value: unknown, mechanism: 'serialize' | 'parse' | 'clone' = 'serialize'): Buffer {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error('Admission value is not JSON serializable');
  chargeAdmissionWork(meter, Buffer.byteLength(text), mechanism);
  const bytes = Buffer.from(text);
  chargeAdmissionWork(meter, bytes.length, mechanism);
  return bytes;
}
export function chargeAdmissionWorkBase64(meter: AdmissionWorkMeter | undefined, value: Uint8Array): string {
  const text = Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64url');
  chargeAdmissionWork(meter, Buffer.byteLength(text), 'base64');
  return text;
}
