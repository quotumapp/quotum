/**
 * What a schema refused, told to the caller that sent it: where, and why in the validator's words.
 * Never the input itself. Both texts are bounded, since a path or an unrecognized key repeats names
 * the caller chose.
 */
export interface RequestIssue {
	path: string;
	message: string;
}

const maxIssues = 10;
const maxText = 200;

function bounded(text: string): string {
	return text.length <= maxText ? text : `${text.slice(0, maxText)}…`;
}

/**
 * The first issues of a failure. `part` (`body`, `query`, `params`) leads each path when the caller
 * knows which part of the request the schema read; an issue on the whole value is named by it, or
 * `request` without one.
 */
export function requestIssues(
	part: string | null,
	issues: readonly { path: readonly PropertyKey[]; message: string }[],
): RequestIssue[] {
	return issues.slice(0, maxIssues).map((issue) => ({
		path: bounded(
			[...(part === null ? [] : [part]), ...issue.path.map(String)].join(".") || "request",
		),
		message: bounded(issue.message),
	}));
}

/** `<summary>: body.plans.1.key: Invalid input: expected string, received number (2 more)`. */
export function describeRequestIssues(
	summary: string,
	issues: readonly RequestIssue[],
	total: number,
): string {
	const [first] = issues;
	if (first === undefined) return summary;
	return `${summary}: ${first.path}: ${first.message}${total > 1 ? ` (${total - 1} more)` : ""}`;
}
