import type { RelayHistoryHealth } from '@resonance/relay';

const mib = (bytes: number) => (bytes / 1048576).toFixed(2);
export default function HistoryHealth({ health }: { health: RelayHistoryHealth | null | undefined }) {
  if (!health || (!health.owner && !health.volunteer && !health.transport)) return null;
  const { owner, volunteer, transport } = health;
  return <section className="relay-section" aria-label="History contribution">
    <h4>History contribution</h4>
    {owner?.state === 'starting' && <p role="status">Preparing your protected history.</p>}
    {owner?.state === 'unavailable' && <p role="status">Your history status is unavailable. Checking status does not clear saved history.</p>}
    {owner?.state === 'available' && <>
      <p>{owner.usage.pending ? 'An unfinished history update is retained for an exact retry.'
        : owner.usage.busy ? 'A history operation is in progress.'
          : owner.usage.initialized ? 'Your protected history is initialized.' : 'Your protected history is not ready.'}</p>
      <p className="text-sm">Current owner generation: {owner.usage.retainedBlocks} / {owner.usage.maximumBlocks} blocks,
        {' '}{mib(owner.usage.retainedCiphertextBytes)} / {mib(owner.usage.maximumCiphertextBytes)} MiB of encrypted payloads.</p>
    </>}
    {volunteer && volunteer.state !== 'available' && <p role="status">Volunteer history status is unavailable. Checking status does not clear saved history.</p>}
    {volunteer?.state === 'available' && <>
      <p>Hosting {volunteer.usage.generations} / {volunteer.usage.maximumGenerations} history generations.</p>
      <p className="text-sm">Encrypted payloads: {mib(volunteer.usage.retainedCiphertextBytes)} MiB,
        {' '}{volunteer.usage.retainedBlocks} retained blocks and {volunteer.usage.stagedBlocks} staged blocks.</p>
      <p className="text-sm">Current generation allocation: {mib(volunteer.usage.currentGenerationReservedBytes)} / {mib(volunteer.usage.maximumGenerationBytes)} MiB,
        {' '}{volunteer.usage.currentGenerationBlocks} / {volunteer.usage.maximumGenerationBlocks} blocks.</p>
      <p className="text-sm text-muted">Allocation includes reserved metadata space. Temporary and recovery files use additional storage;
        these counters are not total disk usage. Existing history is retained when a limit stops new work.</p>
    </>}
    {transport && transport.state !== 'available' && <p role="status">History connection status is unavailable.</p>}
    {transport?.state === 'available' && <>
      {transport.usage.configuredMembers > 0 && <p className="text-sm">Your member set: {transport.usage.configuredMembers} members;
        {' '}{transport.usage.connectedDirectMembers} direct member connections and {transport.usage.connectedOwnerBridges} / {transport.usage.configuredOwnerBridges} bridge connections.</p>}
      {transport.usage.configuredBridgeRoutes > 0 && <p className="text-sm">Bridge: {transport.usage.configuredBridgeRoutes} permitted routes,
        {' '}{transport.usage.connectedBridgeTargets} target connections.</p>}
      {transport.usage.configuredControllers > 0 && <p className="text-sm">Authorized controller connections:
        {' '}{transport.usage.connectedControllers} / {transport.usage.configuredControllers}.</p>}
      <p className="text-sm">History work: {transport.usage.operations} / {transport.usage.maximumOperations} operations;
        {' '}{mib(transport.usage.bufferBytes)} / {mib(transport.usage.maximumBufferBytes)} MiB of transfer buffers.</p>
    </>}
    <p className="text-sm text-muted">Connections and local storage do not confirm current remote copies. Each new protected write needs confirmation from four members.</p>
  </section>;
}
