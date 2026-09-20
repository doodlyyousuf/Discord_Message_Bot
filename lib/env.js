/**
 * Loads variables from a local .env file (if present) into process.env.
 * Imported first by server.js so every other module sees the values.
 */
try {
  if (typeof process.loadEnvFile === 'function') process.loadEnvFile();
} catch {
  // No .env file (or unreadable) - fall back to the ambient environment.
}
