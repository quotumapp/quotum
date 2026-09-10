export interface InterruptTrap {
	signal(): NodeJS.Signals | undefined;
	exitCode(): number | undefined;
}

export function trapInterrupts(
	proc: { on(event: string, listener: (signal: NodeJS.Signals) => void): unknown } = process,
): InterruptTrap {
	let received: NodeJS.Signals | undefined;
	const onSignal = (signal: NodeJS.Signals) => {
		if (received === undefined) {
			received = signal;
		}
	};
	proc.on("SIGINT", onSignal);
	proc.on("SIGTERM", onSignal);
	return {
		signal: () => received,
		exitCode: () => {
			if (received === "SIGINT") {
				return 130;
			}
			if (received === "SIGTERM") {
				return 143;
			}
			return undefined;
		},
	};
}
