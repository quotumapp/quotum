/** Command results are an output contract, separate from diagnostic logging. */
export function writeStdout(value: string): void {
	process.stdout.write(`${value}\n`);
}

export function writeStderr(value: string): void {
	process.stderr.write(`${value}\n`);
}
