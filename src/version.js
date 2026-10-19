// @ts-check

/**
 * Eine Quelle für die Version zur Laufzeit. package.json enthält denselben Wert,
 * weil Cloudflare Workers sie nicht zur Laufzeit lesen können; ein Test hält beide
 * Werte und die versionierten Asset-URLs in index.html synchron.
 */
export const VERSION = '1.2.0';
