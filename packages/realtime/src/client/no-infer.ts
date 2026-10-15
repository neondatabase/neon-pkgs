/**
 * @internal Check an input against a type without inferring that type from it.
 * The deferred conditional preserves compatibility with TypeScript before 5.4.
 */
// biome-ignore lint/suspicious/noExplicitAny: This is the pre-5.4 deferred-conditional inference barrier.
export type NoInferCompat<T> = [T][T extends any ? 0 : never];
