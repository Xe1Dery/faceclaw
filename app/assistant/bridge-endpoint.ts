export type BridgeTransport = "ws" | "wss";

/** Empty ports follow the transport; explicit ports (including legacy 8790) survive upgrades. */
export function bridgePort(transport: BridgeTransport, port?: string | number): number {
  if (port === undefined || String(port).trim() === "") return transport === "wss" ? 443 : 8790;
  const value = String(port).trim();
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error("Bridge port must be between 1 and 65535.");
  }
  return Number(value);
}

/** Host only: credentials, paths, queries and fragments must never enter the endpoint. */
export function bridgeUrl(host: string, transport: BridgeTransport = "ws", port?: string | number): string {
  if (transport !== "ws" && transport !== "wss") throw new Error("Invalid bridge transport.");
  const value = host.trim();
  const ipv6 = /^\[[0-9a-fA-F:.]+\]$/.test(value);
  if (!value || (!ipv6 && !/^[a-zA-Z0-9._-]+$/.test(value))) {
    throw new Error("Bridge host must be a hostname or IP address without a scheme or path.");
  }
  return `${transport}://${value}:${bridgePort(transport, port)}`;
}
