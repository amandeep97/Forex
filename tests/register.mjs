// The app's own source imports without file extensions — tradePlan.js says
// `from './confluence'`, which Vite resolves and bare Node does not. Rather
// than rewrite the source to suit the tests, the tests teach Node the rule
// Vite already applies.
import { register } from 'node:module';
register('./resolver.mjs', import.meta.url);
