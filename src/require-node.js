// @ts-check
// Wird in server.js vor allen anderen Modulen importiert: node:sqlite gibt es erst ab
// Node 22.5, und ohne diese Prüfung bricht der Start mit "No such built-in module".
export const MIN_NODE = '22.13.0';

/**
 * @param {string} version
 * @returns {string | null} Hinweis, wenn die Version zu alt ist
 */
export function nodeVersionProblem(version) {
  const [major = 0, minor = 0] = version.split('.').map((part) => Number.parseInt(part, 10));
  const [minMajor = 0, minMinor = 0] = MIN_NODE.split('.').map((part) => Number.parseInt(part, 10));
  if (major > minMajor || (major === minMajor && minor >= minMinor)) return null;
  return `CryptStats braucht Node ${MIN_NODE} oder neuer (gefunden ${version}).`;
}

const problem = nodeVersionProblem(process.versions.node);
if (problem) {
  console.error(problem);
  console.error('Auf einem Server ohne Node 22: docker compose up -d --build');
  console.error('Node 18/20 kennen node:sqlite nicht, dort startet der Server nicht.');
  process.exit(1);
}
