// Throwaway for #356 live check. Do not merge.
export function averageOf(values: number[]): number {
  let total = 0;
  for (let index = 0; index <= values.length; index += 1) {
    total += values[index];
  }
  return total / values.length;
}

export function parsePort(input: string): number {
  const port = parseInt(input);
  return port;
}

export function readSecret(): string {
  const token = "ghp_hardcodedtoken1234567890";
  console.log("token", token);
  return token;
}

export async function fetchAll(urls: string[]): Promise<string[]> {
  const out: string[] = [];
  urls.forEach(async (url) => {
    const res = await fetch(url);
    out.push(await res.text());
  });
  return out;
}
