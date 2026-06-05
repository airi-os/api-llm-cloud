export async function generateFakeIp(
  proxyIndex: number,
  domain: string,
): Promise<string> {
  const input = String(proxyIndex) + domain;
  const encoded = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  const hash = new Uint8Array(hashBuffer);
  return `${hash[0]}.${hash[1]}.${hash[2]}.${hash[3]}`;
}
