// Local deterministic child; never invokes Aside or any provider.
const scenario = process.argv[2];
if (scenario === 'stop') { process.stdout.write('interrupted\n'); process.exit(0); }
if (scenario === 'stop-failed') { process.stdout.write('idle\n'); process.exit(0); }
if (scenario === 'raw') {
    const bytes = Buffer.from('한🙂');
    process.stdout.write(bytes.subarray(0, 2));
    process.stdout.write(bytes.subarray(2));
    process.exit(0);
}
if (scenario === 'overflow') { process.stdout.write('x'.repeat(40000)); process.exit(0); }
if (scenario === 'provider-error') { process.stdout.write('Error: fixture provider failed\n'); process.exit(0); }
if (scenario === 'no-id') { process.stderr.write('Error: no session\n'); process.exit(0); }
let alive;
if (scenario === 'wait' || scenario === 'delayed') {
    process.on('SIGTERM', () => { clearInterval(alive); process.exit(143); });
    alive = setInterval(() => {}, 1000);
}
if (scenario === 'delayed') {
    process.stdin.once('data', () => process.stderr.write('\x1b[2mcreated new session: owned-session\x1b[0m\n'));
} else {
    process.stderr.write('\x1b[2mcreated new session: owned-session\x1b[0m\n');
}
if (scenario === 'done') { process.stdout.write('DIAGNOSTIC_NOT_FINAL\n'); process.exit(0); }
