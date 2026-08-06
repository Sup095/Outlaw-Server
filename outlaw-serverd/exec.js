// ============================================================================
// Outlaw Server — the one way this daemon runs a program
// ----------------------------------------------------------------------------
// Every subprocess in the daemon goes through here, for two reasons:
//
//   1. NO SHELL, EVER. `execFile` with an argv ARRAY means arguments are handed
//      to the kernel as-is. There is no shell to interpret `;`, backticks, `$(…)`
//      or a stray quote, so a caller-supplied string can never become a command.
//      (This is the single most important rule in the codebase — the daemon runs
//      as root.)
//   2. A FAILING COMMAND IS DATA, NOT AN EXCEPTION. This resolves with
//      {ok, code, stdout, stderr} instead of rejecting, so callers handle a
//      non-zero exit the same way they handle any other result and the daemon
//      can't be knocked over by a missing binary.
//
// Everything is bounded: a timeout so a hung command can't wedge a request, and
// a maxBuffer so runaway output can't exhaust memory.
// ============================================================================
'use strict';

const { execFile } = require('child_process');

function run(bin, args = [], { timeout = 8000, maxBuffer = 4 * 1024 * 1024 } = {}) {
    return new Promise((resolve) => {
        execFile(bin, args, { timeout, maxBuffer }, (err, stdout, stderr) => {
            resolve({
                ok: !err,
                code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
                stdout: String(stdout || ''),
                stderr: String(stderr || ''),
            });
        });
    });
}

module.exports = { run };
