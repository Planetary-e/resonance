/**
 * Bootstrap relay configuration for the Resonance network.
 *
 * New users discover relays via this list. Any user can run a relay
 * and add themselves to the network.
 */

/** Default relay port when running in relay mode. */
export const DEFAULT_RELAY_PORT = 9091;

/**
 * Bootstrap relay list. Tried in order; first successful connection wins.
 * Local relay (if enabled) is always tried first by the app.
 */
export const BOOTSTRAP_RELAYS: string[] = [
  // Add community-operated relays here:
  // 'ws://relay1.planetary.earth:9091',
  // 'ws://relay2.planetary.earth:9091',
];
