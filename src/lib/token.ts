/**
 * 서명 토큰과 비밀번호 해시 (WebCrypto)
 *
 * 토큰 형식은 jmschool판(auth.py)과 같습니다.
 *   base64url(JSON 페이로드) + "." + base64url(HMAC-SHA256(비밀키, 앞부분 문자열))
 * 비밀키는 최초 설정 때 학급 DO가 만들어 자기 저장소에 둡니다(설치자가 따로 넣을 필요 없음).
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64e(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64d(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

export function randomKey(bytes = 32): string {
  return b64e(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export interface TokenPayload {
  v: 1;
  sub: string;
  name?: string;
  role: "teacher" | "student";
  school?: number;
  grade?: number | null;
  class?: number | null;
  num?: number | null;
  dev?: number | null;
  lg?: number | null;
  lc?: number | null;
  pin?: number | null;
  cv?: number;          // 학생 토큰: 발급 때의 학급 코드 판(코드를 바꾸면 옛 토큰은 무효)
  iat: number;
  exp: number;
}

export async function sign(secret: string, payload: TokenPayload): Promise<string> {
  const body = b64e(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body));
  return `${body}.${b64e(sig)}`;
}

export class TokenError extends Error {}

const CLOCK_SKEW = 60;

export async function verify(secret: string, token: string | null | undefined): Promise<TokenPayload> {
  if (!token || typeof token !== "string" || token.split(".").length !== 2) throw new TokenError("bad_token");
  const [body, sig] = token.split(".");
  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), b64d(sig), enc.encode(body));
  } catch {
    throw new TokenError("bad_token");
  }
  if (!ok) throw new TokenError("bad_signature");
  let p: TokenPayload;
  try {
    p = JSON.parse(dec.decode(b64d(body)));
  } catch {
    throw new TokenError("bad_payload");
  }
  const now = Date.now() / 1000;
  if (p.v !== 1) throw new TokenError("bad_version");
  if (typeof p.exp !== "number" || p.exp < now - CLOCK_SKEW) throw new TokenError("expired");
  if ((p.iat ?? 0) > now + CLOCK_SKEW) throw new TokenError("bad_iat");
  if ((p.role !== "teacher" && p.role !== "student") || !p.sub) throw new TokenError("bad_claims");
  return p;
}

/* ── 비밀번호: PBKDF2-SHA256 ──
 * 반복 횟수는 무료 플랜 CPU 한도 안에서 정합니다(검증 4번). 해시 앞에 반복 횟수를 붙여 두어
 * 나중에 횟수를 바꿔도 옛 해시를 그대로 확인할 수 있습니다.  형식: "pbkdf2$<iter>$<salt>$<hash>"
 */
export const PBKDF2_ITER = 100_000;

async function pbkdf2(password: string, salt: Uint8Array, iter: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, iter = PBKDF2_ITER): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${iter}$${b64e(salt)}$${b64e(await pbkdf2(password, salt, iter))}`;
}

export async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [kind, iterS, saltS, hashS] = stored.split("$");
  if (kind !== "pbkdf2") return false;
  const got = await pbkdf2(password, b64d(saltS), Number(iterS));
  const want = b64d(hashS);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}

/** 기기 키는 해시만 저장합니다(DB가 새어도 키를 알 수 없게). */
export async function sha256(text: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
