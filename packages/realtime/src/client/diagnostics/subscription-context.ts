import type { SubscriptionEventSink } from "./events.js";
import { NOOP_SUBSCRIPTION_EVENTS } from "./projector.js";

const subscriptionEvents = new WeakMap<object, SubscriptionEventSink>();

export function registerSubscriptionEvents(
	subscription: object,
	events: SubscriptionEventSink,
): void {
	if (events !== NOOP_SUBSCRIPTION_EVENTS) {
		subscriptionEvents.set(subscription, events);
	}
}

export function subscriptionEventsFor(
	subscription: object | undefined,
): SubscriptionEventSink {
	return subscription === undefined
		? NOOP_SUBSCRIPTION_EVENTS
		: (subscriptionEvents.get(subscription) ?? NOOP_SUBSCRIPTION_EVENTS);
}
