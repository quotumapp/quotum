import type { SubscriptionStatus } from "../../billing/types";
import {
	type PaddleAdjustment,
	type PaddleEvent,
	type PaddleSubscription,
	type PaddleTransaction,
	paddleAdjustmentSchema,
	paddleEventSchema,
	paddleSubscriptionSchema,
	paddleTransactionSchema,
} from "./schemas";

export type NormalizedPaddleEvent =
	| {
			kind: "subscription";
			event: PaddleEvent;
			subscription: PaddleSubscription;
			status: SubscriptionStatus;
			trial: { startsAt: string; endsAt: string } | null;
			cancelAtPeriodEnd: boolean;
			effectiveAt: string;
	  }
	| { kind: "transaction"; event: PaddleEvent; transaction: PaddleTransaction }
	| {
			kind: "adjustment";
			event: PaddleEvent;
			adjustment: PaddleAdjustment;
			/** Reconcile the complete adjustment set; never blindly apply this as a new debit. */
			requiresPurchaseReconciliation: boolean;
	  }
	| { kind: "ignored"; event: PaddleEvent };

/** Parsing does not grant access: persistence must first verify the recorded customer and intent. */
export function normalizePaddleEvent(input: unknown): NormalizedPaddleEvent {
	const event = paddleEventSchema.parse(input);
	if (event.event_type.startsWith("subscription.")) {
		const subscription = paddleSubscriptionSchema.parse(event.data);
		const trials = subscription.items.flatMap((item) =>
			item.trial_dates ? [item.trial_dates] : [],
		);
		const trial =
			trials.length === 0
				? null
				: {
						startsAt: new Date(
							Math.min(...trials.map((value) => Date.parse(value.starts_at))),
						).toISOString(),
						endsAt: new Date(
							Math.max(...trials.map((value) => Date.parse(value.ends_at))),
						).toISOString(),
					};
		return {
			kind: "subscription",
			event,
			subscription,
			status: subscriptionStatus(subscription.status),
			trial,
			cancelAtPeriodEnd:
				subscription.status !== "canceled" && subscription.scheduled_change?.action === "cancel",
			effectiveAt: subscription.updated_at,
		};
	}
	if (event.event_type === "transaction.completed") {
		const transaction = paddleTransactionSchema.parse(event.data);
		if (transaction.status !== "completed")
			throw new Error("Completed Paddle event contains an incomplete transaction");
		return { kind: "transaction", event, transaction };
	}
	if (event.event_type === "adjustment.created" || event.event_type === "adjustment.updated") {
		const adjustment = paddleAdjustmentSchema.parse(event.data);
		return {
			kind: "adjustment",
			event,
			adjustment,
			requiresPurchaseReconciliation:
				adjustment.status === "approved" || adjustment.status === "reversed",
		};
	}
	return { kind: "ignored", event };
}

function subscriptionStatus(status: PaddleSubscription["status"]): SubscriptionStatus {
	switch (status) {
		case "active":
		case "trialing":
			return "active";
		case "past_due":
			return "billing_retry";
		case "canceled":
			return "cancelled";
		case "paused":
			return "expired";
	}
}
