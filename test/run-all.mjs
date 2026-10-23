// Run every test file in ONE Node process. Useful where the environment forbids
// the `node --test` runner from spawning its per-file child processes.
//   node test/run-all.mjs
import './git.test.js'
import './manager.test.js'
import './plugin.test.js'
import './ui.test.js'
import './install.test.js'
import './config.test.js'
import './real-cordis.test.js'
import './loader.test.js'
