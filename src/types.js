// @ts-check

/**
 * Minimale Typen für die D1-API. Sie decken genau das ab, was CryptStats nutzt,
 * damit der Typecheck ohne Cloudflare-Typabhängigkeit läuft.
 * @typedef {object} D1Result
 * @property {boolean} success
 * @property {{ last_row_id: number, changes: number }} meta
 */

/**
 * @typedef {object} D1PreparedStatement
 * @property {(...values: unknown[]) => D1PreparedStatement} bind
 * @property {() => Promise<Record<string, unknown> | null>} first
 * @property {() => Promise<{ results: Record<string, unknown>[] }>} all
 * @property {() => Promise<D1Result>} run
 */

/**
 * @typedef {object} D1Database
 * @property {(sql: string) => D1PreparedStatement} prepare
 * @property {(statements: D1PreparedStatement[]) => Promise<D1Result[]>} batch
 * @property {(sql: string) => Promise<unknown>} exec
 */

/**
 * @typedef {object} AssetFetcher
 * @property {(request: Request) => Promise<Response>} fetch
 */

export {};
