import React, { useEffect, useState } from 'react';
import { getAdmissionWallet, configureAdmissionWallet, importAdmissionTokens, requestAdmissionTokens, completeAdmissionIssuance, cancelAdmissionIssuance, installAdmissionPolicy, type AdmissionWalletStatus } from '../api.client';

export default function AdmissionWallet({ privateDeliveryAvailable, onChange }: {
  privateDeliveryAvailable: boolean; onChange: () => Promise<unknown>;
}) {
  const [status, setStatus] = useState<AdmissionWalletStatus | null>(null);
  const [issuer, setIssuer] = useState('');
  const [epoch, setEpoch] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [relays, setRelays] = useState('');
  const [tokens, setTokens] = useState('');
  const [count, setCount] = useState(8);
  const [response, setResponse] = useState('');
  const [authority, setAuthority] = useState('');
  const [policyText, setPolicyText] = useState('');
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function refresh() {
    const result = await getAdmissionWallet();
    if (result.error) { setMessage(result.error); return; }
    setStatus(result);
  }
  useEffect(() => { void refresh(); }, []);
  async function configure(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      const result = await configureAdmissionWallet({ version: 1, scope: { issuer: issuer.trim(), community: 'public', epoch: epoch.trim() },
        issuerPublicKey: publicKey.trim(), relayUrls: relays.split(/[\s,]+/).filter(Boolean) });
      setMessage(result.error ?? 'Wallet setup saved. Automatic mailbox checks are paused.');
      if (!result.error) { setIssuer(''); setEpoch(''); setPublicKey(''); setRelays(''); setChanging(false); }
      await refresh(); await onChange();
    } finally { setBusy(false); }
  }
  async function importTokens(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage('');
    const batch = tokens.trim().split(/\s+/).filter(Boolean);
    // Bearer tokens do not remain displayed after an import attempt or get stored in browser storage.
    setTokens('');
    try {
      const result = await importAdmissionTokens(batch);
      setMessage(result.error ?? `${result.imported} new access tokens imported.`);
      await refresh(); await onChange();
    } finally { setBusy(false); }
  }
  async function issuance(action: 'request' | 'complete' | 'cancel') {
    setBusy(true); setMessage('');
    try {
      const result = action === 'request' ? await requestAdmissionTokens(count)
        : action === 'cancel' ? await cancelAdmissionIssuance()
        : await completeAdmissionIssuance(JSON.parse(response));
      setMessage(result.error ?? (action === 'request' ? 'Blinded request prepared. Share it with your community issuer.'
        : action === 'cancel' ? 'Unfinished token request cancelled.' : 'Signed response verified and tokens added.'));
      setResponse(''); await refresh(); await onChange();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Invalid signed response'); }
    finally { setBusy(false); }
  }
  async function installPolicy(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      const result = await installAdmissionPolicy(JSON.parse(policyText), authority.trim());
      setMessage(result.error ?? 'Signed community policy saved. Earlier wallet history is retained; automatic checks are paused.');
      if (!result.error) { setPolicyText(''); setAuthority(''); setChanging(false); }
      await refresh(); await onChange();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Invalid signed policy'); }
    finally { setBusy(false); }
  }
  return <section className="relay-section">
    <h3>Access-token wallet</h3>
    {message && <p role="status">{message}</p>}
    {(privateDeliveryAvailable || status?.configured) && <details><summary>Community-signed setup</summary>
      <p>Verify the community authority key through an independent trusted channel. A policy cannot authorize its own signing key. Once pinned, only this authority can update setup. Older revisions and extended retirement dates are refused.</p>
      <form onSubmit={installPolicy}>
        <label htmlFor="wallet-authority">Verified community authority key</label>
        <input id="wallet-authority" value={authority} onChange={event => setAuthority(event.target.value)} maxLength={44} disabled={busy} required />
        <label htmlFor="wallet-policy">Signed community policy (JSON)</label>
        <textarea id="wallet-policy" value={policyText} onChange={event => setPolicyText(event.target.value)} rows={5} maxLength={65536} disabled={busy} spellCheck={false} required />
        <button className="btn btn-primary btn-sm" disabled={busy || !!status?.pendingIssuance}>Verify and apply policy</button>
      </form>
    </details>}
    {status?.policy && <div>
      <p>Community policy revision {status.policy.revision}. Refresh before {new Date(status.policy.expiresAt).toLocaleString()}.</p>
      <p className="text-sm" style={{ overflowWrap: 'anywhere' }}>Authority fingerprint: {status.policy.authorityFingerprint}</p>
      <p className="text-sm">Current key: issuance ends {new Date(status.policy.issueUntil).toLocaleString()}; new uses end {new Date(status.policy.spendUntil).toLocaleString()}; recorded retries end {new Date(status.policy.retryUntil).toLocaleString()}.</p>
    </div>}
    {!status ? <p>Loading wallet…</p> : status.configured && !changing ? <>
      <p><strong>{status.available} available</strong> · {status.reserved} reserved · {status.total}/{status.capacity} history slots used</p>
      <p>Issuer: {status.scope?.issuer} · Community: {status.scope?.community} · Token period: {status.scope?.epoch}</p>
      <details><summary>Pinned setup details</summary>
        <p className="text-sm" style={{ overflowWrap: 'anywhere' }}>Key fingerprint: {status.keyFingerprint}</p>
        <ul>{status.relayUrls?.map(url => <li key={url}>{url}</li>)}</ul>
      </details>
      <p>Tokens stay encrypted on this device. A reserved token belongs to one request and destination, including when delivery is uncertain. It cannot be reassigned. Automatic mailbox checks use tokens when enabled.</p>
      <h4>Request more tokens</h4>
      <p>Ask your community for a single-use issuance permit, then prepare exactly the number of tokens it allows. Share the permit and blinded request with the issuer separately; only the signed response goes here. This preparation sends nothing to the network. Keep this app unlocked until you import the signed response. Locking, quitting, or cancelling loses the unfinished request; the issuer may still count it against your allowance.</p>
      {status.pendingIssuance ? <>
        <label htmlFor="wallet-request">Blinded request to share with the issuer</label>
        <textarea id="wallet-request" readOnly rows={4} value={JSON.stringify(status.pendingIssuance)} onFocus={event => event.target.select()} />
        <label htmlFor="wallet-response">Signed response from the issuer</label>
        <textarea id="wallet-response" rows={4} value={response} onChange={event => setResponse(event.target.value)} maxLength={20000} disabled={busy} spellCheck={false} />
        <button className="btn btn-primary btn-sm" disabled={busy || !response.trim()} onClick={() => void issuance('complete')}>Verify and add tokens</button>
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void issuance('cancel')}>Cancel token request</button>
      </> : <>
        <label htmlFor="wallet-count">Number of tokens (1–32)</label>
        <input id="wallet-count" type="number" min={1} max={32} value={count} disabled={busy} onChange={event => setCount(Number(event.target.value))} />
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void issuance('request')}>Prepare blinded request</button>
      </>}
      <details><summary>Import already-issued tokens</summary>
      <form onSubmit={importTokens}>
        <label htmlFor="wallet-tokens">Access tokens from your community, one per line</label>
        <textarea id="wallet-tokens" value={tokens} onChange={event => setTokens(event.target.value)} disabled={busy}
          autoComplete="off" spellCheck={false} rows={3} maxLength={122000} />
        <button className="btn btn-primary btn-sm" disabled={busy || !!status.pendingIssuance || !tokens.trim()}>Import tokens</button>
        <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={() => void refresh()}>Refresh balance</button>
      </form></details>
      <p className="text-sm text-muted">Up to {status.availableCapacity} available tokens and {status.capacity} total history slots per setup. Reservations are retained to prevent reuse.</p>
      {!!status.archived.length && <details><summary>Previous setups retained for retries ({status.archived.length})</summary>
        {status.archived.map(prior => <p key={prior.keyFingerprint} style={{ overflowWrap: 'anywhere' }}>{prior.scope.issuer} · {prior.scope.epoch}: {prior.available} unused, {prior.reserved} reserved. Key: {prior.keyFingerprint}</p>)}
      </details>}
      {privateDeliveryAvailable && !status.policy && <button className="btn btn-ghost btn-sm" disabled={busy || !!status.pendingIssuance} onClick={() => setChanging(true)}>Change issuer or token period</button>}
    </> : privateDeliveryAvailable ? <>
      <p>Use setup details verified with your community. Each setup pins its issuer key, token period, and destination relays. A changed setup requires a new key. Previous tokens stay on this device for exact retries; new requests use the setup you activate. Setup pauses automatic mailbox checks.</p>
      <form onSubmit={configure}>
        <div className="form-group"><label htmlFor="wallet-issuer">Issuer name</label>
          <input id="wallet-issuer" value={issuer} onChange={event => setIssuer(event.target.value)} maxLength={128} disabled={busy} required /></div>
        <div className="form-group"><label htmlFor="wallet-epoch">Token period</label>
          <input id="wallet-epoch" value={epoch} onChange={event => setEpoch(event.target.value)} maxLength={128} disabled={busy} required /></div>
        <div className="form-group"><label htmlFor="wallet-key">Issuer public key (PEM)</label>
          <textarea id="wallet-key" value={publicKey} onChange={event => setPublicKey(event.target.value)} rows={4} maxLength={4096} disabled={busy} spellCheck={false} required /></div>
        <div className="form-group"><label htmlFor="wallet-relays">Destination relay addresses</label>
          <textarea id="wallet-relays" value={relays} onChange={event => setRelays(event.target.value)} rows={2} maxLength={4104} disabled={busy} spellCheck={false} required /></div>
        <p>Community: public. Add destination relays that accept these tokens; entry relays are configured separately.</p>
        <button className="btn btn-primary btn-sm" disabled={busy}>{status.configured ? 'Activate new wallet setup' : 'Save wallet setup'}</button>
        {changing && <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={() => setChanging(false)}>Keep current setup</button>}
      </form>
    </> : <p>Wallet setup is available in the private transport pilot.</p>}
  </section>;
}
