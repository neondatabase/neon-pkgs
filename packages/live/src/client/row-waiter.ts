import type {
	LiveQuerySnapshot,
	MaterializedLiveQuerySubscription,
} from "./types.js";

type ObservableRows<Row> = Pick<
	MaterializedLiveQuerySubscription<Row>,
	"getSnapshot" | "onChange"
>;

export function waitForRows<Row>(
	subscription: ObservableRows<Row>,
	matches: (rows: readonly Row[]) => boolean,
	timeout?: number,
): Promise<void> {
	if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0)) {
		return Promise.reject(
			new Error("Live-query row timeout must be a non-negative number"),
		);
	}

	return new Promise<void>((resolve, reject) => {
		let settled = false;
		let unsubscribe: () => void = () => undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const cleanup = () => {
			unsubscribe();
			if (timer !== undefined) clearTimeout(timer);
		};
		const succeed = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve();
		};
		const fail = (error: unknown) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const inspect = (snapshot: LiveQuerySnapshot<Row>) => {
			try {
				if (snapshot.data !== undefined && matches(snapshot.data)) {
					succeed();
					return;
				}
			} catch (error) {
				fail(error);
				return;
			}

			if (snapshot.status === "error") fail(snapshot.error);
			else if (snapshot.status === "closed") {
				fail(new Error("Live-query subscription is closed"));
			}
		};

		unsubscribe = subscription.onChange(inspect);
		if (timeout !== undefined) {
			timer = setTimeout(
				() => fail(new Error("Timed out waiting for live-query rows")),
				timeout,
			);
		}
		inspect(subscription.getSnapshot());
	});
}
